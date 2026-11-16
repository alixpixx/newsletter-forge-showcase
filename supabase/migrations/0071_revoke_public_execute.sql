-- 0071 — Les fonctions SECURITY DEFINER cessent d'être exécutables par tout le monde.
--
-- ⛔ LE DÉFAUT DE POSTGRES EST « TOUT LE MONDE PEUT EXÉCUTER ». À la création d'une fonction,
-- EXECUTE est accordé à PUBLIC. Un `grant execute … to service_role` n'y change RIEN : il ajoute
-- un droit, il n'en retire aucun. Seize signatures SECURITY DEFINER du schéma `newsletter` étaient
-- donc appelables par `anon` et `authenticated` — c'est-à-dire par n'importe qui, à travers
-- PostgREST, avec la clé publiable qui est dans le code des pages.
--
-- SECURITY DEFINER veut dire « s'exécute avec les droits du PROPRIÉTAIRE ». La combinaison des deux
-- est exactement le motif d'élévation de privilèges : la plus exposée de la liste est
-- `erase_subscriber(uuid)`, qui anonymise une personne et ne prend qu'un identifiant.
--
-- ⚠️ CE QUE CETTE MIGRATION NE FAIT PAS : elle ne protège que les fonctions qui existent AU MOMENT
-- où elle tourne. Une fonction SECURITY DEFINER créée ensuite repartira avec EXECUTE pour PUBLIC.
-- La requête de contrôle en fin de fichier est faite pour être rejouée.
--
-- Mesuré avant d'écrire : les trois applications (admin, public, worker) parlent à la base avec
-- `service_role` — `apps/*/src/lib/supabase.ts` et `apps/worker/src/db.ts`. Aucun chemin applicatif
-- n'appelle ces RPC en `anon` ni en `authenticated`.
--
-- Forme reprise de 0069_deliverability_summary.sql:200-201, qui est la plus complète du dépôt
-- (`from public, anon, authenticated` puis `grant … to service_role`). ⛔ Le revoke doit précéder
-- le grant — c'est ce que documente 0046:215-216.
--
-- ⛔ BALAYAGE PLUTÔT QUE LISTE ÉCRITE À LA MAIN. Énumérer seize signatures exactes, c'est seize
-- occasions de se tromper d'un type d'argument — et une signature fautive fait échouer toute la
-- migration sur un `function does not exist` qui ressemble à un problème de base. Le balayage
-- interroge `pg_proc` : il ne peut pas désigner une fonction qui n'existe pas, et il rattrape
-- celles que l'inventaire aurait manquées.

do $$
declare
  f record;
  n integer := 0;
  roles_supabase text;
begin
  -- `anon` et `authenticated` existent chez Supabase mais pas sur une base nue : on ne révoque
  -- qu'à ceux qui existent, sinon la migration échoue là où il n'y a justement rien à protéger.
  select string_agg(quote_ident(rolname), ', ')
    into roles_supabase
    from pg_roles
   where rolname in ('anon', 'authenticated');

  for f in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'newsletter'
       and p.prosecdef
     order by 1
  loop
    execute format('revoke all on function %s from public', f.signature);

    if roles_supabase is not null then
      execute format('revoke all on function %s from %s', f.signature, roles_supabase);
    end if;

    -- Reposé systématiquement : une fonction dont le grant manquait deviendrait inappelable, et
    -- la panne se verrait en production sur un chemin qui marchait la minute d'avant.
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.signature);
    end if;

    n := n + 1;
  end loop;

  raise notice '[0071] % fonctions SECURITY DEFINER reservees a service_role', n;
end
$$;

-- ⛔ CONTRE-ÉPREUVE DANS LA MIGRATION ELLE-MÊME. Une migration qui se contente d'exécuter des
-- REVOKE rend « success » même si elle n'a rien révoqué du tout (zéro ligne balayée, mauvais
-- schéma, boucle vide). Celle-ci échoue si le résultat n'est pas atteint.
--
-- `grantee = 0` désigne PUBLIC dans une ACL. `acldefault('f', proowner)` reconstruit l'ACL
-- implicite des fonctions dont `proacl` est NULL — c'est-à-dire celles auxquelles personne n'a
-- jamais touché, et qui sont précisément les plus ouvertes.
do $$
declare
  restantes integer;
  details text;
begin
  select count(*), string_agg(p.oid::regprocedure::text, ', ')
    into restantes, details
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'newsletter'
     and p.prosecdef
     and exists (
       select 1
         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0
          and a.privilege_type = 'EXECUTE'
     );

  if restantes > 0 then
    raise exception '[0071] % fonctions SECURITY DEFINER laissent encore EXECUTE a PUBLIC : %',
      restantes, details;
  end if;

  raise notice '[0071] contre-epreuve OK : aucune fonction SECURITY DEFINER ouverte a PUBLIC';
end
$$;

comment on schema newsletter is
  'Les fonctions SECURITY DEFINER sont reservees a service_role depuis 0071. '
  'Toute nouvelle fonction SECURITY DEFINER doit porter son propre revoke : le defaut Postgres '
  'accorde EXECUTE a PUBLIC, et un grant a service_role ne retire rien.';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE. Le registre de la CLI Supabase ne
-- correspond pas à ce dossier : la seule preuve qu'une migration est passée est la ligne qu'elle
-- écrit ici. L'inscrire AVANT la vérification déclarerait « appliquée » une migration qui échoue
-- ensuite.
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0071', '0071_revoke_public_execute.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
