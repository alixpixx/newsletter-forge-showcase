-- ---------------------------------------------------------------------------
-- 0050 — les shortcodes de sujet atteignent le rendu (nom de campagne, article
--        phare, nombre d'articles, date d'une campagne SANS série).
-- ---------------------------------------------------------------------------
--
-- CE QUI EXISTE DÉJÀ ET NE BOUGE PAS. `{{edition_number}}` (= `occurrence.seq`, compteur PAR
-- CAMPAGNE) et `{{edition_date}}` (= `occurrence.local_date`) sont servis par 0048. Cette
-- migration ne les redéfinit pas, elle comble ce qu'ils NE couvrent pas.
--
-- ⛔ LE TROU MESURÉ : une campagne PONCTUELLE n'a pas d'occurrence. `occurrence_seq` et
-- `occurrence_local_date` rendent alors NULL, et un auteur qui écrit « Édition du
-- {{edition_date}} » sur une campagne ponctuelle voit partir « Édition du  » — repli vide, aucune
-- erreur, aucune trace. La campagne, elle, PORTE sa date (`scheduled_at`) et son fuseau
-- (`timezone`) : il n'y a aucune raison de ne pas la servir.
--
-- ⛔ `at time zone` N'EST PAS COSMÉTIQUE. Un envoi programmé le 8 à 02:00 heure de São Paulo est
-- daté du 8 en local et du **7** en UTC. Lire `scheduled_at::date` daterait donc l'édition de la
-- veille pour toute campagne programmée en fin de nuit — silencieusement, et seulement pour
-- certains fuseaux. `coalesce(timezone,'UTC')` parce que la colonne est nullable.
--
-- POURQUOI DEUX COLONNES DÉNORMALISÉES SUR L'OCCURRENCE plutôt qu'une sous-requête sur
-- `feed_article_sent` : la vue est lue UNE FOIS PAR DESTINATAIRE (1 200 lignes pour une édition
-- Quartz Tips). Une sous-requête corrélée y coûterait 1 200 agrégations pour une valeur identique
-- partout. Le gel connaît déjà le document expédié : il écrit, le rendu lit.
--
-- ⚠️ COLONNES APPENDUES (règle de 0036 et 0048) : `create or replace view` interdit de changer le
-- type ou l'ordre des colonnes déjà rendues. Aucune ligne n'est modifiée, aucun envoi en file ne
-- change de contenu.

alter table newsletter.campaign_occurrence
  add column if not exists first_article_title text,
  add column if not exists article_count integer;

comment on column newsletter.campaign_occurrence.first_article_title is
  'Titre de l''article de tête du document RÉELLEMENT expédié (après dépliage des flux), écrit au gel. Sert {{first_article}}.';
comment on column newsletter.campaign_occurrence.article_count is
  'Nombre d''articles du document réellement expédié, écrit au gel. Sert {{article_count}}.';

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
  occ.article_count       as occurrence_article_count
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
