import { NextResponse } from "next/server";
import { requireAiContext, providerError, statusOf, jsonError } from "../_shared";
import { ArtDirection, type ArtDirectionT } from "@/lib/ai/direction";
import { aspectForWidth, generateImage, hostImage } from "@/lib/ai/images";
import { logGeneration } from "@/lib/ai/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body {
  prompt?: string;
  alt?: string;
  direction?: unknown;
  widthPct?: number;
}

/** Consignes de style dérivées de la direction — c'est ce qui rend les illustrations cohérentes entre elles. */
function styleSuffix(d: ArtDirectionT): string {
  const colors = [d.palette.brandColor, d.palette.contentBackground, d.palette.textColor].join(", ");
  const notes = d.notes ? ` ${d.notes}` : "";
  return [
    `Mood: ${d.mood}.${notes}`,
    `Dominant colours: ${colors}.`,
    `Composition: ${d.density === "airy" ? "generous negative space" : d.density === "compact" ? "tight, focused framing" : "balanced framing"}.`,
    // Un texte rendu DANS l'image est illisible en dark mode et intraduisible : la copie vit dans les blocs.
    "Absolutely no text, words, letters, numbers, logos or watermarks inside the image.",
  ].join(" ");
}

/**
 * Étape 3 — une illustration à la fois.
 *
 * Découpage volontaire : gpt-image-2 met 2 à 3 min par image, donc grouper N images dans un appel
 * garantirait le timeout. L'UI boucle image par image et affiche l'avancement.
 * La réponse renvoie une URL **hébergée** (Storage) : `ImageSrc` du schéma refuse les `data:` URI.
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

  const prompt = (body.prompt ?? "").trim().slice(0, 2000);
  if (!prompt) return jsonError("A prompt is required to generate an illustration.", 400);

  const alt = (body.alt ?? "").trim().slice(0, 300);
  if (!alt) return jsonError("Alternative text is required — an image without alt is not accessible.", 400);

  const parsed = ArtDirection.safeParse(body.direction);
  if (!parsed.success) return jsonError("The art direction is invalid.", 400, { code: "invalid_doc" });

  const widthPct = Number.isFinite(body.widthPct) ? Math.min(100, Math.max(10, Number(body.widthPct))) : 100;
  const aspect = aspectForWidth(widthPct);

  const t0 = Date.now();
  try {
    const img = await generateImage({ prompt: `${prompt}\n\n${styleSuffix(parsed.data)}`, aspect });
    const hosted = await hostImage({
      bytes: img.bytes,
      mime: img.mime,
      assetId: asset.id,
      assetSlug: asset.slug,
      alt,
      authorEmail,
    });

    await logGeneration(db, {
      assetId: asset.id,
      step: "illustrate",
      provider: img.provider,
      model: img.model,
      durationMs: Date.now() - t0,
      status: "ok",
      authorEmail,
    });

    return NextResponse.json({ src: hosted.src, revisedPrompt: img.revisedPrompt });
  } catch (err) {
    await logGeneration(db, {
      assetId: asset.id,
      step: "illustrate",
      provider: "apiyi",
      model: process.env.APIYI_MODEL_ID ?? "gpt-image-2-vip",
      durationMs: Date.now() - t0,
      status: statusOf(err),
      error: err instanceof Error ? err.message : String(err),
      authorEmail,
    });
    return providerError(err);
  }
}
