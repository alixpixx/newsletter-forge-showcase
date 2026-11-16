import { BUCKET } from "@/lib/ai/images";
// Une seule définition de « ceci ressemble-t-il à un uuid ? » dans tout l'admin : un id non-uuid
// envoyé à PostgREST déclenche un 400 (22P02) au lieu du 404 attendu.
import { isUuid } from "@/lib/data/templates";
import { getDb } from "@/lib/supabase";

/**
 * Accès serveur à la MÉDIATHÈQUE (`newsletter.media_asset` + bucket Storage `email-media`).
 *
 * Le bucket et les conventions de chemin/colonnes sont celles de `hostImage` (lib/ai/images.ts) :
 * une image générée par l'IA et une image téléversée à la main doivent être RIGOUREUSEMENT
 * interchangeables, sinon la médiathèque se scinde en deux stocks qui divergent.
 *
 * ⚠️ INVARIANT : tout est scopé par marque (`asset_id`). Une image d'une autre marque doit être
 * indiscernable d'une image inexistante.
 */

type Db = NonNullable<ReturnType<typeof getDb>>;

export const MEDIA_BUCKET = BUCKET;

/** Plafond de téléversement. Aligné sur `ArtworkDrop` pour que l'utilisateur voie la même limite partout. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

/** Doit rester aligné sur le CHECK de `newsletter.media_asset.source` (migration 0018). */
export const MEDIA_SOURCES = ["upload", "ai", "import"] as const;
export type MediaSource = (typeof MEDIA_SOURCES)[number];

export interface MediaRow {
  id: string;
  url: string;
  alt: string;
  mime: string;
  bytes: number;
  source: MediaSource;
  createdAt: string;
  /** Non-null = retirée de la bibliothèque. La ligne et le fichier sont conservés (migration 0021). */
  archivedAt: string | null;
}

const SELECT = "id, url, alt, mime, bytes, source, created_at, archived_at";

function toRow(raw: unknown): MediaRow {
  const r = raw as Record<string, unknown>;
  const source = String(r.source ?? "upload");
  return {
    id: String(r.id ?? ""),
    url: String(r.url ?? ""),
    alt: typeof r.alt === "string" ? r.alt : "",
    mime: String(r.mime ?? "image/png"),
    bytes: Number(r.bytes ?? 0),
    source: (MEDIA_SOURCES as readonly string[]).includes(source) ? (source as MediaSource) : "upload",
    createdAt: String(r.created_at ?? ""),
    archivedAt: r.archived_at ? String(r.archived_at) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Type réel du fichier
 * ------------------------------------------------------------------ */

/** Formats servis dans un email. Le SVG est volontairement absent : c'est du script exécutable. */
const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

export type AcceptedMime = keyof typeof EXT_BY_MIME;
export const ACCEPTED_MIMES = Object.keys(EXT_BY_MIME) as AcceptedMime[];

const ascii = (b: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...Array.from(b.subarray(from, to)));

/**
 * Type déduit des OCTETS D'EN-TÊTE, jamais du `Content-Type` annoncé par le client.
 *
 * C'est la seule défense qui tient : un `.svg` renommé `.png` et annoncé `image/png` serait servi
 * depuis notre domaine et exécuterait son `<script>` — XSS stockée. Un fichier dont l'en-tête ne
 * correspond à aucun format accepté est refusé, point.
 */
export function sniffImageMime(b: Uint8Array): AcceptedMime | null {
  // PNG : signature 8 octets \x89PNG\r\n\x1a\n
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG : SOI (FF D8) suivi du premier marqueur (FF xx)
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  // WebP : conteneur RIFF, avec le type de forme « WEBP » aux octets 8..12
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Même convention que `hostImage` : `{assetSlug}/{yyyy}/{uuid}.{ext}`. */
export const mediaPath = (assetSlug: string, mime: AcceptedMime): string =>
  `${assetSlug}/${new Date().getFullYear()}/${crypto.randomUUID()}.${EXT_BY_MIME[mime]}`;

/** SHA-256 hexadécimal — la clé de déduplication (`unique (asset_id, sha256)`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------------------------------------------ *
 * Lectures
 * ------------------------------------------------------------------ */

/**
 * PostgREST n'expose pas de clause ESCAPE : un `%` ou un `_` saisi deviendrait un joker silencieux,
 * et une virgule ou une parenthèse casserait le parsing du filtre. On retire ces caractères plutôt
 * que de bricoler un échappement qui n'existe pas côté serveur.
 */
const sanitizeSearch = (v: string): string => v.replace(/[%_,()*\\"']/g, " ").trim().slice(0, 120);

export interface MediaQuery {
  source?: MediaSource;
  q?: string;
  limit: number;
  offset: number;
}

export interface MediaPage {
  items: MediaRow[];
  hasMore: boolean;
  /** Non-null = la base a refusé la requête. L'appelant renvoie une erreur nette, pas une liste vide. */
  error: string | null;
}

/**
 * Page de médias de la marque, la plus récente d'abord.
 *
 * On demande `limit + 1` lignes pour savoir s'il en reste, plutôt qu'un `count: exact` : le COUNT
 * exact coûte un second scan à chaque frappe dans la recherche, et personne ne lit ce total.
 */
export async function listMedia(db: Db, assetId: string, query: MediaQuery): Promise<MediaPage> {
  const limit = Math.min(100, Math.max(1, Math.trunc(query.limit)));
  const offset = Math.max(0, Math.trunc(query.offset));

  // Les archivées ne sont plus proposées : leur ligne et leur fichier restent, mais la
  // bibliothèque cesse de les offrir à l'insertion.
  let sel = db.from("media_asset").select(SELECT).eq("asset_id", assetId).is("archived_at", null);
  if (query.source) sel = sel.eq("source", query.source);

  const term = sanitizeSearch(query.q ?? "");
  if (term) sel = sel.ilike("alt", `%${term}%`);

  const { data, error } = await sel.order("created_at", { ascending: false }).range(offset, offset + limit);
  if (error) return { items: [], hasMore: false, error: error.message };

  const rows = ((data as unknown[]) ?? []).map(toRow);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit, error: null };
}

/**
 * Une image de la MARQUE COURANTE, ou `null`.
 *
 * `null` couvre les deux cas volontairement : image inexistante ET image d'une autre marque. Le
 * routeur en fait un 404 dans les deux cas — répondre 403 sur la seconde révélerait qu'un id
 * existe ailleurs.
 */
export async function findMedia(db: Db, assetId: string, id: string): Promise<MediaRow | null> {
  if (!isUuid(id)) return null;
  const { data } = await db
    .from("media_asset")
    .select(SELECT)
    .eq("id", id)
    .eq("asset_id", assetId)
    .maybeSingle();
  return data ? toRow(data) : null;
}

/** Entrée déjà présente pour ces octets exacts — le cœur de la déduplication. */
export async function findMediaBySha(db: Db, assetId: string, sha256: string): Promise<MediaRow | null> {
  const { data } = await db
    .from("media_asset")
    .select(SELECT)
    .eq("asset_id", assetId)
    .eq("sha256", sha256)
    .maybeSingle();
  return data ? toRow(data) : null;
}

/* ------------------------------------------------------------------ *
 * Écriture
 * ------------------------------------------------------------------ */

export interface MediaInsert {
  assetId: string;
  path: string;
  url: string;
  mime: AcceptedMime;
  bytes: number;
  sha256: string;
  alt: string;
  source: MediaSource;
  createdBy: string | null;
}

export type MediaInsertResult =
  | { ok: true; row: MediaRow }
  /** `duplicate` = deux téléversements simultanés du même fichier ; l'appelant relit la ligne gagnante. */
  | { ok: false; duplicate: boolean; message: string };

export async function insertMedia(db: Db, input: MediaInsert): Promise<MediaInsertResult> {
  const { data, error } = await db
    .from("media_asset")
    .insert({
      asset_id: input.assetId,
      path: input.path,
      url: input.url,
      mime: input.mime,
      bytes: input.bytes,
      sha256: input.sha256,
      alt: input.alt.slice(0, 300),
      source: input.source,
      created_by: input.createdBy,
    })
    .select(SELECT)
    .single();

  if (error) {
    return { ok: false, duplicate: error.code === "23505", message: error.message };
  }
  if (!data) return { ok: false, duplicate: false, message: "the media row was not returned after insert" };
  return { ok: true, row: toRow(data) };
}

/**
 * Réécrit l'`alt` STOCKÉ. C'est le défaut proposé à chaque insertion : sans cette écriture, un alt
 * saisi dans le sélecteur ne vivait que dans le bloc image, et la même photo réinsérée ailleurs
 * revenait muette — un défaut d'accessibilité qui se répare autant de fois qu'on utilise l'image.
 *
 * `null` = rien à mettre à jour pour cette marque (voir `findMedia`).
 */
export async function updateMediaAlt(db: Db, assetId: string, id: string, alt: string): Promise<MediaRow | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await db
    .from("media_asset")
    .update({ alt: alt.slice(0, 300) })
    .eq("id", id)
    .eq("asset_id", assetId)
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toRow(data) : null;
}

/**
 * ARCHIVE l'image : elle quitte la bibliothèque, sa ligne et son fichier restent.
 *
 * POURQUOI ne pas supprimer le FICHIER : son URL publique est figée dans les documents déjà publiés
 * et dans les emails DÉJÀ REÇUS. Le client de messagerie va la chercher à l'ouverture — détruire
 * l'objet remplacerait rétroactivement l'image par un trou dans des boîtes qu'on ne contrôle plus.
 *
 * POURQUOI ne pas supprimer la LIGNE non plus : l'empreinte `(asset_id, sha256)` est le cœur de la
 * déduplication. La perdre ferait qu'un re-téléversement des mêmes octets crée une entrée neuve
 * pointant vers un SECOND fichier identique — l'ancien devenant un orphelin que plus rien ne
 * référence, donc impossible à nettoyer sans deviner. Supprimer la ligne en gardant le fichier
 * était le pire des deux mondes ; c'est ce que corrige la migration 0021.
 */
export async function removeMedia(db: Db, assetId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { data, error } = await db
    .from("media_asset")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("asset_id", assetId)
    .is("archived_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return ((data as unknown[]) ?? []).length > 0;
}

/**
 * Remet une image archivée dans la bibliothèque.
 *
 * Appelée quand quelqu'un re-téléverse des octets déjà connus : la déduplication retrouve la ligne,
 * et la seule lecture sensée de ce geste est « je veux cette image ». La laisser archivée
 * afficherait un succès de téléversement sans que rien n'apparaisse dans la bibliothèque.
 */
export async function restoreMedia(db: Db, assetId: string, id: string): Promise<void> {
  await db
    .from("media_asset")
    .update({ archived_at: null })
    .eq("id", id)
    .eq("asset_id", assetId);
}
