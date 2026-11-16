import { NextResponse } from "next/server";
import { requireContext } from "@/app/api/builder/_shared";
import { CLAUDE_MODEL } from "@/lib/ai/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ai/health — dit si le générateur est utilisable AVANT de lancer une génération de 3 min.
 *
 * ⚠️ Ne renvoie jamais de valeur de clé, seulement sa PRÉSENCE. L'UI s'en sert pour désactiver
 * l'étape correspondante avec un message net au lieu d'un échec après 4 minutes d'attente.
 */
export async function GET() {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const text = Boolean(process.env.ANTHROPIC_API_KEY);
  const images = Boolean(process.env.APIYI_API_KEY);

  return NextResponse.json({
    ready: text,
    text: { configured: text, model: CLAUDE_MODEL },
    images: { configured: images, model: process.env.APIYI_MODEL_ID ?? "gpt-image-2-vip" },
    maxPerHour: Number(process.env.NF_AI_MAX_GEN_PER_HOUR ?? 20),
    asset: { slug: c.ctx.asset.slug, name: c.ctx.asset.name },
  });
}
