import { Row } from "@nf/render/schema";
import { buildFooter, normalizeLocale, type FooterConfig, type Regime } from "@nf/email";

/**
 * LECTURES DE LA BIBLIOTHÈQUE (headers, footers, blocs, pieds légaux), côté navigateur.
 *
 * Partagées par la modale « Import template », la section « Saved blocks » de la palette et le
 * sélecteur de l'inspecteur : trois lectures écrites
 * séparément finiraient par ne pas traiter pareil une réponse en erreur — et l'une d'elles
 * afficherait « aucun pied légal » sur une panne.
 *
 * ⛔ UNE LECTURE RATÉE LÈVE. Aucune de ces fonctions ne rend une liste vide sur une erreur : l'appelant
 * affiche le message, jamais un état vide qu'on prendrait pour « rien n'a été créé ».
 */

/**
 * Les fentes de la bibliothèque de marque (0080). Recopiées de `lib/data/brand-partials.ts`, que ce
 * module client ne peut pas importer (il tire la session et la base).
 */
export const PARTIAL_SLOTS = ["header", "footer", "block"] as const;
export type PartialSlot = (typeof PARTIAL_SLOTS)[number];

export interface PartialEntry {
  id: string;
  slot: PartialSlot;
  name: string;
  rows: unknown[];
}

export interface LegalEntry {
  id: string;
  name: string;
  config: FooterConfig;
}

export interface EditionInfo {
  market: string;
  language: string;
  regime: Regime;
}

export interface LegalLibrary {
  legalFooters: LegalEntry[];
  editions: EditionInfo[];
  /** Le pied de l'édition primaire — celui qui part quand l'e-mail n'en choisit aucun. */
  defaultConfig: FooterConfig | null;
}

async function lireErreur(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${res.status})`;
}

export async function fetchPartials(): Promise<PartialEntry[]> {
  const res = await fetch("/api/builder/brand-partials", { cache: "no-store" });
  if (!res.ok) throw new Error(await lireErreur(res));
  const body = (await res.json()) as { brandPartials?: unknown };
  if (!Array.isArray(body.brandPartials)) throw new Error("the brand library could not be read");
  return body.brandPartials.map((raw) => {
    const r = raw as Record<string, unknown>;
    /*
     * ⛔ LA FENTE EST LUE, JAMAIS DÉDUITE. « Tout ce qui n'est pas un footer est un header » rangeait
     * chaque BLOC sous l'onglet Header de la modale et dans le sélecteur d'en-tête de l'inspecteur :
     * l'importer le posait en tête de l'e-mail. Une fente inconnue (un admin plus ancien que la
     * bibliothèque) est une LECTURE RATÉE, dite comme telle — pas un en-tête de plus.
     */
    const slot = PARTIAL_SLOTS.find((s) => s === r.slot);
    if (slot === undefined) {
      throw new Error(`the brand library holds an item of an unknown kind (${JSON.stringify(r.slot)}) — reload the page`);
    }
    return {
      id: String(r.id ?? ""),
      slot,
      name: String(r.name ?? ""),
      rows: Array.isArray(r.rows) ? r.rows : [],
    };
  });
}

/**
 * Les rows d'un header, d'un footer ou d'un bloc, RELUES à l'instant de l'insertion.
 *
 * ⛔ Relire plutôt que réutiliser la liste : chaque lecture renvoie des ids NEUFS. Insérer deux fois la
 * même copie poserait deux fois les mêmes ids, et le reducer refuserait la seconde en silence.
 */
export async function fetchPartialRows(id: string): Promise<Row[]> {
  const res = await fetch(`/api/builder/brand-partials/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error(await lireErreur(res));
  const body = (await res.json()) as { rows?: unknown };
  const parsed = Row.array().safeParse(body.rows);
  if (!parsed.success || parsed.data.length === 0) {
    throw new Error("this library item no longer matches the current block schema and cannot be inserted");
  }
  return parsed.data;
}

export async function fetchLegalLibrary(): Promise<LegalLibrary> {
  const res = await fetch("/api/builder/legal-footer-templates", { cache: "no-store" });
  if (!res.ok) throw new Error(await lireErreur(res));
  const body = (await res.json()) as { legalFooters?: unknown; editions?: unknown; defaultConfig?: unknown };
  if (!Array.isArray(body.legalFooters) || !Array.isArray(body.editions)) {
    throw new Error("the legal footers could not be read");
  }
  return {
    legalFooters: body.legalFooters.map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: String(r.id ?? ""), name: String(r.name ?? ""), config: (r.config ?? {}) as FooterConfig };
    }),
    editions: body.editions as EditionInfo[],
    defaultConfig: (body.defaultConfig ?? null) as FooterConfig | null,
  };
}

/**
 * Le pied légal tel que la PREMIÈRE édition le recevra, pour un aperçu.
 *
 * C'est `buildFooter` lui-même — la fonction que le worker appelle — et non une imitation. Les liens
 * pointent nulle part : les vrais sont signés par destinataire à l'envoi.
 */
export function legalFooterPreviewHtml(cfg: FooterConfig, edition: EditionInfo | undefined, assetName: string): string {
  const { html } = buildFooter({
    assetName,
    regime: edition?.regime ?? "gdpr",
    cfg,
    market: edition?.market,
    locale: normalizeLocale(edition?.language),
    unsubUrl: "#unsubscribe",
    prefsUrl: "#preferences",
  });
  return `<!doctype html><html><body style="margin:0;padding:16px;background:#ffffff">${html}</body></html>`;
}
