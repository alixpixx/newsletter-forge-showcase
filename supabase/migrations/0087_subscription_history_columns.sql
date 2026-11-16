-- ============================================================================
-- 0087 — Ce qu'un abonné a reçu et s'il est revenu, en colonnes (Segments, famille « Automations »).
-- ============================================================================
--
-- ⭐ DEMANDE D'ALIX (24/09/2026, feature 4) : « dans Segment je veux tous les types d'automations qu'on a
-- créés ; si j'en crée de nouvelles je les veux automatiquement dans Segment ». Un segment se compile en
-- filtre de COLONNES sur les trois vues d'audience (`packages/segments`, jamais de SQL libre) : l'histoire
-- d'envoi et de consentement doit donc exister en colonnes sur `subscription`.
--
--  - `lifecycle_sent text[]`    : les e-mails de cycle de vie ACCEPTÉS par Mailgun (`email_outbox.status`
--                                  passé à `sent`) — confirmation, welcome, unsubscribe_ack, reengagement ;
--  - `automations_sent uuid[]`  : les automations dont un e-mail est parti (`kind` automation /
--                                  automation_tx, `payload->>'automation_id'`) ;
--  - `resubscribed_at`          : le dernier RETOUR — `resubscribe`, ou une confirmation (`optin_confirm`)
--                                  après une désinscription sur la même souscription.
--
-- ⛔ LA SOURCE EST `email_outbox` PASSÉ À `sent`, PAS `automation_send`. Ce dernier compte aussi le
-- sunset (`reason = 'sunset_marked'`, qui n'envoie rien) et des lignes encore en file ; « a reçu un
-- e-mail » veut dire qu'un e-mail est parti.
--
-- ⛔ UN DÉCLENCHEUR POSÉ ICI NE FAIT JAMAIS ÉCHOUER L'ÉCRITURE QUI L'APPELLE. `email_outbox` passe à
-- `sent` APRÈS que Mailgun a accepté l'e-mail : si cette écriture échouait, la ligne resterait
-- `sending` et l'e-mail pourrait repartir. `consent_event` est la preuve du consentement : elle doit
-- s'écrire quoi qu'il arrive. D'où `exception when others` + WARNING dans chaque déclencheur.
--
-- ⛔ MONOTONE : on ajoute un kind ou une automation, on avance une date — jamais on ne retire ni ne
-- recule. Rejouer un événement ne change rien.
--
-- ⚠️ « RETOUR » = `resubscribe`, ou `optin_confirm` précédé sur la même souscription d'un `unsubscribe`,
-- d'un `deletion_request` ou d'un `withdrawn` de la finalité `content` — ce dernier est ce qu'écrit
-- l'interrupteur « Newsletter » du centre de préférences, qui ne trace pas `unsubscribe`
-- (`apps/public/src/app/api/v1/preferences/handler.ts`). La règle de « Welcome back » (0082) ne compte pas
-- encore ce `withdrawn` : écart signalé, non corrigé ici.
--
-- ⛔ LES TROIS VUES D'AUDIENCE GARDENT LEURS LIGNES ET LEUR CONDITION. Les trois colonnes sont ajoutées
-- EN FIN de liste (Postgres n'accepte que ça) ; la contre-épreuve compare, avant et après, l'ensemble
-- des identifiants servis et le texte `FROM … WHERE` de chaque vue. `outbox_context` n'est pas touchée.

set local role postgres;

-- ============================================================================
-- 1 — Les colonnes
-- ============================================================================
-- `not null default '{}'` : un tableau NULL ne répond à aucun `ov`/`not.ov`, et « n'a jamais reçu »
-- raterait tout le monde (même raison que 0063).
alter table newsletter.subscription
  add column if not exists lifecycle_sent   text[] not null default '{}',
  add column if not exists automations_sent uuid[] not null default '{}',
  add column if not exists resubscribed_at  timestamptz;

create index if not exists subscription_lifecycle_sent_gin   on newsletter.subscription using gin (lifecycle_sent);
create index if not exists subscription_automations_sent_gin on newsletter.subscription using gin (automations_sent);

-- ============================================================================
-- 2 — Les deux gestes, en fonctions (appelées par les déclencheurs ET par le rattrapage)
-- ============================================================================
create or replace function newsletter.subscription_note_sent(
  p_subscription_id uuid,
  p_kind            text,
  p_payload         jsonb
)
returns void
language plpgsql
security definer
set search_path to 'newsletter', 'public'
as $$
declare
  v_auto text := p_payload ->> 'automation_id';
begin
  if p_subscription_id is null then
    return;
  end if;
  if p_kind in ('confirmation', 'welcome', 'unsubscribe_ack', 'reengagement') then
    update newsletter.subscription
       set lifecycle_sent = array_append(lifecycle_sent, p_kind)
     where id = p_subscription_id
       and not (p_kind = any (lifecycle_sent));
  elsif p_kind in ('automation', 'automation_tx')
        and v_auto ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    update newsletter.subscription
       set automations_sent = array_append(automations_sent, v_auto::uuid)
     where id = p_subscription_id
       and not (v_auto::uuid = any (automations_sent));
  end if;
end;
$$;

create or replace function newsletter.subscription_note_return(
  p_subscription_id uuid,
  p_event_type      text,
  p_event_id        bigint,
  p_occurred_at     timestamptz
)
returns void
language plpgsql
security definer
set search_path to 'newsletter', 'public'
as $$
begin
  if p_subscription_id is null or p_occurred_at is null then
    return;
  end if;
  if p_event_type = 'resubscribe'
     or (p_event_type = 'optin_confirm' and exists (
           select 1 from newsletter.consent_event p
            where p.subscription_id = p_subscription_id
              and p.id < p_event_id
              and (p.event_type in ('unsubscribe', 'deletion_request')
                   or (p.event_type = 'withdrawn' and p.purpose = 'content')))) then
    update newsletter.subscription
       set resubscribed_at = p_occurred_at
     where id = p_subscription_id
       and (resubscribed_at is null or resubscribed_at < p_occurred_at);
  end if;
end;
$$;

revoke all on function newsletter.subscription_note_sent(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function newsletter.subscription_note_return(uuid, text, bigint, timestamptz) from public, anon, authenticated;

-- ============================================================================
-- 3 — Les déclencheurs (AVANT le rattrapage : aucun envoi ne tombe entre les deux)
-- ============================================================================
create or replace function newsletter.trg_email_outbox_note_sent()
returns trigger
language plpgsql
security definer
set search_path to 'newsletter', 'public'
as $$
begin
  begin
    perform newsletter.subscription_note_sent(new.subscription_id, new.kind, new.payload);
  exception when others then
    raise warning '[0087] subscription_note_sent en echec (email_outbox %) : %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function newsletter.trg_consent_event_note_return()
returns trigger
language plpgsql
security definer
set search_path to 'newsletter', 'public'
as $$
begin
  begin
    perform newsletter.subscription_note_return(new.subscription_id, new.event_type, new.id, new.occurred_at);
  exception when others then
    raise warning '[0087] subscription_note_return en echec (consent_event %) : %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function newsletter.trg_email_outbox_note_sent() from public, anon, authenticated;
revoke all on function newsletter.trg_consent_event_note_return() from public, anon, authenticated;

drop trigger if exists email_outbox_note_sent_upd on newsletter.email_outbox;
create trigger email_outbox_note_sent_upd
  after update of status on newsletter.email_outbox
  for each row
  when (new.status = 'sent' and old.status is distinct from 'sent')
  execute function newsletter.trg_email_outbox_note_sent();

drop trigger if exists email_outbox_note_sent_ins on newsletter.email_outbox;
create trigger email_outbox_note_sent_ins
  after insert on newsletter.email_outbox
  for each row
  when (new.status = 'sent')
  execute function newsletter.trg_email_outbox_note_sent();

drop trigger if exists consent_event_note_return on newsletter.consent_event;
create trigger consent_event_note_return
  after insert on newsletter.consent_event
  for each row
  when (new.event_type in ('resubscribe', 'optin_confirm'))
  execute function newsletter.trg_consent_event_note_return();

-- ============================================================================
-- 4 — Le rattrapage, UNE fois, par les MÊMES fonctions que les déclencheurs
-- ============================================================================
do $$
begin
  perform newsletter.subscription_note_sent(o.subscription_id, o.kind, o.payload)
     from newsletter.email_outbox o
    where o.status = 'sent'
      and o.subscription_id is not null
      and o.kind in ('confirmation', 'welcome', 'unsubscribe_ack', 'reengagement', 'automation', 'automation_tx')
    order by o.created_at, o.id;

  perform newsletter.subscription_note_return(c.subscription_id, c.event_type, c.id, c.occurred_at)
     from newsletter.consent_event c
    where c.event_type in ('resubscribe', 'optin_confirm')
    order by c.id;
end
$$;

-- ============================================================================
-- 5 — Les trois vues d'audience : trois colonnes EN FIN, rien d'autre
-- ============================================================================
create temporary table _vues_0087 (vue text primary key, ids text not null, corps text not null) on commit drop;

do $$
declare
  v text;
  d text;
begin
  foreach v in array array['sendable_subscription', 'sunsetted_subscription', 'excluded_demo_subscription'] loop
    d := pg_get_viewdef(format('newsletter.%I', v)::regclass);
    execute format(
      'insert into _vues_0087 select %L, (select md5(coalesce(string_agg(id::text, '','' order by id), '''')) from newsletter.%I), %L',
      v, v, substr(d, strpos(d, 'FROM')));
  end loop;
end
$$;

create or replace view newsletter.sendable_subscription as
 SELECT s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source,
    s.source_detail, s.language, s.consent_state, s.consent_version_id, s.consent_ip,
    s.consent_method, s.consent_at, s.open_count, s.click_count, s.last_open_at,
    s.last_click_at, s.last_engagement_at, s.engagement_score, s.engagement_level,
    s.welcome_completed, s.soft_bounce_count, s.tag_ids, s.created_at, s.country,
    s.tracking_consent, s.tracking_consent_at, s.granted_purposes, s.optin_id, s.sunset_at,
    s.last_response_at,
    s.capture_campaign_id, s.capture_campaign_ids, s.capture_optin_ids,
    s.interest_ids, s.capture_pair_keys, s.capture_event_count,
    s.lifecycle_sent, s.automations_sent, s.resubscribed_at
   FROM newsletter.subscription s
     JOIN newsletter.subscriber sub ON sub.id = s.subscriber_id
  WHERE s.status = 'active'::text
    AND NOT newsletter.is_suppressed(sub.email::text, s.asset_id)
    AND NOT sub.is_demo
    AND s.sunset_at IS NULL;

create or replace view newsletter.sunsetted_subscription as
 SELECT s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source,
    s.source_detail, s.language, s.consent_state, s.consent_version_id, s.consent_ip,
    s.consent_method, s.consent_at, s.open_count, s.click_count, s.last_open_at,
    s.last_click_at, s.last_engagement_at, s.engagement_score, s.engagement_level,
    s.welcome_completed, s.soft_bounce_count, s.tag_ids, s.created_at, s.country,
    s.tracking_consent, s.tracking_consent_at, s.granted_purposes, s.optin_id, s.sunset_at,
    s.last_response_at,
    s.capture_campaign_id, s.capture_campaign_ids, s.capture_optin_ids,
    s.interest_ids, s.capture_pair_keys, s.capture_event_count,
    s.lifecycle_sent, s.automations_sent, s.resubscribed_at
   FROM newsletter.subscription s
     JOIN newsletter.subscriber sub ON sub.id = s.subscriber_id
  WHERE s.status = 'active'::text
    AND NOT newsletter.is_suppressed(sub.email::text, s.asset_id)
    AND NOT sub.is_demo
    AND s.sunset_at IS NOT NULL;

create or replace view newsletter.excluded_demo_subscription as
 SELECT s.id, s.subscriber_id, s.asset_id, s.edition_id, s.status, s.source,
    s.source_detail, s.language, s.consent_state, s.consent_version_id, s.consent_ip,
    s.consent_method, s.consent_at, s.open_count, s.click_count, s.last_open_at,
    s.last_click_at, s.last_engagement_at, s.engagement_score, s.engagement_level,
    s.welcome_completed, s.soft_bounce_count, s.tag_ids, s.created_at, s.country,
    s.tracking_consent, s.tracking_consent_at, s.granted_purposes, s.optin_id, s.sunset_at,
    s.last_response_at,
    s.capture_campaign_id, s.capture_campaign_ids, s.capture_optin_ids,
    s.interest_ids, s.capture_pair_keys, s.capture_event_count,
    s.lifecycle_sent, s.automations_sent, s.resubscribed_at
   FROM newsletter.subscription s
     JOIN newsletter.subscriber sub ON sub.id = s.subscriber_id
  WHERE s.status = 'active'::text
    AND NOT newsletter.is_suppressed(sub.email::text, s.asset_id)
    AND sub.is_demo;

-- ============================================================================
-- 6 — Contre-épreuves
-- ============================================================================
do $$
declare
  r record;
  n int;
  v_attendu int;
  v_obtenu int;
  v_sub uuid;
  v_avant text[];
  v_ids text;
  v_fin text;
  v_auto uuid := '00000000-0000-4000-8000-000000000087';
begin
  -- 1. Chaque vue sert EXACTEMENT les mêmes souscriptions, sous la même condition, et finit par les
  --    trois colonnes neuves, dans cet ordre (40 colonnes).
  for r in select * from _vues_0087 loop
    execute format('select md5(coalesce(string_agg(id::text, '','' order by id), '''')) from newsletter.%I', r.vue) into v_ids;
    if v_ids <> r.ids then
      raise exception '[0087] % ne sert plus les memes souscriptions', r.vue;
    end if;
    if substr(pg_get_viewdef(format('newsletter.%I', r.vue)::regclass),
              strpos(pg_get_viewdef(format('newsletter.%I', r.vue)::regclass), 'FROM')) <> r.corps then
      raise exception '[0087] % : la condition FROM/WHERE a change', r.vue;
    end if;
    select count(*),
           string_agg(a.attname, ',' order by a.attnum) filter (where a.attnum > 37)
      into n, v_fin
      from pg_attribute a
     where a.attrelid = format('newsletter.%I', r.vue)::regclass and a.attnum > 0 and not a.attisdropped;
    if n <> 40 or v_fin is distinct from 'lifecycle_sent,automations_sent,resubscribed_at' then
      raise exception '[0087] % : % colonnes, fin = %, attendu 40 et lifecycle_sent,automations_sent,resubscribed_at', r.vue, n, v_fin;
    end if;
  end loop;
  raise notice '[0087] contre-epreuve 1 OK : 3 vues, memes lignes, meme condition, 3 colonnes en fin';

  -- 2. Le rattrapage retrouve EXACTEMENT l'historique, recompté ici par une autre requête.
  select count(*) into v_attendu
    from (select distinct subscription_id, kind from newsletter.email_outbox
           where status = 'sent' and subscription_id is not null
             and kind in ('confirmation', 'welcome', 'unsubscribe_ack', 'reengagement')) x;
  select coalesce(sum(cardinality(lifecycle_sent)), 0) into v_obtenu from newsletter.subscription;
  if v_obtenu <> v_attendu then
    raise exception '[0087] lifecycle_sent : % paires posees, % dans email_outbox', v_obtenu, v_attendu;
  end if;
  select count(*) into n
    from (select distinct subscription_id, payload ->> 'automation_id' from newsletter.email_outbox
           where status = 'sent' and subscription_id is not null and kind in ('automation', 'automation_tx')) x;
  select coalesce(sum(cardinality(automations_sent)), 0) into v_obtenu from newsletter.subscription;
  if v_obtenu <> n then
    raise exception '[0087] automations_sent : % paires posees, % dans email_outbox', v_obtenu, n;
  end if;
  select count(distinct ce.subscription_id) into v_attendu
    from newsletter.consent_event ce
   where ce.subscription_id is not null
     and (ce.event_type = 'resubscribe'
          or (ce.event_type = 'optin_confirm' and exists (
                select 1 from newsletter.consent_event p
                 where p.subscription_id = ce.subscription_id and p.id < ce.id
                   and (p.event_type in ('unsubscribe', 'deletion_request')
                        or (p.event_type = 'withdrawn' and p.purpose = 'content')))));
  select count(*) into v_obtenu from newsletter.subscription where resubscribed_at is not null;
  if v_obtenu <> v_attendu then
    raise exception '[0087] resubscribed_at : % souscriptions, % retours dans consent_event', v_obtenu, v_attendu;
  end if;
  raise notice '[0087] contre-epreuve 2 OK : rattrapage = historique (% paires cycle de vie, % automations, % retours)',
    (select coalesce(sum(cardinality(lifecycle_sent)), 0) from newsletter.subscription), n, v_attendu;

  -- 3. Les gestes sont MONOTONES et IDEMPOTENTS, et une donnée illisible ne lève pas. Tout est annulé.
  select id into v_sub from newsletter.subscription order by created_at limit 1;
  if v_sub is null then
    raise exception '[0087] aucune souscription pour la contre-epreuve';
  end if;
  begin
    update newsletter.subscription set lifecycle_sent = '{}', automations_sent = '{}', resubscribed_at = null where id = v_sub;
    perform newsletter.subscription_note_sent(v_sub, 'welcome', '{}'::jsonb);
    perform newsletter.subscription_note_sent(v_sub, 'welcome', '{}'::jsonb);
    perform newsletter.subscription_note_sent(v_sub, 'campaign', '{}'::jsonb);
    perform newsletter.subscription_note_sent(v_sub, 'test', '{}'::jsonb);
    perform newsletter.subscription_note_sent(v_sub, 'automation', jsonb_build_object('automation_id', v_auto));
    perform newsletter.subscription_note_sent(v_sub, 'automation_tx', jsonb_build_object('automation_id', v_auto));
    perform newsletter.subscription_note_sent(v_sub, 'automation', jsonb_build_object('automation_id', 'pas-un-uuid'));
    perform newsletter.subscription_note_sent(v_sub, 'automation', null);
    perform newsletter.subscription_note_sent(null, 'welcome', '{}'::jsonb);
    perform newsletter.subscription_note_return(v_sub, 'resubscribe', 9223372036854775807, '2026-09-20T10:00:00Z');
    perform newsletter.subscription_note_return(v_sub, 'resubscribe', 9223372036854775807, '2026-09-10T10:00:00Z');
    perform newsletter.subscription_note_return(v_sub, 'granted', 9223372036854775807, '2026-09-30T10:00:00Z');
    select lifecycle_sent into v_avant from newsletter.subscription where id = v_sub;
    if v_avant <> array['welcome']
       or (select automations_sent from newsletter.subscription where id = v_sub) <> array[v_auto]
       or (select resubscribed_at from newsletter.subscription where id = v_sub) <> '2026-09-20T10:00:00Z'::timestamptz then
      raise exception '[0087] gestes : lifecycle=%, automations=%, retour=%', v_avant,
        (select automations_sent from newsletter.subscription where id = v_sub),
        (select resubscribed_at from newsletter.subscription where id = v_sub);
    end if;
    raise exception 'annuler';
  exception when raise_exception then
    if sqlerrm <> 'annuler' then raise; end if;
  end;
  raise notice '[0087] contre-epreuve 3 OK : un kind une fois, campaign/test ignores, automation_id illisible ignore, date jamais reculee';

  -- 4. Les trois déclencheurs sont là, AFTER, ligne par ligne, et chacun avale ses erreurs.
  select count(*) into n
    from pg_trigger t
   where not t.tgisinternal
     and t.tgname in ('email_outbox_note_sent_upd', 'email_outbox_note_sent_ins', 'consent_event_note_return')
     and (t.tgtype & 1) = 1          -- FOR EACH ROW
     and (t.tgtype & 2) = 0;         -- AFTER
  if n <> 3 then
    raise exception '[0087] % declencheurs AFTER ROW sur 3', n;
  end if;
  if (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'newsletter'
         and p.proname in ('trg_email_outbox_note_sent', 'trg_consent_event_note_return')
         and pg_get_functiondef(p.oid) ~* 'exception\s+when\s+others\s+then\s+raise\s+warning') <> 2 then
    raise exception '[0087] un declencheur ne rattrape pas ses erreurs : il pourrait faire echouer un envoi';
  end if;
  if has_function_privilege('anon', 'newsletter.subscription_note_sent(uuid, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'newsletter.subscription_note_return(uuid, text, bigint, timestamptz)', 'execute') then
    raise exception '[0087] une fonction de 0087 est executable par anon ou authenticated';
  end if;
  raise notice '[0087] contre-epreuve 4 OK : 3 declencheurs AFTER ROW, erreurs rattrapees, fonctions fermees';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0087', '0087_subscription_history_columns.sql', now(), true)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = true;
