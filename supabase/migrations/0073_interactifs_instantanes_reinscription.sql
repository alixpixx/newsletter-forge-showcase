-- ============================================================================
-- 0073 — Les e-mails INTERACTIFS partent tout de suite, et une personne qui se RÉINSCRIT revient.
-- ============================================================================
--
-- Deux demandes d'Alix du 22/09/2026, livrées ensemble parce qu'elles touchent la même file :
--
--   « tout les mails de type welcome etc soit instant les 5min d'attente ca doit etre que pour les
--     newsletter » (« genre confirmation welcome etc »)
--   « si la personne se reinscrit on l'a reme dans le systeme »
--
-- Quatre objets, tous ADDITIFS : rien d'existant n'est supprimé ni modifié dans son comportement.
-- Le code déployé AVANT cette migration continue de tourner à l'identique ; celui d'après s'en sert.
--
--  1. `claim_outbox_interactive` — la réclamation réservée aux kinds interactifs.
--  2. `is_hard_suppressed`       — la suppression qu'une réinscription NE lève PAS.
--  3. `lift_voluntary_suppression` — la levée, au clic de confirmation, et sa trace.
--  4. `outbox_context.hard_suppressed` — la même distinction, lue par le worker au send-time.

-- ===========================================================================
-- 1 — `claim_outbox_interactive`
-- ===========================================================================
--
-- ⛔ LE DÉFAUT MESURÉ. Le plafond de débit du worker (50 réclamations par fenêtre de 5 min, décision
-- d'Alix du 15/09) est vérifié AVANT toute réclamation et compte TOUS les kinds. Pendant une grosse
-- newsletter, la fenêtre est pleine : une confirmation d'inscription attend jusqu'à cinq minutes,
-- alors que `claim_outbox` la classe pourtant en tête (0057:78) — le tri ne joue jamais, puisqu'on
-- ne réclame rien. Hors newsletter, mesuré le 22/09 : confirmation 2,1 s et 3,9 s, bienvenue 2,3 s.
--
-- ⭐ CE QUE FAIT CETTE FONCTION : exactement `claim_outbox` (corps de 0057, relu en prod le 22/09 par
-- `pg_get_functiondef`, identique), avec UN filtre de plus sur les candidats — les kinds interactifs
-- et rien d'autre. Le worker l'appelle dans une passe à part, avec SON propre plafond, jamais compté
-- dans celui des newsletters.
--
-- ⚠️ LA LISTE EST LA MÊME QUE CELLE DU TRI DE 0057, ET DANS LE MÊME SENS : on nomme les interactifs,
-- tout le reste est de la masse. Un kind ajouté demain sans toucher à cette fonction ne passe PAS par
-- ici — il reste sous le plafond des newsletters.
--
-- ⚠️ `claim_outbox` N'EST PAS MODIFIÉE. Ajouter un 4e paramètre par défaut créerait une seconde
-- signature, et PostgREST refuserait l'appel à 3 arguments (deux candidates). Et le chemin
-- `RUN_ONCE` (repli de la collègue) doit continuer à tout drainer, interactifs compris.
create or replace function newsletter.claim_outbox_interactive(
  p_worker text,
  p_batch integer default 10,
  p_stale_seconds integer default 300
)
returns setof newsletter.email_outbox
language plpgsql
security definer
set search_path to 'newsletter', 'extensions'
as $function$
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
        and c.kind in ('confirmation', 'welcome', 'unsubscribe_ack', 'test')
        and ( c.status = 'pending'
           or (c.status = 'sending'
               and c.locked_at < now() - make_interval(secs => p_stale_seconds)) )
      order by c.next_attempt_at, c.created_at
      for update skip locked
      limit p_batch )
  returning o.*;
end;
$function$;

comment on function newsletter.claim_outbox_interactive(text, integer, integer) is
  'Comme claim_outbox, mais ne reserve QUE les kinds interactifs (confirmation, welcome, unsubscribe_ack, test). Le worker resident l''appelle dans une passe a part, avec son propre plafond : un geste humain qui attend sa reponse ne patiente plus derriere le plafond des newsletters (demande d''Alix du 22/09/2026).';

-- ===========================================================================
-- 2 — `is_hard_suppressed` : ce qu'une réinscription ne lève jamais.
-- ===========================================================================
--
-- ⛔ `is_suppressed` NE REGARDE PAS LE MOTIF. Un effacement RGPD ou une désinscription de toutes les
-- marques bloquait donc une NOUVELLE inscription à vie, exactement comme un rebond dur. Mesuré le
-- 22/09 : une collègue effacée le 19/09 (test) se réinscrit sur Northwind Sports → aucun abonné créé, aucun
-- e-mail, aucune trace — et optinforge affiche le lead comme reçu.
--
-- ⭐ DEUX MOTIFS SONT VOLONTAIRES, ET SEULEMENT DEUX : `erasure` et `global_optout`. La personne a
-- elle-même demandé qu'on arrête ; elle peut elle-même demander qu'on reprenne. Tout le reste est
-- DUR : un rebond dur dit que la boîte n'existe pas, une plainte dit « c'est du spam ».
--
-- ⚠️ LE SENS DU DÉFAUT EST DÉLIBÉRÉ (même doctrine que 0057) : on nomme les motifs LEVABLES, tout le
-- reste bloque — motif inconnu, motif futur et motif NUL compris (`suppression.reason` n'a aucune
-- contrainte). L'inverse ferait d'une faute de frappe dans un motif une porte ouverte.
--
-- ⚠️ `is_suppressed` N'EST PAS MODIFIÉE : les vues d'envoi et le gate s'en servent, et une personne
-- effacée ne doit rien recevoir tant qu'elle n'a pas CONFIRMÉ.
create or replace function newsletter.is_hard_suppressed(p_email text, p_asset_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path to 'newsletter', 'extensions'
as $function$
  select exists(
    select 1 from newsletter.suppression
     where email_hash = digest(lower(p_email), 'sha256')
       and (scope = 'global' or asset_id = p_asset_id)
       and coalesce(reason, '') not in ('erasure', 'global_optout')
  );
$function$;

comment on function newsletter.is_hard_suppressed(text, uuid) is
  'Suppression qu''une reinscription volontaire ne leve PAS : tout motif sauf erasure et global_optout (rebond dur, plainte, motif inconnu ou nul). Sert a l''inscription et a la confirmation ; les envois editoriaux restent gardes par is_suppressed.';

-- ===========================================================================
-- 3 — `lift_voluntary_suppression` : la levée, au clic, et sa trace.
-- ===========================================================================
--
-- ⛔ AU CLIC DE CONFIRMATION, JAMAIS À L'INSCRIPTION. N'importe qui peut taper l'adresse d'un autre
-- dans un formulaire : lever à l'inscription effacerait la demande d'arrêt d'une personne sans
-- qu'elle ait rien fait. Le clic sur le lien reçu dans SA boîte est la seule preuve que c'est elle.
--
-- ⭐ ELLE NE LÈVE QUE LES DEUX MOTIFS VOLONTAIRES, les mêmes que ci-dessus. Un rebond dur ou une
-- plainte sur la même adresse restent en place.
--
-- ⚠️ LA TRACE NE CONTIENT PAS L'ADRESSE. `audit_log` garde la souscription, la marque, les motifs
-- levés et leur nombre — de quoi répondre « pourquoi lui écrit-on de nouveau ? » sans réécrire en
-- clair ce qu'un effacement avait réduit à une empreinte. Aucune trace si rien n'a été levé.
create or replace function newsletter.lift_voluntary_suppression(
  p_email text,
  p_asset_id uuid,
  p_subscription_id uuid
)
returns integer
language plpgsql
security definer
set search_path to 'newsletter', 'extensions'
as $function$
declare
  motifs text[];
  n integer;
begin
  with levees as (
    delete from newsletter.suppression
     where email_hash = digest(lower(p_email), 'sha256')
       and reason in ('erasure', 'global_optout')
    returning reason
  )
  select array_agg(distinct reason order by reason), count(*)::integer
    into motifs, n
    from levees;

  if n > 0 then
    insert into newsletter.audit_log (actor, action, target_type, target_id, asset_id, meta)
    values ('public-confirm', 'suppression-lifted', 'subscription', p_subscription_id::text, p_asset_id,
            jsonb_build_object('reasons', to_jsonb(motifs), 'rows', n));
  end if;

  return n;
end;
$function$;

comment on function newsletter.lift_voluntary_suppression(text, uuid, uuid) is
  'Leve les suppressions VOLONTAIRES (erasure, global_optout) d''une adresse qui vient de CONFIRMER une nouvelle inscription (double opt-in). Rebond dur et plainte restent. Trace dans audit_log (suppression-lifted) sans l''adresse. Rend le nombre de lignes levees.';

-- ⛔ LE DÉFAUT POSTGRES EST « TOUT LE MONDE PEUT EXÉCUTER » (voir 0071). Le revoke précède le grant.
revoke all on function newsletter.claim_outbox_interactive(text, integer, integer) from public, anon, authenticated;
revoke all on function newsletter.is_hard_suppressed(text, uuid) from public, anon, authenticated;
revoke all on function newsletter.lift_voluntary_suppression(text, uuid, uuid) from public, anon, authenticated;
grant execute on function newsletter.claim_outbox_interactive(text, integer, integer) to service_role;
grant execute on function newsletter.is_hard_suppressed(text, uuid) to service_role;
grant execute on function newsletter.lift_voluntary_suppression(text, uuid, uuid) to service_role;

-- ===========================================================================
-- 4 — `outbox_context.hard_suppressed`
-- ===========================================================================
--
-- Le worker doit laisser partir la CONFIRMATION d'une personne effacée qui se réinscrit — sinon elle
-- ne peut jamais confirmer, et la levée du point 3 n'arrive jamais. Il lit donc, pour ce kind-là
-- seulement, la suppression DURE. Le bienvenue et les campagnes restent sur `suppressed`.
--
-- ⛔ LE CORPS EST CELUI DE LA PROD, PAS CELUI D'UN FICHIER : relu le 22/09/2026 par
-- `pg_get_viewdef('newsletter.outbox_context')`, recopié tel quel. `create or replace view` exige
-- les mêmes colonnes dans le même ordre ; la nouvelle vient en DERNIER, après `lifecycle_subject`.
-- Une divergence avec la vue en place fait ÉCHOUER la migration — elle ne peut pas la déformer.
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
            WHEN o.kind = ANY (ARRAY['test'::text, 'campaign'::text]) THEN COALESCE(lft_tv.config, e.legal_footer)
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
    newsletter.is_hard_suppressed(o.to_email::text, o.asset_id) AS hard_suppressed
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
            ed.is_primary
           FROM newsletter.asset_edition ed
          WHERE ed.asset_id = o.asset_id
          ORDER BY (ed.id = s.edition_id) DESC NULLS LAST, ed.id
         LIMIT 1) e ON true;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE — DANS la migration. Relire le catalogue et ÉCHOUER si un objet manque, si la vue
-- n'a pas sa colonne, ou si PUBLIC peut exécuter une des trois fonctions.
-- ---------------------------------------------------------------------------
do $$
declare
  manquants text;
  ouvertes text;
begin
  select string_agg(attendu, ', ')
    into manquants
    from (values ('claim_outbox_interactive'), ('is_hard_suppressed'), ('lift_voluntary_suppression')) as v(attendu)
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'newsletter' and p.proname = v.attendu
   );
  if manquants is not null then
    raise exception '[0073] fonctions absentes apres execution : %', manquants;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'newsletter' and table_name = 'outbox_context' and column_name = 'hard_suppressed'
  ) then
    raise exception '[0073] outbox_context n''a pas la colonne hard_suppressed';
  end if;

  select string_agg(p.proname, ', ')
    into ouvertes
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where n.nspname = 'newsletter'
     and p.proname in ('claim_outbox_interactive', 'is_hard_suppressed', 'lift_voluntary_suppression')
     and a.grantee = 0
     and a.privilege_type = 'EXECUTE';
  if ouvertes is not null then
    raise exception '[0073] EXECUTE encore accorde a PUBLIC sur : %', ouvertes;
  end if;

  raise notice '[0073] contre-epreuve OK : 3 fonctions, colonne hard_suppressed, aucune ouverte a PUBLIC';
end
$$;

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0073', '0073_interactifs_instantanes_reinscription.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;

notify pgrst, 'reload schema';
