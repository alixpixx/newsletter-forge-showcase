-- ============================================================================
-- 0085 — Statistiques d'envoi par campagne et par édition (Overview « Recent campaigns »,
--        Analytics › Campaigns), et le suivi ouverture/clic MÉMORISÉ au moment de l'envoi.
-- ============================================================================
--
-- ⭐ DEMANDE D'ALIX (24/09/2026), features 6 et 7, définitions validées :
--   Sent = acceptés par Mailgun · Bounce = rebonds DÉFINITIFS · Spam = plaintes · Open et Click UNIQUES
--   (un destinataire compte une fois) · Open rate et CTR = sur les DÉLIVRÉS SUIVIS.
--
-- ⛔ POURQUOI UNE COLONNE `tracked`. Le worker décide message par message si l'ouverture et le clic
-- sont suivis (`gate.ts` : type d'envoi × `tracking_consent`) et ne l'écrivait nulle part. Sans elle,
-- un taux d'ouverture se calculerait sur TOUS les délivrés — mesuré le 24/09 : 1 abonnement sur 1 269
-- accepte le suivi, donc « 0 % d'ouverture » partout, un zéro FABRIQUÉ (règle du dépôt : inconnu ≠ 0).
-- `tracked` vaut `null` pour tout ce qui est parti avant ce lot : INCONNU, jamais « non suivi ».
--
-- ⛔ UNE SURCHARGE, PAS UN REMPLACEMENT. `outbox_mark_sent(uuid, text)` est appelée APRÈS l'acceptation
-- par Mailgun ; si elle échoue, la ligne reste `sending` et `claim_outbox` la reprend au bout de
-- `p_stale_seconds` — c'est-à-dire la RENVOIE. La modifier (drop + create, ou paramètre par défaut)
-- ouvrirait une fenêtre où le worker EN LIGNE appelle une signature que le cache de l'API ne connaît
-- plus. On AJOUTE donc `(uuid, text, boolean)` sans défaut : l'API choisit par les noms de paramètres,
-- l'ancienne reste octet pour octet identique (contre-épreuve 1), et le nouveau worker retombe sur
-- elle si la surcharge est inconnue (`db.ts`, repli testé).
--
-- ⚠️ `sent` : le compteur posé par la réconciliation (`recipients_sent`, figé à la clôture) et, tant
-- qu'il n'est pas posé, le décompte vivant des lignes `sent` de l'outbox. Événements : distincts par
-- ligne d'outbox (un destinataire d'une édition), lus dans `email_event` qui porte déjà `campaign_id`
-- et `occurrence_id` — d'où l'index.

set local role postgres;

alter table newsletter.email_outbox add column if not exists tracked boolean;

comment on column newsletter.email_outbox.tracked is
  'Suivi ouverture/clic ACTIVE pour cet envoi, decide par le worker (gate.ts) et ecrit par '
  'outbox_mark_sent(uuid,text,boolean). null = parti avant 0085 (ou repli du worker) : INCONNU, jamais « non suivi ».';

create or replace function newsletter.outbox_mark_sent(p_id uuid, p_provider_message_id text, p_tracked boolean)
returns void language sql security definer set search_path = newsletter as $$
  update newsletter.email_outbox
     set status='sent', sent_at=now(), provider_message_id=p_provider_message_id,
         locked_at=null, locked_by=null, error=null, tracked=p_tracked
   where id=p_id and status='sending';
$$;
revoke execute on function newsletter.outbox_mark_sent(uuid, text, boolean) from public;
revoke execute on function newsletter.outbox_mark_sent(uuid, text, boolean) from anon, authenticated;
grant  execute on function newsletter.outbox_mark_sent(uuid, text, boolean) to service_role;

create index if not exists ix_email_event_campaign
  on newsletter.email_event (campaign_id, occurrence_id)
  where campaign_id is not null;

create or replace function newsletter.campaign_send_stats(
  p_asset_id    uuid,
  p_campaign_id uuid        default null,
  p_since       timestamptz default null,
  p_search      text        default null,
  p_limit       integer     default 5,
  p_offset      integer     default 0
) returns jsonb
language sql
stable
security definer
set search_path = newsletter, pg_temp
as $$
with camp as (
  select c.id, c.name, c.status, c.archived_at, c.sent_at, c.recipients_sent,
         (c.recurrence_days is not null
          or exists (select 1 from newsletter.campaign_occurrence o where o.campaign_id = c.id)) as recurring,
         greatest(c.sent_at,
                  (select max(o.sent_at) from newsletter.campaign_occurrence o
                    where o.campaign_id = c.id and o.sent_at is not null)) as last_sent_at
  from newsletter.campaign c
  where c.asset_id = p_asset_id
    and (p_campaign_id is null or c.id = p_campaign_id)
    -- Recherche littérale : `%` et `_` tapés par l'utilisateur ne sont pas des jokers.
    and (nullif(btrim(p_search), '') is null
         or c.name ilike '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%')
),
-- Seules les campagnes qui ont ENVOYÉ, archivées comprises (décision d'Alix du 24/09).
envoyees as (
  select * from camp
  where last_sent_at is not null
    and (p_since is null or last_sent_at >= p_since)
),
page as (
  select * from envoyees
  order by last_sent_at desc, id
  limit greatest(coalesce(p_limit, 5), 0) offset greatest(coalesce(p_offset, 0), 0)
),
-- Une ligne par envoi : chaque édition envoyée, et l'envoi unique d'une campagne one-shot
-- (`occurrence_id` nul), exactement comme l'outbox et les événements les rattachent.
editions as (
  select o.campaign_id, o.id as occurrence_id, o.seq, o.local_date, o.sent_at, o.recipients_sent as compteur
  from newsletter.campaign_occurrence o
  join page p on p.id = o.campaign_id
  where o.sent_at is not null
  union all
  select p.id, null::uuid, null::integer, null::date, p.sent_at, p.recipients_sent
  from page p
  where p.sent_at is not null
),
vivant as (
  select ob.campaign_id, ob.occurrence_id, count(*)::integer as sent
  from newsletter.email_outbox ob
  where ob.asset_id = p_asset_id
    and ob.campaign_id in (select id from page)
    and ob.status = 'sent'
  group by ob.campaign_id, ob.occurrence_id
),
ev as (
  select e.campaign_id, e.occurrence_id,
         count(distinct e.outbox_id) filter (where e.type = 'delivered')                    as delivered,
         count(distinct e.outbox_id) filter (where e.type = 'bounced')                      as bounced,
         count(distinct e.outbox_id) filter (where e.type = 'complained')                   as complained,
         count(distinct e.outbox_id) filter (where e.type = 'opened')                       as opened,
         count(distinct e.outbox_id) filter (where e.type = 'clicked')                      as clicked,
         count(distinct e.outbox_id) filter (where e.type = 'delivered' and ob.tracked)     as tracked,
         count(distinct e.outbox_id) filter (where e.type = 'delivered' and ob.tracked is null) as tracking_unknown
  from newsletter.email_event e
  left join newsletter.email_outbox ob on ob.id = e.outbox_id
  where e.asset_id = p_asset_id
    and e.campaign_id in (select id from page)
  group by e.campaign_id, e.occurrence_id
)
select jsonb_build_object(
  'total', (select count(*) from envoyees),
  'campaigns', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id,
             'name', p.name,
             'status', p.status,
             'archived', p.archived_at is not null,
             'recurring', p.recurring,
             'last_sent_at', p.last_sent_at,
             'editions', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'occurrence_id', ed.occurrence_id,
                        'seq', ed.seq,
                        'local_date', ed.local_date,
                        'sent_at', ed.sent_at,
                        'sent', coalesce(ed.compteur, v.sent, 0),
                        'delivered', coalesce(x.delivered, 0),
                        'bounced', coalesce(x.bounced, 0),
                        'complained', coalesce(x.complained, 0),
                        'opened', coalesce(x.opened, 0),
                        'clicked', coalesce(x.clicked, 0),
                        'tracked', coalesce(x.tracked, 0),
                        'tracking_unknown', coalesce(x.tracking_unknown, 0))
                      order by ed.sent_at desc nulls last, ed.seq desc nulls last)
               from editions ed
               left join vivant v on v.campaign_id = ed.campaign_id
                                 and v.occurrence_id is not distinct from ed.occurrence_id
               left join ev x on x.campaign_id = ed.campaign_id
                             and x.occurrence_id is not distinct from ed.occurrence_id
               where ed.campaign_id = p.id), '[]'::jsonb))
           order by p.last_sent_at desc, p.id)
    from page p), '[]'::jsonb)
);
$$;

revoke execute on function newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer) from public;
revoke execute on function newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer) from anon, authenticated;
grant  execute on function newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer) to service_role;

comment on function newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer) is
  'Campagnes d''UNE marque qui ont envoye (archivees comprises), les plus recentes d''abord, avec une ligne '
  'par envoi (edition, ou envoi unique d''une one-shot) : sent (compteur de reconciliation, sinon decompte '
  'vivant), delivered/bounced/complained/opened/clicked distincts par ligne d''outbox, tracked = delivres dont '
  'le suivi etait ACTIF, tracking_unknown = delivres partis avant 0085. Les taux se calculent sur tracked.';

reset role;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVES — DANS la migration (voir 0072).
-- ---------------------------------------------------------------------------
do $$
declare
  v_src      text;
  v_asset    record;
  v_fuites   integer := 0;
  v_ecarts   integer := 0;
  v_r        jsonb;
begin
  -- 1. L'envoi : l'ancienne signature INTACTE, la surcharge fermée à l'API publique et gardée.
  if (select md5(prosrc) from pg_proc
       where oid = 'newsletter.outbox_mark_sent(uuid, text)'::regprocedure)
     is distinct from 'd3a18ad11bbc1f7f1184afcff1e9908e' then
    raise exception '[0085] outbox_mark_sent(uuid,text) a change : le worker en ligne l''appelle';
  end if;
  if not has_function_privilege('service_role', 'newsletter.outbox_mark_sent(uuid, text)', 'EXECUTE') then
    raise exception '[0085] service_role a perdu outbox_mark_sent(uuid,text)';
  end if;
  select prosrc into v_src from pg_proc
   where oid = 'newsletter.outbox_mark_sent(uuid, text, boolean)'::regprocedure and prosecdef;
  if v_src is null
     or v_src !~ 'tracked=p_tracked'
     or v_src !~ 'status=''sending'''
     or has_function_privilege('anon', 'newsletter.outbox_mark_sent(uuid, text, boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'newsletter.outbox_mark_sent(uuid, text, boolean)', 'EXECUTE')
     or not has_function_privilege('service_role', 'newsletter.outbox_mark_sent(uuid, text, boolean)', 'EXECUTE') then
    raise exception '[0085] outbox_mark_sent(uuid,text,boolean) absente, sans garde sending, sans tracked, ou mal ouverte';
  end if;
  if (select pronargdefaults from pg_proc
       where oid = 'newsletter.outbox_mark_sent(uuid, text, boolean)'::regprocedure) <> 0 then
    raise exception '[0085] la surcharge a un defaut : l''appel a 2 arguments deviendrait ambigu';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'newsletter' and table_name = 'email_outbox'
                    and column_name = 'tracked' and data_type = 'boolean' and is_nullable = 'YES') then
    raise exception '[0085] email_outbox.tracked absente, pas booleenne, ou NOT NULL';
  end if;
  raise notice '[0085] contre-epreuve 1 OK : outbox_mark_sent(uuid,text) intacte, surcharge a 3 arguments gardee et fermee, tracked nullable';

  -- 2. Les statistiques : fermées hors service_role, et AUCUNE campagne d'une autre marque, sur les
  --    VRAIES données de chaque marque ; `sent` égal au compteur quand il est posé.
  if has_function_privilege('anon', 'newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer)', 'EXECUTE') then
    raise exception '[0085] droits d''execution de campaign_send_stats faux';
  end if;
  for v_asset in select distinct asset_id from newsletter.campaign loop
    v_r := newsletter.campaign_send_stats(v_asset.asset_id, null, null, null, 1000, 0);
    select count(*) into v_fuites
      from jsonb_array_elements(v_r -> 'campaigns') c
     where not exists (select 1 from newsletter.campaign k
                        where k.id = (c ->> 'id')::uuid and k.asset_id = v_asset.asset_id);
    if v_fuites > 0 then
      raise exception '[0085] % campagne(s) d''une autre marque rendue(s) pour %', v_fuites, v_asset.asset_id;
    end if;
    select count(*) into v_ecarts
      from jsonb_array_elements(v_r -> 'campaigns') c
     cross join lateral jsonb_array_elements(c -> 'editions') e
      left join newsletter.campaign_occurrence o on o.id = (e ->> 'occurrence_id')::uuid
      left join newsletter.campaign k on k.id = (c ->> 'id')::uuid and e ->> 'occurrence_id' is null
     where coalesce(o.recipients_sent, k.recipients_sent) is not null
       and (e ->> 'sent')::integer <> coalesce(o.recipients_sent, k.recipients_sent);
    if v_ecarts > 0 then
      raise exception '[0085] % envoi(s) dont sent differe du compteur de reconciliation', v_ecarts;
    end if;
  end loop;
  if (newsletter.campaign_send_stats(gen_random_uuid()) ->> 'total')::integer <> 0 then
    raise exception '[0085] une marque inconnue rend des campagnes';
  end if;
  raise notice '[0085] contre-epreuve 2 OK : campaign_send_stats fermee hors service_role, aucune fuite entre marques, sent = compteur';

  -- 3. L'index qui sert l'agrégation par campagne.
  if not exists (select 1 from pg_indexes
                  where schemaname = 'newsletter' and indexname = 'ix_email_event_campaign') then
    raise exception '[0085] index ix_email_event_campaign absent';
  end if;
  raise notice '[0085] contre-epreuve 3 OK : index email_event (campaign_id, occurrence_id)';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0085', '0085_campaign_send_stats.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
