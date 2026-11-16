import { requireContext } from "@/app/api/builder/_shared";
import { patchRecurrence } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/campaigns/[id]/recurrence — le contrat (enregistrer n'est pas armer) est dans `handler.ts`. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return patchRecurrence(req, ctx, {
    requireContext,
    today: () => new Date().toISOString().slice(0, 10),
  });
}
