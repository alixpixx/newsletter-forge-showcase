import { lireEnCours, lireReponse, type EnvoisEnCours, type StatsCampagnes } from "@/lib/campaign-stats";

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

export interface OptionsStats {
  /** Une seule campagne (page détail). */
  campaignId?: string;
  /** Dernier envoi à partir de cet instant (filtre de période). */
  since?: Date;
  /** Recherche littérale dans le nom. */
  search?: string;
  limit?: number;
  offset?: number;
  /** Rendre aussi les campagnes masquées des analytics (0093) — filtre « Show hidden ». */
  includeHidden?: boolean;
}

/**
 * Les campagnes de LA marque courante qui ont envoyé, avec leurs statistiques par envoi (0085).
 *
 * ⛔ `assetId` est celui de la session (`getCurrentAsset`), jamais un paramètre d'URL : la fonction
 * SQL filtre dessus, et c'est tout ce qui sépare une marque d'une autre ici.
 * ⛔ Une lecture ratée rend `known: false` avec sa raison — jamais une liste vide, qui se lirait
 * « aucune campagne n'a envoyé ».
 */
export async function lireStatsCampagnes(
  db: Rpc | null,
  assetId: string | null,
  opts: OptionsStats = {},
): Promise<StatsCampagnes> {
  if (!db) return { known: false, reason: "the database is not configured" };
  if (!assetId) return { known: false, reason: "no brand selected" };
  const args = {
    p_asset_id: assetId,
    p_campaign_id: opts.campaignId ?? null,
    p_since: opts.since ? opts.since.toISOString() : null,
    p_search: opts.search?.trim() ? opts.search.trim() : null,
    p_limit: opts.limit ?? 5,
    p_offset: opts.offset ?? 0,
  };
  // Sans « Show hidden », la signature à 6 arguments : celle d'avant 0093, qui exclut les masquées
  // depuis 0093. Avec, la surcharge à 7 ; une base d'avant 0093 ne la connaît pas et n'a rien masqué :
  // on retombe sur la signature à 6, qui rend alors bien tout.
  let { data, error } = await db.rpc("campaign_send_stats", opts.includeHidden ? { ...args, p_include_hidden: true } : args);
  if (error && opts.includeHidden && /p_include_hidden|could not find the function|schema cache/i.test(error.message)) {
    ({ data, error } = await db.rpc("campaign_send_stats", args));
  }
  if (error) {
    const absente = /campaign_send_stats|could not find the function|schema cache/i.test(error.message);
    return { known: false, reason: absente ? "migration 0085 has not been applied" : error.message };
  }
  const lu = lireReponse(data);
  return lu ? { known: true, ...lu } : { known: false, reason: "the database answered in an unexpected shape" };
}

/**
 * Les envois EN COURS de LA marque courante (0096) — l'encart « Sending now » d'Analytics.
 *
 * ⛔ Même discipline que `lireStatsCampagnes` : la marque vient de la session, et une lecture ratée rend
 * `known: false` avec sa raison — jamais une liste vide, qui se lirait « rien ne part ».
 */
export async function lireEnvoisEnCours(db: Rpc | null, assetId: string | null): Promise<EnvoisEnCours> {
  if (!db) return { known: false, reason: "the database is not configured" };
  if (!assetId) return { known: false, reason: "no brand selected" };
  const { data, error } = await db.rpc("campaign_send_progress", { p_asset_id: assetId });
  if (error) {
    const absente = /campaign_send_progress|could not find the function|schema cache/i.test(error.message);
    return { known: false, reason: absente ? "migration 0096 has not been applied" : error.message };
  }
  const lu = lireEnCours(data);
  return lu ? { known: true, ...lu } : { known: false, reason: "the database answered in an unexpected shape" };
}
