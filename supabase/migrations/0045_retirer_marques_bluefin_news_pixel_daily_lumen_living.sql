-- ============================================================================
-- 0045 — Retirer trois marques du système : Bluefin News, Pixel Daily, Lumen Living
--
-- Décision d'Alix, 01/09/2026. Ces trois marques ne font plus partie du parc.
--
-- ⚠️ MESURÉ AVANT D'ÉCRIRE CE FICHIER. Aucune donnée vivante n'y est attachée :
--
--   marque          abonnements  campagnes  templates  segments  médias  file d'envoi
--   bluefin-news                        0          0          0         0       0             0
--   lumen-living                  0          0          1*        0       0             0
--   pixel-daily             0          0          0         0       0             0
--
--   * « Weekly Newsletter Copper Kettle », DÉJÀ ARCHIVÉ, 0 version publiée, créé le
--     21/08 — un déchet de manipulation (un nom de Copper Kettle sur lumen-living).
--
--   Chacune porte en plus 1 source WordPress, 1 version de consentement,
--   1 édition et 1 octroi de marque (celui posé à l'amorçage du 31/08). Ce sont
--   des lignes de CONFIGURATION, pas des données d'abonnés.
--
-- La suppression suffit donc, et la cascade fait le reste : les 15 tables qui
-- référencent `asset(id)` sont en `on delete cascade`, sauf `email_event` et
-- `email_outbox` qui sont en `set null` — et toutes deux sont vides pour ces
-- marques, donc aucune ligne orpheline n'est créée.
--
-- ⛔ CE FICHIER NE MODIFIE PAS 0002_seed_assets.sql NI 0012 / 0026 / 0030, qui
--    nomment ces marques. Une migration déjà appliquée est un fait historique :
--    la réécrire rendrait l'historique faux et ne changerait rien à la base.
--    C'est ici, en avant, que l'état se corrige.
--
-- ⚠️ `asset.slug` est du `citext`, pas un enum : il n'y a aucune valeur de type
--    à retirer en plus des lignes. (Vérifié : format_type = citext, typtype=b.)
--
-- ⚠️ Le registre applicatif `packages/config/src/assets.ts` est modifié dans le
--    même commit — il portait les trois slugs dans son type `AssetSlug` et dans
--    `ASSETS`. Sans cela, le repli hors-base (`fromConfig`) aurait continué de
--    les nommer, et le type aurait accepté des slugs qui ne désignent plus rien.
-- ============================================================================

delete from newsletter.asset
 where slug in ('bluefin-news', 'pixel-daily', 'lumen-living');

notify pgrst, 'reload schema';
