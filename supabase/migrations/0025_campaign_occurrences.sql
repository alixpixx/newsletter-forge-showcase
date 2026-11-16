-- ---------------------------------------------------------------------------
-- 0025 — Le calendrier des séries, en Postgres. UNE seule arithmétique.
-- ---------------------------------------------------------------------------
--
-- POURQUOI DANS LA BASE ET PAS EN TYPESCRIPT.
-- Deux consommateurs vont demander « quand cette série part-elle ? » : l'aperçu du wizard
-- (« Vos 5 prochains envois ») et le matérialiseur du worker qui crée réellement les occurrences.
-- S'ils calculent chacun de leur côté, ils divergeront — pas sur le cas normal, mais sur les
-- changements d'heure, où Node et Postgres n'embarquent ni la même tzdata ni la même version. Une
-- newsletter qui promet 10:00 à l'écran et part à 09:00 le dimanche du passage à l'heure d'hiver
-- n'est pas un bug qu'on découvre en test : on le découvre parce qu'un abonné le signale.
--
-- Donc : une fonction, une tzdata, une vérité. L'écran et le worker appellent la MÊME.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS : aucune table, aucune colonne, aucune donnée. Elle est
-- purement additive et n'a aucun effet sur le produit tant que personne ne l'appelle. Les tables
-- de série (`campaign_occurrence`) viennent au lot S-2.
--
-- CONVENTION DE JOUR : ISODOW — 1 = lundi … 7 = dimanche. Choisi contre `dow` (0 = dimanche) parce
-- que l'UI liste les jours du lundi au dimanche et qu'un décalage de convention entre la puce
-- cliquée et le jour calculé est l'erreur silencieuse type.

set search_path = newsletter, public;

-- ---------------------------------------------------------------------------
-- La fonction
-- ---------------------------------------------------------------------------
create or replace function newsletter.campaign_occurrences(
  p_days          int[],        -- jours ISO retenus : {1,5} = lundi et vendredi
  p_time          time,         -- heure LOCALE de départ (10:00), jamais UTC
  p_timezone      text,         -- fuseau IANA de l'édition ('America/Santiago')
  p_every_weeks   int,          -- 1 = toutes les semaines, 2 = une sur deux, 4 = une sur quatre
  p_anchor        date,         -- semaine de référence du « une sur N » (date de création du plan)
  p_from          timestamptz,  -- borne basse, incluse
  p_to            timestamptz,  -- borne haute, incluse
  p_limit         int default 200
)
returns table (
  local_date  date,          -- le jour LOCAL — c'est lui qui porte l'unicité d'une occurrence
  fires_at    timestamptz,   -- l'instant absolu de départ
  local_text  text,          -- ce que l'écran affiche : « 2026-09-07 10:00 -03 »
  utc_offset  interval       -- décalage appliqué ce jour-là ; rend le changement d'heure LISIBLE
)
language sql
stable
-- `search_path` figé : une fonction `stable` appelée par le worker ne doit pas dépendre du chemin
-- de recherche de l'appelant.
set search_path = newsletter, pg_catalog, public
as $$
  with bornes as (
    select
      -- Les bornes arrivent en absolu ; le balayage, lui, se fait en jours LOCAUX. Un jour de
      -- changement d'heure ne dure pas 24 h : générer des `timestamptz` de 24 h en 24 h sauterait
      -- ou dupliquerait une date. On génère donc des DATES locales, et on convertit ensuite.
      (p_from at time zone p_timezone)::date - 1 as d_debut,
      (p_to   at time zone p_timezone)::date + 1 as d_fin
  ),
  jours as (
    select generate_series(b.d_debut, b.d_fin, interval '1 day')::date as d
    from bornes b
  ),
  retenus as (
    select
      j.d,
      -- « Une semaine sur N » se compte en SEMAINES ISO pleines depuis l'ancre, jamais en jours :
      -- compter les jours ferait dériver la cadence dès qu'un jour de 23 h ou 25 h passe.
      floor(
        (j.d - date_trunc('week', p_anchor::timestamp)::date) / 7.0
      )::bigint as semaine
    from jours j
    where extract(isodow from j.d)::int = any (p_days)
  ),
  -- Un seul endroit où l'instant absolu est calculé. Le répéter dans le `select` et dans le `where`
  -- laisserait deux expressions à garder d'accord — et l'une des deux finirait par dériver.
  calcule as (
    select
      r.d as jour_demande,
      r.semaine,
      ((r.d + p_time) at time zone p_timezone) as instant
    from retenus r
  ),
  retenu as (
    select
      c.jour_demande,
      c.instant,
      -- Décalage réellement appliqué ce jour-là : -04:00 avant le 6 septembre au Chili, -03:00 après.
      (c.instant at time zone p_timezone) - (c.instant at time zone 'UTC') as decalage
    from calcule c
    where
      -- Le modulo sur les semaines : `((x % n) + n) % n` parce qu'une date ANTÉRIEURE à l'ancre donne
      -- un quotient négatif, et que `%` garde le signe du dividende en Postgres.
      (p_every_weeks <= 1 or ((c.semaine % p_every_weeks) + p_every_weeks) % p_every_weeks = 0)
      -- Filtre final en ABSOLU, sur les bornes reçues : le débordement de ±1 jour du balayage local
      -- est retaillé exactement, quel que soit le fuseau.
      and c.instant >= p_from
      and c.instant <= p_to
  )
  select
    -- Le jour DEMANDÉ (celui de la puce « lundi »), qui porte l'unicité de l'occurrence — et non la
    -- date relue depuis l'instant : les deux ne diffèrent que si une transition d'horloge poussait
    -- l'heure au-delà de minuit, ce qu'aucun fuseau IANA ne fait aujourd'hui, et `local_text`
    -- montrerait le débordement s'il survenait.
    t.jour_demande as local_date,
    t.instant as fires_at,
    -- ⛔ PAS de `to_char(timestamptz, 'TZH:TZM')` ici : `to_char` formate dans le fuseau de la
    -- SESSION, pas dans `p_timezone`. Mesuré le 20/08 — la session est en UTC, et cette écriture
    -- affichait « 2026-09-07 10:00 +00:00 » : l'heure chilienne collée au décalage de Greenwich.
    -- Un opérateur lisant ça programme son envoi avec trois heures d'erreur.
    to_char(t.instant at time zone p_timezone, 'YYYY-MM-DD HH24:MI')
      || ' '
      || (case when t.decalage < interval '0' then '-' else '+' end)
      || lpad((abs(extract(epoch from t.decalage))::int / 3600)::text, 2, '0')
      || ':'
      || lpad(((abs(extract(epoch from t.decalage))::int % 3600) / 60)::text, 2, '0') as local_text,
    t.decalage as utc_offset
  from retenu t
  order by t.instant
  limit greatest(p_limit, 0)
$$;

comment on function newsletter.campaign_occurrences(int[], time, text, int, date, timestamptz, timestamptz, int) is
  'Instants de départ d''une série. UNIQUE arithmétique de calendrier du produit : l''aperçu du wizard et le matérialiseur du worker appellent cette fonction, jamais leur propre calcul — sans quoi ils divergeraient sur les changements d''heure. Jours en ISODOW (1=lundi..7=dimanche). Ne lit aucune table.';

-- Lisible par l'application (clé de service) ; aucune écriture, aucune donnée touchée.
grant execute on function newsletter.campaign_occurrences(int[], time, text, int, date, timestamptz, timestamptz, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- Table de cas — exécutée le 20/08/2026 sur cette base, avant d'écrire la fonction.
-- ---------------------------------------------------------------------------
-- « lundi + vendredi, 10:00, America/Santiago », du 25/08 au 20/09/2026 :
--
--   date locale  jour  instant UTC        heure locale   offset
--   2026-08-28   Fri   2026-08-28 14:00   10:00          -04:00
--   2026-08-31   Mon   2026-08-31 14:00   10:00          -04:00
--   2026-09-04   Fri   2026-09-04 14:00   10:00          -04:00
--   2026-09-07   Mon   2026-09-07 13:00   10:00          -03:00   ← changement d'heure du 06/09
--   2026-09-11   Fri   2026-09-11 13:00   10:00          -03:00
--   2026-09-14   Mon   2026-09-14 13:00   10:00          -03:00
--   2026-09-18   Fri   2026-09-18 13:00   10:00          -03:00
--
-- ⇒ 10:00 LOCAL de part et d'autre de la transition ; c'est l'instant absolu qui bouge, pas la
--   promesse faite à l'abonné. Un calcul en UTC figé aurait envoyé à 09:00 locale à partir du 07/09.
--
-- « une semaine sur deux » (mêmes paramètres, p_every_weeks = 2) : semaines 2 et 4 retenues,
--   semaine 3 (07→11/09) sautée. 31/08, 04/09, 14/09, 18/09.
--
-- Cas dégénérés :
--   00:30 le 2026-09-06 (heure inexistante) → 2026-09-06 04:30 UTC, relu 01:30 locale.
--   23:30 le 2026-04-04 (heure ambiguë)     → 2026-04-05 03:30 UTC, offset -04 (seconde occurrence).
