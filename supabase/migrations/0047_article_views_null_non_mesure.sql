-- 0047 — `article_views` cesse de fabriquer des zéros.
--
-- ⛔ LE DÉFAUT, MESURÉ EN PRODUCTION LE 01/09/2026. La version 0046 fait `coalesce(sum(...), 0)`
-- derrière un `left join`. Tout href absolu reçoit donc une valeur, y compris quand AUCUNE ligne
-- d'analytics ne lui correspond : l'écran écrit « 0 views » — une mesure — là où rien n'a été mesuré.
-- Constaté sur copper-kettle : les 8 articles servis par défaut sont publiés après la borne haute
-- (J−2), n'ont par construction aucune ligne, et s'affichaient pourtant « lus par personne ».
--
-- Un zéro fabriqué est indiscernable d'un zéro observé, et les deux appellent des actions opposées :
-- le premier dit « demande des articles plus anciens », le second « change de catégorie ». Le
-- `left join` reste — il faut bien rendre une entrée par candidat — mais `sum()` rend désormais
-- `null` quand le groupe est vide, et l'appelant traduit `null` par « non mesuré ».
--
-- ⚠️ `matched` change de définition, et c'est une CORRECTION : il comptait `views > 0`, ce qui
-- confondait « apparié et lu par personne » avec « jamais apparié ». Il compte maintenant les
-- candidats réellement APPARIÉS. GA4 ne remonte pas de ligne à zéro, donc l'écart observable est
-- nul aujourd'hui ; la définition, elle, devient exacte et le restera si GA4 change d'avis.
--
-- Additive et rétro-compatible : même signature, mêmes clés JSON, `views` passe de `number` à
-- `number | null`. L'appelant TypeScript traite déjà l'absence de clé comme « non mesuré ».

-- (Base neuve) Même précaution que 0046 : `marts` peut ne pas exister ici, le corps n'est pas validé.
set check_function_bodies = off;
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
-- ⛔ LA BORNE HAUTE EST J−2, ET ELLE EST RENDUE À L'APPELANT. L'aspirateur de data-warehouse demande
-- `endDate = aujourd'hui − 1` : il n'y a jamais une ligne pour le jour courant, à aucune heure. Et
-- J−1 est TRONQUÉ, inégalement : le 31/08, northwind-sports a perdu 67 % de ses lignes et tw_uk 64 % de ses
-- vues, quand copper-kettle ne bougeait pas.
bornes as (
  select p_from as d_from,
         least(p_to, (current_date - 2)) as d_to,
         p_to as d_to_demande
),
-- Normalisation : retirer le schéma et l'hôte, RIEN D'AUTRE. Pas de `lower()` (aucun gain mesuré,
-- et harbor-tech a des chemins à majuscules significatives), pas de `rtrim(path,'/')` (la home
-- deviendrait la chaîne vide, qui se colle à tout). Un href relatif est rejeté ET compté.
cands as (
  select h as href,
         case when h like 'http://%' or h like 'https://%'
              then regexp_replace(h, '^https?://[^/]+', '')
         end as path
  from unnest(coalesce(p_hrefs, array[]::text[])) as h
),
sante as (
  select max(p.event_date) as max_event_date,
         count(*) filter (where p.event_date = (select d_to from bornes))       as rows_last_day,
         count(*) filter (where p.event_date = (select d_to from bornes) - 1)   as rows_prev_day
  from marts.pages_daily_clean p, cfg
  where p.site_slug = cfg.site_slug
    and p.event_date >= current_date - 30
),
vues as (
  -- ⛔ PAS DE `coalesce` ICI. C'est tout l'objet de cette migration : un groupe sans correspondance
  -- doit rendre `null`, pas `0`. Le zéro reste possible et reste vrai — il signifie alors « des
  -- lignes existent pour ce chemin et elles somment à zéro ».
  select c.href,
         c.path,
         sum(p.screen_page_views)::bigint as views
  from cands c
  left join marts.pages_daily_clean p
         on p.site_slug  = (select site_slug from cfg)
        and p.page_path  = c.path
        and p.event_date between (select d_from from bornes) and (select d_to from bornes)
  where c.path is not null
  group by c.href, c.path
)
select jsonb_build_object(
  -- ⛔ TROIS CAUSES DE ZÉRO, TROIS RAISONS DISTINCTES — et `matched = 0` reste un SUCCÈS.
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
  -- APPARIÉ, et non « lu ». Un candidat apparié mais jamais lu est une mesure ; un candidat jamais
  -- apparié est une absence de mesure. Les confondre était le défaut de 0046.
  'matched', (select count(*) from vues where views is not null),
  'views', coalesce((select jsonb_agg(jsonb_build_object('href', href, 'path', path, 'views', views)
                              order by views desc nulls last, href)
                     from vues), '[]'::jsonb)
);
$$;

-- `create or replace` conserve les droits existants, mais on les réaffirme : `create function`
-- accorde `execute` à `public` par défaut, et une `security definer` appelable par `anon` lirait
-- `marts` avec les droits du propriétaire.
reset check_function_bodies;
revoke execute on function newsletter.article_views(uuid, text[], date, date) from public;
grant  execute on function newsletter.article_views(uuid, text[], date, date) to service_role;

comment on function newsletter.article_views(uuid, text[], date, date) is
  'Les vues GA4 de N articles candidats, pour la propriété élue de la marque. Demande « les vues de ces candidats », jamais « classe-moi le site ». Borne la fenêtre à J-2 et rend la fenêtre EFFECTIVE. `views` vaut null quand AUCUNE ligne n''apparie le chemin — à ne pas confondre avec 0, qui est une mesure. `matched` compte les candidats appariés.';
