-- ---------------------------------------------------------------------------
-- 0030 — Les liens « politique de confidentialité » des footers légaux pointaient
--        tous à côté. Six sur neuf sont réparables ; trois n'ont aucune page.
-- ---------------------------------------------------------------------------
--
-- CE QU'ON CHERCHAIT. En corrigeant l'édition Atlas Review (0029), j'ai vu que son footer légal
-- pointait vers `atlas-review-shop.example/privacy` alors que le site est `atlas-review.example`. J'ai d'abord
-- cru à un lien mort. La sonde a répondu **200** — donc « pas de problème ».
--
-- ⛔ LE 200 ÉTAIT LE PIÈGE. `atlas-review-shop.example` n'appartient pas à Example Media : c'est **un site tiers**,
-- une boutique de vêtements de sport. Un abonné qui cliquait « politique de confidentialité » dans
-- un e-mail atterrissait chez un tiers sans aucun rapport. Un lien mort se voit ; un lien vivant
-- vers le mauvais responsable de traitement ne se voit pas, et c'est le pire des deux.
--
-- LA CLASSE, PAS L'INSTANCE. Le seed avait appliqué mécaniquement le motif `<domaine>/privacy` aux
-- NEUF éditions. Sondées une par une (25/08/2026), aucune n'était valide :
--
--   marque             état de `<domaine>/privacy`      page réelle trouvée
--   bluefin-news                 404                              /politica-de-privacidade          ✔
--   northwind-sports             404                              www + /politica-de-privacidade/   ✔
--   pixel-daily      404                              /privacidade                      ✔
--   copper-kettle       404                              /politica-de-privacidad           ✔
--   atlas-review       200 — chez un tiers           .news + /politica-de-privacidade  ✔
--   harbor-tech          404                              www + /cookies-privacy-policies/  ✔
--   goalpost-weekly  200 sans titre exploitable       AUCUNE                            ✘
--   lumen-living           404                              AUCUNE                            ✘
--   quartz-tips         200 sans titre exploitable       AUCUNE                            ✘
--
-- Chaque page retenue a été ouverte et son `<title>` vérifié comme appartenant bien à la marque
-- (« Política de privacidade » chez Atlas Review, « Cookies & Privacy Policies - Harbor Tech », etc.).
-- Aucune URL n'est devinée : celles de northwind-sports et harbor-tech ont été relevées dans le footer du site
-- lui-même, pas fabriquées par motif.
--
-- POURQUOI CE N'EST PAS COSMÉTIQUE. Ce lien est une obligation d'information (LGPD art. 9, RGPD
-- art. 13) et il vit dans le pied de page de CHAQUE e-mail. Tant qu'il pointe à côté, tout envoi
-- part avec une mention légale fausse. C'est un bloquant de mise en service au même titre que
-- DNS/DKIM — à cette différence près qu'il ne fait échouer aucun test.
--
-- ⛔ TROIS MARQUES RESTENT EN DÉFAUT et rien ici ne peut les réparer : goalpost-weekly, lumen-living
-- et quartz-tips n'exposent aucune page de confidentialité, ni par URL devinée, ni dans leur home.
-- Inventer une URL serait remplacer un lien faux par un lien faux. Il faut créer les pages —
-- décision et travail éditorial d'Alix. Leur `privacy_url` est laissé TEL QUEL, visible et faux,
-- plutôt que masqué.
-- ---------------------------------------------------------------------------

update newsletter.asset_edition e
   set legal_footer = jsonb_set(e.legal_footer, '{privacy_url}', to_jsonb(v.url))
  from newsletter.asset a,
       (values
          ('bluefin-news',            'https://bluefin-news.example/politica-de-privacidade'),
          ('northwind-sports',        'https://www.northwind-sports.example/politica-de-privacidade/'),
          ('pixel-daily', 'https://pixel-daily.example/privacidade'),
          ('copper-kettle',  'https://copper-kettle.example/politica-de-privacidad'),
          ('atlas-review',  'https://atlas-review.example/politica-de-privacidade'),
          ('harbor-tech',     'https://www.harbor-tech.example/cookies-privacy-policies/')
       ) as v(marque, url)
 where a.id = e.asset_id
   and a.slug = v.marque
   -- Idempotence, et surtout NON-ÉCRASEMENT : si quelqu'un a corrigé l'URL à la main entre-temps,
   -- on ne repasse pas dessus. Seule la valeur fautive posée par le seed est visée.
   and e.legal_footer->>'privacy_url' like '%/privacy';
