import { requireContext } from "../_shared";
import { createPartial, listPartials } from "./handler";

export const runtime = "nodejs";
// La bibliothèque change à chaque enregistrement : jamais de cache de route.
export const dynamic = "force-dynamic";

/** GET — en-têtes, pieds et blocs vivants de la marque (503 plutôt qu'une liste vide). Détail dans `handler.ts`. */
export async function GET() {
  return listPartials(requireContext);
}

/** POST — crée un en-tête, un pied ou un bloc ; rows validées côté serveur, pied légal refusé. */
export async function POST(req: Request) {
  return createPartial(req, requireContext);
}
