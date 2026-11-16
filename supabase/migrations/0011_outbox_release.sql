-- Relâche gracieuse : à l'arrêt (SIGTERM), les lignes réclamées mais JAMAIS démarrées sont
-- remises en 'pending' et l'incrément d'attempt du claim est ANNULÉ (sinon un arrêt propre
-- « brûlerait » une tentative sans envoi, pouvant enterrer un email transactionnel en 'failed').
-- Garde status='sending' : n'affecte que l'in-flight, jamais une ligne déjà marquée.
create or replace function newsletter.outbox_release(p_ids uuid[])
returns void language sql security definer set search_path = newsletter as $$
  update newsletter.email_outbox
     set status = 'pending',
         locked_at = null,
         locked_by = null,
         next_attempt_at = now(),
         attempts = greatest(attempts - 1, 0)
   where id = any(p_ids) and status = 'sending';
$$;
grant execute on function newsletter.outbox_release(uuid[]) to service_role;

notify pgrst, 'reload schema';
