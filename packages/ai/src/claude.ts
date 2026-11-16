/**
 * Client Claude (API Messages) — serveur uniquement.
 *
 * Pas de SDK : `@anthropic-ai/sdk` n'est pas installé et un `fetch` suffit. On garde donc la main
 * sur les trois choses qui font échouer ce genre d'intégration en silence :
 *  1. **Timeout explicite en millisecondes.** Un job LLM long sans timeout est le mode de panne le
 *     plus coûteux à diagnostiquer (incident projet documenté).
 *  2. **Classification des erreurs.** Un crédit Anthropic à zéro dégrade la prod SANS bruit
 *     (incident 02-04/08) : 401 (auth), 402 (crédit) et 429 (rate) doivent être distinguables.
 *  3. **`stop_reason === "refusal"` testé AVANT de lire `content`** — sinon on plante sur `content[0]`.
 *
 * Prompt caching : le system prompt est marqué `ephemeral`. Il doit rester BYTE-STABLE d'un appel à
 * l'autre (aucun `Date.now()`, aucune interpolation) — tout ce qui varie passe par le message user.
 */

export const CLAUDE_MODEL = process.env.NF_AI_MODEL ?? "claude-opus-5";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * FILET ANTI-REFUS (server-side fallbacks).
 *
 * Nos briefs parlent de paris sportifs : un refus de politique est un risque REEL, pas theorique.
 * Sans ce parametre, un refus se contente d'arreter la requete. Avec lui, l'API rejoue la meme
 * requete sur un modele de repli DANS LE MEME APPEL — le refus ne remonte en erreur que si toute
 * la chaine refuse. Reserve aux modeles qui exposent `stop_reason: "refusal"`.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const SUPPORTS_FALLBACK = /^claude-(?:opus-5|fable-5|mythos-5)$/;

/**
 * ⚠️ `budget_tokens` est REJETE (400) sur Opus 5 / 4.8 / 4.7, ainsi que le preremplissage assistant :
 * ne jamais en ajouter ici. La profondeur de raisonnement se regle par `output_config.effort`.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeErrorKind =
  | "auth"
  | "credit"
  | "rate"
  | "overloaded"
  | "timeout"
  | "refusal"
  | "server"
  | "bad_response"
  | "not_configured";

/** Statut HTTP à renvoyer au client pour chaque nature d'erreur (le client les classe déjà). */
const HTTP_BY_KIND: Record<ClaudeErrorKind, number> = {
  auth: 401,
  credit: 402,
  rate: 429,
  overloaded: 503,
  timeout: 504,
  refusal: 422,
  server: 502,
  bad_response: 422,
  not_configured: 503,
};

export class ClaudeError extends Error {
  readonly kind: ClaudeErrorKind;
  readonly httpStatus: number;
  readonly issues: string[];

  constructor(message: string, kind: ClaudeErrorKind, issues: string[] = []) {
    super(message);
    this.name = "ClaudeError";
    this.kind = kind;
    this.httpStatus = HTTP_BY_KIND[kind];
    this.issues = issues;
  }
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const EMPTY_USAGE: ClaudeUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Bloc de contenu utilisateur : texte, ou image pour la vision. */
export type UserBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

interface ClaudeResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  /** Rempli UNIQUEMENT quand `stop_reason === "refusal"` — null pour tous les autres arrets. */
  stop_details?: { type?: string; category?: string | null; explanation?: string | null } | null;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export async function callClaude(opts: {
  system: string;
  userContent: string | UserBlock[];
  maxTokens: number;
  timeoutMs: number;
  model?: string;
  /** Profondeur de raisonnement. Omis = `high` (defaut API). */
  effort?: Effort;
}): Promise<{ text: string; usage: ClaudeUsage; model: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ClaudeError("ANTHROPIC_API_KEY is not configured.", "not_configured");

  const model = opts.model ?? CLAUDE_MODEL;
  const content = typeof opts.userContent === "string" ? [{ type: "text", text: opts.userContent }] : opts.userContent;
  const withFallback = SUPPORTS_FALLBACK.test(model);

  const headers: Record<string, string> = {
    "x-api-key": key,
    "anthropic-version": API_VERSION,
    "content-type": "application/json",
  };
  if (withFallback) headers["anthropic-beta"] = FALLBACK_BETA;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens,
        // Le system est un tableau pour porter `cache_control` : le prefixe statique est mis en cache
        // (×0,1 sur l'input), ce qui rend l'itération économique.
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
        ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
        // "default" = routage par categorie de refus, sans liste de modeles a maintenir.
        ...(withFallback ? { fallbacks: "default" } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ClaudeError(`Claude did not answer within ${Math.round(opts.timeoutMs / 1000)} s.`, "timeout");
    }
    throw new ClaudeError(err instanceof Error ? err.message : "Network error calling Claude.", "server");
  }

  const raw = await res.text();

  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      /* corps non-JSON : on garde le texte brut tronqué */
    }
    const kind: ClaudeErrorKind =
      res.status === 401 || res.status === 403
        ? "auth"
        : res.status === 402
          ? "credit"
          : res.status === 429
            ? "rate"
            : res.status === 529
              ? "overloaded"
              : "server";
    // Message oriente l'opérateur : « crédit épuisé » est actionnable, « 402 » ne l'est pas.
    const prefix =
      kind === "credit"
        ? "Anthropic credit exhausted — top up the account. "
        : kind === "auth"
          ? "Anthropic rejected the API key. "
          : kind === "rate"
            ? "Anthropic rate limit reached — retry shortly. "
            : kind === "overloaded"
              ? "Anthropic is overloaded — retry shortly. "
              : "";
    throw new ClaudeError(prefix + detail, kind);
  }

  let body: ClaudeResponse;
  try {
    body = JSON.parse(raw) as ClaudeResponse;
  } catch {
    throw new ClaudeError("Claude returned a non-JSON response.", "bad_response");
  }

  const usage: ClaudeUsage = {
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    cacheReadTokens: body.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: body.usage?.cache_creation_input_tokens ?? 0,
  };

  // ⚠️ Teste AVANT la lecture de `content` : un refus renvoie 200 avec un contenu absent.
  // A ce stade il signifie que le modele de repli a refuse AUSSI : le filet a deja joue cote serveur.
  if (body.stop_reason === "refusal") {
    const cat = body.stop_details?.category;
    throw new ClaudeError(
      `Claude declined to answer this request${cat ? ` (category: ${cat})` : ""}. Reword the brief.`,
      "refusal",
    );
  }

  // Seuls les blocs `text` sont lus : sur Opus 5 la reflexion est active PAR DEFAUT et ajoute des
  // blocs `thinking` qu'il ne faut ni parser ni concatener.
  const text = (body.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");

  // Une reponse coupee au plafond produit du JSON tronque. On le DIT, au lieu de laisser le message
  // trompeur « answer was not valid JSON » envoyer l'operateur sur une fausse piste.
  if (body.stop_reason === "max_tokens") {
    throw new ClaudeError(
      `Claude's answer was cut off at the ${opts.maxTokens}-token ceiling, so the document is incomplete. Shorten the brief or raise the limit.`,
      "bad_response",
    );
  }

  if (text.trim() === "") throw new ClaudeError("Claude returned an empty answer.", "bad_response");

  return { text, usage, model: body.model ?? model };
}

/** Retire les fences ```json et isole le premier objet JSON complet. */
export function parseJsonLoose<T>(text: string): T {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!s.startsWith("{") && !s.startsWith("[")) {
    const start = s.search(/[{[]/);
    if (start >= 0) s = s.slice(start);
  }
  const lastBrace = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (lastBrace >= 0) s = s.slice(0, lastBrace + 1);
  try {
    return JSON.parse(s) as T;
  } catch {
    throw new ClaudeError("Claude's answer was not valid JSON.", "bad_response");
  }
}

/**
 * Cout indicatif en centimes, tarif Opus (5 $/M entree, 25 $/M sortie).
 * L'ECRITURE de cache est facturee ~1,25x l'entree et la LECTURE ~0,1x : les deux sont comptees
 * separement, sinon le compteur sous-estime le premier appel et surestime les suivants.
 */
export function estimateCostCents(u: ClaudeUsage): number {
  const inputCost = (u.inputTokens / 1_000_000) * 5 * 100;
  const cacheWriteCost = (u.cacheWriteTokens / 1_000_000) * 6.25 * 100;
  const cacheReadCost = (u.cacheReadTokens / 1_000_000) * 0.5 * 100;
  const outputCost = (u.outputTokens / 1_000_000) * 25 * 100;
  return Math.round((inputCost + cacheWriteCost + cacheReadCost + outputCost) * 10_000) / 10_000;
}

export { EMPTY_USAGE };
