-- ============================================================================
-- 0074 — « All brands and templates » : un membre peut tout voir, y compris ce qui viendra.
-- ============================================================================
--
-- ⭐ POURQUOI. Demande d'Alix (22/09/2026) : une case « All » dans les droits d'un compte, pour que
-- toutes les marques ET tous les templates soient cochés d'office, et qu'une marque ou un template
-- ajouté plus tard le soit aussi, sans repasser par l'écran des comptes. Cocher les cases à la main
-- ne le permet pas : un octroi est une liste de lignes (`app_user_asset`, `app_user_template`),
-- figée au moment où on l'enregistre — ce qui est créé le lendemain n'y est pas.
--
-- ⭐ LE MÉCANISME. Un drapeau sur le compte, pas des lignes. `apps/admin/src/lib/session.ts` relit
-- le compte à CHAQUE requête et, quand `all_access` est vrai, traite le compte comme un super_admin
-- POUR LA VISIBILITÉ SEULEMENT : les marques sont la liste de toutes les marques lue à l'instant, et
-- aucun template n'est filtré par octroi. C'est ce calcul par requête qui rend l'avenir automatique.
-- ⛔ Ce drapeau ne donne AUCUN droit d'administration (écran des comptes, routes super_admin) : il
-- ne touche que le rôle `member`, et le rôle reste `member`.
--
-- ⚠️ Les lignes `app_user_asset` / `app_user_template` explicites sont CONSERVÉES quand on coche
-- « All », et ignorées tant qu'il est coché. Le décocher rend donc la sélection d'avant, au lieu d'un
-- compte vide.
--
-- ⛔ ORDRE DE DÉPLOIEMENT : CETTE MIGRATION AVANT LE CODE. Le code lit `all_access` dans la liste
-- des colonnes de `findById` / `findByEmail`, c'est-à-dire à CHAQUE requête et à la connexion : sans
-- la colonne, PostgREST refuse la lecture et l'admin entier tombe, écran de connexion compris.
-- L'inverse est sans danger : la colonne seule, avec l'ancien code, n'est lue par personne.
--
-- `default false` : aucun compte existant ne change de périmètre en appliquant ce fichier.

alter table newsletter.app_user
  add column if not exists all_access boolean not null default false;

comment on column newsletter.app_user.all_access is
  'true = ce compte voit TOUTES les marques et TOUS les templates, presents et futurs : le perimetre '
  'est recalcule a chaque requete (apps/admin/src/lib/session.ts), ce qui est cree plus tard est donc '
  'inclus d''office. Les lignes app_user_asset / app_user_template explicites sont conservees mais '
  'ignorees tant que ce drapeau est vrai (le decocher rend la selection d''avant). Ne donne aucun '
  'droit d''administration. Sans effet pour un super_admin, qui voit deja tout.';

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE — DANS la migration (voir 0072).
-- ⛔ `add column if not exists` rend « success » même s'il n'a rien ajouté (schéma absent, colonne
-- homonyme d'un autre type). On relit le catalogue et on ÉCHOUE si la colonne n'a pas la forme que
-- le code suppose : booléenne, non nulle, fausse par défaut.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  select data_type, is_nullable, column_default
    into c
    from information_schema.columns
   where table_schema = 'newsletter'
     and table_name   = 'app_user'
     and column_name  = 'all_access';

  if not found then
    raise exception '[0074] app_user n''a pas la colonne all_access apres execution';
  end if;
  if c.data_type <> 'boolean' or c.is_nullable <> 'NO' or coalesce(c.column_default, '') <> 'false' then
    raise exception '[0074] app_user.all_access n''a pas la forme attendue : type=%, nullable=%, defaut=%',
      c.data_type, c.is_nullable, c.column_default;
  end if;

  raise notice '[0074] contre-epreuve OK : app_user.all_access boolean not null default false';
end
$$;

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0074', '0074_app_user_all_access.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;

notify pgrst, 'reload schema';
