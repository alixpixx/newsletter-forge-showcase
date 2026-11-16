import { getDb } from "@/lib/supabase";
import { normalizeRestRoot } from "@nf/wp/client";
import type { ProbeResult } from "@nf/wp/client";

/**
 * Sources WordPress d'une ÉDITION (migration 0024).
 *
 * POURQUOI L'ÉDITION ET PAS LA MARQUE. Décision d'Alix du 20/08 : `atlas-review.example/cl/` aura sa
 * propre liste et sa propre newsletter. Une même marque a donc plusieurs racines REST — mesuré :
 * Atlas Review en expose trois (`/`, `/en/`, `/fr/`). Accrocher la source à la marque obligerait à
 * re-choisir la langue à chaque composition, c'est-à-dire à se tromper un jour.
 *
 * ⛔ AUCUN SECRET ICI. `auth_user` est un identifiant, pas un mot de passe : le mot de passe
 * applicatif vit en variable d'environnement Vercel, résolue à l'exécution par `resolveAuth()`.
 * Ne jamais ajouter de colonne pour le stocker : la même base détient par ailleurs la PII des
 * abonnés.
 *
 * ⚠️ `capabilities` et `status` sont MESURÉS par la sonde, jamais déclarés à la main : ce que le
 * site répond fait foi sur ce que l'opérateur croit.
 */

export type WpSourceKind = "wp-rest" | "rss";
export type WpSourceStatus = "unknown" | "ok" | "error";

export interface WpSourceRow {
  id: string;
  editionId: string;
  assetId: string;
  label: string;
  /** Racine du SITE, sans `/wp-json` — cf. `normalizeRestRoot`. */
  restRoot: string;
  kind: WpSourceKind;
  /** Ids NUMÉRIQUES de catégories WP, jamais des slugs (`?categories=` n'accepte que des ids). */
  defaultCategories: number[];
  authKind: "none" | "app_password";
  authUser: string | null;
  capabilities: Record<string, unknown>;
  status: WpSourceStatus;
  statusDetail: string | null;
  lastProbedAt: string | null;
  createdAt: string;
  /** Rempli par la jointure quand on liste à l'échelle de la marque. */
  editionLabel?: string | null;
}

const COLS =
  "id, edition_id, asset_id, label, rest_root, kind, default_categories, auth_kind, auth_user, capabilities, status, status_detail, last_probed_at, created_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID_RE.test(v);

function toRow(raw: unknown): WpSourceRow {
  const r = raw as Record<string, unknown>;
  const cats = Array.isArray(r.default_categories) ? r.default_categories : [];
  const edition = r.asset_edition as { market?: unknown; language?: unknown } | null | undefined;

  return {
    id: String(r.id ?? ""),
    editionId: String(r.edition_id ?? ""),
    assetId: String(r.asset_id ?? ""),
    label: String(r.label ?? ""),
    restRoot: String(r.rest_root ?? ""),
    kind: (r.kind as WpSourceKind) ?? "wp-rest",
    // Postgres rend un `int[]`; on refiltre quand même : une valeur non numérique dans l'URL
    // produirait un `?categories=NaN` que WordPress interprète comme « aucun filtre ».
    defaultCategories: cats.map((c) => Number(c)).filter((n) => Number.isFinite(n)),
    authKind: (r.auth_kind as WpSourceRow["authKind"]) ?? "none",
    authUser: r.auth_user ? String(r.auth_user) : null,
    capabilities: (r.capabilities as Record<string, unknown>) ?? {},
    status: (r.status as WpSourceStatus) ?? "unknown",
    statusDetail: r.status_detail ? String(r.status_detail) : null,
    lastProbedAt: r.last_probed_at ? String(r.last_probed_at) : null,
    createdAt: String(r.created_at ?? ""),
    editionLabel: edition
      ? [edition.market, edition.language].filter(Boolean).join(" · ") || null
      : undefined,
  };
}

type Db = NonNullable<ReturnType<typeof getDb>>;

/* ------------------------------------------------------------------ Lectures */

/**
 * Toutes les sources de la marque, éditions confondues.
 *
 * ⚠️ REND L'ERREUR AU LIEU DE LA MANGER. Un `catch → []` afficherait « aucune source pour l'instant »
 * quand la table est absente ou les droits refusés : un écran rassurant sur une panne. Mesuré le
 * 20/08 — tant que la migration 0024 n'est pas appliquée, PostgREST répond « Could not find the
 * table 'newsletter.wp_source' », et c'est cette phrase que l'opérateur doit lire.
 *
 * `assetId === null` (base injoignable) → liste vide sans erreur : mieux vaut un écran vide honnête
 * que l'agrégat des 9 marques.
 */
export async function listWpSources(
  assetId: string | null,
): Promise<{ rows: WpSourceRow[]; error: string | null }> {
  const db = getDb();
  if (!db || !assetId) return { rows: [], error: null };

  const { data, error } = await db
    .from("wp_source")
    .select(`${COLS}, asset_edition!inner(market, language)`)
    .eq("asset_id", assetId)
    .order("created_at", { ascending: false });

  if (error) return { rows: [], error: error.message };
  return { rows: ((data as unknown[]) ?? []).map(toRow), error: null };
}

/** Sources d'une édition précise — l'écran de composition n'en propose jamais d'autres. */
export async function listWpSourcesForEdition(
  db: Db,
  editionId: string,
  assetId: string,
): Promise<WpSourceRow[]> {
  if (!isUuid(editionId)) return [];
  const { data } = await db
    .from("wp_source")
    .select(COLS)
    .eq("edition_id", editionId)
    .eq("asset_id", assetId)
    .order("created_at", { ascending: false });
  return data ? (data as unknown[]).map(toRow) : [];
}

/** Source de la marque courante, ou `null` — inexistante ET appartenant à une autre marque. */
export async function findWpSource(db: Db, id: string, assetId: string): Promise<WpSourceRow | null> {
  if (!isUuid(id)) return null;
  const { data } = await db
    .from("wp_source")
    .select(COLS)
    .eq("id", id)
    .eq("asset_id", assetId)
    .maybeSingle();
  return data ? toRow(data) : null;
}

export interface EditionOption {
  id: string;
  market: string | null;
  language: string | null;
  timezone: string | null;
  label: string;
}

/**
 * Éditions de la marque — le choix obligatoire à la création d'une source.
 *
 * Le libellé porte le marché ET la langue parce que c'est ce qui distingue deux éditions du même
 * site : `atlas-review.example/cl/` et `atlas-review.example/en/` ne diffèrent pas par leur nom de domaine.
 */
export async function listEditions(assetId: string | null): Promise<EditionOption[]> {
  const db = getDb();
  if (!db || !assetId) return [];

  const { data } = await db
    .from("asset_edition")
    .select("id, market, language, timezone")
    .eq("asset_id", assetId)
    .order("market", { ascending: true });

  return ((data as unknown[]) ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    const market = r.market ? String(r.market) : null;
    const language = r.language ? String(r.language) : null;
    return {
      id: String(r.id ?? ""),
      market,
      language,
      timezone: r.timezone ? String(r.timezone) : null,
      label: [market, language].filter(Boolean).join(" · ") || "édition",
    };
  });
}

/* ------------------------------------------------------------------ Écritures */

export interface WpSourceInput {
  editionId: string;
  label: string;
  restRoot: string;
  kind?: WpSourceKind;
  defaultCategories?: number[];
  authKind?: "none" | "app_password";
  authUser?: string | null;
}

/** Erreur rendue telle quelle à l'opérateur — pas de `throw` : les routes en font des 4xx. */
export type WpSourceError = { error: string };

/**
 * Crée une source. L'édition est vérifiée APPARTENIR à la marque avant l'insertion.
 *
 * La FK composite `(edition_id, asset_id)` de 0024 l'interdirait déjà côté base, mais un refus de
 * contrainte remonte un message Postgres illisible : on préfère nommer le problème.
 */
export async function createWpSource(
  db: Db,
  assetId: string,
  input: WpSourceInput,
): Promise<{ row: WpSourceRow } | WpSourceError> {
  const label = input.label.trim();
  const restRoot = normalizeRestRoot(input.restRoot);

  if (label === "") return { error: "label is required" };
  if (!isUuid(input.editionId)) return { error: "edition is required" };
  if (restRoot === "") return { error: "site URL is invalid" };

  const { data: edition } = await db
    .from("asset_edition")
    .select("id")
    .eq("id", input.editionId)
    .eq("asset_id", assetId)
    .maybeSingle();
  if (!edition) return { error: "edition not found for this brand" };

  const { data, error } = await db
    .from("wp_source")
    .insert({
      edition_id: input.editionId,
      asset_id: assetId,
      label,
      rest_root: restRoot,
      kind: input.kind ?? "wp-rest",
      default_categories: input.defaultCategories ?? [],
      auth_kind: input.authKind ?? "none",
      auth_user: input.authUser?.trim() || null,
    })
    .select(COLS)
    .single();

  // `unique (edition_id, label)` : deux sources homonymes seraient indiscernables au sélecteur.
  if (error) {
    return {
      error: error.code === "23505" ? "a source with this name already exists in this edition" : error.message,
    };
  }
  return { row: toRow(data) };
}

export interface WpSourcePatch {
  label?: string;
  restRoot?: string;
  /**
   * ⛔ MODIFIABLE, SINON LE TYPE EST UN VERROU. Sans cette clé, une source créée en `wp-rest` sur un
   * site sans API REST ne pouvait plus JAMAIS être réparée autrement qu'en SQL : l'opérateur devait
   * la supprimer et la recréer. Changer de type invalide les capacités, exactement comme changer de
   * racine — elles décrivaient l'autre chemin de lecture.
   */
  kind?: WpSourceKind;
  defaultCategories?: number[];
  authKind?: "none" | "app_password";
  authUser?: string | null;
}

/**
 * Met à jour une source.
 *
 * ⚠️ Changer `rest_root` OU `kind` INVALIDE les capacités : elles décrivaient un autre site, ou
 * l'autre chemin de lecture. On les remet à `unknown` plutôt que de laisser un écran afficher « ok »
 * sur une racine jamais sondée — c'est exactement le témoin qui ne témoigne de rien.
 */
export async function updateWpSource(
  db: Db,
  id: string,
  assetId: string,
  patch: WpSourcePatch,
): Promise<{ row: WpSourceRow } | WpSourceError> {
  if (!isUuid(id)) return { error: "source not found" };

  const current = await findWpSource(db, id, assetId);
  if (!current) return { error: "source not found" };

  const fields: Record<string, unknown> = {};
  // Un seul drapeau pour les deux champs qui périment la sonde : deux invalidations écrites deux
  // fois finiraient par diverger, et c'est celle qu'on oublie qui laisse un « Connected » mensonger.
  let probeStale = false;

  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (label === "") return { error: "label is required" };
    fields.label = label;
  }

  if (patch.restRoot !== undefined) {
    const restRoot = normalizeRestRoot(patch.restRoot);
    if (restRoot === "") return { error: "site URL is invalid" };
    fields.rest_root = restRoot;
    if (restRoot !== current.restRoot) probeStale = true;
  }

  if (patch.kind !== undefined) {
    fields.kind = patch.kind;
    // Les capacités d'une source REST ne disent RIEN d'un flux (et réciproquement) : les garder
    // afficherait « 43 articles, filtre par date » sur un chemin de lecture jamais mesuré.
    if (patch.kind !== current.kind) probeStale = true;
  }

  if (probeStale) {
    fields.capabilities = {};
    fields.status = "unknown";
    fields.status_detail = null;
    fields.last_probed_at = null;
  }

  if (patch.defaultCategories !== undefined) {
    fields.default_categories = patch.defaultCategories.filter((n) => Number.isFinite(n));
  }
  if (patch.authKind !== undefined) fields.auth_kind = patch.authKind;
  if (patch.authUser !== undefined) fields.auth_user = patch.authUser?.trim() || null;

  if (Object.keys(fields).length === 0) return { row: current };

  const { data, error } = await db
    .from("wp_source")
    .update(fields)
    .eq("id", id)
    .eq("asset_id", assetId)
    .select(COLS)
    .single();

  if (error) {
    return {
      error: error.code === "23505" ? "a source with this name already exists in this edition" : error.message,
    };
  }
  return { row: toRow(data) };
}

/**
 * Écrit le VERDICT de la sonde. Séparé de `updateWpSource` : c'est la machine qui écrit ici, pas
 * l'opérateur, et les deux ne doivent jamais partager un chemin où l'un pourrait écraser l'autre.
 */
export async function recordProbe(
  db: Db,
  id: string,
  assetId: string,
  result: ProbeResult,
): Promise<WpSourceRow | null> {
  const { data } = await db
    .from("wp_source")
    .update({
      capabilities: result.capabilities as unknown as Record<string, unknown>,
      status: result.ok ? "ok" : "error",
      status_detail: result.detail,
      last_probed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("asset_id", assetId)
    .select(COLS)
    .maybeSingle();

  return data ? toRow(data) : null;
}

/**
 * Supprime une source.
 *
 * Rien de ce qui a déjà été envoyé n'en dépend : la composition COPIE les articles dans le porteur
 * de contenu de l'occurrence. Supprimer une source casse les compositions FUTURES, jamais l'archive
 * de ce qui est parti — et c'est la garantie que le chantier récurrence repose dessus.
 */
export async function deleteWpSource(db: Db, id: string, assetId: string): Promise<WpSourceError | null> {
  if (!isUuid(id)) return { error: "source not found" };
  const { error } = await db.from("wp_source").delete().eq("id", id).eq("asset_id", assetId);
  return error ? { error: error.message } : null;
}
