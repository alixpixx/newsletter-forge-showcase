-- ============================================================================
-- 0093 — Masquer une campagne des analytics (sans l'archiver ni la supprimer)
-- ============================================================================
--
-- ⭐ DEMANDE D'ALIX (07/10/2026) : « Add possibility to hide campaigns in analytics ». L'archivage ne
-- le fait pas : les archivées RESTENT dans les analytics (décision d'Alix du 24/09, 0085). Un test,
-- un envoi bloqué chez le fournisseur… faussent les moyennes sans rien dire du public.
--
-- `campaign.analytics_hidden_at` : null = visible. Masquer ne touche NI l'envoi, NI les événements,
-- NI les compteurs : la campagne sort seulement des LISTES d'analytics. Demandée par son id (fiche de
-- la campagne), elle reste rendue, avec `hidden = true`.
--
-- ⛔ UNE SURCHARGE, PAS UN REMPLACEMENT (même raison que 0085 pour `outbox_mark_sent`). L'admin EN
-- LIGNE appelle la signature à 6 arguments par leurs noms ; un DROP + CREATE ouvrirait une fenêtre où
-- le cache de l'API ne la connaît plus. On AJOUTE `(…, p_include_hidden boolean)` SANS AUCUN DÉFAUT —
-- un défaut rendrait ambigu tout appel à 6 noms — et la signature à 6 arguments devient un simple
-- appel de la nouvelle avec `false` : même corps, mêmes défauts, mêmes droits. Seul changement visible
-- pour l'ancien admin : une campagne masquée sort de ses listes, et chaque campagne porte `hidden`.

set local role postgres;

alter table newsletter.campaign add column if not exists analytics_hidden_at timestamptz;

comment on column newsletter.campaign.analytics_hidden_at is
  'Masquee des listes d''analytics depuis cette date (null = visible). Ne change ni l''envoi, ni les '
  'evenements, ni les compteurs. Qui l''a masquee : journal d''audit.';

-- Photo de la sortie actuelle, pour prouver plus bas que rien d'autre ne bouge.
create temp table _nf0093_avant on commit drop as
  select a.asset_id, newsletter.campaign_send_stats(a.asset_id, null, null, null, 1000, 0) as r
  from (select distinct asset_id from newsletter.campaign) a;

create or replace function newsletter.campaign_send_stats(
  p_asset_id        uuid,
  p_campaign_id     uuid,
  p_since           timestamptz,
  p_search          text,
  p_limit           integer,
  p_offset          integer,
  p_include_hidden  boolean
) returns jsonb
language sql
stable
security definer
set search_path = newsletter, pg_temp
as $$
with camp as (
  select c.id, c.name, c.status, c.archived_at, c.analytics_hidden_at, c.sent_at, c.recipients_sent,
         (c.recurrence_days is not null
          or exists (select 1 from newsletter.campaign_occurrence o where o.campaign_id = c.id)) as recurring,
         greatest(c.sent_at,
                  (select max(o.sent_at) from newsletter.campaign_occurrence o
                    where o.campaign_id = c.id and o.sent_at is not null)) as last_sent_at
  from newsletter.campaign c
  where c.asset_id = p_asset_id
    and (p_campaign_id is null or c.id = p_campaign_id)
    -- Masquée = hors des LISTES ; demandée par son id, elle reste rendue (0093).
    and (coalesce(p_include_hidden, false) or p_campaign_id is not null or c.analytics_hidden_at is null)
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
             'hidden', p.analytics_hidden_at is not null,
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

revoke execute on function newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer, boolean) from public;
revoke execute on function newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer, boolean) from anon, authenticated;
grant  execute on function newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer, boolean) to service_role;

comment on function newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer, boolean) is
  'Comme la signature a 6 arguments (voir son commentaire), et p_include_hidden = true rend aussi les '
  'campagnes masquees des analytics (0093). Chaque campagne porte hidden.';

-- La signature à 6 arguments : MÊMES noms, MÊMES défauts (CREATE OR REPLACE les refuserait changés),
-- mêmes droits ; elle délègue avec `false`.
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
  select newsletter.campaign_send_stats(p_asset_id, p_campaign_id, p_since, p_search, p_limit, p_offset, false);
$$;

comment on function newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer) is
  'Campagnes d''UNE marque qui ont envoye (archivees comprises, MASQUEES EXCLUES sauf demandees par leur id, '
  '0093), les plus recentes d''abord, avec une ligne par envoi (edition, ou envoi unique d''une one-shot) : '
  'sent (compteur de reconciliation, sinon decompte vivant), delivered/bounced/complained/opened/clicked '
  'distincts par ligne d''outbox, tracked = delivres dont le suivi etait ACTIF, tracking_unknown = delivres '
  'partis avant 0085. Les taux se calculent sur tracked.';

reset role;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVES — DANS la migration (voir 0072).
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig6   constant text := 'newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer)';
  v_sig7   constant text := 'newsletter.campaign_send_stats(uuid, uuid, timestamptz, text, integer, integer, boolean)';
  v_ecarts integer := 0;
  v_cible  record;
  v_avant  jsonb;
  v_apres  jsonb;
  v_un     jsonb;
begin
  -- 1. La colonne : nullable, et AUCUNE campagne masquée par la migration elle-même.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'newsletter' and table_name = 'campaign'
                    and column_name = 'analytics_hidden_at' and is_nullable = 'YES'
                    and data_type = 'timestamp with time zone') then
    raise exception '[0093] campaign.analytics_hidden_at absente, mal typee ou NOT NULL';
  end if;
  if exists (select 1 from newsletter.campaign where analytics_hidden_at is not null) then
    raise exception '[0093] des campagnes sont deja masquees : la migration ne doit rien masquer';
  end if;
  raise notice '[0093] contre-epreuve 1 OK : colonne nullable, 0 campagne masquee';

  -- 2. Les deux signatures : 6 arguments avec SES 5 défauts, 7 arguments SANS défaut (sinon un
  --    appel à 6 noms devient ambigu), toutes deux definer, fermées hors service_role.
  if (select pronargdefaults from pg_proc where oid = v_sig6::regprocedure) <> 5
     or (select pronargdefaults from pg_proc where oid = v_sig7::regprocedure) <> 0
     or not (select prosecdef from pg_proc where oid = v_sig6::regprocedure)
     or not (select prosecdef from pg_proc where oid = v_sig7::regprocedure) then
    raise exception '[0093] defauts ou security definer faux sur campaign_send_stats';
  end if;
  if has_function_privilege('anon', v_sig6, 'EXECUTE') or has_function_privilege('authenticated', v_sig6, 'EXECUTE')
     or has_function_privilege('anon', v_sig7, 'EXECUTE') or has_function_privilege('authenticated', v_sig7, 'EXECUTE')
     or not has_function_privilege('service_role', v_sig6, 'EXECUTE')
     or not has_function_privilege('service_role', v_sig7, 'EXECUTE') then
    raise exception '[0093] droits d''execution de campaign_send_stats faux';
  end if;
  raise notice '[0093] contre-epreuve 2 OK : 6 arguments (5 defauts) + 7 arguments (0 defaut), fermees hors service_role';

  -- 3. Rien d'autre ne bouge : sur les VRAIES données de chaque marque, la sortie d'après, privée de
  --    la seule clé `hidden`, est ÉGALE à la photo d'avant — par les deux signatures.
  for v_cible in select asset_id, r from _nf0093_avant loop
    foreach v_apres in array array[
      newsletter.campaign_send_stats(v_cible.asset_id, null, null, null, 1000, 0),
      newsletter.campaign_send_stats(v_cible.asset_id, null, null, null, 1000, 0, false),
      newsletter.campaign_send_stats(v_cible.asset_id, null, null, null, 1000, 0, true)]
    loop
      if v_apres -> 'total' is distinct from v_cible.r -> 'total'
         or coalesce((select jsonb_agg(c.v - 'hidden' order by c.n)
                        from jsonb_array_elements(v_apres -> 'campaigns') with ordinality c(v, n)), '[]'::jsonb)
            is distinct from v_cible.r -> 'campaigns' then
        v_ecarts := v_ecarts + 1;
      end if;
    end loop;
  end loop;
  if v_ecarts > 0 then
    raise exception '[0093] % sortie(s) differente(s) de la photo d''avant', v_ecarts;
  end if;
  raise notice '[0093] contre-epreuve 3 OK : sorties identiques a la photo d''avant (% marque(s), 3 appels chacune)',
    (select count(*) from _nf0093_avant);

  -- 4. Le masquage lui-même, sur une VRAIE campagne envoyée, dans un bloc ANNULÉ : rien ne persiste.
  select c.id, c.asset_id into v_cible
    from newsletter.campaign c
   where c.analytics_hidden_at is null
     and (c.sent_at is not null
          or exists (select 1 from newsletter.campaign_occurrence o where o.campaign_id = c.id and o.sent_at is not null))
   order by c.created_at desc
   limit 1;
  if v_cible.id is null then
    raise notice '[0093] contre-epreuve 4 SAUTEE : aucune campagne envoyee en base';
  else
    begin
      v_avant := newsletter.campaign_send_stats(v_cible.asset_id, null, null, null, 1000, 0);
      update newsletter.campaign set analytics_hidden_at = now() where id = v_cible.id;
      v_apres := newsletter.campaign_send_stats(v_cible.asset_id, null, null, null, 1000, 0);
      if (v_apres ->> 'total')::integer <> (v_avant ->> 'total')::integer - 1
         or exists (select 1 from jsonb_array_elements(v_apres -> 'campaigns') c where (c ->> 'id')::uuid = v_cible.id) then
        raise exception '[0093] une campagne masquee reste dans la liste par defaut';
      end if;
      v_apres := newsletter.campaign_send_stats(v_cible.asset_id, null, null, null, 1000, 0, true);
      if (v_apres ->> 'total')::integer <> (v_avant ->> 'total')::integer
         or not exists (select 1 from jsonb_array_elements(v_apres -> 'campaigns') c
                         where (c ->> 'id')::uuid = v_cible.id and (c ->> 'hidden')::boolean) then
        raise exception '[0093] p_include_hidden ne rend pas la campagne masquee, ou sans hidden = true';
      end if;
      v_un := newsletter.campaign_send_stats(v_cible.asset_id, v_cible.id);
      if (v_un ->> 'total')::integer <> 1 or not (v_un -> 'campaigns' -> 0 ->> 'hidden')::boolean then
        raise exception '[0093] une campagne masquee demandee par son id n''est plus rendue';
      end if;
      raise exception 'nf0093_retour';
    exception when raise_exception then
      if sqlerrm <> 'nf0093_retour' then
        raise;
      end if;
    end;
    if exists (select 1 from newsletter.campaign where analytics_hidden_at is not null) then
      raise exception '[0093] le masquage d''essai a persiste';
    end if;
    raise notice '[0093] contre-epreuve 4 OK : masquee = hors liste, rendue avec p_include_hidden et par son id ; essai annule';
  end if;
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0093', '0093_campagne_masquee_des_analytics.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
