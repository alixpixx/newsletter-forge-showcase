-- Rend newsletter.email_outbox concurrency- + crash-safe et fournit le contexte résolu
-- que le worker (apps/worker) lit via PostgREST (service_role). RPC de claim/finish + vue.
-- Transport = supabase-js/PostgREST (pas de password pg) → FOR UPDATE SKIP LOCKED encapsulé
-- dans un RPC SECURITY DEFINER (non exprimable côté PostgREST).

-- 1) Colonnes de cycle de vie (aucune n'existait). Rétro-compatible : les lignes existantes
--    deviennent immédiatement réclamables (attempts=0, next_attempt_at=now()).
alter table newsletter.email_outbox
  add column if not exists attempts        integer     not null default 0,
  add column if not exists max_attempts    integer     not null default 5,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists locked_at       timestamptz,
  add column if not exists locked_by       text;

-- 2) Élargit le domaine de status : 'sending' (in-flight) + 'skipped' (bloqué À DESSEIN,
--    PAS une erreur : suppression/allowlist/not_active/footer_incomplete).
alter table newsletter.email_outbox drop constraint if exists email_outbox_status_check;
alter table newsletter.email_outbox
  add constraint email_outbox_status_check
  check (status in ('pending','sending','sent','failed','skipped'));

-- 3) Index de claim partiel : ne scanne que les lignes vivantes, ordonne par éligibilité.
drop index if exists newsletter.idx_outbox_status;
create index if not exists idx_outbox_claimable
  on newsletter.email_outbox (next_attempt_at)
  where status in ('pending','sending');
create index if not exists idx_outbox_provider_msg
  on newsletter.email_outbox (provider_message_id)
  where provider_message_id is not null;

-- 4) Vue de contexte résolu : tout en UN select. is_suppressed() est SECURITY DEFINER et
--    RÉ-ÉVALUÉ au moment de la lecture (= send-time, jamais caché). C4/C5.
--    L'édition est celle à laquelle l'abonné a souscrit (subscription.edition_id) ; à défaut
--    (ligne asset-only) on prend l'édition primaire (plus petit id).
create or replace view newsletter.outbox_context as
select
  o.id, o.kind, o.subject, o.action_url, o.payload, o.to_email,
  o.status, o.attempts, o.max_attempts, o.next_attempt_at, o.created_at,
  o.asset_id, o.subscription_id,
  a.name  as asset_name,
  a.slug  as asset_slug,
  coalesce(e.sending_subdomain, a.sending_subdomain) as sending_subdomain,
  e.compliance_regime,
  e.legal_footer,
  e.language,
  s.status        as sub_status,
  s.subscriber_id as subscriber_id,
  s.tracking_consent,
  newsletter.is_suppressed(o.to_email::text, o.asset_id) as suppressed
from newsletter.email_outbox o
left join newsletter.asset a         on a.id = o.asset_id
left join newsletter.subscription s  on s.id = o.subscription_id
left join lateral (
  select ed.*
    from newsletter.asset_edition ed
   where ed.asset_id = o.asset_id
   order by (ed.id = s.edition_id) desc nulls last, ed.id
   limit 1
) e on true;

grant select on newsletter.outbox_context to service_role;
comment on view newsletter.outbox_context is
  'Contexte résolu par ligne outbox (asset/edition/subscription/subscriber + suppression LIVE). Lu par apps/worker après claim_outbox.';

-- ============ CLAIM (concurrency- + crash-safe). setof => appelable via PostgREST .rpc(). ============
-- (a) enterre les 'sending' périmés qui ont déjà épuisé leurs tentatives (crash à répétition AVANT
--     tout mark_*). SANS ÇA ils resteraient 'sending' pour toujours car le filtre (b) attempts<max
--     les exclut du reclaim. C'est l'élément clé qui rend la file réellement crash-safe.
-- (b) réclame les 'pending' dus + reclaim les 'sending' périmés encore sous quota ; attempts++ À LA
--     PRISE (reclaim compris) => borne les crash-loops. FOR UPDATE SKIP LOCKED => N workers sans collision.
create or replace function newsletter.claim_outbox(
  p_worker        text,
  p_batch         int  default 10,
  p_stale_seconds int  default 300      -- DOIT être >> timeout HTTP Mailgun (~20s)
) returns setof newsletter.email_outbox
language plpgsql
security definer
set search_path = newsletter, extensions
as $$
begin
  update newsletter.email_outbox
     set status = 'failed',
         error  = coalesce(error, 'max_attempts exhausted while in-flight'),
         locked_at = null, locked_by = null
   where status = 'sending'
     and locked_at < now() - make_interval(secs => p_stale_seconds)
     and attempts >= max_attempts;

  return query
  update newsletter.email_outbox o
     set status    = 'sending',
         attempts  = o.attempts + 1,
         locked_at = now(),
         locked_by = p_worker,
         error     = null
   where o.id in (
     select c.id
       from newsletter.email_outbox c
      where c.next_attempt_at <= now()
        and c.attempts < c.max_attempts
        and ( c.status = 'pending'
           or (c.status = 'sending'
               and c.locked_at < now() - make_interval(secs => p_stale_seconds)) )
      order by c.created_at
      for update skip locked
      limit p_batch )
  returning o.*;
end;
$$;
grant execute on function newsletter.claim_outbox(text,int,int) to service_role;

-- ============ SUCCÈS (terminal). Garde 'and status=sending' => n'écrase jamais un état concurrent. ============
create or replace function newsletter.outbox_mark_sent(p_id uuid, p_provider_message_id text)
returns void language sql security definer set search_path = newsletter as $$
  update newsletter.email_outbox
     set status='sent', sent_at=now(), provider_message_id=p_provider_message_id,
         locked_at=null, locked_by=null, error=null
   where id=p_id and status='sending';
$$;
grant execute on function newsletter.outbox_mark_sent(uuid,text) to service_role;

-- ============ ÉCHEC. retryable + attempts<max => 'pending' + backoff expo (30s*2^(n-1), cap 1h) ;
--              sinon => 'failed' (4xx permanent Mailgun, ou tentatives épuisées). ============
create or replace function newsletter.outbox_mark_failed(
  p_id uuid, p_error text, p_retryable boolean default true
) returns void language sql security definer set search_path = newsletter as $$
  update newsletter.email_outbox o
     set status = case when p_retryable and o.attempts < o.max_attempts then 'pending' else 'failed' end,
         next_attempt_at = case when p_retryable and o.attempts < o.max_attempts
                                then now() + least(interval '1 hour',
                                       interval '30 seconds' * power(2, greatest(o.attempts - 1, 0)))
                                else o.next_attempt_at end,
         locked_at=null, locked_by=null, error=p_error
   where o.id=p_id and o.status='sending';
$$;
grant execute on function newsletter.outbox_mark_failed(uuid,text,boolean) to service_role;

-- ============ SKIP (bloqué à dessein : suppressed / not_active / not_allowlisted / footer_incomplete /
--              missing_context). Terminal, JAMAIS retenté, distinct de 'failed' pour ne pas alerter. ============
create or replace function newsletter.outbox_mark_skipped(p_id uuid, p_reason text)
returns void language sql security definer set search_path = newsletter as $$
  update newsletter.email_outbox
     set status='skipped', locked_at=null, locked_by=null, error=p_reason
   where id=p_id and status='sending';
$$;
grant execute on function newsletter.outbox_mark_skipped(uuid,text) to service_role;

notify pgrst, 'reload schema';
