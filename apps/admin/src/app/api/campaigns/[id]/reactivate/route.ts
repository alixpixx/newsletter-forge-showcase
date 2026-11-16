import { estimateAudience, findPublishedVersionRef } from "@/lib/data/campaigns";
import { requireContext } from "@/app/api/builder/_shared";
import { getReactivate, postReactivate, type ReactivateDeps } from "../archive/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deps: ReactivateDeps = {
  requireContext,
  maintenant: () => new Date(),
  versionPubliee: findPublishedVersionRef,
  estimerAudience: estimateAudience,
};

/** GET /api/campaigns/[id]/reactivate — ce que la réactivation va rétablir, lu AVANT le clic. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return getReactivate(req, ctx, deps);
}

/**
 * POST /api/campaigns/[id]/reactivate — sort la campagne des archives, puis rétablit ce qui tournait
 * PAR `/arm` ou `/schedule` (leurs refus s'appliquent tous). Contrat dans `../archive/handler.ts`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return postReactivate(req, ctx, deps);
}
