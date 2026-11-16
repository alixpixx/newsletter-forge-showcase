-- ============================================================================
-- 0095 — Le label d'automation : une créative optinforge nomme sa série, et une
--        automation cible les inscrits qui portent ce label
--
-- Demande d'Alix, 09/10/2026 : « créer dans la section Where une partie
-- "Automations Label" […] l'envoyer dans newsletter-forge qu'on puisse l'utiliser
-- en tant que Targeting », pour la série Libertadores de Northwind Sports (3 e-mails sur
-- 3 jours, aux inscrits de l'opt-in dédié SEULEMENT).
--
-- POURQUOI PAS LE FILTRE `optin_ids` QUI EXISTE DÉJÀ. Il compare
-- `subscription.optin_id`, qui ne garde que le PREMIER formulaire de la personne,
-- et un `newsletter.optin` n'existe qu'après la première inscription : on ne peut
-- pas préparer l'automation avant que la créative ait servi. Le label, lui, est
-- enregistré dès qu'on le tape dans optinforge.
--
-- CE QUI EST AJOUTÉ (rien n'est retiré) :
--   1. `newsletter.automation_label` : le registre des labels par marque (slug +
--      nom affiché), alimenté par `POST /api/v1/automation-labels`.
--   2. `capture_event.automation_label` : le slug porté par CETTE inscription
--      (`capture.creative.automation_label` du pont). GELÉ comme le reste de
--      l'événement ; NULL = la créative n'en portait pas.
--   3. `automation_due` RECRÉÉE DEPUIS 0090 par 6 remplacements, prouvés plus bas :
--        - filtre `labels` (liste de slugs), lu comme les autres filtres et appliqué
--          par `filters_match` à TOUS les déclencheurs : la souscription a au moins
--          une capture portant l'un des labels ;
--        - `optin_promo` exige un opt-in OU un label (avant : un opt-in) ;
--        - sa clé de période devient `coalesce(optin_id, '')` : identique pour toute
--          automation existante (elle exigeait un `optin_id` non nul), et jamais
--          NULL quand seul un label filtre.
--      Même règle dans `packages/automations/src/catalog.ts` (filtersMatch, garde
--      optin_matches) et `validate.ts` (clé `labels`).
--
-- ⛔ LE SLUG SE CALCULE À UN SEUL ENDROIT : `apps/public/src/lib/automation-label.ts`.
--    La base ne fait que vérifier sa forme.
-- ⛔ 0090 N'EST PAS RÉÉCRIT. ⛔ Aucune écriture hors du catalogue : la contre-épreuve
--    3 fabrique ses données dans un bloc ANNULÉ.
-- RETOUR ARRIÈRE : rejouer la fonction de 0090 (son corps est dans le fichier), puis
-- `drop table newsletter.automation_label` et `alter table newsletter.capture_event
-- drop column automation_label` — aucune automation existante ne lit ces objets.
-- ============================================================================

-- La définition d'avant, pour prouver que seuls les 6 remplacements changent.
create temporary table _avant_0095 on commit drop as
select p.prosrc, md5(p.prosrc) as empreinte, p.proconfig, p.prosecdef, p.proowner
  from pg_proc p
 where p.oid = 'newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean)'::regprocedure;

-- ---------------------------------------------------------------------------
-- 1. Le registre
-- ---------------------------------------------------------------------------
create table if not exists newsletter.automation_label (
  id          uuid primary key default gen_random_uuid(),
  asset_id    uuid not null references newsletter.asset(id) on delete cascade,
  -- Même forme que `optin.slug` (0051) : il voyage dans un filtre jsonb et dans une URL.
  slug        text not null,
  name        text not null,
  source      text not null default 'optinforge',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint automation_label_asset_slug_uk unique (asset_id, slug),
  constraint automation_label_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  constraint automation_label_name_len check (char_length(btrim(name)) between 1 and 80),
  constraint automation_label_source_len check (char_length(source) between 1 and 40)
);

comment on table newsletter.automation_label is
  'Labels d''automation par marque (0095) : nommes dans optinforge (onglet Where d''une creative), '
  'cibles par le filtre `labels` d''une automation. Ecrit par POST /api/v1/automation-labels.';
comment on column newsletter.automation_label.slug is
  'Cle stable, calculee par apps/public/src/lib/automation-label.ts depuis le nom. Le nom peut changer, pas elle.';

-- RLS sans policy, comme `automation` (0082) : personne ne lit sauf `service_role`.
alter table newsletter.automation_label enable row level security;
revoke all on newsletter.automation_label from public;
revoke all on newsletter.automation_label from anon, authenticated;
grant select, insert, update, delete on newsletter.automation_label to service_role;

-- ---------------------------------------------------------------------------
-- 2. Le label porté par une inscription
-- ---------------------------------------------------------------------------
alter table newsletter.capture_event
  add column if not exists automation_label text;
alter table newsletter.capture_event
  drop constraint if exists capture_event_automation_label_format;
alter table newsletter.capture_event
  add constraint capture_event_automation_label_format
  check (automation_label is null or automation_label ~ '^[a-z0-9][a-z0-9-]{0,63}$');

comment on column newsletter.capture_event.automation_label is
  'Slug du label d''automation de la creative au moment de CETTE inscription (0095). NULL = aucun. Gele.';

create index if not exists idx_capture_event_automation_label
  on newsletter.capture_event (asset_id, automation_label)
  where automation_label is not null;

-- ---------------------------------------------------------------------------
-- 3. automation_due : 0090 + le filtre `labels`
-- ---------------------------------------------------------------------------
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
  v_labels      text[];
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
    v_labels    := array(select lower(btrim(x)) from jsonb_array_elements_text(coalesce(a.filters->'labels', '[]'::jsonb)) x);
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
  if a.trigger = 'optin_promo' and cardinality(v_optins) = 0 and cardinality(v_labels) = 0 then
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
                and (p.event_type in ('unsubscribe', 'deletion_request')
                     or (p.event_type = 'withdrawn' and p.purpose = 'content'))))  -- returning
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
    select s.id, sub.email::text, coalesce(s.optin_id::text, ''), l.occurred_at
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
       and (cardinality(v_optins) = 0
            or (s.optin_id is not null and s.optin_id = any(v_optins)))         -- optin_matches
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
       and (cardinality(v_interests) = 0 or coalesce(s.interest_ids, '{}'::integer[]) && v_interests)
       and (cardinality(v_labels) = 0 or exists (select 1 from newsletter.capture_event ce
                                                  where ce.subscription_id = s.id
                                                    and ce.automation_label = any(v_labels))));

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
  'p_probe = compte sans rien ecrire. Verrou de transaction par automation (busy). Regles = packages/automations/src/catalog.ts. '
  'Retour (welcome_back) = regle de subscription_note_return (0087), depuis 0090. Filtre labels + optin_promo par label, depuis 0095.';

-- ⛔ LE DÉFAUT POSTGRES EST « TOUT LE MONDE PEUT EXÉCUTER » (voir 0071). Le revoke précède le grant.
revoke all on function newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean) from public, anon, authenticated;
grant execute on function newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean) to service_role;

-- Contre-épreuves
do $$
declare
  av         record;
  v_apres    text;
  v_attendu  text;
  n          int;
  i          int;
  ouvertes   text;
  -- ⛔ LES PAIRES (avant, après) DES 6 REMPLACEMENTS. `migration-sync.test.ts` les relit ICI.
  v_avant    constant text[] := array[
    $a1$  v_interests   integer[];$a1$,
    $a2$    v_interests := array(select x::integer from jsonb_array_elements_text(coalesce(a.filters->'interest_ids', '[]'::jsonb)) x);$a2$,
    $a3$  if a.trigger = 'optin_promo' and cardinality(v_optins) = 0 then$a3$,
    $a4$    select s.id, sub.email::text, s.optin_id::text, l.occurred_at$a4$,
    $a5$       and s.optin_id is not null and s.optin_id = any(v_optins)                -- optin_matches$a5$,
    $a6$       and (cardinality(v_interests) = 0 or coalesce(s.interest_ids, '{}'::integer[]) && v_interests));$a6$
  ];
  v_nouveau  constant text[] := array[
    $b1$  v_interests   integer[];
  v_labels      text[];$b1$,
    $b2$    v_interests := array(select x::integer from jsonb_array_elements_text(coalesce(a.filters->'interest_ids', '[]'::jsonb)) x);
    v_labels    := array(select lower(btrim(x)) from jsonb_array_elements_text(coalesce(a.filters->'labels', '[]'::jsonb)) x);$b2$,
    $b3$  if a.trigger = 'optin_promo' and cardinality(v_optins) = 0 and cardinality(v_labels) = 0 then$b3$,
    $b4$    select s.id, sub.email::text, coalesce(s.optin_id::text, ''), l.occurred_at$b4$,
    $b5$       and (cardinality(v_optins) = 0
            or (s.optin_id is not null and s.optin_id = any(v_optins)))         -- optin_matches$b5$,
    $b6$       and (cardinality(v_interests) = 0 or coalesce(s.interest_ids, '{}'::integer[]) && v_interests)
       and (cardinality(v_labels) = 0 or exists (select 1 from newsletter.capture_event ce
                                                  where ce.subscription_id = s.id
                                                    and ce.automation_label = any(v_labels))));$b6$
  ];
begin
  -- 1. La fonction d'avant est bien celle de 0090, et seuls les 6 remplacements ont changé.
  select * into av from _avant_0095;
  if av.empreinte is distinct from 'e18ac7572c942a227ecf603ac9507eb4' then
    raise exception '[0095] automation_due avait derive depuis 0090 (empreinte %) : rien n est remplace', av.empreinte;
  end if;
  v_attendu := av.prosrc;
  for i in 1 .. array_length(v_avant, 1) loop
    n := (length(v_attendu) - length(replace(v_attendu, v_avant[i], ''))) / length(v_avant[i]);
    if n <> 1 then raise exception '[0095] remplacement % : % occurrence(s), 1 attendue', i, n; end if;
    v_attendu := replace(v_attendu, v_avant[i], v_nouveau[i]);
  end loop;
  select p.prosrc into v_apres from pg_proc p where p.oid = 'newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean)'::regprocedure;
  if v_apres is distinct from v_attendu then
    raise exception '[0095] automation_due differe de 0090 au-dela des 6 remplacements';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean)'::regprocedure
                  and p.prosecdef = av.prosecdef and p.proconfig = av.proconfig and p.proowner = av.proowner) then
    raise exception '[0095] SECURITY DEFINER, reglages ou proprietaire changes';
  end if;
  raise notice '[0095] contre-epreuve 1 OK : 0090 recopie, 6 remplacements (empreinte % -> %)', av.empreinte, md5(v_apres);

  -- 2. Personne d'autre que service_role (et le propriétaire) ne peut l'exécuter ni lire le registre.
  select string_agg(distinct coalesce(r.rolname, 'PUBLIC'), ', ')
    into ouvertes
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    left join pg_roles r on r.oid = x.grantee
   where p.oid = 'newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean)'::regprocedure
     and x.privilege_type = 'EXECUTE'
     and (x.grantee = 0 or r.rolname in ('anon', 'authenticated'));
  if ouvertes is not null then
    raise exception '[0095] EXECUTE accorde sur automation_due a : %', ouvertes;
  end if;
  if not has_function_privilege('service_role', 'newsletter.automation_due(uuid, integer, integer, text[], boolean, text, boolean)', 'execute') then
    raise exception '[0095] service_role ne peut plus executer automation_due';
  end if;
  if has_table_privilege('anon', 'newsletter.automation_label', 'select')
     or has_table_privilege('authenticated', 'newsletter.automation_label', 'select') then
    raise exception '[0095] le registre des labels est lisible par anon ou authenticated';
  end if;
  if not (has_table_privilege('service_role', 'newsletter.automation_label', 'select')
          and has_table_privilege('service_role', 'newsletter.automation_label', 'insert')
          and has_table_privilege('service_role', 'newsletter.automation_label', 'update')) then
    raise exception '[0095] service_role ne peut pas ecrire le registre des labels';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'newsletter.automation_label'::regclass) then
    raise exception '[0095] RLS non activee sur automation_label';
  end if;
  raise notice '[0095] contre-epreuve 2 OK : execution et registre reserves a service_role, RLS active';
end
$$;

-- 3. Le comportement, sur des données fabriquées dans un bloc ANNULÉ : la sonde (`p_probe`, n'écrit
--    rien) compte, scénario par scénario, qui « Opt-in promotion » retiendrait. Chaque scénario a sa
--    langue, et le filtre `languages` l'isole des autres.
--      a  confirmation + capture label L, filtre labels [L]                 → 1/probe
--      b  confirmation + capture label M, filtre labels [L]                 → 0/probe
--      c  confirmation sans capture, filtre labels [L]                      → 0/probe
--      d  confirmation, opt-in X, filtre optin_ids [X] (non-régression)     → 1/probe
--      e  confirmation + capture label L, ni opt-in ni label                → 0/missing_optin_filter
--      f  confirmation + capture L + opt-in X, filtres [X] ET [L]           → 1/probe
--      g  confirmation + capture M + opt-in X, filtres [X] ET [L]           → 0/probe
--      h  confirmation + capture L, sans opt-in, filtre labels [L] (période '') → 1/probe
--    et les formes refusées : slug hors format dans capture_event et dans le registre.
do $$
declare
  v_asset uuid;
  v_auto  uuid;
  v_optin uuid;
  v_sub   uuid;
  v_s     uuid;
  v_r     text;
  v_n     int;
  v_res   jsonb := '{}'::jsonb;
  v_refus int := 0;
  sc      record;
begin
  begin
    select id into v_asset from newsletter.asset where slug = 'pixel-daily';
    if v_asset is null then raise exception '[0095] marque pixel-daily absente'; end if;
    insert into newsletter.optin (asset_id, slug, name)
    values (v_asset, 'ce-0095-optin', 'contre-epreuve 0095') returning id into v_optin;
    insert into newsletter.automation (asset_id, name, trigger, purpose, status, steps)
    values (v_asset, 'contre-epreuve 0095', 'optin_promo', 'content', 'draft', '[{"delay_hours": 0}]')
    returning id into v_auto;
    for sc in select * from (values
        ('a', 'ce-0095-l', false, '{"labels": ["ce-0095-l"]}'),
        ('b', 'ce-0095-m', false, '{"labels": ["ce-0095-l"]}'),
        ('c', null,        false, '{"labels": ["ce-0095-l"]}'),
        ('d', null,        true,  '{"optin_ids": ["__X__"]}'),
        ('e', 'ce-0095-l', false, '{}'),
        ('f', 'ce-0095-l', true,  '{"optin_ids": ["__X__"], "labels": ["ce-0095-l"]}'),
        ('g', 'ce-0095-m', true,  '{"optin_ids": ["__X__"], "labels": ["ce-0095-l"]}'),
        ('h', 'ce-0095-l', false, '{"labels": [" CE-0095-L "]}')) as t(code, label, avec_optin, filtres)
    loop
      insert into newsletter.subscriber (email)
      values ('ce0095-' || sc.code || '@contre-epreuve-0095.invalid') returning id into v_sub;
      insert into newsletter.subscription (subscriber_id, asset_id, status, language, granted_purposes, optin_id)
      values (v_sub, v_asset, 'active', 'x-0095-' || sc.code, '{"content": true}',
              case when sc.avec_optin then v_optin end) returning id into v_s;
      if sc.label is not null then
        insert into newsletter.capture_event (subscription_id, asset_id, automation_label)
        values (v_s, v_asset, sc.label);
      end if;
      insert into newsletter.consent_event (subscription_id, event_type, method)
      values (v_s, 'optin_confirm', 'widget_doi');
      update newsletter.automation
         set filters = replace(sc.filtres, '__X__', v_optin::text)::jsonb
                       || jsonb_build_object('languages', jsonb_build_array('x-0095-' || sc.code))
       where id = v_auto;
      select d.eligible::text || '/' || d.reason into v_r from newsletter.automation_due(v_auto, 1, p_probe => true) d;
      v_res := v_res || jsonb_build_object(sc.code, v_r);
    end loop;

    -- Les formes refusées.
    begin
      insert into newsletter.capture_event (subscription_id, asset_id, automation_label) values (v_s, v_asset, 'Libertadores 2026');
    exception when check_violation then v_refus := v_refus + 1;
    end;
    begin
      insert into newsletter.automation_label (asset_id, slug, name) values (v_asset, '-x', 'contre-epreuve');
    exception when check_violation then v_refus := v_refus + 1;
    end;
    begin
      insert into newsletter.automation_label (asset_id, slug, name) values (v_asset, 'ce-0095-l', '   ');
    exception when check_violation then v_refus := v_refus + 1;
    end;
    raise exception 'annuler';
  exception when raise_exception then
    if sqlerrm <> 'annuler' then raise; end if;
  end;
  if v_res is distinct from '{"a": "1/probe", "b": "0/probe", "c": "0/probe", "d": "1/probe",
                               "e": "0/missing_optin_filter", "f": "1/probe", "g": "0/probe",
                               "h": "1/probe"}'::jsonb then
    raise exception '[0095] sonde optin_promo inattendue : %', v_res;
  end if;
  if v_refus <> 3 then raise exception '[0095] % forme(s) refusee(s) sur 3 attendues', v_refus; end if;
  -- Rien n'est resté du bloc annulé.
  select count(*) into v_n from newsletter.subscriber where email::text like '%@contre-epreuve-0095.invalid';
  if v_n <> 0 then raise exception '[0095] % abonne(s) de contre-epreuve restes en base', v_n; end if;
  select count(*) into v_n from newsletter.automation where name = 'contre-epreuve 0095';
  if v_n <> 0 then raise exception '[0095] automation de contre-epreuve restee en base'; end if;
  select count(*) into v_n from newsletter.optin where slug = 'ce-0095-optin';
  if v_n <> 0 then raise exception '[0095] opt-in de contre-epreuve reste en base'; end if;
  raise notice '[0095] contre-epreuve 3 OK : sonde %, 3 formes refusees, rien n est reste du bloc annule', v_res;
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0095', '0095_label_d_automation.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
