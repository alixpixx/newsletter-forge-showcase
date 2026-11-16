-- ---------------------------------------------------------------------------
-- 0058 — mettre des réengagements en file, et savoir en ressortir.
-- ---------------------------------------------------------------------------
--
-- Deux fonctions, et elles vont ensemble. `enqueue_reengagement_batch` met en file ;
-- `reactivate_sunset` défait la marque dès que quelqu'un donne signe de vie. Livrer la première
-- sans la seconde ferait du sunset un ALLER SIMPLE : un abonné marqué qui rouvre le mois suivant
-- resterait exclu pour toujours, et personne ne s'en apercevrait — un sunsetted disparaît
-- simplement des comptes, il n'apparaît dans aucune alerte.

-- ===========================================================================
-- 1 — ENFILER UNE VAGUE DE RÉENGAGEMENT.
-- ===========================================================================
--
-- ⛔ TOUT EST DANS LA FONCTION, ET C'EST LA RAISON D'ÊTRE DU CHOIX. `enqueue_campaign_batch` (0038)
-- reçoit des identifiants choisis par le worker, parce que la sélection d'une campagne passe par le
-- compilateur de segments. Ici la sélection est simple mais elle DOIT être atomique avec
-- l'écriture : entre un `select` des candidats côté worker et l'`insert`, une seconde passe (un
-- cron qui se chevauche, un redémarrage) verrait les mêmes candidats et enfilerait tout une seconde
-- fois. L'anti-jointure sur `lifecycle_send` ne protège que si elle est évaluée dans la même
-- instruction que l'insertion.
--
-- ⛔ L'ORDRE DES DEUX INSERTIONS N'EST PAS INTERCHANGEABLE. `lifecycle_send` D'ABORD : c'est elle
-- qui porte l'unicité. Si l'outbox était écrite en premier et que la garde mordait ensuite, l'email
-- serait déjà en file — c'est-à-dire déjà parti. Dans ce sens-ci, un conflit signifie « déjà
-- traité » et rien n'entre dans la file.
--
-- ⚠️ CE QUE LA FONCTION NE FAIT PAS : elle ne pose PAS `sunset_at`. Marquer quelqu'un au moment où
-- on lui écrit reviendrait à le condamner avant d'avoir lu sa réponse. La marque se pose à la fin
-- de la séquence, quand la relance est restée sans effet — c'est un geste distinct, à écrire
-- quand la séquence aura plus d'une étape.
create or replace function newsletter.enqueue_reengagement_batch(
  p_asset_id      uuid,
  p_subject       text,
  p_purpose       text,
  p_step          integer default 1,
  p_batch         integer default 100,
  p_daily_cap     integer default 500,
  p_dormant_days  integer default 30,
  p_dry_run       boolean default true
)
returns table (
  eligible    integer,  -- combien de dormants entrent dans les critères, avant tout plafond
  allowed     integer,  -- combien le plafond du jour + la taille de lot autorisent
  enqueued    integer,  -- combien sont RÉELLEMENT entrés en file (0 en simulation)
  daily_used  integer   -- combien de réengagements cette marque a déjà émis aujourd'hui
)
language plpgsql
security definer
set search_path to 'newsletter', 'extensions'
as $$
declare
  v_used    integer;
  v_allowed integer;
begin
  if p_asset_id is null then raise exception 'p_asset_id est obligatoire'; end if;
  if p_purpose is null then
    -- La contrainte de 0057 le refuserait de toute façon ; échouer ici donne un message qui dit
    -- quoi faire, plutôt qu'une violation de contrainte à déchiffrer.
    raise exception 'p_purpose est obligatoire : un reengagement est un envoi editorial';
  end if;

  -- ⚠️ LE PLAFOND SE COMPTE SUR `lifecycle_send`, PAS SUR `email_outbox`. Une ligne d'outbox peut
  -- être purgée ; la trace, elle, survit (0057). Compter sur la file ferait remonter le plafond
  -- après chaque purge et autoriserait une seconde vague le même jour.
  select count(*)::integer into v_used
    from newsletter.lifecycle_send
   where asset_id = p_asset_id
     and kind = 'reengagement'
     and created_at >= date_trunc('day', now());

  v_allowed := least(p_batch, greatest(0, p_daily_cap - v_used));

  -- ⚠️ `on commit drop` ne libère les noms qu'au COMMIT : deux appels dans la même transaction
  -- (une sonde qui compare simulation et réel, par exemple) échoueraient sur « relation existe
  -- déjà ». On nettoie donc à l'entrée plutôt que de compter sur la fin de transaction.
  drop table if exists _cand;
  drop table if exists _lot;
  drop table if exists _pris;
  drop table if exists _files;

  /*
   * Les candidats.
   *
   * ⛔ LA SÉLECTION PART DE `sendable_subscription`, JAMAIS DE `subscription`. La vue porte les
   * quatre gardes d'un seul tenant : actif, non supprimé, non démo, non sunsetted. Requêter la
   * table directement les perdrait toutes les quatre — dont celle qui empêche d'écrire aux
   * abonnés de démonstration.
   *
   * ⚠️ L'ORDRE EST UN CHOIX, PAS UN DÉTAIL : `last_engagement_at desc nulls last`, donc les
   * dormants les PLUS RÉCENTS d'abord. Ce sont ceux qui ont le plus de chances de revenir ; les
   * relancer en premier maximise le nombre de gens récupérés par vague. Trier dans l'autre sens
   * dépenserait le plafond quotidien sur les cas les plus froids.
   */
  create temporary table _cand on commit drop as
  select ss.id as subscription_id, sub.email::text as email, ss.last_engagement_at
    from newsletter.sendable_subscription ss
    join newsletter.subscriber sub on sub.id = ss.subscriber_id
   where ss.asset_id = p_asset_id
     and ss.engagement_level in ('dormant', 'churned')
     -- Ceinture ET bretelles : `engagement_level` est recalculé par un job (0056) qui peut ne pas
     -- avoir tourné. La condition de date, elle, est toujours vraie au moment où on lit.
     and coalesce(ss.last_engagement_at, ss.created_at) < now() - make_interval(days => p_dormant_days)
     -- ⛔ L'anti-jointure qui rend la passe rejouable : celui qui a déjà reçu CETTE étape n'y
     -- revient pas. Évaluée ici, dans la même transaction que l'insertion.
     and not exists (
       select 1 from newsletter.lifecycle_send l
        where l.subscription_id = ss.id and l.kind = 'reengagement' and l.step = p_step
     );

  eligible := (select count(*)::integer from _cand);
  allowed  := v_allowed;
  daily_used := v_used;
  enqueued := 0;

  if p_dry_run or v_allowed <= 0 then
    return next;
    return;
  end if;

  create temporary table _lot on commit drop as
  select * from _cand order by last_engagement_at desc nulls last limit v_allowed;

  -- 1) La garde d'abord. `on conflict do nothing` couvre TOUS les index uniques de la table ;
  --    `returning` ne rend que ce qui est réellement entré.
  --    ⚠️ `CREATE TABLE AS` n'accepte qu'un SELECT : l'écriture passe par un CTE modifiant.
  create temporary table _pris on commit drop as
  with ins as (
    insert into newsletter.lifecycle_send (asset_id, subscription_id, kind, step)
    select p_asset_id, l.subscription_id, 'reengagement', p_step from _lot l
    on conflict do nothing
    returning id, subscription_id
  )
  select id, subscription_id from ins;

  -- 2) La file, seulement pour ce que la garde a laissé passer.
  create temporary table _files on commit drop as
  with ins as (
    insert into newsletter.email_outbox
      (asset_id, subscription_id, to_email, subject, kind, purpose, payload)
    select p_asset_id, p.subscription_id, l.email, p_subject, 'reengagement', p_purpose,
           jsonb_build_object('lifecycle_step', p_step)
      from _pris p join _lot l on l.subscription_id = p.subscription_id
    returning id, subscription_id
  )
  select id, subscription_id from ins;

  -- 3) Relier les deux, pour qu'on puisse répondre à « qu'est devenu cet envoi ? ».
  update newsletter.lifecycle_send t
     set outbox_id = f.id
    from _files f
   where t.subscription_id = f.subscription_id
     and t.kind = 'reengagement' and t.step = p_step;

  enqueued := (select count(*)::integer from _files);
  return next;
end;
$$;

comment on function newsletter.enqueue_reengagement_batch(uuid, text, text, integer, integer, integer, integer, boolean) is
  'Met en file une vague de reengagement pour une marque. Selectionne dans sendable_subscription (actif + non supprime + non demo + non sunsetted), exclut ceux qui ont deja recu cette etape, respecte un plafond quotidien compte sur lifecycle_send. Ecrit lifecycle_send AVANT email_outbox : dans ce sens un conflit signifie deja traite et rien n''entre en file. p_dry_run = true par defaut.';

revoke all on function newsletter.enqueue_reengagement_batch(uuid, text, text, integer, integer, integer, integer, boolean) from public;
grant execute on function newsletter.enqueue_reengagement_batch(uuid, text, text, integer, integer, integer, integer, boolean) to service_role;

-- ===========================================================================
-- 2 — SORTIR DU SUNSET. Sans ça, la marque est un aller simple.
-- ===========================================================================
--
-- ⛔ POURQUOI C'EST UNE FONCTION À PART ET NON UN AJOUT À `recompute_engagement`. Les deux tournent
-- dans la même tâche, mais elles répondent à des questions différentes : l'une recalcule un niveau
-- à partir de tous les événements, l'autre annule une décision quand un fait postérieur la
-- contredit. Les fondre obligerait à recopier 0056 en entier pour ajouter six lignes, et à relire
-- toute la fonction chaque fois qu'on touche à la réactivation.
--
-- ⚠️ LA COMPARAISON EST STRICTEMENT POSTÉRIEURE À LA MARQUE. `last_engagement_at > sunset_at` :
-- une ouverture ANTÉRIEURE au marquage ne réactive personne — c'est justement celle qui n'a pas
-- suffi à l'éviter. Comparer sur la seule existence d'une réaction ressusciterait tout le monde à
-- la première passe, et le sunset ne tiendrait jamais.
create or replace function newsletter.reactivate_sunset(
  p_asset_id uuid default null,
  p_dry_run  boolean default false
)
returns table (candidates integer, reactivated integer)
language plpgsql
security definer
set search_path to 'newsletter', 'extensions'
as $$
begin
  drop table if exists _back;
  create temporary table _back on commit drop as
  select s.id
    from newsletter.subscription s
   where s.sunset_at is not null
     and (p_asset_id is null or s.asset_id = p_asset_id)
     and s.last_engagement_at is not null
     and s.last_engagement_at > s.sunset_at;

  candidates := (select count(*)::integer from _back);
  reactivated := 0;

  if not p_dry_run then
    update newsletter.subscription s
       set sunset_at = null
      from _back b
     where s.id = b.id;
    reactivated := candidates;
  end if;

  return next;
end;
$$;

comment on function newsletter.reactivate_sunset(uuid, boolean) is
  'Efface sunset_at des abonnements dont la derniere reaction est POSTERIEURE au marquage. Sans cette fonction le sunset serait un aller simple, et personne ne le verrait : un sunsetted disparait des comptes sans apparaitre dans aucune alerte. La comparaison est stricte — une reaction anterieure au marquage est justement celle qui n''a pas suffi a l''eviter.';

revoke all on function newsletter.reactivate_sunset(uuid, boolean) from public;
grant execute on function newsletter.reactivate_sunset(uuid, boolean) to service_role;

notify pgrst, 'reload schema';
