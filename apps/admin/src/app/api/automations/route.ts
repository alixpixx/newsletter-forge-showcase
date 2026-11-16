import { requireContext } from "@/app/api/builder/_shared";
import { findPublishedVersionRef } from "@/lib/data/campaigns";
import { postCreate } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/automations — crée une automation sur mesure de la marque courante, TOUJOURS `draft`.
 * Le contrat est dans `handler.ts`.
 */
export async function POST(req: Request) {
  return postCreate(req, { requireContext, versionPubliee: findPublishedVersionRef, maintenant: () => new Date() });
}
