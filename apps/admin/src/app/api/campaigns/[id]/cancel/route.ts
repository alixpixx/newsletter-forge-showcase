import { NextResponse } from "next/server";
import { CANCELLABLE, findCampaign, updateCampaign } from "@/lib/data/campaigns";
import { jsonError, requireContext } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/[id]/cancel — renonce à un envoi qui n'a pas eu lieu.
 *
 * `draft` / `scheduled` / `paused` sont annulables : rien n'est parti, l'annulation est un simple
 * changement d'avis. `sending` ne l'est pas ici — arrêter un envoi en cours est une opération du
 * worker (dépiler `email_outbox`), pas un changement de statut, et prétendre l'avoir fait serait
 * mentir. `sent` ne l'est pas non plus : l'email est déjà chez les abonnés, aucun bouton ne le
 * rattrape.
 *
 * `scheduled_at` est CONSERVÉ : c'est la trace de ce qui avait été prévu. L'index partiel
 * `idx_campaign_due` ne retient que `status = 'scheduled'`, la campagne annulée en sort d'elle-même.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  if (campaign.status === "cancelled") {
    return jsonError("campaign is already cancelled", 409, { status: campaign.status });
  }
  if (!(CANCELLABLE as readonly string[]).includes(campaign.status)) {
    return jsonError(
      campaign.status === "sent"
        ? "a sent campaign cannot be cancelled — it is already in subscribers' inboxes"
        : "a campaign that is currently sending cannot be cancelled from here",
      409,
      { status: campaign.status },
    );
  }

  const { error } = await updateCampaign(db, id, asset.id, { status: "cancelled" });
  if (error) return jsonError(error, 500);

  const cancelled = await findCampaign(db, id, asset.id);
  return NextResponse.json({ campaign: cancelled });
}
