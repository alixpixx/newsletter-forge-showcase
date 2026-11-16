import { getDb } from "@/lib/supabase";
import { ASSETS as CONFIG_ASSETS } from "@nf/config";

export interface AssetRow {
  slug: string;
  name: string;
  market: string | null;
  languages: string[];
}

/**
 * Liste des marques. Lit la vraie base (`newsletter.asset` via service_role) si les
 * env Supabase sont configurés, sinon retombe sur le registre @nf/config.
 * `source` indique l'origine (affiché dans l'UI : badge Base / Config).
 */
export async function getAssets(): Promise<{ rows: AssetRow[]; source: "db" | "config" }> {
  const db = getDb();
  if (db) {
    const { data, error } = await db
      .from("asset")
      .select("slug, name, market, languages")
      .order("created_at");
    if (!error && data) {
      return { rows: data as AssetRow[], source: "db" };
    }
  }
  return {
    rows: CONFIG_ASSETS.map((a) => ({
      slug: a.slug,
      name: a.name,
      market: a.markets[0] ?? null,
      languages: a.languages,
    })),
    source: "config",
  };
}
