import { NextResponse } from "next/server";
import { findCampaign, type CampaignRow } from "@/lib/data/campaigns";
import { jsonError, readJson, type Context, type requireContext } from "@/app/api/builder/_shared";

/**
 * MASQUER / RÉAFFICHER UNE CAMPAGNE DANS LES ANALYTICS — `POST /analytics-visibility` (0093).
 *
 * ⭐ LA DEMANDE (Alix, 07/10/2026) : « Add possibility to hide campaigns in analytics ». Un test, un
 * envoi bloqué chez le fournisseur… faussent les moyennes sans rien dire du public. Masquer ne touche
 * NI l'envoi, NI les événements, NI les compteurs : la campagne sort seulement des LISTES d'analytics
 * (`campaign_send_stats` à 6 arguments). Sa fiche d'analytics et son export restent servis.
 *
 * Corps : `{ "hidden": true | false }`. Réponse : `{ ok, hidden, changed, audited }`.
 *  - ⛔ SCOPÉ MARQUE : une campagne d'une autre marque rend 404, indiscernable d'une absente.
 *  - IDEMPOTENT : redemander l'état déjà en place rend 200 `changed: false`, sans écriture ni trace.
 *  - 0093 absente : 503 qui nomme la migration, pas un 500 opaque.
 *
 * ⚠️ `updated_at` N'EST PAS TOUCHÉ : masquer est un réglage d'affichage des analytics, pas une
 * modification de la campagne — la date de dernière modification ne doit pas bouger pour ça.
 *
 * Module séparé du `route.ts` (qui ne peut exporter que ses méthodes HTTP) : la session et l'horloge
 * sont injectées, pour qu'un banc mesure la route sans cookie, sans base et sans heure qui tourne.
 */

export interface VisibiliteDeps {
  requireContext: () => ReturnType<typeof requireContext>;
  maintenant: () => Date;
}

type Db = Context["db"];

/** Message dédié quand 0093 n'est pas encore appliquée (colonne inconnue de PostgREST). */
export function migrationMasquage(raw: string): string | null {
  return /analytics_hidden_at/i.test(raw) && /schema cache|does not exist/i.test(raw)
    ? "hiding campaigns from analytics is not installed yet — migration 0093 has not been applied"
    : null;
}

/**
 * La trace du geste — même forme que l'archivage. ⛔ AUCUNE donnée d'abonné dans `meta`.
 * ⚠️ Un audit raté ne défait PAS le geste : la campagne EST masquée, le dire autrement mentirait. La
 * réponse porte `audited: false`.
 */
async function journaliser(
  db: Db,
  ctx: Context,
  action: "campaign.analytics_hidden" | "campaign.analytics_shown",
  campaign: CampaignRow,
  meta: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await db.from("audit_log").insert({
    actor: `admin:${ctx.user.email}`,
    action,
    target_type: "campaign",
    target_id: campaign.id,
    asset_id: ctx.asset.id,
    meta: { ...meta, campaign_name: campaign.name },
  });
  if (error) console.error(JSON.stringify({ event: `${action}-audit-failed`, message: error.message }));
  return !error;
}

export async function postVisibilite(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: VisibiliteDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  // ⛔ Un booléen, rien d'autre : `"false"` ou `0` ne doivent pas se lire « masquer ».
  const corps = await readJson<Record<string, unknown>>(req);
  if (!corps || typeof corps !== "object" || typeof corps.hidden !== "boolean") {
    return jsonError('the body must be { "hidden": true } or { "hidden": false }', 400);
  }
  const hidden = corps.hidden;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  // L'état actuel, lu à part : `CAMPAIGN_SELECT` ne porte pas la colonne, pour que TOUTES les lectures
  // de campagne de l'admin survivent à une base d'avant 0093.
  const { data: etat, error: lectureErr } = await db
    .from("campaign")
    .select("analytics_hidden_at")
    .eq("id", id)
    .eq("asset_id", asset.id)
    .maybeSingle();
  if (lectureErr) {
    const friendly = migrationMasquage(lectureErr.message);
    return jsonError(friendly ?? `the campaign could not be read: ${lectureErr.message}`, friendly ? 503 : 500);
  }
  if (!etat) return jsonError("campaign not found", 404);
  const avant = ((etat as { analytics_hidden_at?: string | null }).analytics_hidden_at ?? null) as string | null;

  // Déjà dans l'état demandé (deux onglets, double clic) : rien à écrire, rien à tracer.
  if ((avant !== null) === hidden) {
    return NextResponse.json({ ok: true, hidden, changed: false, audited: null });
  }

  /*
   * ⚠️ RELUE (`.select("id")`) : un UPDATE qui ne touche aucune ligne RÉUSSIT en silence. Zéro ligne =
   * la campagne a disparu entre la lecture et l'écriture, ou n'est pas de cette marque ⇒ 404.
   */
  const maintenant = deps.maintenant().toISOString();
  const { data: ecrite, error: writeErr } = await db
    .from("campaign")
    .update({ analytics_hidden_at: hidden ? maintenant : null })
    .eq("id", id)
    .eq("asset_id", asset.id)
    .select("id");
  if (writeErr) {
    const friendly = migrationMasquage(writeErr.message);
    return jsonError(
      friendly ?? `the campaign could not be ${hidden ? "hidden" : "shown again"}: ${writeErr.message}`,
      friendly ? 503 : 500,
    );
  }
  if (!ecrite || (ecrite as unknown[]).length === 0) return jsonError("campaign not found", 404);

  const audited = await journaliser(
    db,
    c.ctx,
    hidden ? "campaign.analytics_hidden" : "campaign.analytics_shown",
    campaign,
    { hidden_at: hidden ? maintenant : null, previous_hidden_at: avant },
  );

  return NextResponse.json({ ok: true, hidden, changed: true, audited });
}
