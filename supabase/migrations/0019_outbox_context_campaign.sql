-- ⛔ NE PAS REJOUER — déjà appliquée. Rejouée, elle ÉCHOUE : la vue `outbox_context` porte depuis
-- les colonnes appendues par 0036, 0048, 0050, 0055 et 0059, et `create or replace view` ne peut pas
-- les retirer. Voir supabase/README.md (« Jamais `supabase db push` »).
--
-- Expose au worker les références de campagne / version de template posées par la migration 0018.
-- ⚠️ `create or replace view` interdit de renommer ou réordonner : les nouvelles colonnes sont
-- APPENDUES en fin, l'ordre existant est conservé à l'identique.
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
  o.purpose,
  e.market,
  e.consent_mode,
  s.granted_purposes,
  -- nouvelles colonnes (appendues) :
  o.campaign_id,
  o.template_version_id,
  -- le HTML est figé à la publication : le worker le lit une fois et le met en cache,
  -- il n'est JAMAIS dupliqué par destinataire dans email_outbox.
  tv.html_shell as template_html_shell,
  tv.text_shell as template_text_shell,
  c.html_shell  as campaign_html_shell,
  c.text_shell  as campaign_text_shell
from newsletter.email_outbox o
left join newsletter.asset a         on a.id = o.asset_id
left join newsletter.subscription s  on s.id = o.subscription_id
left join newsletter.template_version tv on tv.id = o.template_version_id
left join newsletter.campaign c          on c.id = o.campaign_id
left join lateral (
  select ed.*
    from newsletter.asset_edition ed
   where ed.asset_id = o.asset_id
   order by (ed.id = s.edition_id) desc nulls last, ed.id
   limit 1
) e on true;

grant select on newsletter.outbox_context to service_role;

notify pgrst, 'reload schema';
