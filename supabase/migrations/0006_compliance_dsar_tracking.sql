-- C2 : consentement de TRACKING séparé (pixel/clic = cookie en EU/UK/CL/IT/FR → consentement distinct)
alter table newsletter.subscription add column if not exists tracking_consent boolean not null default false;
alter table newsletter.subscription add column if not exists tracking_consent_at timestamptz;

-- C3 : demandes DSAR (accès / portabilité / effacement / rectification), SLA 30 jours
create table if not exists newsletter.dsar_request (
  id               uuid primary key default gen_random_uuid(),
  subscriber_id    uuid references newsletter.subscriber(id) on delete set null,
  email            extensions.citext,
  type             text not null check (type in ('access','portability','erasure','rectification')),
  status           text not null default 'pending' check (status in ('pending','processing','done','failed')),
  requested_at     timestamptz not null default now(),
  due_at           timestamptz not null default (now() + interval '30 days'),
  nl_completed_at  timestamptz,
  crm_completed_at timestamptz,
  note             text
);
create index if not exists idx_dsar_status on newsletter.dsar_request (status, due_at);
alter table newsletter.dsar_request enable row level security;
grant all on newsletter.dsar_request to service_role;

-- C3 : effacement (droit à l'oubli) qui PRÉSERVE LA PREUVE.
-- Pseudonymise la PII (email/nom/IP/UA) mais garde les faits de consentement
-- (event_type / date / version / méthode) dans consent_event, + conserve un hash de
-- suppression pour ne jamais recontacter. SECURITY DEFINER = seule voie d'écriture
-- autorisée sur le log immuable.
create or replace function newsletter.erase_subscriber(p_subscriber_id uuid)
returns void
language plpgsql
security definer
set search_path = newsletter, extensions
as $$
declare v_email extensions.citext;
begin
  select email into v_email from newsletter.subscriber where id = p_subscriber_id;
  if v_email is null then return; end if;

  -- Reste supprimé pour toujours : hash conservé, PII effacée
  insert into newsletter.suppression (email_hash, email, scope, asset_id, reason)
  values (digest(lower(v_email::text), 'sha256'), null, 'global', null, 'erasure');

  -- Pseudonymise l'identité (email unique non délivrable, reste RFC 2606 .invalid)
  update newsletter.subscriber
  set email = ('erased+' || p_subscriber_id::text || '@deleted.invalid')::extensions.citext,
      first_name = null, crm_contact_id = null, deleted_at = now()
  where id = p_subscriber_id;

  -- Souscriptions : statut 'deleted', on retire l'IP de consentement
  update newsletter.subscription
  set status = 'deleted', consent_ip = null
  where subscriber_id = p_subscriber_id;

  -- Log de consentement : on retire la PII (IP/UA), on GARDE la preuve juridique
  update newsletter.consent_event ce
  set ip_address = null, user_agent = null
  from newsletter.subscription s
  where ce.subscription_id = s.id and s.subscriber_id = p_subscriber_id;
end;
$$;
grant execute on function newsletter.erase_subscriber(uuid) to service_role;
