-- Un email est-il supprimé (do-not-send) ? Global, ou pour cette marque.
create or replace function newsletter.is_suppressed(p_email text, p_asset_id uuid default null)
returns boolean
language sql security definer set search_path = newsletter, extensions
as $$
  select exists(
    select 1 from newsletter.suppression
    where email_hash = digest(lower(p_email), 'sha256')
      and (scope = 'global' or asset_id = p_asset_id)
  );
$$;
grant execute on function newsletter.is_suppressed(text, uuid) to service_role;

-- Ajoute un email à la suppression list (hash calculé côté serveur).
create or replace function newsletter.suppress(p_email text, p_asset_id uuid, p_reason text, p_scope text default 'asset')
returns void
language sql security definer set search_path = newsletter, extensions
as $$
  insert into newsletter.suppression (email_hash, email, scope, asset_id, reason)
  values (
    digest(lower(p_email), 'sha256'),
    lower(p_email)::extensions.citext,
    p_scope,
    case when p_scope = 'global' then null else p_asset_id end,
    p_reason
  );
$$;
grant execute on function newsletter.suppress(text, uuid, text, text) to service_role;
