/**
 * CLIENT des routes `/api/ai/*` — un seul endroit où le contrat réseau est écrit.
 *
 * Deux exigences du projet sont tenues ici, pas ailleurs :
 *  1. **Timeouts explicites, en millisecondes.** Le budget client est volontairement supérieur au
 *     budget serveur (90/240/280 s) : si le serveur abandonne, on veut lire SON message d'erreur,
 *     pas un `AbortError` anonyme fabriqué par le navigateur une seconde trop tôt.
 *  2. **Aucun échec silencieux.** Un crédit Anthropic à zéro est un incident PROD documenté ; il
 *     doit se voir. Les statuts 401 / 402 / 429 sont classés à part et remontés tels quels.
 */
import type { EmailDoc } from "@nf/render/schema";
import type { ArtDirection } from "./types";

/* Budgets client (ms). Serveur : art-direction 90 s · compose 240 s · illustrate 280 s. */
export const TIMEOUT_ART_DIRECTION = 120_000;
export const TIMEOUT_COMPOSE = 300_000;
export const TIMEOUT_ILLUSTRATE = 320_000;

/** Durées ANNONCÉES à l'écran — ce sont des observations, pas des promesses marketing. */
export const EXPECTED_ART_DIRECTION = "usually 15–40 s";
export const EXPECTED_COMPOSE = "usually 60–180 s, up to 4 min";
export const EXPECTED_ILLUSTRATE = "2–3 min per image";

export type AiErrorKind = "auth" | "credit" | "rate_limit" | "invalid_doc" | "timeout" | "network" | "server";

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number | null;
  /** Issues Zod renvoyées par la route quand le document produit est invalide. */
  readonly issues: string[];

  constructor(message: string, kind: AiErrorKind, status: number | null = null, issues: string[] = []) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    this.status = status;
    this.issues = issues;
  }
}

const KIND_LABEL: Record<AiErrorKind, string> = {
  auth: "API key rejected",
  credit: "Credit exhausted",
  rate_limit: "Rate limited",
  invalid_doc: "Invalid document",
  timeout: "Timed out",
  network: "Network error",
  server: "Failed",
};

export const errorLabel = (kind: AiErrorKind): string => KIND_LABEL[kind];

function kindOf(status: number, body: { code?: string; status?: string } | null): AiErrorKind {
  const code = body?.code ?? body?.status;
  if (code === "invalid_doc") return "invalid_doc";
  if (code === "timeout") return "timeout";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "credit";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status === 422) return "invalid_doc";
  return "server";
}

interface ErrorBody {
  error?: string;
  code?: string;
  status?: string;
  issues?: unknown;
}

async function post<T>(path: string, payload: unknown, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new AiError(
        `No answer after ${Math.round(timeoutMs / 1000)} s — the request was aborted client-side.`,
        "timeout",
      );
    }
    throw new AiError(err instanceof Error ? err.message : "Network error", "network");
  }

  const body = (await res.json().catch(() => null)) as (ErrorBody & Record<string, unknown>) | null;

  if (!res.ok) {
    const issues = Array.isArray(body?.issues) ? body.issues.filter((i): i is string => typeof i === "string") : [];
    throw new AiError(body?.error ?? `Request failed (${res.status})`, kindOf(res.status, body), res.status, issues);
  }
  if (!body) throw new AiError("The server returned an empty response.", "server", res.status);
  return body as T;
}

/* ------------------------------------------------------------------ Étape 1 */

export interface ArtDirectionRequest {
  /** Image de référence, base64 SANS le préfixe `data:` (la route la repasse à Claude vision). */
  image: { base64: string; mediaType: string };
  prompt: string;
  category: string;
}

export interface ArtDirectionResponse {
  direction: unknown;
  warnings?: string[];
}

export const requestArtDirection = (payload: ArtDirectionRequest) =>
  post<ArtDirectionResponse>("/api/ai/art-direction", payload, TIMEOUT_ART_DIRECTION);

/* ------------------------------------------------------------------ Étape 2 */

export interface ComposeRequest {
  prompt: string;
  category: string;
  direction: ArtDirection;
  /** Nom souhaité du modèle — sert au libellé, jamais au contenu. */
  name: string;
}

export interface ComposeResponse {
  /** Déjà validé par `EmailDoc` CÔTÉ SERVEUR. Un doc invalide ne parvient jamais ici : il fait un 422. */
  doc: EmailDoc;
  subject?: string;
  preheader?: string;
  warnings?: string[];
}

export const requestCompose = (payload: ComposeRequest) =>
  post<ComposeResponse>("/api/ai/compose", payload, TIMEOUT_COMPOSE);

/* ------------------------------------------------------------------ Étape 3 */

export interface IllustrateRequest {
  prompt: string;
  alt: string;
  direction: ArtDirection;
  /** Informatif : permet à la route de choisir un format proche du rendu final. */
  widthPct: number;
}

export interface IllustrateResponse {
  /**
   * URL HÉBERGÉE. ⚠️ Une `data:` URI est refusée par `ImageSrc` du schéma (schéma dangereux) —
   * l'UI le vérifie et le dit plutôt que d'insérer une source que la publication rejettera.
   */
  src: string;
  revisedPrompt?: string;
}

export const requestIllustration = (payload: IllustrateRequest) =>
  post<IllustrateResponse>("/api/ai/illustrate", payload, TIMEOUT_ILLUSTRATE);

/* ------------------------------------------------------------------ Étape 4 */

export interface ApplyRequest {
  name: string;
  category: string;
  doc: EmailDoc;
  subject: string;
  preheader: string;
}

export interface ApplyResponse {
  id: string;
}

export const requestApply = (payload: ApplyRequest) =>
  post<ApplyResponse>("/api/ai/apply", payload, 60_000);

/* ----------------------------------------------------------------- Aperçu */

export interface PreviewResult {
  html: string;
  text: string;
  warnings: string[];
  sizeBytes: number;
}

/** Le MÊME rendu que l'email final : `/api/builder/preview` compile le MJML côté serveur. */
export const requestPreview = (doc: EmailDoc) =>
  post<PreviewResult>("/api/builder/preview", { doc }, 60_000);
