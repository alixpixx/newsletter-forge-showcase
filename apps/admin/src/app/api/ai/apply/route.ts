import { NextResponse } from "next/server";
import { EmailDoc } from "@nf/render/schema";
import { TEMPLATE_CATEGORIES, authorEmail, uniqueSlug, type TemplateCategory } from "@/lib/data/templates";
import { requireAiContext, jsonError } from "../_shared";
import { issuesOf } from "@/app/api/builder/_shared";
import { applyGuardrails } from "@/lib/ai/compose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  name?: unknown;
  category?: unknown;
  doc?: unknown;
  subject?: unknown;
  preheader?: unknown;
}

/**
 * Étape 4 — matérialise le document généré en template + brouillon (version 0), donc ÉDITABLE
 * immédiatement dans le builder. C'est tout l'intérêt du parti pris « l'IA produit un EmailDoc,
 * jamais du HTML » : rien n'est figé, l'utilisateur reprend la main bloc par bloc.
 *
 * Le doc arrive du client : il est **revalidé** et repasse par les garde-fous (le client a pu
 * modifier des liens ou retirer le pied de page légal).
 */
export async function POST(req: Request) {
  const c = await requireAiContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return jsonError("name is required", 400);
  if (name.length > 120) return jsonError("name must be 120 characters or less", 400);

  const category = body.category === undefined || body.category === null ? "newsletter" : String(body.category);
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(category)) {
    return jsonError(`unknown category "${category}"`, 400);
  }

  const parsed = EmailDoc.safeParse(body.doc);
  if (!parsed.success) {
    return jsonError("The generated document is invalid.", 422, {
      code: "invalid_doc",
      issues: issuesOf(parsed.error),
    });
  }

  const { doc: guarded } = applyGuardrails(parsed.data);

  // Sujet et pré-en-tête de l'écran priment sur ceux du doc : c'est le dernier état vu par l'utilisateur.
  const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim().slice(0, 200) : guarded.meta.subject;
  const preheader =
    typeof body.preheader === "string" ? body.preheader.trim().slice(0, 200) : (guarded.meta.preheader ?? "");

  const doc = { ...guarded, meta: { ...guarded.meta, subject, preheader } };

  const slug = await uniqueSlug(db, asset.id, name);
  const author = await authorEmail();

  const { data, error } = await db
    .from("template")
    .insert({
      asset_id: asset.id,
      slug,
      name,
      category: category as TemplateCategory,
      created_by: author,
    })
    .select("id")
    .single();

  if (error || !data) return jsonError(error?.message ?? "could not create template", 500);
  const id = String((data as { id: string }).id);

  const { error: draftError } = await db.from("template_version").insert({
    template_id: id,
    version: 0,
    status: "draft",
    subject: doc.meta.subject,
    preheader: doc.meta.preheader,
    doc,
    doc_schema: 2,
  });

  // Même politique que la création manuelle : un template sans brouillon serait inéditable.
  if (draftError) {
    await db.from("template").delete().eq("id", id);
    return jsonError(`could not create draft: ${draftError.message}`, 500);
  }

  return NextResponse.json({ id }, { status: 201 });
}
