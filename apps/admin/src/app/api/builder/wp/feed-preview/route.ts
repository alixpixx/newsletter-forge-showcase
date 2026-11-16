import { requireContext } from "../../_shared";
import { feedPreview } from "./handler";

export const runtime = "nodejs";
// Le seul intérêt de cet écran est de montrer ce que la règle rend MAINTENANT. Un cache le ferait
// mentir, et un aperçu qui ment est exactement le défaut que le bloc flux existe pour tuer.
export const dynamic = "force-dynamic";

/** POST /api/builder/wp/feed-preview — voir `handler.ts`. */
export async function POST(req: Request) {
  return feedPreview(req, requireContext);
}
