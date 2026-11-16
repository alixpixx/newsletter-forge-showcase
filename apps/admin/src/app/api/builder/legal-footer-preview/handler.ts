import { NextResponse } from "next/server";
import { buildFooter, normalizeLocale, type FooterConfig, type FooterInput } from "@nf/email";
import { getLegalFooterTemplate } from "@/lib/data/legal-footer-templates";
import { jsonError, type requireContext } from "../_shared";

/*
 * Module séparé de `route.ts` : la session y est injectée, pour qu'un banc mesure la route sans
 * cookie (même forme que `legal-footer-templates/handler.ts`).
 */
export type Garde = () => ReturnType<typeof requireContext>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lien posé à la place des liens PERSONNELS du pied. Ceux de l'envoi sont signés par destinataire
 * (HMAC, côté worker) : en fabriquer un ici serait fabriquer un lien de désinscription valable pour
 * quelqu'un, ou un faux qui aurait l'air vrai. `#` ne mène nulle part et ne ressemble à rien.
 */
export const LIEN_NEUTRE = "#";

interface EditionLue {
  id: string;
  asset_id: string;
  market: string | null;
  language: string | null;
  compliance_regime: string | null;
  is_primary: boolean | null;
  legal_footer: FooterConfig | null;
}

/**
 * GET /api/builder/legal-footer-preview — le VRAI pied légal de la marque courante, tel que le worker
 * le construira, pour qu'on le voie dans le builder au lieu d'un « [Simulated] ».
 *
 * Paramètres (tous facultatifs) :
 *  - `edition`  : l'édition dont on veut le pied. Défaut : celle qui parle la langue du document
 *                 (`locale`), sinon la primaire — c'est là qu'atterrit tout nouvel inscrit.
 *  - `template` : le pied légal CHOISI par l'e-mail (`footer_legal.legalTemplateId`). Sa config
 *                 remplace celle de l'édition, comme dans la vue `outbox_context` (0073) ; le régime,
 *                 la langue et le marché restent ceux de l'édition.
 *
 * ⛔ LECTURE SEULE, ET RIEN QUI TOUCHE UN ABONNÉ. Deux tables seulement : `asset_edition` et
 * `legal_footer_template`, toutes deux filtrées sur la marque de la session. Les liens personnels
 * (désinscription, préférences) sont remplacés par `#` ; le lien de confidentialité est celui de la
 * marque, public, et reste tel quel.
 *
 * ⛔ 404 ET NON 403 pour une édition ou un pied d'une AUTRE marque : un 403 confirmerait qu'il existe.
 *
 * ⛔ 503 sur une lecture ratée, jamais un pied vide : l'écran afficherait un e-mail sans mention
 * légale, et l'auteur croirait que c'est ce qui part.
 */
export async function legalFooterPreview(url: URL, garde: Garde) {
  const c = await garde();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const editionId = url.searchParams.get("edition");
  const templateId = url.searchParams.get("template");
  const locale = url.searchParams.get("locale");

  // Un identifiant malformé ne désigne rien : même réponse qu'un identifiant d'une autre marque.
  if (editionId !== null && !UUID.test(editionId)) return jsonError("edition not found", 404);

  const { data, error } = await db
    .from("asset_edition")
    .select("id, asset_id, market, language, compliance_regime, is_primary, legal_footer")
    .eq("asset_id", asset.id)
    // Même tri que `listEditionLegalFooters` : la primaire d'abord, puis un ordre stable.
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) return jsonError("could not read the brand editions", 503);

  // ⛔ Seconde barrière, en mémoire : le filtre SQL est la vraie garde, celle-ci empêche qu'un jour
  // une requête élargie (une vue, un `or`) fasse rendre le pied d'une autre marque sans bruit.
  const editions = (((data as unknown[]) ?? []) as EditionLue[]).filter((e) => e.asset_id === asset.id);
  if (editions.length === 0) return jsonError("this brand has no edition — nothing can be sent yet", 404);

  let edition: EditionLue | undefined;
  if (editionId !== null) {
    edition = editions.find((e) => e.id === editionId);
    if (!edition) return jsonError("edition not found", 404);
  } else {
    const voulue = locale ? normalizeLocale(locale) : null;
    edition = editions.find((e) => voulue !== null && normalizeLocale(e.language ?? undefined) === voulue) ?? editions[0];
  }
  if (!edition) return jsonError("edition not found", 404);

  let cfgChoisie: FooterConfig | null = null;
  if (templateId !== null) {
    // Scopé sur la marque par `getLegalFooterTemplate` lui-même ; un identifiant malformé rend `null`.
    // Archivé compris : un e-mail déjà écrit peut pointer un pied archivé depuis, et c'est lui qui part.
    const lu = await getLegalFooterTemplate(db, templateId, asset.id, { includeArchived: true });
    if (!lu.known) return jsonError("could not read the chosen legal footer", 503);
    if (!lu.value) return jsonError("legal footer not found", 404);
    cfgChoisie = lu.value.config;
  }

  // ⛔ Les MÊMES entrées que le worker (`apps/worker/src/render.ts`, `footerInput`) : régime par
  // défaut `gdpr`, langue normalisée, marché de l'édition. Seuls les liens personnels changent.
  const input: FooterInput = {
    assetName: asset.name,
    regime: (edition.compliance_regime ?? "gdpr") as FooterInput["regime"],
    cfg: cfgChoisie ?? edition.legal_footer ?? {},
    unsubUrl: LIEN_NEUTRE,
    prefsUrl: LIEN_NEUTRE,
    locale: normalizeLocale(edition.language ?? undefined),
    market: edition.market ?? undefined,
  };
  const { html, text, missing } = buildFooter(input);

  return NextResponse.json({
    editionId: edition.id,
    editions: editions.map((e) => ({
      id: e.id,
      market: e.market ?? "",
      language: e.language ?? "",
      isPrimary: Boolean(e.is_primary),
    })),
    html,
    text,
    // Non vide ⇒ le worker met l'envoi en veto (`footer_incomplete`) : l'écran doit le dire.
    missing,
  });
}
