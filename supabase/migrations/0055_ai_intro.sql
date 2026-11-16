-- ---------------------------------------------------------------------------
-- 0055 — l'accroche et l'introduction écrites par le modèle atteignent la boîte.
-- ---------------------------------------------------------------------------
--
-- Demande d'Alix (08/09/2026) : au moment de l'envoi, récupérer les titres des articles qui
-- composent l'édition et en tirer un résumé de 3-4 lignes qui sert d'introduction, plus une
-- accroche courte pour le preheader.
--
-- ⛔ POURQUOI DES COLONNES ET PAS UNE SUBSTITUTION DANS LE HTML. Le texte se génère UNE FOIS au
-- gel, pour toute l'édition (décision d'Alix : « c'est le même pour tous nos destinataires »).
-- L'écrire dans le shell le figerait ; l'écrire ici le laisse corrigeable jusqu'au drain, exactement
-- comme `first_article_title` (0050). Le rendu LIT, il ne regénère jamais.
--
-- ⛔ POURQUOI RIEN NE DÉCLENCHE LA GÉNÉRATION SAUF LE JETON LUI-MÊME. `{{ai_intro}}` et
-- `{{ai_preheader}}` sont des jetons du registre : l'auteur les pose dans le modèle. Leur PRÉSENCE
-- est l'interrupteur — pas de jeton, pas d'appel, pas de dépense. Une colonne « activé oui/non »
-- aurait permis de payer un texte qui n'atteint personne, et une case à cocher aurait permis
-- l'inverse : un modèle qui porte le jeton et n'affiche rien.
--
-- ⛔ CONSÉQUENCE VOULUE SUR L'EMPREINTE ANTI-DOUBLON. Le HTML figé contient le JETON, pas le texte
-- généré. `content_sha256` reste donc déterministe : un texte non reproductible dans l'empreinte
-- aurait désarmé la garde S-5, qui aurait laissé partir huit fois le même contenu sans le voir.
--
-- ⚠️ COLONNES APPENDUES à `outbox_context` (règle de 0036, 0048 et 0050) : `create or replace view`
-- interdit de changer le type ou l'ordre des colonnes déjà rendues. Aucune ligne n'est modifiée,
-- aucun envoi en file ne change de contenu.

-- Les séries récurrentes : la valeur naît au gel de CHAQUE occurrence.
alter table newsletter.campaign_occurrence
  add column if not exists ai_intro text,
  add column if not exists ai_preheader text,
  add column if not exists ai_status text,
  add column if not exists ai_reason text,
  add column if not exists ai_model text,
  add column if not exists ai_generated_at timestamptz;

-- Les campagnes ponctuelles : la valeur naît au verrouillage, une seule fois. Mêmes colonnes, même
-- sens — sans quoi le rendu aurait deux chemins à connaître au lieu d'un repli.
alter table newsletter.campaign
  add column if not exists ai_intro text,
  add column if not exists ai_preheader text,
  add column if not exists ai_status text,
  add column if not exists ai_reason text,
  add column if not exists ai_model text,
  add column if not exists ai_generated_at timestamptz;

comment on column newsletter.campaign_occurrence.ai_intro is
  'Introduction de 3-4 phrases écrite au gel à partir des titres réellement expédiés. Sert {{ai_intro}}.';
comment on column newsletter.campaign_occurrence.ai_preheader is
  'Accroche courte (<= 140 car.) écrite au gel. Sert {{ai_preheader}}, à poser dans le preheader du modèle.';
comment on column newsletter.campaign_occurrence.ai_status is
  '''ok'' ou ''failed''. NULL = le modèle ne porte aucun jeton IA, aucun appel n''a eu lieu.';
comment on column newsletter.campaign_occurrence.ai_reason is
  'Motif d''échec (crédit épuisé, refus, timeout...). Sans lui, un ai_status=failed serait muet.';

comment on column newsletter.campaign.ai_intro is
  'Idem campaign_occurrence.ai_intro, pour une campagne ponctuelle : écrite au verrouillage.';
comment on column newsletter.campaign.ai_preheader is
  'Idem campaign_occurrence.ai_preheader, pour une campagne ponctuelle.';
comment on column newsletter.campaign.ai_status is
  '''ok'' ou ''failed''. NULL = aucun jeton IA dans le contenu verrouillé.';
comment on column newsletter.campaign.ai_reason is
  'Motif d''échec de la génération au verrouillage.';

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
  o.occurrence_id,
  occ.html_shell as occurrence_html_shell,
  occ.text_shell as occurrence_text_shell,
  occ.status     as occurrence_status,
  occ.seq        as occurrence_seq,
  occ.local_date as occurrence_local_date,
  -- Appendues par 0050.
  c.name as campaign_name,
  -- Le jour LOCAL voulu de la campagne, pour les envois sans occurrence. Le rendu s'en sert
  -- uniquement en repli : quand une occurrence existe, c'est SA date qui fait foi.
  (c.scheduled_at at time zone coalesce(c.timezone, 'UTC'))::date as campaign_local_date,
  occ.first_article_title as occurrence_first_article,
  occ.article_count       as occurrence_article_count,
  -- Appendues par 0055. Même ordre de priorité que le shell : l'occurrence d'abord, la campagne
  -- en repli — une ligne d'outbox porte l'une OU l'autre, jamais les deux valeurs à la fois.
  occ.ai_intro     as occurrence_ai_intro,
  occ.ai_preheader as occurrence_ai_preheader,
  c.ai_intro       as campaign_ai_intro,
  c.ai_preheader   as campaign_ai_preheader
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
