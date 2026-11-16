-- ============================================================================
-- 0092 — Suivi des ouvertures/clics « pour tous » par marque, refus explicite, détail des événements
-- ============================================================================
--
-- ⭐ DÉCISION D'ALIX (07/10/2026) : « Suivi pour tous ». Mesuré le 07/10 : 0 `opened` et 0 `clicked`
-- dans `email_event` depuis toujours, parce que le worker ne demandait le suivi qu'aux abonnés dont
-- `tracking_consent = true` — 0 actif sur 1 155. Le risque juridique (un pixel de suivi demande en
-- principe un consentement au Royaume-Uni et dans l'UE) a été signalé AVANT la décision.
--
-- ⛔ D'OÙ UN RÉGLAGE PAR MARQUE, PAS UNE CONSTANTE. `asset.tracking_mode` :
--   'all'     — suivi pour tous les destinataires, SAUF refus explicite (défaut, décision d'Alix) ;
--   'consent' — suivi seulement pour qui l'a accepté (règle d'avant 0092).
-- Si le juridique objecte pour une marque, on la repasse en 'consent' sans une ligne de code.
--
-- ⛔ UN « NON » EXPLICITE RESTE UN NON. Le centre de préférences laisse couper le suivi
-- (`set_tracking`, consent_event `withdrawn` + metadata.tracking_consent). Un mode 'all' qui
-- l'ignorerait proposerait un choix que le système ne respecte pas. `subscription.tracking_refused_at`
-- garde ce refus ; une case d'inscription laissée DÉCOCHÉE n'en est pas un (personne n'a dit non).
-- La décision reste dans le CODE (`gate.ts`), sous banc : la vue expose les deux faits, rien de plus.
--
-- ⛔ LE DÉTAIL DES ÉVÉNEMENTS. Le webhook ne gardait que `event` et `severity` : même allumé, le suivi
-- n'aurait dit que « ouvert / cliqué ». On garde désormais le lien cliqué, l'appareil, le client mail,
-- le système, le marqueur de robot quand Mailgun le donne, et la géolocalisation (pays, région, ville).
-- ⛔ JAMAIS l'adresse IP : la ville suffit à l'analyse et l'IP est une donnée personnelle de plus.
--
-- ⛔ `outbox_context` EST RECRÉÉE À L'IDENTIQUE (définition relevée en base le 07/10 par
-- pg_get_viewdef) + DEUX colonnes EN FIN : `tracking_mode`, `tracking_refused`. Le worker lit la vue
-- en `select *` : un worker d'avant ce lot ignore les deux clés, un worker d'après sur une base d'avant
-- ce lot ne les reçoit pas et retombe sur la règle du consentement (repli testé dans gate.test.ts).

set local role postgres;

-- 1. Le réglage par marque.
alter table newsletter.asset add column if not exists tracking_mode text not null default 'all';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'asset_tracking_mode_check') then
    alter table newsletter.asset
      add constraint asset_tracking_mode_check check (tracking_mode in ('all', 'consent'));
  end if;
end
$$;
comment on column newsletter.asset.tracking_mode is
  'Suivi ouverture/clic des envois marketing : all = tous sauf refus explicite (decision Alix 07/10/2026), '
  'consent = seulement tracking_consent = true. Lu par le worker (gate.ts) via outbox_context.';

-- 2. Le refus explicite, et son rattrapage depuis la preuve de consentement.
alter table newsletter.subscription add column if not exists tracking_refused_at timestamptz;
comment on column newsletter.subscription.tracking_refused_at is
  'Refus EXPLICITE du suivi (centre de preferences, set_tracking active=false). Respecte meme en mode all. '
  'Remis a null quand la personne reactive le suivi. Une case d''inscription decochee n''est PAS un refus.';

-- Dernier événement de SUIVI du centre de préférences par souscription : s'il est un retrait, refus.
update newsletter.subscription s
   set tracking_refused_at = d.occurred_at
  from (select distinct on (ce.subscription_id) ce.subscription_id, ce.event_type, ce.occurred_at
          from newsletter.consent_event ce
         where ce.method = 'preference_center'
           and ce.metadata ? 'tracking_consent'
         order by ce.subscription_id, ce.occurred_at desc, ce.id desc) d
 where d.subscription_id = s.id
   and d.event_type = 'withdrawn'
   and s.tracking_refused_at is null;

-- 3. Le détail de chaque événement Mailgun (rempli par le webhook à partir de 0092).
alter table newsletter.email_event
  add column if not exists url         text,
  add column if not exists device_type text,
  add column if not exists client_type text,
  add column if not exists client_name text,
  add column if not exists client_os   text,
  add column if not exists bot         text,
  add column if not exists country     text,
  add column if not exists region      text,
  add column if not exists city        text;
comment on column newsletter.email_event.url is 'Lien clique (evenement clicked). Jamais d''IP stockee.';
comment on column newsletter.email_event.bot is
  'Marqueur de robot donne par Mailgun (client-info.bot), ex. ouverture automatique d''Apple Mail ; null = inconnu.';

create index if not exists ix_email_event_asset_type_time
  on newsletter.email_event (asset_id, type, occurred_at);

-- Instantané d'avant, pour prouver que la vue recréée rend les MÊMES valeurs (contre-épreuve 4).
create temp table _nf0092_avant on commit drop as
  select * from newsletter.outbox_context
   where id in (select id from newsletter.email_outbox order by created_at desc limit 500);

-- 4. La vue de contexte du worker, à l'identique + 2 colonnes en fin.
create or replace view newsletter.outbox_context as
 SELECT o.id,
    o.kind,
    o.subject,
    o.action_url,
    o.payload,
    o.to_email,
    o.status,
    o.attempts,
    o.max_attempts,
    o.next_attempt_at,
    o.created_at,
    o.asset_id,
    o.subscription_id,
    a.name AS asset_name,
    a.slug AS asset_slug,
    COALESCE(e.sending_subdomain, a.sending_subdomain) AS sending_subdomain,
    e.compliance_regime,
        CASE
            WHEN o.kind = ANY (ARRAY['test'::text, 'campaign'::text, 'automation'::text, 'automation_tx'::text]) THEN COALESCE(lft_tv.config, e.legal_footer)
            ELSE COALESCE(lft_lc.config, e.legal_footer)
        END AS legal_footer,
    e.language,
    s.status AS sub_status,
    s.subscriber_id,
    s.tracking_consent,
    newsletter.is_suppressed(o.to_email::text, o.asset_id) AS suppressed,
    o.purpose,
    e.market,
    e.consent_mode,
    s.granted_purposes,
    o.campaign_id,
    o.template_version_id,
    tv.html_shell AS template_html_shell,
    tv.text_shell AS template_text_shell,
    c.html_shell AS campaign_html_shell,
    c.text_shell AS campaign_text_shell,
    o.occurrence_id,
    occ.html_shell AS occurrence_html_shell,
    occ.text_shell AS occurrence_text_shell,
    occ.status AS occurrence_status,
    occ.seq AS occurrence_seq,
    occ.local_date AS occurrence_local_date,
    c.name AS campaign_name,
    (c.scheduled_at AT TIME ZONE COALESCE(c.timezone, 'UTC'::text))::date AS campaign_local_date,
    occ.first_article_title AS occurrence_first_article,
    occ.article_count AS occurrence_article_count,
    occ.ai_intro AS occurrence_ai_intro,
    occ.ai_preheader AS occurrence_ai_preheader,
    c.ai_intro AS campaign_ai_intro,
    c.ai_preheader AS campaign_ai_preheader,
    ltv.html_shell AS lifecycle_html_shell,
    ltv.text_shell AS lifecycle_text_shell,
    ltv.subject AS lifecycle_subject,
    newsletter.is_hard_suppressed(o.to_email::text, o.asset_id) AS hard_suppressed,
    e.from_name,
    e.reply_to,
    a.tracking_mode,
    s.tracking_refused_at IS NOT NULL AS tracking_refused
   FROM newsletter.email_outbox o
     LEFT JOIN newsletter.asset a ON a.id = o.asset_id
     LEFT JOIN newsletter.subscription s ON s.id = o.subscription_id
     LEFT JOIN newsletter.template_version tv ON tv.id = o.template_version_id
     LEFT JOIN newsletter.campaign c ON c.id = o.campaign_id
     LEFT JOIN newsletter.campaign_occurrence occ ON occ.id = o.occurrence_id
     LEFT JOIN newsletter.lifecycle_template lt ON lt.asset_id = o.asset_id AND lt.kind = o.kind
     LEFT JOIN newsletter.template lft ON lft.id = lt.template_id AND lft.archived_at IS NULL
     LEFT JOIN newsletter.template_version ltv ON ltv.id = lft.current_version_id AND ltv.status = 'published'::text
     LEFT JOIN newsletter.legal_footer_template lft_tv ON lft_tv.id = tv.legal_footer_template_id AND lft_tv.asset_id = o.asset_id
     LEFT JOIN newsletter.legal_footer_template lft_lc ON lft_lc.id = ltv.legal_footer_template_id AND lft_lc.asset_id = o.asset_id
     LEFT JOIN LATERAL ( SELECT ed.id,
            ed.asset_id,
            ed.market,
            ed.language,
            ed.compliance_regime,
            ed.data_residency,
            ed.timezone,
            ed.branding,
            ed.legal_footer,
            ed.sending_subdomain,
            ed.wp_connection_id,
            ed.created_at,
            ed.consent_mode,
            ed.proof_retention_years,
            ed.slug,
            ed.is_primary,
            ed.from_name,
            ed.reply_to
           FROM newsletter.asset_edition ed
          WHERE ed.asset_id = o.asset_id
          ORDER BY (ed.id = s.edition_id) DESC NULLS LAST, ed.id
         LIMIT 1) e ON true;

reset role;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVES — DANS la migration (voir 0072).
-- ---------------------------------------------------------------------------
do $$
declare
  v_n        integer;
  v_attendus integer;
  v_cols     text[];
begin
  -- 1. Le réglage : présent, NOT NULL, borné, et 'all' sur TOUTES les marques (décision d'Alix).
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'newsletter' and table_name = 'asset'
                    and column_name = 'tracking_mode' and is_nullable = 'NO') then
    raise exception '[0092] asset.tracking_mode absente ou nullable';
  end if;
  select count(*) into v_n from newsletter.asset where tracking_mode is distinct from 'all';
  if v_n > 0 then
    raise exception '[0092] % marque(s) hors mode all', v_n;
  end if;
  begin
    update newsletter.asset set tracking_mode = 'tous' where id = (select id from newsletter.asset limit 1);
    raise exception '[0092] la contrainte laisse passer une valeur inconnue';
  exception when check_violation then
    null; -- attendu : la ligne n'a pas bougé (sous-bloc annulé)
  end;
  raise notice '[0092] contre-epreuve 1 OK : tracking_mode NOT NULL, borne, all partout';

  -- 2. Le refus : rattrapé exactement depuis la preuve de consentement.
  select count(*) into v_attendus
    from (select distinct on (ce.subscription_id) ce.subscription_id, ce.event_type
            from newsletter.consent_event ce
           where ce.method = 'preference_center' and ce.metadata ? 'tracking_consent'
           order by ce.subscription_id, ce.occurred_at desc, ce.id desc) d
   where d.event_type = 'withdrawn';
  select count(*) into v_n from newsletter.subscription where tracking_refused_at is not null;
  if v_n <> v_attendus then
    raise exception '[0092] % refus poses, % attendus', v_n, v_attendus;
  end if;
  raise notice '[0092] contre-epreuve 2 OK : % refus explicite(s) rattrape(s)', v_n;

  -- 3. Le détail des événements : les 9 colonnes, nullables, et l'index.
  select count(*) into v_n from information_schema.columns
   where table_schema = 'newsletter' and table_name = 'email_event' and is_nullable = 'YES'
     and column_name in ('url','device_type','client_type','client_name','client_os','bot','country','region','city');
  if v_n <> 9 then
    raise exception '[0092] % colonne(s) de detail sur 9', v_n;
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'newsletter' and indexname = 'ix_email_event_asset_type_time') then
    raise exception '[0092] index ix_email_event_asset_type_time absent';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'newsletter' and table_name = 'email_event' and column_name ~ '(^ip$|ip_address)') then
    raise exception '[0092] une colonne d''IP existe sur email_event';
  end if;
  raise notice '[0092] contre-epreuve 3 OK : 9 colonnes de detail, index, aucune IP';

  -- 4. La vue : les 2 colonnes EN FIN, et les MÊMES valeurs qu'avant sur les 500 derniers envois.
  select array_agg(column_name::text order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'newsletter' and table_name = 'outbox_context';
  if v_cols[array_length(v_cols, 1) - 1] <> 'tracking_mode' or v_cols[array_length(v_cols, 1)] <> 'tracking_refused' then
    raise exception '[0092] les 2 colonnes ne sont pas en fin de vue : %', v_cols[array_length(v_cols, 1) - 1 : array_length(v_cols, 1)];
  end if;
  select count(*) into v_n
    from _nf0092_avant av
    left join newsletter.outbox_context ap on ap.id = av.id
   where ap.id is null
      or (to_jsonb(av)) is distinct from (to_jsonb(ap) - 'tracking_mode' - 'tracking_refused');
  if v_n > 0 then
    raise exception '[0092] % ligne(s) de outbox_context different d''avant', v_n;
  end if;
  if not has_table_privilege('service_role', 'newsletter.outbox_context', 'SELECT') then
    raise exception '[0092] service_role a perdu la lecture de outbox_context';
  end if;
  raise notice '[0092] contre-epreuve 4 OK : vue identique sur % lignes, 2 colonnes en fin', (select count(*) from _nf0092_avant);
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0092', '0092_suivi_pour_tous_et_detail_evenements.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
