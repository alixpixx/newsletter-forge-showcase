-- Rétention de preuve (kit : IN 7 ans, JP 3 ans). Minimisation après la période : on retire la
-- PII (IP / user-agent / URL source) des consent_event plus vieux que la rétention de leur édition,
-- en GARDANT les faits légaux (event_type, purpose, date, version, pays, langue, base légale).
-- Dormant tant qu'aucune édition n'a `proof_retention_years` ; à planifier (cron) quand IN/JP enverront.
create or replace function newsletter.purge_expired_proof()
returns integer
language plpgsql
security definer
set search_path = newsletter, extensions
as $$
declare n integer := 0;
begin
  with expired as (
    select ce.id
    from newsletter.consent_event ce
    join newsletter.subscription s   on s.id = ce.subscription_id
    join newsletter.asset_edition e  on e.id = s.edition_id
    where e.proof_retention_years is not null
      and ce.occurred_at < now() - make_interval(years => e.proof_retention_years::int)
      and (ce.ip_address is not null or ce.user_agent is not null or ce.source_url is not null)
  )
  update newsletter.consent_event ce
     set ip_address = null, user_agent = null, source_url = null
    from expired
   where ce.id = expired.id;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function newsletter.purge_expired_proof() to service_role;
