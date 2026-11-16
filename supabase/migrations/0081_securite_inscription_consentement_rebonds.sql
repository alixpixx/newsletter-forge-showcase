-- ============================================================================
-- 0081 — Fondations de sécurité avant tout envoi automatique (plan Automations, vague 1).
-- ============================================================================
--
-- ⭐ POURQUOI. La section « Automations » va écrire des e-mails sans qu'un humain appuie sur un
-- bouton. Avant qu'une seule automation existe, trois défauts mesurés le 24/09/2026 doivent être
-- fermés, parce qu'une automation les MULTIPLIERAIT :
--   1. l'inscription publique n'a aucune limite de débit : n'importe qui peut faire recevoir des
--      dizaines de confirmations à l'adresse d'un tiers (section 1) ;
--   2. le journal de consentement se dit « append-only » depuis 0001, mais `service_role` y a
--      UPDATE, DELETE et TRUNCATE, et aucun déclencheur ne le protège : la preuve légale est
--      modifiable par la clé que tout le code serveur utilise (section 2) ;
--   3. le compteur de rebonds mous existe depuis 0001 et n'a jamais été écrit : une adresse qui
--      échoue temporairement à chaque envoi reste servie pour toujours (section 3) — et la
--      suppression qui en découle doit rester levable par une réinscription confirmée (section 4).
--
-- ⛔ AUCUNE DONNÉE EXISTANTE N'EST RÉÉCRITE NI EFFACÉE. Ce fichier ajoute une table, des fonctions,
-- deux déclencheurs, un commentaire de colonne, redéfinit deux fonctions de 0073
-- (`is_hard_suppressed`, `lift_voluntary_suppression`), et retire des droits. Chaque section a sa
-- contre-épreuve DANS la migration (modèle 0072 / 0080) : on relit le catalogue, on exécute ce qui
-- vient d'être posé, et on LÈVE si l'état attendu n'est pas là — l'applicateur tourne dans une
-- transaction, donc un échec n'a rien laissé derrière lui. Les seules écritures des contre-épreuves
-- portent sur leurs propres lignes jetables (effacées) ou sont annulées dans un sous-bloc.
--
-- ⚠️ CE QUI CHANGE DE COMPORTEMENT (section 2) : supprimer un abonné, une souscription ou une
-- marque qui porte des preuves de consentement ÉCHOUE désormais — la cascade vers `consent_event`
-- est refusée. C'est voulu : l'effacement passe par `erase_subscriber` (pseudonymisation), et le
-- retrait de marque de 0045 ne touchait que des marques sans aucun abonné.
--
-- ⛔ ORDRE DE DÉPLOIEMENT : INDIFFÉRENT. Le code qui appelle `signup_rate_take` LAISSE PASSER
-- l'inscription quand la fonction n'existe pas encore (échec journalisé, voir
-- `apps/public/src/lib/debit-inscription.ts`) ; la colonne `soft_bounce_count` que le webhook écrit
-- existe depuis 0001 ; aucun code n'écrit dans `consent_event` autrement que par INSERT (relevé le
-- 24/09/2026). Appliquer ce fichier avant ou après le code ne casse rien.

-- ===========================================================================
-- 1 — Limite de débit de l'inscription publique : `signup_attempt` + `signup_rate_take`.
-- ===========================================================================
--
-- ⛔ POURQUOI EN BASE. Le site public tourne en plusieurs instances qui redémarrent : un compteur en
-- mémoire se remet à zéro à chaque déploiement et ne voit que sa propre instance. Aucun mécanisme
-- de débit n'existe côté inscription, et le dépôt n'ajoute aucune dépendance.
--
-- ⛔ AUCUNE ADRESSE NI IP EN CLAIR. `key_hash` est une empreinte sha256 calculée par le site
-- (`ip:<ip>` ou `address:<adresse normalisée>`) ; la contrainte refuse tout ce qui n'a pas la
-- forme d'une empreinte, donc une adresse passée par erreur ne s'écrit pas. Rien n'est gardé plus
-- de 48 h : la fonction purge à chaque appel.
--
-- ⚠️ UNE TENTATIVE REFUSÉE N'EST PAS COMPTÉE. Les N premières d'une fenêtre passent, les suivantes
-- attendent qu'une place se libère ; un appelant qui insiste ne rallonge pas sa propre attente, et
-- le pont de capture qui rejoue un lead refusé passera dès que la fenêtre le permet.

create table if not exists newsletter.signup_attempt (
  id          bigint generated always as identity primary key,
  key_kind    text not null check (key_kind in ('ip', 'address')),
  key_hash    text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now()
);

create index if not exists ix_signup_attempt_key
  on newsletter.signup_attempt (key_kind, key_hash, created_at desc);
create index if not exists ix_signup_attempt_created
  on newsletter.signup_attempt (created_at);

comment on table newsletter.signup_attempt is
  'Limite de debit de l''inscription publique (0081) : une ligne par tentative ACCEPTEE, par cle '
  '(ip / address), sous forme d''empreinte sha256 — jamais l''adresse ni l''IP. Ecrite et purgee '
  '(> 48 h) par signup_rate_take seulement.';

-- RLS sans aucune politique = personne ne lit ni n'écrit par PostgREST ; seule la fonction
-- SECURITY DEFINER ci-dessous y touche.
alter table newsletter.signup_attempt enable row level security;
revoke all on newsletter.signup_attempt from public, anon, authenticated;

-- ⛔ COMPTER ET RÉSERVER DANS LA MÊME TRANSACTION, SOUS UN VERROU PAR CLÉ. Sans le verrou, deux
-- inscriptions simultanées de la même adresse lisent toutes deux « 4 sur 5 » et passent toutes
-- deux. Les verrous sont pris dans un ordre FIXE (adresse, puis IP) : deux appels ne peuvent pas
-- s'attendre l'un l'autre en croix.
--
-- ⚠️ Les fenêtres sont bornées à 48 h parce que la purge efface tout ce qui est plus vieux : une
-- fenêtre plus longue compterait des lignes qui n'existent plus.
create or replace function newsletter.signup_rate_take(
  p_ip_key                  text,
  p_address_key             text,
  p_ip_max                  integer,
  p_ip_window_seconds       integer,
  p_address_max             integer,
  p_address_window_seconds  integer
)
returns jsonb
language plpgsql
security definer
set search_path = newsletter, extensions
as $$
declare
  v_now        timestamptz := now();
  v_n          integer;
  v_plus_vieux timestamptz;
begin
  if p_address_key is null or p_address_key !~ '^[0-9a-f]{64}$' then
    raise exception 'signup_rate_take : p_address_key doit etre une empreinte sha256 hexadecimale';
  end if;
  if p_ip_key is not null and p_ip_key !~ '^[0-9a-f]{64}$' then
    raise exception 'signup_rate_take : p_ip_key doit etre une empreinte sha256 hexadecimale, ou NULL';
  end if;
  if coalesce(p_ip_max, 0) < 1 or coalesce(p_address_max, 0) < 1
     or coalesce(p_ip_window_seconds, 0) not between 1 and 172800
     or coalesce(p_address_window_seconds, 0) not between 1 and 172800 then
    raise exception 'signup_rate_take : seuils >= 1 et fenetres entre 1 s et 48 h exiges';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('signup_rate:address:' || p_address_key, 0));
  if p_ip_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('signup_rate:ip:' || p_ip_key, 0));
  end if;

  select count(*), min(created_at)
    into v_n, v_plus_vieux
    from newsletter.signup_attempt
   where key_kind = 'address'
     and key_hash = p_address_key
     and created_at > v_now - make_interval(secs => p_address_window_seconds);
  if v_n >= p_address_max then
    return jsonb_build_object(
      'allowed', false,
      'limited_by', 'address',
      'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_plus_vieux + make_interval(secs => p_address_window_seconds) - v_now))))::integer
    );
  end if;

  if p_ip_key is not null then
    select count(*), min(created_at)
      into v_n, v_plus_vieux
      from newsletter.signup_attempt
     where key_kind = 'ip'
       and key_hash = p_ip_key
       and created_at > v_now - make_interval(secs => p_ip_window_seconds);
    if v_n >= p_ip_max then
      return jsonb_build_object(
        'allowed', false,
        'limited_by', 'ip',
        'retry_after_seconds',
        greatest(1, ceil(extract(epoch from (v_plus_vieux + make_interval(secs => p_ip_window_seconds) - v_now))))::integer
      );
    end if;
  end if;

  insert into newsletter.signup_attempt (key_kind, key_hash, created_at) values ('address', p_address_key, v_now);
  if p_ip_key is not null then
    insert into newsletter.signup_attempt (key_kind, key_hash, created_at) values ('ip', p_ip_key, v_now);
  end if;

  -- Purge bornée : au plus 1 000 lignes par appel, jamais une tâche longue sur le chemin public.
  delete from newsletter.signup_attempt
   where id in (
     select id from newsletter.signup_attempt
      where created_at < v_now - interval '48 hours'
      order by created_at
      limit 1000
   );

  return jsonb_build_object('allowed', true);
end;
$$;

comment on function newsletter.signup_rate_take(text, text, integer, integer, integer, integer) is
  'Limite de debit de l''inscription (0081) : compte les tentatives ACCEPTEES par empreinte d''adresse '
  'et d''IP dans leur fenetre, refuse a partir du seuil ({allowed:false, limited_by, retry_after_seconds}), '
  'sinon reserve une place ({allowed:true}). Verrou par cle, purge > 48 h. Appelee par apps/public.';

-- ⛔ LE DÉFAUT POSTGRES EST « TOUT LE MONDE PEUT EXÉCUTER » (voir 0071). Le revoke précède le grant.
revoke all on function newsletter.signup_rate_take(text, text, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function newsletter.signup_rate_take(text, text, integer, integer, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE 1 — la limite existe, n'est ouverte à aucun rôle public, et MORD.
-- ⛔ Relire le catalogue ne suffit pas : une fonction présente peut compter de travers. On
-- l'EXÉCUTE sur des clés jetables (jamais une vraie empreinte), on vérifie les deux seuils, puis
-- on efface ces lignes — tout cela dans la transaction de la migration.
-- ---------------------------------------------------------------------------
do $$
declare
  f       constant text := 'newsletter.signup_rate_take(text,text,integer,integer,integer,integer)';
  k_adr   text := md5('0081-adresse-' || clock_timestamp()::text) || md5('a' || random()::text);
  k_ip    text := md5('0081-ip-' || clock_timestamp()::text) || md5('b' || random()::text);
  k_autre text;
  v_cles  text[];
  r       jsonb;
  i       integer;
begin
  v_cles := array[k_adr, k_ip];
  if to_regclass('newsletter.signup_attempt') is null then
    raise exception '[0081] table signup_attempt absente apres execution';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'newsletter.signup_attempt'::regclass) then
    raise exception '[0081] RLS non active sur signup_attempt';
  end if;
  if to_regprocedure(f) is null then
    raise exception '[0081] fonction signup_rate_take absente apres execution';
  end if;
  if not (select prosecdef from pg_proc where oid = to_regprocedure(f)) then
    raise exception '[0081] signup_rate_take doit etre SECURITY DEFINER (la table est fermee aux roles)';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and (has_function_privilege('anon', f, 'EXECUTE')
          or has_table_privilege('anon', 'newsletter.signup_attempt', 'SELECT,INSERT,UPDATE,DELETE')) then
    raise exception '[0081] anon peut encore appeler signup_rate_take ou toucher signup_attempt';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and (has_function_privilege('authenticated', f, 'EXECUTE')
          or has_table_privilege('authenticated', 'newsletter.signup_attempt', 'SELECT,INSERT,UPDATE,DELETE')) then
    raise exception '[0081] authenticated peut encore appeler signup_rate_take ou toucher signup_attempt';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and not has_function_privilege('service_role', f, 'EXECUTE') then
    raise exception '[0081] service_role ne peut pas appeler signup_rate_take : toute inscription passerait sans limite';
  end if;

  -- Par ADRESSE : seuil 3 ⇒ trois passent (IP différentes), la quatrième est refusée.
  for i in 1..3 loop
    k_autre := md5('0081-ip-' || i || clock_timestamp()::text) || md5(random()::text);
    v_cles := v_cles || k_autre;
    r := newsletter.signup_rate_take(k_autre, k_adr, 100, 3600, 3, 3600);
    if (r->>'allowed')::boolean is distinct from true then
      raise exception '[0081] tentative % sur 3 refusee a tort : %', i, r;
    end if;
  end loop;
  r := newsletter.signup_rate_take(null, k_adr, 100, 3600, 3, 3600);
  if (r->>'allowed')::boolean is distinct from false or r->>'limited_by' is distinct from 'address'
     or coalesce((r->>'retry_after_seconds')::integer, 0) < 1 then
    raise exception '[0081] la 4e tentative sur la meme adresse aurait du etre refusee (address) : %', r;
  end if;

  -- Par IP : seuil 2 ⇒ deux adresses passent, la troisième est refusée.
  for i in 1..2 loop
    k_autre := md5('0081-adr-' || i || clock_timestamp()::text) || md5(random()::text);
    v_cles := v_cles || k_autre;
    r := newsletter.signup_rate_take(k_ip, k_autre, 2, 3600, 100, 3600);
    if (r->>'allowed')::boolean is distinct from true then
      raise exception '[0081] adresse % sur 2 refusee a tort pour l''IP : %', i, r;
    end if;
  end loop;
  k_autre := md5('0081-derniere' || random()::text) || md5(random()::text);
  v_cles := v_cles || k_autre;
  r := newsletter.signup_rate_take(k_ip, k_autre, 2, 3600, 100, 3600);
  if (r->>'allowed')::boolean is distinct from false or r->>'limited_by' is distinct from 'ip' then
    raise exception '[0081] la 3e adresse depuis la meme IP aurait du etre refusee (ip) : %', r;
  end if;

  -- Une empreinte mal formée (une adresse en clair, par exemple) ne s'écrit jamais.
  begin
    perform newsletter.signup_rate_take(null, 'lecteur@example.invalid', 5, 3600, 5, 3600);
    raise exception using errcode = 'P0001', message = '[0081] une adresse en clair a ete acceptee comme cle';
  exception
    when raise_exception then
      -- Seul le refus de la fonction est attendu ; le témoin ci-dessus, ou toute autre erreur, remonte.
      if sqlerrm not like 'signup_rate_take : p_address_key%' then raise; end if;
  end;

  -- Rien de ce banc ne reste : seules ses propres clés, jetables, sont effacées.
  delete from newsletter.signup_attempt
   where key_hash = any (v_cles);
  if exists (select 1 from newsletter.signup_attempt where key_hash = any (v_cles)) then
    raise exception '[0081] les lignes du banc de la contre-epreuve n''ont pas ete effacees';
  end if;

  raise notice '[0081] contre-epreuve 1 OK : limite par adresse et par IP en place, fermee aux roles publics';
end
$$;

-- ===========================================================================
-- 2 — `consent_event` réellement append-only : droits retirés + déclencheurs.
-- ===========================================================================
--
-- ⛔ LE REVOKE DE 0001 NE PROTÉGEAIT RIEN. Il retirait UPDATE et DELETE à `public` ; or Supabase
-- accorde ses droits NOMMÉMENT. Mesuré le 24/09/2026 : `service_role` a UPDATE, DELETE et TRUNCATE
-- sur la table, et elle n'a aucun déclencheur. Un bug, une requête de nettoyage ou une clé
-- `service_role` fuitée pouvait réécrire ou effacer la preuve qu'une personne a consenti — la seule
-- chose qu'on puisse opposer à une plainte. Et demain le moteur d'automations LIRA ce journal par
-- curseur (id croissant) : une ligne réécrite serait un déclenchement faux ou perdu.
--
-- ⭐ DEUX VERROUS, PARCE QU'UN SEUL NE SUFFIT PAS.
--   — les droits : plus aucun rôle applicatif ne peut UPDATE, DELETE ni TRUNCATE ;
--   — un déclencheur, qui tient AUSSI pour le propriétaire et les fonctions SECURITY DEFINER, que
--     les droits ne touchent pas.
--
-- ⚠️ LA SEULE MODIFICATION PERMISE : METTRE À NULL `ip_address`, `user_agent` ET `source_url`, et rien
-- d'autre dans la même instruction. C'est ce que font l'effacement (`erase_subscriber`, 0006) et la
-- rétention (`purge_expired_proof`, 0016) : ils retirent l'identifiant personnel et GARDENT le fait
-- juridique. Les interdire casserait le droit à l'oubli. La comparaison se fait sur la ligne
-- entière moins ces trois colonnes : une colonne ajoutée demain est protégée sans retoucher ce code.
--
-- ⚠️ TRUNCATE est refusé par un déclencheur d'instruction : les déclencheurs de ligne ne le voient pas.

revoke update, delete, truncate on newsletter.consent_event from public, anon, authenticated, service_role;

create or replace function newsletter.consent_event_append_only()
returns trigger
language plpgsql
set search_path = newsletter, extensions
as $$
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'ip_address' - 'user_agent' - 'source_url')
         = (to_jsonb(old) - 'ip_address' - 'user_agent' - 'source_url')
       and (new.ip_address is null or new.ip_address is not distinct from old.ip_address)
       and (new.user_agent is null or new.user_agent is not distinct from old.user_agent)
       and (new.source_url is null or new.source_url is not distinct from old.source_url) then
      return new;
    end if;
    raise exception using
      errcode = 'restrict_violation',
      message = 'consent_event est append-only : seule la mise a NULL de ip_address, user_agent et source_url est permise',
      hint = 'effacement : newsletter.erase_subscriber ; retention : newsletter.purge_expired_proof';
  end if;
  raise exception using
    errcode = 'restrict_violation',
    message = format('consent_event est append-only : %s refuse', tg_op);
end;
$$;

comment on function newsletter.consent_event_append_only() is
  'Declencheur de consent_event (0081) : refuse UPDATE, DELETE et TRUNCATE (restrict_violation), sauf la mise '
  'a NULL de ip_address / user_agent / source_url (effacement 0006, retention 0016).';

revoke all on function newsletter.consent_event_append_only() from public, anon, authenticated;

drop trigger if exists consent_event_append_only_row on newsletter.consent_event;
create trigger consent_event_append_only_row
  before update or delete on newsletter.consent_event
  for each row execute function newsletter.consent_event_append_only();

drop trigger if exists consent_event_append_only_truncate on newsletter.consent_event;
create trigger consent_event_append_only_truncate
  before truncate on newsletter.consent_event
  for each statement execute function newsletter.consent_event_append_only();

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE 2 — aucun rôle applicatif ne peut réécrire la preuve, le déclencheur MORD, et
-- l'effacement passe encore.
-- ⛔ Sur une VRAIE ligne, parce qu'un déclencheur de ligne ne se déclenche pas sur zéro ligne. Rien
-- n'y reste : les refus lèvent avant d'écrire, et la mise à NULL permise est annulée dans son
-- sous-bloc par une erreur levée exprès (SQLSTATE NF081), attrapée juste après.
-- ⚠️ TRUNCATE n'est vérifié qu'au catalogue : l'exécuter poserait un verrou exclusif sur la table des
-- preuves pendant la migration, et la fonction qu'il appelle est déjà éprouvée par a) et c).
-- ---------------------------------------------------------------------------
do $$
declare
  f      constant regprocedure := 'newsletter.consent_event_append_only()'::regprocedure;
  v_role text;
  v_id   bigint;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role)
       and (has_any_column_privilege(v_role, 'newsletter.consent_event', 'UPDATE')
            or has_table_privilege(v_role, 'newsletter.consent_event', 'DELETE')
            or has_table_privilege(v_role, 'newsletter.consent_event', 'TRUNCATE')) then
      raise exception '[0081] % peut encore modifier, effacer ou vider consent_event', v_role;
    end if;
  end loop;
  -- Le verrou ne doit pas fermer l'écriture NORMALE : sans INSERT, plus aucune inscription n'aurait
  -- de preuve, et le site refuserait tout (write-policy : pas de preuve, pas de jeton).
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and not (has_table_privilege('service_role', 'newsletter.consent_event', 'INSERT')
              and has_table_privilege('service_role', 'newsletter.consent_event', 'SELECT')) then
    raise exception '[0081] service_role a perdu INSERT ou SELECT sur consent_event : plus aucune preuve ne s''ecrirait';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'newsletter.consent_event'::regclass and not tgisinternal
                    and tgname = 'consent_event_append_only_row' and tgenabled = 'O' and tgfoid = f::oid
                    and (tgtype & 27) = 27) then  -- ROW(1) + BEFORE(2) + DELETE(8) + UPDATE(16)
    raise exception '[0081] declencheur de ligne append-only absent, desactive ou mal forme sur consent_event';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'newsletter.consent_event'::regclass and not tgisinternal
                    and tgname = 'consent_event_append_only_truncate' and tgenabled = 'O' and tgfoid = f::oid
                    and (tgtype & 34) = 34) then  -- BEFORE(2) + TRUNCATE(32)
    raise exception '[0081] declencheur TRUNCATE append-only absent, desactive ou mal forme sur consent_event';
  end if;

  select id into v_id from newsletter.consent_event order by id limit 1;
  if v_id is null then
    raise notice '[0081] contre-epreuve 2 : consent_event est vide, execution non eprouvee (droits et catalogue verifies)';
    return;
  end if;

  -- a) Réécrire un fait de preuve : refusé.
  begin
    update newsletter.consent_event set method = coalesce(method, '') || '~0081' where id = v_id;
    raise exception '[0081] un UPDATE de consent_event.method est passe : la preuve est reecrivable';
  exception when restrict_violation then null;
  end;

  -- b) Retirer IP, user-agent et URL source (effacement, rétention) : permis — puis annulé.
  begin
    update newsletter.consent_event
       set ip_address = null, user_agent = null, source_url = null
     where id = v_id;
    raise exception using errcode = 'NF081', message = 'annulation voulue';
  exception when sqlstate 'NF081' then null;
  end;

  -- c) Effacer une preuve : refusé.
  begin
    delete from newsletter.consent_event where id = v_id;
    raise exception '[0081] un DELETE de consent_event est passe : la preuve est effacable';
  exception when restrict_violation then null;
  end;

  raise notice '[0081] contre-epreuve 2 OK : consent_event fermee en UPDATE/DELETE/TRUNCATE, mise a NULL des PII permise';
end
$$;

-- ===========================================================================
-- 3 — Rebonds mous : `subscription.soft_bounce_count`, écrit par le webhook.
-- ===========================================================================
--
-- ⛔ LA COLONNE EXISTE DEPUIS 0001 ET N'A JAMAIS ÉTÉ ÉCRITE (0 ligne non nulle le 24/09/2026). Un
-- échec TEMPORAIRE ne supprime personne — à raison, une panne d'une heure ne doit pas priver
-- quelqu'un de la newsletter pour toujours. Mais sans compteur, une adresse qui échoue à CHAQUE
-- envoi reste servie indéfiniment, et les fournisseurs lisent ces échecs répétés comme une liste
-- mal tenue.
--
-- ⭐ LA RÈGLE, TENUE PAR LE CODE (`apps/public/src/app/api/v1/webhooks/mailgun/handler.ts`) :
--   — le compteur est DÉRIVÉ : nombre de MESSAGES distincts en échec temporaire depuis la dernière
--     livraison réussie, recalculé depuis `email_event` à chaque échec temporaire. Un événement
--     rejoué, ou les tentatives successives de Mailgun pour un même message, comptent une fois ;
--   — une LIVRAISON le remet à zéro : elle prouve que la boîte reçoit. Un rebond DUR ne le remet
--     pas à zéro : c'est un échec, et l'adresse est déjà supprimée ;
--   — au seuil (`SEUIL_REBONDS_MOUS = 4`), suppression PAR MARQUE, par `suppress()` comme le rebond
--     dur, motif `soft_bounce:<n>:<raison>`.
-- ⭐ Cette suppression est LEVÉE par une réinscription confirmée : voir la section 4.
--
-- Rien à créer : la colonne (0001) et l'index `(subscription_id, type)` de `email_event` existent.
-- Ce qui est posé : la définition, écrite sur la colonne. Ce qui est éprouvé : ce dont le webhook a
-- besoin pour l'écrire — sans quoi chaque échec temporaire rendrait 500, rejoué huit heures.

comment on column newsletter.subscription.soft_bounce_count is
  'Rebonds MOUS (0081) : nombre de messages distincts en echec temporaire depuis la derniere livraison '
  'reussie. Ecrit par le webhook Mailgun, recalcule depuis email_event (idempotent), remis a 0 par une '
  'livraison. Au seuil SEUIL_REBONDS_MOUS = 4 : suppression par marque, motif soft_bounce:<n>:<raison>.';

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'newsletter' and table_name = 'subscription'
                    and column_name = 'soft_bounce_count' and data_type = 'integer' and is_nullable = 'NO') then
    raise exception '[0081] subscription.soft_bounce_count absente ou mal typee';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'newsletter.email_event'::regclass and contype = 'c'
                    and pg_get_constraintdef(oid) like '%severity%temporary%') then
    raise exception '[0081] email_event.severity n''accepte plus ''temporary'' : le compteur ne verrait aucun rebond mou';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and not (has_column_privilege('service_role', 'newsletter.subscription', 'soft_bounce_count', 'UPDATE')
              and has_table_privilege('service_role', 'newsletter.email_event', 'SELECT')
              and has_function_privilege('service_role', 'newsletter.suppress(text,uuid,text,text)', 'EXECUTE')) then
    raise exception '[0081] service_role ne peut pas ecrire soft_bounce_count, lire email_event ou appeler suppress';
  end if;
  raise notice '[0081] contre-epreuve 3 OK : le webhook peut compter, ecrire et supprimer';
end
$$;

-- ===========================================================================
-- 4 — Une suppression pour rebonds mous est levée par une réinscription CONFIRMÉE.
-- ===========================================================================
--
-- ⭐ POURQUOI ELLE EST LEVABLE. La personne ne peut confirmer qu'en RECEVANT le lien de confirmation :
-- son clic prouve que la boîte reçoit de nouveau — exactement ce que la suppression pour rebonds mous
-- mettait en doute. Sans cette levée, une boîte pleine quatre fois de suite fermait la marque à
-- cette personne pour toujours, y compris quand elle revient d'elle-même. Un rebond DUR (la boîte
-- n'existe pas) et une PLAINTE (« c'est du spam ») restent DURS.
--
-- ⛔ LA DOCTRINE DE 0073 EST GARDÉE : on NOMME les motifs levables, tout le reste bloque — motif
-- nul ou inconnu compris. Le troisième motif nommé est un PRÉFIXE EXACT, `soft_bounce:`, testé par
-- `starts_with` :
--   — jamais une sous-chaîne : le motif d'un rebond dur embarque le texte du serveur distant
--     (`hard_bounce:<raison>`), qu'un tiers choisit ; une raison contenant « soft_bounce: » rendrait
--     levable un rebond dur ;
--   — jamais `like 'soft_bounce:%'` : `_` y est un joker, et `softXbounce:` passerait.
--
-- ⛔ PAR MARQUE, DES DEUX CÔTÉS. Ce motif est posé en portée `asset` par le webhook ; il n'est levable
-- qu'en portée `asset`, et la levée ne touche que la marque confirmée. Les deux fonctions portent la
-- MÊME condition : si `is_hard_suppressed` disait « levable » là où `lift_voluntary_suppression` ne
-- lève rien, la confirmation partirait, la personne cliquerait, et elle resterait supprimée.
--
-- ⚠️ `outbox_context.hard_suppressed` (0073, puis 0078) APPELLE `is_hard_suppressed` : il suit sans
-- être retouché. Relevé le 24/09/2026 (catalogue de prod et dépôt) : aucune autre copie de la liste
-- des motifs levables, ni en SQL ni en TS. Les deux corps ci-dessous sont ceux de 0073 — identiques
-- à la prod, empreinte comparée le même jour — plus le troisième motif, rien d'autre.
--
-- ⚠️ LA TRACE NE RECOPIE PAS LE MOTIF COMPLET d'un rebond mou : il embarque le texte du serveur
-- distant, qui cite souvent l'adresse. `audit_log` reçoit `soft_bounce`, sans rien après.

create or replace function newsletter.is_hard_suppressed(p_email text, p_asset_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path to 'newsletter', 'extensions'
as $function$
  select exists(
    select 1 from newsletter.suppression
     where email_hash = digest(lower(p_email), 'sha256')
       and (scope = 'global' or asset_id = p_asset_id)
       and coalesce(reason, '') not in ('erasure', 'global_optout')
       and not (scope = 'asset' and starts_with(coalesce(reason, ''), 'soft_bounce:'))
  );
$function$;

comment on function newsletter.is_hard_suppressed(text, uuid) is
  'Suppression qu''une reinscription volontaire ne leve PAS : tout motif sauf erasure, global_optout et, '
  'en portee marque, le prefixe soft_bounce: (0081) — rebond dur, plainte, motif inconnu ou nul restent durs. '
  'Sert a l''inscription et a la confirmation ; les envois editoriaux restent gardes par is_suppressed.';

create or replace function newsletter.lift_voluntary_suppression(
  p_email text,
  p_asset_id uuid,
  p_subscription_id uuid
)
returns integer
language plpgsql
security definer
set search_path to 'newsletter', 'extensions'
as $function$
declare
  motifs text[];
  n integer;
begin
  with levees as (
    delete from newsletter.suppression
     where email_hash = digest(lower(p_email), 'sha256')
       and (reason in ('erasure', 'global_optout')
            or (scope = 'asset' and asset_id = p_asset_id and starts_with(coalesce(reason, ''), 'soft_bounce:')))
    returning case when starts_with(coalesce(reason, ''), 'soft_bounce:') then 'soft_bounce' else reason end as reason
  )
  select array_agg(distinct reason order by reason), count(*)::integer
    into motifs, n
    from levees;

  if n > 0 then
    insert into newsletter.audit_log (actor, action, target_type, target_id, asset_id, meta)
    values ('public-confirm', 'suppression-lifted', 'subscription', p_subscription_id::text, p_asset_id,
            jsonb_build_object('reasons', to_jsonb(motifs), 'rows', n));
  end if;

  return n;
end;
$function$;

comment on function newsletter.lift_voluntary_suppression(text, uuid, uuid) is
  'Leve les suppressions VOLONTAIRES (erasure, global_optout) et, pour la seule marque confirmee, les rebonds '
  'mous (soft_bounce:, 0081) d''une adresse qui vient de CONFIRMER une nouvelle inscription (double opt-in) : '
  'le clic prouve que la boite recoit. Rebond dur et plainte restent. Trace dans audit_log (suppression-lifted) '
  'sans l''adresse ni le texte du rebond. Rend le nombre de lignes levees.';

-- `create or replace` garde les droits ; on les repose quand même, dans l'ordre de 0071.
revoke all on function newsletter.is_hard_suppressed(text, uuid) from public, anon, authenticated;
revoke all on function newsletter.lift_voluntary_suppression(text, uuid, uuid) from public, anon, authenticated;
grant execute on function newsletter.is_hard_suppressed(text, uuid) to service_role;
grant execute on function newsletter.lift_voluntary_suppression(text, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE 4 — le catalogue porte le motif, et les deux fonctions MORDENT pareil.
-- ⛔ Sur des lignes JETABLES (adresses `@example.invalid` tirées au hasard, marque existante),
-- insérées puis annulées dans leur sous-bloc par une erreur levée exprès (SQLSTATE NF081), dont le
-- message rapporte le nombre de cas éprouvés : un banc qui n'aurait rien parcouru ne passe pas.
-- ---------------------------------------------------------------------------
do $$
declare
  v_asset  uuid;
  v_cas    record;
  v_email  text;
  v_dur    boolean;
  v_levees integer;
  v_n      integer := 0;
  v_attendus constant integer := 8;
begin
  -- `position`, pas `like` : dans un motif LIKE, `_` est un joker et le contrôle serait plus lâche
  -- que la règle qu'il vérifie.
  if position('starts_with(coalesce(reason, ''''), ''soft_bounce:'')'
              in pg_get_functiondef('newsletter.is_hard_suppressed(text,uuid)'::regprocedure)) = 0 then
    raise exception '[0081] is_hard_suppressed ne nomme pas le prefixe soft_bounce: comme levable';
  end if;
  if position('starts_with(coalesce(reason, ''''), ''soft_bounce:'')'
              in pg_get_functiondef('newsletter.lift_voluntary_suppression(text,uuid,uuid)'::regprocedure)) = 0 then
    raise exception '[0081] lift_voluntary_suppression ne leve pas le prefixe soft_bounce:';
  end if;
  if position('is_hard_suppressed(' in pg_get_viewdef('newsletter.outbox_context'::regclass)) = 0 then
    raise exception '[0081] outbox_context.hard_suppressed ne passe plus par is_hard_suppressed : la liste divergerait';
  end if;

  select id into v_asset from newsletter.asset order by id limit 1;
  if v_asset is null then
    raise notice '[0081] contre-epreuve 4 : aucune marque, execution non eprouvee (catalogue verifie)';
    return;
  end if;

  begin
    for v_cas in
      select * from (values
        ('soft_bounce:4:generic',          'asset',  false),
        ('hard_bounce:no such user',       'asset',  true),
        ('spam_complaint',                 'asset',  true),
        (null,                             'asset',  true),
        ('soft_bounce',                    'asset',  true),
        ('softXbounce:4',                  'asset',  true),
        ('hard_bounce:550 soft_bounce:1',  'asset',  true),
        ('soft_bounce:4:generic',          'global', true)
      ) as t(motif, portee, dur)
    loop
      v_email := 'ce0081-' || md5(random()::text || clock_timestamp()::text) || '@example.invalid';
      -- Par `suppress()`, le chemin réel du webhook et des préférences : empreinte et portée comprises.
      perform newsletter.suppress(v_email, v_asset, v_cas.motif, v_cas.portee);

      v_dur := newsletter.is_hard_suppressed(v_email, v_asset);
      if v_dur is distinct from v_cas.dur then
        raise exception '[0081] is_hard_suppressed(motif %, portee %) = %, attendu %', v_cas.motif, v_cas.portee, v_dur, v_cas.dur;
      end if;

      v_levees := newsletter.lift_voluntary_suppression(v_email, v_asset, gen_random_uuid());
      if v_levees is distinct from (case when v_cas.dur then 0 else 1 end) then
        raise exception '[0081] lift_voluntary_suppression(motif %, portee %) a leve % ligne(s) : les deux fonctions divergent',
          v_cas.motif, v_cas.portee, v_levees;
      end if;
      v_n := v_n + 1;
    end loop;
    raise exception using errcode = 'NF081', message = v_n::text;
  exception when sqlstate 'NF081' then
    if sqlerrm is distinct from v_attendus::text then
      raise exception '[0081] contre-epreuve 4 : % cas eprouves sur %', sqlerrm, v_attendus;
    end if;
  end;

  raise notice '[0081] contre-epreuve 4 OK : soft_bounce: levable par marque, rebond dur, plainte et motif nul restent durs';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LES CONTRE-ÉPREUVES (voir 0072). Le registre de la CLI
-- Supabase ne correspond pas à ce dossier : la seule preuve qu'une migration est passée est la
-- ligne qu'elle écrit ici.
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0081', '0081_securite_inscription_consentement_rebonds.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
