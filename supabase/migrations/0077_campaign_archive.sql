-- ============================================================================
-- 0077 — Archiver une campagne (newsletter) : la ranger ET la mettre hors d'état d'envoyer.
-- ============================================================================
--
-- ⭐ POURQUOI. Demande d'Alix (22/09/2026) : « sur chaque campagne un bouton archiver (avec un onglet
-- archive dans campagne) et quand on archive une campagne ca la met en pause (pause qu'on peut
-- reactiver dans la section archive) ». Deux colonnes, et deux seulement :
--   - `archived_at`     : null = la campagne est ACTIVE (liste principale) ; non null = rangée dans
--                         l'onglet « Archived », depuis cet instant ;
--   - `archived_resume` : CE QUE « Reactivate » DOIT RÉTABLIR, écrit au moment de l'archivage — le
--                         statut d'avant, la série qui tournait ou non, la date d'envoi retirée du
--                         calendrier, le nombre d'éditions annulées. Sans lui, la réactivation
--                         devrait DEVINER ce qui tournait avant, et elle devinerait mal : archiver
--                         remet un envoi programmé en brouillon et arrête la série.
--
-- ⛔ `archived_at` SEUL N'ARRÊTE RIEN. Le worker ne connaît que `campaignCanStillSend(status)`
-- (cancelled|paused) ; le gel et la mise en file ne lisaient pas cette colonne (elle n'existait pas).
-- Ce qui arrête un envoi, c'est la route d'archivage (arrêt de la série + annulation des éditions à
-- venir, ou retrait du calendrier d'un envoi unique) ; ce qui le GARANTIT, c'est la ceinture posée en
-- même temps dans le worker (`listArmedPlans`, le gel, les deux requêtes du fan-out ignorent une
-- campagne archivée). Les deux livrent ensemble, APRÈS ce fichier.
--
-- ⚠️ À NE PAS CONFONDRE AVEC `capture_campaign.archived_at` (0063) : celle-là range une campagne
-- d'ACQUISITION (écran Subscribers). Celle-ci range une campagne d'ENVOI de newsletter.
--
-- ⛔ ORDRE DE DÉPLOIEMENT : CETTE MIGRATION AVANT LE CODE. Le nouveau code nomme `archived_at` dans
-- `CAMPAIGN_SELECT` (toute lecture de campagne de l'admin) et dans les requêtes du worker : sans la
-- colonne, PostgREST refuse la lecture — l'écran Campagnes tombe et le planificateur lève à chaque
-- passe. L'inverse est sans danger : les deux colonnes, avec l'ancien code, ne sont lues par personne.
--
-- ⚠️ NUMÉRO 0077 : 0075 et 0076 appartiennent au lot « All brands / All templates » (branche
-- `users-acces-marques-templates-separes`), livré à part. Ce fichier ne dépend d'eux en rien et peut
-- s'appliquer avant ou après eux.
--
-- Pas d'index pour le filtre de liste : 12 campagnes au 22/09/2026, et `idx_campaign_asset` sert
-- déjà le `where asset_id = …` de la liste. Un index partiel sur `archived_at is null` paierait une
-- écriture de plus à chaque mise à jour de campagne pour trier une douzaine de lignes.

alter table newsletter.campaign
  add column if not exists archived_at timestamptz,
  add column if not exists archived_resume jsonb;

comment on column newsletter.campaign.archived_at is
  'Null = campagne ACTIVE. Non null = rangee dans l''onglet Archived depuis cet instant. Archiver arrete '
  'une serie en marche (et annule ses editions a venir) ou retire du calendrier un envoi unique programme '
  '(retour brouillon, verrou conserve) AVANT de poser cette date. Le worker ignore une campagne archivee '
  '(planification, gel, mise en file). A ne pas confondre avec capture_campaign.archived_at (0063).';

comment on column newsletter.campaign.archived_resume is
  'Ce que Reactivate retablit, ecrit a l''archivage : {"version":1, "previous_status", "series_running", '
  '"scheduled_at", "editions_cancelled"}. Null si et seulement si archived_at est null. La reactivation '
  'repasse par les memes refus que Start series (/arm) et Schedule (/schedule), jamais a cote.';

-- ⛔ LES DEUX COLONNES VONT ENSEMBLE. Une campagne archivée sans `archived_resume` ne saurait plus ce
-- qu'elle doit rétablir ; un `archived_resume` sans date décrirait un archivage qui n'existe pas. La
-- route les écrit dans la même instruction ; la contrainte rend l'écriture à moitié impossible.
alter table newsletter.campaign drop constraint if exists campaign_archive_pair;
alter table newsletter.campaign
  add constraint campaign_archive_pair check (
    (archived_at is null and archived_resume is null)
    or (archived_at is not null and jsonb_typeof(archived_resume) = 'object')
  );

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE — DANS la migration (voir 0072).
-- ⛔ `add column if not exists` rend « success » même s'il n'a rien ajouté (schéma absent, colonne
-- homonyme d'un autre type). On relit le catalogue et on ÉCHOUE si la forme n'est pas celle que le
-- code suppose : deux colonnes nullables, du bon type, et la contrainte de paire posée.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select v.col, v.attendu, i.data_type, i.is_nullable
      from (values ('archived_at', 'timestamp with time zone'), ('archived_resume', 'jsonb')) as v(col, attendu)
      left join information_schema.columns i
        on i.table_schema = 'newsletter' and i.table_name = 'campaign' and i.column_name = v.col
  loop
    if c.data_type is null then
      raise exception '[0077] campaign n''a pas la colonne % apres execution', c.col;
    end if;
    if c.data_type <> c.attendu or c.is_nullable <> 'YES' then
      raise exception '[0077] campaign.% n''a pas la forme attendue : type=%, nullable=% (attendu % nullable)',
        c.col, c.data_type, c.is_nullable, c.attendu;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conname = 'campaign_archive_pair'
       and conrelid = 'newsletter.campaign'::regclass
  ) then
    raise exception '[0077] la contrainte campaign_archive_pair est absente apres execution';
  end if;

  raise notice '[0077] contre-epreuve OK : campaign.archived_at timestamptz + archived_resume jsonb, paire contrainte';
end
$$;

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0077', '0077_campaign_archive.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;

notify pgrst, 'reload schema';
