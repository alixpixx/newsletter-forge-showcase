-- 0066 — Les pieds éditoriaux déjà composés, versés dans la bibliothèque (données).
--
-- LA DEMANDE (Alix, 16/09) : « on avait cree une entete et un design pour le footer pour
-- un template harbor-tech copper-kettle et northwind-sports j'aimerai que tu mettes ces elements la
-- par default dans notre header footer section de ces domaines ». Les trois en-têtes y
-- sont déjà (H4) ; aucun pied n'y était.
--
-- LA SOURCE : la version PUBLIÉE du modèle qui porte ce pied, lue en base au moment de la
-- migration. Recopier le JSON ici aurait figé une forme que personne ne relit ; le lire
-- à la source garantit que la bibliothèque montre le pied qui part aujourd'hui.
--
-- ⚠️ Copper Kettle : SEULEMENT le logo et la ligne du site (décision d'Alix). L'encart
-- « Infórmate antes » (canal WhatsApp) est une promotion, pas un pied de marque.
--
-- ⛔ PAS DE TEMPLATE LÉGAL « Default ». Le pied de l'édition reste le pied par défaut, et
-- il reste éditable. Une copie en template aurait fait deux sources du même texte, qui
-- auraient divergé à la première correction.
--
-- Rejouable : chaque insertion est gardée par l'existence d'un pied VIVANT du même nom.

with source as (
  select a.id as asset_id, a.slug, r.value as row_json, r.ordinality as ord
    from newsletter.template t
    join newsletter.asset a on a.id = t.asset_id
    join newsletter.template_version v on v.id = t.current_version_id and v.status = 'published'
    cross join lateral jsonb_array_elements(v.doc -> 'rows') with ordinality r
   where t.archived_at is null
     and (
       (a.slug = 'harbor-tech' and t.name = 'Friday edition' and r.value ->> 'id' = 'tw_foot')
       or (a.slug = 'northwind-sports' and t.name = 'Giro do Tricolor' and r.value ->> 'id' in ('nf_bar2', 'nf_foot'))
       or (a.slug = 'copper-kettle' and t.name = 'Boletín semanal genérico' and r.value ->> 'id' = 'pf_encart')
     )
),
lignes as (
  select asset_id, slug, ord,
         case
           when slug = 'copper-kettle' then
             jsonb_set(
               row_json,
               '{columns,0,blocks}',
               (select jsonb_agg(b.value order by b.ordinality)
                  from jsonb_array_elements(row_json -> 'columns' -> 0 -> 'blocks') with ordinality b
                 where b.value ->> 'id' in ('pf_logo2', 'pf_site'))
             ) || '{"id": "pf_foot"}'::jsonb
           else row_json
         end as row_json
    from source
),
pieds as (
  select asset_id, slug,
         case slug
           when 'harbor-tech' then 'Harbor Tech footer'
           when 'northwind-sports' then 'NORTHWIND SPORTS footer'
           when 'copper-kettle' then 'Copper Kettle footer'
         end as name,
         jsonb_agg(row_json order by ord) as "rows"
    from lignes
   group by asset_id, slug
)
insert into newsletter.brand_partial (asset_id, slot, name, "rows", updated_by)
select p.asset_id, 'footer', p.name, p."rows", 'migration-0066'
  from pieds p
 where not exists (
   select 1 from newsletter.brand_partial bp
    where bp.asset_id = p.asset_id and bp.slot = 'footer' and bp.name = p.name and bp.archived_at is null
 );

-- Assertion : les trois pieds existent, avec le bon nombre de rows et de blocs. Un modèle
-- renommé ferait sinon passer la migration en n'ayant rien versé.
do $$
declare
  -- slug : nombre de rows : blocs de la DERNIÈRE row (logo + ligne du site, partout).
  v_attendu text := 'northwind-sports:2:2|copper-kettle:1:2|harbor-tech:1:2';
  v_obtenu text;
begin
  -- Base neuve (démo, CI) : les modèles sources n'existent pas, il n'y a rien à verser.
  if not exists (
    select 1 from newsletter.template t join newsletter.asset a on a.id = t.asset_id
     where t.archived_at is null
       and ((a.slug = 'harbor-tech' and t.name = 'Friday edition')
         or (a.slug = 'northwind-sports' and t.name = 'Giro do Tricolor')
         or (a.slug = 'copper-kettle' and t.name = 'Boletín semanal genérico'))
  ) then
    raise notice 'pieds de marque : modèles sources absents (base neuve), rien versé';
    return;
  end if;

  select string_agg(a.slug || ':' || jsonb_array_length(bp."rows") || ':'
                    || jsonb_array_length(bp."rows" -> -1 -> 'columns' -> 0 -> 'blocks'),
                    '|' order by a.slug)
    into v_obtenu
    from newsletter.brand_partial bp
    join newsletter.asset a on a.id = bp.asset_id
   where bp.slot = 'footer' and bp.archived_at is null
     and bp.name in ('Harbor Tech footer', 'NORTHWIND SPORTS footer', 'Copper Kettle footer');

  if v_obtenu is distinct from v_attendu then
    raise exception 'pieds de marque : attendu %, obtenu %', v_attendu, v_obtenu;
  end if;
end
$$;

insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0066', '0066_brand_footers_seed.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
