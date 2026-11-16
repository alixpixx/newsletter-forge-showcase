import { NextResponse } from "next/server";
import { findCampaign, updateCampaign } from "@/lib/data/campaigns";
import { jsonError, requireContext } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/[id]/unschedule — retire une campagne du calendrier sans rien détruire.
 *
 * POURQUOI CETTE ROUTE EXISTE. `SCHEDULABLE` ne contient que `draft` et `paused`, et jusqu'ici
 * AUCUN chemin ne ramenait une campagne en `draft`. Décaler un envoi d'une heure imposait donc de
 * l'annuler puis de la recréer : nouvel id, nouveau verrou, historique coupé en deux. Le message
 * d'erreur de `/schedule` promettait pourtant l'inverse — « cancel it before rescheduling » — en
 * envoyant l'utilisateur vers une annulation dont on ne revient pas.
 *
 * C'est aussi le préalable du chantier récurrence : une occurrence de série qu'on décale doit
 * rester LA MÊME ligne, sinon son empreinte de contenu et sa clé d'idempotence sont perdues, et
 * l'occurrence peut repartir deux fois.
 *
 * CE QU'ON NE FAIT PAS : déverrouiller. `locked_at`, `html_shell`, `text_shell` et `size_bytes`
 * sont conservés intacts. Déplanifier, c'est changer d'avis sur le QUAND ; le contenu gelé reste
 * gelé, et c'est exactement la garantie que `/lock` existe pour donner — republier le modèle
 * entre-temps ne doit pas réécrire ce qui a été approuvé.
 *
 * `recipients_planned` est en revanche remis à `null` : il avait été figé au moment de la
 * planification et ne décrit plus aucun envoi prévu. Le laisser afficherait, sur un brouillon, une
 * audience qui n'est plus promise à personne — et `/schedule` le recalcule de toute façon.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  // Seul `scheduled` a un calendrier à quitter. On nomme le statut réel dans chaque refus :
  // « impossible » sans raison oblige l'utilisateur à deviner ce qu'il doit faire ensuite.
  if (campaign.status !== "scheduled") {
    const raison =
      campaign.status === "draft"
        ? "campaign is already a draft — nothing to unschedule"
        : campaign.status === "sending"
          ? "a campaign that is currently sending cannot be unscheduled — stop the send first"
          : campaign.status === "sent"
            ? "a sent campaign cannot be unscheduled — it is already in subscribers' inboxes"
            : `a ${campaign.status} campaign has no schedule to leave`;
    return jsonError(raison, 409, { status: campaign.status });
  }

  const { error } = await updateCampaign(db, id, asset.id, {
    status: "draft",
    scheduled_at: null,
    recipients_planned: null,
  });
  if (error) return jsonError(error, 500);

  const unscheduled = await findCampaign(db, id, asset.id);
  return NextResponse.json({
    campaign: unscheduled,
    // Le client doit pouvoir dire à l'utilisateur ce qui a survécu, sans relire le verrou lui-même.
    contentStillLocked: Boolean(unscheduled?.lockedAt ?? campaign.lockedAt),
  });
}
