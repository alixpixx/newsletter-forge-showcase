import { requireContext } from "../_shared";
import { legalFooterPreview } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/builder/legal-footer-preview — voir `handler.ts`. */
export async function GET(req: Request) {
  return legalFooterPreview(new URL(req.url), requireContext);
}
