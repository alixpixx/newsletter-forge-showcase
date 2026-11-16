-- 0068 — « Edición 1 » cesse d'être écrit en dur dans les en-têtes Copper Kettle (données).
--
-- LA DEMANDE (Alix, 16/09) : le header PF affichait « {{edition_date}} · Edición 1 » quelle que
-- soit l'édition → « on le rend dynamique ».
--
-- LA FORME : `visibleIf` ne s'applique qu'à un bloc entier, pas à une portion de texte. Le bloc
-- `pf_date` devient DEUX blocs exclusifs, au même endroit et avec le même style :
--   pf_date_ed  « {{edition_date}} · Edición {{edition_number}} »  si edition_number est renseigné
--   pf_date     « {{edition_date}} »                               sinon (exists:false)
-- `edition_number` n'existe que pour une occurrence de SÉRIE (0027/0067) : une campagne ponctuelle
-- ou un envoi de test affiche la date seule, jamais « · Edición » orphelin ni un faux « 1 ».
-- Banc : packages/render/src/edition-number.test.ts.
--
-- LE PÉRIMÈTRE, mesuré le 16/09 : le header « Copper Kettle header » de la bibliothèque et les
-- BROUILLONS des 4 modèles PF actifs (Colo-Colo, U. Católica, U. de Chile, genérico), tous
-- identiques à leur version publiée. Les versions publiées ne sont PAS touchées : une version est
-- figée, elle se remplace en publiant (geste fait par l'admin juste après). Les modèles archivés
-- restent tels quels (Alix : pas de restauration).
--
-- ⛔ GARDÉ : le bloc visé doit être à sa place, avec son texte exact ; sinon rien n'est écrit.
-- `updated_at` est avancé pour qu'un onglet ouvert sur l'un de ces documents prenne un 409 au lieu
-- d'écraser la modification.

do $$
declare
  -- ⚠️ Le « · » est entouré d'ESPACES INSÉCABLES (U+00A0) dans les documents : mesuré en hex le
  -- 16/09, un premier passage avec des espaces ordinaires a été refusé par le garde (0 sur 4).
  v_sep      constant text := chr(160) || '·' || chr(160);
  v_ancien   constant text := '{{edition_date}}' || v_sep || 'Edición 1';
  v_nouveau  constant text := '{{edition_date}}' || v_sep || 'Edición {{edition_number}}';
  v_ids      constant uuid[] := array[
    'c8575b87-c21b-4582-9f64-92fb30bfbc07',  -- Boletín semanal Colo-Colo
    '144263e7-b0da-49d6-b282-7ad943800207',  -- Boletín semanal U. Católica
    '7a15c55c-84cc-41c9-b594-8c3dfc2e8744',  -- Boletín semanal U. de Chile
    'b08982fd-3705-42df-a04d-14ec86b9fc68'   -- Boletín semanal genérico
  ]::uuid[];
  v_partial  constant uuid := 'f49d5bdc-5b68-4be7-a9ca-445a795d47c6';  -- Copper Kettle header
  v_n        integer;
begin
  -- 1. Les 4 brouillons.
  with cibles as (
    select tv.id, tv.doc
      from newsletter.template_version tv
      join newsletter.template t on t.id = tv.template_id
     where t.id = any (v_ids)
       and t.archived_at is null
       and tv.status = 'draft'
       and tv.doc #>> '{rows,0,columns,0,blocks,4,id}' = 'pf_date'
       and tv.doc #>> '{rows,0,columns,0,blocks,4,paragraphs,0,spans,0,text}' = v_ancien
       and jsonb_array_length(tv.doc #> '{rows,0,columns,0,blocks,4,paragraphs}') = 1
       and jsonb_array_length(tv.doc #> '{rows,0,columns,0,blocks,4,paragraphs,0,spans}') = 1
       and tv.doc #> '{rows,0,columns,0,blocks,4,visibleIf}' is null
       and position('pf_date_ed' in tv.doc::text) = 0
  ),
  refaits as (
    select c.id,
           jsonb_set(
             c.doc,
             '{rows,0,columns,0,blocks}',
             (select jsonb_agg(x order by o, k)
                from (
                  select b.o, 0 as k,
                         case when b.o = 5
                              then b.blk || jsonb_build_object(
                                     'id', 'pf_date_ed',
                                     'visibleIf', jsonb_build_object('token', 'edition_number'),
                                     'paragraphs', jsonb_build_array(jsonb_build_object('spans',
                                       jsonb_build_array(jsonb_build_object('text', v_nouveau)))))
                              else b.blk end as x
                    from jsonb_array_elements(c.doc #> '{rows,0,columns,0,blocks}') with ordinality b(blk, o)
                  union all
                  select 5, 1,
                         (c.doc #> '{rows,0,columns,0,blocks,4}') || jsonb_build_object(
                           'visibleIf', jsonb_build_object('token', 'edition_number', 'exists', false),
                           'paragraphs', jsonb_build_array(jsonb_build_object('spans',
                             jsonb_build_array(jsonb_build_object('text', '{{edition_date}}')))))
                ) s)
           ) as doc
      from cibles c
  )
  update newsletter.template_version tv
     set doc = r.doc, updated_at = now()
    from refaits r
   where tv.id = r.id;
  get diagnostics v_n = row_count;
  -- 0 = base neuve (démo, CI) : les brouillons ciblés n'existent pas, rien à réécrire.
  if v_n not in (0, 4) then
    raise exception '0068 brouillons PF : attendu 4 (ou 0 sur base neuve), obtenu %', v_n;
  end if;

  update newsletter.template set updated_at = now() where id = any (v_ids);

  -- 2. Le header de la bibliothèque (rows = tableau de rows, même chemin sans le préfixe `rows`).
  with cible as (
    select bp.id, bp.rows
      from newsletter.brand_partial bp
     where bp.id = v_partial
       and bp.archived_at is null
       and bp.rows #>> '{0,columns,0,blocks,4,id}' = 'pf_date'
       and bp.rows #>> '{0,columns,0,blocks,4,paragraphs,0,spans,0,text}' = v_ancien
       and jsonb_array_length(bp.rows #> '{0,columns,0,blocks,4,paragraphs}') = 1
       and jsonb_array_length(bp.rows #> '{0,columns,0,blocks,4,paragraphs,0,spans}') = 1
       and bp.rows #> '{0,columns,0,blocks,4,visibleIf}' is null
       and position('pf_date_ed' in bp.rows::text) = 0
  ),
  refait as (
    select c.id,
           jsonb_set(
             c.rows,
             '{0,columns,0,blocks}',
             (select jsonb_agg(x order by o, k)
                from (
                  select b.o, 0 as k,
                         case when b.o = 5
                              then b.blk || jsonb_build_object(
                                     'id', 'pf_date_ed',
                                     'visibleIf', jsonb_build_object('token', 'edition_number'),
                                     'paragraphs', jsonb_build_array(jsonb_build_object('spans',
                                       jsonb_build_array(jsonb_build_object('text', v_nouveau)))))
                              else b.blk end as x
                    from jsonb_array_elements(c.rows #> '{0,columns,0,blocks}') with ordinality b(blk, o)
                  union all
                  select 5, 1,
                         (c.rows #> '{0,columns,0,blocks,4}') || jsonb_build_object(
                           'visibleIf', jsonb_build_object('token', 'edition_number', 'exists', false),
                           'paragraphs', jsonb_build_array(jsonb_build_object('spans',
                             jsonb_build_array(jsonb_build_object('text', '{{edition_date}}')))))
                ) s)
           ) as rows
      from cible c
  )
  update newsletter.brand_partial bp
     set rows = r.rows, updated_at = now(), updated_by = 'migration 0068'
    from refait r
   where bp.id = r.id;
  get diagnostics v_n = row_count;
  if v_n not in (0, 1) then
    raise exception '0068 header PF de la bibliothèque : attendu 1 (ou 0 sur base neuve), obtenu %', v_n;
  end if;
end
$$;

insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0068', '0068_pf_edition_dynamique.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
