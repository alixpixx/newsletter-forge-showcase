-- ---------------------------------------------------------------------------
-- 0036 — `outbox_context` apprend l'existence des occurrences.
-- ---------------------------------------------------------------------------
--
-- ⛔ LE PIÈGE FATAL DE LA RÉCURRENCE, ET LE SEUL ENDROIT OÙ IL SE REFERME. Le worker ne lit pas
-- `email_outbox` : il lit la VUE `outbox_context`, qui rassemble le destinataire, l'édition, le
-- footer légal et le HTML à hydrater. Or cette vue, telle que 0019 l'a laissée, ne connaît que
-- deux porteurs de contenu : `template_version` et `campaign`. Elle ignore `campaign_occurrence`.
--
-- Conséquence, si le fan-out était écrit sans cette migration : une série hebdomadaire gèle chaque
-- semaine un contenu NEUF dans son occurrence (`campaign_occurrence.html_shell`, avec les articles
-- WordPress de la semaine), mais la vue continuerait de servir `campaign.html_shell` — le contenu
-- du MODÈLE, figé au premier verrou. Les huit envois d'une série de huit semaines porteraient les
-- articles de la semaine 1. Rien ne planterait : l'e-mail est valide, il est simplement PÉRIMÉ.
-- C'est le défaut le plus coûteux du chantier récurrence, et il ne se voit qu'à la réception.
--
-- POURQUOI DES COLONNES APPENDUES ET PAS UN `coalesce` DANS LES COLONNES EXISTANTES.
-- `create or replace view` interdit de changer le type ou l'ordre des colonnes déjà rendues, mais
-- surtout : écraser `campaign_html_shell` par un coalesce rendrait les deux sources
-- indiscernables. Une ligne servie avec le mauvais shell ne pourrait plus être diagnostiquée après
-- coup — on ne saurait pas si l'occurrence était vide ou si la préférence a mal joué. Les deux
-- valeurs restent donc visibles côte à côte, et c'est le RENDU qui choisit, explicitement.
--
-- ⚠️ CETTE MIGRATION NE CHANGE LE COMPORTEMENT D'AUCUN ENVOI EXISTANT : `occurrence_id` est nul
-- sur les 4 lignes en file (2 confirmations, 2 welcome) comme sur toute ligne hors série, et une
-- jointure LEFT sur un identifiant nul rend NULL. Elle ajoute de la matière, elle n'en retire pas.
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
  o.campaign_id,
  o.template_version_id,
  tv.html_shell as template_html_shell,
  tv.text_shell as template_text_shell,
  c.html_shell  as campaign_html_shell,
  c.text_shell  as campaign_text_shell,
  -- Appendues par 0036. L'occurrence est le porteur de contenu d'une série : c'est elle qui a été
  -- gelée avec les articles du jour, et c'est elle qui doit être servie.
  o.occurrence_id,
  occ.html_shell as occurrence_html_shell,
  occ.text_shell as occurrence_text_shell,
  occ.status     as occurrence_status
from newsletter.email_outbox o
left join newsletter.asset a         on a.id = o.asset_id
left join newsletter.subscription s  on s.id = o.subscription_id
left join newsletter.template_version tv on tv.id = o.template_version_id
left join newsletter.campaign c      on c.id = o.campaign_id
left join newsletter.campaign_occurrence occ on occ.id = o.occurrence_id
left join lateral (
  select ed.*
    from newsletter.asset_edition ed
   where ed.asset_id = o.asset_id
   order by (ed.id = s.edition_id) desc nulls last, ed.id
   limit 1
) e on true;

grant select on newsletter.outbox_context to service_role;

notify pgrst, 'reload schema';
