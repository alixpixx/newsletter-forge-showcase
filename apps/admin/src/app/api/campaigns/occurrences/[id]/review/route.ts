import { requireContext } from "@/app/api/builder/_shared";
import { getReview, postReview } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/campaigns/occurrences/[id]/review — l'état de relecture d'une édition (base, écart, attente).
 * POST /api/campaigns/occurrences/[id]/review — enregistre un écart `{ overrides, rev }` (0079).
 *
 * Le contrat est dans `handler.ts` : la route n'écrit que l'écart, le worker reconstruit l'édition.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return getReview(req, ctx, { requireContext, maintenant: () => new Date() });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return postReview(req, ctx, { requireContext, maintenant: () => new Date() });
}
