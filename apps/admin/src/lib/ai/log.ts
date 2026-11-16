/**
 * Journalisation des générations IA + rate limit.
 *
 * Une seule table (`newsletter.ai_generation`) résout trois besoins d'un coup : l'audit, la limite
 * de débit, et le suivi de coût. Elle rend surtout VISIBLE la panne silencieuse : une série de
 * `status='error'` sur le provider `anthropic` = crédit épuisé (incident prod documenté).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any, any, any>;

export type GenStep = "art_direction" | "compose" | "illustrate";
export type GenStatus = "ok" | "invalid_doc" | "refusal" | "error" | "timeout";

export interface GenLogRow {
  assetId: string | null;
  templateId?: string | null;
  step: GenStep;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costCents?: number;
  durationMs: number;
  status: GenStatus;
  error?: string | null;
  authorEmail?: string | null;
}

/**
 * Écrit une ligne d'audit. **Jamais bloquant** : si le log échoue, la génération réussie ne doit pas
 * être transformée en erreur pour l'utilisateur.
 */
export async function logGeneration(db: Db | null, row: GenLogRow): Promise<void> {
  if (!db) return;
  try {
    await db.from("ai_generation").insert({
      asset_id: row.assetId,
      template_id: row.templateId ?? null,
      step: row.step,
      provider: row.provider,
      model: row.model,
      input_tokens: row.inputTokens ?? null,
      output_tokens: row.outputTokens ?? null,
      cache_read_tokens: row.cacheReadTokens ?? null,
      cache_write_tokens: row.cacheWriteTokens ?? null,
      cost_cents: row.costCents ?? null,
      duration_ms: row.durationMs,
      status: row.status,
      error: row.error ? row.error.slice(0, 500) : null,
      author_email: row.authorEmail ?? null,
    });
  } catch {
    /* volontairement avalé : l'audit ne doit jamais casser le produit */
  }
}

export interface RateLimitVerdict {
  ok: boolean;
  used: number;
  limit: number;
}

/**
 * Limite par utilisateur et par heure. Motif : une boucle client bugguée peut brûler le crédit
 * Anthropic en quelques minutes, et le crédit à zéro est un point de panne unique en production.
 */
export async function checkRateLimit(db: Db | null, authorEmail: string | null): Promise<RateLimitVerdict> {
  const limit = Number(process.env.NF_AI_MAX_GEN_PER_HOUR ?? 20);
  if (!db || !authorEmail) return { ok: true, used: 0, limit };

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error } = await db
    .from("ai_generation")
    .select("*", { count: "exact", head: true })
    .eq("author_email", authorEmail)
    .gte("created_at", since);

  // En cas d'erreur de lecture on laisse passer : mieux vaut une génération de trop qu'un blocage
  // total du produit sur un incident de base.
  if (error) return { ok: true, used: 0, limit };

  const used = count ?? 0;
  return { ok: used < limit, used, limit };
}
