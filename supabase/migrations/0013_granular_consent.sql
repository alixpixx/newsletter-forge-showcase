-- Consentement par finalité (granulaire) + preuve enrichie + mode d'édition. Tout additif/nullable.

-- Snapshot d'état par finalité sur la souscription (lu par le gate sans join).
alter table newsletter.subscription
  add column if not exists granted_purposes jsonb not null default '{}'::jsonb;
create index if not exists idx_sub_granted_purposes on newsletter.subscription using gin (granted_purposes);

-- Preuve enrichie sur le log immuable (colonnes nullables = sûres sur une table append-only).
-- Statut = event_type (granted/withdrawn) ; date de retrait = occurred_at. Pas de changement du CHECK event_type.
alter table newsletter.consent_event
  add column if not exists purpose     text check (purpose is null or purpose in ('content','offers','events','partners')),
  add column if not exists source_url  text,
  add column if not exists country     text,
  add column if not exists language    text,
  add column if not exists legal_basis text check (legal_basis is null or legal_basis in ('consent','legitimate_interest','opt_out'));
create index if not exists idx_consent_event_purpose on newsletter.consent_event (subscription_id, purpose);

-- Mode de consentement + rétention de preuve par édition.
alter table newsletter.asset_edition
  add column if not exists consent_mode text not null default 'single' check (consent_mode in ('single','granular')),
  add column if not exists proof_retention_years smallint;

-- Finalité de la campagne sur l'unité d'envoi.
alter table newsletter.email_outbox
  add column if not exists purpose text check (purpose is null or purpose in ('content','offers','events','partners'));
