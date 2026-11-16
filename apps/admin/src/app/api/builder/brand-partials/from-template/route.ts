import { requireContext } from "../../_shared";
import { liftFromTemplate } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST — lève l'en-tête ou le pied d'un modèle vers la bibliothèque (jamais un bloc). Détail dans `handler.ts`. */
export async function POST(req: Request) {
  return liftFromTemplate(req, requireContext);
}
