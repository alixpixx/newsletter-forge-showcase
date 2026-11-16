-- ============================================================================
-- 0080 — Troisième fente de la bibliothèque de marque : `brand_partial.slot = 'block'`.
-- ============================================================================
--
-- ⭐ POURQUOI. Demande d'Alix (23/09/2026) : « pouvoir créer des blocks qu'on peut importer où on
-- veut, un truc simple, comme le header et le footer qui sont importables ». Un bloc de bibliothèque
-- est une suite de 1 à 20 rows, COPIÉE dans le document à l'insertion — exactement ce que sont déjà
-- l'en-tête et le pied depuis la décision d'Alix du 16/09. Seule la position d'insertion change :
-- l'en-tête va en haut, le pied au-dessus du pied légal, le bloc là où l'auteur le demande.
--
-- ⛔ POURQUOI LA MÊME TABLE ET PAS UNE NEUVE. Tout existe déjà sur `brand_partial` : liste, aperçu,
-- éditeur, renommage, archivage (qui LIBÈRE le nom, `uq_brand_partial_nom` filtré), contrôle de
-- version, modale d'import. Une table neuve dupliquerait ces chemins, et les deux finiraient par ne
-- plus traiter pareil un nom pris ou une row illisible. L'index unique porte déjà `slot` : un bloc et
-- un en-tête peuvent porter le même nom sans se gêner.
--
-- ⛔ AUCUN POINTEUR NE DÉSIGNE UN BLOC. `doc.meta.headerPartialId` / `footerPartialId` exigent la
-- fente correspondante (`resolveBrandPartials` côté admin, `resoudrePartials` côté worker) : une ligne
-- `block` désignée comme en-tête sort « manquante » et la publication est refusée, jamais posée en
-- haut de l'e-mail.
--
-- ⛔ ORDRE DE DÉPLOIEMENT : LE CODE D'ABORD, OU CETTE MIGRATION D'ABORD — MAIS AUCUNE LIGNE `block`
-- AVANT LE CODE. L'ancien code n'écrit jamais `block`, donc appliquer ce fichier seul ne change rien.
-- En revanche l'admin actuellement en ligne relit chaque ligne avec une liste FERMÉE de fentes : une
-- seule ligne `block` lui fait rendre `known: false`, c'est-à-dire un 503 sur TOUTE la bibliothèque de
-- la marque, en-têtes et pieds compris.
--
-- ⚠️ La table `saved_row` (0020) reste en place : son interface est retirée (« Save this row » écrit
-- désormais un bloc), mais ses 3 lignes — toutes archivées — ne sont pas effacées. Aucune migration
-- destructive.

alter table newsletter.brand_partial drop constraint if exists brand_partial_slot_check;
alter table newsletter.brand_partial
  add constraint brand_partial_slot_check check (slot in ('header', 'footer', 'block'));

comment on table newsletter.brand_partial is
  'Bibliotheque de marque : en-tete (header), pied editorial (footer) et blocs (block) d''une marque. '
  'Les rows sont COPIEES dans le document a l''import ; les pointeurs doc.meta.headerPartialId / '
  'footerPartialId (dormants) exigent la fente correspondante et ne designent jamais un bloc. '
  'Ne porte jamais le theme, ni de bloc footer_legal.';

-- ---------------------------------------------------------------------------
-- CONTRE-ÉPREUVE — DANS la migration (voir 0072).
-- ⛔ `drop constraint if exists` rend « success » même s'il n'a rien retiré (contrainte renommée à la
-- main, schéma absent) : on relit le CATALOGUE et on ÉCHOUE si la contrainte posée ne porte pas les
-- trois fentes, ou si une AUTRE contrainte de fente, restée d'avant, refuserait encore `block`.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_autres int;
begin
  select pg_get_constraintdef(oid)
    into v_def
    from pg_constraint
   where conname = 'brand_partial_slot_check'
     and conrelid = 'newsletter.brand_partial'::regclass;

  if v_def is null then
    raise exception '[0080] la contrainte brand_partial_slot_check est absente apres execution';
  end if;
  if v_def not like '%''header''%' or v_def not like '%''footer''%' or v_def not like '%''block''%' then
    raise exception '[0080] brand_partial_slot_check ne porte pas les trois fentes : %', v_def;
  end if;

  select count(*)
    into v_autres
    from pg_constraint
   where conrelid = 'newsletter.brand_partial'::regclass
     and contype = 'c'
     and conname <> 'brand_partial_slot_check'
     and pg_get_constraintdef(oid) like '%slot%';
  if v_autres > 0 then
    raise exception '[0080] % autre(s) contrainte(s) CHECK portent sur slot et pourraient refuser block', v_autres;
  end if;

  raise notice '[0080] contre-epreuve OK : %', v_def;
end
$$;

notify pgrst, 'reload schema';

-- ⛔ EN DERNIÈRE INSTRUCTION, ET APRÈS LA CONTRE-ÉPREUVE (voir 0072).
insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0080', '0080_brand_partial_block.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
