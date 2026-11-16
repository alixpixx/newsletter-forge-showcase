-- ============================================================================
-- 0082 — La section Automations : deux tables, deux kinds, une fonction de sélection atomique.
-- ============================================================================
--
-- ⭐ POURQUOI. Demande d'Alix (24/09/2026) : une section « Automations » dans le backoffice, pour les
-- e-mails déclenchés par un événement ou une date (relance de confirmation, préférences mises à jour,
-- retour d'un désinscrit, réengagement, sunset, anniversaire, renouvellement du consentement, promo
-- par opt-in). Plan : `tasks/plan-automations.md`, étape 6. Catalogue des déclencheurs et de leurs
-- gardes : `packages/automations/src/catalog.ts` — CE FICHIER EN RECOPIE LES RÈGLES, garde pour garde.
--
-- ⛔ ENVOYER = ÉCRIRE UNE LIGNE DANS `email_outbox`. Le drain résident la prend en ~5 s, en `live`,
-- allowlist ouverte. Tout ce qui suit sert à ce qu'une ligne n'y entre QUE si l'automation est armée
-- en réel, que le worker peut envoyer, que la personne est éligible, et qu'elle ne l'a jamais reçue.
--
-- ⛔ ÉCRITE, JAMAIS APPLIQUÉE. Aucune base jetable n'existe pour ce dépôt et la base de production
-- envoie de vrais e-mails : la fonction ci-dessous n'a JAMAIS tourné. Syntaxe vérifiée hors ligne
-- (analyseur Postgres) ; sémantique à éprouver sur une copie AVANT de l'appliquer (étape 16 du plan,
-- décision d'Alix). Suppose 0081 appliquée avant, sans en dépendre.
--
-- Cinq objets, dans cet ordre :
--  1. `automation`       — une automation par marque : déclencheur (liste FERMÉE), filtres, étapes,
--                          état draft → simulation → live ⇄ paused, plafond, fenêtre horaire.
--  2. `automation_send`  — la trace d'idempotence, écrite AVANT la mise en file.
--  3. les kinds `automation` (marketing) et `automation_tx` (transactionnel strict).
--  4. `outbox_context`   — le pied légal du modèle choisi, comme pour un envoi de test.
--  5. `automation_due`   — la sélection atomique, sur le modèle d'`enqueue_reengagement_batch` (0058).

-- ===========================================================================
-- 1 — `automation`
-- ===========================================================================
--
-- ⛔ LE DÉCLENCHEUR EST UNE LISTE FERMÉE, EN BASE AUSSI. L'admin n'expose que le catalogue ; une ligne
-- écrite à la main avec un déclencheur inventé serait refusée ici plutôt qu'ignorée par le moteur.
-- `migration-sync.test.ts` rougit si cette liste diverge de `TRIGGER_IDS`.
--
-- ⚠️ `filters`, `settings` et `steps` sont en jsonb : la base ne vérifie que leur FORME. Leur contenu
-- est validé clé par clé par `validateAutomation` (admin avant d'écrire, worker avant d'exécuter), et
-- `automation_due` refuse ce qu'elle ne sait pas lire (`bad_filters`, `bad_settings`, `bad_step`).
--
-- ⛔ NAÎT `draft`. Le premier état armé est TOUJOURS `simulation` (elle calcule, trace, n'écrit rien
-- dans `email_outbox`) ; `live` exige en plus que le worker tourne en `WORKER_MODE=live`.
create table if not exists newsletter.automation (
  id                uuid primary key default gen_random_uuid(),
  asset_id          uuid not null references newsletter.asset(id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 1 and 120),
  trigger           text not null check (trigger in (
                      'confirmation_reminder', 'preferences_updated', 'welcome_back', 'reengagement',
                      'sunset', 'anniversary', 'consent_renewal', 'soft_bounce_rule', 'optin_promo')),
  filters           jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  settings          jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  steps             jsonb not null default '[]'::jsonb
                      check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 5),
  status            text not null default 'draft' check (status in ('draft', 'simulation', 'live', 'paused')),
  purpose           text check (purpose is null or purpose in ('content', 'offers', 'events', 'partners')),
  daily_cap         integer not null default 50 check (daily_cap between 1 and 2000),
  window_start_hour smallint not null default 8 check (window_start_hour between 0 and 23),
  window_end_hour   smallint not null default 20 check (window_end_hour between 1 and 24),
  timezone          text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  -- Curseur `consent_event.id` des déclencheurs événementiels. NULL = jamais passé : la première passe
  -- le POSE au dernier événement et ne sélectionne rien (aucun envoi rétroactif).
  event_cursor      bigint,
  last_run_at       timestamptz,
  created_by        text,
  updated_by        text,
  armed_by          text,
  armed_at          timestamptz,
  -- Le dernier changement de STATUT, écrit par l'admin à chaque transition (le moteur n'y touche pas).
  -- ⛔ C'est lui qui dit si la simulation a TOURNÉ depuis qu'on l'a lancée : `simulation → live` exige
  -- un `last_run_at` ou une trace simulée POSTÉRIEURS — pas ceux d'une simulation d'avant le dernier
  -- retour au brouillon, faite sur d'autres réglages.
  status_changed_at timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint automation_window_check check (window_start_hour < window_end_hour),
  -- ⛔ UN MARKETING ARMÉ PORTE SA FINALITÉ. Sans elle, la porte ne vérifierait aucun consentement
  -- (`canSend` ne teste la finalité que si la ligne en porte une) : le filet est posé en base aussi.
  constraint automation_marketing_purpose check (
    status in ('draft', 'paused')
    or trigger not in ('preferences_updated', 'welcome_back', 'reengagement', 'anniversary', 'optin_promo')
    or purpose is not null
  ),
  -- ⛔ UN NON-MARKETING NE PORTE PAS DE FINALITÉ : ce serait un marketing qui s'ignore.
  constraint automation_non_marketing_no_purpose check (
    trigger in ('preferences_updated', 'welcome_back', 'reengagement', 'anniversary', 'optin_promo')
    or purpose is null
  )
);

comment on table newsletter.automation is
  'Automations par marque (section Automations, 0082). trigger = catalogue FERME (packages/automations). '
  'status draft -> simulation -> live <-> paused : seule live + WORKER_MODE=live ecrit dans email_outbox ; '
  'simulation n''ecrit que automation_send(simulated). Executee par automation_due, appelee depuis la tache plan du worker.';

create index if not exists idx_automation_armed
  on newsletter.automation (status)
  where status in ('simulation', 'live');

create index if not exists idx_automation_asset
  on newsletter.automation (asset_id);

-- RLS activée sans policy, comme `lifecycle_send` (0057) : personne ne lit sauf `service_role`.
alter table newsletter.automation enable row level security;

-- ===========================================================================
-- 2 — `automation_send` : la trace, écrite AVANT la file.
-- ===========================================================================
--
-- ⛔ L'UNICITÉ `(automation_id, subscription_id, step, period_key)` EST LA RAISON D'ÊTRE DE LA TABLE.
-- `period_key` rend la trace juste pour ce qui se répète : l'année pour l'anniversaire, la demande
-- d'inscription pour la relance, le jour de référence d'engagement pour le réengagement, l'opt-in pour
-- la promo. `(subscription_id, kind, step)` — le modèle de `lifecycle_send` — interdirait le 2ᵉ
-- anniversaire.
--
-- ⛔ UNE LIGNE SIMULÉE OCCUPE LE CRÉNEAU, ET C'EST VOULU. Une automation passe 24 h en simulation avant
-- d'être armée ; si les créneaux simulés restaient libres, armer enverrait d'un coup tout ce que la
-- simulation a vu — exactement la « liste stockée qui part après » qu'Alix a interdite le 15/09. Armer
-- ne rejoue donc rien : seuls les cas NOUVEAUX partent. Même raison pour l'étape N+1, qui exige
-- l'étape N dans le MÊME mode.
--
-- ⚠️ `outbox_id on delete set null` : la trace survit à une purge de la file, sinon la purge
-- deviendrait un ré-envoi (même raison que 0057). `automation_id` sans cascade : on ne supprime pas
-- une automation qui a écrit, on la met en pause — son historique est la preuve de ce qui est parti.
create table if not exists newsletter.automation_send (
  id              uuid primary key default gen_random_uuid(),
  automation_id   uuid not null references newsletter.automation(id),
  asset_id        uuid not null references newsletter.asset(id) on delete cascade,
  subscription_id uuid not null references newsletter.subscription(id) on delete cascade,
  step            integer not null check (step between 1 and 5),
  period_key      text not null default '' check (char_length(period_key) <= 64),
  simulated       boolean not null,
  outbox_id       uuid references newsletter.email_outbox(id) on delete set null,
  reason          text not null check (char_length(reason) between 1 and 80),
  created_at      timestamptz not null default now()
);

create unique index if not exists uq_automation_send_slot
  on newsletter.automation_send (automation_id, subscription_id, step, period_key);

-- Le plafond quotidien et le journal de simulation se lisent par automation et par date.
create index if not exists idx_automation_send_automation_created
  on newsletter.automation_send (automation_id, created_at desc);

create index if not exists idx_automation_send_subscription
  on newsletter.automation_send (subscription_id);

comment on table newsletter.automation_send is
  'Trace d''idempotence des automations (0082). Unique (automation_id, subscription_id, step, period_key). '
  'Ecrite AVANT email_outbox, dans la meme transaction. simulated = true : rien n''est parti, mais le creneau '
  'est pris (armer ne rejoue pas la simulation). Sert aussi de compteur du plafond quotidien.';

alter table newsletter.automation_send enable row level security;

-- ===========================================================================
-- 3 — LES KINDS `automation` ET `automation_tx`.
-- ===========================================================================
--
-- Les endroits qu'un kind neuf touche (carte `envoi.md` § 6) et ce que 0082 y fait :
--  · `email_outbox_kind_check`                  : les deux kinds ajoutés (ci-dessous).
--  · `email_outbox_campaign_purpose_required`   : `automation` exige sa finalité (ci-dessous).
--  · `claim_outbox` / `claim_outbox_interactive`: NON MODIFIÉES, délibérément. Elles nomment les kinds
--    INTERACTIFS ; tout autre kind est de la masse (0057:32-36). Une automation n'est pas un geste
--    humain qui attend : elle reste sous le plafond des newsletters (contre-épreuve ci-dessous).
--  · `lifecycle_template_kind_check`, `lifecycle_send` : NON MODIFIÉES. Une automation porte son modèle
--    sur la ligne (`template_version_id`) et sa trace dans `automation_send`.
--  · porte (`gate.ts`), rendu (`render.ts`), `List-Unsubscribe` (`process.ts`) : côté worker, même lot.
--  · `OutboxKind` de `apps/public` : NON MODIFIÉ — l'app publique n'enfile jamais une automation ;
--    seule `automation_due` écrit ces deux kinds.
alter table newsletter.email_outbox drop constraint if exists email_outbox_kind_check;
alter table newsletter.email_outbox
  add constraint email_outbox_kind_check
  check (kind in ('confirmation', 'welcome', 'unsubscribe_ack', 'campaign', 'test', 'reengagement',
                  'automation', 'automation_tx'));

-- ⛔ UN ENVOI D'AUTOMATION MARKETING DIT AU TITRE DE QUEL CONSENTEMENT IL PART (même raison que 0057).
alter table newsletter.email_outbox drop constraint if exists email_outbox_campaign_purpose_required;
alter table newsletter.email_outbox
  add constraint email_outbox_campaign_purpose_required
  check (kind not in ('campaign', 'reengagement', 'automation') or purpose is not null);

comment on constraint email_outbox_campaign_purpose_required on newsletter.email_outbox is
  'Tout envoi EDITORIAL (campaign, reengagement, automation) porte la finalite au titre de laquelle il est envoye. Les transactionnels (automation_tx compris) en sont dispenses.';

-- ⛔ L'EXCEPTION TRANSACTIONNELLE EST BORNÉE AU DÉCLENCHEUR, EN BASE. `automation_tx` est le seul kind
-- d'automation qui passe la porte `not_active` ; il n'existe QUE pour la relance de confirmation (qui
-- porte obligatoirement son lien) et le renouvellement du consentement. Une ligne `automation_tx`
-- d'un autre déclencheur — ou sans déclencheur — est refusée à l'écriture. `coalesce` : une
-- contrainte CHECK dont l'expression vaut NULL PASSE ; sans lui, un payload vide passerait.
alter table newsletter.email_outbox drop constraint if exists email_outbox_automation_tx_trigger;
alter table newsletter.email_outbox
  add constraint email_outbox_automation_tx_trigger
  check (
    kind <> 'automation_tx'
    or (coalesce(payload->>'automation_trigger', '') = 'confirmation_reminder' and action_url is not null)
    or coalesce(payload->>'automation_trigger', '') = 'consent_renewal'
  );

-- ⛔ UNE LIGNE D'AUTOMATION DIT D'OÙ ELLE VIENT ET CE QU'ELLE REND. Sans `automation_id` au payload,
-- impossible de répondre « quelle automation a écrit à cette personne ? » ; sans version de modèle, le
-- rendu n'aurait rien à hydrater (`no_compiled_shell`).
alter table newsletter.email_outbox drop constraint if exists email_outbox_automation_origin;
alter table newsletter.email_outbox
  add constraint email_outbox_automation_origin
  check (
    kind not in ('automation', 'automation_tx')
    or (coalesce(payload ? 'automation_id', false) and template_version_id is not null)
  );

-- ===========================================================================
-- 4 — `outbox_context` : le pied légal du MODÈLE, comme pour un envoi de test.
-- ===========================================================================
--
-- Une automation rend la version de modèle portée par sa ligne (`template_version_id`), exactement
-- comme `test` et `campaign`. Le pied légal doit donc venir du même endroit (`lft_tv`, le pied choisi
-- dans le modèle) — sinon l'e-mail parti n'aurait pas le pied que l'auteur a vu à l'envoi de test.
--
-- ⛔ LE CORPS EST CELUI DE LA PROD. Relu le 24/09/2026 par `pg_get_viewdef('newsletter.outbox_context')`
-- et comparé mot à mot au corps de 0078 (espaces et parenthèses d'affichage ignorés) : identiques, à
-- l'alias près que Postgres omet quand il égale le nom de colonne (`e.from_name AS from_name`). SEULE
-- modification : `ARRAY['test', 'campaign']` devient `ARRAY['test', 'campaign', 'automation',
-- 'automation_tx']`. Mêmes colonnes, même ordre : `create or replace view` échoue plutôt que de déformer.
--
-- ⚠️ SI UNE MIGRATION ENTRE 0079 ET 0082 RECRÉE AUSSI CETTE VUE (0081 comprise), CE CORPS EST À REBASER
-- sur le sien.
create or replace view newsletter.outbox_context as
 SELECT o.id,
    o.kind,
    o.subject,
    o.action_url,
    o.payload,
    o.to_email,
    o.status,
    o.attempts,
    o.max_attempts,
    o.next_attempt_at,
    o.created_at,
    o.asset_id,
    o.subscription_id,
    a.name AS asset_name,
    a.slug AS asset_slug,
    COALESCE(e.sending_subdomain, a.sending_subdomain) AS sending_subdomain,
    e.compliance_regime,
        CASE
            WHEN o.kind = ANY (ARRAY['test'::text, 'campaign'::text, 'automation'::text, 'automation_tx'::text]) THEN COALESCE(lft_tv.config, e.legal_footer)
            ELSE COALESCE(lft_lc.config, e.legal_footer)
        END AS legal_footer,
    e.language,
    s.status AS sub_status,
    s.subscriber_id,
    s.tracking_consent,
    newsletter.is_suppressed(o.to_email::text, o.asset_id) AS suppressed,
    o.purpose,
    e.market,
    e.consent_mode,
    s.granted_purposes,
    o.campaign_id,
    o.template_version_id,
    tv.html_shell AS template_html_shell,
    tv.text_shell AS template_text_shell,
    c.html_shell AS campaign_html_shell,
    c.text_shell AS campaign_text_shell,
    o.occurrence_id,
    occ.html_shell AS occurrence_html_shell,
    occ.text_shell AS occurrence_text_shell,
    occ.status AS occurrence_status,
    occ.seq AS occurrence_seq,
    occ.local_date AS occurrence_local_date,
    c.name AS campaign_name,
    (c.scheduled_at AT TIME ZONE COALESCE(c.timezone, 'UTC'::text))::date AS campaign_local_date,
    occ.first_article_title AS occurrence_first_article,
    occ.article_count AS occurrence_article_count,
    occ.ai_intro AS occurrence_ai_intro,
    occ.ai_preheader AS occurrence_ai_preheader,
    c.ai_intro AS campaign_ai_intro,
    c.ai_preheader AS campaign_ai_preheader,
    ltv.html_shell AS lifecycle_html_shell,
    ltv.text_shell AS lifecycle_text_shell,
    ltv.subject AS lifecycle_subject,
    newsletter.is_hard_suppressed(o.to_email::text, o.asset_id) AS hard_suppressed,
    e.from_name AS from_name,
    e.reply_to AS reply_to
   FROM newsletter.email_outbox o
     LEFT JOIN newsletter.asset a ON a.id = o.asset_id
     LEFT JOIN newsletter.subscription s ON s.id = o.subscription_id
     LEFT JOIN newsletter.template_version tv ON tv.id = o.template_version_id
     LEFT JOIN newsletter.campaign c ON c.id = o.campaign_id
     LEFT JOIN newsletter.campaign_occurrence occ ON occ.id = o.occurrence_id
     LEFT JOIN newsletter.lifecycle_template lt ON lt.asset_id = o.asset_id AND lt.kind = o.kind
     LEFT JOIN newsletter.template lft ON lft.id = lt.template_id AND lft.archived_at IS NULL
     LEFT JOIN newsletter.template_version ltv ON ltv.id = lft.current_version_id AND ltv.status = 'published'::text
     LEFT JOIN newsletter.legal_footer_template lft_tv ON lft_tv.id = tv.legal_footer_template_id AND lft_tv.asset_id = o.asset_id
     LEFT JOIN newsletter.legal_footer_template lft_lc ON lft_lc.id = ltv.legal_footer_template_id AND lft_lc.asset_id = o.asset_id
     LEFT JOIN LATERAL ( SELECT ed.id,
            ed.asset_id,
            ed.market,
            ed.language,
            ed.compliance_regime,
            ed.data_residency,
            ed.timezone,
            ed.branding,
            ed.legal_footer,
            ed.sending_subdomain,
            ed.wp_connection_id,
            ed.created_at,
            ed.consent_mode,
            ed.proof_retention_years,
            ed.slug,
            ed.is_primary,
            ed.from_name,
            ed.reply_to
           FROM newsletter.asset_edition ed
          WHERE ed.asset_id = o.asset_id
          ORDER BY (ed.id = s.edition_id) DESC NULLS LAST, ed.id
         LIMIT 1) e ON true;

-- ===========================================================================
-- 5 — `automation_due` : QUI, pour UNE étape d'UNE automation, et la mise en file.
-- ===========================================================================
--
-- ⛔ TOUT EST DANS LA FONCTION, ET POUR LA MÊME RAISON QUE 0058. La sélection DOIT être atomique avec
-- l'écriture : entre un `select` côté worker et l'`insert`, une seconde passe verrait les mêmes
-- candidats. L'anti-jointure sur `automation_send` ne protège que si elle est évaluée dans la même
-- transaction que l'insertion.
--
-- ⛔ L'ORDRE DES ÉCRITURES N'EST PAS INTERCHANGEABLE. `automation_send` D'ABORD : c'est elle qui porte
-- l'unicité ; un conflit y signifie « déjà traité » et rien n'entre dans la file.
--
-- ⛔ `email_outbox` N'EST ÉCRITE QUE SI LES TROIS SONT VRAIS : l'automation est `live`, le worker dit
-- que le drain PEUT envoyer (`p_live_allowed`, soit `WORKER_MODE=live`), et ce n'est pas une sonde
-- (`p_probe`). `simulation` n'écrit QUE `automation_send(simulated = true)` ; `draft` et `paused`
-- n'écrivent RIEN. Une automation `live` sur un worker en `dry-run` n'écrit rien non plus
-- (`drain_cannot_send`) : la simuler occuperait les créneaux de vrais envois.
--
-- ⛔ JAMAIS DEUX PASSES SIMULTANÉES SUR LA MÊME AUTOMATION : verrou consultatif de TRANSACTION (relâché
-- au commit, donc jamais orphelin) + `for update` sur la ligne. Une seconde passe rend `busy`.
--
-- ⛔ LES ABONNÉS DE DÉMONSTRATION NE SONT JAMAIS CANDIDATS : `sendable_subscription` les exclut pour
-- tous les déclencheurs sauf la relance, qui les exclut elle-même — et une seconde passe les retire
-- encore, ceinture ET bretelles, pour tous.
--
-- ⚠️ LES RÈGLES D'ÉLIGIBILITÉ SONT CELLES DE `packages/automations/src/catalog.ts`, garde pour garde
-- (le nom de la garde est en commentaire sur chaque condition). Modifier l'une sans l'autre fait mentir
-- l'écran d'aperçu.
--
-- Paramètres :
--   p_step             étape évaluée (1 à 5) ; le moteur appelle les étapes dans l'ordre.
--   p_batch            taille de lot (bornée à 500), en plus du plafond quotidien de l'automation.
--   p_allowlist        `WORKER_ALLOWLIST` du worker, en minuscules (adresses exactes ou domaines).
--                      `*` = ouverte. Vide en réel = refus (`no_allowlist`) ; vide en simulation =
--                      aucun filtre (on veut voir la population réelle).
--   p_live_allowed     le drain peut-il envoyer ? (`WORKER_MODE=live`)
--   p_confirm_base_url origine publique, pour émettre un NOUVEAU lien de confirmation (relance).
--   p_probe            compter seulement : n'écrit RIEN, pas même la simulation ni le curseur
--                      (aperçu d'audience de l'admin ; accepte une automation `draft`). Rend en plus
--                      `sample` : 5 adresses au plus, MASQUÉES ici (`abc…@domaine`) — l'admin n'en
--                      reçoit jamais une entière.
create or replace function newsletter.automation_due(
  p_automation_id    uuid,
  p_step             integer,
  p_batch            integer default 100,
  p_allowlist        text[]  default null,
  p_live_allowed     boolean default false,
  p_confirm_base_url text    default null,
  p_probe            boolean default false
)
returns table (
  eligible   integer,  -- candidats après TOUTES les gardes, avant plafond
  allowed    integer,  -- ce que le plafond du jour et le lot autorisent
  written    integer,  -- traces écrites (simulées ou réelles) ; 0 en sonde
  simulated  boolean,  -- la passe a-t-elle écrit en simulation ?
  daily_used integer,  -- traces déjà écrites aujourd'hui (dans le fuseau de l'automation), même mode
  reason     text,     -- pourquoi la passe s'est arrêtée là
  sample     text[]    -- sonde seulement : 5 adresses MASQUÉES au plus, dans l'ordre du lot ; NULL sinon
)
language plpgsql
security definer
set search_path to 'newsletter', 'extensions'
-- ⚠️ Les ajouts de mois et les dates d'anniversaire se calculent en UTC, comme `catalog.ts`.
set timezone to 'UTC'
as $$
declare
  a             newsletter.automation%rowtype;
  v_step        jsonb;
  v_prev        jsonb;
  v_delay       interval;
  v_gap         interval := interval '12 hours';
  v_tv_id       uuid;
  v_subject     text;
  v_kind        text;
  v_sends       boolean;
  v_marketing   boolean;
  v_simulated   boolean;
  v_used        integer;
  v_allowed     integer;
  v_hour        integer;
  v_day_start   timestamptz;
  v_horizon     constant interval := interval '7 days';
  v_min_gap     constant interval := interval '12 hours';
  v_optins      uuid[];
  v_langs       text[];
  v_interests   integer[];
  v_cursor      bigint;
  v_months      integer;
  v_catchup     integer;
  v_grace       integer;
  v_untracked   boolean;
  v_require_re  boolean;
  v_today       date;
begin
  eligible := 0; allowed := 0; written := 0; simulated := true; daily_used := 0; reason := null; sample := null;

  -- ⛔ Une seule passe à la fois par automation. `try` : on ne fait pas la queue derrière une passe
  -- lente, on rend la main — la suivante (dans dix minutes) reprendra.
  if not pg_try_advisory_xact_lock(hashtext('newsletter.automation_due'), hashtext(p_automation_id::text)) then
    reason := 'busy'; return next; return;
  end if;

  select * into a from newsletter.automation where id = p_automation_id for update;
  if not found then reason := 'not_found'; return next; return; end if;

  -- ⛔ La règle système (rebonds mous) est appliquée par le webhook (0081) : rien à exécuter ici.
  if a.trigger not in ('confirmation_reminder', 'preferences_updated', 'welcome_back', 'reengagement',
                       'sunset', 'anniversary', 'consent_renewal', 'optin_promo') then
    reason := 'no_engine'; return next; return;
  end if;

  if not p_probe then
    if a.status not in ('simulation', 'live') then reason := 'not_armed'; return next; return; end if;
    if a.status = 'live' and not coalesce(p_live_allowed, false) then
      reason := 'drain_cannot_send'; return next; return;
    end if;
    -- ⛔ En réel, une allowlist absente n'est pas « ouverte » : même règle que les gardes de boot.
    if a.status = 'live' and (p_allowlist is null or cardinality(p_allowlist) = 0) then
      reason := 'no_allowlist'; return next; return;
    end if;
  end if;

  v_simulated := a.status <> 'live';
  simulated := v_simulated;
  v_sends := a.trigger <> 'sunset';
  v_marketing := a.trigger in ('preferences_updated', 'welcome_back', 'reengagement', 'anniversary', 'optin_promo');
  v_kind := case when v_marketing then 'automation'
                 when a.trigger in ('confirmation_reminder', 'consent_renewal') then 'automation_tx' end;

  -- L'étape : un délai (heures depuis le déclencheur) et, si le déclencheur envoie, une version publiée.
  if p_step is null or p_step < 1 or p_step > 5 then reason := 'bad_step'; return next; return; end if;
  v_step := a.steps -> (p_step - 1);
  if v_step is null or jsonb_typeof(v_step) <> 'object' then reason := 'no_such_step'; return next; return; end if;
  if coalesce(v_step->>'delay_hours', '') !~ '^[0-9]{1,6}$' then reason := 'bad_step'; return next; return; end if;
  v_delay := make_interval(hours => (v_step->>'delay_hours')::integer);
  if p_step > 1 then
    v_prev := a.steps -> (p_step - 2);
    if coalesce(v_prev->>'delay_hours', '') !~ '^[0-9]{1,6}$' then reason := 'bad_step'; return next; return; end if;
    v_gap := greatest(v_delay - make_interval(hours => (v_prev->>'delay_hours')::integer), v_min_gap);
  end if;

  -- ⛔ Finalité : obligatoire pour le marketing, interdite ailleurs (voir les contraintes de la table).
  if v_marketing and (a.purpose is null or a.purpose not in ('content', 'offers', 'events', 'partners')) then
    reason := 'missing_purpose'; return next; return;
  end if;

  if v_sends and not p_probe then
    -- ⛔ LA VERSION DE MODÈLE EST FIGÉE DANS L'ÉTAPE ET RELUE ICI : publiée, de CETTE marque, modèle non
    -- archivé, HTML compilé présent. Ce qu'on a simulé est ce qui part — pas « la dernière version ».
    if coalesce(v_step->>'template_version_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      reason := 'no_template'; return next; return;
    end if;
    select tv.id, tv.subject into v_tv_id, v_subject
      from newsletter.template_version tv
      join newsletter.template t on t.id = tv.template_id
     where tv.id = (v_step->>'template_version_id')::uuid
       and t.asset_id = a.asset_id
       and t.archived_at is null
       and tv.status = 'published'
       and coalesce(tv.html_shell, '') <> '';
    if v_tv_id is null or coalesce(btrim(v_subject), '') = '' then
      reason := 'template_unusable'; return next; return;
    end if;
    -- ⛔ Un NOUVEAU lien de confirmation a besoin de l'origine publique. On refuse AVANT d'écrire quoi
    -- que ce soit, plutôt que d'enfiler un lien vers nulle part.
    if a.trigger = 'confirmation_reminder' and not v_simulated and coalesce(btrim(p_confirm_base_url), '') = '' then
      reason := 'no_confirm_base_url'; return next; return;
    end if;
  end if;

  -- Réglages et filtres : illisibles = refus nommé, jamais « au mieux ».
  begin
    v_optins    := array(select x::uuid from jsonb_array_elements_text(coalesce(a.filters->'optin_ids', '[]'::jsonb)) x);
    v_langs     := array(select lower(x) from jsonb_array_elements_text(coalesce(a.filters->'languages', '[]'::jsonb)) x);
    v_interests := array(select x::integer from jsonb_array_elements_text(coalesce(a.filters->'interest_ids', '[]'::jsonb)) x);
  exception when others then
    reason := 'bad_filters'; return next; return;
  end;
  begin
    v_untracked  := coalesce((a.settings->>'include_untracked')::boolean, false);
    v_require_re := coalesce((a.settings->>'require_reengagement')::boolean, true);
    v_grace      := coalesce((a.settings->>'grace_days')::integer, 14);
    v_catchup    := coalesce((a.settings->>'catchup_days')::integer, 3);
    v_months     := coalesce((a.settings->>'months')::integer, 24);
  exception when others then
    reason := 'bad_settings'; return next; return;
  end;
  if v_grace not between 1 and 90 or v_catchup not between 0 and 14 or v_months not between 6 and 60 then
    reason := 'bad_settings'; return next; return;
  end if;
  if a.trigger = 'optin_promo' and cardinality(v_optins) = 0 then
    reason := 'missing_optin_filter'; return next; return;
  end if;

  -- Fuseau : début du jour (plafond) et fenêtre horaire (seulement pour ce qui ENVOIE).
  begin
    v_day_start := date_trunc('day', now() at time zone a.timezone) at time zone a.timezone;
    v_hour := extract(hour from (now() at time zone a.timezone))::integer;
  exception when others then
    reason := 'bad_timezone'; return next; return;
  end;
  if v_sends and not p_probe and (v_hour < a.window_start_hour or v_hour >= a.window_end_hour) then
    reason := 'outside_window'; return next; return;
  end if;

  -- ⛔ Curseur des déclencheurs événementiels. Jamais posé = première passe : on le POSE au dernier
  -- événement et on ne sélectionne RIEN. Une automation armée ne rattrape pas le passé.
  -- En sonde, un curseur jamais posé vaut 0 : l'aperçu compte ce que la fenêtre de 7 jours aurait donné.
  if a.trigger in ('preferences_updated', 'welcome_back', 'optin_promo') then
    if a.event_cursor is null and p_probe then
      a.event_cursor := 0;
    end if;
    if a.event_cursor is null then
      if not p_probe then
        update newsletter.automation
           set event_cursor = coalesce((select max(id) from newsletter.consent_event), 0), last_run_at = now()
         where id = a.id;
      end if;
      reason := 'cursor_initialized'; return next; return;
    end if;
    v_cursor := a.event_cursor;
  end if;

  if not p_probe then
    /*
     * Le curseur n'avance que jusqu'AVANT le plus ancien événement encore dans la fenêtre : un
     * événement de la fenêtre n'est jamais sauté, même si un autre, antidaté (import), porte un id
     * plus grand. L'anti-jointure sur `automation_send` rend la relecture de la fenêtre inoffensive.
     */
    update newsletter.automation
       set last_run_at = now(),
           event_cursor = case
             when v_cursor is null then event_cursor
             else greatest(v_cursor, coalesce(
               (select min(ce.id) - 1 from newsletter.consent_event ce
                 where ce.id > v_cursor and ce.occurred_at > now() - v_horizon),
               (select max(ce.id) from newsletter.consent_event ce),
               v_cursor))
           end
     where id = a.id;
  end if;

  drop table if exists _auto_cand;
  drop table if exists _auto_lot;
  drop table if exists _auto_pris;
  drop table if exists _auto_files;

  create temporary table _auto_cand (
    subscription_id uuid primary key,
    email           text not null,
    period_key      text not null,
    anchor          timestamptz not null,
    info            jsonb not null default '{}'::jsonb,
    action_url      text,
    token_raw       text,
    token_expiry    timestamptz
  ) on commit drop;

  -- -------------------------------------------------------------------------
  -- Les candidats, déclencheur par déclencheur. Une ligne au plus par souscription.
  -- -------------------------------------------------------------------------
  if a.trigger = 'confirmation_reminder' then
    -- Ancre = la DERNIÈRE demande d'inscription (une réinscription ouvre une période neuve).
    -- Lien : celui déjà envoyé s'il vit encore au moins 2 h (D2, +24 h), sinon un NOUVEAU (+72 h).
    insert into _auto_cand (subscription_id, email, period_key, anchor, info, action_url, token_expiry)
    select s.id, sub.email::text, r.id::text, r.occurred_at,
           jsonb_build_object('link_mode', case when k.reuse then 'reuse' else 'new_token' end),
           case when k.reuse then u.action_url end,
           case when k.reuse then t.expires_at end
      from newsletter.subscription s
      join newsletter.subscriber sub on sub.id = s.subscriber_id
      join lateral (
        select ce.id, ce.occurred_at from newsletter.consent_event ce
         where ce.subscription_id = s.id and ce.event_type = 'optin_request'
         order by ce.id desc limit 1) r on true
      left join lateral (
        select d.created_at, d.expires_at, d.confirmed_at from newsletter.doi_token d
         where d.subscription_id = s.id
         order by d.created_at desc limit 1) t on true
      left join lateral (
        select o.action_url, o.created_at from newsletter.email_outbox o
         where o.subscription_id = s.id and o.kind in ('confirmation', 'automation_tx')
           and o.action_url is not null and o.created_at >= r.occurred_at - interval '5 minutes'
         order by o.created_at desc limit 1) u on true
      cross join lateral (
        select coalesce(u.action_url is not null and t.confirmed_at is null
                        and t.expires_at > now() + interval '2 hours'
                        and t.created_at <= u.created_at + interval '1 minute', false) as reuse) k
     where s.asset_id = a.asset_id
       and s.status = 'pending'                                                 -- pending
       and not newsletter.is_suppressed(sub.email::text, s.asset_id)            -- not_suppressed
       and not sub.is_demo                                                      -- not_demo
       and exists (select 1 from newsletter.email_outbox o2
                    where o2.subscription_id = s.id and o2.kind = 'confirmation' and o2.status = 'sent'
                      and o2.created_at >= r.occurred_at - interval '5 minutes')  -- confirmation_sent
       and t.confirmed_at is null                                               -- not_confirmed
       and r.occurred_at > now() - interval '7 days'                            -- within_7_days
       and r.occurred_at + v_delay <= now();                                    -- delay_reached

  elsif a.trigger = 'preferences_updated' then
    -- Ancre = le DERNIER changement fait dans le centre de préférences. ⛔ Pas les `granted` de la
    -- confirmation (méthode `widget_doi`) : ce n'est pas un changement, c'est l'inscription.
    insert into _auto_cand (subscription_id, email, period_key, anchor, info)
    select s.id, sub.email::text, l.id::text, l.occurred_at,
           jsonb_build_object('updated_fields', coalesce((
             select jsonb_agg(jsonb_build_object('field', coalesce(e.purpose, 'tracking'),
                                                 'value', e.event_type = 'granted') order by e.id)
               from newsletter.consent_event e
              where e.subscription_id = s.id and e.method = 'preference_center'
                and e.event_type in ('granted', 'withdrawn')
                and e.id > greatest(v_cursor, coalesce((
                      select max(x.period_key::bigint) from newsletter.automation_send x
                       where x.automation_id = a.id and x.subscription_id = s.id and x.step = 1
                         and x.period_key ~ '^[0-9]{1,18}$'), 0))), '[]'::jsonb))
      from (select distinct ce.subscription_id from newsletter.consent_event ce
             where ce.id > v_cursor and ce.occurred_at > now() - v_horizon) recent
      join newsletter.subscription s on s.id = recent.subscription_id
      join newsletter.subscriber sub on sub.id = s.subscriber_id
      join lateral (
        select ce.id, ce.occurred_at from newsletter.consent_event ce
         where ce.subscription_id = s.id and ce.method = 'preference_center'
           and ce.event_type in ('granted', 'withdrawn')
         order by ce.id desc limit 1) l on true
     where s.asset_id = a.asset_id
       and l.id > v_cursor                                                      -- after_cursor
       and l.occurred_at > now() - v_horizon                                    -- within_horizon
       and l.occurred_at + v_delay <= now();                                    -- delay_reached

  elsif a.trigger = 'welcome_back' then
    -- Ancre = la DERNIÈRE confirmation ou réinscription (centre de préférences). D3 : après la
    -- NOUVELLE confirmation, jamais à un désinscrit encore désinscrit (sendable, plus bas).
    insert into _auto_cand (subscription_id, email, period_key, anchor)
    select s.id, sub.email::text, l.id::text, l.occurred_at
      from (select distinct ce.subscription_id from newsletter.consent_event ce
             where ce.id > v_cursor and ce.occurred_at > now() - v_horizon) recent
      join newsletter.subscription s on s.id = recent.subscription_id
      join newsletter.subscriber sub on sub.id = s.subscriber_id
      join lateral (
        select ce.id, ce.event_type, ce.occurred_at from newsletter.consent_event ce
         where ce.subscription_id = s.id
           and (ce.event_type = 'optin_confirm' or (ce.event_type = 'resubscribe' and ce.method = 'preference_center'))
         order by ce.id desc limit 1) l on true
     where s.asset_id = a.asset_id
       and (l.event_type = 'resubscribe' or exists (
             select 1 from newsletter.consent_event p
              where p.subscription_id = s.id and p.id < l.id
                and p.event_type in ('unsubscribe', 'deletion_request')))         -- returning
       and l.id > v_cursor                                                      -- after_cursor
       and l.occurred_at > now() - v_horizon                                    -- within_horizon
       and l.occurred_at + v_delay <= now();                                    -- delay_reached

  elsif a.trigger in ('reengagement', 'sunset') then
    -- D4 : référence = dernier clic SUIVI, dernière visite du centre de préférences, confirmation,
    -- inscription en plancher. ⛔ Pas l'ouverture. `greatest` ignore les NULL.
    insert into _auto_cand (subscription_id, email, period_key, anchor, info)
    select s.id, sub.email::text, to_char(r.ref at time zone 'UTC', 'YYYY-MM-DD'), r.ref,
           case when a.trigger = 'reengagement'
                then jsonb_build_object('days_inactive', floor(extract(epoch from (now() - r.ref)) / 86400)::integer)
                else '{}'::jsonb end
      from newsletter.subscription s
      join newsletter.subscriber sub on sub.id = s.subscriber_id
      cross join lateral (
        select greatest(s.last_click_at, s.last_response_at, s.consent_at, s.created_at) as ref) r
     where s.asset_id = a.asset_id
       and (coalesce(s.tracking_consent, false) or v_untracked)                 -- tracking_consented
       and r.ref + v_delay <= now()                                             -- delay_reached
       and (a.trigger = 'reengagement' or not v_require_re or exists (
             select 1 from newsletter.automation_send x
               join newsletter.automation ax on ax.id = x.automation_id
              where ax.trigger = 'reengagement' and ax.asset_id = a.asset_id
                and x.subscription_id = s.id
                and x.simulated = v_simulated
                and x.created_at > r.ref
                and x.created_at <= now() - make_interval(days => v_grace)));     -- reengaged_without_answer

  elsif a.trigger = 'anniversary' then
    -- Le dernier anniversaire atteint (celui de cette année, sinon celui de l'an dernier), en UTC.
    -- ⚠️ `date + interval 'n years'` ramène le 29 février au 28 : `anniversaryOf` fait de même.
    v_today := (now() at time zone 'UTC')::date;
    insert into _auto_cand (subscription_id, email, period_key, anchor)
    select s.id, sub.email::text, extract(year from an.d)::integer::text, an.d::timestamp at time zone 'UTC'
      from newsletter.subscription s
      join newsletter.subscriber sub on sub.id = s.subscriber_id
      cross join lateral (select (s.created_at at time zone 'UTC')::date as d0) b
      cross join lateral (
        select (b.d0 + make_interval(years => extract(year from v_today)::integer - extract(year from b.d0)::integer))::date as ce_an,
               (b.d0 + make_interval(years => extract(year from v_today)::integer - 1 - extract(year from b.d0)::integer))::date as l_an) y
      cross join lateral (select case when y.ce_an <= v_today then y.ce_an else y.l_an end as d) an
     where s.asset_id = a.asset_id
       and an.d > b.d0                                                          -- one_year_old
       and (an.d::timestamp at time zone 'UTC') + v_delay <= now()              -- delay_reached
       and now() < (an.d::timestamp at time zone 'UTC') + v_delay
                   + make_interval(days => v_catchup + 1);                      -- within_catchup

  elsif a.trigger = 'consent_renewal' then
    -- D5 : une fois par consentement (la période est la date du consentement : le renouveler en
    -- ouvre une neuve). ⛔ Transactionnel strict : aucun contenu promotionnel dans le modèle.
    insert into _auto_cand (subscription_id, email, period_key, anchor)
    select s.id, sub.email::text, to_char(s.consent_at at time zone 'UTC', 'YYYY-MM-DD'),
           s.consent_at + make_interval(months => v_months)
      from newsletter.subscription s
      join newsletter.subscriber sub on sub.id = s.subscriber_id
     where s.asset_id = a.asset_id
       and s.consent_at is not null
       and s.consent_at + make_interval(months => v_months) + v_delay <= now(); -- delay_reached

  elsif a.trigger = 'optin_promo' then
    -- D6 : après la CONFIRMATION, une fois par abonné et par opt-in (la période est l'opt-in).
    insert into _auto_cand (subscription_id, email, period_key, anchor)
    select s.id, sub.email::text, s.optin_id::text, l.occurred_at
      from (select distinct ce.subscription_id from newsletter.consent_event ce
             where ce.id > v_cursor and ce.occurred_at > now() - v_horizon
               and ce.event_type = 'optin_confirm') recent
      join newsletter.subscription s on s.id = recent.subscription_id
      join newsletter.subscriber sub on sub.id = s.subscriber_id
      join lateral (
        select ce.id, ce.occurred_at from newsletter.consent_event ce
         where ce.subscription_id = s.id and ce.event_type = 'optin_confirm'
         order by ce.id desc limit 1) l on true
     where s.asset_id = a.asset_id
       and s.optin_id is not null and s.optin_id = any(v_optins)                -- optin_matches
       and l.id > v_cursor                                                      -- after_cursor
       and l.occurred_at > now() - v_horizon                                    -- within_horizon
       and l.occurred_at + v_delay <= now();                                    -- delay_reached
  end if;

  -- -------------------------------------------------------------------------
  -- Les gardes communes.
  -- -------------------------------------------------------------------------

  -- active + not_suppressed + not_demo + not_sunset, d'un seul tenant : `sendable_subscription`.
  -- (La relance vise des `pending` : ses propres gardes sont dans sa branche.)
  if a.trigger <> 'confirmation_reminder' then
    delete from _auto_cand c
     where not exists (select 1 from newsletter.sendable_subscription ss where ss.id = c.subscription_id);
  end if;

  -- ⛔ NE PAS RETIRER : sans elle, un abonné de démonstration pourrait recevoir un vrai e-mail le jour
  -- où une branche ci-dessus serait réécrite sans passer par la vue.
  delete from _auto_cand c
   using newsletter.subscription s, newsletter.subscriber sub
   where s.id = c.subscription_id and sub.id = s.subscriber_id and sub.is_demo;

  -- filters_match. ⚠️ Chaque terme est non NULL : `not (NULL)` ne supprimerait rien, et un filtre
  -- évalué à NULL laisserait passer toute la marque.
  delete from _auto_cand c
   using newsletter.subscription s
   where s.id = c.subscription_id
     and not (
           (cardinality(v_optins) = 0 or (s.optin_id is not null and s.optin_id = any(v_optins)))
       and (cardinality(v_langs) = 0 or lower(coalesce(s.language, '')) = any(v_langs))
       and (cardinality(v_interests) = 0 or coalesce(s.interest_ids, '{}'::integer[]) && v_interests));

  -- purpose_granted — la règle de `purposeAllowed` (@nf/config), régime de la même édition que la
  -- porte (`outbox_context`) : sélectionner quelqu'un que la porte refusera brûlerait son créneau.
  if v_marketing then
    delete from _auto_cand c
     using newsletter.subscription s
     where s.id = c.subscription_id
       and not coalesce(
             case
               when a.purpose = 'partners' then (s.granted_purposes->>'partners') = 'true'
               when (select ed.compliance_regime from newsletter.asset_edition ed
                      where ed.asset_id = s.asset_id
                      order by (ed.id = s.edition_id) desc nulls last, ed.id
                      limit 1) = 'canspam'
                 then coalesce(s.granted_purposes->>a.purpose, '') <> 'false'
               else (s.granted_purposes->>a.purpose) = 'true'
             end, false);
  end if;

  -- not_already_sent — l'anti-jointure qui rend la passe rejouable (simulée ou réelle : le créneau
  -- est pris dans les deux cas).
  delete from _auto_cand c
   where exists (select 1 from newsletter.automation_send x
                  where x.automation_id = a.id and x.subscription_id = c.subscription_id
                    and x.step = p_step and x.period_key = c.period_key);

  -- previous_step_done — l'étape N attend l'étape N-1 de la même période, DANS LE MÊME MODE, et
  -- l'écart des délais (12 h au moins) : deux étapes ne partent jamais dans le même souffle.
  if p_step > 1 then
    delete from _auto_cand c
     where not exists (select 1 from newsletter.automation_send x
                        where x.automation_id = a.id and x.subscription_id = c.subscription_id
                          and x.step = p_step - 1 and x.period_key = c.period_key
                          and x.simulated = v_simulated
                          and x.created_at <= now() - v_gap);
  end if;

  -- L'allowlist du worker : hors liste, on ne prend PAS le créneau (il partira quand la liste s'ouvrira).
  if p_allowlist is not null and cardinality(p_allowlist) > 0 and not ('*' = any(p_allowlist)) then
    delete from _auto_cand c
     where not (lower(c.email) = any(p_allowlist) or split_part(lower(c.email), '@', 2) = any(p_allowlist));
  end if;

  eligible := (select count(*)::integer from _auto_cand);

  -- ⚠️ LE PLAFOND SE COMPTE SUR LA TRACE, dans le MÊME mode : une matinée de simulation ne consomme
  -- pas le plafond réel de l'après-midi, et une purge de la file ne le remonte pas.
  -- ⚠️ Colonnes QUALIFIÉES : `simulated` est aussi une colonne de sortie de la fonction, et plpgsql
  -- refuse une référence ambiguë (`variable_conflict = error`) — à l'exécution, pas à la création.
  select count(*)::integer into v_used
    from newsletter.automation_send u
   where u.automation_id = a.id and u.simulated = v_simulated and u.created_at >= v_day_start;
  v_allowed := least(greatest(coalesce(p_batch, 0), 0), 500, greatest(0, a.daily_cap - v_used));
  allowed := v_allowed;
  daily_used := v_used;

  -- ⛔ L'ÉCHANTILLON DE L'APERÇU EST LE SEUL ENDROIT OÙ DES ADRESSES SORTENT DE CETTE FONCTION, ET
  -- ELLES SORTENT MASQUÉES D'ICI : trois caractères de la partie locale, puis le domaine. L'admin
  -- n'a donc jamais une adresse entière à cacher. Sonde seulement ; même ordre que le lot plus bas
  -- (ce que le plafond laisserait partir en premier).
  if p_probe then
    sample := array(
      select left(split_part(c.email, '@', 1), 3) || '…@' || split_part(c.email, '@', 2)
        from _auto_cand c
       order by case when a.trigger = 'reengagement' then -extract(epoch from c.anchor)
                     else extract(epoch from c.anchor) end,
                c.subscription_id
       limit 5);
  end if;

  if p_probe then reason := 'probe'; return next; return; end if;
  if eligible = 0 then reason := 'nobody'; return next; return; end if;
  if v_allowed <= 0 then reason := 'daily_cap_reached'; return next; return; end if;

  -- Quand le plafond coupe : l'ancre la plus ancienne d'abord (une relance proche de ses 7 jours passe
  -- avant une fraîche) ; pour le réengagement, les dormants les PLUS RÉCENTS d'abord (0058).
  create temporary table _auto_lot on commit drop as
  select c.* from _auto_cand c
   order by case when a.trigger = 'reengagement' then -extract(epoch from c.anchor)
                 else extract(epoch from c.anchor) end,
            c.subscription_id
   limit v_allowed;

  -- 1) LA TRACE D'ABORD. `on conflict do nothing` + `returning` : seul ce qui entre vraiment continue.
  create temporary table _auto_pris on commit drop as
  with ins as (
    insert into newsletter.automation_send (automation_id, asset_id, subscription_id, step, period_key, simulated, reason)
    select a.id, a.asset_id, l.subscription_id, p_step, l.period_key, v_simulated,
           case when v_simulated then 'simulated' || coalesce(':' || (l.info->>'link_mode'), '')
                when a.trigger = 'sunset' then 'sunset_marked'
                else 'enqueued' end
      from _auto_lot l
    on conflict do nothing
    returning subscription_id
  )
  select subscription_id from ins;

  written := (select count(*)::integer from _auto_pris);

  -- ⛔ EN SIMULATION, ON S'ARRÊTE ICI : la trace dit qui AURAIT reçu quoi ; rien d'autre n'est écrit
  -- (ni file, ni jeton, ni `sunset_at`).
  if v_simulated then reason := 'simulated'; return next; return; end if;

  -- 2a) Le sunset n'envoie rien : il marque. Réversible (`reactivate_sunset`, 0058).
  if a.trigger = 'sunset' then
    update newsletter.subscription s
       set sunset_at = now()
      from _auto_pris p
     where s.id = p.subscription_id and s.sunset_at is null;
    reason := 'written'; return next; return;
  end if;

  -- 2b) La relance qui n'a plus de lien vivant reçoit un NOUVEAU jeton (48 h), au format exact de
  --     `newDoiToken` (@nf/tokens) : 32 octets en base64url, stocké en sha256 hexadécimal.
  if a.trigger = 'confirmation_reminder' then
    update _auto_lot l
       set token_raw = rtrim(translate(encode(gen_random_bytes(32), 'base64'), '+/', '-_'), '='),
           token_expiry = now() + interval '48 hours'
     where l.action_url is null
       and l.subscription_id in (select p.subscription_id from _auto_pris p);

    insert into newsletter.doi_token (subscription_id, token_hash, expires_at)
    select l.subscription_id, encode(digest(l.token_raw, 'sha256'), 'hex'), l.token_expiry
      from _auto_lot l
     where l.token_raw is not null;

    -- Même forme que `signup/route.ts` : `/confirm?token=…&lang=<langue de l'édition>`.
    update _auto_lot l
       set action_url = rtrim(btrim(p_confirm_base_url), '/') || '/confirm?token=' || l.token_raw
                        || coalesce('&lang=' || (
                             select ed.language from newsletter.asset_edition ed
                               join newsletter.subscription s on s.id = l.subscription_id
                              where ed.asset_id = s.asset_id
                              order by (ed.id = s.edition_id) desc nulls last, ed.id
                              limit 1), '')
     where l.token_raw is not null;
  end if;

  -- 2c) LA FILE, seulement pour ce que la trace a laissé passer.
  create temporary table _auto_files on commit drop as
  with ins as (
    insert into newsletter.email_outbox
      (asset_id, subscription_id, to_email, subject, kind, purpose, payload, action_url, template_version_id)
    select a.asset_id, l.subscription_id, l.email, v_subject, v_kind,
           case when v_marketing then a.purpose end,
           jsonb_strip_nulls(l.info || jsonb_build_object(
             'automation_id', a.id,
             'automation_trigger', a.trigger,
             'automation_step', p_step,
             'period_key', l.period_key,
             'first_name', nullif(btrim(sub.first_name), ''),
             'signup_date', to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD'),
             'optin_id', s.optin_id,
             'optin_source', op.name,
             'token_expiry', l.token_expiry)),
           case when a.trigger = 'confirmation_reminder' then l.action_url end,
           v_tv_id
      from _auto_lot l
      join _auto_pris p on p.subscription_id = l.subscription_id
      join newsletter.subscription s on s.id = l.subscription_id
      join newsletter.subscriber sub on sub.id = s.subscriber_id
      left join newsletter.optin op on op.id = s.optin_id
    returning id, subscription_id
  )
  select id, subscription_id from ins;

  -- 3) Relier la trace à sa ligne : « qu'est devenu cet envoi ? ».
  update newsletter.automation_send t
     set outbox_id = f.id
    from _auto_files f
    join _auto_lot l on l.subscription_id = f.subscription_id
   where t.automation_id = a.id
     and t.subscription_id = f.subscription_id
     and t.step = p_step
     and t.period_key = l.period_key;

  reason := 'written';
  return next;
end;
$$;

comment on function newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean) is
  'Execute UNE etape d''UNE automation (0082). Selection atomique + trace automation_send AVANT email_outbox. '
  'simulation = automation_send(simulated) seulement ; live + p_live_allowed = file reelle ; draft/paused = rien ; '
  'p_probe = compte sans rien ecrire. Verrou de transaction par automation (busy). Regles = packages/automations/src/catalog.ts.';

-- ⛔ LE DÉFAUT POSTGRES EST « TOUT LE MONDE PEUT EXÉCUTER » (voir 0071). Le revoke précède le grant.
revoke all on function newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean) from public, anon, authenticated;
grant execute on function newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE — DANS la migration (voir 0072). Relire le CATALOGUE et ÉCHOUER si un objet manque,
-- si une garde n'est pas posée, si un kind d'automation a été rendu interactif, ou si la fonction est
-- exécutable par PUBLIC.
-- ⛔ `drop constraint if exists` rend « success » même s'il n'a rien retiré : on relit les définitions.
-- ---------------------------------------------------------------------------
do $$
declare
  manquants text;
  v_def     text;
  ouvertes  text;
  dernieres text;
begin
  -- Les deux tables, et la RLS sur chacune.
  select string_agg(attendu, ', ')
    into manquants
    from (values ('automation'), ('automation_send')) as v(attendu)
   where not exists (
     select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'newsletter' and c.relname = v.attendu and c.relkind = 'r' and c.relrowsecurity
   );
  if manquants is not null then
    raise exception '[0082] tables absentes ou sans RLS apres execution : %', manquants;
  end if;

  -- L'unicité qui est la raison d'être de la trace.
  select pg_get_indexdef(i.indexrelid)
    into v_def
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
   where i.indrelid = 'newsletter.automation_send'::regclass
     and ic.relname = 'uq_automation_send_slot'
     and i.indisunique;
  if v_def is null or v_def not like '%(automation_id, subscription_id, step, period_key)%' then
    raise exception '[0082] uq_automation_send_slot absent, non unique ou mal forme : %', coalesce(v_def, '(null)');
  end if;

  -- La liste fermée des déclencheurs.
  select string_agg(attendu, ', ')
    into manquants
    from (values ('confirmation_reminder'), ('preferences_updated'), ('welcome_back'), ('reengagement'),
                 ('sunset'), ('anniversary'), ('consent_renewal'), ('soft_bounce_rule'), ('optin_promo')) as v(attendu)
   where not exists (
     select 1 from pg_constraint
      where conrelid = 'newsletter.automation'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%trigger%'
        and pg_get_constraintdef(oid) like '%''' || v.attendu || '''%'
   );
  if manquants is not null then
    raise exception '[0082] declencheurs absents de la contrainte de automation.trigger : %', manquants;
  end if;

  -- Les huit kinds, anciens compris.
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'newsletter.email_outbox'::regclass and conname = 'email_outbox_kind_check';
  select string_agg(attendu, ', ')
    into manquants
    from (values ('confirmation'), ('welcome'), ('unsubscribe_ack'), ('campaign'), ('test'), ('reengagement'),
                 ('automation'), ('automation_tx')) as v(attendu)
   where coalesce(v_def, '') not like '%''' || v.attendu || '''%';
  if manquants is not null then
    raise exception '[0082] email_outbox_kind_check ne porte pas : %', manquants;
  end if;

  -- La finalité obligatoire pour `automation`.
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'newsletter.email_outbox'::regclass and conname = 'email_outbox_campaign_purpose_required';
  if coalesce(v_def, '') not like '%''automation''%' or coalesce(v_def, '') not like '%''reengagement''%' then
    raise exception '[0082] la finalite n''est pas exigee pour automation : %', coalesce(v_def, '(absente)');
  end if;

  -- L'exception transactionnelle, bornée à ses deux déclencheurs.
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'newsletter.email_outbox'::regclass and conname = 'email_outbox_automation_tx_trigger';
  if coalesce(v_def, '') not like '%''confirmation_reminder''%' or coalesce(v_def, '') not like '%''consent_renewal''%'
     or coalesce(v_def, '') not like '%action_url IS NOT NULL%' then
    raise exception '[0082] email_outbox_automation_tx_trigger absente ou incomplete : %', coalesce(v_def, '(absente)');
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'newsletter.email_outbox'::regclass and conname = 'email_outbox_automation_origin') then
    raise exception '[0082] email_outbox_automation_origin absente';
  end if;

  -- ⛔ Une automation n'est pas un geste humain qui attend : elle doit rester sous le plafond de masse.
  if pg_get_functiondef('newsletter.claim_outbox_interactive(text, integer, integer)'::regprocedure) like '%automation%' then
    raise exception '[0082] claim_outbox_interactive nomme un kind d''automation : il passerait devant le plafond des newsletters';
  end if;

  -- La vue : le pied légal du modèle pour les automations, et les colonnes de fin inchangées.
  if pg_get_viewdef('newsletter.outbox_context'::regclass) not like '%''automation_tx''::text%' then
    raise exception '[0082] outbox_context ne sert pas le pied legal du modele aux automations';
  end if;
  select string_agg(column_name::text, ',' order by ordinal_position)
    into dernieres
    from (
      select column_name, ordinal_position from information_schema.columns
       where table_schema = 'newsletter' and table_name = 'outbox_context'
       order by ordinal_position desc
       limit 3
    ) t;
  if dernieres is distinct from 'hard_suppressed,from_name,reply_to' then
    raise exception '[0082] outbox_context : dernieres colonnes attendues hard_suppressed,from_name,reply_to, lues : %', dernieres;
  end if;

  -- La fonction : présente, SECURITY DEFINER, search_path figé, fermée à PUBLIC / anon / authenticated.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'newsletter' and p.proname = 'automation_due' and p.prosecdef
       and exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%')
  ) then
    raise exception '[0082] automation_due absente, non SECURITY DEFINER ou sans search_path fige';
  end if;
  select string_agg(distinct coalesce(r.rolname, 'PUBLIC'), ', ')
    into ouvertes
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    left join pg_roles r on r.oid = x.grantee
   where n.nspname = 'newsletter'
     and p.proname = 'automation_due'
     and x.privilege_type = 'EXECUTE'
     and (x.grantee = 0 or r.rolname in ('anon', 'authenticated'));
  if ouvertes is not null then
    raise exception '[0082] EXECUTE encore accorde sur automation_due a : %', ouvertes;
  end if;

  -- L'aperçu de l'admin : la sonde rend un échantillon, et il est MASQUÉ dans la base.
  if pg_get_function_result('newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean)'::regprocedure)
       not like '%sample text[]%'
     or pg_get_functiondef('newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean)'::regprocedure)
       not like '%left(split_part(c.email, ''@'', 1), 3) || ''…@''%' then
    raise exception '[0082] automation_due ne rend pas l''echantillon masque de la sonde';
  end if;

  -- La date du dernier changement de statut, sans laquelle « la simulation a tourné » ne se prouve pas.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'newsletter' and table_name = 'automation'
                    and column_name = 'status_changed_at' and is_nullable = 'NO') then
    raise exception '[0082] automation.status_changed_at absente ou nullable';
  end if;

  raise notice '[0082] contre-epreuve OK : 2 tables sous RLS, unicite du creneau, 9 declencheurs, 8 kinds, 3 gardes d''outbox, masse non interactive, vue a jour, fonction fermee, echantillon masque, date de statut';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0082', '0082_automations.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
