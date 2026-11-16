import { NextResponse } from "next/server";
import {
  createLegalFooterTemplate,
  listLegalFooterTemplates,
  refusSiIncomplet,
  validateLegalTemplateName,
} from "@/lib/data/legal-footer-templates";
import { listEditionLegalFooters } from "@/lib/data/asset-editions";
import { validerConfig } from "@/lib/legal-footer-cfg";
import { jsonError, readJson, type requireContext } from "../_shared";

/*
 * Module séparé de `route.ts` : la session y est injectée, pour qu'un banc mesure la route sans
 * cookie. L'auteur est lu sur la session déjà résolue — `authorEmail()` relisait la même.
 */
export type Garde = () => ReturnType<typeof requireContext>;

/**
 * GET /api/builder/legal-footer-templates — les pieds légaux VIVANTS de la marque courante.
 *
 * ⛔ Une lecture ratée répond 503, jamais une liste vide : le builder afficherait « aucun pied
 * légal » et l'auteur en recréerait un par-dessus celui qui existe.
 */
export async function listLegalFooters(garde: Garde) {
  const c = await garde();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  // Les éditions accompagnent la liste : l'aperçu du builder rend le pied avec le régime, la langue
  // et le marché de la marque, et le pied par défaut est celui de l'édition primaire (triée en tête).
  const [lu, editions] = await Promise.all([
    listLegalFooterTemplates(db, asset.id),
    listEditionLegalFooters(db, asset.id, asset.name),
  ]);
  if (!lu.known || !editions.known) return jsonError("could not read the legal footers", 503);
  return NextResponse.json({
    legalFooters: lu.value,
    editions: editions.value.map((e) => ({ market: e.market, language: e.language, regime: e.regime })),
    defaultConfig: editions.value[0]?.cfg ?? null,
  });
}

/**
 * POST /api/builder/legal-footer-templates — crée un pied légal.
 *
 * La config passe par `validerConfig` (liste fermée, valeurs bornées, URL sans guillemets) puis par
 * le contrôle de complétude : un pied légal incomplet n'a pas le droit d'exister, puisqu'il est lu en
 * direct par tous les envois qui le choisissent.
 */
export async function createLegalFooter(req: Request, garde: Garde) {
  const c = await garde();
  if (!c.ok) return c.res;
  const { db, asset, user } = c.ctx;

  const body = await readJson<{ name?: unknown; config?: unknown }>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const nom = validateLegalTemplateName(body.name);
  if (!nom.ok) return jsonError(nom.refusal.error, nom.refusal.status);

  const valide = validerConfig(body.config);
  if (!valide.ok) return jsonError(valide.error, 422);

  const refus = await refusSiIncomplet(db, asset, valide.cfg);
  if (refus) return jsonError(refus.error, refus.status, refus.missing ? { missing: refus.missing } : undefined);

  const cree = await createLegalFooterTemplate(db, {
    assetId: asset.id,
    name: nom.name,
    config: valide.cfg,
    author: user.email,
  });
  if (!cree.ok) {
    return jsonError(cree.refusal.error, cree.refusal.status, cree.refusal.kind ? { kind: cree.refusal.kind } : undefined);
  }
  return NextResponse.json({ id: cree.id }, { status: 201 });
}
