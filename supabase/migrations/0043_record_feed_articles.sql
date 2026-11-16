-- =============================================================================
-- 0043 — Mémoriser les articles d'une édition SANS jamais échouer sur un doublon
-- =============================================================================
--
-- ⛔ POURQUOI UNE FONCTION PLUTÔT QU'UN `upsert` DEPUIS LE WORKER. `feed_article_sent` protège son
-- idempotence par deux index uniques PARTIELS (0042) : un pour les occurrences, un pour les
-- campagnes ponctuelles, parce qu'en Postgres `NULL <> NULL` et qu'un index ordinaire ne couvrirait
-- donc pas le second cas.
--
-- Or PostgREST ne sait PAS viser un index partiel : son `Prefer: resolution=ignore-duplicates`
-- pose un `ON CONFLICT` sur la clé primaire. Comme chaque ligne arrive avec un `id` neuf, aucun
-- conflit n'est détecté là — et l'index partiel lève un 23505 qui fait échouer TOUT le lot.
-- Mesuré le 26/08 sur un banc : le rejeu d'une résolution identique faisait tomber l'enregistrement
-- entier, alors que le gel, lui, avait réussi.
--
-- ⚠️ Ce n'est pas un cas tordu : c'est le cas NORMAL. Deux passes du planificateur peuvent proposer
-- les mêmes articles, et une occurrence regelée après un incident les propose forcément. Un lot qui
-- échoue là condamne la mémoire d'anti-répétition à rester incomplète — donc la newsletter à se
-- répéter — sans qu'aucun écran ne s'allume.
--
-- `ON CONFLICT DO NOTHING` SANS CIBLE est la seule forme qui couvre tous les index de la table,
-- partiels compris. Elle n'est exprimable qu'en SQL, d'où cette fonction.
-- =============================================================================

create or replace function newsletter.record_feed_articles(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = newsletter, public
as $$
declare
  v_inserted integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;

  insert into newsletter.feed_article_sent (
    campaign_id, occurrence_id, asset_id, block_id, article_url, article_title, published_at
  )
  select
    (r ->> 'campaign_id')::uuid,
    nullif(r ->> 'occurrence_id', '')::uuid,
    (r ->> 'asset_id')::uuid,
    r ->> 'block_id',
    r ->> 'article_url',
    r ->> 'article_title',
    nullif(r ->> 'published_at', '')::timestamptz
  from jsonb_array_elements(p_rows) as r
  on conflict do nothing;

  -- ⚠️ `GET DIAGNOSTICS` et non un `select count(*)` : un comptage lancé dans la même instruction
  -- lirait le snapshot d'AVANT l'insertion et rendrait toujours l'ancien total.
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function newsletter.record_feed_articles(jsonb) is
  'Mémorise les articles retenus par un bloc flux. ON CONFLICT DO NOTHING sans cible : seule forme qui couvre les index uniques PARTIELS de feed_article_sent.';

revoke all on function newsletter.record_feed_articles(jsonb) from public;
grant execute on function newsletter.record_feed_articles(jsonb) to service_role;
