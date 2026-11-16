-- Recréation des vues pour exposer les nouvelles colonnes (une vue fige sa liste de colonnes).
-- ⚠️ create or replace view exige de CONSERVER l'ordre existant et d'AJOUTER les nouvelles À LA FIN.
create or replace view newsletter.sendable_subscription as
select s.*
from newsletter.subscription s
join newsletter.subscriber sub on sub.id = s.subscriber_id
where s.status = 'active'
  and not newsletter.is_suppressed(sub.email::text, s.asset_id);

create or replace view newsletter.outbox_context as
select
  o.id, o.kind, o.subject, o.action_url, o.payload, o.to_email,
  o.status, o.attempts, o.max_attempts, o.next_attempt_at, o.created_at,
  o.asset_id, o.subscription_id,
  a.name  as asset_name,
  a.slug  as asset_slug,
  coalesce(e.sending_subdomain, a.sending_subdomain) as sending_subdomain,
  e.compliance_regime,
  e.legal_footer,
  e.language,
  s.status        as sub_status,
  s.subscriber_id as subscriber_id,
  s.tracking_consent,
  newsletter.is_suppressed(o.to_email::text, o.asset_id) as suppressed,
  -- nouvelles colonnes (appendues) :
  o.purpose,
  e.market,
  e.consent_mode,
  s.granted_purposes
from newsletter.email_outbox o
left join newsletter.asset a         on a.id = o.asset_id
left join newsletter.subscription s  on s.id = o.subscription_id
left join lateral (
  select ed.*
    from newsletter.asset_edition ed
   where ed.asset_id = o.asset_id
   order by (ed.id = s.edition_id) desc nulls last, ed.id
   limit 1
) e on true;

grant select on newsletter.outbox_context to service_role;

notify pgrst, 'reload schema';
