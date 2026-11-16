import { NextResponse } from "next/server";
import { EmailDoc } from "@nf/render/schema";
import { findTemplate, getDraftRow, touchTemplate } from "@/lib/data/templates";
import { issuesOf, jsonError, readJson, requireContext, requireTemplateAccess } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DraftBody {
  doc?: unknown;
  subject?: unknown;
  preheader?: unknown;
  /** Jeton anti-conflit : `updatedAt` reçu au dernier GET/PATCH. */
  baseUpdatedAt?: unknown;
}

/**
 * PATCH /api/builder/templates/[id]/draft — autosave du brouillon (version 0).
 *
 * Deux gardes, dans cet ordre :
 *  1. VALIDITÉ — `EmailDoc.safeParse` AVANT toute écriture. Un document invalide ne doit jamais
 *     atteindre la base : le worker et le compilateur le liraient plus tard sans filet.
 *  2. CONFLIT — pas de merge automatique. Si `baseUpdatedAt` ne correspond plus, on renvoie 409
 *     avec l'`updatedAt` réel et on n'écrit RIEN (deux onglets ouverts = l'un des deux perdrait
 *     silencieusement son travail). La comparaison est doublée d'un compare-and-swap SQL
 *     (`.eq("updated_at", base)`) : la fenêtre entre la lecture et l'écriture est ainsi couverte.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const template = await findTemplate(db, id, asset.id);
  if (!template) return jsonError("template not found", 404);

  // ⛔ Octroi : 404 et non 403, un template non octroyé est indiscernable d'un inexistant.
  const refus = await requireTemplateAccess(c.ctx, template.id);
  if (refus) return refus;

  const draft = await getDraftRow(db, template.id);
  if (!draft) return jsonError("draft not found", 404);

  const body = await readJson<DraftBody>(req);
  if (!body || body.doc === undefined) return jsonError("doc is required", 400);

  const base = typeof body.baseUpdatedAt === "string" ? body.baseUpdatedAt : null;
  if (base && base !== draft.updated_at) {
    return NextResponse.json({ conflict: true, updatedAt: draft.updated_at }, { status: 409 });
  }

  const parsed = EmailDoc.safeParse(body.doc);
  if (!parsed.success) {
    return jsonError("invalid document", 400, { issues: issuesOf(parsed.error) });
  }

  // `subject` / `preheader` vivent à la fois dans les colonnes (index, listes, envoi) et dans
  // `doc.meta` (compilation). On les resynchronise ici pour qu'il n'existe qu'une seule vérité.
  const doc = parsed.data;
  const subject = (typeof body.subject === "string" ? body.subject : doc.meta.subject).slice(0, 200);
  const preheader = (typeof body.preheader === "string" ? body.preheader : doc.meta.preheader).slice(0, 200);
  doc.meta.subject = subject;
  doc.meta.preheader = preheader;

  const updatedAt = new Date().toISOString();
  let q = db
    .from("template_version")
    .update({ doc, subject, preheader, doc_schema: doc.schema, updated_at: updatedAt })
    .eq("id", draft.id);
  // Compare-and-swap : couvre la course entre la lecture ci-dessus et cette écriture.
  if (base) q = q.eq("updated_at", base);

  const { data, error } = await q.select("updated_at");
  if (error) return jsonError(error.message, 500);

  if (!data || (data as unknown[]).length === 0) {
    const fresh = await getDraftRow(db, template.id);
    return NextResponse.json({ conflict: true, updatedAt: fresh?.updated_at ?? draft.updated_at }, { status: 409 });
  }

  // Le tri de la liste des templates suit `template.updated_at` : sans ça un brouillon travaillé
  // toute la journée resterait en bas de liste.
  await touchTemplate(db, template.id);

  const written = (data as { updated_at?: unknown }[])[0]?.updated_at;
  return NextResponse.json({ updatedAt: String(written ?? updatedAt) });
}
