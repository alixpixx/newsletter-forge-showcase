import { NextResponse } from "next/server";
import {
  TEMPLATE_CATEGORIES,
  authorEmail,
  findTemplate,
  getDraftRow,
  isUuid,
  touchTemplate,
  uniqueSlug,
  type TemplateCategory,
} from "@/lib/data/templates";
import { MAX_HTML_BYTES, htmlToDoc } from "@/lib/import";
import { jsonError, readJson, requireContext, requireTemplateAccess } from "../_shared";

export const runtime = "nodejs";
// L'import écrit en base et renvoie un rapport : rien à mettre en cache.
export const dynamic = "force-dynamic";

interface ImportBody {
  html?: unknown;
  name?: unknown;
  category?: unknown;
  /** Présent = on REMPLACE le brouillon de ce modèle au lieu d'en créer un nouveau. */
  templateId?: unknown;
  /**
   * OBLIGATOIRE quand `templateId` est fourni : l'horodatage du brouillon tel que l'appelant l'a lu.
   * C'est la preuve qu'il sait ce qu'il s'apprête à détruire.
   */
  baseUpdatedAt?: unknown;
}

/**
 * POST /api/builder/import — convertit un HTML étranger en document éditable.
 *
 * Deux destinations, un seul convertisseur :
 *  - sans `templateId` : nouveau template + brouillon (version 0), même contrat de création que
 *    `POST /api/builder/templates`, suppression du template orphelin comprise — un template sans
 *    brouillon serait inéditable et invisible du builder ;
 *  - avec `templateId` : le brouillon EXISTANT est écrasé. Les versions publiées ne bougent pas
 *    (elles vivent dans d'autres lignes `template_version`), donc ce que les abonnés ont reçu
 *    reste intact ; c'est le travail non publié qui est perdu.
 *
 * ⚠️ Le remplacement exige `baseUpdatedAt`, l'horodatage du brouillon tel que l'appelant l'a LU.
 * Une confirmation dans l'interface ne protège que l'utilisateur attentif : elle ne dit rien d'un
 * bug de client, d'un double envoi, ni d'un collègue qui a modifié le brouillon entre-temps.
 * Le contrôle est donc ici, avec le MÊME motif que `PATCH .../draft` — comparaison puis écriture
 * conditionnelle, pour couvrir aussi la fenêtre entre la lecture et l'écriture.
 *
 * Le `report` est renvoyé À L'UTILISATEUR, pas seulement journalisé : il doit savoir ce qui a été
 * retiré (sécurité) et ce qui n'a pas pu être traduit AVANT d'ouvrir l'éditeur.
 */
export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<ImportBody>(req);
  const replacing = typeof body?.templateId === "string" && body.templateId.trim() !== "";

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  // Le nom n'a de sens qu'à la création : en remplacement, le modèle porte déjà le sien.
  if (!replacing && !name) return jsonError("name is required", 400);
  if (name.length > 120) return jsonError("name must be 120 characters or less", 400);

  const category = body?.category === undefined || body?.category === null ? "newsletter" : String(body.category);
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(category)) {
    return jsonError(`unknown category "${category}"`, 400);
  }

  const html = typeof body?.html === "string" ? body.html : "";
  if (html.trim() === "") return jsonError("html is required", 400);
  // Plafond vérifié AVANT l'analyse : un fichier hostile ne doit pas nous faire travailler.
  if (html.length > MAX_HTML_BYTES) return jsonError("this HTML is larger than the 2 MB import limit", 413);

  // Cible résolue AVANT la conversion : inutile d'analyser 2 Mo pour un modèle qui n'existe pas,
  // et un modèle d'une autre marque doit être indiscernable d'un modèle inexistant (404).
  const target = replacing ? await findTemplate(db, String(body?.templateId).trim(), asset.id) : null;
  if (replacing) {
    if (!isUuid(String(body?.templateId).trim()) || !target) return jsonError("template not found", 404);
    // ⛔ L'import REMPLACE le contenu du template visé : sans octroi, il permettrait d'écraser
    // le travail d'un autre sans jamais avoir pu l'ouvrir.
    const refus = await requireTemplateAccess(c.ctx, target.id);
    if (refus) return refus;
  }

  const result = htmlToDoc(html, {
    assetSlug: asset.slug,
    locale: asset.languages[0] ?? "en",
    subject: name || target?.name || "",
  });

  if (!result.ok) {
    const status = result.code === "too_large" ? 413 : 422;
    return jsonError(result.error, status, {
      code: result.code,
      report: result.report,
      ...(result.issues ? { issues: result.issues } : {}),
    });
  }

  const doc = result.doc;

  if (target) {
    const draft = await getDraftRow(db, target.id);
    if (!draft) return jsonError("this template has no draft to replace", 409);

    // Sans preuve de lecture, on refuse : écraser un brouillon entier n'est pas une opération qu'on
    // exécute « au cas où ». Le message dit comment obtenir la valeur, pour ne pas laisser
    // l'appelant deviner.
    const base = typeof body?.baseUpdatedAt === "string" ? body.baseUpdatedAt : null;
    if (!base) {
      return jsonError(
        "replacing a draft requires baseUpdatedAt — read the draft first (GET /api/builder/templates/[id]) and send back its updated_at, so the server can tell an intentional replacement from an accidental one",
        400,
      );
    }
    if (base !== draft.updated_at) {
      return NextResponse.json(
        {
          conflict: true,
          updatedAt: draft.updated_at,
          error: "this draft changed since you loaded it — reload before replacing it, or the other change is lost",
        },
        { status: 409 },
      );
    }

    const { data: written, error } = await db
      .from("template_version")
      .update({
        doc,
        subject: doc.meta.subject,
        preheader: doc.meta.preheader,
        doc_schema: doc.schema,
        updated_at: new Date().toISOString(),
      })
      .eq("id", draft.id)
      // Écriture CONDITIONNELLE : couvre la fenêtre entre la comparaison ci-dessus et ce moment.
      .eq("updated_at", base)
      .select("updated_at");

    if (error) return jsonError(`could not replace the draft: ${error.message}`, 500);

    // Zéro ligne touchée = quelqu'un a écrit entre-temps. On ne réessaie pas en silence.
    if (!written || (written as unknown[]).length === 0) {
      const fresh = await getDraftRow(db, target.id);
      return NextResponse.json(
        {
          conflict: true,
          updatedAt: fresh?.updated_at ?? draft.updated_at,
          error: "this draft changed while the import was running — nothing was replaced",
        },
        { status: 409 },
      );
    }

    // Le tri de la bibliothèque suit `template.updated_at` : un modèle réimporté doit remonter.
    await touchTemplate(db, target.id);
    return NextResponse.json({ id: target.id, report: result.report, replaced: true });
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

  return NextResponse.json({ id, report: result.report, replaced: false }, { status: 201 });
}
