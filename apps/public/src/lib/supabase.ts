import { createClient } from "@supabase/supabase-js";

/**
 * Client Supabase SERVER-ONLY sur le schéma `newsletter` (service_role → bypass RLS).
 * Même projet/clé que l'admin. À n'importer que côté serveur.
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

export type Db = NonNullable<ReturnType<typeof getDb>>;
