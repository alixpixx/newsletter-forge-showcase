-- ---------------------------------------------------------------------------
-- 0048 — le numéro d'édition et la date d'envoi atteignent enfin le rendu.
-- ---------------------------------------------------------------------------
--
-- ⛔ QUATRE VARIABLES ÉTAIENT OFFERTES À L'AUTEUR ET N'IMPRIMAIENT RIEN. Le registre
-- (`packages/render/src/hydrate/index.ts`) déclare `edition_date` depuis l'origine, et le menu
-- d'insertion du builder la propose. Mais `mergeVars()` la lit dans le PAYLOAD de la file, et le
-- seul écrivain de ce payload (`0038_enqueue_campaign_batch`) n'y met que le prénom. Le jeton
-- retombait donc systématiquement sur son repli — une chaîne vide. Un auteur pouvait écrire
-- « Edição de {{edition_date}} » dans son sujet, voir « Edição de  » partir chez 1 200 abonnés, et
-- rien dans le code n'aurait signalé quoi que ce soit : un repli vide ne lève aucune erreur.
--
-- POURQUOI PAR LA VUE ET PAS PAR LE PAYLOAD. Le payload est écrit UNE FOIS par destinataire, au
-- moment du fan-out : y copier le numéro d'édition le figerait en autant d'exemplaires qu'il y a
-- d'abonnés, et une correction d'occurrence ne les rattraperait jamais. La vue, elle, lit
-- l'occurrence à chaque rendu — la valeur servie est toujours celle qui est en base.
--
-- POURQUOI `seq` ET PAS UN NOUVEAU COMPTEUR. `campaign_occurrence.seq` EXISTE depuis 0027, il est
-- unique par campagne (`occurrence_campaign_seq_uk`), il n'est jamais réutilisé — même quand une
-- occurrence est annulée — et l'admin l'affiche déjà « #7 ». Décision d'Alix du 03/09/2026 : le
-- compteur reste PAR CAMPAGNE. Deux campagnes servies par un même modèle ont donc chacune leur
-- propre numérotation, ce qui est voulu : ce sont deux séries distinctes pour le lecteur.
--
-- ⚠️ COLONNES APPENDUES, comme en 0036 : `create or replace view` interdit de changer le type ou
-- l'ordre des colonnes déjà rendues.
--
-- ⚠️ `local_date` est NULLABLE et `occurrence_id` l'est aussi (tout envoi hors série : welcome,
-- confirmation, campagne ponctuelle jamais matérialisée). Les deux colonnes rendent alors NULL, et
-- c'est le rendu qui décide quoi en faire — il ne fabrique pas un numéro pour un envoi qui n'en a
-- pas. Cette migration N'AJOUTE AUCUNE LIGNE, ne modifie aucune donnée, et ne change le contenu
-- d'aucun envoi déjà en file : elle ne fait qu'exposer deux colonnes de plus.
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
  occ.status     as occurrence_status,
  -- Appendues par 0048. Le numéro lisible de l'édition et le jour LOCAL de son envoi :
  -- les deux seules données dont le rendu a besoin pour `{{edition_number}}` et
  -- `{{edition_date}}`. Le formatage (langue, style long) se fait au rendu, pas ici — le SQL
  -- ne connaît pas la locale de la marque.
  occ.seq        as occurrence_seq,
  occ.local_date as occurrence_local_date
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
