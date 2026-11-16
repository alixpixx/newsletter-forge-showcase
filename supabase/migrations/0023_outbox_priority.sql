-- Priorité de file : le transactionnel passe DEVANT le marketing.
--
-- POURQUOI. `claim_outbox` (0010) trie par `created_at` seul : la file est un pur FIFO. Dès qu'une
-- campagne pré-enfile son lot (1 200 lignes d'un coup), la confirmation de double opt-in de
-- quelqu'un qui s'inscrit une minute plus tard se retrouve DERRIÈRE ces 1 200 lignes. Au rythme du
-- worker elle arrive avec des dizaines de minutes de retard — sur harbor-tech (GB) et copper-kettle
-- (CL), qui sont en ligne avec de vrais visiteurs, c'est un opt-in perdu. Un email qu'un humain
-- attend devant son écran ne peut pas patienter derrière un envoi de masse.
--
-- Le tri devient donc : kind='campaign' en dernier (1), tout le reste d'abord (0) — confirmation,
-- welcome, unsubscribe_ack, test (domaine posé par 0018). À priorité ÉGALE, on ajoute
-- `next_attempt_at` avant `created_at` : c'est la date d'éligibilité réellement recalculée par le
-- backoff de outbox_mark_failed, alors que `created_at` est figé. Sans elle, une vieille ligne
-- repoussée à plus tard passait quand même devant une ligne due maintenant.
--
-- RÉTRO-COMPATIBLE : recopie fidèle de 0010 — même signature (text,int,int), mêmes gardes, mêmes
-- effets. Seul l'`order by` du sous-select de claim change. Aucune ligne existante n'est invalidée.
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
      order by (case when c.kind = 'campaign' then 1 else 0 end), c.next_attempt_at, c.created_at
      for update skip locked
      limit p_batch )
  returning o.*;
end;
$$;
grant execute on function newsletter.claim_outbox(text,int,int) to service_role;

comment on function newsletter.claim_outbox(text,int,int) is
  'Réclame un lot outbox. Le transactionnel (confirmation/welcome/unsubscribe_ack/test) passe TOUJOURS avant kind=campaign : une campagne de 1 200 lignes ne doit pas retarder un double opt-in.';

notify pgrst, 'reload schema';
