import { NextResponse } from "next/server";
import { requireAiContext, providerError, statusOf, jsonError } from "../_shared";
import { ArtDirection } from "@/lib/ai/direction";
import { composeDoc } from "@/lib/ai/compose";
import { logGeneration } from "@/lib/ai/log";
import { estimateCostCents } from "@/lib/ai/claude";
import { issuesOf } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body {
  prompt?: string;
  category?: string;
  direction?: unknown;
  name?: string;
}

/**
 * Étape 2 — compose le document. La réponse contient un `EmailDoc` DÉJÀ VALIDÉ côté serveur :
 * un document non conforme ne parvient jamais au client, il fait un 422 avec les issues Zod.
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

  // La direction vient du client (l'utilisateur a pu la corriger) → on la revalide intégralement.
  const parsedDirection = ArtDirection.safeParse(body.direction);
  if (!parsedDirection.success) {
    return jsonError("The art direction is invalid.", 400, {
      code: "invalid_doc",
      issues: issuesOf(parsedDirection.error),
    });
  }

  // ⚠️ La langue vient de la MARQUE, jamais du prompt utilisateur (règle du kit de conformité).
  const locale = asset.languages?.[0] ?? "en";

  const t0 = Date.now();
  try {
    const out = await composeDoc({
      direction: parsedDirection.data,
      brief: (body.prompt ?? "").slice(0, 6000),
      assetName: asset.name,
      assetSlug: asset.slug,
      locale,
      category: (body.category ?? "newsletter").slice(0, 40),
      name: (body.name ?? asset.name).slice(0, 120),
    });

    await logGeneration(db, {
      assetId: asset.id,
      step: "compose",
      provider: "anthropic",
      model: out.model,
      inputTokens: out.usage.inputTokens,
      outputTokens: out.usage.outputTokens,
      cacheReadTokens: out.usage.cacheReadTokens,
      cacheWriteTokens: out.usage.cacheWriteTokens,
      costCents: estimateCostCents(out.usage),
      durationMs: Date.now() - t0,
      status: "ok",
      authorEmail,
    });

    const warnings = out.repaired
      ? [...out.warnings, "The first attempt did not validate; the document was regenerated once."]
      : out.warnings;

    return NextResponse.json({ doc: out.doc, subject: out.subject, preheader: out.preheader, warnings });
  } catch (err) {
    await logGeneration(db, {
      assetId: asset.id,
      step: "compose",
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
