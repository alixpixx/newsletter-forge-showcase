import { NextResponse } from "next/server";
import { requireAiContext, providerError, statusOf, jsonError } from "../_shared";
import { analyzeArtDirection } from "@/lib/ai/direction";
import { logGeneration } from "@/lib/ai/log";
import { estimateCostCents } from "@/lib/ai/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Signatures binaires — un MIME déclaré ne prouve rien (un SVG accepté = XSS stocké). */
const MAGIC: { mime: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/webp",
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  {
    // GIF87a / GIF89a. Accepte parce que la zone de depot le propose : une interface qui annonce un
    // format que l'API refuse fait attendre l'utilisateur pour lui rendre une erreur.
    mime: "image/gif",
    test: (b) =>
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  },
];

const MAX_BYTES = 5 * 1024 * 1024;

interface Body {
  image?: { base64?: string; mediaType?: string };
  prompt?: string;
  category?: string;
}

/**
 * Étape 1 — analyse l'image de référence et renvoie une direction graphique éditable.
 * Le client envoie l'image en base64 (JSON), ce qui évite un parsing multipart pour ~1-5 Mo.
 */
export async function POST(req: Request) {
  const c = await requireAiContext();
  if (!c.ok) return c.res;
  const { db, asset, authorEmail } = c.ctx;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const base64 = (body.image?.base64 ?? "").replace(/^data:[^;]+;base64,/, "").trim();
  if (!base64) return jsonError("A reference image is required.", 400);

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return jsonError("The image could not be decoded.", 400);
  }
  if (bytes.length === 0) return jsonError("The image is empty.", 400);
  if (bytes.length > MAX_BYTES) {
    return jsonError(`The image is ${(bytes.length / 1048576).toFixed(1)} MB — the limit is 5 MB.`, 413);
  }

  // ⚠️ Le type est déduit des MAGIC BYTES, jamais du `mediaType` annoncé par le client.
  const head = new Uint8Array(bytes.subarray(0, 16));
  const detected = MAGIC.find((m) => m.test(head))?.mime;
  if (!detected) {
    return jsonError("Only PNG, JPEG, WebP and GIF images are accepted (detected from the file itself, not from what the browser claims).", 415);
  }

  const t0 = Date.now();
  try {
    const { direction, usage, model, warnings } = await analyzeArtDirection({
      imageBase64: base64,
      mediaType: detected,
      brief: (body.prompt ?? "").slice(0, 4000),
      category: (body.category ?? "newsletter").slice(0, 40),
    });

    await logGeneration(db, {
      assetId: asset.id,
      step: "art_direction",
      provider: "anthropic",
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costCents: estimateCostCents(usage),
      durationMs: Date.now() - t0,
      status: "ok",
      authorEmail,
    });

    return NextResponse.json({ direction, warnings });
  } catch (err) {
    await logGeneration(db, {
      assetId: asset.id,
      step: "art_direction",
      provider: "anthropic",
      model: process.env.NF_AI_MODEL ?? "claude-opus-4-8",
      durationMs: Date.now() - t0,
      status: statusOf(err),
      error: err instanceof Error ? err.message : String(err),
      authorEmail,
    });
    return providerError(err);
  }
}
