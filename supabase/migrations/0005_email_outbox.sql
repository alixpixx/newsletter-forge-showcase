-- Outbox d'emails transactionnels. Le widget / double opt-in écrit ici (status='pending')
-- au lieu d'envoyer directement. POINT D'ANCRAGE SES : le worker (à venir) drainera cette
-- table et enverra via SES, puis marquera 'sent'. Tant que SES n'est pas branché, rien ne
-- part réellement — mais la boucle d'acquisition est prouvable de bout en bout.
create table if not exists newsletter.email_outbox (
  id                  uuid primary key default gen_random_uuid(),
  asset_id            uuid references newsletter.asset(id) on delete set null,
  subscription_id     uuid references newsletter.subscription(id) on delete set null,
  to_email            extensions.citext not null,
  kind                text not null check (kind in ('confirmation','welcome','unsubscribe_ack')),
  subject             text not null,
  action_url          text,
  payload             jsonb not null default '{}',
  status              text not null default 'pending' check (status in ('pending','sent','failed')),
  provider_message_id text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  error               text
);
create index if not exists idx_outbox_status on newsletter.email_outbox (status, created_at);

alter table newsletter.email_outbox enable row level security;
grant usage on schema newsletter to service_role;
grant all on newsletter.email_outbox to service_role;
