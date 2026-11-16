import {
  lireActiviteAbonne,
  lireAudience,
  lireEngagementCampagne,
  lireResultatsAutomations,
  type ActiviteAbonne,
  type Audience,
  type EngagementCampagne,
  type Lecture,
  type ResultatsAutomation,
} from "@/lib/engagement";

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

/**
 * Les quatre lectures d'analytics du comportement (0094), pour LA marque de la session.
 *
 * ⛔ `assetId` vient de `getCurrentAsset()`, jamais de l'URL : chaque fonction SQL filtre dessus, et
 * c'est tout ce qui sépare une marque d'une autre ici.
 * ⛔ Une lecture ratée rend `known: false` avec sa raison — jamais des zéros.
 */
async function lire<T>(
  db: Rpc | null,
  assetId: string | null,
  fn: string,
  args: Record<string, unknown>,
  lecteur: (data: unknown) => T | null,
): Promise<Lecture<T>> {
  if (!db) return { known: false, reason: "the database is not configured" };
  if (!assetId) return { known: false, reason: "no brand selected" };
  const { data, error } = await db.rpc(fn, { p_asset_id: assetId, ...args });
  if (error) {
    const absente = new RegExp(`${fn}|could not find the function|schema cache`, "i").test(error.message);
    return { known: false, reason: absente ? "migration 0094 has not been applied" : error.message };
  }
  const lu = lecteur(data);
  return lu === null ? { known: false, reason: "the database answered in an unexpected shape" } : { known: true, value: lu };
}

/** Engagement d'une campagne : toutes ses éditions, ou une seule (`occurrenceId`). */
export function lireEngagementDeCampagne(
  db: Rpc | null,
  assetId: string | null,
  campaignId: string,
  occurrenceId?: string | null,
): Promise<Lecture<EngagementCampagne>> {
  return lire(db, assetId, "campaign_engagement",
    { p_campaign_id: campaignId, p_occurrence_id: occurrenceId ?? null }, lireEngagementCampagne);
}

/** Résultats des automations de la marque (une seule si `automationId`), envois depuis `since`. */
export function lireResultatsDesAutomations(
  db: Rpc | null,
  assetId: string | null,
  opts: { automationId?: string; since?: Date } = {},
): Promise<Lecture<ResultatsAutomation[]>> {
  return lire(db, assetId, "automation_send_stats",
    { p_automation_id: opts.automationId ?? null, p_since: opts.since ? opts.since.toISOString() : null },
    lireResultatsAutomations);
}

/** Audience de la marque ; `since` absent = 26 dernières semaines (côté SQL). */
export function lireAudienceDeMarque(
  db: Rpc | null,
  assetId: string | null,
  since?: Date,
): Promise<Lecture<Audience>> {
  return lire(db, assetId, "audience_engagement", { p_since: since ? since.toISOString() : null }, lireAudience);
}

/** Les messages d'un abonné SUR LA MARQUE COURANTE, chacun avec ses événements. */
export function lireActiviteDAbonne(
  db: Rpc | null,
  assetId: string | null,
  subscriberId: string,
  limit = 100,
): Promise<Lecture<ActiviteAbonne>> {
  return lire(db, assetId, "subscriber_activity", { p_subscriber_id: subscriberId, p_limit: limit }, lireActiviteAbonne);
}
