import { NextResponse } from "next/server";
import {
  TEMPLATE_CATEGORIES,
  authorEmail,
  initialDoc,
  listTemplates,
  uniqueSlug,
  type TemplateCategory,
} from "@/lib/data/templates";
import { grantTemplate } from "@/lib/data/app-user";
import { jsonError, readJson, requireContext } from "../_shared";

export const runtime = "nodejs";
// Le builder lit son propre état : jamais de cache de route.
export const dynamic = "force-dynamic";

/** GET /api/builder/templates — liste de la marque courante. */
export async function GET() {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const templates = await listTemplates(c.ctx.asset.id);
  return NextResponse.json({ templates });
}

interface CreateBody {
  name?: unknown;
  category?: unknown;
}

/**
 * POST /api/builder/templates — crée un template ET son brouillon (version 0).
 *
 * Les deux insertions ne sont pas dans une transaction (PostgREST) : si la seconde échoue, on
 * supprime le template orphelin. Un template sans brouillon serait inéditable et invisible du
 * builder — mieux vaut échouer franchement que laisser une ligne morte.
 */
export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset, user } = c.ctx;

  const body = await readJson<CreateBody>(req);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return jsonError("name is required", 400);
  if (name.length > 120) return jsonError("name must be 120 characters or less", 400);

  const category = body?.category === undefined || body?.category === null ? "newsletter" : String(body.category);
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(category)) {
    return jsonError(`unknown category "${category}"`, 400);
  }

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

  const doc = initialDoc(asset.slug, asset.languages[0] ?? "en", name);
  const { error: draftError } = await db.from("template_version").insert({
    template_id: id,
    version: 0,
    status: "draft",
    subject: doc.meta.subject,
    preheader: doc.meta.preheader,
    doc,
    doc_schema: 2,
  });

  if (draftError) {
    await db.from("template").delete().eq("id", id);
    return jsonError(`could not create draft: ${draftError.message}`, 500);
  }

  // « S'occuper de sa propre newsletter » : le créateur se voit octroyer son template, par le même
  // mécanisme qu'un octroi d'administrateur. Sans cette ligne, il ne reverrait jamais ce qu'il
  // vient de créer.
  await grantTemplate(db, user.id, id, user.id);

  return NextResponse.json({ id }, { status: 201 });
}
