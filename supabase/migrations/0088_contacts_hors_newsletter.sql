-- ---------------------------------------------------------------------------
-- 0088 — Les CONTACTS hors newsletter : un statut, une vue, une mise en file à part
-- ---------------------------------------------------------------------------
--
-- Décision d'Alix (24-25/09/2026) : les leads OptinForge d'une créative « pas newsletter » entrent
-- dans newsletter-forge SANS e-mail de confirmation, pour « des types de clients précis, 1 ou 2
-- mails max par an, ciblés ». Et (Q-E1, 25/09) : « Tous, j'assume le juridique » — un contact
-- désigné par un segment reçoit la campagne même sans finalité cochée, derrière une case explicite
-- par campagne.
--
-- ⛔ LE PRINCIPE QUI TIENT TOUT : UN CONTACT N'EST ATTEINT QUE PAR UNE RÈGLE QUI LE NOMME.
-- Les trois vues d'audience écrivent `status = 'active'` en dur : un contact y est invisible, donc
-- aucun envoi « toute la marque », aucun segment existant, aucune automation ne peut le toucher.
-- Il vit dans SA vue (`contact_subscription`), que seul un segment portant « Newsletter: No »
-- désigne (compilateur, `population`), et il n'entre en file que par SA fonction
-- (`enqueue_campaign_batch_contacts`), qui revalide contre cette vue.
--
-- ⚠️ CETTE MIGRATION N'ÉCRIT AUCUNE LIGNE DE DONNÉE ET N'ENVOIE RIEN : une valeur de statut
-- autorisée, une vue vide, une colonne à faux par défaut, une fonction que personne n'appelle
-- encore. La fonction et la vue existantes (0038, 0087) ne sont PAS touchées.

-- 1 — Le statut
alter table newsletter.subscription drop constraint subscription_status_check;
alter table newsletter.subscription add constraint subscription_status_check
  check (status in ('pending', 'active', 'unsubscribed', 'suppressed_soft', 'suppressed_hard',
                    'complained', 'deleted', 'contact'));

-- 2 — La vue des contacts : les MÊMES 40 colonnes que `sendable_subscription`, dans le même ordre,
--     sous les mêmes barrières (suppression COMPLÈTE, hors démonstration, hors sunset). Seul le
--     statut change. Les appelants choisissent l'une OU l'autre selon la règle, jamais les deux.
create view newsletter.contact_subscription as
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
  WHERE s.status = 'contact'::text
    AND NOT newsletter.is_suppressed(sub.email::text, s.asset_id)
    AND NOT sub.is_demo
    AND s.sunset_at IS NULL;

comment on view newsletter.contact_subscription is
  'Contacts hors newsletter (statut contact, 0088) : entrés sans double opt-in, atteints UNIQUEMENT par un segment qui porte « Newsletter: No ». Mêmes colonnes et mêmes barrières que sendable_subscription, statut contact au lieu de active.';

revoke all on newsletter.contact_subscription from public;
grant select on newsletter.contact_subscription to service_role;

-- 3 — La case explicite par campagne (Q-E1) : sans elle, un contact n'est atteint que pour la
--     finalité qu'il a cochée, comme un abonné.
alter table newsletter.campaign
  add column contacts_ignore_purpose boolean not null default false;

comment on column newsletter.campaign.contacts_ignore_purpose is
  'Q-E1 (Alix, 25/09/2026, « Tous, j''assume le juridique ») : vrai = les CONTACTS visés par le segment reçoivent cette campagne même sans avoir coché sa finalité. Sans effet sur les abonnés newsletter, dont la barrière de finalité reste entière.';

-- 4 — La mise en file des contacts : le reflet de `enqueue_campaign_batch` (0038), sur SA vue.
--     ⛔ Une fonction À PART, pas un paramètre de plus : l'ancienne reste octet pour octet ce qu'elle
--     était, et aucun appelant ne peut faire entrer un contact en oubliant un argument.
--     Le payload porte `audience: contacts` (et `ignore_purpose` si la case est cochée) : c'est ce
--     que relit la porte d'envoi (`gate.ts`) pour laisser passer le statut `contact`, et rien d'autre.
create or replace function newsletter.enqueue_campaign_batch_contacts(
  p_campaign_id uuid,
  p_occurrence_id uuid,
  p_subscription_ids uuid[]
) returns integer
language plpgsql
as $fn$
declare
  v_inserted integer;
  v_asset    uuid;
  v_purpose  text;
  v_ignore   boolean;
  v_subject  text;
  v_template uuid;
  v_marque   jsonb;
begin
  if p_subscription_ids is null or array_length(p_subscription_ids, 1) is null then
    return 0;
  end if;

  select c.asset_id, c.purpose, c.contacts_ignore_purpose into v_asset, v_purpose, v_ignore
    from newsletter.campaign c
   where c.id = p_campaign_id;

  if v_asset is null then
    raise exception 'enqueue_contacts: campaign % not found', p_campaign_id;
  end if;

  -- Même refus que 0038 : la ligne porte TOUJOURS une finalité, même quand la case la fait ignorer
  -- pour les contacts — c'est elle que les abonnés continuent de passer.
  if v_purpose is null then
    raise exception 'enqueue_contacts: campaign % has no purpose — the send gate would have nothing to compare', p_campaign_id;
  end if;

  if p_occurrence_id is not null then
    select o.subject, o.template_version_id into v_subject, v_template
      from newsletter.campaign_occurrence o
     where o.id = p_occurrence_id
       and o.campaign_id = p_campaign_id;
    if v_subject is null then
      raise exception 'enqueue_contacts: occurrence % does not belong to campaign %', p_occurrence_id, p_campaign_id;
    end if;
  else
    select c.subject, c.template_version_id into v_subject, v_template
      from newsletter.campaign c
     where c.id = p_campaign_id;
  end if;

  v_marque := case when v_ignore then '{"audience": "contacts", "ignore_purpose": true}'::jsonb
                   else '{"audience": "contacts"}'::jsonb end;

  -- ⛔ LA BARRIÈRE AU GOULOT : un identifiant qui n'est pas un contact envoyable de CETTE marque
  -- (abonné, désinscrit, supprimé, démo) est écarté par la jointure, quoi que dise l'appelant.
  insert into newsletter.email_outbox
    (asset_id, subscription_id, to_email, kind, subject, payload, purpose,
     campaign_id, template_version_id, occurrence_id)
  select v_asset,
         cs.id,
         sub.email,
         'campaign',
         v_subject,
         case when coalesce(sub.first_name, '') = '' then v_marque
              else v_marque || jsonb_build_object('first_name', sub.first_name) end,
         v_purpose,
         p_campaign_id,
         v_template,
         p_occurrence_id
    from newsletter.contact_subscription cs
    join newsletter.subscriber sub on sub.id = cs.subscriber_id
   where cs.id = any(p_subscription_ids)
     and cs.asset_id = v_asset
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$fn$;

comment on function newsletter.enqueue_campaign_batch_contacts(uuid, uuid, uuid[]) is
  'Reflet de enqueue_campaign_batch (0038) pour les CONTACTS (0088) : revalide contre contact_subscription, marque le payload audience=contacts (+ ignore_purpose si la campagne porte la case). Idempotente (ON CONFLICT DO NOTHING). N''envoie rien.';

revoke all on function newsletter.enqueue_campaign_batch_contacts(uuid, uuid, uuid[]) from public;
grant execute on function newsletter.enqueue_campaign_batch_contacts(uuid, uuid, uuid[]) to service_role;

-- 5 — Contre-épreuves
do $$
declare
  n int;
  v_def text;
  v_acl text;
  v_cols_s text;
  v_cols_c text;
begin
  -- 1. Le statut : les 7 anciennes valeurs + contact, et rien d'autre.
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'newsletter.subscription'::regclass and conname = 'subscription_status_check';
  if v_def is null
     or strpos(v_def, '''contact''') = 0 or strpos(v_def, '''pending''') = 0 or strpos(v_def, '''active''') = 0
     or strpos(v_def, '''unsubscribed''') = 0 or strpos(v_def, '''suppressed_soft''') = 0
     or strpos(v_def, '''suppressed_hard''') = 0 or strpos(v_def, '''complained''') = 0
     or strpos(v_def, '''deleted''') = 0 then
    raise exception '[0088] contrainte de statut inattendue : %', v_def;
  end if;

  -- 2. La vue des contacts a EXACTEMENT les colonnes de sendable_subscription, dans le même ordre.
  select string_agg(a.attname, ',' order by a.attnum) into v_cols_s
    from pg_attribute a where a.attrelid = 'newsletter.sendable_subscription'::regclass and a.attnum > 0 and not a.attisdropped;
  select string_agg(a.attname, ',' order by a.attnum) into v_cols_c
    from pg_attribute a where a.attrelid = 'newsletter.contact_subscription'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols_c is distinct from v_cols_s then
    raise exception '[0088] contact_subscription ne reprend pas les colonnes de sendable_subscription';
  end if;

  -- 3. Aucun contact n'existe encore : la vue est vide, et aucune des trois vues d'audience ne sert
  --    une ligne de statut autre que active (le statut neuf n'y entre pas).
  select count(*) into n from newsletter.contact_subscription;
  if n <> 0 then raise exception '[0088] contact_subscription devrait etre vide, % lignes', n; end if;
  select count(*) into n from newsletter.sendable_subscription where status <> 'active';
  if n <> 0 then raise exception '[0088] sendable_subscription sert % lignes non actives', n; end if;

  -- 4. La case : non nulle, fausse partout.
  select count(*) into n from newsletter.campaign where contacts_ignore_purpose;
  if n <> 0 then raise exception '[0088] % campagnes ont deja la case', n; end if;

  -- 5. Les droits : ni PUBLIC, ni anon, ni authenticated sur la vue et la fonction neuves.
  if has_table_privilege('anon', 'newsletter.contact_subscription', 'select')
     or has_table_privilege('authenticated', 'newsletter.contact_subscription', 'select') then
    raise exception '[0088] contact_subscription lisible par anon/authenticated';
  end if;
  select coalesce(array_to_string(p.proacl, ' '), '') into v_acl
    from pg_proc p where p.oid = 'newsletter.enqueue_campaign_batch_contacts(uuid,uuid,uuid[])'::regprocedure;
  if v_acl ~ '(^| )=X/' or strpos(v_acl, 'anon=') > 0 or strpos(v_acl, 'authenticated=') > 0 then
    raise exception '[0088] enqueue_campaign_batch_contacts executable trop largement : %', v_acl;
  end if;
  if not has_function_privilege('service_role', 'newsletter.enqueue_campaign_batch_contacts(uuid,uuid,uuid[])', 'execute') then
    raise exception '[0088] service_role ne peut pas appeler enqueue_campaign_batch_contacts';
  end if;

  -- 6. La fonction revalide contre la vue des CONTACTS et marque le payload.
  v_def := pg_get_functiondef('newsletter.enqueue_campaign_batch_contacts(uuid,uuid,uuid[])'::regprocedure);
  if strpos(v_def, 'from newsletter.contact_subscription cs') = 0
     or strpos(v_def, 'cs.asset_id = v_asset') = 0
     or strpos(v_def, '"audience": "contacts"') = 0
     or strpos(v_def, 'sendable_subscription') > 0 then
    raise exception '[0088] enqueue_campaign_batch_contacts ne lit pas la bonne vue';
  end if;

  raise notice '[0088] contre-epreuve OK : statut contact, vue de 40 colonnes vide, case a faux, droits fermes, file des contacts sur sa vue';
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0088', '0088_contacts_hors_newsletter.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
