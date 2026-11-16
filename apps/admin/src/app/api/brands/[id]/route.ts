import { requireContext } from "@/app/api/builder/_shared";
import { modifierMarque } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Réglages d'une marque — réservés au super_admin. Toute la décision (garde de rôle comprise) vit dans
 * `handler.ts`, éprouvé sans base par `handler.test.ts`.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return modifierMarque(req, id, requireContext);
}
