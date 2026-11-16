-- ============================================================================
-- 0094 — Analytics du comportement : engagement d'une campagne, résultats des automations,
--        audience (moments, sources, semaines), activité d'un abonné
-- ============================================================================
--
-- ⭐ DEMANDE D'ALIX (07/10/2026) : « le maximum d'info sur tous mes envois », profondeurs choisies :
-- liens cliqués, appareils et pays, fiche abonné, moments et sources ; et « Add automation results in
-- analytics ». Le détail par événement arrive avec 0092 (lien, appareil, client, système, robot,
-- pays/région/ville) ; cette migration le LIT, elle n'écrit rien.
--
-- Quatre fonctions, toutes `stable security definer`, fermées hors service_role, et toutes FILTRÉES
-- PAR MARQUE à chaque table lue (`asset_id = p_asset_id`) : une campagne, une automation ou un abonné
-- d'une autre marque rend du VIDE, jamais ses chiffres (contre-épreuve 2).
--
--   campaign_engagement   ouvertures/clics uniques et totaux, ouvertures de robots à part, liens
--                         cliqués, délai jusqu'à la 1re ouverture / au 1er clic (par heure, 72 = « 72 h
--                         et plus »), appareils, clients, systèmes, pays, villes.
--   automation_send_stats par automation et par étape : réels / simulés, sort dans l'outbox
--                         (sent/failed/skipped/en file), délivrés, rebonds, plaintes, ouvertures,
--                         clics, délivrés suivis. Lien : automation_send.outbox_id → outbox → événements.
--   audience_engagement   niveaux d'engagement des actifs, carte jour × heure des ouvertures et clics
--                         dans le fuseau de l'édition principale, sources d'inscription, semaines
--                         (inscriptions, imports, confirmations, désinscriptions, lecteurs uniques).
--   subscriber_activity   les messages d'un abonné SUR CETTE MARQUE, chacun avec ses événements.
--
-- ⚠️ Désinscriptions dans le temps : seules celles qui ont laissé un `consent_event` 'unsubscribe' ont
-- une date. Un statut 'unsubscribed' venu d'un import n'en a pas : il compte dans les sources, pas
-- dans les semaines (mesuré le 07/10 : 88 statuts, 7 événements).

set local role postgres;

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'newsletter' and table_name = 'email_event' and column_name = 'device_type') then
    raise exception '[0094] 0092 absente : email_event n''a pas les colonnes de detail';
  end if;
end
$$;

-- La fiche abonné lit l'outbox par abonnement : sans index, chaque fiche parcourt toute la table.
create index if not exists ix_email_outbox_subscription
  on newsletter.email_outbox (subscription_id, created_at desc)
  where subscription_id is not null;

-- ---------------------------------------------------------------------------
-- 1. Engagement d'une campagne (toutes éditions, ou une seule).
-- ---------------------------------------------------------------------------
create or replace function newsletter.campaign_engagement(
  p_asset_id      uuid,
  p_campaign_id   uuid,
  p_occurrence_id uuid default null
) returns jsonb
language sql
stable
security definer
set search_path = newsletter, pg_temp
as $$
with ob as (
  select o.id, o.sent_at, o.tracked
  from newsletter.email_outbox o
  where o.asset_id = p_asset_id
    and o.campaign_id = p_campaign_id
    and o.status = 'sent'
    and (p_occurrence_id is null or o.occurrence_id = p_occurrence_id)
),
ev as (
  select e.outbox_id, e.type, e.occurred_at, e.url, e.device_type, e.client_name, e.client_os, e.bot,
         e.country, e.city, ob.sent_at
  from newsletter.email_event e
  left join ob on ob.id = e.outbox_id
  where e.asset_id = p_asset_id
    and e.campaign_id = p_campaign_id
    and (p_occurrence_id is null or e.occurrence_id = p_occurrence_id)
    and e.type in ('opened', 'clicked')
),
liens as (
  select url, count(distinct outbox_id) as uniques, count(*) as total
  from ev
  where type = 'clicked' and url is not null
  group by url
  order by count(distinct outbox_id) desc, count(*) desc, url
  limit 25
),
-- Délai jusqu'à la PREMIÈRE ouverture / au PREMIER clic de chaque destinataire, compté depuis SON envoi :
-- valable aussi pour une campagne récurrente dont les éditions partent à des jours différents.
premiers as (
  select outbox_id, type, min(occurred_at) - min(sent_at) as delai
  from ev
  where sent_at is not null
  group by outbox_id, type
),
heures as (
  select least(greatest(floor(extract(epoch from delai) / 3600)::integer, 0), 72) as h,
         count(*) filter (where type = 'opened')  as opens,
         count(*) filter (where type = 'clicked') as clicks
  from premiers
  group by 1
),
dims as (
  select d.dim, d.val, count(distinct ev.outbox_id) as uniques, count(*) as total
  from ev
  cross join lateral (values
    ('device',  ev.device_type),
    ('client',  ev.client_name),
    ('os',      ev.client_os),
    ('country', ev.country),
    ('city',    case when ev.city is null then null else ev.city || coalesce(', ' || ev.country, '') end)
  ) as d(dim, val)
  group by d.dim, d.val
),
rangs as (
  select dim, val, uniques, total,
         row_number() over (partition by dim order by uniques desc, total desc, val nulls last) as rang
  from dims
)
select jsonb_build_object(
  'sent',             (select count(*) from ob),
  'tracked',          (select count(*) from ob where tracked),
  'tracking_unknown', (select count(*) from ob where tracked is null),
  'opens', jsonb_build_object(
    'unique',       (select count(distinct outbox_id) from ev where type = 'opened'),
    'total',        (select count(*) from ev where type = 'opened'),
    'unique_human', (select count(distinct outbox_id) from ev where type = 'opened' and bot is null),
    'bot',          (select count(*) from ev where type = 'opened' and bot is not null)),
  'clicks', jsonb_build_object(
    'unique', (select count(distinct outbox_id) from ev where type = 'clicked'),
    'total',  (select count(*) from ev where type = 'clicked')),
  'links', coalesce((
    select jsonb_agg(jsonb_build_object('url', url, 'unique', uniques, 'total', total)
                     order by uniques desc, total desc, url)
    from liens), '[]'::jsonb),
  'first_action_hours', coalesce((
    select jsonb_agg(jsonb_build_object('hour', h, 'opens', opens, 'clicks', clicks) order by h)
    from heures), '[]'::jsonb),
  'dimensions', coalesce((
    select jsonb_object_agg(dim, lignes)
    from (select dim, jsonb_agg(jsonb_build_object('value', val, 'unique', uniques, 'total', total)
                                order by rang) as lignes
          from rangs where rang <= 20
          group by dim) x), '{}'::jsonb)
);
$$;

-- ---------------------------------------------------------------------------
-- 2. Résultats des automations, par étape.
-- ---------------------------------------------------------------------------
create or replace function newsletter.automation_send_stats(
  p_asset_id      uuid,
  p_automation_id uuid        default null,
  p_since         timestamptz default null
) returns jsonb
language sql
stable
security definer
set search_path = newsletter, pg_temp
as $$
with s as (
  select a.automation_id, a.step, a.simulated, a.outbox_id, a.created_at
  from newsletter.automation_send a
  where a.asset_id = p_asset_id
    and (p_automation_id is null or a.automation_id = p_automation_id)
    and (p_since is null or a.created_at >= p_since)
),
ob as (
  select o.id, o.status, o.tracked
  from newsletter.email_outbox o
  where o.asset_id = p_asset_id
    and o.id in (select outbox_id from s where outbox_id is not null)
),
ev as (
  select e.outbox_id,
         bool_or(e.type = 'delivered')  as delivered,
         bool_or(e.type = 'bounced')    as bounced,
         bool_or(e.type = 'complained') as complained,
         bool_or(e.type = 'opened')     as opened,
         bool_or(e.type = 'clicked')    as clicked
  from newsletter.email_event e
  where e.asset_id = p_asset_id
    and e.outbox_id in (select id from ob)
  group by e.outbox_id
),
etapes as (
  select s.automation_id, s.step,
         count(*) filter (where not s.simulated)                     as real,
         count(*) filter (where s.simulated)                         as simulated,
         count(*) filter (where ob.status = 'sent')                  as sent,
         count(*) filter (where ob.status = 'failed')                as failed,
         count(*) filter (where ob.status = 'skipped')               as skipped,
         count(*) filter (where ob.status in ('pending', 'sending')) as queued,
         count(*) filter (where ev.delivered)                        as delivered,
         count(*) filter (where ev.bounced)                          as bounced,
         count(*) filter (where ev.complained)                       as complained,
         count(*) filter (where ev.opened)                           as opened,
         count(*) filter (where ev.clicked)                          as clicked,
         count(*) filter (where ev.delivered and ob.tracked)         as tracked,
         max(s.created_at)                                           as last_at
  from s
  left join ob on ob.id = s.outbox_id
  left join ev on ev.outbox_id = s.outbox_id
  group by s.automation_id, s.step
)
select jsonb_build_object('automations', coalesce((
  select jsonb_agg(jsonb_build_object(
           'id', a.id,
           'name', a.name,
           'status', a.status,
           'trigger', a.trigger,
           'steps', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'step', e.step, 'real', e.real, 'simulated', e.simulated,
                      'sent', e.sent, 'failed', e.failed, 'skipped', e.skipped, 'queued', e.queued,
                      'delivered', e.delivered, 'bounced', e.bounced, 'complained', e.complained,
                      'opened', e.opened, 'clicked', e.clicked, 'tracked', e.tracked,
                      'last_at', e.last_at)
                    order by e.step)
             from etapes e where e.automation_id = a.id), '[]'::jsonb))
         order by a.name, a.id)
  from newsletter.automation a
  where a.asset_id = p_asset_id
    and (p_automation_id is null or a.id = p_automation_id)
    -- Un brouillon qui n'a jamais rien produit n'a pas de résultat à montrer.
    and (a.status <> 'draft' or exists (select 1 from s where s.automation_id = a.id))
), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- 3. Audience : niveaux, moments, sources, semaines.
-- ---------------------------------------------------------------------------
create or replace function newsletter.audience_engagement(
  p_asset_id uuid,
  p_since    timestamptz default null
) returns jsonb
language sql
stable
security definer
set search_path = newsletter, pg_temp
as $$
with tz as (
  select coalesce((select e.timezone from newsletter.asset_edition e
                    where e.asset_id = p_asset_id and e.is_primary and e.timezone is not null
                    limit 1), 'UTC') as nom
),
debut as (
  select coalesce(p_since, now() - interval '182 days') as t
),
subs as (
  select s.id, s.status, s.source, s.engagement_level, s.engagement_score, s.open_count, s.click_count,
         s.created_at
  from newsletter.subscription s
  where s.asset_id = p_asset_id
    and s.status <> 'deleted'
),
actions as (
  select e.subscription_id, e.outbox_id, e.type, e.occurred_at at time zone (select nom from tz) as local
  from newsletter.email_event e
  where e.asset_id = p_asset_id
    and e.type in ('opened', 'clicked')
    and e.occurred_at >= (select t from debut)
),
carte as (
  select extract(isodow from local)::integer as dow,
         extract(hour from local)::integer   as hour,
         count(distinct outbox_id) filter (where type = 'opened')  as opens,
         count(distinct outbox_id) filter (where type = 'clicked') as clicks
  from actions
  group by 1, 2
),
sources as (
  select coalesce(source, 'unknown')                                                        as source,
         count(*)                                                                           as total,
         count(*) filter (where status = 'active')                                          as active,
         count(*) filter (where status = 'pending')                                         as pending,
         count(*) filter (where status = 'contact')                                         as contacts,
         count(*) filter (where status = 'unsubscribed')                                    as unsubscribed,
         count(*) filter (where status = 'active' and (open_count > 0 or click_count > 0))  as engaged,
         round(avg(engagement_score) filter (where status = 'active'))::integer              as avg_score
  from subs
  group by 1
),
semaines as (
  select date_trunc('week', x.local)::date as semaine, x.k, count(*) as n
  from (
    select s.created_at at time zone (select nom from tz) as local,
           case when s.source in ('import', 'crm_sync') then 'imported' else 'signups' end as k
    from subs s
    where s.created_at >= (select t from debut)
    union all
    select c.occurred_at at time zone (select nom from tz),
           case c.event_type when 'optin_confirm' then 'confirmations' else 'unsubscribes' end
    from newsletter.consent_event c
    join subs s on s.id = c.subscription_id
    where c.event_type in ('optin_confirm', 'unsubscribe')
      and c.occurred_at >= (select t from debut)
  ) x
  group by 1, 2
  union all
  select date_trunc('week', local)::date, 'readers', count(distinct subscription_id)
  from actions
  where type = 'opened' and subscription_id is not null
  group by 1
)
select jsonb_build_object(
  'timezone', (select nom from tz),
  'since',    (select t from debut),
  'levels', coalesce((
    select jsonb_object_agg(niveau, n)
    from (select coalesce(engagement_level, 'unknown') as niveau, count(*) as n
            from subs where status = 'active' group by 1) x), '{}'::jsonb),
  'heatmap', coalesce((
    select jsonb_agg(jsonb_build_object('dow', dow, 'hour', hour, 'opens', opens, 'clicks', clicks)
                     order by dow, hour)
    from carte), '[]'::jsonb),
  'sources', coalesce((
    select jsonb_agg(jsonb_build_object(
             'source', source, 'total', total, 'active', active, 'pending', pending,
             'contacts', contacts, 'unsubscribed', unsubscribed, 'engaged', engaged,
             'avg_score', avg_score)
           order by total desc, source)
    from sources), '[]'::jsonb),
  'weekly', coalesce((
    select jsonb_agg(jsonb_build_object('week', semaine, 'metric', k, 'count', n) order by semaine, k)
    from semaines), '[]'::jsonb)
);
$$;

-- ---------------------------------------------------------------------------
-- 4. Activité d'un abonné sur UNE marque.
-- ---------------------------------------------------------------------------
create or replace function newsletter.subscriber_activity(
  p_asset_id      uuid,
  p_subscriber_id uuid,
  p_limit         integer default 100
) returns jsonb
language sql
stable
security definer
set search_path = newsletter, pg_temp
as $$
with abo as (
  select s.id, s.status, s.open_count, s.click_count, s.last_open_at, s.last_click_at,
         s.last_engagement_at, s.engagement_score, s.engagement_level, s.tracking_consent, s.created_at
  from newsletter.subscription s
  where s.asset_id = p_asset_id
    and s.subscriber_id = p_subscriber_id
),
tous as (
  select o.id, o.kind, o.subject, o.status, o.created_at, o.sent_at, o.tracked, o.campaign_id
  from newsletter.email_outbox o
  where o.asset_id = p_asset_id
    and o.subscription_id in (select id from abo)
),
msgs as (
  select * from tous
  order by coalesce(sent_at, created_at) desc, id
  limit least(greatest(coalesce(p_limit, 100), 0), 500)
)
select jsonb_build_object(
  'subscriptions', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'status', a.status, 'open_count', a.open_count, 'click_count', a.click_count,
             'last_open_at', a.last_open_at, 'last_click_at', a.last_click_at,
             'last_engagement_at', a.last_engagement_at, 'engagement_score', a.engagement_score,
             'engagement_level', a.engagement_level, 'tracking_consent', a.tracking_consent,
             'created_at', a.created_at)
           order by a.created_at)
    from abo a), '[]'::jsonb),
  'total_messages', (select count(*) from tous),
  'messages', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', m.id, 'kind', m.kind, 'subject', m.subject, 'status', m.status,
             'created_at', m.created_at, 'sent_at', m.sent_at, 'tracked', m.tracked,
             'campaign_id', m.campaign_id, 'campaign_name', c.name,
             'events', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'type', e.type, 'occurred_at', e.occurred_at, 'severity', e.severity,
                        'reason', e.reason, 'url', e.url, 'device_type', e.device_type,
                        'client_name', e.client_name, 'client_os', e.client_os, 'bot', e.bot,
                        'country', e.country, 'city', e.city)
                      order by e.occurred_at, e.id)
               from newsletter.email_event e
               where e.outbox_id = m.id and e.asset_id = p_asset_id), '[]'::jsonb))
           order by coalesce(m.sent_at, m.created_at) desc, m.id)
    from msgs m
    left join newsletter.campaign c on c.id = m.campaign_id and c.asset_id = p_asset_id), '[]'::jsonb)
);
$$;

revoke execute on function newsletter.campaign_engagement(uuid, uuid, uuid)                from public, anon, authenticated;
revoke execute on function newsletter.automation_send_stats(uuid, uuid, timestamptz)        from public, anon, authenticated;
revoke execute on function newsletter.audience_engagement(uuid, timestamptz)                from public, anon, authenticated;
revoke execute on function newsletter.subscriber_activity(uuid, uuid, integer)              from public, anon, authenticated;
grant  execute on function newsletter.campaign_engagement(uuid, uuid, uuid)                to service_role;
grant  execute on function newsletter.automation_send_stats(uuid, uuid, timestamptz)        to service_role;
grant  execute on function newsletter.audience_engagement(uuid, timestamptz)                to service_role;
grant  execute on function newsletter.subscriber_activity(uuid, uuid, integer)              to service_role;

reset role;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVES — DANS la migration (voir 0072).
-- ---------------------------------------------------------------------------
-- Deux lectures de JSON pour la contre-épreuve 4, TEMPORAIRES (pg_temp : disparaissent avec la session).
create function pg_temp.nf0094_h(j jsonb, k text, h integer) returns integer language sql immutable as $f$
  select coalesce((select (g ->> k)::integer from jsonb_array_elements(j -> 'first_action_hours') g
                    where (g ->> 'hour')::integer = h), 0)
$f$;
create function pg_temp.nf0094_case(j jsonb, t timestamp) returns integer language sql immutable as $f$
  select coalesce((select (g ->> 'opens')::integer from jsonb_array_elements(j -> 'heatmap') g
                    where (g ->> 'dow')::integer = extract(isodow from t)::integer
                      and (g ->> 'hour')::integer = extract(hour from t)::integer), 0)
$f$;
create function pg_temp.nf0094_etape(j jsonb, etape integer, k text) returns integer language sql immutable as $f$
  select coalesce((select sum((st ->> k)::integer) from jsonb_array_elements(j -> 'automations') a,
                                                       jsonb_array_elements(a -> 'steps') st
                    where (st ->> 'step')::integer = etape), 0)::integer
$f$;

do $$
declare
  v_sigs   constant text[] := array[
    'newsletter.campaign_engagement(uuid, uuid, uuid)',
    'newsletter.automation_send_stats(uuid, uuid, timestamptz)',
    'newsletter.audience_engagement(uuid, timestamptz)',
    'newsletter.subscriber_activity(uuid, uuid, integer)'];
  v_sig    text;
  v_asset  record;
  v_c      record;
  v_r      jsonb;
  v_n      bigint;
  v_m      bigint;
  v_camp   record;
  v_f      record;
  v_a      record;
  v_b      record;
  v_autre  uuid;
  v_tz     text;
  v_avant  jsonb;
  v_apres  jsonb;
  v_aud_av jsonb;
  v_aud_ap jsonb;
  v_act    jsonb;
begin
  -- 1. Les quatre fonctions : definer, fermées hors service_role ; l'index de la fiche abonné.
  foreach v_sig in array v_sigs loop
    if not (select prosecdef from pg_proc where oid = v_sig::regprocedure)
       or has_function_privilege('anon', v_sig, 'EXECUTE')
       or has_function_privilege('authenticated', v_sig, 'EXECUTE')
       or not has_function_privilege('service_role', v_sig, 'EXECUTE') then
      raise exception '[0094] % : pas definer, ou mal ouverte', v_sig;
    end if;
  end loop;
  if not exists (select 1 from pg_indexes where schemaname = 'newsletter' and indexname = 'ix_email_outbox_subscription') then
    raise exception '[0094] index ix_email_outbox_subscription absent';
  end if;
  raise notice '[0094] contre-epreuve 1 OK : 4 fonctions definer fermees hors service_role, index present';

  -- 2. AUCUNE fuite entre marques, sur les vraies données : la campagne, l'automation ou l'abonné d'une
  --    autre marque rend du vide.
  for v_asset in select id from newsletter.asset loop
    for v_c in select c.id from newsletter.campaign c where c.asset_id <> v_asset.id loop
      v_r := newsletter.campaign_engagement(v_asset.id, v_c.id);
      if (v_r ->> 'sent')::integer <> 0 or (v_r -> 'opens' ->> 'total')::integer <> 0
         or (v_r -> 'clicks' ->> 'total')::integer <> 0 or jsonb_array_length(v_r -> 'links') <> 0 then
        raise exception '[0094] campaign_engagement rend la campagne % a la marque %', v_c.id, v_asset.id;
      end if;
    end loop;
    v_r := newsletter.automation_send_stats(v_asset.id);
    if exists (select 1 from jsonb_array_elements(v_r -> 'automations') a
                where not exists (select 1 from newsletter.automation k
                                   where k.id = (a ->> 'id')::uuid and k.asset_id = v_asset.id)) then
      raise exception '[0094] automation_send_stats rend une automation d''une autre marque a %', v_asset.id;
    end if;
    -- Les 200 abonnés les plus récents des AUTRES marques (tous = ~64 000 appels, hors du délai).
    select count(*) into v_n
      from (select s.subscriber_id
              from newsletter.subscription s
             where s.asset_id <> v_asset.id
               and not exists (select 1 from newsletter.subscription t
                                where t.subscriber_id = s.subscriber_id and t.asset_id = v_asset.id)
             order by s.created_at desc
             limit 200) x
     where jsonb_array_length(newsletter.subscriber_activity(v_asset.id, x.subscriber_id, 5) -> 'subscriptions') > 0
        or (newsletter.subscriber_activity(v_asset.id, x.subscriber_id, 5) ->> 'total_messages')::integer > 0;
    if v_n > 0 then
      raise exception '[0094] subscriber_activity rend % abonne(s) d''une autre marque a %', v_n, v_asset.id;
    end if;
  end loop;
  raise notice '[0094] contre-epreuve 2 OK : aucune campagne, automation ou abonne d''une autre marque';

  -- 3. Les totaux recoupent les tables, sur les vraies données de chaque marque.
  for v_asset in select id from newsletter.asset loop
    v_r := newsletter.automation_send_stats(v_asset.id);
    select coalesce(sum((st ->> 'real')::bigint + (st ->> 'simulated')::bigint), 0) into v_n
      from jsonb_array_elements(v_r -> 'automations') a, jsonb_array_elements(a -> 'steps') st;
    if v_n <> (select count(*) from newsletter.automation_send where asset_id = v_asset.id) then
      raise exception '[0094] automations de % : % envois rendus, % en table', v_asset.id, v_n,
        (select count(*) from newsletter.automation_send where asset_id = v_asset.id);
    end if;
    select coalesce(sum((st ->> 'simulated')::bigint), 0) into v_n
      from jsonb_array_elements(v_r -> 'automations') a, jsonb_array_elements(a -> 'steps') st;
    if v_n <> (select count(*) from newsletter.automation_send where asset_id = v_asset.id and simulated) then
      raise exception '[0094] automations de % : simules rendus % <> table', v_asset.id, v_n;
    end if;
    select coalesce(sum((st ->> 'sent')::bigint), 0), coalesce(sum((st ->> 'delivered')::bigint), 0) into v_n, v_m
      from jsonb_array_elements(v_r -> 'automations') a, jsonb_array_elements(a -> 'steps') st;
    if v_n <> (select count(*) from newsletter.automation_send s join newsletter.email_outbox o on o.id = s.outbox_id
                where s.asset_id = v_asset.id and o.status = 'sent')
       or v_m <> (select count(*) from newsletter.automation_send s
                   where s.asset_id = v_asset.id
                     and exists (select 1 from newsletter.email_event e where e.outbox_id = s.outbox_id and e.type = 'delivered')) then
      raise exception '[0094] automations de % : sent ou delivered ne recoupent pas l''outbox et les evenements', v_asset.id;
    end if;
    for v_c in select c.id from newsletter.campaign c where c.asset_id = v_asset.id loop
      v_r := newsletter.campaign_engagement(v_asset.id, v_c.id);
      if (v_r ->> 'sent')::bigint <> (select count(*) from newsletter.email_outbox
                                        where campaign_id = v_c.id and asset_id = v_asset.id and status = 'sent')
         or (v_r -> 'opens' ->> 'unique')::bigint <> coalesce((
              select sum((e ->> 'opened')::bigint)
                from jsonb_array_elements(newsletter.campaign_send_stats(v_asset.id, v_c.id) -> 'campaigns') c,
                     jsonb_array_elements(c -> 'editions') e), 0) then
        raise exception '[0094] campaign_engagement de % ne recoupe ni l''outbox ni campaign_send_stats', v_c.id;
      end if;
    end loop;
    v_r := newsletter.audience_engagement(v_asset.id);
    select coalesce(sum(value::bigint), 0) into v_n from jsonb_each_text(v_r -> 'levels');
    select coalesce(sum((x ->> 'total')::bigint), 0) into v_m from jsonb_array_elements(v_r -> 'sources') x;
    if v_n <> (select count(*) from newsletter.subscription where asset_id = v_asset.id and status = 'active')
       or v_m <> (select count(*) from newsletter.subscription where asset_id = v_asset.id and status <> 'deleted') then
      raise exception '[0094] audience de % : niveaux ou sources ne recoupent pas les abonnements', v_asset.id;
    end if;
    select coalesce(sum((w ->> 'count')::bigint) filter (where w ->> 'metric' in ('signups', 'imported')), 0),
           coalesce(sum((w ->> 'count')::bigint) filter (where w ->> 'metric' = 'confirmations'), 0)
      into v_n, v_m
      from jsonb_array_elements(v_r -> 'weekly') w;
    if v_n <> (select count(*) from newsletter.subscription
                where asset_id = v_asset.id and status <> 'deleted' and created_at >= (v_r ->> 'since')::timestamptz)
       or v_m <> (select count(*) from newsletter.consent_event c join newsletter.subscription s on s.id = c.subscription_id
                   where s.asset_id = v_asset.id and s.status <> 'deleted' and c.event_type = 'optin_confirm'
                     and c.occurred_at >= (v_r ->> 'since')::timestamptz) then
      raise exception '[0094] audience de % : semaines (inscriptions ou confirmations) ne recoupent pas les tables', v_asset.id;
    end if;
  end loop;
  raise notice '[0094] contre-epreuve 3 OK : automations, campagnes et audience recoupent les tables';

  -- 4. Le comportement, sur DEUX VRAIS envois d'une même campagne, avec des événements d'essai dans un
  --    bloc ANNULÉ (rien ne persiste) :
  --      A : ouverture humaine à 30 min, clic à 3 h 05, seconde ouverture à 5 h 20 ;
  --      B : UNE SEULE ouverture, de robot, à 2 h 10 — sans elle, compter les robots parmi les humains
  --          passerait inaperçu (A a aussi une ouverture humaine).
  select o.campaign_id into v_camp
    from newsletter.email_outbox o
    join newsletter.subscription s on s.id = o.subscription_id
   where o.status = 'sent' and o.kind = 'campaign' and o.campaign_id is not null and o.sent_at is not null
     and not exists (select 1 from newsletter.email_event e where e.outbox_id = o.id and e.type in ('opened', 'clicked'))
   group by o.campaign_id
  having count(*) >= 2
   order by max(o.sent_at) desc, o.campaign_id
   limit 1;
  if v_camp.campaign_id is null then
    raise notice '[0094] contre-epreuve 4 SAUTEE : aucune campagne a deux envois sans ouverture';
  else
    select o.id, o.asset_id, o.campaign_id, o.occurrence_id, o.subscription_id, o.sent_at, s.subscriber_id into v_a
      from newsletter.email_outbox o join newsletter.subscription s on s.id = o.subscription_id
     where o.campaign_id = v_camp.campaign_id and o.status = 'sent' and o.sent_at is not null
       and not exists (select 1 from newsletter.email_event e where e.outbox_id = o.id and e.type in ('opened', 'clicked'))
     order by o.sent_at desc, o.id limit 1;
    select o.id, o.asset_id, o.campaign_id, o.occurrence_id, o.subscription_id, o.sent_at into v_b
      from newsletter.email_outbox o join newsletter.subscription s on s.id = o.subscription_id
     where o.campaign_id = v_camp.campaign_id and o.status = 'sent' and o.sent_at is not null and o.id <> v_a.id
       and not exists (select 1 from newsletter.email_event e where e.outbox_id = o.id and e.type in ('opened', 'clicked'))
     order by o.sent_at desc, o.id limit 1;
    select id into v_autre from newsletter.asset where id <> v_a.asset_id order by id limit 1;
    v_tz := coalesce((select e.timezone from newsletter.asset_edition e
                       where e.asset_id = v_a.asset_id and e.is_primary and e.timezone is not null limit 1), 'UTC');
    begin
      v_avant  := newsletter.campaign_engagement(v_a.asset_id, v_a.campaign_id);
      v_aud_av := newsletter.audience_engagement(v_a.asset_id, '2000-01-01');
      insert into newsletter.email_event
        (outbox_id, subscription_id, asset_id, campaign_id, occurrence_id, type, provider, provider_event_id,
         occurred_at, payload, url, device_type, client_name, client_os, bot, country, city)
      values
        (v_a.id, v_a.subscription_id, v_a.asset_id, v_a.campaign_id, v_a.occurrence_id,
         'opened', 'mailgun', 'nf0094-essai-1', v_a.sent_at + interval '30 minutes', '{}'::jsonb,
         null, 'mobile', 'Gmail', 'Android', null, 'GB', 'London'),
        (v_a.id, v_a.subscription_id, v_a.asset_id, v_a.campaign_id, v_a.occurrence_id,
         'clicked', 'mailgun', 'nf0094-essai-2', v_a.sent_at + interval '3 hours 5 minutes', '{}'::jsonb,
         'https://exemple.test/nf0094', 'mobile', 'Gmail', 'Android', null, 'GB', 'London'),
        (v_a.id, v_a.subscription_id, v_a.asset_id, v_a.campaign_id, v_a.occurrence_id,
         'opened', 'mailgun', 'nf0094-essai-3', v_a.sent_at + interval '5 hours 20 minutes', '{}'::jsonb,
         null, 'desktop', 'Outlook', 'Windows', null, 'GB', 'Leeds'),
        (v_b.id, v_b.subscription_id, v_b.asset_id, v_b.campaign_id, v_b.occurrence_id,
         'opened', 'mailgun', 'nf0094-essai-4', v_b.sent_at + interval '2 hours 10 minutes', '{}'::jsonb,
         null, null, null, null, 'apple', null, null);
      v_apres := newsletter.campaign_engagement(v_a.asset_id, v_a.campaign_id);
      if (v_apres -> 'opens' ->> 'unique')::integer          <> (v_avant -> 'opens' ->> 'unique')::integer + 2
         or (v_apres -> 'opens' ->> 'total')::integer        <> (v_avant -> 'opens' ->> 'total')::integer + 3
         or (v_apres -> 'opens' ->> 'unique_human')::integer <> (v_avant -> 'opens' ->> 'unique_human')::integer + 1
         or (v_apres -> 'opens' ->> 'bot')::integer          <> (v_avant -> 'opens' ->> 'bot')::integer + 1
         or (v_apres -> 'clicks' ->> 'unique')::integer      <> (v_avant -> 'clicks' ->> 'unique')::integer + 1
         or (v_apres -> 'clicks' ->> 'total')::integer       <> (v_avant -> 'clicks' ->> 'total')::integer + 1 then
        raise exception '[0094] ouvertures/clics faux : avant % / apres %', v_avant -> 'opens', v_apres -> 'opens';
      end if;
      if not exists (select 1 from jsonb_array_elements(v_apres -> 'links') l
                      where l ->> 'url' = 'https://exemple.test/nf0094' and (l ->> 'unique')::integer = 1)
         or exists (select 1 from jsonb_array_elements(v_apres -> 'links') l where l ->> 'url' is null) then
        raise exception '[0094] le lien clique manque, ou un lien sans adresse est rendu';
      end if;
      -- Délais comptés depuis l'envoi de CHAQUE destinataire, PREMIÈRE action seulement :
      -- A ouvre en heure 0 (et rouvre en heure 5 : ne compte pas), B en heure 2, A clique en heure 3.
      if pg_temp.nf0094_h(v_apres, 'opens', 0)  <> pg_temp.nf0094_h(v_avant, 'opens', 0) + 1
         or pg_temp.nf0094_h(v_apres, 'opens', 2)  <> pg_temp.nf0094_h(v_avant, 'opens', 2) + 1
         or pg_temp.nf0094_h(v_apres, 'clicks', 3) <> pg_temp.nf0094_h(v_avant, 'clicks', 3) + 1
         or pg_temp.nf0094_h(v_apres, 'opens', 5)  <> pg_temp.nf0094_h(v_avant, 'opens', 5) then
        raise exception '[0094] delai jusqu''a la premiere action faux : %', v_apres -> 'first_action_hours';
      end if;
      if not exists (select 1 from jsonb_array_elements(v_apres -> 'dimensions' -> 'device') d where d ->> 'value' = 'mobile')
         or not exists (select 1 from jsonb_array_elements(v_apres -> 'dimensions' -> 'country') d where d ->> 'value' = 'GB')
         or not exists (select 1 from jsonb_array_elements(v_apres -> 'dimensions' -> 'city') d where d ->> 'value' = 'London, GB') then
        raise exception '[0094] dimensions fausses : %', v_apres -> 'dimensions';
      end if;
      -- Une autre édition, ou une autre marque, ne voit RIEN de ces événements.
      v_r := newsletter.campaign_engagement(v_a.asset_id, v_a.campaign_id, gen_random_uuid());
      if (v_r ->> 'sent')::integer <> 0 or (v_r -> 'opens' ->> 'total')::integer <> 0 or (v_r -> 'clicks' ->> 'total')::integer <> 0 then
        raise exception '[0094] le filtre d''edition de campaign_engagement ne filtre pas';
      end if;
      if v_autre is not null then
        v_r := newsletter.campaign_engagement(v_autre, v_a.campaign_id);
        if (v_r -> 'opens' ->> 'total')::integer <> 0 or (v_r -> 'clicks' ->> 'total')::integer <> 0
           or jsonb_array_length(v_r -> 'links') <> 0 or v_r -> 'dimensions' <> '{}'::jsonb then
          raise exception '[0094] une autre marque voit les ouvertures de la campagne %', v_a.campaign_id;
        end if;
        if exists (select 1 from jsonb_array_elements(newsletter.subscriber_activity(v_autre, v_a.subscriber_id, 500) -> 'messages') m
                    where (m ->> 'id')::uuid = v_a.id) then
          raise exception '[0094] une autre marque voit l''envoi dans la fiche abonne';
        end if;
      end if;
      -- La carte : dans le fuseau de l'édition principale ; 3 couples (envoi, case) en ouverture, 1 en clic.
      v_aud_ap := newsletter.audience_engagement(v_a.asset_id, '2000-01-01');
      if v_aud_ap ->> 'timezone' <> v_tz
         or (select coalesce(sum((h ->> 'opens')::integer), 0) from jsonb_array_elements(v_aud_ap -> 'heatmap') h)
            <> (select coalesce(sum((h ->> 'opens')::integer), 0) from jsonb_array_elements(v_aud_av -> 'heatmap') h) + 3
         or (select coalesce(sum((h ->> 'clicks')::integer), 0) from jsonb_array_elements(v_aud_ap -> 'heatmap') h)
            <> (select coalesce(sum((h ->> 'clicks')::integer), 0) from jsonb_array_elements(v_aud_av -> 'heatmap') h) + 1
         or pg_temp.nf0094_case(v_aud_ap, (v_a.sent_at + interval '30 minutes') at time zone v_tz)
            < pg_temp.nf0094_case(v_aud_av, (v_a.sent_at + interval '30 minutes') at time zone v_tz) + 1 then
        raise exception '[0094] carte jour x heure fausse (fuseau %)', v_tz;
      end if;
      v_act := newsletter.subscriber_activity(v_a.asset_id, v_a.subscriber_id, 500);
      if not exists (select 1 from jsonb_array_elements(v_act -> 'messages') m
                      where (m ->> 'id')::uuid = v_a.id
                        and (select count(*) from jsonb_array_elements(m -> 'events') e
                              where e ->> 'type' in ('opened', 'clicked')) = 3
                        and exists (select 1 from jsonb_array_elements(m -> 'events') e
                                     where e ->> 'url' = 'https://exemple.test/nf0094')) then
        raise exception '[0094] la fiche abonne ne montre pas l''envoi et ses evenements';
      end if;
      raise exception 'nf0094_retour';
    exception when raise_exception then
      if sqlerrm <> 'nf0094_retour' then
        raise;
      end if;
    end;
    if exists (select 1 from newsletter.email_event where provider_event_id like 'nf0094-essai-%') then
      raise exception '[0094] les evenements d''essai ont persiste';
    end if;
    raise notice '[0094] contre-epreuve 4 OK : ouvertures, robot seul, clic, lien, premiers delais, dimensions, edition, autre marque, carte (fuseau %) et fiche abonne ; essai annule', v_tz;
  end if;

  -- 5. Un envoi d'automation ÉCHOUÉ compte en `failed`, jamais en `sent`. Mesuré le 07/10 : 46 envois
  --    d'automation `sent`, 41 `skipped`, AUCUN `failed` — sans cet essai, compter les échecs comme
  --    envoyés passerait (mutant survivant). Bloc ANNULÉ, et l'outbox n'est PAS touchée : une ligne
  --    d'essai d'automation_send est rattachée à un échec qui existe déjà.
  select o.id as outbox_id, o.asset_id, o.subscription_id, a.id as automation_id into v_f
    from newsletter.email_outbox o
    join newsletter.automation a on a.asset_id = o.asset_id
   where o.status = 'failed' and o.subscription_id is not null
   order by o.created_at desc, o.id, a.id
   limit 1;
  if v_f.outbox_id is null then
    raise notice '[0094] contre-epreuve 5 SAUTEE : aucun echec rattachable a une automation';
  else
    begin
      v_avant := newsletter.automation_send_stats(v_f.asset_id, v_f.automation_id);
      insert into newsletter.automation_send
        (automation_id, asset_id, subscription_id, step, period_key, simulated, outbox_id, reason)
      values (v_f.automation_id, v_f.asset_id, v_f.subscription_id, 5, 'nf0094-essai', false, v_f.outbox_id, 'enqueued');
      v_apres := newsletter.automation_send_stats(v_f.asset_id, v_f.automation_id);
      if pg_temp.nf0094_etape(v_apres, 5, 'failed') <> pg_temp.nf0094_etape(v_avant, 5, 'failed') + 1
         or pg_temp.nf0094_etape(v_apres, 5, 'sent') <> pg_temp.nf0094_etape(v_avant, 5, 'sent')
         or pg_temp.nf0094_etape(v_apres, 5, 'real') <> pg_temp.nf0094_etape(v_avant, 5, 'real') + 1 then
        raise exception '[0094] un envoi d''automation echoue n''est pas compte en failed : %', v_apres;
      end if;
      raise exception 'nf0094_retour';
    exception when raise_exception then
      if sqlerrm <> 'nf0094_retour' then
        raise;
      end if;
    end;
    if exists (select 1 from newsletter.automation_send where period_key = 'nf0094-essai') then
      raise exception '[0094] l''envoi d''automation d''essai a persiste';
    end if;
    raise notice '[0094] contre-epreuve 5 OK : un echec d''automation compte en failed, pas en sent ; essai annule';
  end if;
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0094', '0094_analytics_comportement.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
