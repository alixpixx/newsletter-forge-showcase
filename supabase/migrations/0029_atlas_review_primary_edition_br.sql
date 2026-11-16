-- ---------------------------------------------------------------------------
-- 0029 — Atlas Review : l'édition primaire est BRÉSILIENNE, pas italienne.
-- ---------------------------------------------------------------------------
--
-- ARBITRAGE D'ALIX (21/08/2026), mot pour mot : « pour atlas-review l'edition primaire est BR
-- pas IT ». C'est la réponse à la question laissée ouverte en tête de `0026`, qui posait
-- `is_primary` sans oser trancher le contenu de la ligne.
--
-- CE QUI S'EST PASSÉ. Le seed a construit cette édition en prenant le PREMIER élément de
-- `languages: ["it","fr","pt-BR","es","en"]` dans le registre `@nf/config`. Personne n'a choisi
-- l'italien : c'est l'ordre d'un tableau qui a décidé. Or la racine du site publie en portugais —
-- mesuré par la sonde WordPress le 20/08 : catégories « Palpites de hoje », « Notícias »,
-- « Brasileirão ».
--
-- POURQUOI CE N'EST PAS COSMÉTIQUE. `market` ne décrit pas un pays sur une fiche : il choisit le
-- RÉGIME appliqué à de vraies personnes. En INT/gdpr, un inscrit de atlas-review.example recevait le
-- texte de consentement européen, la résidence de données `eu`, et une heure d'envoi calculée sur
-- Europe/Rome — soit cinq heures d'écart avec l'heure promise à l'écran. Six champs portent ce
-- défaut, pas un.
--
-- POURQUOI UNE MIGRATION ET PAS UN `UPDATE` À LA MAIN. La correction doit atteindre TOUS les
-- environnements. Réparée à la main sur une seule base, elle manquerait partout ailleurs, et le
-- prochain déploiement recréerait le défaut sans que rien ne le signale.
--
-- RISQUE MESURÉ AVANT D'ÉCRIRE (21/08/2026) : cette édition porte 1 souscription, en statut
-- `deleted` avec `consent_state = false`. Autrement dit **aucun abonné actif**, et aucun
-- consentement donné sous le régime italien. Le changement de régime ne réinterprète donc le
-- consentement de personne. La preuve historique reste de toute façon intacte : `consent_event`
-- est append-only et garde le texte et la version qui ont réellement été présentés.
-- ---------------------------------------------------------------------------

update newsletter.asset_edition e
   set market            = 'BR',
       language          = 'pt-BR',
       slug              = 'pt-br',
       timezone          = 'America/Sao_Paulo',
       compliance_regime = 'lgpd',
       data_residency    = 'br'
  from newsletter.asset a
 where a.id = e.asset_id
   and a.slug = 'atlas-review'
   -- Idempotence : la garde porte sur l'ÉTAT DE DÉPART, pas sur un `if not exists`. Rejouée, la
   -- migration ne trouve plus d'édition italienne et ne touche rien. Surtout, elle n'écrase pas
   -- une édition italienne qui aurait été RECRÉÉE volontairement plus tard, quand
   -- atlas-review.example/it/ existera pour de bon : seule la ligne encore marquée INT/it est visée.
   and e.market = 'INT'
   and e.language = 'it';

-- ---------------------------------------------------------------------------
-- RESTE À TRANCHER — non appliqué ici, volontairement.
-- ---------------------------------------------------------------------------
-- Le footer légal de cette édition pointe vers `https://atlas-review-shop.example/privacy`, alors que le
-- site est `atlas-review.example`. C'est un lien mort dans un pied de page LÉGAL — l'endroit où une
-- autorité de contrôle regarde en premier. Je ne le corrige pas d'office : je ne sais pas si la
-- page existe à l'adresse `.news`, et publier une URL de politique de confidentialité qui répond
-- 404 est pire que de laisser le défaut visible. À faire dire par Alix, puis :
--
--   update newsletter.asset_edition e
--      set legal_footer = jsonb_set(e.legal_footer, '{privacy_url}',
--                                   '"https://atlas-review.example/privacy"'::jsonb)
--     from newsletter.asset a
--    where a.id = e.asset_id and a.slug = 'atlas-review';
