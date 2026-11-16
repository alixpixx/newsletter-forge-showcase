-- ---------------------------------------------------------------------------
-- 0069 — Deliverability : les chiffres RÉELS d'une marque, sur une fenêtre de jours.
-- ---------------------------------------------------------------------------
--
-- CE QUE ÇA REMPLACE. L'écran Deliverability était, sous son bloc de réengagement, une maquette
-- entière (placement en boîte de réception, réputation par sous-domaine, SPF/DKIM « ✓ », alertes).
-- Aucune de ces mesures n'existe dans le produit : on n'a ni sonde de placement, ni lecture DNS, ni
-- score de réputation. Cette fonction rend ce qui EXISTE — ce que le worker a remis au fournisseur
-- et ce que le fournisseur a répondu par webhook — et rien d'autre.
--
-- ⛔ LA COHORTE, PAS LA FENÊTRE D'ÉVÉNEMENTS. Les taux sont calculés sur les envois PARTIS dans la
-- fenêtre et sur les événements de CES envois, quelle que soit leur date. Compter « les événements
-- de la fenêtre » sur « les envois de la fenêtre » mélange deux populations : un rebond arrivé ce
-- matin pour un envoi d'hier soir tomberait hors du dénominateur, et un taux pourrait dépasser 100 %.
--
-- ⛔ UN ENVOI COMPTE UNE FOIS PAR ISSUE. Mailgun rejoue et double des événements (un échec mou peut
-- se répéter) : chaque issue est un booléen par envoi, jamais un nombre de lignes d'événements.
--
-- ⛔ AUCUNE ADRESSE NE SORT D'ICI. Les raisons de non-envoi sont réduites à leur code (le préfixe
-- avant « : ») et un préfixe qui n'a pas la forme d'un code devient « other » : un message d'erreur
-- du fournisseur peut citer l'adresse refusée.
--
-- ⚠️ Les jours sont des jours UTC. Les ouvertures et les clics sont rendus tels quels, mais ne
-- mesurent presque rien : sans consentement au suivi, Mailgun ne pose ni pixel ni lien réécrit.
-- L'écran le dit au lieu d'afficher un taux.
--
-- Accès : service_role uniquement (l'admin lit avec cette clé). Révoquée de public/anon/authenticated.

create or replace function newsletter.deliverability_summary(p_asset_id uuid, p_days integer default 30)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with bornes as (
  select
    j.jours,
    (date_trunc('day', now() at time zone 'utc') - make_interval(days => j.jours - 1)) at time zone 'utc' as depuis
  from (select least(greatest(coalesce(p_days, 30), 1), 365) as jours) j
),
envois as (
  select o.id, o.kind, o.campaign_id, o.sent_at
  from newsletter.email_outbox o, bornes b
  where o.asset_id = p_asset_id
    and o.status = 'sent'
    and o.sent_at >= b.depuis
),
issues as (
  select
    ev.outbox_id,
    bool_or(ev.type = 'delivered')    as delivered,
    bool_or(ev.type = 'bounced')      as bounced,
    bool_or(ev.type = 'failed')       as soft_failed,
    bool_or(ev.type = 'complained')   as complained,
    bool_or(ev.type = 'unsubscribed') as unsubscribed,
    bool_or(ev.type = 'opened')       as opened,
    bool_or(ev.type = 'clicked')      as clicked
  from newsletter.email_event ev
  where ev.outbox_id in (select id from envois)
  group by ev.outbox_id
),
lignes as (
  select
    e.id, e.kind, e.campaign_id, e.sent_at,
    coalesce(i.delivered, false)    as delivered,
    coalesce(i.bounced, false)      as bounced,
    coalesce(i.soft_failed, false)  as soft_failed,
    coalesce(i.complained, false)   as complained,
    coalesce(i.unsubscribed, false) as unsubscribed,
    coalesce(i.opened, false)       as opened,
    coalesce(i.clicked, false)      as clicked
  from envois e
  left join issues i on i.outbox_id = e.id
)
select jsonb_build_object(
  'days', b.jours,
  'since', b.depuis,
  'measured_at', now(),
  'sending_subdomain', (select a.sending_subdomain from newsletter.asset a where a.id = p_asset_id),

  'totals', (
    select jsonb_build_object(
      'sent',         count(*),
      'delivered',    count(*) filter (where l.delivered),
      'bounced',      count(*) filter (where l.bounced),
      'soft_failed',  count(*) filter (where l.soft_failed and not l.delivered and not l.bounced),
      'no_outcome',   count(*) filter (where not l.delivered and not l.bounced),
      'complained',   count(*) filter (where l.complained),
      'unsubscribed', count(*) filter (where l.unsubscribed),
      'opened',       count(*) filter (where l.opened),
      'clicked',      count(*) filter (where l.clicked)
    )
    from lignes l
  ),

  'daily', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'day',        to_char(d.jour at time zone 'utc', 'YYYY-MM-DD'),
      'sent',       coalesce(x.sent, 0),
      'delivered',  coalesce(x.delivered, 0),
      'bounced',    coalesce(x.bounced, 0),
      'complained', coalesce(x.complained, 0)
    ) order by d.jour), '[]'::jsonb)
    from generate_series(b.depuis, b.depuis + make_interval(days => b.jours - 1), interval '1 day') d(jour)
    left join lateral (
      select
        count(*)                              as sent,
        count(*) filter (where l.delivered)   as delivered,
        count(*) filter (where l.bounced)     as bounced,
        count(*) filter (where l.complained)  as complained
      from lignes l
      where l.sent_at >= d.jour and l.sent_at < d.jour + interval '1 day'
    ) x on true
  ),

  'by_send', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'campaign_id',  g.campaign_id,
      'kind',         g.kind,
      'name',         g.name,
      'sent',         g.sent,
      'delivered',    g.delivered,
      'bounced',      g.bounced,
      'complained',   g.complained,
      'unsubscribed', g.unsubscribed,
      'last_sent_at', g.last_sent_at
    ) order by g.sent desc, g.last_sent_at desc), '[]'::jsonb)
    from (
      select
        l.campaign_id,
        case when l.campaign_id is null then l.kind else 'campaign' end as kind,
        max(c.name)                               as name,
        count(*)                                  as sent,
        count(*) filter (where l.delivered)       as delivered,
        count(*) filter (where l.bounced)         as bounced,
        count(*) filter (where l.complained)      as complained,
        count(*) filter (where l.unsubscribed)    as unsubscribed,
        max(l.sent_at)                            as last_sent_at
      from lignes l
      left join newsletter.campaign c on c.id = l.campaign_id
      group by l.campaign_id, case when l.campaign_id is null then l.kind else 'campaign' end
    ) g
  ),

  -- File d'attente À L'INSTANT (pas de fenêtre) : une file qui grossit est le premier symptôme d'un
  -- worker arrêté, et c'est précisément ce qu'aucun autre chiffre de cet écran ne montre.
  'queue', (
    select jsonb_build_object(
      'pending',        count(*) filter (where o.status = 'pending'),
      'sending',        count(*) filter (where o.status = 'sending'),
      'oldest_pending', min(o.created_at) filter (where o.status = 'pending')
    )
    from newsletter.email_outbox o
    where o.asset_id = p_asset_id and o.status in ('pending', 'sending')
  ),

  'not_sent', (
    select coalesce(jsonb_agg(jsonb_build_object('status', r.status, 'reason', r.reason, 'count', r.n)
                              order by r.n desc, r.status, r.reason), '[]'::jsonb)
    from (
      select
        o.status,
        case when split_part(coalesce(o.error, ''), ':', 1) ~ '^[a-z0-9_]{1,40}$'
             then split_part(o.error, ':', 1) else 'other' end as reason,
        count(*) as n
      from newsletter.email_outbox o
      where o.asset_id = p_asset_id
        and o.status in ('failed', 'skipped')
        and o.created_at >= b.depuis
      group by 1, 2
    ) r
  ),

  'suppressions', (
    select coalesce(jsonb_agg(jsonb_build_object('reason', s.reason, 'count', s.n) order by s.n desc, s.reason), '[]'::jsonb)
    from (
      select
        case when sp.reason like 'hard_bounce%' then 'hard_bounce'
             when split_part(coalesce(sp.reason, ''), ':', 1) ~ '^[a-z0-9_]{1,40}$' then split_part(sp.reason, ':', 1)
             else 'other' end as reason,
        count(*) as n
      from newsletter.suppression sp
      where sp.asset_id = p_asset_id and sp.created_at >= b.depuis
      group by 1
    ) s
  ),
  -- Les suppressions GLOBALES (plaintes) n'ont pas de marque : on les rend à part, toutes marques.
  'global_suppressions', (
    select count(*) from newsletter.suppression sp where sp.scope = 'global' and sp.created_at >= b.depuis
  ),
  -- Événements sans envoi rattaché : ni marque ni cohorte. Toutes marques, et c'est dit à l'écran.
  'unlinked_events', (
    select count(*) from newsletter.email_event ev where ev.outbox_id is null and ev.occurred_at >= b.depuis
  )
)
from bornes b;
$$;

revoke all on function newsletter.deliverability_summary(uuid, integer) from public, anon, authenticated;
grant execute on function newsletter.deliverability_summary(uuid, integer) to service_role;

comment on function newsletter.deliverability_summary(uuid, integer) is
  'Chiffres réels de délivrabilité d''une marque : cohorte des envois partis dans la fenêtre (jours UTC, 1..365) et leurs événements fournisseur, un booléen par issue. Aucune adresse rendue. service_role uniquement.';

notify pgrst, 'reload schema';

insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0069', '0069_deliverability_summary.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
