import { requireContext } from "@/app/api/builder/_shared";
import { postArchive } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/[id]/archive — range la campagne dans l'onglet Archived ET la met hors d'état
 * d'envoyer (série arrêtée + éditions à venir annulées, ou envoi unique retiré du calendrier).
 *
 * Le contrat est dans `handler.ts`. L'aperçu des dates annulées, lui, est celui de `GET /arm` : la
 * confirmation les lit là, avec la même requête que l'annulation.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return postArchive(req, ctx, { requireContext, maintenant: () => new Date() });
}
