-- ============================================================================
-- 0084 — `article_views` : le filtre des chemins candidats part VRAIMENT au serveur distant.
-- ============================================================================
--
-- ⛔ CE QUE 0083 PROMETTAIT ET NE FAISAIT PAS, MESURÉ LE 24/09/2026 (EXPLAIN VERBOSE à travers le lien).
-- Le commentaire de 0083 disait « seuls les chemins candidats remontent ». Faux : le SQL envoyé à la
-- base `postgres` était
--     SELECT page_path, screen_page_views FROM marts.pages_daily_clean
--      WHERE event_date >= $1 AND event_date <= $2 AND site_slug = $3
-- — toutes les lignes de la marque sur la fenêtre (15 892 pour copper-kettle sur 7 jours), filtrées et
-- sommées ICI. En cause : `any (coalesce((select ...), array[]::text[]))`. `postgres_fdw` ne sait pas
-- rejouer ce `coalesce` à distance, donc il garde le filtre, et avec lui la somme.
--
-- ⭐ LA FORME QUI PART : `any ((select coalesce(...) ...)::text[])`. Le `coalesce` passe DANS la
-- sous-requête, qui devient un simple paramètre ; le `::text[]` (sans effet sur le type) empêche
-- l'analyseur de lire `any ((select ...))` comme un `any` de sous-requête (text = text[], l'erreur
-- de l'essai de 0083). SQL envoyé, mesuré :
--     SELECT page_path, sum(screen_page_views) FROM marts.pages_daily_clean
--      WHERE event_date >= $1 AND event_date <= $2 AND page_path = ANY ($3::text[]) AND site_slug = $4
--      GROUP BY 1
-- Seuls les chemins candidats remontent, déjà sommés. Gain mesuré sur northwind-sports : 270 → 228 ms (le reste
-- est le coût de la vue distante elle-même). Le résultat ne change pas : seule la répartition du
-- travail change.
--
-- Rien d'autre ne bouge : même signature, mêmes clés JSON, mêmes droits.

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
-- ⛔ Chaque borne est une sous-requête scalaire : elle part au serveur distant comme paramètre (0083).
-- `current_date` écrit en clair ferait rapatrier la vue entière (14,4 M de lignes).
sante as (
  select max(p.event_date) as max_event_date,
         count(*) filter (where p.event_date = (select d_to from bornes))     as rows_last_day,
         count(*) filter (where p.event_date = (select d_to from bornes) - 1) as rows_prev_day
  from newsletter_ext.pages_daily_clean p
  where p.site_slug  = (select site_slug from cfg)
    and p.event_date >= (select current_date - 30)
),
-- Les vues sommées PAR CHEMIN, côté distant : seuls les chemins candidats remontent (mesuré, voir
-- l'en-tête de 0084).
par_chemin as (
  select p.page_path,
         sum(p.screen_page_views)::bigint as views
  from newsletter_ext.pages_daily_clean p
  where p.site_slug  = (select site_slug from cfg)
    and p.event_date between (select d_from from bornes) and (select d_to from bornes)
    -- ⛔ LE `coalesce` RESTE DANS LA SOUS-REQUÊTE et le `::text[]` reste dehors : sorti de la
    -- sous-requête, le `coalesce` n'est plus envoyable et tout le filtre reste ici (0083) ; sans le
    -- cast, `any ((select ...))` redevient un `any` de sous-requête (text = text[]).
    and p.page_path  = any ((select coalesce(array_agg(distinct path), array[]::text[])
                               from cands where path is not null)::text[])
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

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVES — DANS la migration (voir 0072).
-- ---------------------------------------------------------------------------
do $$
declare
  v_src text;
begin
  select prosrc into v_src
    from pg_proc
   where oid = 'newsletter.article_views(uuid, text[], date, date)'::regprocedure
     and prosecdef;
  if v_src is null or v_src !~ 'newsletter_ext\.pages_daily_clean' or v_src ~ '(^|[^_a-z])marts\.' then
    raise exception '[0084] article_views ne lit pas newsletter_ext, lit encore marts, ou n''est plus SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'newsletter.article_views(uuid, text[], date, date)', 'EXECUTE')
     or has_function_privilege('authenticated', 'newsletter.article_views(uuid, text[], date, date)', 'EXECUTE')
     or not has_function_privilege('service_role', 'newsletter.article_views(uuid, text[], date, date)', 'EXECUTE') then
    raise exception '[0084] droits d''execution de article_views faux';
  end if;
  raise notice '[0084] contre-epreuve 1 OK : article_views lit newsletter_ext, SECURITY DEFINER, executable par service_role seul';

  -- 2. La forme envoyable : le `coalesce` DANS la sous-requête, le cast DEHORS. Le retour à la forme
  --    de 0083 (coalesce enveloppant la sous-requête) ramènerait le filtre ici sans aucune erreur.
  if v_src !~ 'any \(\(select coalesce\(array_agg\(distinct path\), array\[\]::text\[\]\)\s+from cands where path is not null\)::text\[\]\)'
     or v_src ~ 'any \(coalesce\(' then
    raise exception '[0084] le filtre des chemins n''a pas la forme envoyable au serveur distant';
  end if;
  raise notice '[0084] contre-epreuve 2 OK : filtre des chemins sous forme de parametre tableau (envoyable)';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0084', '0084_article_views_chemins_distants.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
