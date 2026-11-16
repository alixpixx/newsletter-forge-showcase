import { NextResponse } from "next/server";
import { findTemplate, getDraftRow } from "@/lib/data/templates";
import { jsonError, readJson, requireContext, requireTemplateAccess } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RestoreBody {
  version?: unknown;
}

/**
 * POST /api/builder/templates/[id]/restore — recharge une version publiée DANS le brouillon.
 *
 * L'historique n'est jamais réécrit : restaurer v3 n'annule pas v4, ça remplit le brouillon avec
 * le document de v3 (l'utilisateur republie ensuite s'il le souhaite). C'est aussi pour ça qu'on
 * exige `status='published'` : le brouillon ne peut pas se restaurer lui-même.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const template = await findTemplate(db, id, asset.id);
  if (!template) return jsonError("template not found", 404);

  // ⛔ Même raison qu'à la publication : `template_restore` est SECURITY DEFINER, et elle rend un
  // succès SILENCIEUX quand rien ne correspond. Un refus greffé là-dedans serait indiscernable
  // d'une réussite — il doit donc être ici, avant l'appel.

  // ⛔ Octroi : 404 et non 403, un template non octroyé est indiscernable d'un inexistant.
  const refus = await requireTemplateAccess(c.ctx, template.id);
  if (refus) return refus;

  const body = await readJson<RestoreBody>(req);
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 1) return jsonError("version must be a positive integer", 400);

  const { data: source } = await db
    .from("template_version")
    .select("id")
    .eq("template_id", template.id)
    .eq("version", version)
    .eq("status", "published")
    .maybeSingle();
  if (!source) return jsonError(`published version ${version} not found`, 404);

  // Le brouillon doit exister : la RPC est un UPDATE ... FROM, elle ne signalerait rien s'il manquait.
  const draft = await getDraftRow(db, template.id);
  if (!draft) return jsonError("draft not found", 404);

  const { error } = await db.rpc("template_restore", { p_template_id: template.id, p_version: version });
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ ok: true });
}
