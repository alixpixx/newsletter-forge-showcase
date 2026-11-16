-- 0063 — Provenance des abonnés : campagne → créative → intérêts
--
-- Demande d'Alix (09/09/2026) : savoir de quelle CAMPAGNE, de quelleS CRÉATIVEs et
-- de quels INTÉRÊTS vient chaque abonné, et pouvoir cibler « une ou des » de chacun.
--
-- ⛔ VOCABULAIRE — la règle qui justifie tout le préfixe `capture_` :
--    dans le schéma `newsletter`, `campaign` désigne ce qui PART (un envoi).
--    4 tables portent déjà un `campaign_id` en ce sens. `capture_*` désigne ce qui
--    fait ENTRER (une campagne d'acquisition côté optinforge). Sans le préfixe, un
--    `join ... using (campaign_id)` entre deux univers disjoints serait
--    syntaxiquement valide et silencieusement faux.
--
-- ⛔ MODÈLE — la provenance est un ÉVÉNEMENT DATÉ, pas un attribut.
--    La base impose au plus une souscription par (personne, marque) quand
--    `edition_id` est NULL, et l'émetteur n'envoie pas d'édition : un scalaire ne
--    pourrait porter QUE la première touche. Or Alix demande « de quelS créativeS ».
--
-- L'ORDRE DE CE FICHIER EST SON CONTENU : une vue posée avant sa colonne échoue,
-- une colonne ajoutée après la vue est invisible depuis cette vue.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Les campagnes d'acquisition (niveau 1)
-- ═══════════════════════════════════════════════════════════════════════════════

-- PK de SUBSTITUT et non l'uuid amont : « Duplicate », « Create In-Article version »
-- et le déploiement depuis un modèle frappent chez l'émetteur un uuid NEUF pour la
-- même intention. Seul un substitut permettra d'enregistrer une équivalence plus
-- tard, et c'est NOTRE id que `rule_json` citera dans les segments.
create table if not exists newsletter.capture_campaign (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references newsletter.asset(id) on delete cascade,
  external_id   uuid not null,
  name          text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  archived_at   timestamptz,
  constraint capture_campaign_asset_external_uk unique (asset_id, external_id)
);

comment on table newsletter.capture_campaign is
  'Campagne d''ACQUISITION côté optinforge (niveau 1 de la provenance). Rien à voir avec newsletter.campaign, qui est un envoi.';
comment on column newsletter.capture_campaign.external_id is
  'uuid de la campagne chez l''émetteur. Clé d''identité ; le nom, lui, peut changer.';

alter table newsletter.capture_campaign enable row level security;

create index if not exists idx_capture_campaign_asset
  on newsletter.capture_campaign (asset_id, archived_at nulls first);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Les intérêts sont des TAGS, séparés par `kind` (niveau 3)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Pas de table `preference` : le ciblage par tag existe déjà, il est indexé et le
-- compilateur sait l'exprimer. Ce qu'il manquait, c'est de pouvoir DISTINGUER un
-- intérêt déclaré par l'abonné d'un tag posé par l'équipe.
-- ⛔ La séparation se fait par `kind`, JAMAIS par un LIKE sur le slug : un tag
--    manuel nommé « interest:… » suffirait à casser un filtre fondé sur la forme.
alter table newsletter.tag
  add column if not exists kind        text not null default 'manual',
  add column if not exists taxonomy    text,
  add column if not exists source_slug text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'tag_kind_ck' and conrelid = 'newsletter.tag'::regclass
  ) then
    alter table newsletter.tag
      add constraint tag_kind_ck check (kind in ('manual', 'interest'));
  end if;
end
$$;

comment on column newsletter.tag.kind is
  'manual = posé par l''équipe ; interest = choisi par l''abonné dans une créative. Filtrer sur kind, jamais sur la forme du slug.';
comment on column newsletter.tag.taxonomy is
  'Origine du terme chez l''émetteur : tag WordPress, catégorie WordPress, liste libre. NULL pour un tag manuel.';
comment on column newsletter.tag.source_slug is
  'Slug tel que l''émetteur l''écrit (ex. colo-colo), avant préfixage en interest:<taxonomy>:<slug>.';

create index if not exists idx_tag_kind on newsletter.tag (asset_id, kind);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Les créatives (niveau 2) — `optin` gagne son rattachement et son offre
-- ═══════════════════════════════════════════════════════════════════════════════

alter table newsletter.optin
  add column if not exists capture_campaign_id  uuid references newsletter.capture_campaign(id) on delete set null,
  add column if not exists external_id          uuid,
  add column if not exists placement            text,
  add column if not exists asks_interests       boolean not null default false,
  add column if not exists offered_interest_ids integer[] not null default '{}';

comment on column newsletter.optin.asks_interests is
  'true = ce formulaire POSE la question des intérêts. Sans ce drapeau, « pas demandé » et « demandé, rien coché » sont indistinguables — et un ciblage « n''aime pas X » écrirait à des gens à qui on n''a jamais rien demandé.';
comment on column newsletter.optin.capture_campaign_id is
  'Rattachement COURANT de la créative à sa campagne. Il peut changer chez l''émetteur ; ce que la personne a vu le jour J est figé dans capture_event.';

create index if not exists idx_optin_asset_campaign
  on newsletter.optin (asset_id, capture_campaign_id);

-- Advisory critical au 09/09/2026 : `optin` est la seule table de ce schéma exposé
-- via PostgREST dont la RLS est DÉSACTIVÉE. Les autres l'ont activée sans policy —
-- seul le service role lit. On aligne.
alter table newsletter.optin enable row level security;

-- Assertion de vocabulaire : après cette migration, `campaign_id` doit désigner
-- EXACTEMENT les mêmes 4 tables d'envoi qu'avant. Aucune table d'acquisition ne
-- doit en porter — c'est tout l'objet du préfixe `capture_`.
do $$
declare
  n_tables int;
begin
  select count(*) into n_tables
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace nsp on nsp.oid = c.relnamespace
   where nsp.nspname = 'newsletter'
     and a.attname = 'campaign_id'
     and a.attnum > 0 and not a.attisdropped
     and c.relkind = 'r';

  if n_tables <> 4 then
    raise exception 'vocabulaire : % tables portent campaign_id, 4 attendues (campaign_occurrence, email_event, email_outbox, feed_article_sent)', n_tables;
  end if;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. L'événement de capture — le cœur du modèle
-- ═══════════════════════════════════════════════════════════════════════════════

-- PK de SUBSTITUT et non `(subscription_id, optin_id)` :
--  · la route pose en règle qu'un échec de résolution de créative ne coûte jamais
--    l'inscription (`optin_id = null`) — une PK avec une colonne NULL rendrait la
--    ligne inécrivable exactement dans le cas prévu ;
--  · une PK composite interdirait deux inscriptions sur la MÊME créative avec des
--    intérêts différents, soit précisément le niveau 3 demandé.
create table if not exists newsletter.capture_event (
  id                       uuid primary key default gen_random_uuid(),
  subscription_id          uuid not null references newsletter.subscription(id) on delete cascade,
  asset_id                 uuid not null references newsletter.asset(id) on delete cascade,
  optin_id                 uuid references newsletter.optin(id) on delete set null,
  capture_campaign_id      uuid references newsletter.capture_campaign(id) on delete set null,
  lead_external_id         text,
  -- Heure de l'ÉMETTEUR (quand la personne a validé), distincte de `ingested_at`
  -- (quand nous l'avons su). Un pont en retard de 3 h ne doit pas réécrire l'ordre
  -- des touches.
  occurred_at              timestamptz not null default now(),
  ingested_at              timestamptz not null default now(),
  -- GELÉ : ce qui a été coché SUR CE FORMULAIRE, ce jour-là. Ne suit pas les
  -- changements ultérieurs de la créative.
  interest_ids             integer[] not null default '{}',
  -- ⚠️ NULLABLE, et le NULL porte du sens : NULL = l'émetteur ne nous a pas dit ce
  -- qu'il proposait ; '{}' = il proposait explicitement rien. Confondre les deux
  -- retire pour toujours le dénominateur de tout taux d'intérêt.
  interests_offered        integer[],
  campaign_name_at_capture text,
  optin_name_at_capture    text,
  variant_external_id      text,
  source_url               text,
  ip_address               inet,
  user_agent               text
);

comment on table newsletter.capture_event is
  'Une inscription observée : d''où elle vient et ce qui a été coché. Source de vérité du modèle ; les colonnes de subscription n''en sont qu''une projection maintenue par trigger.';
comment on column newsletter.capture_event.interests_offered is
  'Intérêts PROPOSÉS au moment de la capture. NULL = inconnu (l''émetteur ne l''envoie pas), ''{}'' = aucun proposé. Ne jamais assimiler les deux.';

alter table newsletter.capture_event enable row level security;

-- Unique PARTIEL : `lead_external_id` peut être NULL (émetteur muet sur ce point),
-- et deux NULL ne doivent pas se bloquer l'un l'autre.
create unique index if not exists capture_event_lead_uk
  on newsletter.capture_event (asset_id, lead_external_id)
  where lead_external_id is not null;

create index if not exists idx_capture_event_subscription
  on newsletter.capture_event (subscription_id, occurred_at);
create index if not exists idx_capture_event_optin
  on newsletter.capture_event (optin_id, occurred_at desc);
create index if not exists idx_capture_event_campaign
  on newsletter.capture_event (capture_campaign_id, occurred_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. La projection filtrable sur `subscription`
-- ═══════════════════════════════════════════════════════════════════════════════

-- ⛔ `NOT NULL DEFAULT '{}'` est NON NÉGOCIABLE sur les tableaux : c'est lui, et
--    rien d'autre, qui rend une exclusion honnête. Le précédent est documenté :
--    `optin_id` est NULL sur les 1 203 lignes, et `compile.ts` doit écrire
--    `or(optin_id.neq.X, optin_id.is.null)` pour que « pas cet optin » ne perde pas
--    tout le monde. Une colonne tableau NULL rejouerait le même piège en pire.
alter table newsletter.subscription
  add column if not exists capture_campaign_id  uuid references newsletter.capture_campaign(id) on delete set null,
  add column if not exists capture_campaign_ids uuid[]  not null default '{}',
  add column if not exists capture_optin_ids    uuid[]  not null default '{}',
  add column if not exists interest_ids         integer[] not null default '{}',
  add column if not exists capture_pair_keys    text[]  not null default '{}',
  add column if not exists capture_event_count  integer not null default 0;

comment on column newsletter.subscription.capture_campaign_id is
  'Campagne de la PREMIÈRE touche. Miroir de lecture ; la vérité est dans capture_event.';
comment on column newsletter.subscription.capture_pair_keys is
  'Clés de PAIRE, une par (événement × intérêt) et par niveau : o:<créative>:i:<tag> et c:<campagne>:i:<tag>. Sans elle, « campagne A ET intérêt X » retient quelqu''un qui a demandé X sur la campagne B — deux prédicats plats évalués sur deux événements différents.';
comment on column newsletter.subscription.capture_event_count is
  'Nombre d''inscriptions observées. 0 avec des tableaux vides = jamais passé par un formulaire (cas des 1 202 contacts de démonstration), à ne pas lire comme une panne.';

create index if not exists idx_subscription_capture_campaign_ids
  on newsletter.subscription using gin (capture_campaign_ids);
create index if not exists idx_subscription_capture_optin_ids
  on newsletter.subscription using gin (capture_optin_ids);
create index if not exists idx_subscription_interest_ids
  on newsletter.subscription using gin (interest_ids);
create index if not exists idx_subscription_capture_pair_keys
  on newsletter.subscription using gin (capture_pair_keys);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. UN SEUL écrivain : trigger + fonction de réparation
-- ═══════════════════════════════════════════════════════════════════════════════

-- ⛔ Les colonnes ci-dessus ne sont JAMAIS écrites par du code applicatif.
--    Le précédent maison est `subscription_tag` / `tag_ids`, deux écritures
--    applicatives du même fait, concordantes aujourd'hui par chance seulement.
--    Ici : une seule source (capture_event), un seul écrivain (ce trigger), et une
--    fonction de réparation idempotente qui sert au diagnostic comme au backfill.
create or replace function newsletter.refresh_subscription_capture(p_subscription_id uuid)
returns void
language plpgsql
security definer
set search_path to 'newsletter', 'public'
as $$
declare
  v_first_campaign uuid;
  v_campaign_ids   uuid[];
  v_optin_ids      uuid[];
  v_interest_ids   integer[];
  v_pair_keys      text[];
  v_count          integer;
begin
  select count(*) into v_count
    from newsletter.capture_event e
   where e.subscription_id = p_subscription_id;

  -- Première touche = l'événement le plus ancien CHEZ L'ÉMETTEUR ; départagé par
  -- l'ordre d'arrivée puis par l'id, pour que deux événements à la même seconde
  -- donnent toujours le même résultat.
  select e.capture_campaign_id into v_first_campaign
    from newsletter.capture_event e
   where e.subscription_id = p_subscription_id
     and e.capture_campaign_id is not null
   order by e.occurred_at, e.ingested_at, e.id
   limit 1;

  select coalesce(array_agg(distinct e.capture_campaign_id), '{}') into v_campaign_ids
    from newsletter.capture_event e
   where e.subscription_id = p_subscription_id
     and e.capture_campaign_id is not null;

  select coalesce(array_agg(distinct e.optin_id), '{}') into v_optin_ids
    from newsletter.capture_event e
   where e.subscription_id = p_subscription_id
     and e.optin_id is not null;

  select coalesce(array_agg(distinct i), '{}') into v_interest_ids
    from newsletter.capture_event e, unnest(e.interest_ids) i
   where e.subscription_id = p_subscription_id;

  -- Une clé par (événement × intérêt) et par NIVEAU : le niveau 2 (créative) et le
  -- niveau 1 (campagne). C'est ce qui permet d'exprimer « campagne A ET intérêt X »
  -- sans retenir quelqu'un qui a demandé X sur la campagne B.
  select coalesce(array_agg(distinct k), '{}') into v_pair_keys
    from (
      select 'o:' || coalesce(e.optin_id::text, '-') || ':i:' || i::text as k
        from newsletter.capture_event e, unnest(e.interest_ids) i
       where e.subscription_id = p_subscription_id
      union all
      select 'c:' || coalesce(e.capture_campaign_id::text, '-') || ':i:' || i::text
        from newsletter.capture_event e, unnest(e.interest_ids) i
       where e.subscription_id = p_subscription_id
    ) q;

  -- Sans événement, tous les agrégats ci-dessus valent déjà '{}' / NULL / 0 : la
  -- projection revient d'elle-même à l'état neutre, sans branche particulière.
  update newsletter.subscription s
     set capture_campaign_id  = v_first_campaign,
         capture_campaign_ids = v_campaign_ids,
         capture_optin_ids    = v_optin_ids,
         interest_ids         = v_interest_ids,
         capture_pair_keys    = v_pair_keys,
         capture_event_count  = v_count
   where s.id = p_subscription_id;
end
$$;

comment on function newsletter.refresh_subscription_capture(uuid) is
  'Recalcule la projection de provenance d''une souscription DEPUIS capture_event. Idempotente : sert au trigger, au backfill et au diagnostic d''écart.';

create or replace function newsletter.sync_subscription_capture()
returns trigger
language plpgsql
security definer
set search_path to 'newsletter', 'public'
as $$
begin
  -- Un UPDATE peut déplacer l'événement d'une souscription à l'autre : les deux
  -- projections sont alors fausses, pas seulement la nouvelle.
  if tg_op in ('UPDATE', 'DELETE') then
    perform newsletter.refresh_subscription_capture(old.subscription_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform newsletter.refresh_subscription_capture(new.subscription_id);
  end if;
  return null;
end
$$;

drop trigger if exists trg_capture_event_sync on newsletter.capture_event;
create trigger trg_capture_event_sync
  after insert or update or delete on newsletter.capture_event
  for each row execute function newsletter.sync_subscription_capture();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. Les trois vues d'audience — 7 colonnes appendues
-- ═══════════════════════════════════════════════════════════════════════════════

-- ⚠️ `last_response_at` (posée par 0061, hier) n'est dans AUCUNE des trois vues :
--    vérifié colonne par colonne. Une colonne ajoutée après une vue lui est
--    invisible — c'est ce lot-ci qui la rattrape, sinon le moteur de cycle de vie
--    filtrerait sur une colonne que ses propres vues ne servent pas.
create or replace view newsletter.sendable_subscription as
 SELECT s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source,
    s.source_detail, s.language, s.consent_state, s.consent_version_id, s.consent_ip,
    s.consent_method, s.consent_at, s.open_count, s.click_count, s.last_open_at,
    s.last_click_at, s.last_engagement_at, s.engagement_score, s.engagement_level,
    s.welcome_completed, s.soft_bounce_count, s.tag_ids, s.created_at, s.country,
    s.tracking_consent, s.tracking_consent_at, s.granted_purposes, s.optin_id, s.sunset_at,
    s.last_response_at,
    s.capture_campaign_id, s.capture_campaign_ids, s.capture_optin_ids,
    s.interest_ids, s.capture_pair_keys, s.capture_event_count
   FROM newsletter.subscription s
     JOIN newsletter.subscriber sub ON sub.id = s.subscriber_id
  WHERE s.status = 'active'::text
    AND NOT newsletter.is_suppressed(sub.email::text, s.asset_id)
    AND NOT sub.is_demo
    AND s.sunset_at IS NULL;

create or replace view newsletter.sunsetted_subscription as
 SELECT s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source,
    s.source_detail, s.language, s.consent_state, s.consent_version_id, s.consent_ip,
    s.consent_method, s.consent_at, s.open_count, s.click_count, s.last_open_at,
    s.last_click_at, s.last_engagement_at, s.engagement_score, s.engagement_level,
    s.welcome_completed, s.soft_bounce_count, s.tag_ids, s.created_at, s.country,
    s.tracking_consent, s.tracking_consent_at, s.granted_purposes, s.optin_id, s.sunset_at,
    s.last_response_at,
    s.capture_campaign_id, s.capture_campaign_ids, s.capture_optin_ids,
    s.interest_ids, s.capture_pair_keys, s.capture_event_count
   FROM newsletter.subscription s
     JOIN newsletter.subscriber sub ON sub.id = s.subscriber_id
  WHERE s.status = 'active'::text
    AND NOT newsletter.is_suppressed(sub.email::text, s.asset_id)
    AND NOT sub.is_demo
    AND s.sunset_at IS NOT NULL;

create or replace view newsletter.excluded_demo_subscription as
 SELECT s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source,
    s.source_detail, s.language, s.consent_state, s.consent_version_id, s.consent_ip,
    s.consent_method, s.consent_at, s.open_count, s.click_count, s.last_open_at,
    s.last_click_at, s.last_engagement_at, s.engagement_score, s.engagement_level,
    s.welcome_completed, s.soft_bounce_count, s.tag_ids, s.created_at, s.country,
    s.tracking_consent, s.tracking_consent_at, s.granted_purposes, s.optin_id, s.sunset_at,
    s.last_response_at,
    s.capture_campaign_id, s.capture_campaign_ids, s.capture_optin_ids,
    s.interest_ids, s.capture_pair_keys, s.capture_event_count
   FROM newsletter.subscription s
     JOIN newsletter.subscriber sub ON sub.id = s.subscriber_id
  WHERE s.status = 'active'::text
    AND NOT newsletter.is_suppressed(sub.email::text, s.asset_id)
    AND sub.is_demo;

-- Assertion : 7 colonnes neuves × 3 vues = 21. Sans ce compte, une vue oubliée ne
-- se manifesterait qu'au premier segment qui filtre dessus, côté envoi.
do $$
declare
  n int;
begin
  select count(*) into n
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace nsp on nsp.oid = c.relnamespace
   where nsp.nspname = 'newsletter'
     and c.relname in ('sendable_subscription', 'sunsetted_subscription', 'excluded_demo_subscription')
     and a.attnum > 0 and not a.attisdropped
     and a.attname in ('last_response_at', 'capture_campaign_id', 'capture_campaign_ids',
                       'capture_optin_ids', 'interest_ids', 'capture_pair_keys', 'capture_event_count');

  if n <> 21 then
    raise exception 'vues d''audience : % colonnes de provenance servies, 21 attendues (7 x 3)', n;
  end if;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. Gouvernance : contacts ET envoyables, côte à côte
-- ═══════════════════════════════════════════════════════════════════════════════

-- ⛔ `optin_stats` (0054) ne filtre NI `is_demo` NI les supprimés : sa colonne
--    « Contacts » compte aujourd'hui des contacts de démonstration, un nombre
--    qu'aucune campagne ne peut servir. La vue neuve porte les DEUX chiffres.
--    `optin_stats` est CONSERVÉE tant que l'écran ne l'a pas quittée (lot 1.3) :
--    une migration qui casse l'écran en cours de route n'est pas additive.
create or replace view newsletter.capture_source_stats
with (security_invoker = true) as
  select
    o.id                as optin_id,
    o.asset_id,
    o.slug,
    o.name,
    o.placement,
    o.asks_interests,
    o.default_tag_id,
    o.capture_campaign_id,
    cc.name             as capture_campaign_name,
    o.first_seen_at,
    o.last_seen_at,
    o.archived_at,
    count(distinct e.subscription_id)                                  as contacts,
    count(distinct e.subscription_id) filter (where ss.id is not null) as sendable,
    max(e.occurred_at)                                                 as last_signup_at,
    count(distinct e.subscription_id)
      filter (where e.occurred_at >= now() - interval '30 days')       as new_30d
  from newsletter.optin o
  left join newsletter.capture_campaign cc on cc.id = o.capture_campaign_id
  left join newsletter.capture_event e on e.optin_id = o.id
  left join newsletter.sendable_subscription ss on ss.id = e.subscription_id
  group by o.id, cc.name;

comment on view newsletter.capture_source_stats is
  'Gouvernance des créatives. `contacts` = tout le monde ; `sendable` = ce qu''une campagne peut réellement servir. Les deux côte à côte parce que leur écart est l''information.';

-- `apply_optin_default_tag` doit suivre le modèle événementiel : une personne
-- inscrite DEUX fois sur la même créative n'a qu'une `optin_id` (première touche),
-- mais bien cette créative dans `capture_optin_ids`. Les deux formes sont acceptées
-- pendant la transition — `optin_id` reste le miroir de première touche (D8).
create or replace function newsletter.apply_optin_default_tag(p_optin_id uuid, p_dry_run boolean default true)
returns integer
language plpgsql
security definer
set search_path to 'newsletter', 'public'
as $function$
declare
  v_tag        integer;
  v_asset      uuid;
  v_tag_asset  uuid;
  v_manquants  integer;
begin
  select o.default_tag_id, o.asset_id into v_tag, v_asset
    from newsletter.optin o where o.id = p_optin_id;

  if not found then
    raise exception 'optin % introuvable', p_optin_id using errcode = 'no_data_found';
  end if;

  if v_tag is null then
    return 0;
  end if;

  select t.asset_id into v_tag_asset from newsletter.tag t where t.id = v_tag;
  if v_tag_asset is distinct from v_asset then
    raise exception 'le tag % appartient a une autre marque que l''optin %', v_tag, p_optin_id
      using errcode = 'check_violation';
  end if;

  select count(*) into v_manquants
    from newsletter.subscription s
   where (s.capture_optin_ids @> array[p_optin_id] or s.optin_id = p_optin_id)
     and not (coalesce(s.tag_ids, '{}'::integer[]) @> array[v_tag]);

  if p_dry_run then
    return v_manquants;
  end if;

  insert into newsletter.subscription_tag (subscription_id, tag_id, source)
  select s.id, v_tag, 'optin_default'
    from newsletter.subscription s
   where (s.capture_optin_ids @> array[p_optin_id] or s.optin_id = p_optin_id)
  on conflict (subscription_id, tag_id) do nothing;

  update newsletter.subscription s
     set tag_ids = (
           select array(select distinct unnest(coalesce(s.tag_ids, '{}'::integer[]) || v_tag))
         )
   where (s.capture_optin_ids @> array[p_optin_id] or s.optin_id = p_optin_id)
     and not (coalesce(s.tag_ids, '{}'::integer[]) @> array[v_tag]);

  return v_manquants;
end
$function$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. Contrôles finaux
-- ═══════════════════════════════════════════════════════════════════════════════

-- Aucune ligne à NULL sur les colonnes de projection : c'est la garantie qui rend
-- les exclusions honnêtes.
do $$
declare
  n_null int;
begin
  select count(*) into n_null
    from newsletter.subscription
   where capture_campaign_ids is null
      or capture_optin_ids is null
      or interest_ids is null
      or capture_pair_keys is null
      or capture_event_count is null;

  if n_null <> 0 then
    raise exception 'projection : % lignes a NULL, 0 attendue', n_null;
  end if;
end
$$;

notify pgrst, 'reload schema';

insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0063', '0063_capture_provenance.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
