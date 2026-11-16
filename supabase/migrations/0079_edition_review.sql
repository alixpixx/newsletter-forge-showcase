-- ============================================================================
-- 0079 — Relire une édition AVANT son envoi : introduction du modèle, articles du jour, sujet.
-- ============================================================================
--
-- ⭐ POURQUOI. Règle d'Alix (22/09/2026) : « je veux tout pouvoir modifier dans le builder ce que les
-- users vont recevoir sans exception !! ». Pour une édition de série, trois choses partaient sans que
-- personne puisse les lire ni les corriger (inventaire D101-D105) :
--   - l'introduction et l'accroche écrites par le modèle au gel (lecture seule, échec = trou muet) ;
--   - les articles du jour, figés ~90 min avant l'envoi : ni relecture, ni retrait, ni correction ;
--   - le sujet et le preheader, réglables par CAMPAGNE seulement, jamais par édition.
-- Décisions d'Alix (22/09) : tout est lisible ET modifiable avant l'envoi, sans validation obligatoire
-- (ce que personne ne touche part tel que généré), avec « Reset to AI version ».
--
-- ⛔ LA ROUTE DE L'ADMIN N'ÉCRIT QUE L'ÉCART, JAMAIS L'E-MAIL. Elle écrit `review_overrides` et
-- incrémente `review_rev` ; c'est le WORKER qui reconstruit l'édition (même fonction que le gel,
-- `@nf/edition`) et pose `review_applied_rev`. Une seconde compilation côté admin aurait fait deux
-- définitions du même e-mail — c'est exactement le défaut « l'e-mail ne ressemblait pas au builder ».
--
-- ⛔ JAMAIS D'ENVOI PÉRIMÉ : tant que `review_rev > review_applied_rev`, le fan-out refuse d'enfiler
-- l'édition (et sa prise `frozen → sending` est gardée par la révision lue). Une relecture enregistrée
-- une minute avant l'heure retarde l'envoi de quelques minutes ; elle ne part jamais « à moitié ».
--
-- Colonnes :
--   - `review_base`        : ce que le GEL a produit, avant toute relecture — le document déplié
--                            (articles du jour), l'en-tête de marque résolu, le shell avant preheader
--                            et UTM, sujet, preheader, textes du modèle. De quoi reconstruire SANS
--                            redemander à WordPress (il rendrait d'autres articles) ni au modèle.
--   - `review_overrides`   : l'ÉCART d'une relecture (une clé absente = la valeur du gel).
--   - `review_rev`         : révision de l'écart, incrémentée par chaque enregistrement.
--   - `review_applied_rev` : révision que le worker a reconstruite. En attente ⇔ rev > applied.
--   - `review_error`       : pourquoi la dernière relecture ne s'applique pas (affiché à l'écran).
--   - `review_updated_at` / `review_updated_by` : qui a relu, quand (l'audit détaillé est dans audit_log).
--
-- ⛔ ORDRE DE DÉPLOIEMENT : CETTE MIGRATION AVANT LE CODE. Le nouveau worker nomme ces colonnes dans le
-- gel (`review_base` écrit à chaque gel) et dans le fan-out (`review_rev` lu et gardé) : sans elles,
-- PostgREST refuse la lecture et plus aucune édition ne gèle ni ne part. L'admin les lit dans la liste
-- des éditions. L'inverse est sans danger : avec l'ancien code, ces colonnes ne sont lues par personne.
--
-- ⚠️ NUMÉRO 0079 : 0075 et 0076 appartiennent au lot « All brands / All templates », 0077 est
-- l'archivage de campagne, 0078 est réservé à un autre lot en cours. Ce fichier ne dépend d'aucun
-- d'eux et peut s'appliquer avant ou après eux.
--
-- ⚠️ Taille : `review_base` porte le shell (≈ 45 Ko mesurés sur les éditions envoyées le 22/09) et le
-- document déplié. Une ligne par édition, quelques éditions par semaine et par série : négligeable.
-- Pas d'index : la passe de relecture filtre `status = 'frozen'` (déjà servi par `idx_occurrence_due`),
-- et une édition ne reste gelée que ~90 minutes.

alter table newsletter.campaign_occurrence
  add column if not exists review_base jsonb,
  add column if not exists review_overrides jsonb,
  add column if not exists review_rev integer not null default 0,
  add column if not exists review_applied_rev integer not null default 0,
  add column if not exists review_error text,
  add column if not exists review_updated_at timestamptz,
  add column if not exists review_updated_by text;

comment on column newsletter.campaign_occurrence.review_base is
  'Ce que le gel a produit AVANT relecture (document deplie, en-tete de marque, shell avant preheader/UTM, '
  'sujet, preheader, textes du modele). Ecrit par le worker au gel. Base de toute reconstruction apres '
  'relecture : rien n''est redemande a WordPress ni au modele. Null = gele avant 0079 (non relisible).';

comment on column newsletter.campaign_occurrence.review_overrides is
  'Ecart d''une relecture d''edition (sujet, preheader, ai_intro, ai_preheader, articles caches/corriges). '
  'Ecrit par l''admin SEULEMENT ; le worker l''applique. Null = aucune relecture. Une cle absente = la valeur du gel.';

comment on column newsletter.campaign_occurrence.review_rev is
  'Revision de review_overrides, incrementee a chaque enregistrement (ecriture gardee par la revision lue).';

comment on column newsletter.campaign_occurrence.review_applied_rev is
  'Revision que le worker a reconstruite. review_rev > review_applied_rev = relecture en attente : le fan-out '
  'refuse d''enfiler l''edition tant que le worker ne l''a pas reconstruite.';

comment on column newsletter.campaign_occurrence.review_error is
  'Pourquoi la derniere relecture ne s''applique pas (null = appliquee, ou aucune). Affiche a l''ecran de relecture.';

-- ⛔ LA RÉVISION APPLIQUÉE NE DÉPASSE JAMAIS LA RÉVISION ÉCRITE. Le worker n'écrit que la révision
-- qu'il a LUE ; une valeur plus haute voudrait dire qu'on a « appliqué » une relecture qui n'existe
-- pas — et le fan-out laisserait partir la suivante sans reconstruction.
alter table newsletter.campaign_occurrence drop constraint if exists occurrence_review_rev_order;
alter table newsletter.campaign_occurrence
  add constraint occurrence_review_rev_order check (
    review_rev >= 0 and review_applied_rev >= 0 and review_applied_rev <= review_rev
  );

-- Les deux documents sont des OBJETS : un tableau ou un scalaire ne serait lu par personne (les deux
-- lecteurs rendent « aucune relecture ») et masquerait une écriture fautive.
alter table newsletter.campaign_occurrence drop constraint if exists occurrence_review_json_objects;
alter table newsletter.campaign_occurrence
  add constraint occurrence_review_json_objects check (
    (review_base is null or jsonb_typeof(review_base) = 'object')
    and (review_overrides is null or jsonb_typeof(review_overrides) = 'object')
  );

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE — DANS la migration (voir 0072).
-- ⛔ `add column if not exists` rend « success » même s'il n'a rien ajouté (schéma absent, colonne
-- homonyme d'un autre type). On relit le catalogue et on ÉCHOUE si la forme n'est pas celle que le
-- code suppose : types, nullabilité, défauts des deux révisions, et les deux contraintes posées.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select v.col, v.attendu, v.nullable, i.data_type, i.is_nullable, i.column_default
      from (values
              ('review_base', 'jsonb', 'YES'),
              ('review_overrides', 'jsonb', 'YES'),
              ('review_rev', 'integer', 'NO'),
              ('review_applied_rev', 'integer', 'NO'),
              ('review_error', 'text', 'YES'),
              ('review_updated_at', 'timestamp with time zone', 'YES'),
              ('review_updated_by', 'text', 'YES')
           ) as v(col, attendu, nullable)
      left join information_schema.columns i
        on i.table_schema = 'newsletter' and i.table_name = 'campaign_occurrence' and i.column_name = v.col
  loop
    if c.data_type is null then
      raise exception '[0079] campaign_occurrence n''a pas la colonne % apres execution', c.col;
    end if;
    if c.data_type <> c.attendu or c.is_nullable <> c.nullable then
      raise exception '[0079] campaign_occurrence.% n''a pas la forme attendue : type=%, nullable=% (attendu %, nullable=%)',
        c.col, c.data_type, c.is_nullable, c.attendu, c.nullable;
    end if;
    -- ⛔ Les révisions DOIVENT valoir 0 par défaut : le fan-out lit « rev > applied », et une ligne
    -- insérée sans défaut (gel d'avant ce code, matérialiseur) doit se lire « aucune relecture ».
    if c.col in ('review_rev', 'review_applied_rev') and coalesce(c.column_default, '') <> '0' then
      raise exception '[0079] campaign_occurrence.% doit valoir 0 par defaut (trouve : %)', c.col, c.column_default;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conname = 'occurrence_review_rev_order'
       and conrelid = 'newsletter.campaign_occurrence'::regclass
  ) then
    raise exception '[0079] la contrainte occurrence_review_rev_order est absente apres execution';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'occurrence_review_json_objects'
       and conrelid = 'newsletter.campaign_occurrence'::regclass
  ) then
    raise exception '[0079] la contrainte occurrence_review_json_objects est absente apres execution';
  end if;

  raise notice '[0079] contre-epreuve OK : 7 colonnes review_* de la bonne forme, revisions a 0 par defaut, 2 contraintes posees';
end
$$;

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0079', '0079_edition_review.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;

notify pgrst, 'reload schema';
