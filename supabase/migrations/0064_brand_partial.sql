-- 0064 — En-tête et pied de marque réutilisables (« brand partial »).
--
-- POURQUOI UNE TABLE DÉDIÉE ET PAS `saved_row` (0020). Une ligne enregistrée est un
-- COPIER-COLLER sans lien retour : une fois insérée dans un modèle, plus rien ne
-- relie les deux, et la question « quels modèles utilisent cet en-tête ? » n'a pas
-- de réponse. Ici le document ne stocke qu'un POINTEUR (`doc.meta.headerPartialId`
-- / `footerPartialId`) : le lien survit à l'insertion, et c'est lui qui permettra
-- de dire à l'écran combien de modèles portent réellement cet en-tête.
--
-- POURQUOI L'UNICITÉ EST FILTRÉE, CONTRAIREMENT À `saved_row`. `saved_row` porte
-- `unique (asset_id, name)` NON filtrée : un nom archivé reste réservé À VIE, et la
-- route répond 409 sur un nom que plus personne ne voit nulle part. Le geste
-- naturel — « j'archive l'ancien header, j'en refais un qui s'appelle pareil » —
-- est donc refusé sans explication visible. L'index ci-dessous ne contraint que les
-- lignes VIVANTES : archiver libère le nom, ce qui est exactement ce qu'archiver
-- veut dire.
--
-- CE QUE LA TABLE NE PORTE PAS, ET C'EST VOLONTAIRE : le THÈME. Les 4 modèles
-- Copper Kettle partagent le même en-tête (`pf_head`, identique octet pour octet)
-- mais ont QUATRE thèmes différents (`bodyBackground`, `contentBackground`) : un
-- partial qui transporterait le thème changerait la couleur de fond de quatre
-- newsletters de clubs différents en une seule application.

create table if not exists newsletter.brand_partial (
  id          uuid primary key default gen_random_uuid(),
  -- Même invariant de marque que `saved_row` et `template` : un partial appartient à
  -- UNE marque, et disparaît avec elle. Une bibliothèque partagée mélangerait des
  -- identités visuelles distinctes.
  asset_id    uuid not null references newsletter.asset(id) on delete cascade,
  -- Deux fentes, fermées. « header » se préfixe au document, « footer » s'insère
  -- JUSTE AVANT la row du pied légal — jamais à sa place, jamais après.
  slot        text not null check (slot in ('header','footer')),
  name        text not null,
  -- Un TABLEAU de Row du schéma EmailDoc, validé `z.array(Row)` à l'écriture par la
  -- route. Stocker une forme non conforme ferait échouer, bien plus tard et loin de
  -- sa cause, la compilation du modèle qui pointe dessus.
  -- « rows » est un unreserved_keyword Postgres : utilisable tel quel, cité partout
  -- pour qu'aucune relecture n'ait à se poser la question.
  "rows"      jsonb not null,
  -- On n'efface pas, on archive (même doctrine que `template` et `saved_row`) : un
  -- partial a pu partir dans des éditions déjà envoyées, et des modèles pointent
  -- peut-être encore dessus. Voir la note sur la résolution, plus bas.
  archived_at timestamptz,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ⛔ FILTRÉE sur `archived_at` — c'est LA différence avec `saved_row` (voir en-tête).
create unique index if not exists uq_brand_partial_nom
  on newsletter.brand_partial (asset_id, slot, name)
  where archived_at is null;

-- ⚠️ PAS d'index de lecture supplémentaire : l'unique ci-dessus est un index partiel
-- dont le préfixe est (asset_id, slot), c'est-à-dire EXACTEMENT l'accès de la
-- bibliothèque (« les partials vivants de cette marque, par fente »). Un second
-- index servirait les mêmes lignes deux fois.

-- ⚠️ La résolution d'un pointeur, elle, lit SANS filtrer `archived_at` : un modèle
-- qui pointe sur un partial archivé doit continuer de se compiler avec son en-tête.
-- Filtrer là aussi ferait disparaître l'en-tête de plusieurs modèles à la première
-- republication, sans qu'aucun écran ne l'ait annoncé. D'où l'accès par clé primaire,
-- que l'index primaire sert déjà.

-- RLS activée sans aucune policy, comme les autres tables du schéma : `newsletter`
-- est exposé via PostgREST, donc toute table y est joignable par `anon`. Seul le
-- service role (qui contourne la RLS) doit y accéder.
alter table newsletter.brand_partial enable row level security;
grant all on newsletter.brand_partial to service_role;

comment on table newsletter.brand_partial is
  'En-tête / pied éditorial partagé d''une marque. Le document ne stocke qu''un pointeur (doc.meta.headerPartialId / footerPartialId) ; les rows sont résolues à la COMPILATION. Ne porte jamais le thème, ni de bloc footer_legal.';

-- Assertion : l'unicité doit être PARTIELLE. C'est la propriété entière de cette
-- migration — un index non filtré rendrait le nom archivé réservé à vie, le défaut
-- de `saved_row` que ce fichier existe pour ne pas reproduire. Vérifiée sur le
-- catalogue, pas sur le texte du fichier.
do $$
declare
  v_predicat text;
begin
  select pg_get_expr(i.indpred, i.indrelid)
    into v_predicat
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
   where c.relname = 'uq_brand_partial_nom';

  if v_predicat is null then
    raise exception 'uq_brand_partial_nom : index absent ou NON filtre — un nom archive resterait reserve a vie';
  end if;
  if v_predicat not like '%archived_at%' then
    raise exception 'uq_brand_partial_nom : filtre sur %, "archived_at" attendu', v_predicat;
  end if;
end
$$;

notify pgrst, 'reload schema';

insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0064', '0064_brand_partial.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
