import { requireContext } from "@/app/api/builder/_shared";
import { postVisibilite } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/[id]/analytics-visibility — `{ "hidden": true | false }` : sort la campagne des
 * listes d'analytics, ou l'y remet (0093). Rien d'autre ne bouge. Le contrat est dans `handler.ts`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return postVisibilite(req, ctx, { requireContext, maintenant: () => new Date() });
}
