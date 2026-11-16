import { NextResponse } from "next/server";
import { TEMPLATE_CATEGORIES, findTemplate, getTemplateWithDraft, isUuid, type TemplateCategory } from "@/lib/data/templates";
import { jsonError, readJson, requireContext, requireTemplateAccess } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/builder/templates/[id] — template + brouillon vivant + historique publié.
 * Hors marque courante ou inexistant → 404 (aucun oracle d'existence inter-marques).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const { id } = await params;
  const data = await getTemplateWithDraft(id, c.ctx.asset.id);
  if (!data) return jsonError("template not found", 404);

  // ⛔ Octroi : 404 et non 403, un template non octroyé est indiscernable d'un inexistant.
  const refus = await requireTemplateAccess(c.ctx, id);
  if (refus) return refus;

  return NextResponse.json(data);
}

interface PatchBody {
  name?: unknown;
  category?: unknown;
}

/**
 * PATCH /api/builder/templates/[id] — renomme et/ou reclasse le template.
 *
 * ⚠️ Le `slug` n'est JAMAIS régénéré. C'est l'identifiant stable du template : le changer casserait
 * les références externes et la contrainte d'unicité par marque, pour un simple changement de libellé.
 * Le nom est un affichage, le slug est une identité — les deux ne bougent pas ensemble.
 *
 * Le CONTENU du template ne se modifie pas ici : il vit dans le brouillon (`/draft`).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const existing = await findTemplate(db, id, asset.id);
  if (!existing) return jsonError("template not found", 404);

  // ⛔ Octroi : 404 et non 403, un template non octroyé est indiscernable d'un inexistant.
  const refus = await requireTemplateAccess(c.ctx, id);
  if (refus) return refus;

  const body = await readJson<PatchBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return jsonError("name cannot be empty", 400);
    if (name.length > 120) return jsonError("name must be 120 characters or less", 400);
    patch.name = name;
  }

  if (body.category !== undefined) {
    const category = String(body.category);
    if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(category)) {
      return jsonError(`unknown category "${category}"`, 400);
    }
    patch.category = category as TemplateCategory;
  }

  if (Object.keys(patch).length === 0) return jsonError("nothing to update", 400);
  patch.updated_at = new Date().toISOString();

  const { error } = await db.from("template").update(patch).eq("id", id).eq("asset_id", asset.id);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ id, name: patch.name ?? existing.name, category: patch.category ?? existing.category });
}

/**
 * DELETE /api/builder/templates/[id] — ARCHIVE le template, ne le détruit pas.
 *
 * Une suppression réelle ferait disparaître ses versions publiées (cascade), donc la trace de ce qui
 * a RÉELLEMENT été envoyé aux abonnés : `email_outbox` référence `template_version_id`, et cette
 * trace est ce qui permet de répondre à « qu'avons-nous envoyé, exactement ? ». On ne détruit pas
 * une preuve d'envoi pour ranger une bibliothèque.
 *
 * La colonne `archived_at` existait déjà et le côté lecture la filtrait (`listTemplates`,
 * `findTemplate`, pastille « Archived » sur la page détail) — seule l'écriture manquait.
 * Le désarchivage n'a pas d'écran : il reste une opération manuelle en base, assumée tant qu'il n'y
 * a pas de vue « archivés ».
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  if (!isUuid(id)) return jsonError("template not found", 404);

  // On revalide l'appartenance à la marque AVANT d'écrire : un id d'une autre marque doit être
  // indiscernable d'un id inexistant.
  const existing = await findTemplate(db, id, asset.id);
  if (!existing) return jsonError("template not found", 404);

  // ⛔ Octroi : 404 et non 403, un template non octroyé est indiscernable d'un inexistant.
  const refus = await requireTemplateAccess(c.ctx, id);
  if (refus) return refus;

  const { error } = await db
    .from("template")
    .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("asset_id", asset.id);

  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ id, archived: true });
}
