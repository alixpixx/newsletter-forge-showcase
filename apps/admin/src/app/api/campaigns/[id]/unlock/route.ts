import { NextResponse } from "next/server";
import { findCampaign, updateCampaign } from "@/lib/data/campaigns";
import { jsonError, requireContext } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/[id]/unlock — rend un brouillon à l'édition.
 *
 * ⛔ POURQUOI CETTE ROUTE EXISTE. Elle était PROMISE et n'existait pas. La page de campagne
 * conseillait « Unlocking and locking again re-runs the generation », et trois refus de l'API
 * renvoyaient vers une duplication de campagne qui n'existe pas davantage. Vu de l'utilisateur, un
 * verrou posé par erreur était définitif : la seule sortie réelle était d'annuler la campagne, de
 * la supprimer, et de tout ressaisir. Un écran qui nomme une issue inexistante est pire qu'un écran
 * muet — il fait chercher une porte dans un mur.
 *
 * ⛔ CE QU'ON DÉTRUIT, ET CE QU'ON NE DÉTRUIT PAS. On efface exactement ce que `/lock` avait écrit :
 * le rendu figé (`html_shell`, `text_shell`, `size_bytes`), sa date (`locked_at`) et le texte que
 * le modèle avait rédigé pour CE verrou (`ai_*`). On ne touche ni au sujet, ni à l'accroche, ni à
 * la version choisie : `/lock` ne les avait écrits que s'ils étaient vides, et les remettre à zéro
 * ferait perdre à l'utilisateur ce qu'il vient de relire.
 *
 * ⛔ SEUL UN BROUILLON SE DÉVERROUILLE. `scheduled` a une date promise, `sending` est en cours,
 * `sent` est ce que des abonnés ont reçu : dans les trois cas, le rendu figé est la SEULE trace de
 * ce qui part ou de ce qui est parti. Le geste de sortie d'une campagne programmée est
 * `/unschedule`, qui la ramène en `draft` — et rend alors ce déverrouillage possible.
 *
 * ⚠️ `paused` est accepté : c'est l'état d'une campagne que le worker a écartée (fan-out) ou qui
 * n'a rien envoyé. Elle est re-planifiable, donc elle doit être ré-éditable — sinon on ferme la
 * seule issue de la campagne la plus abîmée.
 */

/** Les statuts où le contenu figé n'engage encore personne. */
const DEVERROUILLABLE = new Set(["draft", "paused"]);

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  if (!campaign.lockedAt) {
    return jsonError("this campaign is not locked — its content is already editable", 409, {
      status: campaign.status,
    });
  }

  // Chaque refus NOMME le geste qui débloque : « impossible » oblige à deviner, et c'est ce qui a
  // fait exister le conseil mensonger que cette route remplace.
  if (!DEVERROUILLABLE.has(campaign.status)) {
    const raison =
      campaign.status === "scheduled"
        ? "this campaign is scheduled — unschedule it first, then the content can be unlocked"
        : campaign.status === "sending"
          ? "this campaign is sending right now — its frozen content is what recipients are receiving"
          : campaign.status === "sent"
            ? "this campaign was sent — its frozen content is the record of what subscribers received"
            : `a ${campaign.status} campaign cannot be unlocked`;
    return jsonError(raison, 409, { status: campaign.status });
  }

  const { error } = await updateCampaign(db, id, asset.id, {
    locked_at: null,
    html_shell: null,
    text_shell: null,
    size_bytes: null,
    // Le texte écrit par le modèle appartenait à CE verrou : il sera régénéré au suivant, sur le
    // contenu du moment. Le garder ferait afficher une introduction qui ne décrit plus rien.
    ai_status: null,
    ai_reason: null,
    ai_intro: null,
    ai_preheader: null,
    ai_model: null,
    ai_generated_at: null,
  });
  if (error) return jsonError(error, 500);

  /*
   * ⛔ RELECTURE. `updateCampaign` ne demande pas son résultat à PostgREST : un UPDATE qui ne touche
   * aucune ligne rend `error: null`, exactement comme un succès. Annoncer « déverrouillé » à tort
   * ferait rouvrir un formulaire dont chaque enregistrement serait ensuite refusé en 409, sans que
   * rien à l'écran n'explique pourquoi.
   */
  const relu = await findCampaign(db, id, asset.id);
  if (relu?.lockedAt) {
    return jsonError("the campaign could not be unlocked — nothing was written", 500);
  }

  return NextResponse.json({ campaign: relu, locked: false });
}
