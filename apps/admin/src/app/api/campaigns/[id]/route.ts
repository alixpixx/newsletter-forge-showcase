import { NextResponse } from "next/server";
import { findCampaign, findPublishedVersionRef } from "@/lib/data/campaigns";
import { jsonError, requireContext } from "@/app/api/builder/_shared";
import { patchCampaign } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/campaigns/[id] — hors marque courante ou inexistante → 404 (aucun oracle d'existence). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const { id } = await params;
  const campaign = await findCampaign(c.ctx.db, id, c.ctx.asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  return NextResponse.json({ campaign });
}

/**
 * PATCH /api/campaigns/[id] — modifie une campagne encore modifiable. Le contrat (barrières de
 * statut et de verrou, et le REPOINTAGE des éditions à venir quand la version change) est dans
 * `handler.ts`, testé.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return patchCampaign(req, ctx, {
    requireContext,
    versionPubliee: findPublishedVersionRef,
    maintenant: () => new Date(),
  });
}

/**
 * DELETE /api/campaigns/[id] — supprime une campagne qui n'a jamais rien envoyé.
 *
 * Une campagne `sent` (ou en cours) est la TRACE de ce que les abonnés ont reçu : la détruire
 * effacerait la réponse à « qu'avons-nous envoyé, exactement ? », qui est justement ce qu'un
 * régulateur demande. Une campagne `scheduled` est un engagement pris : on annule, puis on
 * supprime — deux gestes, deux intentions.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  if (campaign.status !== "draft" && campaign.status !== "cancelled") {
    return jsonError(
      campaign.status === "scheduled"
        ? "campaign is scheduled — cancel it before deleting"
        : `a ${campaign.status} campaign cannot be deleted — it is the record of what was sent`,
      409,
      { status: campaign.status },
    );
  }

  const { error } = await db.from("campaign").delete().eq("id", id).eq("asset_id", asset.id);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ id, deleted: true });
}
