import { requireContext } from "@/app/api/builder/_shared";
import { postReviewPreview } from "../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/occurrences/[id]/review/preview — l'e-mail RECOMPILÉ d'une édition relue.
 *
 * ⚠️ AUCUNE ÉCRITURE. Corps vide : l'écart enregistré ; `{ overrides }` : le brouillon de l'écran.
 * Même fonction que le worker (`finaliserEdition`), même base : ce qui s'affiche est ce qui partira.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return postReviewPreview(req, ctx, { requireContext, maintenant: () => new Date() });
}
