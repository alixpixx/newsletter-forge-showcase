import { requireContext } from "../_shared";
import { canvasRenderHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/builder/canvas-render — voir `handler.ts`. */
export async function POST(req: Request) {
  return canvasRenderHandler(req, requireContext);
}
