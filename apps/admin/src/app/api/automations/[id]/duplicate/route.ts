import { requireContext } from "@/app/api/builder/_shared";
import { findPublishedVersionRef } from "@/lib/data/campaigns";
import { postDuplicate } from "../../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/automations/[id]/duplicate → 201 `{ id }` : une copie `draft` (« Copy of … »), sans
 * historique, revalidée comme une création. Le contrat est dans `../../handler.ts`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return postDuplicate(req, ctx, { requireContext, versionPubliee: findPublishedVersionRef, maintenant: () => new Date() });
}
