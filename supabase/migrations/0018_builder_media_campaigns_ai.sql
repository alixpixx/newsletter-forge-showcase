-- ⛔ NE PAS REJOUER — déjà appliquée. Rejouée, elle recrée `email_outbox_kind_check` SANS
-- `reengagement` (ajouté par 0057) : la contrainte échouerait sur les lignes existantes ou fermerait
-- le moteur de réengagement. Voir supabase/README.md (« Jamais `supabase db push` »).
--
-- Builder v2 — médiathèque, campagnes réelles, et journal des générations IA.

-- ---------------------------------------------------------------------------
-- 1. Médiathèque (bucket Supabase Storage `email-media`, chemin {asset_slug}/{yyyy}/{uuid}.{ext})
-- ---------------------------------------------------------------------------
create table if not exists newsletter.media_asset (
  id          uuid primary key default gen_random_uuid(),
  asset_id    uuid not null references newsletter.asset(id) on delete cascade,
  path        text not null,                 -- chemin dans le bucket
  url         text not null,                 -- URL publique servie dans les emails
  mime        text not null,
  width       int,
  height      int,
  bytes       int,
  sha256      text,                          -- dédup à l'upload
  alt         text,                          -- alt par défaut proposé aux blocs image
  source      text not null default 'upload' check (source in ('upload','ai','import')),
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (asset_id, sha256)
);
create index if not exists idx_media_asset on newsletter.media_asset (asset_id, created_at desc);
alter table newsletter.media_asset enable row level security;
grant all on newsletter.media_asset to service_role;

-- ---------------------------------------------------------------------------
-- 2. Campagnes — copie IMMUABLE du rendu au moment du lock (envois déterministes)
-- ---------------------------------------------------------------------------
create table if not exists newsletter.campaign (
  id                  uuid primary key default gen_random_uuid(),
  asset_id            uuid not null references newsletter.asset(id) on delete cascade,
  name                text not null,
  status              text not null default 'draft'
                        check (status in ('draft','scheduled','sending','sent','paused','cancelled')),
  template_version_id uuid references newsletter.template_version(id) on delete set null,
  segment_id          uuid references newsletter.segment(id) on delete set null,
  purpose             text check (purpose is null or purpose in ('content','offers','events','partners')),
  subject             text not null default '',
  preheader           text,
  -- snapshot figé au lock : jamais recompilé, jamais dupliqué par destinataire
  html_shell          text,
  text_shell          text,
  size_bytes          int,
  scheduled_at        timestamptz,
  locked_at           timestamptz,
  sent_at             timestamptz,
  recipients_planned  int,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_campaign_asset on newsletter.campaign (asset_id, created_at desc);
create index if not exists idx_campaign_due on newsletter.campaign (scheduled_at) where status = 'scheduled';
alter table newsletter.campaign enable row level security;
grant all on newsletter.campaign to service_role;

-- L'outbox porte la référence, jamais le HTML : le worker lit le shell une fois et le met en cache.
alter table newsletter.email_outbox
  add column if not exists campaign_id uuid references newsletter.campaign(id) on delete set null,
  add column if not exists template_version_id uuid references newsletter.template_version(id) on delete set null;
create index if not exists idx_outbox_campaign on newsletter.email_outbox (campaign_id)
  where campaign_id is not null;

-- Nouveaux kinds : 'campaign' (envoi de masse) et 'test' (envoi de test depuis le builder).
alter table newsletter.email_outbox drop constraint if exists email_outbox_kind_check;
alter table newsletter.email_outbox
  add constraint email_outbox_kind_check
  check (kind in ('confirmation','welcome','unsubscribe_ack','campaign','test'));

-- ---------------------------------------------------------------------------
-- 3. Générations IA — audit, rate limit et suivi de coût en une seule table
-- ---------------------------------------------------------------------------
create table if not exists newsletter.ai_generation (
  id                uuid primary key default gen_random_uuid(),
  asset_id          uuid references newsletter.asset(id) on delete cascade,
  template_id       uuid references newsletter.template(id) on delete set null,
  step              text not null check (step in ('art_direction','compose','illustrate')),
  provider          text not null,
  model             text not null,
  input_tokens      int,
  output_tokens     int,
  cache_read_tokens int,
  cache_write_tokens int,
  cost_cents        numeric(10,4),
  duration_ms       int,
  status            text not null check (status in ('ok','invalid_doc','refusal','error','timeout')),
  error             text,
  author_email      text,
  created_at        timestamptz not null default now()
);
-- sert le rate limit (20/h/utilisateur) ET rend visible la panne silencieuse (crédit épuisé)
create index if not exists idx_aigen_rate on newsletter.ai_generation (author_email, created_at desc);
alter table newsletter.ai_generation enable row level security;
grant all on newsletter.ai_generation to service_role;

notify pgrst, 'reload schema';
