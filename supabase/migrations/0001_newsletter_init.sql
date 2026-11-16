-- newsletter-forge · base clean (P1-02/03/04)
-- Cible : un projet Supabase (éventuellement partagé), schéma DÉDIÉ `newsletter`
-- (isolation propre : un schéma par application).
-- RLS activée partout (default-deny) — neutralise l'exposition du projet partagé ;
-- l'app accède en service-role / connexion directe Postgres.
-- Résidence : US (décision Alix). NB : quand les assets GDPR (Harbor Tech, Goalpost
-- Weekly) arriveront, revoir la résidence pour eux (data_residency='eu').
-- citext installé dans le schéma `extensions` (convention Supabase) et référencé
-- en `extensions.citext` pour éviter toute dépendance au search_path.

create schema if not exists newsletter;
create extension if not exists citext with schema extensions;

-- ============================================================ Tenancy
create table if not exists newsletter.asset (
  id                uuid primary key default gen_random_uuid(),
  slug              extensions.citext unique not null,
  name              text not null,
  market            text,
  languages         text[] not null default '{}',
  sending_subdomain text,
  created_at        timestamptz not null default now()
);

create table if not exists newsletter.asset_edition (
  id                uuid primary key default gen_random_uuid(),
  asset_id          uuid not null references newsletter.asset(id) on delete cascade,
  market            text not null,
  language          text not null,
  compliance_regime text not null check (compliance_regime in ('gdpr','lgpd','canspam')),
  data_residency    text not null default 'us' check (data_residency in ('eu','br','us','none')),
  timezone          text not null default 'UTC',
  branding          jsonb not null default '{}',
  legal_footer      jsonb not null default '{}',
  sending_subdomain text,
  wp_connection_id  uuid,
  created_at        timestamptz not null default now(),
  unique (asset_id, market, language)
);

-- ============================================================ Identité
create table if not exists newsletter.subscriber (
  id              uuid primary key default gen_random_uuid(),
  email           extensions.citext unique not null,
  first_name      text,
  crm_contact_id  text,
  global_unsub_at timestamptz,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

-- ============================================================ Consentement (versions)
create table if not exists newsletter.consent_version (
  id             uuid primary key default gen_random_uuid(),
  regime         text not null check (regime in ('gdpr','lgpd','canspam')),
  asset_id       uuid references newsletter.asset(id) on delete cascade,
  version_label  text not null,
  effective_from timestamptz not null default now(),
  legal_text     text not null,
  text_hash      text not null,
  created_at     timestamptz not null default now()
);

-- ============================================================ Souscription (workhorse segmentation)
create table if not exists newsletter.subscription (
  id                 uuid primary key default gen_random_uuid(),
  subscriber_id      uuid not null references newsletter.subscriber(id) on delete cascade,
  asset_id           uuid not null references newsletter.asset(id) on delete cascade,
  edition_id         uuid references newsletter.asset_edition(id),
  status             text not null default 'pending'
                       check (status in ('pending','active','unsubscribed','suppressed_soft','suppressed_hard','complained','deleted')),
  source             text check (source in ('organic','social','crm_sync','import','content_upgrade')),
  source_detail      jsonb not null default '{}',
  language           text,
  -- snapshot consentement (le log consent_event reste la source légale)
  consent_state      boolean not null default false,
  consent_version_id uuid references newsletter.consent_version(id),
  consent_ip         inet,
  consent_method     text,
  consent_at         timestamptz,
  -- snapshot engagement (dénormalisé pour previews rapides)
  open_count         integer not null default 0,
  click_count        integer not null default 0,
  last_open_at       timestamptz,
  last_click_at      timestamptz,
  last_engagement_at timestamptz,
  engagement_score   integer not null default 0,
  engagement_level   text not null default 'active' check (engagement_level in ('active','dormant','churned')),
  welcome_completed  boolean not null default false,
  soft_bounce_count  integer not null default 0,
  tag_ids            integer[] not null default '{}',
  created_at         timestamptz not null default now(),
  unique (subscriber_id, asset_id)
);

-- ============================================================ Consentement (log immuable)
create table if not exists newsletter.consent_event (
  id                 bigint generated always as identity primary key,
  subscription_id    uuid not null references newsletter.subscription(id) on delete cascade,
  consent_version_id uuid references newsletter.consent_version(id),
  event_type         text not null
                       check (event_type in ('optin_request','optin_confirm','granted','withdrawn','unsubscribe','resubscribe','preference_change','deletion_request')),
  ip_address         inet,
  user_agent         text,
  method             text,
  occurred_at        timestamptz not null default now(),
  metadata           jsonb not null default '{}'
);
-- append-only : interdit UPDATE/DELETE (l'effacement RGPD passe par une fonction dédiée)
revoke update, delete on newsletter.consent_event from public;

-- ============================================================ Double opt-in + suppression
create table if not exists newsletter.doi_token (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references newsletter.subscription(id) on delete cascade,
  token_hash      text not null,
  expires_at      timestamptz not null,
  confirmed_at    timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists newsletter.suppression (
  id         uuid primary key default gen_random_uuid(),
  email_hash bytea not null,
  email      extensions.citext,
  scope      text not null default 'global' check (scope in ('global','asset')),
  asset_id   uuid references newsletter.asset(id) on delete cascade,
  reason     text,
  created_at timestamptz not null default now(),
  unique (email_hash, asset_id)
);

-- ============================================================ Tags
create table if not exists newsletter.tag (
  id         integer generated always as identity primary key,
  asset_id   uuid references newsletter.asset(id) on delete cascade,
  slug       text not null,
  label      text,
  source     text,
  created_at timestamptz not null default now(),
  unique (asset_id, slug)
);

create table if not exists newsletter.subscription_tag (
  subscription_id uuid not null references newsletter.subscription(id) on delete cascade,
  tag_id          integer not null references newsletter.tag(id) on delete cascade,
  source          text,
  assigned_at     timestamptz not null default now(),
  primary key (subscription_id, tag_id)
);

-- ============================================================ Segments (persiste le builder)
create table if not exists newsletter.segment (
  id                 uuid primary key default gen_random_uuid(),
  asset_id           uuid not null references newsletter.asset(id) on delete cascade,
  name               text not null,
  kind               text not null default 'dynamic' check (kind in ('dynamic','static')),
  rule_json          jsonb not null default '{}',
  cached_count       integer,
  cached_at          timestamptz,
  used_by_automation boolean not null default false,
  sync_to_crm        boolean not null default false,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ============================================================ Audit
create table if not exists newsletter.audit_log (
  id          bigint generated always as identity primary key,
  actor       text,
  action      text not null,
  target_type text,
  target_id   text,
  asset_id    uuid,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

-- ============================================================ Index
create index if not exists idx_sub_asset_status      on newsletter.subscription (asset_id, status);
create index if not exists idx_sub_asset_engagement  on newsletter.subscription (asset_id, last_engagement_at);
create index if not exists idx_sub_asset_level       on newsletter.subscription (asset_id, engagement_level);
create index if not exists idx_sub_subscriber        on newsletter.subscription (subscriber_id);
create index if not exists idx_sub_tag_ids           on newsletter.subscription using gin (tag_ids);
create index if not exists idx_consent_event_sub     on newsletter.consent_event (subscription_id, occurred_at);
create index if not exists idx_sub_tag_tag           on newsletter.subscription_tag (tag_id);
create index if not exists idx_segment_asset         on newsletter.segment (asset_id);

-- ============================================================ RLS default-deny (l'app = service-role)
alter table newsletter.asset            enable row level security;
alter table newsletter.asset_edition    enable row level security;
alter table newsletter.subscriber       enable row level security;
alter table newsletter.subscription     enable row level security;
alter table newsletter.consent_version  enable row level security;
alter table newsletter.consent_event    enable row level security;
alter table newsletter.doi_token        enable row level security;
alter table newsletter.suppression      enable row level security;
alter table newsletter.tag              enable row level security;
alter table newsletter.subscription_tag enable row level security;
alter table newsletter.segment          enable row level security;
alter table newsletter.audit_log        enable row level security;

-- ============================================================ Grants (service-role uniquement)
grant usage on schema newsletter to service_role;
grant all on all tables in schema newsletter to service_role;
grant all on all sequences in schema newsletter to service_role;
alter default privileges in schema newsletter grant all on tables to service_role;
alter default privileges in schema newsletter grant all on sequences to service_role;

-- ============================================================ Seed pilote : Quartz Tips (BR · LGPD)
insert into newsletter.asset (slug, name, market, languages, sending_subdomain)
values ('quartz-tips', 'Quartz Tips', 'BR', '{pt-BR}', 'news.quartz-tips-parked.example')
on conflict (slug) do nothing;

insert into newsletter.asset_edition (asset_id, market, language, compliance_regime, data_residency, timezone, sending_subdomain)
select id, 'BR', 'pt-BR', 'lgpd', 'br', 'America/Sao_Paulo', 'news.quartz-tips-parked.example'
from newsletter.asset where slug = 'quartz-tips'
on conflict (asset_id, market, language) do nothing;

insert into newsletter.consent_version (regime, asset_id, version_label, legal_text, text_hash)
select 'lgpd', id, 'v1',
       'Autorizo a Quartz Tips a me enviar novidades, palpites e comunicacoes por e-mail. Posso cancelar a qualquer momento.',
       'seed:quartz-tips-lgpd-v1'
from newsletter.asset where slug = 'quartz-tips'
on conflict do nothing;

insert into newsletter.tag (asset_id, slug, label, source)
select id, 'interesse:paris', 'Interesse: paris', 'seed' from newsletter.asset where slug = 'quartz-tips'
on conflict (asset_id, slug) do nothing;
