-- ============================================================================
-- 0096 — Les envois EN COURS, lisibles dans Analytics (09/10/2026)
-- ============================================================================
--
-- ⭐ DEMANDE D'ALIX (09/10/2026, lot 2 Harbor Tech en cours d'envoi) : « je la vois en sending mais je sais
-- pas si ça envoie vraiment … elle apparaît pas dans analytics … ça serait cool d'avoir combien de mails
-- envoyés sur combien et quelques infos supplémentaires pendant l'envoi ».
--
-- Pourquoi elle n'y est pas : `campaign_send_stats` (0085, 0093) ne rend que les campagnes dont
-- `last_sent_at` est posé, et `campaign.sent_at` n'est écrit qu'à la FIN de l'envoi (lot 1 : dernier
-- mail 19:28 UTC, `sent_at` 19:30:03). 13 347 destinataires = ~4 h d'invisibilité, pendant lesquelles
-- seule l'étiquette « sending » de la liste des campagnes dit que quelque chose se passe.
--
-- ⛔ UNE FONCTION NEUVE, PAS UNE RETOUCHE DE `campaign_send_stats`. Ses listes, son total, sa pagination
-- et la contre-épreuve de 0094 restent intacts : « envoyée » garde son sens. Celle-ci ne rend QUE ce qui
-- part en ce moment ; l'admin l'affiche AU-DESSUS du tableau, et à la fin de l'envoi la campagne quitte
-- l'encart pour entrer dans la liste.
--
-- « En cours » = une campagne ONE-SHOT au statut `sending`, ou une ÉDITION (occurrence) au statut
-- `sending` — le grain auquel l'outbox et les événements rattachent chaque ligne. Une campagne masquée
-- des analytics (0093) n'y figure pas : même règle que les listes.
--
-- ⛔ MÊMES DÉFINITIONS QUE `campaign_send_stats` pour les événements (delivered/bounced/complained/
-- opened/clicked distincts par ligne d'outbox, tracked/tracking_unknown) : l'admin calcule les taux avec
-- la même `taux()`, donc un chiffre ne change pas de sens en passant de l'encart à la liste.

set local role postgres;

create or replace function newsletter.campaign_send_progress(p_asset_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = newsletter, pg_temp
as $$
with envois as (
  -- Les one-shot. ⛔ PAS une récurrente : son statut ne dit pas qu'une édition part — ce sont ses
  -- occurrences qui le disent (même définition de « récurrente » que 0093).
  select c.id as campaign_id, null::uuid as occurrence_id, c.name, false as recurring,
         null::integer as seq, null::date as local_date, c.scheduled_at, c.recipients_planned as planned
  from newsletter.campaign c
  where c.asset_id = p_asset_id
    and c.status = 'sending'
    and c.analytics_hidden_at is null
    and c.recurrence_days is null
    and not exists (select 1 from newsletter.campaign_occurrence o where o.campaign_id = c.id)
  union all
  select c.id, o.id, c.name, true, o.seq, o.local_date, o.scheduled_at, o.recipients_planned
  from newsletter.campaign_occurrence o
  join newsletter.campaign c on c.id = o.campaign_id
  where o.asset_id = p_asset_id
    and o.status = 'sending'
    and c.analytics_hidden_at is null
),
file as (
  select ob.campaign_id, ob.occurrence_id,
         count(*)::integer                                                    as queued,
         count(*) filter (where ob.status = 'sent')::integer                  as sent,
         count(*) filter (where ob.status = 'pending')::integer               as pending,
         count(*) filter (where ob.status = 'sending')::integer               as in_flight,
         count(*) filter (where ob.status = 'failed')::integer                as failed,
         count(*) filter (where ob.status = 'skipped')::integer               as skipped,
         count(*) filter (where ob.status = 'sent'
                            and ob.sent_at > now() - interval '15 minutes')::integer as sent_last_15m,
         min(ob.sent_at) filter (where ob.status = 'sent')                     as first_sent_at,
         max(ob.sent_at) filter (where ob.status = 'sent')                     as last_sent_at,
         min(ob.next_attempt_at) filter (where ob.status = 'pending')          as next_attempt_at
  from newsletter.email_outbox ob
  join envois e on e.campaign_id = ob.campaign_id
               and e.occurrence_id is not distinct from ob.occurrence_id
  where ob.asset_id = p_asset_id
  group by ob.campaign_id, ob.occurrence_id
),
ev as (
  select ev.campaign_id, ev.occurrence_id,
         count(distinct ev.outbox_id) filter (where ev.type = 'delivered')                    as delivered,
         count(distinct ev.outbox_id) filter (where ev.type = 'bounced')                      as bounced,
         count(distinct ev.outbox_id) filter (where ev.type = 'complained')                   as complained,
         count(distinct ev.outbox_id) filter (where ev.type = 'opened')                       as opened,
         count(distinct ev.outbox_id) filter (where ev.type = 'clicked')                      as clicked,
         count(distinct ev.outbox_id) filter (where ev.type = 'delivered' and ob.tracked)     as tracked,
         count(distinct ev.outbox_id) filter (where ev.type = 'delivered' and ob.tracked is null) as tracking_unknown
  from newsletter.email_event ev
  left join newsletter.email_outbox ob on ob.id = ev.outbox_id
  join envois e on e.campaign_id = ev.campaign_id
               and e.occurrence_id is not distinct from ev.occurrence_id
  where ev.asset_id = p_asset_id
  group by ev.campaign_id, ev.occurrence_id
)
select jsonb_build_object(
  'as_of', now(),
  'sending', coalesce((
    select jsonb_agg(jsonb_build_object(
             'campaign_id', e.campaign_id,
             'occurrence_id', e.occurrence_id,
             'name', e.name,
             'recurring', e.recurring,
             'seq', e.seq,
             'local_date', e.local_date,
             'scheduled_at', e.scheduled_at,
             'planned', e.planned,
             'queued', coalesce(f.queued, 0),
             'sent', coalesce(f.sent, 0),
             'pending', coalesce(f.pending, 0),
             'in_flight', coalesce(f.in_flight, 0),
             'failed', coalesce(f.failed, 0),
             'skipped', coalesce(f.skipped, 0),
             'sent_last_15m', coalesce(f.sent_last_15m, 0),
             'first_sent_at', f.first_sent_at,
             'last_sent_at', f.last_sent_at,
             'next_attempt_at', f.next_attempt_at,
             'delivered', coalesce(x.delivered, 0),
             'bounced', coalesce(x.bounced, 0),
             'complained', coalesce(x.complained, 0),
             'opened', coalesce(x.opened, 0),
             'clicked', coalesce(x.clicked, 0),
             'tracked', coalesce(x.tracked, 0),
             'tracking_unknown', coalesce(x.tracking_unknown, 0))
           order by e.scheduled_at nulls last, e.campaign_id, e.seq nulls first)
    from envois e
    left join file f on f.campaign_id = e.campaign_id and f.occurrence_id is not distinct from e.occurrence_id
    left join ev x on x.campaign_id = e.campaign_id and x.occurrence_id is not distinct from e.occurrence_id
  ), '[]'::jsonb)
);
$$;

revoke execute on function newsletter.campaign_send_progress(uuid) from public;
revoke execute on function newsletter.campaign_send_progress(uuid) from anon, authenticated;
grant  execute on function newsletter.campaign_send_progress(uuid) to service_role;

comment on function newsletter.campaign_send_progress(uuid) is
  'Envois EN COURS d''une marque (0096) : one-shot au statut sending, ou edition au statut sending, '
  'masquees (0093) exclues. Par envoi : planned (prevus au verrouillage), file (queued, sent, pending, '
  'in_flight, failed, skipped), sent_last_15m, premier/dernier envoi, prochain essai, et les memes '
  'evenements que campaign_send_stats. as_of = l''instant de la lecture.';

reset role;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVES — DANS la migration (voir 0072).
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig    constant text := 'newsletter.campaign_send_progress(uuid)';
  v_ecarts integer := 0;
  v_vus    integer := 0;
  v_asset  record;
  v_r      jsonb;
  v_un     jsonb;
  v_cible  record;
  v_statut text;
begin
  -- 1. Droits : definer, fermée hors service_role.
  if not (select prosecdef from pg_proc where oid = v_sig::regprocedure)
     or has_function_privilege('anon', v_sig, 'EXECUTE')
     or has_function_privilege('authenticated', v_sig, 'EXECUTE')
     or not has_function_privilege('service_role', v_sig, 'EXECUTE') then
    raise exception '[0096] security definer ou droits d''execution faux sur campaign_send_progress';
  end if;
  raise notice '[0096] contre-epreuve 1 OK : security definer, fermee hors service_role';

  -- 2. Sur les VRAIES données de chaque marque : l'ensemble rendu est EXACTEMENT celui des envois en
  --    cours (calculé ici autrement), et chaque compteur de file est égal au décompte direct de l'outbox.
  for v_asset in select a.id from newsletter.asset a loop
    v_r := newsletter.campaign_send_progress(v_asset.id);
    if (select count(*) from jsonb_array_elements(v_r -> 'sending'))
       <> (select count(*) from newsletter.campaign c
            where c.asset_id = v_asset.id and c.status = 'sending' and c.analytics_hidden_at is null
              and c.recurrence_days is null
              and not exists (select 1 from newsletter.campaign_occurrence o where o.campaign_id = c.id))
        + (select count(*) from newsletter.campaign_occurrence o join newsletter.campaign c on c.id = o.campaign_id
            where o.asset_id = v_asset.id and o.status = 'sending' and c.analytics_hidden_at is null) then
      v_ecarts := v_ecarts + 1;
    end if;
    select v_ecarts + count(*) into v_ecarts
      from jsonb_array_elements(v_r -> 'sending') s
     where (s ->> 'sent')::integer <> (select count(*) from newsletter.email_outbox ob
                                        where ob.campaign_id = (s ->> 'campaign_id')::uuid
                                          and ob.occurrence_id is not distinct from (s ->> 'occurrence_id')::uuid
                                          and ob.status = 'sent')
        or (s ->> 'pending')::integer + (s ->> 'in_flight')::integer
           <> (select count(*) from newsletter.email_outbox ob
                where ob.campaign_id = (s ->> 'campaign_id')::uuid
                  and ob.occurrence_id is not distinct from (s ->> 'occurrence_id')::uuid
                  and ob.status in ('pending', 'sending'))
        or (s ->> 'queued')::integer
           <> (s ->> 'sent')::integer + (s ->> 'pending')::integer + (s ->> 'in_flight')::integer
            + (s ->> 'failed')::integer + (s ->> 'skipped')::integer;
    v_vus := v_vus + jsonb_array_length(v_r -> 'sending');
  end loop;
  if v_ecarts > 0 then
    raise exception '[0096] % ecart(s) entre campaign_send_progress et l''outbox', v_ecarts;
  end if;
  raise notice '[0096] contre-epreuve 2 OK : % envoi(s) en cours, ensemble et compteurs egaux a l''outbox', v_vus;

  -- 3. Sur une VRAIE one-shot envoyée, dans un bloc ANNULÉ : absente tant qu'elle est `sent` ; passée
  --    `sending`, elle apparaît avec SES chiffres ; masquée, elle disparaît. Rien ne persiste.
  select c.id, c.asset_id, c.status into v_cible
    from newsletter.campaign c
   where c.status = 'sent' and c.analytics_hidden_at is null and c.recurrence_days is null
     and not exists (select 1 from newsletter.campaign_occurrence o where o.campaign_id = c.id)
     and exists (select 1 from newsletter.email_outbox ob where ob.campaign_id = c.id and ob.status = 'sent')
   order by c.sent_at desc nulls last
   limit 1;
  if v_cible.id is null then
    raise notice '[0096] contre-epreuve 3 SAUTEE : aucune one-shot envoyee en base';
  else
    begin
      if exists (select 1 from jsonb_array_elements(newsletter.campaign_send_progress(v_cible.asset_id) -> 'sending') s
                  where (s ->> 'campaign_id')::uuid = v_cible.id) then
        raise exception '[0096] une campagne deja envoyee est rendue comme en cours';
      end if;
      update newsletter.campaign set status = 'sending' where id = v_cible.id;
      select s into v_un
        from jsonb_array_elements(newsletter.campaign_send_progress(v_cible.asset_id) -> 'sending') s
       where (s ->> 'campaign_id')::uuid = v_cible.id;
      if v_un is null
         or (v_un ->> 'sent')::integer <> (select count(*) from newsletter.email_outbox
                                            where campaign_id = v_cible.id and status = 'sent')
         or (v_un ->> 'delivered')::integer <> (select count(distinct outbox_id) from newsletter.email_event
                                                 where campaign_id = v_cible.id and occurrence_id is null
                                                   and type = 'delivered')
         or v_un -> 'occurrence_id' <> 'null'::jsonb then
        raise exception '[0096] une one-shot passee sending n''est pas rendue avec ses chiffres';
      end if;
      update newsletter.campaign set analytics_hidden_at = now() where id = v_cible.id;
      if exists (select 1 from jsonb_array_elements(newsletter.campaign_send_progress(v_cible.asset_id) -> 'sending') s
                  where (s ->> 'campaign_id')::uuid = v_cible.id) then
        raise exception '[0096] une campagne masquee des analytics reste dans les envois en cours';
      end if;
      raise exception 'nf0096_retour';
    exception when raise_exception then
      if sqlerrm <> 'nf0096_retour' then
        raise;
      end if;
    end;
    select status into v_statut from newsletter.campaign where id = v_cible.id;
    if v_statut <> v_cible.status
       or exists (select 1 from newsletter.campaign where id = v_cible.id and analytics_hidden_at is not null) then
      raise exception '[0096] l''essai sur la campagne a persiste';
    end if;
    raise notice '[0096] contre-epreuve 3 OK : envoyee = absente, sending = rendue avec ses chiffres, masquee = absente ; essai annule';
  end if;

  -- 4. Le chemin des RÉCURRENTES : une VRAIE édition envoyée, passée `sending` dans un bloc ANNULÉ,
  --    apparaît comme édition (recurring, seq) avec les chiffres de CETTE édition seulement.
  select o.id, o.campaign_id, o.asset_id, o.seq, o.status into v_cible
    from newsletter.campaign_occurrence o
    join newsletter.campaign c on c.id = o.campaign_id
   where o.status = 'sent' and c.analytics_hidden_at is null
     and exists (select 1 from newsletter.email_outbox ob where ob.occurrence_id = o.id and ob.status = 'sent')
   order by o.sent_at desc nulls last
   limit 1;
  if v_cible.id is null then
    raise notice '[0096] contre-epreuve 4 SAUTEE : aucune edition envoyee en base';
  else
    begin
      update newsletter.campaign_occurrence set status = 'sending' where id = v_cible.id;
      select s into v_un
        from jsonb_array_elements(newsletter.campaign_send_progress(v_cible.asset_id) -> 'sending') s
       where (s ->> 'occurrence_id')::uuid = v_cible.id;
      if v_un is null
         or not (v_un ->> 'recurring')::boolean
         or (v_un ->> 'campaign_id')::uuid <> v_cible.campaign_id
         or (v_un ->> 'seq')::integer is distinct from v_cible.seq
         or (v_un ->> 'sent')::integer <> (select count(*) from newsletter.email_outbox
                                            where occurrence_id = v_cible.id and status = 'sent')
         or (v_un ->> 'delivered')::integer <> (select count(distinct outbox_id) from newsletter.email_event
                                                 where campaign_id = v_cible.campaign_id and occurrence_id = v_cible.id
                                                   and type = 'delivered') then
        raise exception '[0096] une edition passee sending n''est pas rendue avec SES chiffres';
      end if;
      raise exception 'nf0096_retour';
    exception when raise_exception then
      if sqlerrm <> 'nf0096_retour' then
        raise;
      end if;
    end;
    select status into v_statut from newsletter.campaign_occurrence where id = v_cible.id;
    if v_statut <> v_cible.status then
      raise exception '[0096] l''essai sur l''edition a persiste';
    end if;
    raise notice '[0096] contre-epreuve 4 OK : edition sending = rendue (recurring, seq) avec ses seuls chiffres ; essai annule';
  end if;
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0096', '0096_envois_en_cours.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
