/**
 * Génération d'illustrations — apiyi (passerelle compatible OpenAI), avec Gemini en secours rapide.
 *
 * Deux contraintes de terrain gouvernent ce fichier :
 *  1. **gpt-image-2 met 2 à 3 minutes par image.** D'où un timeout de 280 s et, côté produit, des
 *     illustrations DÉCOUPLÉES de la composition (jamais dans le même appel).
 *  2. **Le schéma refuse les `data:` URI** (`ImageSrc` rejette les schémas dangereux) : l'image doit
 *     donc être HÉBERGÉE. On la pousse dans le bucket Supabase Storage et on renvoie une URL publique.
 */
import { getDb } from "@/lib/supabase";

const APIYI_BASE = "https://api.apiyi.com/v1";
const DEFAULT_MODEL = "gpt-image-2-vip";
export const BUCKET = "email-media";

/** Tailles apiyi : les deux côtés doivent être multiples de 16. */
export const SIZE_BY_ASPECT = {
  "16:9": "1024x576",
  "1:1": "1024x1024",
  "4:5": "1024x1280",
} as const;
export type Aspect = keyof typeof SIZE_BY_ASPECT;

/** Un bloc pleine largeur mérite un panoramique ; une vignette, un carré. */
export function aspectForWidth(widthPct: number): Aspect {
  if (widthPct >= 80) return "16:9";
  if (widthPct >= 50) return "1:1";
  return "4:5";
}

export type ImageErrorKind = "not_configured" | "auth" | "quota" | "unavailable" | "timeout" | "server" | "bad_response";

const HTTP_BY_KIND: Record<ImageErrorKind, number> = {
  not_configured: 503,
  auth: 401,
  quota: 402,
  unavailable: 503,
  timeout: 504,
  server: 502,
  bad_response: 502,
};

export class ImageError extends Error {
  readonly kind: ImageErrorKind;
  readonly httpStatus: number;
  constructor(message: string, kind: ImageErrorKind) {
    super(message);
    this.name = "ImageError";
    this.kind = kind;
    this.httpStatus = HTTP_BY_KIND[kind];
  }
}

interface ApiyiImage {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

interface ApiyiResponse {
  data?: ApiyiImage[];
  error?: { message?: string };
}

async function readApiyi(res: Response, elapsedMs: number): Promise<{ bytes: Buffer; mime: string; revisedPrompt?: string }> {
  const raw = await res.text();

  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try {
      const j = JSON.parse(raw) as ApiyiResponse;
      if (j.error?.message) detail = j.error.message;
    } catch {
      /* corps non-JSON */
    }
    // Le message d'apiyi est explicite quand la clé n'a pas accès au modèle : on le remonte tel quel,
    // c'est exactement ce qui permet de diagnostiquer une clé « vidéo » utilisée pour de l'image.
    const kind: ImageErrorKind =
      res.status === 401 || res.status === 403
        ? "auth"
        : res.status === 402
          ? "quota"
          : res.status === 503 || /no available channels/i.test(detail)
            ? "unavailable"
            : "server";
    throw new ImageError(`Image provider refused the request (${res.status}): ${detail}`, kind);
  }

  let body: ApiyiResponse;
  try {
    body = JSON.parse(raw) as ApiyiResponse;
  } catch {
    throw new ImageError("Image provider returned a non-JSON response.", "bad_response");
  }

  const first = body.data?.[0];
  if (!first) throw new ImageError("Image provider returned no image.", "bad_response");

  if (first.b64_json) {
    return { bytes: Buffer.from(first.b64_json, "base64"), mime: "image/png", revisedPrompt: first.revised_prompt };
  }
  if (first.url) {
    // Certains déploiements renvoient une URL éphémère : on la matérialise tout de suite, sinon le
    // lien casse dans l'email quelques heures plus tard.
    const img = await fetch(first.url, { signal: AbortSignal.timeout(Math.max(20_000, 280_000 - elapsedMs)) });
    if (!img.ok) throw new ImageError(`Could not download the generated image (${img.status}).`, "server");
    const mime = img.headers.get("content-type") ?? "image/png";
    return { bytes: Buffer.from(await img.arrayBuffer()), mime, revisedPrompt: first.revised_prompt };
  }
  throw new ImageError("Image provider returned neither b64_json nor url.", "bad_response");
}

/** Texte → image. */
export async function generateImage(a: { prompt: string; aspect: Aspect }): Promise<{ bytes: Buffer; mime: string; revisedPrompt?: string; provider: string; model: string }> {
  const key = process.env.APIYI_API_KEY;
  if (!key) throw new ImageError("APIYI_API_KEY is not configured.", "not_configured");
  const model = process.env.APIYI_MODEL_ID ?? DEFAULT_MODEL;
  const t0 = Date.now();

  let res: Response;
  try {
    res = await fetch(`${APIYI_BASE}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: a.prompt, n: 1, size: SIZE_BY_ASPECT[a.aspect], quality: "high" }),
      signal: AbortSignal.timeout(280_000),
      cache: "no-store",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ImageError("The image provider did not answer within 280 s.", "timeout");
    }
    throw new ImageError(err instanceof Error ? err.message : "Network error calling the image provider.", "server");
  }

  const out = await readApiyi(res, Date.now() - t0);
  return { ...out, provider: "apiyi", model };
}

/**
 * Image de référence + prompt → illustration dans le même style.
 * C'est ce mode qui donne la cohérence visuelle entre les illustrations d'un même template.
 */
export async function editImage(a: { prompt: string; sourceBase64: string; sourceMime: string; aspect: Aspect }): Promise<{ bytes: Buffer; mime: string; revisedPrompt?: string; provider: string; model: string }> {
  const key = process.env.APIYI_API_KEY;
  if (!key) throw new ImageError("APIYI_API_KEY is not configured.", "not_configured");
  const model = process.env.APIYI_MODEL_ID ?? DEFAULT_MODEL;
  const t0 = Date.now();

  const fd = new FormData();
  fd.append("model", model);
  fd.append("prompt", a.prompt);
  fd.append("n", "1");
  fd.append("size", SIZE_BY_ASPECT[a.aspect]);
  fd.append("quality", "high");
  const bin = Buffer.from(a.sourceBase64, "base64");
  fd.append("image[]", new Blob([new Uint8Array(bin)], { type: a.sourceMime || "image/png" }), "source.png");

  let res: Response;
  try {
    res = await fetch(`${APIYI_BASE}/images/edits`, {
      method: "POST",
      // ⚠️ Pas de Content-Type manuel : FormData pose lui-même la boundary.
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: AbortSignal.timeout(280_000),
      cache: "no-store",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ImageError("The image provider did not answer within 280 s.", "timeout");
    }
    throw new ImageError(err instanceof Error ? err.message : "Network error calling the image provider.", "server");
  }

  const out = await readApiyi(res, Date.now() - t0);
  return { ...out, provider: "apiyi", model };
}

/* ------------------------------------------------------------------ hébergement */

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Pousse l'image dans le bucket Storage et renvoie une URL PUBLIQUE stable.
 * Indispensable : `ImageSrc` du schéma refuse les `data:` URI, et un email doit pointer une URL.
 */
export async function hostImage(a: {
  bytes: Buffer;
  mime: string;
  assetId: string;
  assetSlug: string;
  alt: string;
  authorEmail: string | null;
}): Promise<{ src: string; path: string }> {
  const db = getDb();
  if (!db) throw new ImageError("Storage is unavailable (Supabase not configured).", "not_configured");

  const ext = EXT_BY_MIME[a.mime] ?? "png";
  const year = new Date().getFullYear();
  const path = `${a.assetSlug}/${year}/${crypto.randomUUID()}.${ext}`;

  const { error: upErr } = await db.storage.from(BUCKET).upload(path, a.bytes, { contentType: a.mime, upsert: false });
  if (upErr) throw new ImageError(`Could not store the image: ${upErr.message}`, "server");

  const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);
  const src = pub?.publicUrl;
  if (!src) throw new ImageError("The image was stored but no public URL could be built.", "server");

  // Trace dans la médiathèque : l'image devient réutilisable ailleurs et traçable (source = 'ai').
  const sha = await crypto.subtle.digest("SHA-256", new Uint8Array(a.bytes)).then((b) =>
    Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join(""),
  );
  await db.from("media_asset").insert({
    asset_id: a.assetId,
    path,
    url: src,
    mime: a.mime,
    bytes: a.bytes.length,
    sha256: sha,
    alt: a.alt.slice(0, 300),
    source: "ai",
    created_by: a.authorEmail,
  });

  return { src, path };
}
