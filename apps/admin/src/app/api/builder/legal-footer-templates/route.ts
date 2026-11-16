import { requireContext } from "../_shared";
import { createLegalFooter, listLegalFooters } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — les pieds légaux vivants de la marque (503 plutôt qu'une liste vide). Détail dans `handler.ts`. */
export async function GET() {
  return listLegalFooters(requireContext);
}

/** POST — crée un pied légal, refusé s'il est incomplet pour une édition de la marque. */
export async function POST(req: Request) {
  return createLegalFooter(req, requireContext);
}
