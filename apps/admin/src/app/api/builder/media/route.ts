import { NextResponse } from "next/server";
import {
  MAX_MEDIA_BYTES,
  MEDIA_BUCKET,
  MEDIA_SOURCES,
  findMediaBySha,
  insertMedia,
  restoreMedia,
  listMedia,
  mediaPath,
  sha256Hex,
  sniffImageMime,
  type MediaSource,
} from "@/lib/data/media";
import { authorEmail } from "@/lib/data/templates";
import { jsonError, requireContext } from "../_shared";

export const runtime = "nodejs";
// La médiathèque change à chaque téléversement : jamais de cache de route.
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const MAX_MB = Math.round(MAX_MEDIA_BYTES / 1024 / 1024);

/** ⚠️ `Number(null)` vaut 0, pas NaN : le paramètre absent doit être écarté AVANT la conversion. */
function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * GET /api/builder/media — page de la MARQUE COURANTE, la plus récente d'abord.
 * Paramètres : `source` (upload|ai|import), `q` (recherche sur l'alt), `limit`, `offset`.
 */
export async function GET(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const params = new URL(req.url).searchParams;

  const rawSource = params.get("source");
  if (rawSource !== null && !(MEDIA_SOURCES as readonly string[]).includes(rawSource)) {
    return jsonError(`unknown source "${rawSource}"`, 400);
  }

  const page = await listMedia(db, asset.id, {
    source: (rawSource as MediaSource | null) ?? undefined,
    q: params.get("q") ?? "",
    limit: intParam(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: intParam(params.get("offset"), 0, 0, 100_000),
  });

  // Une liste vide alors que la requête a échoué ferait croire à une médiathèque vide : on refuse.
  if (page.error) return jsonError(page.error, 500);
  return NextResponse.json({ items: page.items, hasMore: page.hasMore });
}

/**
 * POST /api/builder/media — téléversement (multipart : `file`, `alt` optionnel).
 *
 * Trois pièges que cette route traite explicitement :
 *  1. **Le type vient des octets, pas du client.** Un SVG accepté serait une XSS stockée servie
 *     depuis notre propre domaine (voir `sniffImageMime`).
 *  2. **Déduplication par sha256.** Réuploader la même image renvoie l'entrée existante : c'est ce
 *     qui garde la médiathèque lisible dans six mois, et ça évite de payer deux fois le stockage.
 *  3. **Aucun orphelin dans le bucket.** PostgREST n'a pas de transaction : si l'insertion échoue
 *     après l'upload, on supprime le fichier qu'on vient d'écrire.
 *
 * ⚠️ L'`alt` peut rester VIDE au stockage (l'interface le signale au moment d'insérer) : bloquer le
 * téléversement pour ça ferait perdre le fichier à l'utilisateur, pas gagner l'accessibilité.
 */
export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("expected a multipart/form-data body with a `file` part", 400);
  }

  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) return jsonError("a `file` part is required", 400);
  // Refus AVANT lecture : inutile de charger 40 Mo en mémoire pour les jeter ensuite.
  if (file.size > MAX_MEDIA_BYTES) return jsonError(`that image is too large — the limit is ${MAX_MB} MB`, 413);

  const bytes = Buffer.from(await file.arrayBuffer());
  // `Blob.size` est déclaratif : on revérifie sur les octets réellement reçus.
  if (bytes.byteLength > MAX_MEDIA_BYTES) return jsonError(`that image is too large — the limit is ${MAX_MB} MB`, 413);

  const mime = sniffImageMime(bytes);
  if (!mime) return jsonError("unsupported image format — only PNG, JPEG and WebP are accepted", 415);

  const rawAlt = form.get("alt");
  const alt = (typeof rawAlt === "string" ? rawAlt : "").trim().slice(0, 300);

  const sha256 = await sha256Hex(bytes);
  const existing = await findMediaBySha(db, asset.id, sha256);
  if (existing) {
    // Ces octets sont déjà connus. Si l'entrée avait été archivée, la seule lecture sensée d'un
    // re-téléversement est « je veux cette image » : on la remet dans la bibliothèque, sinon le
    // téléversement afficherait un succès sans que rien n'apparaisse.
    if (existing.archivedAt) await restoreMedia(db, asset.id, existing.id);
    return NextResponse.json({ item: { ...existing, archivedAt: null }, deduplicated: true, restored: Boolean(existing.archivedAt) });
  }

  const path = mediaPath(asset.slug, mime);
  const { error: upErr } = await db.storage.from(MEDIA_BUCKET).upload(path, bytes, {
    contentType: mime,
    upsert: false,
  });
  if (upErr) return jsonError(`could not store the image: ${upErr.message}`, 502);

  const { data: pub } = db.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  const url = pub?.publicUrl;
  if (!url) {
    await db.storage.from(MEDIA_BUCKET).remove([path]);
    return jsonError("the image was stored but no public URL could be built", 500);
  }

  const author = await authorEmail();
  const inserted = await insertMedia(db, {
    assetId: asset.id,
    path,
    url,
    mime,
    bytes: bytes.byteLength,
    sha256,
    alt,
    source: "upload",
    createdBy: author,
  });

  if (!inserted.ok) {
    await db.storage.from(MEDIA_BUCKET).remove([path]);
    if (inserted.duplicate) {
      // Course entre deux téléversements du même fichier : la ligne gagnante fait foi.
      const winner = await findMediaBySha(db, asset.id, sha256);
      if (winner) return NextResponse.json({ item: winner, deduplicated: true });
    }
    return jsonError(`could not record the image: ${inserted.message}`, 500);
  }

  return NextResponse.json({ item: inserted.row, deduplicated: false }, { status: 201 });
}
