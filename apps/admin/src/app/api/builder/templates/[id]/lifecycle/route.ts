import { requireContext, requireTemplateAccess } from "../../../_shared";
import { putLifecycle } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/builder/templates/[id]/lifecycle — le contrat (on juge la version PUBLIÉE) est dans `handler.ts`. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return putLifecycle(req, ctx, { requireContext, requireTemplateAccess });
}
