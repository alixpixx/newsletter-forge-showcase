-- ---------------------------------------------------------------------------
-- 0039 — Deux domaines de plus qui n'appartenaient pas à Example Media.
-- ---------------------------------------------------------------------------
--
-- MÊME DÉFAUT QUE 0031, DEUX MARQUES DE PLUS. Le seed a dérivé le domaine du NOM de la marque.
-- Pour Atlas Review, ça donnait une boutique tierce ; ici, ça donne deux domaines PARQUÉS.
-- Constaté le 25/08 en sondant les sites un par un, pas en relisant le seed :
--
--   goalpost-weekly-parked.example  → page de 114 octets qui redirige en JS vers /lander, laquelle répond
--                           403. Le site réel est **goalpost-weekly.example** : son API REST
--                           WordPress répond (article du jour lu, id 1327740) et son flux RSS
--                           porte 11 entrées.
--   quartz-tips-parked.example        → exactement la même page de parking. Le site réel est
--                           **quartz-tips.example**, une landing d'une seule page vers Telegram :
--                           ni API REST, ni flux RSS, et ses liens « Privacidade » / « Termos »
--                           pointent vers `#`.
--
-- ⛔ CE QUE ÇA DÉBLOQUAIT SANS QU'ON LE SACHE. `sending_subdomain` valait `news.goalpost-weekly-parked.example`
-- et `news.quartz-tips-parked.example` : on ne peut pas poser SPF/DKIM/DMARC sur le DNS d'un domaine qu'on ne
-- contrôle pas — le bloquant « DKIM » de la mise en service était donc IMPOSSIBLE à lever pour ces
-- deux marques, sans que rien n'explique pourquoi. Et envoyer depuis le sous-domaine d'un tiers,
-- c'est usurper son domaine. Rien n'est jamais parti : le worker est en dry-run. Le défaut était
-- armé, pas déclenché. ⚠️ Quartz Tips est la marque PILOTE.
--
-- ⛔ ET LE LIEN LÉGAL DU FOOTER pointait vers ces mêmes domaines parqués. 0030 avait corrigé six
-- marques et laissé celles-ci « fausses et visibles » faute de page connue : la page existe, elle
-- était simplement sur un autre domaine. Relevée dans le footer du site réel et ouverte pour
-- vérifier son titre — « Cookies & Privacy Policies » — jamais devinée.
--
-- ⚠️ QUARTZ TIPS RESTE SANS PAGE DE CONFIDENTIALITÉ. Son lien n'est donc PAS remplacé : mettre un
-- lien faux à la place d'un autre lien faux rendrait le défaut invisible. Il reste à créer la page
-- (geste éditorial, côté Alix) — c'est un bloquant d'envoi pour cette marque, et il doit se voir.

update newsletter.asset
   set sending_subdomain = 'news.goalpost-weekly.example'
 where slug = 'goalpost-weekly'
   and sending_subdomain = 'news.goalpost-weekly-parked.example';

update newsletter.asset
   set sending_subdomain = 'news.quartz-tips.example'
 where slug = 'quartz-tips'
   and sending_subdomain = 'news.quartz-tips-parked.example';

-- Le footer légal : seule Goalpost Weekly a une page réelle à pointer.
update newsletter.asset_edition e
   set legal_footer = jsonb_set(
         coalesce(e.legal_footer, '{}'::jsonb),
         '{privacy_url}',
         to_jsonb('https://goalpost-weekly.example/cookie-and-privacy-policies/'::text),
         true)
  from newsletter.asset a
 where a.id = e.asset_id
   and a.slug = 'goalpost-weekly'
   and coalesce(e.legal_footer->>'privacy_url', '') = 'https://goalpost-weekly-parked.example/privacy';

notify pgrst, 'reload schema';
