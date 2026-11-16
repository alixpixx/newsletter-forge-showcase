-- ============================================================================
-- 0072 — `audit_log` devient interrogeable PAR CIBLE.
-- ============================================================================
--
-- ⭐ POURQUOI. `newsletter.campaign` n'a pas de colonne `hold_reason` (l'occurrence, si). Quand le
-- fan-out arrête une campagne PONCTUELLE, la raison n'a donc qu'un seul endroit où vivre :
-- `audit_log`, action `campaign-held` (voir `apps/worker/src/fanout-db.ts`, `holdCampaign`).
-- Jusqu'au 18/09/2026 aucun écran ne lisait cette table : une campagne arrêtée par le worker
-- affichait « Paused » et rien d'autre, et la cause n'existait que dans les journaux d'un service
-- que personne ne consulte. L'écran de détail la lit désormais.
--
-- ⛔ MAIS `audit_log` N'AVAIT AUCUN INDEX — pas un seul, depuis 0001. La lecture « le dernier
-- incident de CETTE campagne » est un `where target_type = ... and target_id = ...` : sans index,
-- c'est un parcours complet de la table à chaque ouverture d'une fiche campagne. La table ne fait
-- que grossir (chaque action d'admin et chaque refus de worker y écrit) et n'est jamais purgée :
-- l'écran se dégraderait lentement, sans qu'aucune erreur ne soit jamais levée. C'est exactement la
-- forme de panne que ce lot corrige ailleurs — on ne va pas en introduire une.
--
-- ⚠️ `created_at desc` DANS L'INDEX, parce que la requête est `order by created_at desc limit 1`.
-- Sans cette colonne, Postgres retrouve vite les lignes de la cible puis les TRIE : correct, mais
-- le tri revient à chaque lecture. Avec elle, la première ligne lue est la réponse.
--
-- ⚠️ `concurrently` est VOLONTAIREMENT ABSENT : il ne peut pas tourner dans un bloc transactionnel,
-- et l'applicateur de migrations en utilise un. `audit_log` est une table d'écriture seule que rien
-- ne lit en continu ; le verrou d'un `create index` ordinaire y dure le temps du parcours.

create index if not exists idx_audit_log_target
  on newsletter.audit_log (target_type, target_id, created_at desc);

-- Le pendant pour la lecture « tout ce qui s'est passé sur cette marque », qui n'existe pas encore
-- à l'écran mais que le moindre audit réclame — et qui ferait le même parcours complet.
create index if not exists idx_audit_log_asset
  on newsletter.audit_log (asset_id, created_at desc);

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE — DANS la migration.
-- ⛔ Une migration qui n'exécute que des `create index if not exists` rend « success » même si elle
-- n'a rien créé (schéma absent, droits insuffisants, nom déjà pris par un autre objet). La seule
-- preuve est de relire le catalogue et d'ÉCHOUER si l'index n'y est pas.
-- ---------------------------------------------------------------------------
do $$
declare
  manquants text;
begin
  select string_agg(attendu, ', ')
    into manquants
    from (values ('idx_audit_log_target'), ('idx_audit_log_asset')) as v(attendu)
   where not exists (
     select 1
       from pg_indexes
      where schemaname = 'newsletter'
        and tablename  = 'audit_log'
        and indexname  = v.attendu
   );

  if manquants is not null then
    raise exception '[0072] index absents apres execution : %', manquants;
  end if;

  raise notice '[0072] contre-epreuve OK : audit_log est indexee par cible et par marque';
end
$$;

comment on table newsletter.audit_log is
  'Journal d''audit. Pour une campagne PONCTUELLE arretee par le fan-out, action = campaign-held, '
  'c''est la SEULE source de la raison (campaign n''a pas de colonne hold_reason). Indexee par '
  '(target_type, target_id) depuis 0072 : l''ecran de detail d''une campagne la lit.';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE. Le registre de la CLI Supabase ne
-- correspond pas à ce dossier : la seule preuve qu'une migration est passée est la ligne qu'elle
-- écrit ici. L'inscrire AVANT la vérification déclarerait « appliquée » une migration qui échoue
-- ensuite.
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0072', '0072_audit_log_target_index.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
