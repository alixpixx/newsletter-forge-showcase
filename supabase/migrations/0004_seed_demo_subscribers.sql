-- Seed de DÉMO : 1200 abonnés Quartz Tips avec attributs variés (statut, engagement,
-- source, pays, tags) pour faire vivre les écrans et la segmentation.
--
-- ⚠️ SÉCURITÉ : emails `@example.com` = domaine RÉSERVÉ (RFC 2606), non délivrable.
-- Jamais de vraies adresses (gmail…) dans une base qui enverra des emails : on ne doit
-- pas pouvoir spammer de vraies personnes par accident.
--
-- Purge avant lancement réel :
--   delete from newsletter.subscriber where email like 'demo%@example.com';
--
-- Distribution obtenue : 1056 actifs / 84 désabonnés / 60 pending ·
-- engagement 720 actifs / 300 dormants / 180 churned · 1104 BR · 420 tagués.

insert into newsletter.subscriber (email, first_name)
select format('demo%s@example.com', i),
       (array['Rafael','Maria','Joao','Lucas','Bruna','Diego','Camila','Pedro','Ana','Tiago'])[1 + (i % 10)]
from generate_series(1, 1200) as i
on conflict (email) do nothing;

with a as (select id from newsletter.asset where slug = 'quartz-tips'),
ed as (
  select e.id from newsletter.asset_edition e
  join newsletter.asset x on x.id = e.asset_id and x.slug = 'quartz-tips'
  limit 1
),
tg as (select id from newsletter.tag where slug = 'interesse:paris' limit 1),
calc as (
  select s.id as sid,
         (regexp_replace(s.email::text, '\D', '', 'g'))::int as i,
         ((regexp_replace(s.email::text, '\D', '', 'g'))::int * 7919)   % 100 as b_status,
         ((regexp_replace(s.email::text, '\D', '', 'g'))::int * 104729) % 100 as b_source,
         ((regexp_replace(s.email::text, '\D', '', 'g'))::int * 13)     % 100 as b_country,
         ((regexp_replace(s.email::text, '\D', '', 'g'))::int * 7)      % 100 as b_level,
         ((regexp_replace(s.email::text, '\D', '', 'g'))::int * 23)     % 100 as b_tag
  from newsletter.subscriber s
  where s.email like 'demo%@example.com'
)
insert into newsletter.subscription (
  subscriber_id, asset_id, edition_id, status, source, language, country,
  consent_state, consent_method, consent_at,
  open_count, click_count, last_open_at, last_click_at, last_engagement_at,
  engagement_score, engagement_level, welcome_completed, tag_ids, created_at
)
select
  c.sid, a.id, ed.id,
  case when c.b_status < 88 then 'active' when c.b_status < 95 then 'unsubscribed' else 'pending' end,
  case when c.b_source < 40 then 'organic' when c.b_source < 65 then 'social'
       when c.b_source < 80 then 'import' when c.b_source < 92 then 'crm_sync'
       else 'content_upgrade' end,
  'pt-BR',
  case when c.b_country < 92 then 'BR' when c.b_country < 95 then 'PT'
       when c.b_country < 98 then 'US' else 'AR' end,
  true, 'double_optin', now() - ((c.i % 300) || ' days')::interval,
  case when c.b_level < 60 then 5 + (c.i % 35) when c.b_level < 85 then 1 + (c.i % 8) else 0 end,
  case when c.b_level < 60 then 1 + (c.i % 12) when c.b_level < 85 then (c.i % 3) else 0 end,
  case when c.b_level < 60 then now() - ((c.b_level % 29) || ' days')::interval
       when c.b_level < 85 then now() - ((31 + (c.b_level % 59)) || ' days')::interval
       else now() - ((91 + (c.i % 200)) || ' days')::interval end,
  case when c.b_level < 60 then now() - ((c.b_level % 29) || ' days')::interval else null end,
  case when c.b_level < 60 then now() - ((c.b_level % 29) || ' days')::interval
       when c.b_level < 85 then now() - ((31 + (c.b_level % 59)) || ' days')::interval
       else now() - ((91 + (c.i % 200)) || ' days')::interval end,
  case when c.b_level < 60 then 60 + (c.i % 36) when c.b_level < 85 then 25 + (c.i % 31) else (c.i % 21) end,
  case when c.b_level < 60 then 'active' when c.b_level < 85 then 'dormant' else 'churned' end,
  c.b_level < 75,
  case when c.b_tag < 35 then array[(select id from tg)] else '{}'::int[] end,
  now() - ((c.i % 300) || ' days')::interval
from calc c cross join a cross join ed
on conflict (subscriber_id, asset_id) do nothing;

insert into newsletter.subscription_tag (subscription_id, tag_id, source)
select s.id, t.tag_id, 'seed'
from newsletter.subscription s, unnest(s.tag_ids) as t(tag_id)
on conflict do nothing;
