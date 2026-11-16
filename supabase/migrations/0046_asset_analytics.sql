-- ⛔ NE PAS REJOUER — déjà appliquée. Rejouée, elle remet dans `article_views` le
-- `coalesce(sum(...), 0)` que 0047 a retiré : l'écran afficherait de nouveau « 0 views » pour des
-- articles jamais mesurés. Voir supabase/README.md (« Jamais `supabase db push` »).
--
-- ---------------------------------------------------------------------------
-- 0046 — L'audience d'un article : quelle propriété GA4 fait autorité, et comment on la lit.
-- ---------------------------------------------------------------------------
--
-- CE QUI MANQUAIT. L'admin affiche « most read is unavailable on these sites » parce que le plugin
-- `wordpress-popular-posts` n'est installé sur aucune des sources sondées. La donnée existe pourtant
-- — dans l'entrepôt data-warehouse, `marts.pages_daily_clean`, page × jour — et dans LA MÊME instance
-- Postgres que ce schéma. Il n'y a donc ni secret à ajouter ni appel réseau à faire : il manquait
-- seulement de savoir QUELLE propriété GA4 représente une marque, et un chemin de lecture fermé.
--
-- ⛔ POURQUOI UNE TABLE ET PAS UNE VARIABLE D'ENVIRONNEMENT. Cette correspondance est lue à DEUX
-- endroits : l'aperçu (admin) et le gel d'une occurrence (worker). Posée en variable, elle devrait
-- être écrite deux fois — et le jour où les deux divergent, l'aperçu montrerait un classement et
-- l'envoi en produirait un autre, sans que rien ne le signale puisque les deux « marchent ». C'est
-- de la donnée produit datée, pas un réglage de déploiement.
--
-- ⛔ UNE SEULE PROPRIÉTÉ PAR MARQUE, JAMAIS UNE SOMME. Mesuré : `northwind_sports_com_br` et son miroir
-- `www_northwind_sports_com_br_apostas_officiel` rendent des volumes quasi identiques sur 7 jours en
-- partageant 99,4 % de leurs chemins ; `atlas_review_br` et `atlas_review_apostas` sont à 99,8 % communs. Les
-- additionner double l'audience SANS faire apparaître le moindre doublon dans le classement, ni
-- manquer une ligne : le résultat reste parfaitement plausible. D'où la clé primaire sur `asset_id`,
-- qui rend la somme structurellement impossible plutôt que déconseillée.
--
-- ⚠️ `decided_at` N'EST PAS DÉCORATIF. Élire `harbor_tech_media` au lieu de `tw_uk` changerait tous
-- les classements à venir sans invalider les précédents — et personne ne saurait dire lesquels ont
-- été produits sous quelle élection. La date de décision est ce qui rend un classement passé
-- explicable ; sans elle, changer d'avis efface l'histoire en silence.
create table if not exists newsletter.asset_analytics (
  asset_id   uuid primary key references newsletter.asset(id) on delete cascade,
  -- Le `site_slug` de `marts.pages_daily_clean` / `marts.dim_sites`. Volontairement du texte libre :
  -- il n'y a AUCUNE clé étrangère possible vers `marts` (schéma d'un autre produit, dont le cycle de
  -- vie ne nous appartient pas). C'est précisément pourquoi le semis se vérifie par une MESURE
  -- (volume non nul sur 7 jours) et pas par une contrainte.
  site_slug  text not null,
  decided_at timestamptz not null default now(),
  decided_by text,
  note       text
);

comment on table newsletter.asset_analytics is
  'Quelle propriété GA4 (site_slug de marts) fait autorité pour une marque. UNE ligne par marque : la clé primaire sur asset_id rend la somme de deux propriétés impossible, parce que sommer double l''audience en gardant un classement plausible (northwind-sports : 99,4 % de chemins communs entre ses deux propriétés). Lue par l''aperçu ET par le gel, d''où une table plutôt qu''une variable d''environnement — deux variables divergentes feraient mentir l''aperçu sans erreur.';

comment on column newsletter.asset_analytics.decided_at is
  'Date de l''élection. Sans elle, changer de propriété rendrait tous les classements passés inexplicables : rien ne dirait lesquels ont été produits sous quelle élection.';

-- Même motif que 0041/0042 : RLS activé sans policy ⇒ muette pour anon/authenticated, seul
-- `service_role` la voit. Le jour où quelqu'un élargit un grant, la table reste fermée par défaut.
alter table newsletter.asset_analytics enable row level security;
grant select, insert, update, delete on newsletter.asset_analytics to service_role;

-- ---------------------------------------------------------------------------
-- Le semis : les quatre élections tranchées par Alix le 01/09/2026.
-- ---------------------------------------------------------------------------
--
-- Chacune a été mesurée le jour même sur `marts.pages_daily_clean` (7 jours) :
--   northwind_sports_com_br   écarte le miroir (99,4 % de chemins communs)
--   tw_uk                     écarte harbor_tech_media (volume moindre, 84 % de chemins communs)
--   copper-kettle             propriété unique, aucun arbitrage
--   atlas_review_br           écarte atlas_review_apostas (99,8 % de chemins communs)
--
-- ⚠️ `atlas_review_br` est un choix de MARCHÉ, pas de volume : `atlas_review_en` pèse plus du triple
-- sur la même semaine. L'élection dit « cette newsletter parle au Brésil », elle ne
-- dit pas « c'est la plus grosse propriété ». C'est exactement ce que `note` sert à conserver.
--
-- ⛔ goalpost-weekly et quartz-tips N'ONT PAS DE LIGNE, volontairement. La première n'émet plus rien
-- depuis le 16/08/2026 alors que son cron d'ingestion rapporte `success` avec `ga4_rows = 0` — un
-- voyant vert sur une source morte ; la seconde n'a jamais été raccordée à `dim_sites`. Leur semer
-- une ligne les ferait passer pour couvertes et transformerait « aucune propriété élue » en « aucun
-- article lu ». L'absence de ligne est l'information.
--
-- `on conflict do nothing` : rejouer la migration ne réécrit pas une élection qu'on aurait changée
-- depuis. Une modification se fait par un `update` explicite, jamais par un re-jeu de migration.
insert into newsletter.asset_analytics (asset_id, site_slug, decided_by, note)
select a.id, v.site_slug, 'alix (01/09/2026)', v.note
from (values
  ('northwind-sports',       'northwind_sports_com_br',   'Écarte www_northwind_sports_com_br_apostas_officiel : 99,4 % de chemins communs, le sommer doublerait l''audience.'),
  ('harbor-tech',    'tw_uk',           'Écarte harbor_tech_media (volume moindre sur 7 j, 84 % de chemins communs).'),
  ('copper-kettle', 'copper-kettle',    'Propriété unique : aucun arbitrage à faire.'),
  ('atlas-review', 'atlas_review_br', 'Choix de marché, pas de volume : atlas_review_en pèse plus du triple sur la même semaine. Écarte aussi atlas_review_apostas (99,8 % de chemins communs).')
) as v(slug, site_slug, note)
join newsletter.asset a on a.slug = v.slug
on conflict (asset_id) do nothing;

-- ---------------------------------------------------------------------------
-- `article_views` — les vues de N candidats, et de quoi refuser honnêtement.
-- ---------------------------------------------------------------------------
--
-- ⛔ POURQUOI UNE RPC ET PAS UN SECOND CLIENT `.schema("marts")`. Si `marts` sortait un jour de la
-- liste des schémas exposés par PostgREST — un réglage de projet, hors du dépôt et hors migration —
-- un client JS recevrait `PGRST106`, et tout appelant qui lit `data ?? []` transformerait cette panne
-- de configuration en « aucun article populaire ». Cette fonction ne dépend que de l'exposition de
-- `newsletter`, dont l'application entière dépend déjà : la panne devient impossible à confondre avec
-- un résultat vide.
--
-- ⛔ ON DEMANDE « LES VUES DE CES N CANDIDATS », JAMAIS « CLASSE-MOI LE SITE ». Le classement porte
-- sur les articles que le filtre de catégories a déjà retenus. C'est ce qui empêche `/`,
-- `/category/…` et `/guias/…` d'entrer — sur atlas-review, un top brut sort 19 pages de section sur
-- 20 — et c'est aussi le sens de jointure qui a été mesuré (33 articles sur 33 appariés). Coût
-- mesuré : 27 ms sur northwind-sports, le plus gros site, grâce à l'index couvrant (site_slug, page_path,
-- event_date).
--
-- ⚠️ LA VUE, PAS LA TABLE. `marts.pages_daily_clean` exclut les hôtes étrangers et de staging ;
-- `pages_daily_raw` réintroduirait les pages d'autres marques Example Media partageant le measurement ID.
-- Et le piège se referme dans les deux sens : la table porte une RLS deny-all quand la vue la
-- contourne — la même requête, avec la même clé, rend soit tout soit zéro ligne SANS le dire.
--
-- (Base neuve) L'entrepôt `marts` peut ne pas exister dans cette base : le corps n'est donc pas
-- validé à la création. Appelée sans `marts`, la fonction échoue et l'appelant affiche « non
-- mesuré » ; 0083 la fait lire `newsletter_ext.pages_daily_clean`, qui existe toujours.
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
-- vues, quand copper-kettle ne bougeait pas. Classer sur J−1 favoriserait silencieusement les
-- articles plus anciens. On borne donc — mais on rend `to_effective` pour que l'écran affiche la
-- fenêtre RÉELLEMENT couverte, jamais celle qu'on a demandée.
bornes as (
  select p_from as d_from,
         least(p_to, (current_date - 2)) as d_to,
         p_to as d_to_demande
),
-- Normalisation : retirer le schéma et l'hôte, RIEN D'AUTRE.
-- ⛔ Pas de `lower()` : mesuré, il n'apporte aucune correspondance supplémentaire (33/33 avec comme
--    sans) et harbor-tech sert des chemins à majuscules significatives (`/players/profiles/James.php`,
--    1 918 lignes) que la mise en minuscules fusionnerait en une seule ligne de classement.
-- ⛔ Pas de `rtrim(path,'/')` : appliqué à la page d'accueil il produit la chaîne VIDE, qui se colle
--    ensuite à tout chemin normalisé de la même façon — la home absorberait le classement en silence.
-- ⚠️ Un href RELATIF passe le schéma de validation (`/artigos/gestao-de-banca` est un `Href` valide)
--    et ne peut apparier aucun `page_path` complet. Il est donc rejeté EXPLICITEMENT et COMPTÉ :
--    sinon il disparaîtrait du classement sans que personne ne sache qu'il a existé.
cands as (
  select h as href,
         case when h like 'http://%' or h like 'https://%'
              then regexp_replace(h, '^https?://[^/]+', '')
         end as path
  from unnest(coalesce(p_hrefs, array[]::text[])) as h
),
-- Fenêtre large et indépendante de la demande : une source peut être muette depuis des semaines
-- alors que la fenêtre demandée, elle, est courte. C'est ce qui distingue « rien vu cette semaine »
-- de « cette propriété n'émet plus ».
sante as (
  select max(p.event_date) as max_event_date,
         count(*) filter (where p.event_date = (select d_to from bornes))       as rows_last_day,
         count(*) filter (where p.event_date = (select d_to from bornes) - 1)   as rows_prev_day
  from marts.pages_daily_clean p, cfg
  where p.site_slug = cfg.site_slug
    and p.event_date >= current_date - 30
),
vues as (
  select c.href,
         c.path,
         coalesce(sum(p.screen_page_views), 0)::bigint as views
  from cands c
  left join marts.pages_daily_clean p
         on p.site_slug  = (select site_slug from cfg)
        and p.page_path  = c.path
        and p.event_date between (select d_from from bornes) and (select d_to from bornes)
  where c.path is not null
  group by c.href, c.path
)
select jsonb_build_object(
  -- ⛔ TROIS CAUSES DE ZÉRO, TROIS RAISONS DISTINCTES. Une marque sans propriété élue, une propriété
  -- muette et un appariement vide rendent tous une liste vide ; un seul message pour les trois ferait
  -- accuser WordPress d'une panne d'analytics. Noter que `matched = 0` reste un SUCCÈS : c'est une
  -- mesure (« 0 de ces 12 articles n'a été vu »), pas une panne.
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
  'matched', (select count(*) from vues where views > 0),
  'views', coalesce((select jsonb_agg(jsonb_build_object('href', href, 'path', path, 'views', views)
                              order by views desc, href)
                     from vues), '[]'::jsonb)
);
$$;

comment on function newsletter.article_views(uuid, text[], date, date) is
  'Les vues GA4 de N articles candidats, pour la propriété élue de la marque. Demande « les vues de ces candidats », jamais « classe-moi le site » : le classement porte sur les articles déjà retenus par le filtre de catégories, ce qui exclut par construction la home et les pages de section. Borne la fenêtre à J-2 (l''ingestion s''arrête à J-1, et J-1 est tronqué de 60 à 70 % sur certaines marques) et rend la fenêtre EFFECTIVE. Distingue trois causes de zéro : no_property, source_silent, source_stale — matched=0 restant un succès.';

-- ⛔ `execute` EST ACCORDÉ À `public` PAR DÉFAUT SUR TOUTE FONCTION NEUVE. Sans cette révocation, une
-- fonction `security definer` serait appelable par `anon` : n'importe quel porteur de la clé publique
-- lirait l'audience de toutes les marques, avec les droits du propriétaire. Le `revoke` doit précéder
-- le `grant`, et il n'est pas une précaution — c'est ce qui ferme la porte que `create function` vient
-- d'ouvrir.
reset check_function_bodies;
revoke execute on function newsletter.article_views(uuid, text[], date, date) from public;
grant  execute on function newsletter.article_views(uuid, text[], date, date) to service_role;

notify pgrst, 'reload schema';
