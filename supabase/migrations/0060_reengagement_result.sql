-- 0060 — MESURER CE QU'UNE VAGUE DE RÉENGAGEMENT A PRODUIT (5C.6)
--
-- Le lot 5C n'est pas fini quand les e-mails partent : il est fini quand on sait ce qu'ils ont
-- provoqué. Cette migration ajoute la seule chose qui manquait — le RÉSULTAT de chaque relance.
--
-- ============================================================================================
-- LE FAIT QUI COMMANDE TOUTE CETTE MIGRATION : IL N'Y AURA AUCUN `opened` NI `clicked`
-- ============================================================================================
--
-- `apps/worker/src/mailgun.ts` ne pose `o:tracking-opens` / `o:tracking-clicks` que si `msg.track`,
-- qui vient du gate et exige `tracking_consent = true`. Mesuré le 09/09/2026 :
-- **1 202 abonnements à `false`, 1 seul à `true`**. Pour ~100 % des envois, Mailgun ne pose donc ni
-- pixel ni réécriture de lien, et n'émettra JAMAIS d'ouverture ni de clic.
--
-- ⛔ Une vue « taux de réouverture » écrite sur `type='opened'` rendrait **0 pour toujours, avec un
-- journal parfaitement vert**. On en conclurait que la relance ne marche pas, alors qu'on ne
-- l'aurait jamais mesurée. C'est la panne exacte que ce lot doit éviter, pas produire.
--
-- La mesure porte donc sur les signaux QUI EXISTENT, et elle NOMME lequel :
--   · `delivered_at`   — Mailgun l'émet sans aucun consentement de suivi. C'est le dénominateur
--                        honnête : ni « enfilé » (une relance peut rester `pending` pour toujours),
--                        ni « envoyé » (remettre à Mailgun ne dit rien de la remise finale).
--   · `responded_at`   — signal de PREMIÈRE PARTIE : la personne a ouvert sa page de préférences
--                        depuis la relance. C'est le geste que le CTA demande, il est délibéré, et
--                        il ne dépend d'aucun pixel. Écrit par `apps/public`.
--   · le COÛT          — désabonnements, plaintes, rebonds. Ils arrivent TOUJOURS, eux, et c'est le
--                        chiffre le plus important d'un réengagement : écrire à des gens qui ne
--                        lisent plus peut coûter plus que ne rien faire.
--
-- Rendre les ouvertures mesurables demanderait de changer le consentement de suivi : décision
-- d'Alix, hors de ce lot.
--
-- ============================================================================================
-- 1 — LES RÉSULTATS SONT MATÉRIALISÉS SUR LA RELANCE, PAS RECALCULÉS À LA VOLÉE
-- ============================================================================================
--
-- ⛔ POURQUOI DES COLONNES ET NON UNE VUE QUI JOINT. `email_event.outbox_id` (0041) ET
-- `lifecycle_send.outbox_id` (0057) sont tous les deux `on delete set null`. Purger la file d'envoi
-- — ce qu'on finira par faire — couperait donc RÉTROACTIVEMENT le lien entre chaque relance et ses
-- événements : l'historique s'effondrerait sans une erreur, et les chiffres d'hier changeraient
-- sans que personne n'ait rien fait. Une mesure qui ne survit pas au ménage n'est pas une mesure.
alter table newsletter.lifecycle_send
  add column if not exists delivered_at    timestamptz,
  add column if not exists responded_at    timestamptz,
  add column if not exists opened_at       timestamptz,
  add column if not exists clicked_at      timestamptz,
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists complained_at   timestamptz,
  add column if not exists bounced_at      timestamptz;

comment on column newsletter.lifecycle_send.delivered_at is
  'Première remise CONFIRMÉE par le fournisseur. Dénominateur de tout taux : ni enqueued (une ligne peut rester pending pour toujours), ni sent (remettre à Mailgun ne dit rien de la remise).';
comment on column newsletter.lifecycle_send.opened_at is
  'Première ouverture rapportée par le fournisseur. Reste NULL tant que tracking_consent est faux — ce qui est le cas de 1 202 abonnements sur 1 203 : un zéro ici dit le consentement, pas la relance.';
comment on column newsletter.lifecycle_send.responded_at is
  'La personne a ouvert sa page de préférences APRÈS cette relance. Signal de première partie, sans pixel — le seul qui existera tant que le consentement de suivi est refusé.';
comment on column newsletter.lifecycle_send.unsubscribed_at is
  'Désabonnement postérieur à la relance. Le COÛT de la vague : le chiffre le plus important, et le seul qui puisse la condamner.';

-- ============================================================================================
-- 2 — LA SYNCHRONISATION : DES ÉVÉNEMENTS VERS LA RELANCE
-- ============================================================================================
--
-- ⛔ ANTÉRIORITÉ STRICTE. On ne compte qu'un événement POSTÉRIEUR à la relance
-- (`e.occurred_at > l.created_at`). Une ouverture antérieure est justement celle qui n'a pas suffi
-- à éviter la relance : la compter comme un succès ferait dire à la mesure le contraire de ce qui
-- s'est passé. Même discipline que `reactivate_sunset` (0058).
--
-- ⛔ `min()` ET NON `max()`. On veut la PREMIÈRE réaction, pas la dernière : c'est elle qui dit si
-- la relance a fonctionné. La dernière ne dirait que la date du dernier passage.
--
-- ⛔ IDEMPOTENTE, ET ELLE NE RECULE JAMAIS. `coalesce(l.colonne, nouvelle_valeur)` : une date déjà
-- posée ne bouge plus. Repasser la fonction dix fois ne change rien après la première.
create or replace function newsletter.sync_lifecycle_outcomes(
  p_asset_id uuid default null,
  p_dry_run  boolean default false
)
returns table(candidates bigint, updated bigint)
language plpgsql
security definer
set search_path = newsletter, public
as $$
declare
  v_candidates bigint := 0;
  v_updated    bigint := 0;
begin
  -- ⛔ `on commit drop` ne libère le NOM qu'au COMMIT, pas à la sortie de la fonction : deux appels
  -- dans une même transaction — ce que fait le banc, et ce que fera un jour un script — échouent
  -- sur « relation already exists ». Le drop explicite est la seule façon de rendre la fonction
  -- réellement rappelable.
  drop table if exists _sync;

  -- Les relances dont un événement postérieur n'est pas encore reporté.
  create temp table _sync on commit drop as
  select l.id,
         min(e.occurred_at) filter (where e.type = 'delivered')    as delivered_at,
         min(e.occurred_at) filter (where e.type = 'opened')       as opened_at,
         min(e.occurred_at) filter (where e.type = 'clicked')      as clicked_at,
         min(e.occurred_at) filter (where e.type = 'unsubscribed') as unsubscribed_at,
         min(e.occurred_at) filter (where e.type = 'complained')   as complained_at,
         min(e.occurred_at) filter (where e.type = 'bounced')      as bounced_at
    from newsletter.lifecycle_send l
    join newsletter.email_event e
      on e.outbox_id = l.outbox_id
     and e.occurred_at > l.created_at
   where l.outbox_id is not null
     and (p_asset_id is null or l.asset_id = p_asset_id)
   group by l.id;

  select count(*) into v_candidates from _sync;

  if p_dry_run then
    -- ⛔ On rend le MÊME nombre que la branche réelle mettrait à jour, calculé sur la même table
    -- temporaire — jamais une seconde expression « équivalente », qui finirait par diverger.
    return query select v_candidates, 0::bigint;
    return;
  end if;

  update newsletter.lifecycle_send l
     set delivered_at    = coalesce(l.delivered_at,    s.delivered_at),
         opened_at       = coalesce(l.opened_at,       s.opened_at),
         clicked_at      = coalesce(l.clicked_at,      s.clicked_at),
         unsubscribed_at = coalesce(l.unsubscribed_at, s.unsubscribed_at),
         complained_at   = coalesce(l.complained_at,   s.complained_at),
         bounced_at      = coalesce(l.bounced_at,      s.bounced_at)
    from _sync s
   where s.id = l.id
     -- N'écrire que ce qui change : sinon chaque passe réécrit toute la table.
     and (l.delivered_at    is distinct from coalesce(l.delivered_at,    s.delivered_at)
       or l.opened_at       is distinct from coalesce(l.opened_at,       s.opened_at)
       or l.clicked_at      is distinct from coalesce(l.clicked_at,      s.clicked_at)
       or l.unsubscribed_at is distinct from coalesce(l.unsubscribed_at, s.unsubscribed_at)
       or l.complained_at   is distinct from coalesce(l.complained_at,   s.complained_at)
       or l.bounced_at      is distinct from coalesce(l.bounced_at,      s.bounced_at));

  get diagnostics v_updated = row_count;
  return query select v_candidates, v_updated;
end;
$$;

comment on function newsletter.sync_lifecycle_outcomes(uuid, boolean) is
  'Reporte sur chaque relance les événements POSTÉRIEURS qui la concernent. Matérialise pour survivre à une purge de la file. N''écrit jamais une date par-dessus une autre.';

-- ============================================================================================
-- 3 — LA VUE DE RÉSULTAT, AVEC SON DISCRIMINANT
-- ============================================================================================
--
-- ⛔ `count(distinct l.id)` PARTOUT. La chaîne relance → outbox → événements multiplie les lignes
-- par le nombre d'événements : un `count(*)` compterait trois fois une relance ayant reçu trois
-- événements. Le nombre serait faux VERS LE HAUT — et un taux trop flatteur ne se remarque jamais.
-- Ici on agrège des colonnes déjà matérialisées, donc une ligne par relance : le `distinct` est
-- une ceinture, pas une nécessité, et il reste juste si quelqu'un rejoint la table plus tard.
--
-- ⛔ LE COMPTE D'ORPHELINS EST LA COLONNE LA PLUS IMPORTANTE DE CETTE VUE. Sans lui, « 0 réaction »
-- ne se distingue pas de « la jointure ne mord pas » — et ce sont deux mondes opposés : le premier
-- dit que la relance ne marche pas, le second qu'on ne mesure rien. Un compteur nul a presque
-- toujours deux causes possibles ; celle-ci les sépare.
create or replace view newsletter.reengagement_result as
with orphelins as (
  -- Événements reçus SANS ligne d'origine rattachée. Comptés par marque quand on la connaît, et
  -- globalement sinon — un orphelin sans marque est précisément le cas le plus grave.
  select asset_id, count(*) as n
    from newsletter.email_event
   where outbox_id is null
   group by asset_id
)
select
  l.asset_id,
  a.slug  as asset_slug,
  l.kind,
  l.step,
  count(distinct l.id)                                                as enqueued,
  count(distinct l.id) filter (where l.delivered_at    is not null)   as delivered,
  count(distinct l.id) filter (where l.responded_at    is not null)   as responded,
  -- ⚠️ STRUCTURELLEMENT NULS AUJOURD'HUI, et ce n'est pas une panne : Mailgun ne pose pixel ni
  -- réécriture de lien sans `tracking_consent`, refusé par 1 202 abonnements sur 1 203. Ces deux
  -- colonnes existent pour que changer ce consentement suffise — sans nouvelle migration — et
  -- pour que leur zéro soit LU comme un réglage, pas comme un échec de la relance.
  count(distinct l.id) filter (where l.opened_at       is not null)   as opened,
  count(distinct l.id) filter (where l.clicked_at      is not null)   as clicked,
  count(distinct l.id) filter (where l.unsubscribed_at is not null)   as unsubscribed,
  count(distinct l.id) filter (where l.complained_at   is not null)   as complained,
  count(distinct l.id) filter (where l.bounced_at      is not null)   as bounced,
  min(l.created_at)                                                   as first_sent_at,
  max(l.created_at)                                                   as last_sent_at,
  -- ⚠️ LE DISCRIMINANT. Non nul ⇒ des événements arrivent sans qu'on sache à quoi les rattacher :
  -- tout chiffre de cette ligne est alors un PLANCHER, pas une mesure.
  coalesce((select o.n from orphelins o where o.asset_id is not distinct from l.asset_id), 0)
    + coalesce((select o.n from orphelins o where o.asset_id is null), 0)               as orphan_events
from newsletter.lifecycle_send l
left join newsletter.asset a on a.id = l.asset_id
group by l.asset_id, a.slug, l.kind, l.step;

comment on view newsletter.reengagement_result is
  'Ce qu''une vague de réengagement a produit, par marque et par étape. Le dénominateur honnête est `delivered`, jamais `enqueued`. `responded` est un signal de première partie (page de préférences) : il n''y a ni ouverture ni clic tant que le consentement de suivi est refusé. `orphan_events` non nul ⇒ tous les autres chiffres sont des planchers.';

grant select on newsletter.reengagement_result to service_role;

notify pgrst, 'reload schema';
