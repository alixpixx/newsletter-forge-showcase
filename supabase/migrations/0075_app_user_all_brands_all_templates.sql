-- ============================================================================
-- 0075 — « All brands » et « All templates » : DEUX cases, deux décisions.
-- ============================================================================
--
-- ⭐ POURQUOI. 0074 n'avait qu'un drapeau, `all_access` : tout ou rien. Demande d'Alix
-- (22/09/2026) : « faut que brands et template soient séparés ; par exemple je veux qu'un user ait
-- accès qu'à un domaine mais à tous les templates automatiquement ». Un seul booléen ne peut pas
-- exprimer ça — cocher « tous les templates » ouvrait du même geste toutes les marques, et c'est
-- exactement le cas d'usage demandé qui devenait impossible à écrire.
--
-- ⭐ CE QUE CHAQUE COLONNE VEUT DIRE, ET CE QU'ELLE NE VEUT PAS DIRE.
--   `all_assets`    = toutes les MARQUES, présentes et futures.
--   `all_templates` = tous les TEMPLATES DES MARQUES QUE CE COMPTE VOIT, présents et futurs.
--
-- ⛔ `all_templates` N'EST PAS UN CHEMIN VERS UNE AUTRE MARQUE. Il lève le filtre PAR TEMPLATE, il
-- ne touche jamais au filtre PAR MARQUE : toute lecture de template porte `asset_id = <marque
-- courante>` (apps/admin/src/lib/data/templates.ts), et la marque courante est elle-même choisie
-- dans `assetIds` du compte (apps/admin/src/lib/asset-context.ts). Un membre qui a la marque A et
-- « All templates » voit donc TOUS les templates de A — y compris ceux créés demain — et RIEN de B.
-- Les quatre combinaisons ont un sens, et c'est le but : ni l'un ni l'autre, marques seules,
-- templates seuls, les deux.
--
-- ⭐ LE MÉCANISME EST CELUI DE 0074, DÉDOUBLÉ : des drapeaux sur le compte, pas des lignes.
-- `apps/admin/src/lib/session.ts` relit le compte à CHAQUE requête ; c'est ce recalcul par requête
-- qui rend l'avenir automatique, là où une liste de lignes d'octroi (`app_user_asset`,
-- `app_user_template`) reste figée au moment où on l'enregistre.
-- ⛔ Ces drapeaux ne donnent AUCUN droit d'administration : le rôle reste `member`.
--
-- ⚠️ Les lignes d'octroi explicites sont CONSERVÉES quand on coche une case, et ignorées tant
-- qu'elle est cochée. Décocher rend donc la sélection d'avant, au lieu d'un compte vide.
--
-- ⭐ REPRISE DE L'EXISTANT. Les deux colonnes sont recopiées depuis `all_access` : un compte qui
-- voyait tout continue de tout voir, sans que personne ait à repasser sur l'écran des comptes.
-- Mesuré en production le 22/09/2026 avant écriture : 6 comptes, 0 avec `all_access` vrai — la
-- reprise ne touche aucune ligne aujourd'hui. Elle est écrite quand même : ce fichier sera rejoué
-- sur les bases de développement, où le drapeau a pu être posé.
--
-- ⛔⛔ ORDRE DE DÉPLOIEMENT : **0075 → NOUVEAU CODE → 0076**.
--   1. 0075 (ce fichier) AVANT le code : le nouveau code lit `all_assets` / `all_templates` dans la
--      liste des colonnes de `findById` / `findByEmail`, donc à CHAQUE requête et à la connexion.
--      Sans les colonnes, PostgREST refuse la lecture et l'admin entier tombe, écran de connexion
--      compris. L'inverse est sans danger : les colonnes seules, avec l'ancien code, ne sont lues
--      par personne.
--   2. Le nouveau code.
--   3. 0076 SEULEMENT APRÈS, pour retirer `all_access`.
-- ⛔ CE FICHIER NE SUPPRIME NI NE RENOMME `all_access`, ET C'EST DÉLIBÉRÉ. Le code EN PRODUCTION
-- aujourd'hui lit `all_access` à chaque requête : le retirer avant que le nouveau code soit en
-- ligne coupe l'admin en entier, connexion comprise. C'est `0076_app_user_drop_all_access.sql`,
-- dans le même commit, qui le retire — et il ne s'applique qu'après le déploiement.
--
-- `default false` : aucun compte existant ne change de périmètre en appliquant ce fichier.

alter table newsletter.app_user
  add column if not exists all_assets    boolean not null default false,
  add column if not exists all_templates boolean not null default false;

comment on column newsletter.app_user.all_assets is
  'true = ce compte voit TOUTES les marques, presentes et futures : le perimetre est recalcule a '
  'chaque requete (apps/admin/src/lib/session.ts), une marque creee plus tard est donc incluse '
  'd''office. Les lignes app_user_asset explicites sont conservees mais ignorees tant que ce '
  'drapeau est vrai (le decocher rend la selection d''avant). Ne donne aucun droit '
  'd''administration. Sans effet pour un super_admin, qui voit deja tout. Remplace all_access '
  '(0074) pour la partie marques.';

comment on column newsletter.app_user.all_templates is
  'true = ce compte voit TOUS les templates DES MARQUES QU''IL VOIT, presents et futurs. ⛔ Ce '
  'drapeau leve le filtre par TEMPLATE, jamais le filtre par MARQUE : un membre qui a la marque A '
  'et ce drapeau voit tous les templates de A et aucun de B. Les lignes app_user_template '
  'explicites sont conservees mais ignorees tant que ce drapeau est vrai. Ne donne aucun droit '
  'd''administration. Sans effet pour un super_admin. Remplace all_access (0074) pour la partie '
  'templates.';

-- ---------------------------------------------------------------------------
-- REPRISE DE L'EXISTANT depuis `all_access`.
-- ⚠️ Sous garde d'existence de la colonne : si ce fichier est rejoué sur une base où 0076 est déjà
-- passé, `all_access` n'existe plus et un `update` nu échouerait à la COMPILATION de l'instruction,
-- avant même de lire une ligne. On préfère le dire et continuer.
-- ---------------------------------------------------------------------------
do $$
declare
  reprises bigint;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'newsletter' and table_name = 'app_user' and column_name = 'all_access'
  ) then
    execute 'update newsletter.app_user
                set all_assets = all_access, all_templates = all_access
              where all_access';
    -- ⚠️ `GET DIAGNOSTICS` et non un `count(*)` refait ensuite : ce chiffre doit désigner LES
    -- LIGNES QUE CET UPDATE A TOUCHÉES, pas le nombre de comptes portant un drapeau — un compte
    -- déjà coché avant ce fichier gonflerait le second sans que la reprise y soit pour rien.
    get diagnostics reprises = row_count;
    raise notice '[0075] reprise depuis all_access : % ligne(s) mise(s) a jour', reprises;
  else
    raise notice '[0075] all_access absent (0076 deja applique ?) : aucune reprise a faire';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE — DANS la migration (voir 0072).
-- ⛔ `add column if not exists` rend « success » même s'il n'a rien ajouté (schéma absent, colonne
-- homonyme d'un autre type). On relit le catalogue et on ÉCHOUE si l'une des deux colonnes n'a pas
-- la forme que le code suppose : booléenne, non nulle, fausse par défaut.
-- ⛔ Et on éprouve la REPRISE elle-même : un `update` qui ne touche aucune ligne réussit en
-- silence. Tant que `all_access` existe, aucun compte ne doit le porter sans porter les deux
-- nouveaux drapeaux — sinon quelqu'un perdrait son périmètre au déploiement du code.
-- ---------------------------------------------------------------------------
do $$
declare
  c        record;
  manquant text;
  perdus   bigint;
begin
  foreach manquant in array array['all_assets', 'all_templates'] loop
    select data_type, is_nullable, column_default
      into c
      from information_schema.columns
     where table_schema = 'newsletter'
       and table_name   = 'app_user'
       and column_name  = manquant;

    if not found then
      raise exception '[0075] app_user n''a pas la colonne % apres execution', manquant;
    end if;
    if c.data_type <> 'boolean' or c.is_nullable <> 'NO' or coalesce(c.column_default, '') <> 'false' then
      raise exception '[0075] app_user.% n''a pas la forme attendue : type=%, nullable=%, defaut=%',
        manquant, c.data_type, c.is_nullable, c.column_default;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'newsletter' and table_name = 'app_user' and column_name = 'all_access'
  ) then
    execute 'select count(*) from newsletter.app_user
              where all_access and not (all_assets and all_templates)'
       into perdus;
    if perdus > 0 then
      raise exception '[0075] % compte(s) portent all_access sans les deux nouveaux drapeaux : la reprise n''a pas pris',
        perdus;
    end if;
  end if;

  raise notice '[0075] contre-epreuve OK : all_assets et all_templates boolean not null default false, reprise coherente';
end
$$;

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0075', '0075_app_user_all_brands_all_templates.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;

notify pgrst, 'reload schema';
