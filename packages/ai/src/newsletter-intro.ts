import { callClaude, ClaudeError, parseJsonLoose, type ClaudeUsage } from "./claude";

/**
 * L'ACCROCHE ET L'INTRODUCTION D'UNE ÉDITION, à partir des titres qu'elle contient vraiment.
 *
 * Demande d'Alix (08/09/2026) : « au moment de l'envoi tu récupères le titre des articles qui
 * composent la newsletter et tu me crées un résumé de 3-4 lignes qui servira d'introduction ».
 *
 * ⛔ DEUX SORTIES, UN SEUL APPEL (arbitrage d'Alix). Un preheader n'affiche que ~90 à 140
 * caractères selon la boîte : y mettre 3-4 lignes les fait couper au milieu d'un mot. On demande
 * donc une accroche courte POUR le preheader et une introduction POUR le corps, en une fois — deux
 * appels coûteraient deux fois et pourraient se contredire sur la même édition.
 *
 * ⛔ CETTE FONCTION NE LÈVE JAMAIS. Elle est appelée pendant le gel d'une occurrence, c'est-à-dire
 * sur le chemin d'un envoi. Un service tiers indisponible, un crédit épuisé ou un refus de
 * politique ne doivent pas empêcher une édition de partir : l'appelant reçoit un motif et gèle
 * quand même, sans introduction.
 *
 * ⛔ AUCUN CHIFFRE INVENTÉ. Huit marques sur neuf publient du sport, et un résumé qui « complète »
 * un titre par un score plausible produit une fausse information dans une boîte mail. Le prompt
 * l'interdit explicitement, et rien dans le code ne peut rattraper une invention — c'est pourquoi
 * la consigne est cadrée plutôt que corrigée après coup.
 */

/** Bornes IMPOSÉES EN CODE, pas par un schéma : l'API Messages rejette les contraintes de valeur
 *  dans un `output_config.format.schema` (mesuré le 04/09/2026, HTTP 400). On les rappelle dans le
 *  prompt ET on tronque après lecture — un modèle qui déborde ne doit pas casser un envoi. */
export const MAX_PREHEADER_CHARS = 140;
export const MAX_INTRO_CHARS = 600;

/** Le plafond de sortie : deux textes courts. Assez large pour ne jamais couper, assez bas pour
 *  que l'appel reste bon marché sur une quotidienne. */
const MAX_TOKENS = 900;
/** ⛔ Un job LLM sans délai explicite est le mode de panne le plus coûteux du projet. Le gel a
 *  90 minutes d'avance sur l'envoi : 45 s est large, et borne la passe du planificateur. */
const TIMEOUT_MS = 45_000;

/**
 * ⚠️ BYTE-STABLE, sans exception. Ce texte porte `cache_control: ephemeral` : la moindre
 * interpolation (une date, un nom de marque) casse le cache et multiplie le coût d'entrée par dix.
 * Tout ce qui varie passe par le message utilisateur.
 */
const SYSTEM = [
  "You write the opening lines of an email newsletter.",
  "",
  "You will receive: the brand name, the language to write in, and the list of article headlines",
  "that this specific edition contains. Return exactly two pieces of text.",
  "",
  "1. `preheader`: one sentence that makes someone open the email. It is shown next to the subject",
  "   line in the inbox and is cut off after about 140 characters, so keep it well under that.",
  "2. `intro`: three to four sentences introducing what is in this edition, as ONE paragraph with",
  "   no line breaks. It sits at the top of the email, above the articles.",
  "",
  "Hard rules:",
  "- Write in the requested language, in the register a sports or news brand uses with its readers.",
  "- Use ONLY what the headlines say. Never add a score, an odds value, a date, a place, a player",
  "  name or an outcome that is not written in a headline. If the headlines are thin, stay general.",
  "- Never promise anything the edition does not contain.",
  "- Plain text only: no markdown, no HTML, no emoji, no quotation marks around the whole text.",
  "- Do not repeat the subject line word for word, and do not start with the brand name.",
  "",
  'Answer with JSON only: {"preheader": "...", "intro": "..."}',
].join("\n");

export interface IntroArticle {
  title: string;
  /** Chapô ou début d'article, quand la source en fournit un. Facultatif. */
  excerpt?: string | null;
}

export interface IntroInput {
  assetName: string;
  /** Langue de l'ÉDITION (`asset_edition.language`), pas celle de l'interface. */
  language: string;
  articles: IntroArticle[];
  /** Le sujet déjà décidé, pour que l'accroche ne le paraphrase pas. Facultatif. */
  subject?: string | null;
}

export type IntroResult =
  | { ok: true; preheader: string; intro: string; model: string; usage: ClaudeUsage }
  | { ok: false; reason: string; kind: string };

/** Espaces normalisés et troncature sur une frontière de mot — couper au milieu d'un mot se voit. */
export function clampText(raw: unknown, max: number): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const coupe = s.slice(0, max);
  const espace = coupe.lastIndexOf(" ");
  // Un texte sans aucun espace dans la fenêtre (langue sans séparateur, mot très long) est tronqué
  // net : mieux vaut ça qu'une chaîne vide.
  return (espace > max * 0.6 ? coupe.slice(0, espace) : coupe).trim();
}

/** Ce que le modèle reçoit. Isolé pour être testable sans réseau. */
export function buildUserMessage(input: IntroInput): string {
  const titres = input.articles
    .map((a, i) => {
      const chapo = a.excerpt?.trim() ? ` — ${clampText(a.excerpt, 200)}` : "";
      return `${i + 1}. ${clampText(a.title, 200)}${chapo}`;
    })
    .join("\n");
  const lignes = [
    `Brand: ${input.assetName}`,
    `Language: ${input.language}`,
    input.subject?.trim() ? `Subject line already chosen: ${clampText(input.subject, 200)}` : null,
    "",
    `Headlines in this edition (${input.articles.length}):`,
    titres,
  ].filter((l) => l !== null);
  return lignes.join("\n");
}

export async function generateEditionIntro(
  input: IntroInput,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<IntroResult> {
  // ⛔ Sans titre, il n'y a rien à résumer. Appeler le modèle produirait un texte générique qui a
  // l'air d'un vrai résumé — le pire résultat possible, parce qu'il ne se distingue pas d'un bon.
  const articles = input.articles.filter((a) => a.title?.trim());
  if (articles.length === 0) return { ok: false, reason: "no-articles", kind: "no-articles" };

  try {
    const { text, usage, model } = await callClaude({
      system: SYSTEM,
      userContent: buildUserMessage({ ...input, articles }),
      maxTokens: MAX_TOKENS,
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
      ...(opts.model ? { model: opts.model } : {}),
    });

    const parsed = parseJsonLoose<{ preheader?: unknown; intro?: unknown }>(text);
    const preheader = clampText(parsed.preheader, MAX_PREHEADER_CHARS);
    const intro = clampText(parsed.intro, MAX_INTRO_CHARS);

    // Une moitié vide n'est pas un succès partiel : le preheader part dans l'en-tête de l'email et
    // l'intro dans le corps, et un des deux manquant laisse un trou visible.
    if (preheader === "" || intro === "") {
      return { ok: false, reason: "empty-fields", kind: "bad_response" };
    }
    return { ok: true, preheader, intro, model, usage };
  } catch (err) {
    if (err instanceof ClaudeError) return { ok: false, reason: err.message, kind: err.kind };
    return { ok: false, reason: err instanceof Error ? err.message : "unknown", kind: "server" };
  }
}

/**
 * Les colonnes `ai_*` telles qu'elles s'écrivent, à l'identique sur une occurrence de série et sur
 * une campagne ponctuelle (migration 0055).
 *
 * ⛔ POURQUOI CETTE FONCTION EXISTE, ALORS QU'ELLE NE FAIT QUE RECOPIER SIX CHAMPS. Deux chemins
 * écrivent ces colonnes : le gel, dans le worker, et le verrouillage, dans l'admin. Deux mappings
 * écrits séparément finiraient par diverger — l'un noterait le motif d'échec, l'autre non, et
 * l'écran dirait « échec » sans jamais pouvoir dire pourquoi selon le chemin emprunté. Le contrat
 * de colonnes tient donc à UN seul endroit. Ce paquet ne parle toujours pas à la base : il rend un
 * objet, l'appelant l'écrit.
 *
 * ⛔ UN ÉCHEC S'ÉCRIT AUSSI. Laisser les colonnes nulles rendrait « le modèle a échoué »
 * indiscernable de « aucun jeton IA dans ce modèle » — c'est-à-dire d'un envoi normal.
 */
export interface AiColumns {
  ai_intro: string | null;
  ai_preheader: string | null;
  ai_status: "ok" | "failed";
  ai_reason: string | null;
  ai_model: string | null;
  ai_generated_at: string;
}

export async function generateIntroColumns(
  input: IntroInput,
  now: Date,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<AiColumns> {
  const r = await generateEditionIntro(input, opts);
  const ai_generated_at = now.toISOString();
  if (!r.ok) {
    // Le motif est tronqué : il finit dans une colonne lue par un écran, pas dans un journal.
    return {
      ai_intro: null,
      ai_preheader: null,
      ai_status: "failed",
      ai_reason: clampText(`${r.kind}: ${r.reason}`, 300),
      ai_model: null,
      ai_generated_at,
    };
  }
  return {
    ai_intro: r.intro,
    ai_preheader: r.preheader,
    ai_status: "ok",
    ai_reason: null,
    ai_model: r.model,
    ai_generated_at,
  };
}
