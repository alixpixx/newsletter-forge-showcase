-- ---------------------------------------------------------------------------
-- 0061 — L'ENGAGEMENT DE PREMIÈRE PARTIE, QU'UN RECALCUL NE PEUT PLUS EFFACER
-- ---------------------------------------------------------------------------
--
-- ⛔ LE DÉFAUT QUE CETTE MIGRATION RÉPARE, ET IL EST SILENCIEUX. `recompute_engagement` (0056)
-- écrit `last_engagement_at = greatest(last_open, last_click)` — deux grandeurs tirées des seuls
-- événements `opened` et `clicked`. Or ces événements N'EXISTERONT PAS : `mailgun.ts` ne pose
-- `o:tracking-opens` / `o:tracking-clicks` que si `tracking_consent` est vrai, refusé par 1 202
-- abonnements sur 1 203 (mesuré le 09/09/2026). L'expression vaut donc NULL pour tout le monde.
--
-- Conséquence exacte, une fois l'étape 14 en place : la personne ouvre sa page de préférences
-- depuis une relance, `apps/public` inscrit sa réaction dans `last_engagement_at` — et la passe
-- suivante du worker (`engagement.ts:85` appelle cette fonction) la REMET À NULL. La personne
-- redevient dormante, donc éligible à une nouvelle relance, alors qu'elle vient précisément de
-- répondre. Un cron défait le seul signal que le produit sait encore capter, sans une erreur, sans
-- une ligne de journal rouge.
--
-- ⛔ POURQUOI UNE COLONNE À PART ET NON UN `greatest()` AVEC L'ANCIENNE VALEUR. Écrire
-- `last_eng = greatest(last_open, last_click, last_engagement_at)` suffirait à empêcher le
-- recul — et détruirait la fonction : une date fausse posée par erreur ne pourrait PLUS JAMAIS
-- être corrigée à la baisse, puisque chaque passe la relirait comme un plancher. `recompute`
-- cesserait de recalculer. Chaque signal garde donc sa colonne — `last_open_at`, `last_click_at`,
-- `last_response_at` — et `last_engagement_at` reste ce qu'il est : leur agrégat, recalculable de
-- zéro à tout moment.
alter table newsletter.subscription
  add column if not exists last_response_at timestamptz;

comment on column newsletter.subscription.last_response_at is
  'Dernière réaction de PREMIÈRE PARTIE : ouverture de la page de préférences depuis un e-mail, ou geste explicite sur cet écran. Écrit par apps/public. Ne dépend d''aucun pixel — c''est le seul signal d''engagement qui existe tant que tracking_consent est refusé, et la raison pour laquelle recompute_engagement ne peut plus rendre NULL une personne qui vient de répondre.';

create index if not exists idx_sub_asset_response
  on newsletter.subscription (asset_id, last_response_at);

-- ---------------------------------------------------------------------------
-- `recompute_engagement`, à l'identique de 0056 SAUF le troisième signal.
-- ---------------------------------------------------------------------------
create or replace function newsletter.recompute_engagement(
  p_asset_id uuid default null,
  p_now timestamptz default now(),
  p_dry_run boolean default false
)
returns table (
  scanned integer,
  changed integer,
  lvl_active integer,
  lvl_dormant integer,
  lvl_churned integer,
  without_events integer
)
language plpgsql
as $$
declare
  -- ⛔ LES SEUILS SONT ÉCRITS ICI, EN UN SEUL ENDROIT, et nommés. Un seuil recopié dans une requête
  -- d'écran finit par diverger de celui du job, et les deux affichent alors des vérités différentes.
  c_min_editions   constant integer := 3;   -- en dessous, personne n'est « inactif » : il n'a pas eu l'occasion
  c_dormant_days   constant integer := 30;
  c_churned_days   constant integer := 90;
  c_half_life_days constant numeric := 30;  -- un signal vieux d'un mois pèse la moitié
  c_open_pts       constant numeric := 10;
  c_click_pts      constant numeric := 30;  -- un clic vaut trois ouvertures (doc produit)
begin
  /*
   * Table temporaire plutôt qu'un CTE : le résultat sert DEUX fois — une fois pour les compteurs
   * rendus à l'appelant, une fois pour l'UPDATE. Dupliquer le calcul dans les deux branches
   * `p_dry_run` ferait exactement ce qu'un mode simulation doit interdire : mesurer autre chose que
   * ce qui sera écrit.
   */
  drop table if exists _eng;

  create temporary table _eng on commit drop as
  with cible as (
    select s.id, s.engagement_level, s.engagement_score, s.open_count, s.click_count,
           s.last_open_at, s.last_click_at, s.last_engagement_at,
           -- Le signal de première partie entre dans le calcul, il n'en sort jamais réécrit.
           s.last_response_at
      from newsletter.subscription s
      join newsletter.subscriber sub on sub.id = s.subscriber_id
     where not sub.is_demo
       and (p_asset_id is null or s.asset_id = p_asset_id)
  ),
  distincts as (
    /*
     * ⛔ UNE OUVERTURE PAR E-MAIL, PAS PAR PIXEL. `uq_email_event_provider` (0041) déduplique par
     * événement FOURNISSEUR : Mailgun émet un `opened` à chaque rechargement d'image, et Apple Mail
     * Privacy en fabrique un immédiatement, sans lecture humaine. Un `count(*)` produirait des
     * scores gonflés, sans plafond et incomparables d'un abonné à l'autre.
     *
     * ⚠️ `coalesce(outbox_id, id)` : `outbox_id` est `on delete set null`. Regrouper les orphelins
     * sur un NULL commun les compterait POUR UN SEUL. Chacun redevient donc sa propre unité — c'est
     * le comportement dégradé correct : on ne sait plus dédupliquer, on ne fusionne pas à tort.
     */
    select e.subscription_id,
           e.type,
           coalesce(e.outbox_id::text, e.id::text) as unite,
           max(e.occurred_at) as occurred_at
      from newsletter.email_event e
      join cible c on c.id = e.subscription_id
     where e.type in ('opened', 'clicked', 'delivered')
     group by 1, 2, 3
  ),
  agg as (
    select d.subscription_id,
           count(*) filter (where d.type = 'opened')                as opens,
           count(*) filter (where d.type = 'clicked')               as clicks,
           count(*) filter (where d.type = 'delivered')             as delivered,
           max(d.occurred_at) filter (where d.type = 'opened')      as last_open,
           max(d.occurred_at) filter (where d.type = 'clicked')     as last_click,
           max(d.occurred_at) filter (where d.type = 'delivered')   as last_delivered,
           coalesce(sum(
             case d.type when 'opened' then c_open_pts when 'clicked' then c_click_pts else 0 end
             * power(0.5, extract(epoch from (p_now - d.occurred_at)) / 86400.0 / c_half_life_days)
           ), 0) as poids
      from distincts d
     group by 1
  )
  select
    c.id,
    c.engagement_level                                  as ancien_level,
    c.engagement_score                                  as ancien_score,
    c.open_count                                        as ancien_open,
    c.click_count                                       as ancien_click,
    c.last_open_at                                      as ancien_last_open,
    c.last_click_at                                     as ancien_last_click,
    c.last_engagement_at                                as ancien_last_eng,
    coalesce(a.opens, 0)::integer                       as opens,
    coalesce(a.clicks, 0)::integer                      as clicks,
    coalesce(a.delivered, 0)::integer                   as delivered,
    a.last_open,
    a.last_click,
    -- ⛔ LE TROISIÈME SIGNAL, ET AUJOURD'HUI LE SEUL QUI ARRIVERA. `greatest()` ignore les NULL en
    -- PostgreSQL : tant qu'il n'y a ni ouverture ni clic, `last_engagement_at` vaut exactement la
    -- dernière réaction de première partie — et non plus NULL.
    greatest(a.last_open, a.last_click, c.last_response_at) as last_eng,
    -- ⛔ Le score est PLAFONNÉ À 100 : l'écran le rend sous forme de barre, une valeur au-delà
    -- déborderait sans erreur. 10 points par ouverture récente, 30 par clic récent, décroissance de
    -- moitié tous les 30 jours. L'échelle est conventionnelle ; ce qui compte est le CLASSEMENT.
    --
    -- ⚠️ LA RÉPONSE NE DONNE PAS DE POINTS, ELLE DONNE UNE DATE. Lui attribuer un poids
    -- inventerait une équivalence — « répondre vaut deux clics » — que rien ne mesure. Elle agit
    -- donc là où elle est incontestable : la dernière réaction, donc le NIVEAU.
    least(100, round(coalesce(a.poids, 0)))::integer    as score,
    case
      -- ⛔ LA GARDE D'ANCIENNETÉ D'ABORD. Un inscrit d'il y a dix jours qui a reçu deux e-mails
      -- n'est pas « inactif », et le classer ainsi le rendrait éligible à un e-mail de
      -- réengagement — voire à une purge. Tant qu'il n'a pas reçu assez d'éditions pour avoir eu
      -- l'occasion de réagir, il reste actif.
      when coalesce(a.delivered, 0) < c_min_editions then 'active'
      -- Aucun repère temporel du tout : rien reçu, rien ouvert. Actif par défaut, comme la colonne.
      when coalesce(greatest(a.last_open, a.last_click, c.last_response_at), a.last_delivered) is null then 'active'
      -- ⚠️ La référence est la dernière RÉACTION, et à défaut la dernière RÉCEPTION : « il reçoit
      -- depuis X jours sans jamais réagir » est exactement ce qu'on veut mesurer chez quelqu'un qui
      -- n'a jamais ouvert. Une réponse compte comme réaction — c'est même la seule qu'on verra.
      when p_now - coalesce(greatest(a.last_open, a.last_click, c.last_response_at), a.last_delivered)
           < make_interval(days => c_dormant_days) then 'active'
      when p_now - coalesce(greatest(a.last_open, a.last_click, c.last_response_at), a.last_delivered)
           < make_interval(days => c_churned_days) then 'dormant'
      else 'churned'
    end as level
  from cible c
  left join agg a on a.subscription_id = c.id;

  if not p_dry_run then
    /*
     * ⛔ ON N'ÉCRIT QUE CE QUI CHANGE. Réécrire 1 200 lignes identiques à chaque passe ferait
     * mentir `updated_at`, réveillerait tous les déclencheurs, et rendrait impossible de répondre à
     * « qu'est-ce qui a bougé cette nuit ? » — la seule question qu'on se pose devant ce job.
     */
    update newsletter.subscription s
       set open_count         = e.opens,
           click_count        = e.clicks,
           last_open_at       = e.last_open,
           last_click_at      = e.last_click,
           last_engagement_at = e.last_eng,
           engagement_score   = e.score,
           engagement_level   = e.level
      from _eng e
     where s.id = e.id
       and (s.open_count is distinct from e.opens
         or s.click_count is distinct from e.clicks
         or s.last_open_at is distinct from e.last_open
         or s.last_click_at is distinct from e.last_click
         or s.last_engagement_at is distinct from e.last_eng
         or s.engagement_score is distinct from e.score
         or s.engagement_level is distinct from e.level);
  end if;

  return query
  select
    count(*)::integer,
    -- ⛔ « changed » compte ce qui DIFFÈRE, en simulation comme en réel : c'est la même expression
    -- que le `where` de l'UPDATE ci-dessus. Un mode simulation qui compterait autre chose que ce
    -- que le mode réel écrit ne simulerait rien.
    count(*) filter (
      where e.ancien_open is distinct from e.opens
         or e.ancien_click is distinct from e.clicks
         or e.ancien_last_open is distinct from e.last_open
         or e.ancien_last_click is distinct from e.last_click
         or e.ancien_last_eng is distinct from e.last_eng
         or e.ancien_score is distinct from e.score
         or e.ancien_level is distinct from e.level
    )::integer,
    count(*) filter (where e.level = 'active')::integer,
    count(*) filter (where e.level = 'dormant')::integer,
    count(*) filter (where e.level = 'churned')::integer,
    count(*) filter (where e.delivered = 0)::integer
  from _eng e;
end;
$$;

comment on function newsletter.recompute_engagement(uuid, timestamptz, boolean) is
  'Recalcule les colonnes d''engagement de subscription depuis email_event ET last_response_at (signal de première partie, jamais réécrit ici). Exclut les abonnés de démonstration. p_dry_run = mesure sans écrire, avec les MÊMES compteurs. Seuils : actif < 30 j, dormant 30-90 j, churned > 90 j, et jamais avant 3 éditions reçues.';

revoke all on function newsletter.recompute_engagement(uuid, timestamptz, boolean) from public;
grant execute on function newsletter.recompute_engagement(uuid, timestamptz, boolean) to service_role;

notify pgrst, 'reload schema';
