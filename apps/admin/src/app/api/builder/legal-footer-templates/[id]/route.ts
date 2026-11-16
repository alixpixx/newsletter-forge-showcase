import { NextResponse } from "next/server";
import type { FooterConfig } from "@nf/email";
import {
  archiveLegalFooterTemplate,
  getLegalFooterTemplate,
  refusSiIncomplet,
  updateLegalFooterTemplate,
  validateLegalTemplateName,
} from "@/lib/data/legal-footer-templates";
import { authorEmail } from "@/lib/data/templates";
import { validerConfig } from "@/lib/legal-footer-cfg";
import { jsonError, readJson, requireContext } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/builder/legal-footer-templates/[id] — hors marque, archivé ou inexistant → 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const { id } = await params;
  const lu = await getLegalFooterTemplate(c.ctx.db, id, c.ctx.asset.id);
  if (!lu.known) return jsonError("could not read this legal footer", 503);
  if (!lu.value) return jsonError("legal footer not found", 404);
  return NextResponse.json(lu.value);
}

/**
 * PATCH /api/builder/legal-footer-templates/[id] — renomme et/ou remplace la config.
 *
 * ⛔ UNE CONFIG ENREGISTRÉE ICI PART AU PROCHAIN ENVOI de chaque e-mail qui a choisi ce pied, sans
 * republication. D'où le contrôle de complétude à CHAQUE écriture de config, et le compare-and-swap
 * (`baseUpdatedAt`) : deux personnes qui l'ouvrent ensemble ne s'écrasent pas en silence.
 *
 * La réponse renvoie la config NORMALISÉE (voir la route du pied d'édition : sans elle, l'écran se
 * croit modifié après chaque enregistrement réussi).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<{ name?: unknown; config?: unknown; baseUpdatedAt?: unknown }>(req);
  if (!body) return jsonError("invalid JSON body", 400);
  if (body.name === undefined && body.config === undefined) return jsonError("nothing to update", 400);

  let name: string | undefined;
  if (body.name !== undefined) {
    const nom = validateLegalTemplateName(body.name);
    if (!nom.ok) return jsonError(nom.refusal.error, nom.refusal.status);
    name = nom.name;
  }

  let config: FooterConfig | undefined;
  if (body.config !== undefined) {
    const valide = validerConfig(body.config);
    if (!valide.ok) return jsonError(valide.error, 422);
    const refus = await refusSiIncomplet(db, asset, valide.cfg);
    if (refus) return jsonError(refus.error, refus.status, refus.missing ? { missing: refus.missing } : undefined);
    config = valide.cfg;
  }

  if (body.baseUpdatedAt !== undefined && typeof body.baseUpdatedAt !== "string") {
    return jsonError("baseUpdatedAt must be a string", 400);
  }

  const { id } = await params;
  const r = await updateLegalFooterTemplate(db, {
    id,
    assetId: asset.id,
    name,
    config,
    author: await authorEmail(),
    baseUpdatedAt: body.baseUpdatedAt as string | undefined,
  });
  if (!r.ok) return jsonError(r.refusal.error, r.refusal.status, r.refusal.kind ? { kind: r.refusal.kind } : undefined);

  return NextResponse.json({ updated: true, updatedAt: r.updatedAt, ...(config ? { config } : {}), ...(name ? { name } : {}) });
}

/**
 * DELETE /api/builder/legal-footer-templates/[id] — ARCHIVE.
 *
 * Les e-mails qui l'ont déjà choisi continuent de partir avec lui : archiver le retire seulement de
 * la liste proposée dans le builder.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const { id } = await params;
  const r = await archiveLegalFooterTemplate(c.ctx.db, id, c.ctx.asset.id, await authorEmail());
  if (!r.ok) return jsonError(r.message, r.status);
  return NextResponse.json({ id, archived: true });
}
