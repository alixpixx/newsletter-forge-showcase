-- Sources WordPress — d'où viennent les articles proposés dans le builder.
--
-- PORTÉE : l'ÉDITION, pas la marque. Décision d'Alix (20/08) : atlas-review.example/cl/ aura sa
-- propre liste d'abonnés et sa propre newsletter. Deux éditions d'une même marque ne tirent donc
-- pas des mêmes URLs, pas des mêmes catégories, et souvent pas de la même langue. Scoper à la
-- marque forcerait un filtre « langue » dans chaque requête et ferait fuiter, un jour, un article
-- brésilien dans l'édition chilienne.
--
-- `asset_id` est DÉNORMALISÉ pour que « les sources de la marque courante » (le contexte que
-- l'admin porte partout, cf. lib/asset-context.ts) se lise sans jointure. Une colonne dénormalisée
-- dérive dès qu'on la laisse libre : la clé étrangère COMPOSITE ci-dessous la contraint à toujours
-- valoir l'`asset_id` de son édition. C'est déclaratif, donc rien à maintenir.
--
-- ⛔ AUCUNE COLONNE DE SECRET. Décision d'Alix : le mot de passe applicatif WordPress vit en
-- variable d'environnement Vercel, jamais en base. La base porte l'identifiant (`auth_user`) et
-- l'intention (`auth_kind`) ; le secret est résolu à l'exécution. Motif : cette base est un projet
-- Supabase PARTAGÉ, et un dump de `newsletter` ne doit jamais rendre publiable sur les 9 sites.

-- ---------------------------------------------------------------------------
-- 1. Support de la clé étrangère composite
-- ---------------------------------------------------------------------------
-- `id` est déjà la clé primaire : cet index unique n'invalide aucune ligne existante, il ne fait
-- qu'offrir la cible que réclame une FK sur (id, asset_id).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'asset_edition_id_asset_uk'
      and conrelid = 'newsletter.asset_edition'::regclass
  ) then
    alter table newsletter.asset_edition
      add constraint asset_edition_id_asset_uk unique (id, asset_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. La table
-- ---------------------------------------------------------------------------
create table if not exists newsletter.wp_source (
  id             uuid primary key default gen_random_uuid(),
  edition_id     uuid not null,
  asset_id       uuid not null,
  -- Ce que l'opérateur lit dans la liste. Libre : « Atlas Review · CL », « Northwind Sports — colunas ».
  label          text not null,
  -- Racine du SITE (https://northwind-sports.example), pas de /wp-json : le client la dérive, et une racine
  -- déjà suffixée casserait la découverte du namespace autant que celle du flux RSS.
  rest_root      text,
  kind           text not null default 'wp-rest' check (kind in ('wp-rest','rss')),
  -- Ids NUMÉRIQUES de catégories WP, jamais des slugs : `?categories=` n'accepte que des ids, et
  -- stocker le slug obligerait à le re-résoudre — donc à échouer — au moment de composer.
  default_categories int[] not null default '{}',
  auth_kind      text not null default 'none' check (auth_kind in ('none','app_password')),
  auth_user      text,
  -- Ce que la source sait RÉELLEMENT faire, mesuré par la sonde (jamais déclaré à la main) :
  -- namespaces exposés, _embed exploitable, taxonomies lisibles, filtre de date accepté…
  -- jsonb et pas des colonnes : la liste des capacités bougera à chaque site rencontré.
  capabilities   jsonb not null default '{}',
  status         text not null default 'unknown' check (status in ('unknown','ok','error')),
  status_detail  text,
  last_probed_at timestamptz,
  created_at     timestamptz not null default now(),

  -- Deux sources homonymes dans une même édition seraient indiscernables dans le sélecteur.
  unique (edition_id, label),

  -- Remplace la FK simple sur edition_id : elle garantit l'existence de l'édition ET interdit
  -- qu'`asset_id` désigne une autre marque que celle de l'édition. La suppression cascade en
  -- chaîne (asset → asset_edition → wp_source).
  constraint wp_source_edition_fk
    foreign key (edition_id, asset_id)
    references newsletter.asset_edition (id, asset_id)
    on delete cascade
);

-- Les deux seules lectures de l'application : « les sources de cette édition » (écran d'édition)
-- et « les sources de cette marque » (vue d'ensemble). Une par index.
create index if not exists idx_wp_source_edition
  on newsletter.wp_source (edition_id, created_at desc);
create index if not exists idx_wp_source_asset
  on newsletter.wp_source (asset_id, created_at desc);

alter table newsletter.wp_source enable row level security;
grant all on newsletter.wp_source to service_role;

comment on table newsletter.wp_source is
  'Sources WordPress d''une ÉDITION. Le secret d''authentification n''est PAS ici : il vit en variable d''environnement Vercel, résolue à l''exécution depuis l''hôte de rest_root.';
comment on column newsletter.wp_source.auth_user is
  'Identifiant du mot de passe applicatif WordPress. Le mot de passe lui-même est une variable d''environnement — ne jamais ajouter de colonne pour le stocker.';
comment on column newsletter.wp_source.capabilities is
  'Résultat de la dernière sonde. Mesuré, jamais déclaré : ce que le site répond fait foi sur ce que l''opérateur croit.';

-- ---------------------------------------------------------------------------
-- 3. L'ancienne colonne orpheline
-- ---------------------------------------------------------------------------
-- `asset_edition.wp_connection_id` date de 0001 : uuid sans clé étrangère et sans table cible,
-- jamais lue par une ligne de code. On la laisse en place (la retirer n'apporte rien et casserait
-- un éventuel `select *`) mais on l'étiquette, pour que la prochaine relecture ne la prenne pas
-- pour le lien à utiliser.
comment on column newsletter.asset_edition.wp_connection_id is
  'OBSOLÈTE — orpheline depuis 0001 (aucune FK, aucune table cible, jamais lue). Remplacée par newsletter.wp_source (migration 0024). Ne pas écrire dedans.';

notify pgrst, 'reload schema';
