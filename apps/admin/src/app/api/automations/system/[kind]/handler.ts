import { NextResponse } from "next/server";
import { jsonError, readJson, type requireContext } from "@/app/api/builder/_shared";
import { CONFIRMATION_LOCKED_WHY, canTurnOff, isLifecycleEditable } from "@/lib/automations";
import { setLifecycleSetting } from "@/lib/data/lifecycle-settings";

/**
 * PUT /api/automations/system/[kind]  `{ enabled: boolean }` — allume ou coupe un e-mail de cycle de vie
 * pour la marque courante (0086, feature 3 du 24/09/2026).
 *
 * ⛔ LA CONFIRMATION NE SE COUPE PAS : 422, avant toute lecture du corps. La contrainte de 0086 la
 * refuserait de toute façon ; le dire ici donne la raison au lieu d'une erreur de base.
 * ⛔ MARQUE = CELLE DE LA SESSION, jamais un identifiant du corps.
 * ⚠️ Membre de la marque suffit, comme pour choisir le modèle de l'e-mail (`templates/[id]/lifecycle`) :
 * couper un e-mail transactionnel n'envoie rien, le rallumer ne rend que l'état d'avant.
 * L'audit suit l'écriture ; son échec est journalisé mais ne défait pas un réglage déjà posé.
 */
export interface SystemSwitchDeps {
  requireContext: () => ReturnType<typeof requireContext>;
}

export async function putSystemSwitch(
  req: Request,
  { params }: { params: Promise<{ kind: string }> },
  deps: SystemSwitchDeps,
): Promise<Response> {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { kind } = await params;
  if (!isLifecycleEditable(kind)) return jsonError("unknown lifecycle email", 404);
  if (!canTurnOff(kind)) return jsonError(`the confirmation email cannot be switched off. ${CONFIRMATION_LOCKED_WHY}`, 422);

  const body = await readJson<{ enabled?: unknown }>(req);
  if (typeof body?.enabled !== "boolean") return jsonError("`enabled` must be true or false", 400);
  const enabled = body.enabled;

  const { db, asset, user } = c.ctx;
  const r = await setLifecycleSetting(db, asset.id, kind, enabled, user.email);
  if (!r.ok) return jsonError(`not saved: ${r.message}`, 500);

  const { error } = await db.from("audit_log").insert({
    actor: `admin:${user.email}`,
    action: enabled ? "lifecycle-email-on" : "lifecycle-email-off",
    target_type: "lifecycle_email",
    target_id: kind,
    asset_id: asset.id,
    meta: { kind, enabled },
  });
  if (error) console.error(JSON.stringify({ event: "lifecycle-switch-audit-failed", kind, reason: error.message }));

  return NextResponse.json({ ok: true, kind, enabled });
}
