-- ---------------------------------------------------------------------------
-- 0051 — l'OPTIN : de quel formulaire vient ce contact, et quel tag lui donner.
-- ---------------------------------------------------------------------------
--
-- CE QU'ON AVAIT POUR RÉPONDRE À « d'où vient ce contact ? », et pourquoi ça ne suffisait pas :
--   • `subscription.source` est un ENUM FERMÉ (organic|social|crm_sync|import|content_upgrade) —
--     l'ingestion y écrit `content_upgrade` pour tout le monde ;
--   • `subscription.source_detail` est un jsonb LIBRE — rien n'y garantit une clé, rien ne s'y
--     requête proprement, et deux formulaires peuvent y écrire deux vocabulaires différents ;
--   • les `interests[]` deviennent des tags, mais ce sont des CENTRES D'INTÉRÊT cochés par la
--     personne, pas le formulaire qui l'a captée.
-- Aucun des trois ne permet de dire « les 340 contacts venus du guide en barre latérale de
-- Quartz Tips ». D'où une dimension de première classe, plutôt qu'un détournement de plus.
--
-- ⛔ L'OPTIN EST CRÉÉ AU VOL par l'ingestion. Exiger une création manuelle côté admin ferait
-- perdre, en silence, tous les contacts d'un formulaire neuf entre sa mise en ligne et le moment
-- où quelqu'un pense à le déclarer ici.
--
-- ⚠️ `slug` est la CLÉ STABLE, `name` le libellé. Renommer le formulaire côté optinforge doit
-- renommer la sous-liste ici sans casser le rattachement des contacts déjà arrivés.
--
-- ⚠️ `subscription.optin_id` est NULLABLE et le restera : les 1 203 souscriptions existantes
-- n'ont pas d'optin, et « sans optin » est une valeur légitime — pas une donnée manquante à
-- combler. C'est aussi pour ça que le compilateur de segments devra traiter le cas explicitement :
-- un `null` ne matche jamais un `IN`, et ces contacts disparaîtraient des comptes sans le dire.

create table if not exists newsletter.optin (
  id              uuid primary key default gen_random_uuid(),
  asset_id        uuid not null references newsletter.asset(id) on delete cascade,
  slug            text not null,
  name            text not null,
  -- Le tag posé automatiquement aux PROCHAINS contacts de cet optin. L'application rétroactive
  -- aux contacts déjà arrivés est un geste séparé, côté admin.
  default_tag_id  integer references newsletter.tag(id) on delete set null,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  archived_at     timestamptz,
  constraint optin_asset_slug_uk unique (asset_id, slug),
  -- Le slug voyage dans une URL et dans un filtre de segment : on le borne ici plutôt que de
  -- faire confiance à l'appelant.
  constraint optin_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

comment on table newsletter.optin is
  'Formulaire d''origine d''un contact (sous-liste par site). Cree au vol par /api/v1/signup.';
comment on column newsletter.optin.slug is
  'Cle stable, fournie par le systeme de capture. Le libelle peut changer, pas elle.';
comment on column newsletter.optin.default_tag_id is
  'Tag applique aux PROCHAINS contacts de cet optin. Le retroactif est un geste separe.';

alter table newsletter.subscription
  add column if not exists optin_id uuid references newsletter.optin(id) on delete set null;

comment on column newsletter.subscription.optin_id is
  'Formulaire d''origine. NULL = contact anterieur ou arrive sans optin — valeur legitime.';

create index if not exists subscription_optin_idx
  on newsletter.subscription (optin_id)
  where optin_id is not null;

-- Le comptage « combien de contacts par optin » est la question posée à chaque ouverture de
-- l'écran : on l'indexe par marque plutôt que de balayer la table.
create index if not exists optin_asset_idx on newsletter.optin (asset_id) where archived_at is null;

grant select, insert, update on newsletter.optin to service_role;

notify pgrst, 'reload schema';
