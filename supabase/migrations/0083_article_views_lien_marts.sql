-- ============================================================================
-- 0083 — « Most viewed » relit l'audience GA4 à travers un lien en lecture seule vers la base `postgres`.
-- ============================================================================
--
-- CONTEXTE. En production, le schéma `newsletter` et l'entrepôt d'analytics (`marts`) vivent dans deux
-- bases distinctes d'un même cluster : `article_views` (0047) ne peut pas lire `marts.pages_daily_clean`
-- sans lien, chaque appel échoue et une édition dont le flux trie par vues est RETENUE au gel.
-- `postgres_fdw` fournit ce lien en lecture seule. Les appelants, les écrans et la règle
-- « non mesuré ≠ 0 » ne changent pas : seule la SOURCE de la fonction change.
--
-- ⭐ LE LIEN EST OPTIONNEL. Le serveur distant n'est créé QUE si le réglage `newsletter.marts_fdw_host`
-- est posé avant la migration, par exemple :
--     alter database <base> set newsletter.marts_fdw_host = 'db';   -- puis se reconnecter
--   (facultatifs : `newsletter.marts_fdw_port`, défaut 5432 ; `newsletter.marts_fdw_dbname`, défaut postgres)
-- Sans ce réglage — base neuve, démo, développement — `newsletter_ext.pages_daily_clean` est une table
-- LOCALE vide de même forme : `article_views` répond `ok = false, reason = 'source_silent'` et les
-- écrans affichent « non mesuré ». Aucune connexion sortante, aucune erreur de migration.
--
-- ⛔ AUCUN SECRET ICI. Avec le lien, le rôle distant en lecture seule, son mot de passe et le mapping
-- d'utilisateur sont posés HORS DÉPÔT : un mot de passe écrit dans une migration serait dans git. Tant
-- que le mapping n'existe pas, `article_views` échoue (« user mapping not found ») et l'appelant dit
-- « unavailable ».
--
-- ⚠️ L'HÔTE. `postgres_fdw` exige un mot de passe d'un rôle non superutilisateur : viser le nom du
-- service (ex. `db` dans un réseau Docker), pas `localhost` en confiance, ni une adresse IP qui change
-- quand le conteneur est recréé.
--
-- ⛔ TOUT FILTRE PASSE PAR UNE SOUS-REQUÊTE SCALAIRE, ET C'EST VOULU. La vue distante compte des
-- millions de lignes. `postgres_fdw` n'envoie au serveur distant que des expressions qu'il
-- sait y rejouer : `current_date` n'en est pas, un paramètre d'initplan en est un. Écrire
-- `event_date >= current_date - 30` ferait rapatrier toute la vue pour filtrer ici. Coût mesuré côté
-- distant, filtres appliqués : 143 ms pour le contrôle de fraîcheur, 6 ms pour les vues.
--
-- ⚠️ `views` se somme d'abord PAR CHEMIN, puis se rattache aux href. Même résultat que 0047 pour des
-- href distincts ; pour un href soumis deux fois, 0047 doublait ses vues (le `left join` multipliait
-- les lignes avant le `sum`) — ici il garde son vrai total.

set local role postgres;

create schema if not exists newsletter_ext;
revoke all on schema newsletter_ext from public;
revoke all on schema newsletter_ext from anon, authenticated, service_role;

comment on schema newsletter_ext is
  'Tables etrangeres (postgres_fdw) ou leur remplacant local vide. Jamais exposees a l''API : seules des fonctions SECURITY DEFINER les lisent.';

-- Les QUATRE colonnes que la fonction lit, et aucune autre : une colonne déclarée ici est une colonne
-- qui doit exister là-bas, et chaque colonne de trop est une panne possible le jour où l'entrepôt la
-- renomme. Lien distant SEULEMENT si `newsletter.marts_fdw_host` est posé (voir l'en-tête).
do $$
declare
  v_host text := nullif(current_setting('newsletter.marts_fdw_host', true), '');
  v_port text := coalesce(nullif(current_setting('newsletter.marts_fdw_port', true), ''), '5432');
  v_db   text := coalesce(nullif(current_setting('newsletter.marts_fdw_dbname', true), ''), 'postgres');
begin
  if v_host is null then
    raise notice '[0083] newsletter.marts_fdw_host absent : aucun lien distant, table locale vide (analytics « non mesuré »)';
    execute 'create table if not exists newsletter_ext.pages_daily_clean (
               site_slug         text,
               event_date        date,
               page_path         text,
               screen_page_views bigint
             )';
  else
    execute 'create extension if not exists postgres_fdw schema extensions';
    execute format(
      'create server if not exists marts_src foreign data wrapper postgres_fdw '
      || 'options (host %L, port %L, dbname %L, fetch_size %L)',
      v_host, v_port, v_db, '10000');
    execute 'comment on server marts_src is '
      || quote_literal('Lien en lecture seule vers l''entrepot `marts`. Le mapping d''utilisateur et le '
                       || 'role distant sont poses hors depot : aucun secret dans git.');
    execute 'create foreign table if not exists newsletter_ext.pages_daily_clean (
               site_slug         text,
               event_date        date,
               page_path         text,
               screen_page_views bigint
             ) server marts_src
               options (schema_name ''marts'', table_name ''pages_daily_clean'')';
  end if;
end
$$;

revoke all on newsletter_ext.pages_daily_clean from public;
revoke all on newsletter_ext.pages_daily_clean from anon, authenticated, service_role;

create or replace function newsletter.article_views(
  p_asset_id uuid,
  p_hrefs    text[],
  p_from     date,
  p_to       date
) returns jsonb
language sql
stable
security definer
set search_path = newsletter, pg_temp
as $$
with cfg as (
  select site_slug from newsletter.asset_analytics where asset_id = p_asset_id
),
-- ⛔ LA BORNE HAUTE EST J−2, ET ELLE EST RENDUE À L'APPELANT (0047, inchangé). L'ingestion demande
-- `endDate = aujourd'hui − 1`, et J−1 est tronqué inégalement selon la marque.
bornes as (
  select p_from as d_from,
         least(p_to, (current_date - 2)) as d_to,
         p_to as d_to_demande
),
-- Normalisation : retirer le schéma et l'hôte, RIEN D'AUTRE (0046/0047, inchangé).
cands as (
  select h as href,
         case when h like 'http://%' or h like 'https://%'
              then regexp_replace(h, '^https?://[^/]+', '')
         end as path
  from unnest(coalesce(p_hrefs, array[]::text[])) as h
),
-- ⛔ Chaque borne est une sous-requête scalaire : elle part au serveur distant comme paramètre. Voir
-- l'en-tête — `current_date` écrit en clair ferait rapatrier la vue entière.
sante as (
  select max(p.event_date) as max_event_date,
         count(*) filter (where p.event_date = (select d_to from bornes))     as rows_last_day,
         count(*) filter (where p.event_date = (select d_to from bornes) - 1) as rows_prev_day
  from newsletter_ext.pages_daily_clean p
  where p.site_slug  = (select site_slug from cfg)
    and p.event_date >= (select current_date - 30)
),
-- Les vues sommées PAR CHEMIN, côté distant : seuls les chemins candidats remontent.
par_chemin as (
  select p.page_path,
         sum(p.screen_page_views)::bigint as views
  from newsletter_ext.pages_daily_clean p
  where p.site_slug  = (select site_slug from cfg)
    and p.event_date between (select d_from from bornes) and (select d_to from bornes)
    -- ⚠️ `coalesce(...)` n'est pas décoratif : `any ((select ...))` seul est lu comme un `any` de
    -- SOUS-REQUÊTE (text = text[] → erreur). Enveloppé, c'est une expression tableau, envoyée en paramètre.
    and p.page_path  = any (coalesce((select array_agg(distinct path) from cands where path is not null),
                                     array[]::text[]))
  group by p.page_path
),
vues as (
  -- ⛔ PAS DE `coalesce` ICI (0047) : un chemin sans aucune ligne rend `null`, pas `0`. Le zéro reste
  -- possible et reste vrai — des lignes existent pour ce chemin et elles somment à zéro.
  select c.href,
         c.path,
         max(v.views) as views
  from cands c
  left join par_chemin v on v.page_path = c.path
  where c.path is not null
  group by c.href, c.path
)
select jsonb_build_object(
  -- ⛔ TROIS CAUSES DE ZÉRO, TROIS RAISONS DISTINCTES — et `matched = 0` reste un SUCCÈS (0047).
  'ok', case
          when not exists (select 1 from cfg)                                     then false
          when (select max_event_date from sante) is null                         then false
          when (select max_event_date from sante) < (select d_to from bornes) - 3 then false
          else true
        end,
  'reason', case
              when not exists (select 1 from cfg)                                     then 'no_property'
              when (select max_event_date from sante) is null                         then 'source_silent'
              when (select max_event_date from sante) < (select d_to from bornes) - 3 then 'source_stale'
            end,
  'site_slug', (select site_slug from cfg),
  'window', jsonb_build_object(
    'from', (select d_from from bornes),
    'to', (select d_to from bornes),
    'to_requested', (select d_to_demande from bornes)
  ),
  'freshness', jsonb_build_object(
    'max_event_date', (select max_event_date from sante),
    'rows_last_day',  (select rows_last_day from sante),
    'rows_prev_day',  (select rows_prev_day from sante)
  ),
  'candidates', coalesce(array_length(p_hrefs, 1), 0),
  'rejected_relative', (select count(*) from cands where path is null),
  'matched', (select count(*) from vues where views is not null),
  'views', coalesce((select jsonb_agg(jsonb_build_object('href', href, 'path', path, 'views', views)
                              order by views desc nulls last, href)
                     from vues), '[]'::jsonb)
);
$$;

revoke execute on function newsletter.article_views(uuid, text[], date, date) from public;
revoke execute on function newsletter.article_views(uuid, text[], date, date) from anon, authenticated;
grant  execute on function newsletter.article_views(uuid, text[], date, date) to service_role;

comment on function newsletter.article_views(uuid, text[], date, date) is
  'Les vues GA4 de N articles candidats, pour la propriete elue de la marque, lues dans la base `postgres` '
  'via la table etrangere newsletter_ext.pages_daily_clean (0083). Borne la fenetre a J-2 et rend la fenetre '
  'EFFECTIVE. `views` vaut null quand AUCUNE ligne n''apparie le chemin — a ne pas confondre avec 0, qui est '
  'une mesure. `matched` compte les candidats apparies.';

reset role;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVES — DANS la migration (voir 0072). Structurelles seulement : la lecture réelle exige
-- le mapping d'utilisateur, posé hors dépôt APRÈS cette migration, et se prouve à ce moment-là.
-- ---------------------------------------------------------------------------
do $$
declare
  v_opts text[];
  v_kind "char";
  v_host text := nullif(current_setting('newsletter.marts_fdw_host', true), '');
begin
  -- 1. La source : table étrangère sur `marts_src` si le réglage est posé, table locale vide sinon.
  select c.relkind into v_kind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'newsletter_ext' and c.relname = 'pages_daily_clean';
  if v_kind is null then
    raise exception '[0083] newsletter_ext.pages_daily_clean absente apres execution';
  end if;
  if v_host is null then
    if v_kind <> 'r' then
      raise exception '[0083] sans newsletter.marts_fdw_host, pages_daily_clean doit etre une table locale (relkind %)', v_kind;
    end if;
    raise notice '[0083] contre-epreuve 1 OK : aucun lien distant, newsletter_ext.pages_daily_clean locale et vide';
  else
    if v_kind <> 'f' then
      raise exception '[0083] avec newsletter.marts_fdw_host, pages_daily_clean doit etre une table etrangere (relkind %)', v_kind;
    end if;
    if not exists (select 1 from pg_extension where extname = 'postgres_fdw') then
      raise exception '[0083] postgres_fdw absente apres execution';
    end if;
    select s.srvoptions into v_opts
      from pg_foreign_server s
      join pg_foreign_data_wrapper w on w.oid = s.srvfdw
     where s.srvname = 'marts_src' and w.fdwname = 'postgres_fdw';
    if v_opts is null or not (('host=' || v_host) = any (v_opts)) then
      raise exception '[0083] serveur marts_src absent ou mal pointe : %', v_opts;
    end if;
    select ft.ftoptions into v_opts
      from pg_foreign_table ft
     where ft.ftrelid = 'newsletter_ext.pages_daily_clean'::regclass;
    if not ('schema_name=marts' = any (v_opts)) or not ('table_name=pages_daily_clean' = any (v_opts)) then
      raise exception '[0083] la table etrangere ne vise pas marts.pages_daily_clean : %', v_opts;
    end if;
    raise notice '[0083] contre-epreuve 1 OK : postgres_fdw installee, marts_src -> host=%, cible marts.pages_daily_clean', v_host;
  end if;

  -- 2. La table : les 4 colonnes typées, et FERMÉE aux rôles de l'API.
  if (select count(*)
        from information_schema.columns
       where table_schema = 'newsletter_ext' and table_name = 'pages_daily_clean'
         and (column_name, data_type) in (('site_slug', 'text'), ('event_date', 'date'),
                                          ('page_path', 'text'), ('screen_page_views', 'bigint'))) <> 4
     or (select count(*) from information_schema.columns
          where table_schema = 'newsletter_ext' and table_name = 'pages_daily_clean') <> 4 then
    raise exception '[0083] newsletter_ext.pages_daily_clean n''a pas exactement les 4 colonnes attendues';
  end if;
  if has_table_privilege('anon', 'newsletter_ext.pages_daily_clean', 'SELECT')
     or has_table_privilege('authenticated', 'newsletter_ext.pages_daily_clean', 'SELECT')
     or has_table_privilege('service_role', 'newsletter_ext.pages_daily_clean', 'SELECT')
     or has_schema_privilege('anon', 'newsletter_ext', 'USAGE')
     or has_schema_privilege('authenticated', 'newsletter_ext', 'USAGE')
     or has_schema_privilege('service_role', 'newsletter_ext', 'USAGE') then
    raise exception '[0083] newsletter_ext est lisible par un role de l''API';
  end if;
  raise notice '[0083] contre-epreuve 2 OK : 4 colonnes typees, fermee a anon/authenticated/service_role';

  -- 3. La fonction : lit la table étrangère et plus `marts`, reste SECURITY DEFINER, fermée hors service_role.
  if exists (select 1 from pg_proc
              where oid = 'newsletter.article_views(uuid, text[], date, date)'::regprocedure
                and (prosrc !~ 'newsletter_ext\.pages_daily_clean'
                     or prosrc ~ '(^|[^_a-z])marts\.'
                     or not prosecdef)) then
    raise exception '[0083] article_views ne lit pas newsletter_ext, lit encore marts, ou n''est plus SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'newsletter.article_views(uuid, text[], date, date)', 'EXECUTE')
     or has_function_privilege('authenticated', 'newsletter.article_views(uuid, text[], date, date)', 'EXECUTE')
     or not has_function_privilege('service_role', 'newsletter.article_views(uuid, text[], date, date)', 'EXECUTE') then
    raise exception '[0083] droits d''execution de article_views faux';
  end if;
  raise notice '[0083] contre-epreuve 3 OK : article_views lit newsletter_ext, SECURITY DEFINER, executable par service_role seul';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0083', '0083_article_views_lien_marts.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
