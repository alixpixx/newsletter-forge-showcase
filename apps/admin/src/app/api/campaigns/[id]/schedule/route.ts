import { estimateAudience } from "@/lib/data/campaigns";
import { requireContext } from "@/app/api/builder/_shared";
import { postSchedule } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/[id]/schedule — engage la campagne pour une date.
 *
 * Le contrat (les cinq exigences, l'envoi immédiat, le refus d'une série et d'une archivée) est dans
 * `handler.ts` : la réactivation d'un envoi archivé passe par la MÊME fonction, jamais à côté.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return postSchedule(req, ctx, {
    requireContext,
    estimerAudience: estimateAudience,
    maintenant: () => Date.now(),
  });
}
