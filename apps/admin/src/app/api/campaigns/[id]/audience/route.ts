import { NextResponse } from "next/server";
import { estimateAudience, findCampaign, isCampaignPurpose } from "@/lib/data/campaigns";
import { jsonError, requireContext } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/campaigns/[id]/audience — combien d'abonnés cette campagne toucherait.
 *
 * ⛔ AUCUNE PII n'est renvoyée ni même lue : les requêtes de comptage sont en mode `head`
 * (PostgREST renvoie le total dans `Content-Range`, zéro ligne). Pas d'adresse, pas de nom, pas
 * d'identifiant d'abonné — un écran d'estimation n'a aucun besoin de savoir QUI.
 *
 * Deux chiffres, parce qu'ils ne disent pas la même chose :
 *  - `sendable` : qui matche le ciblage ET est envoyable (actif, hors liste de suppression) ;
 *  - `eligible` : le sous-ensemble ayant accordé la FINALITÉ de la campagne. C'est le seul chiffre
 *    qui prédit l'envoi, parce que `canSend()` rejette les autres, un par un, au moment du départ.
 *  L'écart entre les deux est exactement ce qu'un envoi « réussi » perdrait en silence.
 *
 * `?segmentId=` / `?purpose=` permettent de prévisualiser une audience AVANT de l'enregistrer sur
 * la campagne (l'assistant compte pendant qu'on choisit). Les deux restent scopés à la marque.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  const url = new URL(req.url);
  const segmentOverride = url.searchParams.get("segmentId");
  const purposeOverride = url.searchParams.get("purpose");

  /*
   * Trois cas, et non deux — c'est la chaîne VIDE qui porte l'information neuve :
   *   paramètre absent (`null`) → aucune consigne, on compte ce que la campagne vise en base ;
   *   paramètre vide (`""`)     → « aucun ciblage », demandé explicitement : toute la marque ;
   *   paramètre renseigné       → ce segment-là.
   * Confondre les deux premiers ferait répondre avec le segment enregistré à un écran qui vient de
   * choisir « pas de segment » : un compte juste pour une question qui n'a pas été posée.
   */
  const segmentId = segmentOverride === null ? campaign.segmentId : segmentOverride || null;
  let purpose: string | null = campaign.purpose;
  if (purposeOverride) {
    if (!isCampaignPurpose(purposeOverride)) return jsonError(`unknown purpose "${purposeOverride}"`, 400);
    purpose = purposeOverride;
  }
  // `?contactsIgnorePurpose=` : la case non encore enregistrée. Absent → la valeur en base ;
  // ⛔ toute autre valeur que "true"/"false" est refusée, jamais lue comme l'une des deux.
  const caseOverride = url.searchParams.get("contactsIgnorePurpose");
  if (caseOverride !== null && caseOverride !== "true" && caseOverride !== "false") {
    return jsonError(`contactsIgnorePurpose must be "true" or "false"`, 400);
  }
  const contactsIgnorePurpose = caseOverride === null ? campaign.contactsIgnorePurpose : caseOverride === "true";

  const audience = await estimateAudience(db, asset.id, segmentId, purpose, { contactsIgnorePurpose });

  return NextResponse.json({
    ...audience,
    // Un compte est une photo : sans horodatage, on ne sait pas si on regarde l'audience
    // d'aujourd'hui ou celle de l'onglet ouvert hier.
    countedAt: new Date().toISOString(),
  });
}
