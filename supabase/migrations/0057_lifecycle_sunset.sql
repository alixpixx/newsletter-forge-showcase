-- ---------------------------------------------------------------------------
-- 0057 — ce qu'il faut mettre en place AVANT d'écrire le moteur de réengagement.
-- ---------------------------------------------------------------------------
--
-- Quatre changements indissociables. Les livrer séparément laisserait, entre deux migrations, un
-- état où le kind `reengagement` est accepté sans que la file sache le classer ni la contrainte de
-- finalité le couvrir : la première vague d'envoi passerait devant les double opt-in en attente et
-- sortirait sans finalité déclarée. Ils sont donc dans le même fichier, dans cet ordre.
--
--  1. La priorité de la file, corrigée AVANT que le kind existe.
--  2. Le kind `reengagement`, et la finalité obligatoire qui va avec.
--  3. `subscription.sunset_at` — marquer sans désabonner (décision d'Alix), + les DEUX vues.
--  4. `lifecycle_send` — l'idempotence que les index de `email_outbox` ne peuvent pas donner.

-- ===========================================================================
-- 1 — LA PRIORITÉ DE LA FILE. Corrigée d'abord, parce qu'elle est fausse dès qu'un kind de masse
--     autre que `campaign` existe.
-- ===========================================================================
--
-- ⛔ CE QUI ÉTAIT ÉCRIT (0023_outbox_priority.sql:56) :
--        order by (case when c.kind = 'campaign' then 1 else 0 end), ...
--     Le tri ne dit pas « les transactionnels d'abord » : il dit « tout ce qui n'est PAS une
--     campagne d'abord ». Tant que les seuls autres kinds sont transactionnels, les deux phrases
--     donnent le même résultat, et rien ne distingue l'intention de l'accident.
--
-- ⛔ CE QUE ÇA CASSE À L'AJOUT DE `reengagement` : un envoi de masse hériterait de la priorité 0 et
--     passerait DEVANT les confirmations d'inscription. Quelqu'un qui vient de laisser son adresse
--     attendrait derrière la vague entière — c'est-à-dire, à l'échelle d'une liste, plusieurs
--     heures pour un e-mail que le lecteur attend dans la seconde, avec sa fenêtre de double opt-in
--     qui court pendant ce temps. Le défaut ne se verrait pas dans le code du moteur : il est ici.
--
-- ⚠️ LE SENS DU DÉFAUT EST INVERSÉ, ET C'EST VOULU. On liste les kinds INTERACTIFS (déclenchés par
--     un geste humain qui attend une réponse) ; tout le reste est de la masse. Un kind ajouté
--     demain sans toucher à cette fonction tombera donc en masse — lent, jamais prioritaire. La
--     liste blanche inverse (« les kinds de masse ») ferait passer tout kind inconnu devant les
--     inscriptions, c'est-à-dire exactement la panne qu'on corrige.
--
-- ⚠️ `test` EST INTERACTIF : c'est un aperçu demandé depuis l'admin, quelqu'un regarde sa boîte en
--     l'attendant. Il était déjà prioritaire avant ce correctif ; il le reste.
--
-- Le reste du corps est identique à 0023 — recopié parce qu'un `create or replace` remplace la
-- fonction entière. Attributs reproduits à l'identique : SECURITY DEFINER et le `search_path` figé
-- (sans eux, la fonction devient exécutable dans le schéma de l'appelant, ce qui est une faille).
create or replace function newsletter.claim_outbox(
  p_worker text,
  p_batch integer default 10,
  p_stale_seconds integer default 300
)
returns setof newsletter.email_outbox
language plpgsql
security definer
set search_path to 'newsletter', 'extensions'
as $function$
begin
  update newsletter.email_outbox
     set status = 'failed',
         error  = coalesce(error, 'max_attempts exhausted while in-flight'),
         locked_at = null, locked_by = null
   where status = 'sending'
     and locked_at < now() - make_interval(secs => p_stale_seconds)
     and attempts >= max_attempts;

  return query
  update newsletter.email_outbox o
     set status    = 'sending',
         attempts  = o.attempts + 1,
         locked_at = now(),
         locked_by = p_worker,
         error     = null
   where o.id in (
     select c.id
       from newsletter.email_outbox c
      where c.next_attempt_at <= now()
        and c.attempts < c.max_attempts
        and ( c.status = 'pending'
           or (c.status = 'sending'
               and c.locked_at < now() - make_interval(secs => p_stale_seconds)) )
      order by (case when c.kind in ('confirmation', 'welcome', 'unsubscribe_ack', 'test')
                     then 0 else 1 end),
               c.next_attempt_at, c.created_at
      for update skip locked
      limit p_batch )
  returning o.*;
end;
$function$;

comment on function newsletter.claim_outbox(text, integer, integer) is
  'Reserve un lot d''emails a envoyer. Priorite 0 aux kinds INTERACTIFS (confirmation, welcome, unsubscribe_ack, test) : un geste humain les attend. Priorite 1 a tout le reste, kinds futurs compris — un envoi de masse ne doit jamais passer devant une confirmation d''inscription. Le tri precedent testait kind <> ''campaign'', ce qui aurait donne la priorite a reengagement.';

-- ===========================================================================
-- 2 — LE KIND `reengagement`, ET SA FINALITÉ.
-- ===========================================================================
alter table newsletter.email_outbox drop constraint if exists email_outbox_kind_check;
alter table newsletter.email_outbox
  add constraint email_outbox_kind_check
  check (kind in ('confirmation', 'welcome', 'unsubscribe_ack', 'campaign', 'test', 'reengagement'));

-- ⛔ LA FINALITÉ EST OBLIGATOIRE POUR UN RÉENGAGEMENT AUSSI. La contrainte ne couvrait que
-- `campaign` : un `reengagement` aurait pu partir avec `purpose` à NULL, c'est-à-dire sans dire au
-- titre de quel consentement on écrit. Or c'est exactement le message le plus exposé — il part à
-- quelqu'un qui ne réagit plus depuis des mois, et c'est celui qu'on aura le plus de mal à
-- justifier s'il est signalé. Un contenu éditorial reste un contenu éditorial parce qu'on l'appelle
-- « réengagement ».
alter table newsletter.email_outbox drop constraint if exists email_outbox_campaign_purpose_required;
alter table newsletter.email_outbox
  add constraint email_outbox_campaign_purpose_required
  check (kind not in ('campaign', 'reengagement') or purpose is not null);

comment on constraint email_outbox_campaign_purpose_required on newsletter.email_outbox is
  'Tout envoi EDITORIAL (campaign, reengagement) porte la finalite au titre de laquelle il est envoye. Les transactionnels en sont dispenses : ils repondent a un geste de l''abonne, pas a un consentement marketing.';

-- ===========================================================================
-- 3 — `sunset_at` : ARRÊTER D'ÉCRIRE SANS DÉSABONNER.
-- ===========================================================================
--
-- ⛔ DÉCISION D'ALIX, ET CE QU'ELLE VEUT DIRE EXACTEMENT. « Marquer sans désabonner » : le `status`
-- reste `active`, le consentement, sa date, sa version et sa preuve restent intacts, la ligne n'est
-- ni supprimée ni transformée. Ce qui change est qu'on CESSE DE LUI ÉCRIRE — c'est toute la raison
-- d'être d'une politique de sunset : continuer d'envoyer à des boîtes qui n'ouvrent plus depuis des
-- mois dégrade la réputation du domaine, et cette dégradation frappe en premier les gens qui, eux,
-- lisent encore.
--
-- ⛔ POURQUOI LE FILTRE EST DANS LA VUE ET NULLE PART AILLEURS. `sendable_subscription` est le seul
-- point d'entrée du fan-out, du compilateur de segments et des comptes de l'admin (9 fichiers).
-- Poser le filtre ici le rend vrai pour tous d'un coup. Le poser dans le moteur d'envoi laisserait
-- les segments compter des gens à qui plus rien ne part, et l'écran annoncerait une audience qui
-- n'existe pas.
--
-- ⚠️ RÉVERSIBLE PAR CONSTRUCTION : remettre `sunset_at` à NULL suffit à réintégrer quelqu'un. C'est
-- ce que fera la réactivation quand elle existera (5C.4) — un abonné marqué qui rouvre ou clique
-- doit ressortir du sunset, sinon la politique devient un aller simple.
--
-- ⚠️ AUCUNE LIGNE N'EST MARQUÉE PAR CETTE MIGRATION. La colonne naît entièrement NULL et rien ne
-- l'écrit encore : le comportement d'envoi est donc RIGOUREUSEMENT inchangé aujourd'hui. Le premier
-- code capable de la poser est le moteur `lifecycle` (5C.4), qui n'existe pas.
alter table newsletter.subscription
  add column if not exists sunset_at timestamptz;

comment on column newsletter.subscription.sunset_at is
  'Date a laquelle on a CESSE d''ecrire a cet abonnement, sans le desabonner : status reste active, le consentement reste intact et prouvable. Non nul = exclu de sendable_subscription. Remettre a NULL reintegre (reactivation apres une ouverture ou un clic).';

create index if not exists idx_subscription_sunset
  on newsletter.subscription (asset_id, sunset_at)
  where sunset_at is not null;

-- ⛔ LES DEUX VUES SONT RECRÉÉES, PAS SEULEMENT CELLE QU'ON FILTRE. Un `select *` dans une vue
-- Postgres est expansé À LA CRÉATION : les deux listaient déjà leurs 29 colonnes une par une, et
-- ajouter `sunset_at` à la table ne l'y aurait PAS ajoutée. On les récrit donc ensemble, avec la
-- colonne, pour qu'elles restent la partition EXACTE de `subscription` — ce qui est vrai de l'une
-- doit rester vrai de l'autre, sinon comparer leurs effectifs cesse d'avoir un sens.
--
-- ⚠️ `create or replace view` REFUSE d'ajouter une colonne ailleurs qu'à la fin, et refuse tout
-- changement d'ordre : `sunset_at` est donc en dernier, après `optin_id`.
create or replace view newsletter.excluded_demo_subscription as
  select s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source, s.source_detail,
         s.language, s.consent_state, s.consent_version_id, s.consent_ip, s.consent_method,
         s.consent_at, s.open_count, s.click_count, s.last_open_at, s.last_click_at,
         s.last_engagement_at, s.engagement_score, s.engagement_level, s.welcome_completed,
         s.soft_bounce_count, s.tag_ids, s.created_at, s.country, s.tracking_consent,
         s.tracking_consent_at, s.granted_purposes, s.optin_id, s.sunset_at
    from newsletter.subscription s
    join newsletter.subscriber sub on sub.id = s.subscriber_id
   where s.status = 'active'
     and not newsletter.is_suppressed(sub.email::text, s.asset_id)
     and sub.is_demo;

create or replace view newsletter.sendable_subscription as
  select s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source, s.source_detail,
         s.language, s.consent_state, s.consent_version_id, s.consent_ip, s.consent_method,
         s.consent_at, s.open_count, s.click_count, s.last_open_at, s.last_click_at,
         s.last_engagement_at, s.engagement_score, s.engagement_level, s.welcome_completed,
         s.soft_bounce_count, s.tag_ids, s.created_at, s.country, s.tracking_consent,
         s.tracking_consent_at, s.granted_purposes, s.optin_id, s.sunset_at
    from newsletter.subscription s
    join newsletter.subscriber sub on sub.id = s.subscriber_id
   where s.status = 'active'
     and not newsletter.is_suppressed(sub.email::text, s.asset_id)
     -- ⛔ NE PAS RETIRER : sans lui, les abonnés de démonstration reçoivent de vrais emails.
     and not sub.is_demo
     -- Le sunset. Voir le commentaire de la colonne : marqué = on n'écrit plus, mais il reste
     -- abonné et son consentement reste valide.
     and s.sunset_at is null;

comment on view newsletter.sendable_subscription is
  'Les abonnements a qui on a le droit d''ecrire : actifs, non supprimes, non demo, et non sunsetted. Point d''entree UNIQUE du fan-out, du compilateur de segments et des comptes de l''admin — un filtre pose ici vaut pour tous.';

-- ===========================================================================
-- 4 — `lifecycle_send` : L'IDEMPOTENCE QUE `email_outbox` NE PEUT PAS DONNER.
-- ===========================================================================
--
-- ⛔ POURQUOI LES INDEX EXISTANTS NE COUVRENT PAS CE CAS. `uq_outbox_occurrence_subscription`
-- (0032) exige `occurrence_id is not null` ; `uq_outbox_campaign_subscription` (0037) exige
-- `kind = 'campaign'` ET `campaign_id is not null`. Un réengagement n'a ni occurrence ni campagne :
-- il ne tombe sous AUCUN des deux, et `on conflict do nothing` — qui couvre pourtant tous les index
-- uniques de la table — ne rattraperait donc rien. Un moteur qui replante après avoir écrit la
-- moitié de sa vague et qu'on relance écrirait la première moitié DEUX FOIS.
--
-- ⛔ POURQUOI PAS UN INDEX UNIQUE SUR `(subscription_id) where kind = 'reengagement'`. Il
-- interdirait DÉFINITIVEMENT un second réengagement au même abonné, y compris deux ans plus tard
-- après qu'il est revenu puis reparti. Un état terminal qu'on ne peut pas quitter n'est pas une
-- garde, c'est une perte.
--
-- Ce qu'on veut borner est plus précis : un abonné ne reçoit jamais deux fois LA MÊME ÉTAPE de la
-- même séquence. `step` vaut 1 pour une relance simple ; une séquence « on vous a manqué » /
-- « dernière chance » se numérote 1, 2 sans nouvelle migration.
create table if not exists newsletter.lifecycle_send (
  id              uuid primary key default gen_random_uuid(),
  asset_id        uuid not null references newsletter.asset(id) on delete cascade,
  subscription_id uuid not null references newsletter.subscription(id) on delete cascade,
  kind            text not null check (kind in ('reengagement')),
  step            integer not null default 1 check (step >= 1),
  -- ⚠️ `on delete set null` : la trace de l'envoi doit SURVIVRE à la purge de la file. Si la ligne
  -- d'outbox disparaît et emporte la trace avec elle, l'abonné redevient éligible et reçoit une
  -- seconde fois le même message — la purge deviendrait un ré-envoi.
  outbox_id       uuid references newsletter.email_outbox(id) on delete set null,
  created_at      timestamptz not null default now()
);

-- ⛔ L'UNICITÉ EST LA RAISON D'ÊTRE DE LA TABLE. Sans elle, elle ne serait qu'un journal — et un
-- journal ne prévient pas un doublon, il le raconte après coup.
create unique index if not exists uq_lifecycle_send_subscription_kind_step
  on newsletter.lifecycle_send (subscription_id, kind, step);

-- Le plafond quotidien par marque (5C.4) se lit ici : « combien de réengagements pour cet asset
-- depuis minuit ». L'index le rend praticable sans parcourir la table.
create index if not exists idx_lifecycle_send_asset_created
  on newsletter.lifecycle_send (asset_id, created_at desc);

comment on table newsletter.lifecycle_send is
  'Trace d''idempotence des envois de cycle de vie. Un abonnement ne recoit jamais deux fois la meme etape (subscription_id, kind, step). Necessaire parce qu''un reengagement n''a ni occurrence_id ni campaign_id : les index uniques partiels de email_outbox ne le couvrent pas. Sert aussi de compteur pour le plafond quotidien par marque.';

-- RLS activée sans aucune policy : personne ne lit, sauf `service_role` qui la contourne. Cette
-- table dit qui a reçu quoi et quand.
--
-- ⚠️ MESURÉ LE 08/09/2026, POUR NE PAS SE TROMPER SUR CE QUI PROTÈGE QUOI : `anon` n'a pas même
-- USAGE sur le schéma `newsletter`, et aucun privilège sur aucune de ses tables. La vraie garde est
-- donc au niveau du SCHÉMA, pas de la RLS — c'est ce qui explique que `email_event` et `optin`
-- vivent aujourd'hui sans RLS sans être pour autant exposées. On l'active quand même ici : le jour
-- où quelqu'un ouvrira le schéma à PostgREST pour une seule vue, cette table ne doit pas devenir
-- lisible par accident. Aucun `revoke` n'est écrit : retirer un droit que personne n'a laisserait
-- croire qu'il y avait quelque chose à retirer.
alter table newsletter.lifecycle_send enable row level security;

notify pgrst, 'reload schema';
