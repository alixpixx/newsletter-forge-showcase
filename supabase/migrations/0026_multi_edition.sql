-- ---------------------------------------------------------------------------
-- 0026 — E-1 : plusieurs newsletters et plusieurs listes par domaine
-- ---------------------------------------------------------------------------
--
-- DÉCISION D'ALIX (20/08/2026), mot pour mot :
--   « les newsletters elles-mêmes ne seront pas multi-langue car pour atlas-review et harbor-tech les sections
--    dans d'autres langages, par exemple atlas-review.example/cl/, auront leur propre liste de mail et
--    leur propre newsletter. Il faut juste prévoir que le même domaine peut avoir plusieurs
--    newsletters et listes différentes par langue. »
--
-- Autrement dit : la granularité de travail n'est plus la MARQUE, c'est l'ÉDITION. Une personne
-- doit pouvoir être abonnée à `atlas-review.example` en portugais ET à `atlas-review.example/cl/` en
-- espagnol, avec deux consentements distincts et deux désabonnements distincts.
--
-- ⛔ LE VERROU. `subscription` porte `unique (subscriber_id, asset_id)` : cette contrainte interdit
-- exactement ce cas. C'est le seul obstacle de schéma ; le reste du modèle était déjà prêt
-- (`asset_edition` unique par (asset, marché, langue), `subscription.edition_id` existe,
-- `outbox_context` choisit déjà l'édition par destinataire).
--
-- ÉTAT MESURÉ SUR LA BASE AVANT D'ÉCRIRE (20/08/2026) :
--   · 1 203 souscriptions, dont **0** sans `edition_id` ;
--   · **0** doublon (subscriber_id, edition_id) — la contrainte cible est satisfaite dès maintenant ;
--   · **0** ligne où `edition_id` désigne une édition d'une autre marque ;
--   · 9 éditions pour 9 marques : aucune marque n'en a encore deux.
-- Cette migration n'invalide donc aucune ligne existante et ne change aucun comportement tant
-- qu'une deuxième édition n'est pas créée.
--
-- ⚠️ ORDRE DE DÉPLOIEMENT : cette migration est sûre AVANT comme APRÈS le code qui l'accompagne.
-- Appliquée seule, l'ancien code continue de fonctionner (une seule édition par marque, donc
-- `(subscriber_id, asset_id)` reste de facto unique). Déployé seul, le nouveau code fonctionne
-- aussi (il cible `edition_id`, déjà renseignée partout). Aucun ordre n'est imposé.

set search_path = newsletter, public;

-- ---------------------------------------------------------------------------
-- 1. Nommer les éditions — `slug` et `is_primary`
-- ---------------------------------------------------------------------------
-- POURQUOI UN SLUG. Le widget public doit pouvoir viser une édition :
-- `/embed/atlas-review?edition=cl`. Sans slug, il faudrait mettre un UUID dans une URL publique —
-- illisible, impossible à écrire à la main, et qui expose un identifiant interne dans du HTML
-- collé sur un site tiers.
alter table newsletter.asset_edition add column if not exists slug text;

-- POURQUOI UNE ÉDITION PRIMAIRE. `signup` lit aujourd'hui l'édition par
-- `.eq(asset_id).limit(1).maybeSingle()` — SANS `order by`. Avec une seule édition c'est correct
-- par accident ; avec deux, Postgres est libre de rendre l'une ou l'autre, et la même personne
-- pourrait atterrir dans la liste espagnole un jour et portugaise le lendemain. Le défaut doit
-- être DÉCLARÉ, pas tiré au sort.
alter table newsletter.asset_edition add column if not exists is_primary boolean not null default false;

-- Backfill : slug dérivé de la langue (« pt-BR » → « pt-br »), à renommer par l'opérateur pour les
-- sections qui ne sont pas des langues (`/cl/` est un marché). Fait uniquement là où c'est vide.
--
-- ⛔ POURQUOI PAS LA LANGUE SEULE. Le premier jet écrivait `lower(language)` sans plus. Or ce
-- backfill est suivi, quelques lignes plus bas, d'un `unique (asset_id, slug)` : deux éditions
-- d'une même marque qui ne diffèrent que par le MARCHÉ — une brésilienne et une portugaise, toutes
-- deux en `pt-BR` — auraient reçu le même slug, et la CRÉATION DE LA CONTRAINTE aurait échoué. La
-- migration ne serait pas passée du tout, sur un environnement où personne n'aurait compris
-- pourquoi. Sans effet aujourd'hui (aucune marque n'a deux éditions), armé pour le jour où.
--
-- La règle : la langue seule quand elle suffit — ce qui laisse les slugs actuels INCHANGÉS, et ils
-- servent d'URL publique (`/embed/atlas-review?edition=cl`) — et `langue-marché` en cas de
-- collision. Cette forme-là est toujours unique, puisque `(asset_id, market, language)` l'est déjà.
update newsletter.asset_edition e
   set slug = case
                when (
                  select count(*)
                    from newsletter.asset_edition x
                   where x.asset_id = e.asset_id
                     and lower(replace(x.language, '_', '-')) = lower(replace(e.language, '_', '-'))
                ) > 1
                then lower(replace(e.language, '_', '-')) || '-' || lower(e.market)
                else lower(replace(e.language, '_', '-'))
              end
 where e.slug is null or e.slug = '';

-- La PLUS ANCIENNE édition de chaque marque devient la primaire : c'est celle sur laquelle les
-- 1 203 souscriptions existantes ont été créées, donc le seul choix qui ne déplace personne.
with premiere as (
  select distinct on (asset_id) id
    from newsletter.asset_edition
   order by asset_id, created_at, id
)
update newsletter.asset_edition e
   set is_primary = true
  from premiere p
 where e.id = p.id
   and not exists (
     select 1 from newsletter.asset_edition x
      where x.asset_id = e.asset_id and x.is_primary
   );

alter table newsletter.asset_edition alter column slug set not null;

-- ⚠️ CE QUE LE BACKFILL VA GRAVER, ET QUI MÉRITE UNE RELECTURE (mesuré le 20/08/2026)
--
--   marque             marché  langue  → slug   abonnés
--   quartz-tips         BR      pt-BR     pt-br    1 200
--   atlas-review       INT     it        it           1   ← voir ci-dessous
--   northwind-sports             BR      pt-BR     pt-br        2
--   copper-kettle       CL      es        es           0
--   harbor-tech          GB      en        en           0
--   goalpost-weekly  GB      en        en           0
--   lumen-living / pixel-daily / bluefin-news  BR   pt-BR  pt-br  0
--
-- ⛔ **Atlas Review est déclarée en ITALIEN** (`market=INT`, `language=it`). Ce n'est pas une
-- coquille : le seed a pris le PREMIER élément de `languages: ["it","fr","pt-BR","es","en"]` du
-- registre `@nf/config`. Or la racine du site publie en portugais — mesuré par la sonde WordPress
-- le 20/08 : catégories « Palpites de hoje », « Notícias », « Brasileirão ». Marquer cette édition
-- `is_primary` GRAVE donc un défaut existant : un nouvel inscrit sans édition précisée atterrit
-- dans une liste italienne. Le comportement est déjà celui-là aujourd'hui (`limit(1)` sans ordre),
-- mais il devient une décision affichée.
--
-- ⇒ ARBITRAGE À RENDRE AVANT D'APPLIQUER : soit corriger l'édition existante, soit créer les
-- éditions réelles et déplacer la primaire. Les racines REST réellement exposées par le site,
-- mesurées : `/` (portugais), `/en/`, `/fr/`. Plus `/cl/`, annoncée par Alix.
--
--   -- Corriger l'édition existante (elle porte 1 abonné) :
--   -- update newsletter.asset_edition e set market = 'BR', language = 'pt-BR', slug = 'pt-br',
--   --        timezone = 'America/Sao_Paulo', compliance_regime = 'lgpd'
--   --   from newsletter.asset a where a.id = e.asset_id and a.slug = 'atlas-review';
--
-- Le même raisonnement vaut pour Harbor Tech (`languages: ["en","it","es","sv"]`, une seule édition
-- `en/GB`) — mais là le seed a choisi la bonne.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'asset_edition_asset_slug_uk'
       and conrelid = 'newsletter.asset_edition'::regclass
  ) then
    alter table newsletter.asset_edition
      add constraint asset_edition_asset_slug_uk unique (asset_id, slug);
  end if;
end $$;

-- UNE seule primaire par marque. Index partiel : il n'interdit rien aux éditions secondaires.
create unique index if not exists asset_edition_one_primary
  on newsletter.asset_edition (asset_id) where is_primary;

comment on column newsletter.asset_edition.slug is
  'Identifiant lisible de l''édition dans les URL publiques (/embed/atlas-review?edition=cl). Rempli par défaut depuis la langue ; à renommer quand la section est un marché et non une langue.';
comment on column newsletter.asset_edition.is_primary is
  'Édition retenue quand l''appelant n''en précise aucune. Exactement une par marque (index partiel asset_edition_one_primary). Remplace un `limit(1)` sans `order by`, qui aurait tiré l''édition au sort dès la deuxième.';

-- ---------------------------------------------------------------------------
-- 2. L'unicité composite dont dépendent les clés étrangères
-- ---------------------------------------------------------------------------
-- Identique au bloc de 0024, volontairement REJOUÉ ici : les deux migrations en ont besoin et
-- aucune ne doit dépendre de l'ordre dans lequel l'autre est appliquée. `if not exists` le rend
-- idempotent.
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
-- 3. `subscription` — lever le verrou
-- ---------------------------------------------------------------------------

-- 3a. La clé étrangère devient COMPOSITE.
--
-- Elle garantit ce que la FK simple ne garantissait pas : que l'édition appartient bien à la marque
-- de la souscription. Sans elle, rien n'empêche d'abonner quelqu'un à l'édition chilienne de
-- Atlas Review sur une ligne dont `asset_id` désigne Harbor Tech — et ce sont deux listes, deux
-- consentements, deux régimes légaux.
--
-- ⚠️ On REMPLACE la FK simple au lieu d'en ajouter une seconde. Deux clés étrangères entre les
-- mêmes tables rendent l'agrégation PostgREST ambiguë (« more than one relationship found »), et
-- casseraient toute requête `subscription → asset_edition` écrite plus tard.
--
-- `MATCH SIMPLE` (le défaut) : une ligne dont `edition_id` est nul satisfait la contrainte. Les
-- souscriptions sans édition — il n'y en a aucune aujourd'hui — restent donc valides.
alter table newsletter.subscription drop constraint if exists subscription_edition_id_fkey;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'subscription_edition_fk'
       and conrelid = 'newsletter.subscription'::regclass
  ) then
    alter table newsletter.subscription
      add constraint subscription_edition_fk
      foreign key (edition_id, asset_id)
      references newsletter.asset_edition (id, asset_id);
  end if;
end $$;

-- 3b. LE changement : une souscription par (personne, ÉDITION), plus par (personne, marque).
alter table newsletter.subscription
  drop constraint if exists subscription_subscriber_id_asset_id_key;

-- Deux index partiels plutôt qu'une contrainte unique simple, parce qu'une contrainte unique
-- traite chaque NULL comme distinct : `unique (subscriber_id, edition_id)` seule laisserait
-- créer autant de lignes sans édition qu'on veut pour la même personne et la même marque — soit
-- exactement le doublon qu'on vient de passer une migration à empêcher.
create unique index if not exists subscription_subscriber_edition_uk
  on newsletter.subscription (subscriber_id, edition_id)
  where edition_id is not null;

-- Le filet pour les lignes sans édition : elles gardent l'ancienne règle, une par marque.
create unique index if not exists subscription_subscriber_asset_no_edition_uk
  on newsletter.subscription (subscriber_id, asset_id)
  where edition_id is null;

-- 3c. Les lectures deviennent « par édition ». Tous les index existants portent sur `asset_id`
-- (idx_sub_asset_status, _country, _source, _level, _engagement) : sans celui-ci, la sélection
-- d'audience d'une série ferait un parcours complet dès la deuxième édition d'une marque.
create index if not exists idx_sub_edition_status
  on newsletter.subscription (edition_id, status);

comment on index newsletter.subscription_subscriber_edition_uk is
  'Une souscription par (personne, édition) — remplace unique (subscriber_id, asset_id), qui interdisait d''être abonné à deux éditions du même domaine (atlas-review.example et atlas-review.example/cl/).';
comment on index newsletter.subscription_subscriber_asset_no_edition_uk is
  'Filet pour les souscriptions sans édition : elles gardent l''ancienne règle (une par marque). Sans lui, les NULL — tous distincts pour une contrainte unique — laisseraient passer des doublons.';

-- ---------------------------------------------------------------------------
-- 4. Ajouter une édition — le geste, écrit ici pour ne pas l'inventer plus tard
-- ---------------------------------------------------------------------------
-- ⛔ AUCUNE ÉDITION N'EST CRÉÉE PAR CETTE MIGRATION. Une édition seedée est une liste vide qui
-- apparaît dans l'interface et qu'on croira active ; quelle langue, quel marché, quel régime et
-- quel fuseau sont des décisions produit, pas des valeurs par défaut.
--
-- Les sections RÉELLEMENT exposées par atlas-review.example, mesurées par la sonde WordPress le
-- 20/08/2026 : trois racines REST — `/` (portugais), `/en/`, `/fr/`. Chacune peut devenir une
-- édition avec sa liste et sa newsletter ; `/cl/` s'y ajoutera.
--
-- Le geste, quand la section chilienne de Atlas Review ouvrira :
--
--   insert into newsletter.asset_edition
--     (asset_id, slug, market, language, compliance_regime, timezone, consent_mode, is_primary)
--   select id, 'cl', 'CL', 'es-CL', 'gdpr', 'America/Santiago', 'granular', false
--     from newsletter.asset where slug = 'atlas-review';
--
-- Puis la source WordPress correspondante (migration 0024), qui pointe la racine REST de la
-- section — `https://atlas-review.example/cl` — et non le domaine nu :
--
--   insert into newsletter.wp_source (edition_id, asset_id, label, rest_root)
--   select e.id, e.asset_id, 'Atlas Review · CL', 'https://atlas-review.example/cl'
--     from newsletter.asset_edition e
--     join newsletter.asset a on a.id = e.asset_id
--    where a.slug = 'atlas-review' and e.slug = 'cl';
--
-- ⚠️ `compliance_regime` de l'édition chilienne : la Ley 21.719 impose le consentement explicite et
-- interdit les cases pré-cochées — d'où `consent_mode = 'granular'`, comme les autres marchés à
-- consentement (DE, FR, IT, ES, CL, CO, IN).
