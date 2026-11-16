-- ---------------------------------------------------------------------------
-- 0027 — La campagne devient un PLAN ; l'occurrence porte son propre contenu.
-- ---------------------------------------------------------------------------
--
-- LE DÉFAUT QUE CETTE MIGRATION EXISTE POUR RENDRE IMPOSSIBLE.
--
-- Aujourd'hui `/lock` COPIE le HTML compilé dans `campaign.html_shell` et rien ne le re-résout
-- jamais (`lock/route.ts:78-82`). C'est exactement ce qu'il faut pour un envoi ponctuel : le
-- contenu est figé, l'envoi est déterministe, un template republié ne change pas ce qui part.
--
-- Mais si l'on branchait une cadence sur CETTE structure, une série hebdomadaire de huit
-- occurrences enverrait huit fois les articles de la semaine 1. Le défaut ne se verrait pas au
-- premier envoi : il apparaîtrait le vendredi suivant, chez de vrais abonnés, et une semaine plus
-- tard encore. Un `html_shell` unique et une cadence sont incompatibles, point.
--
-- DONC : **une occurrence naît avec son PROPRE porteur de contenu**, jamais avec un pointeur vers
-- le shell partagé du plan. C'est le point de non-retour d'architecture de tout ce chantier.
--
-- ⚠️ MIGRATION ADDITIVE. `campaign.html_shell` et ses voisines RESTENT : tout le code actuel les
-- lit, et une migration qui casse l'envoi ponctuel pour préparer le récurrent est un mauvais
-- échange. Elles deviennent le miroir de l'occurrence n°1 ; la bascule des lecteurs se fait au lot
-- S-4, quand le matérialiseur existe. Tant qu'aucune série n'est armée, cette table est une table
-- vide et le produit se comporte exactement comme avant.
--
-- ⛔ RIEN N'EST ARMÉ ICI. `recurrence_active` naît à `false` sur chaque ligne, sans exception :
-- une migration qui laisserait une cadence active créerait des occurrences dès le premier tick du
-- worker, sur des campagnes que personne n'a converties en série.

set search_path = newsletter, public;

-- ---------------------------------------------------------------------------
-- 1. Le PLAN — ce qui décrit la série, pas ce qui part
-- ---------------------------------------------------------------------------

alter table newsletter.campaign
  -- Édition d'appartenance. E-1 (0026) a rendu les éditions réelles : une série en espagnol tire
  -- ses abonnés, son fuseau et son footer de l'édition CL, pas de la marque en général.
  add column if not exists edition_id uuid,

  -- FUSEAU COPIÉ SUR LE PLAN, PAS LU À TRAVERS L'ÉDITION.
  -- Il serait tentant de résoudre `edition.timezone` à chaque calcul. Le jour où quelqu'un corrige
  -- le fuseau d'une édition, toutes les séries déjà planifiées se déplaceraient en silence — y
  -- compris celles dont les abonnés ont pris l'habitude de l'horaire. Le fuseau est une propriété
  -- de la PROMESSE faite à l'abonné : il se copie, et se change explicitement.
  add column if not exists timezone text,

  -- Cadence. `null` sur `recurrence_days` = campagne PONCTUELLE : c'est le cas de toutes les
  -- lignes existantes, et le défaut pour toute nouvelle campagne.
  add column if not exists recurrence_days smallint[],
  add column if not exists recurrence_time time,
  add column if not exists recurrence_every_weeks smallint not null default 1,
  add column if not exists recurrence_anchor date,
  add column if not exists recurrence_until date,

  -- ⛔ L'INTERRUPTEUR. Une série n'existe pour le matérialiseur que si ceci est vrai.
  add column if not exists recurrence_active boolean not null default false,

  -- Minutes entre le gel du contenu et l'envoi. 90 par défaut : assez pour qu'un humain voie
  -- l'alerte d'empreinte identique (S-5) et republie, trop court pour que le contenu vieillisse.
  -- Stocké, pas codé en dur : une quotidienne à 06:00 ne peut pas geler à 04:30 sans que
  -- quelqu'un l'ait décidé.
  add column if not exists freeze_lead_minutes int not null default 90;

-- FK COMPOSITE, comme pour `subscription` (0026) : elle interdit de rattacher une campagne à
-- l'édition d'une AUTRE marque. Une FK simple vers `asset_edition(id)` laisserait passer un plan
-- brésilien pointant l'édition chilienne — et personne ne le verrait avant l'envoi.
-- ⚠️ DÉPEND DE 0026, qui crée `asset_edition_id_asset_uk unique (id, asset_id)` : une FK composite
-- exige une contrainte unique sur exactement ces colonnes. Le test porte sur le NOM de cette
-- contrainte plutôt que sur sa forme — c'est vérifiable d'un coup d'œil, là où une comparaison de
-- `conkey` est le genre de code qu'on croit juste jusqu'au jour où il ne l'est pas.
-- ⛔ DEUX SITUATIONS QUE LE PREMIER JET CONFONDAIT. Une seule branche `else` couvrait à la fois
-- « 0026 n'a pas été appliquée » et « la clé est déjà posée », avec un `raise notice` pour les
-- deux. Or la première est une PANNE — la migration sort en succès sans la clé étrangère, donc
-- sans la garde qui empêche une campagne brésilienne de pointer l'édition chilienne — et la
-- seconde est un rejeu parfaitement normal. Un témoin vert sur une panne est pire que pas de
-- témoin du tout : ici, la base actuelle porte bien la clé, mais le prochain environnement
-- l'aurait perdue en silence.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'asset_edition_id_asset_uk') then
    raise exception
      'campaign_edition_fk impossible : asset_edition_id_asset_uk est absente. Appliquer 0026 avant 0027.';
  end if;

  -- Le rejeu, lui, ne dit rien et ne fait rien : c'est ce qu'on attend d'une migration idempotente.
  if not exists (select 1 from pg_constraint where conname = 'campaign_edition_fk') then
    alter table newsletter.campaign
      add constraint campaign_edition_fk
      foreign key (edition_id, asset_id) references newsletter.asset_edition (id, asset_id);
  end if;
end $$;

-- Cadence COHÉRENTE ou absente — jamais à moitié remplie.
-- Sans cette contrainte, une série avec des jours mais sans heure serait acceptée, et le
-- matérialiseur devrait inventer un horaire. Il inventerait minuit.
alter table newsletter.campaign drop constraint if exists campaign_recurrence_complete;
alter table newsletter.campaign
  add constraint campaign_recurrence_complete check (
    (recurrence_days is null and recurrence_time is null)
    or (
      recurrence_days is not null
      and recurrence_time is not null
      and timezone is not null
      and array_length(recurrence_days, 1) between 1 and 7
      and recurrence_anchor is not null
    )
  );

-- Jours en ISODOW (1 = lundi … 7 = dimanche), comme `campaign_occurrences` (0025). Un décalage de
-- convention entre la puce cliquée et le jour calculé est l'erreur silencieuse type.
-- ⚠️ PAS de vérification d'unicité des jours ici : un CHECK ne peut pas contenir de sous-requête
-- (Postgres le refuse à la création). Ce n'est pas une lacune — un doublon `{1,1,5}` produirait
-- deux fois le même jour local, et c'est exactement ce que la clé `(campaign_id, local_date)`
-- de `campaign_occurrence` interdit plus bas. La garde existe, elle est juste posée là où elle
-- protège vraiment : sur ce qui part, pas sur ce qui est saisi.
alter table newsletter.campaign drop constraint if exists campaign_recurrence_days_valid;
alter table newsletter.campaign
  add constraint campaign_recurrence_days_valid check (
    recurrence_days is null or recurrence_days <@ array[1,2,3,4,5,6,7]::smallint[]
  );

alter table newsletter.campaign drop constraint if exists campaign_every_weeks_valid;
alter table newsletter.campaign
  add constraint campaign_every_weeks_valid check (recurrence_every_weeks between 1 and 8);

-- ⛔ Une cadence ARMÉE doit être complète. Sans ça, `recurrence_active = true` sur une campagne
-- ponctuelle serait accepté et le matérialiseur balaierait des lignes qu'il ne sait pas traiter.
alter table newsletter.campaign drop constraint if exists campaign_active_needs_recurrence;
alter table newsletter.campaign
  add constraint campaign_active_needs_recurrence check (
    recurrence_active = false or recurrence_days is not null
  );

comment on column newsletter.campaign.html_shell is
  'Contenu figé de l''occurrence n°1 (campagne ponctuelle). ⚠️ DÉPRÉCIÉ pour les séries : à partir du lot S-4, la vérité est campaign_occurrence.html_shell. Un shell unique partagé par N occurrences renverrait N fois le contenu de la première.';

-- ---------------------------------------------------------------------------
-- 2. L'OCCURRENCE — un envoi, un contenu, une date
-- ---------------------------------------------------------------------------

create table if not exists newsletter.campaign_occurrence (
  id                  uuid primary key default gen_random_uuid(),
  campaign_id         uuid not null references newsletter.campaign(id) on delete cascade,
  -- Dénormalisé DEPUIS le plan : les lectures du worker filtrent par marque avant tout, et une
  -- jointure sur chaque tick pour retrouver une valeur qui ne change jamais est du gaspillage.
  asset_id            uuid not null references newsletter.asset(id) on delete cascade,

  -- Numéro lisible (« édition n° 7 »). Stable : une occurrence annulée garde son numéro, et le
  -- suivant ne le réutilise pas — sinon deux e-mails différents porteraient le même nom.
  seq                 int not null,

  /*
   * JOUR LOCAL de l'envoi — c'est LUI qui porte l'unicité, pas l'instant absolu.
   *
   * Le vendredi 10:00 à Santiago tombe à 13:00 ou 14:00 UTC selon la saison. Deux occurrences du
   * même vendredi local seraient deux instants différents et passeraient une unicité posée sur
   * `scheduled_at` ; l'abonné, lui, recevrait deux fois la newsletter du vendredi.
   *
   * `null` = occurrence NON DATÉE (le brouillon ponctuel d'aujourd'hui). On n'invente pas une date
   * d'envoi pour un brouillon.
   */
  local_date          date,
  scheduled_at        timestamptz,

  status              text not null default 'planned'
                        check (status in ('planned','frozen','sending','sent','cancelled','held','failed')),
  /*
   * POURQUOI cette occurrence est retenue. Obligatoire dès que `status = 'held'`.
   * « held » sans raison ne dit rien à celui qui découvre l'écran le lendemain matin : contenu
   * périmé ? empreinte identique à la précédente ? segment vide ? Trois causes, trois gestes.
   */
  hold_reason         text,

  -- ⭐ LE PORTEUR DE CONTENU PROPRE À CETTE OCCURRENCE. Voir l'en-tête du fichier.
  html_shell          text,
  text_shell          text,
  size_bytes          int,
  subject             text not null default '',
  preheader           text,

  /*
   * EMPREINTE du contenu figé — préparée ici, exploitée au lot S-5.
   * Comparée à la dernière occurrence RÉELLEMENT ENVOYÉE : identique ⇒ on n'envoie pas deux fois
   * le même e-mail sous deux dates différentes.
   */
  content_sha256      text,

  template_version_id uuid references newsletter.template_version(id) on delete set null,
  segment_id          uuid references newsletter.segment(id) on delete set null,

  frozen_at           timestamptz,
  locked_at           timestamptz,
  sent_at             timestamptz,
  recipients_planned  int,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Une occurrence retenue DOIT dire pourquoi.
  constraint occurrence_held_needs_reason check (status <> 'held' or hold_reason is not null),
  -- Une occurrence datée porte les DEUX dates ou aucune : `local_date` sans instant est
  -- inenvoyable, et un instant sans jour local échappe à la clé d'unicité qui compte.
  constraint occurrence_dates_together check (
    (local_date is null and scheduled_at is null) or (local_date is not null and scheduled_at is not null)
  )
);

/*
 * CLÉ 1 — UN ENVOI PAR JOUR LOCAL. C'est elle qui empêche le double envoi quand on change la
 * cadence en cours de route : passer de « vendredi » à « lundi + vendredi » recalcule la série, et
 * le matérialiseur retombe sur des jours déjà planifiés. Sans cette clé, il les recréerait.
 *
 * Les annulées sont hors du filet : ré-planifier un vendredi qu'on avait annulé est légitime.
 */
create unique index if not exists occurrence_campaign_local_date_uk
  on newsletter.campaign_occurrence (campaign_id, local_date)
  where local_date is not null and status <> 'cancelled';

/* CLÉ 2 — la numérotation est unique par plan : « édition n° 7 » ne désigne qu'un seul e-mail. */
create unique index if not exists occurrence_campaign_seq_uk
  on newsletter.campaign_occurrence (campaign_id, seq);

/*
 * CLÉ 3 — UNE SEULE OCCURRENCE EN VOL PAR PLAN.
 *
 * Deux occurrences d'une même série en `sending` simultanément, c'est un envoi qui a débordé sur
 * le suivant : la charge double, les deux tirent le même segment, et un abonné peut recevoir les
 * deux à quelques minutes d'intervalle. Le cas arrive tout seul — un envoi lent, une cadence
 * quotidienne — et il ne se voit qu'après. La base le refuse.
 */
create unique index if not exists occurrence_one_in_flight_uk
  on newsletter.campaign_occurrence (campaign_id)
  where status = 'sending';

-- Le balayage du matérialiseur : « qu'est-ce qui doit partir bientôt ? »
create index if not exists idx_occurrence_due
  on newsletter.campaign_occurrence (scheduled_at)
  where status in ('planned','frozen');

create index if not exists idx_occurrence_asset
  on newsletter.campaign_occurrence (asset_id, scheduled_at desc);

-- Recherche de la dernière occurrence envoyée (comparaison d'empreinte, lot S-5).
create index if not exists idx_occurrence_sent
  on newsletter.campaign_occurrence (campaign_id, sent_at desc)
  where status = 'sent';

alter table newsletter.campaign_occurrence enable row level security;
grant all on newsletter.campaign_occurrence to service_role;

comment on table newsletter.campaign_occurrence is
  'Un envoi d''une campagne. Porte SON PROPRE contenu figé : un shell partagé entre occurrences renverrait N fois le contenu de la première. L''unicité qui compte est (campaign_id, local_date) — le jour LOCAL, pas l''instant absolu, qui varie avec les changements d''heure.';

-- ---------------------------------------------------------------------------
-- 3. L'outbox sait de quelle occurrence elle vient
-- ---------------------------------------------------------------------------

alter table newsletter.email_outbox
  add column if not exists occurrence_id uuid references newsletter.campaign_occurrence(id) on delete set null;

create index if not exists idx_outbox_occurrence
  on newsletter.email_outbox (occurrence_id) where occurrence_id is not null;

comment on column newsletter.email_outbox.occurrence_id is
  'Occurrence d''origine. Reste NULL tant que le matérialiseur (S-4) n''envoie pas : « select count(*) where occurrence_id is not null » est justement le contrôle qui prouve qu''une série se remplit sans qu''un seul e-mail parte.';

-- ---------------------------------------------------------------------------
-- 4. Fuseau des campagnes existantes
-- ---------------------------------------------------------------------------
--
-- On prend l'édition la PLUS ANCIENNE de la marque — la même définition que le backfill
-- `is_primary` de 0026, écrite ici sans dépendre de cette colonne : cette migration doit pouvoir
-- s'appliquer avant ou après 0026 sans changer de résultat.
--
-- `UTC` en dernier recours, et c'est un choix ASSUMÉ : un fuseau faux mais explicite se corrige à
-- l'écran (S-3 affiche l'offset), là où un fuseau deviné se découvre à l'heure de l'envoi.

update newsletter.campaign c
set timezone = coalesce(
  (select e.timezone from newsletter.asset_edition e
    where e.asset_id = c.asset_id and e.timezone is not null
    order by e.created_at asc limit 1),
  'UTC'
)
where c.timezone is null;

-- ---------------------------------------------------------------------------
-- 5. BACKFILL — une occurrence n°1 par campagne existante, à l'identique
-- ---------------------------------------------------------------------------
--
-- ⚠️ COPIE, PAS RÉFÉRENCE. `html_shell` est recopié tel quel : c'est la seule façon d'obtenir le
-- « octet pour octet » qu'on vérifiera juste après. Le recompiler à partir du template donnerait
-- un HTML légèrement différent (ids, ordre des attributs) et rendrait la vérification impossible.
--
-- `local_date` n'est calculé que pour les campagnes qui ont une date d'envoi. Les brouillons
-- restent NON DATÉS : leur inventer un jour local ferait apparaître dans le calendrier des envois
-- que personne n'a programmés.

insert into newsletter.campaign_occurrence (
  campaign_id, asset_id, seq, local_date, scheduled_at, status,
  html_shell, text_shell, size_bytes, subject, preheader,
  template_version_id, segment_id, locked_at, sent_at, recipients_planned, created_at
)
select
  c.id,
  c.asset_id,
  1,
  case when c.scheduled_at is null then null
       else (c.scheduled_at at time zone coalesce(c.timezone, 'UTC'))::date end,
  c.scheduled_at,
  -- Correspondance des statuts. `paused` n'existe pas côté occurrence : un plan se met en pause,
  -- une occurrence est planifiée ou annulée. Elle redevient donc `planned`, et c'est le plan
  -- (`recurrence_active = false`) qui retient l'envoi.
  case c.status
    when 'draft'     then 'planned'
    when 'scheduled' then 'planned'
    when 'sending'   then 'sending'
    when 'sent'      then 'sent'
    when 'cancelled' then 'cancelled'
    when 'paused'    then 'planned'
    else 'planned'
  end,
  c.html_shell, c.text_shell, c.size_bytes, c.subject, c.preheader,
  c.template_version_id, c.segment_id, c.locked_at, c.sent_at, c.recipients_planned,
  c.created_at
from newsletter.campaign c
-- Idempotent : rejouer la migration ne crée pas de seconde occurrence n°1.
where not exists (
  select 1 from newsletter.campaign_occurrence o where o.campaign_id = c.id
);

-- ---------------------------------------------------------------------------
-- 6. Vérification — à lire APRÈS application
-- ---------------------------------------------------------------------------
--
-- État relevé le 20/08/2026 AVANT d'écrire : 4 campagnes (3 draft, 1 scheduled), 1 seule
-- verrouillée avec `html_shell` de 15 509 caractères, 0 envoyée, 0 ligne d'outbox de campagne.
--
--   -- exactement une occurrence par campagne, aucune orpheline
--   select (select count(*) from newsletter.campaign)                       as campagnes,
--          (select count(*) from newsletter.campaign_occurrence)            as occurrences,
--          (select count(*) from newsletter.campaign c
--             where (select count(*) from newsletter.campaign_occurrence o
--                      where o.campaign_id = c.id) <> 1)                    as anomalies;
--
--   -- le shell est identique OCTET POUR OCTET
--   select c.id, c.name,
--          md5(c.html_shell) = md5(o.html_shell)            as html_identique,
--          octet_length(c.html_shell) = octet_length(o.html_shell) as taille_identique,
--          c.html_shell is not distinct from o.html_shell   as strictement_egal
--   from newsletter.campaign c join newsletter.campaign_occurrence o on o.campaign_id = c.id;
--
--   -- aucune cadence armée, aucun e-mail rattaché à une occurrence
--   select count(*) filter (where recurrence_active) as series_armees from newsletter.campaign;
--   select count(*) from newsletter.email_outbox where occurrence_id is not null;  -- doit être 0
