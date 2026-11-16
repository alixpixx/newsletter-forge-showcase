import { NextResponse } from "next/server";
import { jsonError, readJson, requireContext } from "@/app/api/builder/_shared";
import { findSegment, isValidRule, isUuid } from "@/lib/data/segments";
import { messageDeBlocage } from "./blocage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/segments/[id] — hors marque ou inexistant → 404, jamais 403. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const { id } = await params;
  const segment = await findSegment(c.ctx.db, id, c.ctx.asset.id);
  if (!segment) return jsonError("segment not found", 404);

  return NextResponse.json({ segment });
}

interface PatchBody {
  name?: unknown;
  rule?: unknown;
  cachedCount?: unknown;
}

/** PATCH /api/segments/[id] — renomme et/ou remplace la règle. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const existing = await findSegment(db, id, asset.id);
  if (!existing) return jsonError("segment not found", 404);

  const body = await readJson<PatchBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return jsonError("name cannot be empty", 400);
    if (name.length > 120) return jsonError("name must be 120 characters or less", 400);
    patch.name = name;
  }

  if (body.rule !== undefined) {
    if (!isValidRule(body.rule)) return jsonError("rule must be a group with a conditions array", 400);
    patch.rule_json = body.rule;
    // La règle a changé : le compte mémorisé décrit l'ANCIENNE règle. Le garder afficherait un
    // chiffre qui ne correspond plus à rien — on l'efface plutôt que de laisser mentir l'écran.
    patch.cached_count = null;
    patch.cached_at = null;
  }

  if (typeof body.cachedCount === "number" && Number.isFinite(body.cachedCount)) {
    patch.cached_count = Math.max(0, Math.trunc(body.cachedCount));
    patch.cached_at = new Date().toISOString();
  }

  if (Object.keys(patch).length === 0) return jsonError("nothing to update", 400);
  patch.updated_at = new Date().toISOString();

  const { error } = await db.from("segment").update(patch).eq("id", id).eq("asset_id", asset.id);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ id });
}

/**
 * DELETE /api/segments/[id] — suppression réelle.
 *
 * Contrairement aux modèles, un segment ne laisse aucune trace d'envoi derrière lui : c'est une
 * requête enregistrée, pas une preuve. Il n'y a donc rien à préserver.
 *
 * En revanche on REFUSE de supprimer un segment utilisé par une automation ou par une campagne non
 * envoyée : la campagne perdrait silencieusement son audience et partirait à personne, ou pire, à
 * une audience recalculée par défaut.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  if (!isUuid(id)) return jsonError("segment not found", 404);

  const existing = await findSegment(db, id, asset.id);
  if (!existing) return jsonError("segment not found", 404);

  if (existing.usedByAutomation) {
    return jsonError("This segment is used by an automation — detach it there first.", 409);
  }

  // ⛔ PAS de filtre `archived_at` : une campagne archivée peut être réactivée, elle bloque aussi
  // (voir `blocage.ts`). On la lit pour la NOMMER comme telle.
  const { data: used } = await db
    .from("campaign")
    .select("id, name, status, archived_at")
    .eq("segment_id", id)
    .neq("status", "sent")
    .limit(3);

  const blockers = (used as { name: string; archived_at?: unknown }[] | null) ?? [];
  if (blockers.length > 0) {
    return jsonError(messageDeBlocage(blockers), 409);
  }

  const { error } = await db.from("segment").delete().eq("id", id).eq("asset_id", asset.id);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ id, deleted: true });
}
