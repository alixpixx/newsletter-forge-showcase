-- ============================================================================
-- 0076 — retrait de `all_access` (0074), remplacé par `all_assets` + `all_templates` (0075).
-- ============================================================================
--
-- 🚨⛔⛔ CE FICHIER NE S'APPLIQUE QU'APRÈS LE DÉPLOIEMENT DU NOUVEAU CODE. 🚨
--
-- ORDRE : 0075 → NOUVEAU CODE EN LIGNE → 0076 (ce fichier).
--
-- ⛔ POURQUOI CET ORDRE N'EST PAS UNE PRÉCAUTION DE STYLE. Le code qui tourne AVANT le déploiement
-- demande `all_access` dans la liste de colonnes de `findById` / `findByEmail`
-- (apps/admin/src/lib/data/app-user.ts) — c'est-à-dire à CHAQUE requête et à la connexion. Appliqué
-- trop tôt, ce fichier fait répondre à PostgREST « column app_user.all_access does not exist » sur
-- cette lecture, et `getSessionUser()` lève : l'admin entier tombe, écran de connexion compris, et
-- plus personne ne peut se connecter pour réparer. Le nouveau code, lui, ne nomme `all_access` nulle
-- part — c'est ce qui rend ce retrait sans effet une fois qu'il est en ligne.
--
-- ⭐ POURQUOI RETIRER PLUTÔT QUE LAISSER. Une colonne que plus personne n'écrit et que personne ne
-- lit devient un piège : elle garde la valeur du jour où on l'a abandonnée, elle a l'air d'être la
-- source de vérité dans un `select *`, et le premier script d'export ou de reprise qui la croit
-- rendra un périmètre faux. Deux drapeaux qui décident, zéro drapeau qui traîne.
--
-- ⚠️ IRRÉVERSIBLE. La valeur de `all_access` est perdue après ce fichier. Elle a été recopiée dans
-- `all_assets` et `all_templates` par 0075, dont la contre-épreuve échoue si la recopie n'a pas pris
-- — c'est là, et pas ici, que la reprise est prouvée.

-- ---------------------------------------------------------------------------
-- GARDE D'ORDRE — avant de retirer l'ancienne colonne, exiger les deux nouvelles.
-- ⛔ Sans cette garde, appliquer 0076 sur une base où 0075 n'est pas passé laisserait le compte
-- SANS AUCUN drapeau : `all_access` détruit, `all_assets` / `all_templates` jamais créés, et tous
-- les comptes qui voyaient tout réduits à leurs octrois explicites, en silence.
-- ---------------------------------------------------------------------------
do $$
declare
  manquant text;
begin
  foreach manquant in array array['all_assets', 'all_templates'] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'newsletter' and table_name = 'app_user' and column_name = manquant
    ) then
      raise exception '[0076] app_user.% absent : appliquer 0075 AVANT ce fichier', manquant;
    end if;
  end loop;
end
$$;

alter table newsletter.app_user
  drop column if exists all_access;

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE — DANS la migration (voir 0072).
-- ⛔ `drop column if exists` rend « success » même s'il n'a rien retiré. On relit le catalogue et on
-- ÉCHOUE si la colonne est encore là, ou si l'une des deux qui la remplacent a disparu au passage.
-- ---------------------------------------------------------------------------
do $$
declare
  present text;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'newsletter' and table_name = 'app_user' and column_name = 'all_access'
  ) then
    raise exception '[0076] app_user.all_access est encore present apres execution';
  end if;

  foreach present in array array['all_assets', 'all_templates'] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'newsletter' and table_name = 'app_user' and column_name = present
    ) then
      raise exception '[0076] app_user.% a disparu : les deux drapeaux doivent survivre au retrait', present;
    end if;
  end loop;

  raise notice '[0076] contre-epreuve OK : all_access retire, all_assets et all_templates en place';
end
$$;

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0076', '0076_app_user_drop_all_access.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;

notify pgrst, 'reload schema';
