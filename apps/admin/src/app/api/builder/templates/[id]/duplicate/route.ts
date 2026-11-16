import { NextResponse } from "next/server";
import { EmailDoc } from "@nf/render/schema";
import { authorEmail, findTemplate, getDraftRow, initialDoc, uniqueSlug } from "@/lib/data/templates";
import { grantTemplate } from "@/lib/data/app-user";
import { jsonError, requireContext, requireTemplateAccess } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/builder/templates/[id]/duplicate
 *
 * On duplique le BROUILLON, pas la dernière version publiée : c'est l'état que l'utilisateur voit
 * à l'écran au moment où il clique. La copie repart sans historique (version 0 seulement) —
 * un historique de publication cloné mentirait sur ce qui est réellement parti chez des abonnés.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset, user } = c.ctx;

  const { id } = await params;
  const source = await findTemplate(db, id, asset.id);
  if (!source) return jsonError("template not found", 404);

  // ⛔ Octroi : 404 et non 403, un template non octroyé est indiscernable d'un inexistant.
  const refus = await requireTemplateAccess(c.ctx, source.id);
  if (refus) return refus;

  const draft = await getDraftRow(db, source.id);
  const name = `${source.name} (copy)`.slice(0, 120);
  const slug = await uniqueSlug(db, asset.id, name);

  // Un brouillon corrompu (schéma antérieur, écriture manuelle) ne doit pas bloquer la duplication :
  // on repart alors d'un document initial valide plutôt que d'échouer.
  const parsed = draft ? EmailDoc.safeParse(draft.doc) : null;
  const doc = parsed?.success ? parsed.data : initialDoc(asset.slug, asset.languages[0] ?? "en", name);

  const { data, error } = await db
    .from("template")
    .insert({
      asset_id: asset.id,
      slug,
      name,
      category: source.category,
      created_by: await authorEmail(),
    })
    .select("id")
    .single();

  if (error || !data) return jsonError(error?.message ?? "could not duplicate template", 500);
  const newId = String((data as { id: string }).id);

  const { error: draftError } = await db.from("template_version").insert({
    template_id: newId,
    version: 0,
    status: "draft",
    subject: draft?.subject ?? doc.meta.subject,
    preheader: draft?.preheader ?? doc.meta.preheader,
    doc,
    doc_schema: 2,
  });

  if (draftError) {
    await db.from("template").delete().eq("id", newId);
    return jsonError(`could not duplicate draft: ${draftError.message}`, 500);
  }

  // La copie appartient à qui l'a faite — pas à qui possédait l'original.
  await grantTemplate(db, user.id, newId, user.id);

  return NextResponse.json({ id: newId }, { status: 201 });
}
