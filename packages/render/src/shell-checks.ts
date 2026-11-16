import { GMAIL_CLIP_BYTES } from "./limits";
import { hydrate, type MergeVars } from "./hydrate";

/**
 * POIDS DE L'EMAIL RÉELLEMENT ENVOYÉ — pas du shell.
 *
 * LE DÉFAUT QUE CE MODULE CORRIGE. `publish` et `lock` mesurent `html_shell` : le HTML compilé,
 * AVANT que le worker y injecte le footer légal, les liens de désabonnement et de préférences
 * signés, et les valeurs de fusion du destinataire. Le seuil de Gmail, lui, s'applique à ce qui
 * arrive dans la boîte. Entre les deux il manque plusieurs kilo-octets, et ils manquent exactement
 * là où ça compte : au-delà de 102 400 octets, Gmail coupe la FIN du message, donc le footer, donc
 * le lien de désabonnement. Ce n'est pas un défaut d'esthétique, c'est une infraction — et une
 * série récurrente la répète à chaque occurrence.
 *
 * Trois blocs `article` avec vignettes, ce que le chantier WordPress s'apprête à rendre banal, est
 * précisément la charge qui franchit ce seuil.
 *
 * ⛔ ZÉRO DÉPENDANCE, comme `hydrate`. Ni MJML, ni Zod, ni `@nf/email`. Le footer légal arrive
 * RENDU, en paramètre : c'est l'appelant qui sait quelle édition a le footer le plus long (un
 * Impressum allemand pèse plus lourd qu'une mention brésilienne), et lui seul peut l'obtenir sans
 * imposer une dépendance à ce module.
 *
 * ⚠️ ON MESURE LE PIRE CAS, PAS UN CAS MOYEN. Un email qui passe pour 900 abonnés et se fait
 * tronquer pour les 300 dont le prénom est long n'est pas « presque conforme ».
 */

/** Longueurs réelles, mesurées dans `@nf/tokens` — pas estimées. */
const UNSUB_TOKEN_LEN = 80; // uuid (36) + '.' + HMAC sha256 en base64url (43)
const PREFS_TOKEN_LEN = 80;

/**
 * Prénom de gabarit. 40 caractères : au-delà, ce n'est plus un prénom mais une saisie erronée, et
 * la garde de saisie du formulaire public la refuse déjà.
 */
const LONG_FIRST_NAME = "A".repeat(40);

export interface ShellWeightInput {
  /** Le HTML compilé tel que `publish`/`lock` le stockent. */
  htmlShell: string;
  /**
   * Footer légal RENDU — celui de l'édition la PLUS BAVARDE de la marque.
   * Le passer vide fait mesurer un email sans footer : la mesure serait fausse dans le sens
   * dangereux, c'est pourquoi `footerProvided` le signale dans le rapport.
   */
  legalFooterHtml: string;
  /** Base publique des liens (« https://news.quartz-tips.example »), pour la longueur réelle des URL. */
  publicBaseUrl: string;
  /** Valeurs de fusion supplémentaires. Celles du pire cas sont déjà posées par défaut. */
  vars?: MergeVars;
}

export interface ShellWeightReport {
  /** Ce que `publish` et `lock` mesurent aujourd'hui. */
  shellBytes: number;
  /** Ce que l'abonné reçoit réellement. C'est CE nombre qui doit être comparé au seuil. */
  hydratedBytes: number;
  /** Ce que la mesure actuelle rate. */
  overheadBytes: number;
  limitBytes: number;
  overLimit: boolean;
  /** Octets restants avant la coupe. Négatif quand le seuil est franchi. */
  headroomBytes: number;
  /** Faux quand aucun footer n'a été fourni : le rapport sous-estime alors le poids réel. */
  footerProvided: boolean;
}

/** Octets UTF-8, jamais `String.length` — un « ç » compte pour deux, un emoji pour quatre. */
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Variables du PIRE cas plausible : footer le plus long, jetons signés de longueur réelle, prénom
 * de 40 caractères. Les valeurs fournies par l'appelant écrasent celles-ci.
 */
function worstCaseVars(input: ShellWeightInput): MergeVars {
  const base = input.publicBaseUrl.replace(/\/+$/, "");
  return {
    first_name: LONG_FIRST_NAME,
    email: `${"a".repeat(64)}@example.com`, // longueur maximale d'une partie locale (RFC 5321)
    brand_name: "",
    unsubscribe_url: `${base}/unsubscribe?t=${"x".repeat(UNSUB_TOKEN_LEN)}`,
    preferences_url: `${base}/preferences?t=${"x".repeat(PREFS_TOKEN_LEN)}`,
    legal_footer_html: input.legalFooterHtml,
    legal_footer_text: "",
    ...(input.vars ?? {}),
  };
}

/**
 * Mesure le poids hydraté et le compare au seuil de Gmail.
 *
 * Ne lance jamais et n'écrit rien : c'est un rapport. La décision de refuser appartient à
 * `publish` / `lock` / au matérialiseur, qui savent quoi dire à l'utilisateur.
 */
export function checkShellWeight(input: ShellWeightInput): ShellWeightReport {
  const shellBytes = bytes(input.htmlShell);
  const hydrated = hydrate(input.htmlShell, worstCaseVars(input));
  const hydratedBytes = bytes(hydrated);

  return {
    shellBytes,
    hydratedBytes,
    // Peut être négatif si le shell contenait plus de tokens que leur substitution ne pèse — c'est
    // une information, pas une anomalie : on ne la masque pas par un `Math.max(0, …)`.
    overheadBytes: hydratedBytes - shellBytes,
    limitBytes: GMAIL_CLIP_BYTES,
    overLimit: hydratedBytes > GMAIL_CLIP_BYTES,
    headroomBytes: GMAIL_CLIP_BYTES - hydratedBytes,
    footerProvided: input.legalFooterHtml.trim() !== "",
  };
}

/**
 * Phrase prête à afficher. Écrite ici pour que l'admin, le worker et le matérialiseur disent
 * EXACTEMENT la même chose — trois formulations différentes du même refus se lisent comme trois
 * problèmes différents.
 */
export function shellWeightMessage(r: ShellWeightReport): string | null {
  if (!r.overLimit) return null;
  const over = r.hydratedBytes - r.limitBytes;
  return (
    `the email weighs ${r.hydratedBytes.toLocaleString("en-US")} bytes once the legal footer and ` +
    `signed links are added — ${over.toLocaleString("en-US")} over Gmail's ${r.limitBytes.toLocaleString("en-US")} ` +
    `byte clipping limit, which would cut the unsubscribe link. Remove a block or shorten the content.`
  );
}
