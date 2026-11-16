import { createClient } from "@supabase/supabase-js";

/**
 * Client Supabase SERVER-ONLY sur le schéma `newsletter`.
 * Utilise la clé service_role → bypass la RLS. À n'importer QUE dans du code serveur,
 * jamais dans un client component.
 *
 * Convention : service_role + client JS (PostgREST), pas de connexion Postgres directe. Renvoie null si les env manquent → l'app retombe
 * proprement sur le registre @nf/config.
 */
export function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createClient<any, "newsletter">(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "newsletter" },
  });
}
