import { requireContext } from "@/app/api/builder/_shared";
import { postSegmentMembers } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/segments/[id]/members — le contrat (même ciblage que l'envoi, refus si élargi) est dans `handler.ts`. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return postSegmentMembers(req, ctx, { requireContext });
}
