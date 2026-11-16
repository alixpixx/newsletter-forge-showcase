import { NextResponse } from "next/server";
import { requireContext, jsonError, type Context } from "@/app/api/builder/_shared";
import { checkRateLimit } from "@/lib/ai/log";
import { ClaudeError } from "@/lib/ai/claude";
import { ImageError } from "@/lib/ai/images";

/**
 * Socle commun des routes `app/api/ai/**`.
 *
 * Réutilise `requireContext()` du builder (base + marque garanties, 503 sinon) et y ajoute les deux
 * garde-fous propres à l'IA : le rate limit par utilisateur, et une traduction d'erreur qui préserve
 * la NATURE du problème (crédit épuisé ≠ erreur serveur). Le client classe déjà 401/402/429.
 */

export type AiContext = Context & { authorEmail: string | null };

export async function requireAiContext(): Promise<{ ok: true; ctx: AiContext } | { ok: false; res: NextResponse }> {
  const base = await requireContext();
  if (!base.ok) return base;

  // ⚠️ Vient du contexte, plus d'une lecture de cookie propre à ce module : `requireContext()`
  // a déjà refusé si l'identité manque, donc l'e-mail est ici toujours renseigné — là où la
  // lecture précédente rendait `null` en silence et faisait porter le rate limit à personne,
  // c'est-à-dire à tout le monde en commun.
  const authorEmail = base.ctx.user.email;

  const rl = await checkRateLimit(base.ctx.db, authorEmail);
  if (!rl.ok) {
    return {
      ok: false,
      res: jsonError(
        `Rate limit reached: ${rl.used}/${rl.limit} generations in the last hour. Try again later.`,
        429,
        { code: "rate_limit" },
      ),
    };
  }

  return { ok: true, ctx: { ...base.ctx, authorEmail } };
}

/** Traduit une erreur de provider en réponse HTTP fidèle à sa nature. */
export function providerError(err: unknown): NextResponse {
  if (err instanceof ClaudeError) {
    return jsonError(err.message, err.httpStatus, {
      code: err.kind === "bad_response" || err.kind === "refusal" ? "invalid_doc" : err.kind,
      ...(err.issues.length ? { issues: err.issues } : {}),
    });
  }
  if (err instanceof ImageError) {
    return jsonError(err.message, err.httpStatus, { code: err.kind });
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  return jsonError(message, 502, { code: "server" });
}

/** Statut d'audit déduit de l'erreur, pour `ai_generation.status`. */
export function statusOf(err: unknown): "invalid_doc" | "refusal" | "timeout" | "error" {
  if (err instanceof ClaudeError) {
    if (err.kind === "bad_response") return "invalid_doc";
    if (err.kind === "refusal") return "refusal";
    if (err.kind === "timeout") return "timeout";
  }
  if (err instanceof ImageError && err.kind === "timeout") return "timeout";
  return "error";
}

export { jsonError };
