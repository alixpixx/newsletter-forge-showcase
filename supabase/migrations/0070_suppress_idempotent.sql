-- ---------------------------------------------------------------------------
-- 0070 — `suppress()` devient idempotente.
-- ---------------------------------------------------------------------------
--
-- LE DÉFAUT. 0008 insérait sans `ON CONFLICT`. Mesuré le 16/09/2026 dans un bloc annulé :
--   — un 2e rebond dur pour la même adresse et la même marque lève 23505 (unique email_hash, asset_id) ;
--     le webhook répond alors 500, et Mailgun rejoue l'événement pendant huit heures ;
--   — deux plaintes identiques créent DEUX lignes globales : `asset_id` y est NULL, et deux NULL ne
--     se heurtent jamais dans un index unique.
-- Le webhook ne pouvait donc pas rejouer la suppression sur un événement déjà enregistré — et il
-- répondait 200 avant d'y arriver : un échec passager de la suppression n'était jamais rattrapé.
--
-- LA RÈGLE, SANS RIEN EFFACER.
--   — portée marque : `on conflict do nothing`, la première raison reste ;
--   — portée globale : pas de nouvelle ligne si la MÊME raison existe déjà pour cette adresse.
--     Une raison DIFFÉRENTE (un effacement après une désinscription globale) reste écrite : c'est une
--     trace distincte, pas un doublon.
--
-- ⛔ PAS D'INDEX UNIQUE GLOBAL : la table contient déjà plusieurs lignes globales pour une même
-- adresse (raisons différentes). Les fondre supprimerait une trace de conformité. Deux appels
-- STRICTEMENT simultanés peuvent encore écrire deux lignes globales identiques : sans effet sur
-- `is_suppressed`, qui ne teste qu'une existence.
--
-- Signature, `security definer`, `search_path` et droits inchangés (`create or replace` les garde).

create or replace function newsletter.suppress(p_email text, p_asset_id uuid, p_reason text, p_scope text default 'asset')
returns void
language sql security definer set search_path = newsletter, extensions
as $$
  insert into newsletter.suppression (email_hash, email, scope, asset_id, reason)
  select
    digest(lower(p_email), 'sha256'),
    lower(p_email)::extensions.citext,
    p_scope,
    case when p_scope = 'global' then null else p_asset_id end,
    p_reason
  where p_scope is distinct from 'global'
     or not exists (
       select 1
       from newsletter.suppression s
       where s.scope = 'global'
         and s.email_hash = digest(lower(p_email), 'sha256')
         and s.reason is not distinct from p_reason
     )
  on conflict (email_hash, asset_id) do nothing;
$$;

comment on function newsletter.suppress(text, uuid, text, text) is
  'Ajoute une adresse à la liste de suppression, idempotente (0070) : portée marque = on conflict do nothing ; portée globale = pas de doublon de même raison.';

insert into newsletter.applied_migration (version, filename, applied_at, backfilled)
values ('0070', '0070_suppress_idempotent.sql', now(), false)
on conflict (version) do update
   set applied_at = excluded.applied_at,
       backfilled = false;
