-- La segmentation cible le pays (prédicat `country`) : colonne manquante au schéma initial.
alter table newsletter.subscription add column if not exists country text;
create index if not exists idx_sub_asset_country on newsletter.subscription (asset_id, country);
create index if not exists idx_sub_asset_source on newsletter.subscription (asset_id, source);
