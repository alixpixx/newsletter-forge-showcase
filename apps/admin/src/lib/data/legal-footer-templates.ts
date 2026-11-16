import { buildFooter, normalizeLocale, type FooterConfig, type Regime } from "@nf/email";
import type { EmailDoc } from "@nf/render/schema";
import { listEditionLegalFooters } from "@/lib/data/asset-editions";
import { isUuid } from "@/lib/data/templates";
import { getDb } from "@/lib/supabase";

/**
 * PIEDS LÉGAUX RÉUTILISABLES — accès serveur à `newsletter.legal_footer_template` (0065).
 *
 * Une marque en compose autant qu'elle veut ; le builder en choisit un par e-mail (bloc
 * `footer_legal`, `legalTemplateId`). La publication pose le choix sur la version
 * (`template_version.legal_footer_template_id`) et la vue d'envoi lit la config EN DIRECT : corriger
 * une adresse ici corrige tous les envois suivants, sans republier — comme le pied d'édition.
 *
 * ⛔ UN TEMPLATE LÉGAL EST TOUJOURS COMPLET. Parce qu'il est lu en direct, vider sa `privacy_url`
 * mettrait en veto (`footer_incomplete`) TOUS les envois qui l'utilisent, sans qu'aucun écran ne
 * s'allume. Création et édition refusent donc une config à laquelle `buildFooter` trouve un manque
 * pour l'une des éditions de la marque — et la publication revérifie, les éditions ayant pu changer.
 *
 * ⚠️ Mêmes invariants que `brand-partials.ts` : aucune lecture sans `assetId` (un template d'une autre
 * marque est indiscernable d'un inexistant), et une lecture ratée rend `known: false`, jamais « aucun ».
 */

type Db = NonNullable<ReturnType<typeof getDb>>;

/** Aligné sur `template.name` et `brand_partial.name`. */
export const MAX_LEGAL_TEMPLATE_NAME = 120;

export interface LegalFooterTemplate {
  id: string;
  name: string;
  config: FooterConfig;
  archivedAt: string | null;
  updatedBy: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface LegalTemplateRead<T> {
  known: boolean;
  value: T;
}

export type LegalTemplateRefusal = {
  status: number;
  error: string;
  /** Même discriminant que `BrandPartialRefusal` : deux 409 que l'écran doit distinguer. */
  kind?: "name_taken" | "stale" | "incomplete";
  missing?: string[];
};

const SELECT = "id, name, config, archived_at, updated_by, updated_at, created_at";

/** Ligne de base → objet, ou `null` si la config n'est pas un objet (jamais « config vide »). */
function toTemplate(raw: unknown): LegalFooterTemplate | null {
  const r = raw as Record<string, unknown>;
  const config = r.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    config: config as FooterConfig,
    archivedAt: (r.archived_at as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: String(r.updated_at ?? ""),
    createdAt: String(r.created_at ?? ""),
  };
}

export function validateLegalTemplateName(
  raw: unknown,
): { ok: true; name: string } | { ok: false; refusal: LegalTemplateRefusal } {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return { ok: false, refusal: { status: 400, error: "name is required" } };
  if (name.length > MAX_LEGAL_TEMPLATE_NAME) {
    return {
      ok: false,
      refusal: { status: 400, error: `name must be ${MAX_LEGAL_TEMPLATE_NAME} characters or less` },
    };
  }
  return { ok: true, name };
}

/* ------------------------------------------------------------------ *
 * Complétude — la règle qui rend un pointeur vivant acceptable
 * ------------------------------------------------------------------ */

export interface EditionCible {
  market: string;
  language: string;
  regime: Regime;
}

/**
 * Ce qui manque à `cfg` pour chaque édition, sous la forme « privacy_url (CL · es) ».
 *
 * ⛔ C'EST `buildFooter` QUI RÉPOND, pas une liste écrite ici : c'est lui qui alimente le veto du
 * worker, et une seconde liste finirait par ne plus dire la même chose.
 */
export function manquantsPourEditions(cfg: FooterConfig, editions: EditionCible[], assetName: string): string[] {
  const out: string[] = [];
  for (const e of editions) {
    const { missing } = buildFooter({
      assetName,
      regime: e.regime,
      cfg,
      market: e.market,
      locale: normalizeLocale(e.language),
      unsubUrl: "https://example.invalid/u",
    });
    for (const champ of missing) out.push(`${champ} (${[e.market, e.language].filter(Boolean).join(" · ")})`);
  }
  return out;
}

/** Les éditions de la marque, réduites à ce qui décide des mentions obligatoires. */
async function editionsDe(db: Db, assetId: string, assetName: string): Promise<LegalTemplateRead<EditionCible[]>> {
  const lu = await listEditionLegalFooters(db, assetId, assetName);
  if (!lu.known) return { known: false, value: [] };
  return {
    known: true,
    value: lu.value.map((e) => ({ market: e.market, language: e.language, regime: e.regime })),
  };
}

/**
 * Refus prêt à rendre si `cfg` est incomplète pour la marque, `null` si elle est complète.
 * Une lecture ratée des éditions REFUSE (503) : « je n'ai pas pu vérifier » n'est pas « complet ».
 */
export async function refusSiIncomplet(
  db: Db,
  asset: { id: string; name: string },
  cfg: FooterConfig,
): Promise<LegalTemplateRefusal | null> {
  const editions = await editionsDe(db, asset.id, asset.name);
  if (!editions.known) return { status: 503, error: "could not read this brand's editions to check the legal footer" };
  const missing = manquantsPourEditions(cfg, editions.value, asset.name);
  if (missing.length === 0) return null;
  return {
    status: 422,
    kind: "incomplete",
    missing,
    error: `this legal footer cannot go out without: ${missing.join(", ")}`,
  };
}

/* ------------------------------------------------------------------ *
 * Lectures
 * ------------------------------------------------------------------ */

/** La bibliothèque VIVANTE de la marque, par nom. */
export async function listLegalFooterTemplates(
  db: Db,
  assetId: string,
): Promise<LegalTemplateRead<LegalFooterTemplate[]>> {
  const { data, error } = await db
    .from("legal_footer_template")
    .select(SELECT)
    .eq("asset_id", assetId)
    .is("archived_at", null)
    .order("name", { ascending: true });
  if (error) return { known: false, value: [] };

  const lignes = ((data as unknown[]) ?? []).map(toTemplate);
  // Une ligne illisible ne disparaît pas en silence de la liste.
  if (lignes.some((l) => l === null)) return { known: false, value: [] };
  return { known: true, value: lignes as LegalFooterTemplate[] };
}

/**
 * Un template de la marque courante.
 *
 * `includeArchived` sert la PUBLICATION : un e-mail qui a choisi un template archivé depuis doit
 * continuer à se publier avec lui — archiver retire de la bibliothèque, ça ne change pas les e-mails.
 */
export async function getLegalFooterTemplate(
  db: Db,
  id: string,
  assetId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<LegalTemplateRead<LegalFooterTemplate | null>> {
  if (!isUuid(id)) return { known: true, value: null };

  let q = db.from("legal_footer_template").select(SELECT).eq("id", id).eq("asset_id", assetId);
  if (!opts.includeArchived) q = q.is("archived_at", null);
  const { data, error } = await q.maybeSingle();

  if (error) return { known: false, value: null };
  if (!data) return { known: true, value: null };
  const t = toTemplate(data);
  return t === null ? { known: false, value: null } : { known: true, value: t };
}

/* ------------------------------------------------------------------ *
 * Le choix d'un document — publication, envoi de test, aperçu, verrou
 * ------------------------------------------------------------------ */

/** L'id choisi sur le bloc légal du document, s'il y en a un. */
export function legalTemplateIdOf(doc: Pick<EmailDoc, "rows">): string | null {
  for (const row of doc.rows) {
    for (const column of row.columns) {
      for (const block of column.blocks) {
        if (block.type === "footer_legal") return block.legalTemplateId ?? null;
      }
    }
  }
  return null;
}

export type ChoixLegal =
  | { ok: true; templateId: string | null; cfg: FooterConfig | null }
  | { ok: false; status: number; error: string };

/**
 * Résout le pied légal qu'un document a choisi, avec les mêmes refus partout où il va partir.
 *
 * ⛔ UN CHOIX INTROUVABLE REFUSE (422), il ne retombe PAS sur le pied de l'édition. L'auteur a choisi
 * une entité juridique ; en expédier une autre sans le dire est exactement l'erreur qu'on ne voit
 * qu'une fois l'e-mail parti.
 */
export async function resoudreChoixLegal(
  db: Db,
  asset: { id: string; name: string },
  templateId: string | null,
): Promise<ChoixLegal> {
  if (!templateId) return { ok: true, templateId: null, cfg: null };

  const lu = await getLegalFooterTemplate(db, templateId, asset.id, { includeArchived: true });
  if (!lu.known) return { ok: false, status: 503, error: "the legal footer this email uses could not be read" };
  if (!lu.value) {
    return {
      ok: false,
      status: 422,
      error: "the legal footer this email uses no longer exists — pick another one on the legal footer block",
    };
  }

  const refus = await refusSiIncomplet(db, asset, lu.value.config);
  if (refus) {
    return {
      ok: false,
      status: refus.status,
      error:
        refus.status === 422
          ? `the legal footer "${lu.value.name}" cannot go out without: ${(refus.missing ?? []).join(", ")} — complete it in Templates › Legal footers`
          : refus.error,
    };
  }
  return { ok: true, templateId: lu.value.id, cfg: lu.value.config };
}

/**
 * Pose le choix sur une version (le brouillon, avant sa publication ou un envoi de test).
 *
 * ⛔ TOUJOURS ÉCRIT, même à `null` : un brouillon qui garderait le choix d'un envoi de test précédent
 * publierait un pied que le document ne choisit plus.
 */
export async function poserChoixLegal(
  db: Db,
  versionId: string,
  templateId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await db
    .from("template_version")
    .update({ legal_footer_template_id: templateId })
    .eq("id", versionId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "the draft changed while publishing — reload and try again" };
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Écritures
 * ------------------------------------------------------------------ */

export async function createLegalFooterTemplate(
  db: Db,
  p: { assetId: string; name: string; config: FooterConfig; author: string | null },
): Promise<{ ok: true; id: string } | { ok: false; refusal: LegalTemplateRefusal }> {
  const { data, error } = await db
    .from("legal_footer_template")
    .insert({ asset_id: p.assetId, name: p.name, config: p.config, updated_by: p.author })
    .select("id")
    .single();

  if (error?.code === "23505") {
    return {
      ok: false,
      refusal: { status: 409, kind: "name_taken", error: `a legal footer named "${p.name}" already exists for this brand` },
    };
  }
  if (error || !data) {
    return { ok: false, refusal: { status: 500, error: error?.message ?? "could not save the legal footer" } };
  }
  return { ok: true, id: String((data as { id: string }).id) };
}

/**
 * Renomme et/ou REMPLACE la config (jamais de fusion : vider un champ doit le vider).
 *
 * ⭐ `baseUpdatedAt` = compare-and-swap, comme `updateBrandPartial` : sans lui, la seconde personne
 * qui enregistre écrase la première sans rien dire. ⛔ Le `.select()` dit si une ligne a été écrite.
 */
export async function updateLegalFooterTemplate(
  db: Db,
  p: {
    id: string;
    assetId: string;
    name?: string;
    config?: FooterConfig;
    author: string | null;
    baseUpdatedAt?: string;
  },
): Promise<{ ok: true; updatedAt: string } | { ok: false; refusal: LegalTemplateRefusal }> {
  if (!isUuid(p.id)) return { ok: false, refusal: { status: 404, error: "legal footer not found" } };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: p.author };
  if (p.name !== undefined) patch.name = p.name;
  if (p.config !== undefined) patch.config = p.config;

  let q = db
    .from("legal_footer_template")
    .update(patch)
    .eq("id", p.id)
    .eq("asset_id", p.assetId)
    .is("archived_at", null);
  if (p.baseUpdatedAt !== undefined) q = q.eq("updated_at", p.baseUpdatedAt);

  const { data, error } = await q.select("updated_at").maybeSingle();

  if (error?.code === "23505") {
    return {
      ok: false,
      refusal: { status: 409, kind: "name_taken", error: "another legal footer of this brand already has that name" },
    };
  }
  if (error) return { ok: false, refusal: { status: 500, error: error.message } };

  if (!data) {
    // Zéro ligne : archivé entre-temps, ou modifié ailleurs. On relit pour dire lequel.
    const relu = await getLegalFooterTemplate(db, p.id, p.assetId);
    if (!relu.known) return { ok: false, refusal: { status: 503, error: "could not read this legal footer" } };
    if (!relu.value) return { ok: false, refusal: { status: 404, error: "legal footer not found" } };
    return {
      ok: false,
      refusal: {
        status: 409,
        kind: "stale",
        error: "this legal footer changed somewhere else since you opened it — reload before saving",
      },
    };
  }
  return { ok: true, updatedAt: String((data as { updated_at: unknown }).updated_at ?? "") };
}

/**
 * ARCHIVE, ne supprime jamais : des versions publiées pointent peut-être dessus, et la vue d'envoi
 * continue de les lire (la clé étrangère refuserait d'ailleurs la suppression).
 */
export async function archiveLegalFooterTemplate(
  db: Db,
  id: string,
  assetId: string,
  updatedBy: string | null,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!isUuid(id)) return { ok: false, status: 404, message: "legal footer not found" };

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("legal_footer_template")
    .update({ archived_at: now, updated_at: now, updated_by: updatedBy })
    .eq("id", id)
    .eq("asset_id", assetId)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, status: 500, message: error.message };
  if (!data) return { ok: false, status: 404, message: "legal footer not found" };
  return { ok: true };
}
