import { requireContext } from "@/app/api/builder/_shared";
import { findPublishedVersionRef } from "@/lib/data/campaigns";
import { postStatus } from "../../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/automations/[id]/status — `{ to, confirmName? }`. Simuler, armer (super_admin, nom tapé,
 * ligne `audit_log` AVANT l'armement), mettre en pause, reprendre, revenir au brouillon. Le contrat
 * est dans `../../handler.ts`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return postStatus(req, ctx, { requireContext, versionPubliee: findPublishedVersionRef, maintenant: () => new Date() });
}
