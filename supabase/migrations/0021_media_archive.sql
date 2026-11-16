-- Médiathèque : archiver plutôt que détruire.
--
-- POURQUOI. Retirer une image de la bibliothèque supprimait sa LIGNE tout en laissant l'objet dans
-- le bucket. C'était le pire des deux mondes :
--   1. l'objet devenait un orphelin que plus rien ne référençait, donc impossible à nettoyer plus
--      tard sans deviner ;
--   2. l'empreinte de déduplication `sha256` partait avec la ligne — réuploader le même fichier
--      recréait un doublon pointant vers un SECOND objet identique.
--
-- Et surtout : on ne peut pas simplement supprimer l'objet à la place. Une image citée par une
-- version publiée vit dans un `html_shell` FIGÉ, déjà parti chez les abonnés. Leur client de
-- messagerie va la chercher à l'ouverture — détruire l'objet casse des e-mails déjà distribués.
--
-- On archive donc : la ligne reste (empreinte préservée), l'objet reste (les e-mails partis
-- continuent de s'afficher), et la bibliothèque cesse de la proposer. Même doctrine que
-- `template.archived_at`.

alter table newsletter.media_asset
  add column if not exists archived_at timestamptz;

-- La liste ne montre que le vivant ; l'index suit ce filtre.
create index if not exists idx_media_asset_live
  on newsletter.media_asset (asset_id, created_at desc)
  where archived_at is null;

comment on column newsletter.media_asset.archived_at is
  'Retirée de la bibliothèque. La ligne et l''objet Storage sont CONSERVÉS : une image citée par une version publiée est déjà partie chez les abonnés, et leur client la charge à l''ouverture.';
