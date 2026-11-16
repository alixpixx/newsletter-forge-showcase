-- ---------------------------------------------------------------------------
-- 0031 — Atlas Review : le domaine d'envoi appartenait à quelqu'un d'autre.
-- ---------------------------------------------------------------------------
--
-- SUITE DE 0029 ET 0030, et la vraie racine du défaut. En corrigeant le lien de politique de
-- confidentialité (0030), j'ai cherché s'il restait un `atlas-review-shop.example` ailleurs dans le schéma.
-- Un seul, mais le plus lourd : `asset.sending_subdomain = 'news.atlas-review-shop.example'`.
--
-- ⛔ CE QUE ÇA CASSAIT. Le domaine réel est `atlas-review.example`. `atlas-review-shop.example` appartient à
-- **un site tiers**, une boutique de vêtements de sport américaine. Deux conséquences, l'une
-- bloquante et l'autre grave :
--   · on ne peut pas poser SPF/DKIM/DMARC sur le DNS d'un domaine qu'on ne contrôle pas — le
--     bloquant « DKIM » de la mise en service était donc IMPOSSIBLE à lever pour cette marque, et
--     rien n'expliquait pourquoi ;
--   · envoyer depuis le sous-domaine d'un tiers, c'est usurper son domaine. Les messages seraient
--     rejetés ou classés en spam, et le tiers en subirait la réputation.
--
-- Rien n'est jamais parti : le worker est en `dry-run`. Le défaut était armé, pas déclenché.
--
-- POURQUOI CETTE VALEUR-LÀ. Les huit autres marques suivent `news.<domaine réel>`
-- (`news.northwind-sports.example`, `news.copper-kettle.example`, `news.harbor-tech.example`…). Atlas Review était la
-- seule fausse, parce que son domaine ne se déduit pas de son nom. On garde le motif du parc :
-- `news.atlas-review.example`.
--
-- LES DEUX AUTRES CHAMPS. `market` restait à `INT` et `languages` commençait par `it`, alors que
-- l'édition primaire est désormais BR (0029). `languages[0]` n'est pas décoratif : c'est la langue
-- par défaut de tout nouveau template, de l'import et du générateur IA. Le laisser en italien
-- aurait recréé le défaut à chaque création, en aval de la correction.
-- ---------------------------------------------------------------------------

update newsletter.asset
   set sending_subdomain = 'news.atlas-review.example'
 where slug = 'atlas-review'
   -- Idempotence et non-écrasement : seule la valeur fautive est visée.
   and sending_subdomain = 'news.atlas-review-shop.example';

update newsletter.asset
   set market    = 'BR',
       languages = array['pt-BR', 'en', 'fr', 'es', 'it']
 where slug = 'atlas-review'
   and market = 'INT';

-- Une édition peut porter son propre sous-domaine (il prime sur celui de la marque). Aucune n'est
-- concernée aujourd'hui pour Atlas Review, mais la garde est écrite pour que la migration reste
-- juste si une édition en pose un plus tard.
update newsletter.asset_edition e
   set sending_subdomain = 'news.atlas-review.example'
  from newsletter.asset a
 where a.id = e.asset_id
   and a.slug = 'atlas-review'
   and e.sending_subdomain = 'news.atlas-review-shop.example';
