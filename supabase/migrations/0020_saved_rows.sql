-- Blocs réutilisables — une « ligne enregistrée » est une Row du schéma EmailDoc que l'éditeur
-- veut rejouer d'un modèle à l'autre (en-tête de marque, pied de page éditorial, bandeau promo).
--
-- Deux invariants portés par la table :
--  1. UNE ligne appartient à UNE marque. `asset_id` n'est pas nullable et cascade avec l'asset :
--     une bibliothèque partagée entre marques mélangerait des identités visuelles distinctes.
--  2. On n'efface pas, on archive. Une ligne a pu servir dans des éditions déjà envoyées ; la
--     retirer de la bibliothèque ne doit pas effacer la trace de ce qui a existé (même doctrine
--     que `newsletter.template.archived_at`, migration 0017).
--
-- `row` porte une Row VALIDÉE à l'écriture par le schéma `Row` de @nf/render. Stocker une forme
-- non conforme ferait échouer, bien plus tard et loin de la cause, le document qui l'insère.

create table if not exists newsletter.saved_row (
  id          uuid primary key default gen_random_uuid(),
  asset_id    uuid not null references newsletter.asset(id) on delete cascade,
  name        text not null,
  category    text,
  -- « row » est un col_name_keyword Postgres : utilisable comme nom de colonne, mais on le cite
  -- partout pour qu'aucune relecture n'ait à se poser la question.
  "row"       jsonb not null,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  -- Unicité NON filtrée, alignée sur `unique (asset_id, slug)` de `newsletter.template` :
  -- une ligne archivée garde son nom réservé. Conséquence assumée — la route répond 409 avec
  -- un message explicite plutôt que de renommer dans le dos de l'utilisateur.
  unique (asset_id, name)
);

-- Le seul accès de lecture est « la bibliothèque de la marque courante », archivés exclus.
create index if not exists idx_saved_row_asset
  on newsletter.saved_row (asset_id) where archived_at is null;

alter table newsletter.saved_row enable row level security;
grant all on newsletter.saved_row to service_role;

notify pgrst, 'reload schema';
