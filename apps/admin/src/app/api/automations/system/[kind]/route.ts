import { requireContext } from "@/app/api/builder/_shared";
import { putSystemSwitch } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/automations/system/[kind] — allume ou coupe un e-mail de cycle de vie. Contrat dans `handler.ts`. */
export async function PUT(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  return putSystemSwitch(req, ctx, { requireContext });
}
