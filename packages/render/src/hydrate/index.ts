/**
 * @nf/render/hydrate — point d'entrée LÉGER, exécuté par le worker à chaque envoi.
 *
 * ⛔ RÈGLE ABSOLUE : ZÉRO import (ni package externe, ni fichier de ce package qui en importerait
 * un). Le worker ne doit JAMAIS charger MJML ni Zod. Ce fichier est volontairement autonome ;
 * c'est aussi lui qui détient le REGISTRE des merge tags — `schema.ts` le ré-exporte, jamais
 * l'inverse (sinon Zod remonterait dans le worker par la porte de derrière).
 *
 * Contrat : l'admin fige `html_shell` / `text_shell` à la PUBLICATION, tokens NON résolus.
 * Le worker n'exécute que `hydrate()` / `hydrateText()` par destinataire.
 *
 * Sécurité : toute valeur est échappée avant insertion (un prénom `<script>` ne doit jamais
 * s'injecter). Seuls les champs déclarés `kind: "raw"` échappent à l'échappement — ils sont
 * produits par le système (footer légal de @nf/email), jamais par un abonné.
 */

/* ------------------------------------------------------------------ *
 * Registre des merge tags — SOURCE DE VÉRITÉ partagée builder / IA / worker
 * ------------------------------------------------------------------ */

export type MergeVarKind =
  /** Texte libre venant de l'abonné ou de l'édition — TOUJOURS échappé. */
  | "text"
  /** URL insérée dans un href — échappée (les `&` deviennent `&amp;`, correct en attribut). */
  | "url"
  /** Booléen destiné aux marqueurs conditionnels ; ne s'imprime jamais. */
  | "flag"
  /** HTML de confiance généré par le système (footer légal). NON échappé. */
  | "raw";

export interface MergeVarSpec {
  kind: MergeVarKind;
  /** Valeur utilisée quand la donnée manque. Obligatoire : jamais de trou visible dans un envoi. */
  fallback: string;
  /** Libellé anglais affiché dans le menu d'insertion du builder. */
  label: string;
}

export const MERGE_VARS = {
  first_name: { kind: "text", fallback: "there", label: "First name" },
  last_name: { kind: "text", fallback: "", label: "Last name" },
  email: { kind: "text", fallback: "", label: "Email address" },
  asset_name: { kind: "text", fallback: "", label: "Brand name" },
  edition_title: { kind: "text", fallback: "", label: "Edition title" },
  edition_date: { kind: "text", fallback: "", label: "Edition date" },
  /**
   * Le numéro lisible de l'édition (« #7 » devient « 7 »), pris sur `campaign_occurrence.seq`.
   *
   * ⛔ REPLI VIDE, JAMAIS « 1 ». Un envoi hors série — bienvenue, confirmation, campagne ponctuelle
   * jamais matérialisée — n'a pas de numéro du tout. Écrire « 1 » par défaut ferait partir une
   * « édition n° 1 » à chaque message de bienvenue, chiffre parfaitement plausible et faux, que
   * personne ne pourrait distinguer d'une vraie première édition.
   *
   * ⚠️ Le compteur est PAR CAMPAGNE (`occurrence_campaign_seq_uk`), décision d'Alix du 03/09/2026 :
   * deux campagnes servies par un même modèle ont chacune leur propre numérotation.
   */
  edition_number: { kind: "text", fallback: "", label: "Edition number" },
  /**
   * Variantes de la date d'édition, servies par la même source que `edition_date` : le jour LOCAL
   * de l'envoi, jamais l'horloge du serveur au moment du rendu. Un sujet composé une fois doit
   * dire la même date aux 1 200 destinataires, y compris si le drain repasse après minuit.
   */
  edition_date_short: { kind: "text", fallback: "", label: "Edition date (short)" },
  weekday: { kind: "text", fallback: "", label: "Day of the week" },
  /** Le nom de la campagne tel qu'il est écrit dans l'admin. */
  campaign_name: { kind: "text", fallback: "", label: "Campaign name" },
  /**
   * Titre de l'article de tête et nombre d'articles du document RÉELLEMENT expédié.
   *
   * ⛔ REPLI VIDE, et c'est la seule valeur honnête : un envoi sans bloc d'articles — bienvenue,
   * confirmation, campagne éditoriale à la main — n'a pas d'article de tête. Inventer un titre
   * ferait partir un sujet qui promet un contenu absent.
   *
   * ⚠️ Ces deux valeurs sont écrites au GEL (`campaign_occurrence.first_article_title` /
   * `article_count`, migration 0050) parce que c'est le seul moment où le document déplié existe.
   * Le rendu les lit, il ne les recalcule pas.
   */
  first_article: { kind: "text", fallback: "", label: "First article title" },
  article_count: { kind: "text", fallback: "", label: "Number of articles" },
  /**
   * L'introduction et l'accroche écrites par le modèle à partir des titres RÉELLEMENT expédiés.
   *
   * ⛔ CES DEUX JETONS SONT L'INTERRUPTEUR DE LA GÉNÉRATION. Le gel (et le verrouillage, pour une
   * campagne ponctuelle) n'appelle le modèle que si l'un d'eux est écrit dans le contenu. Poser la
   * décision ailleurs — une case à cocher, une colonne « activé » — autoriserait les deux erreurs
   * symétriques : payer un texte que rien n'affiche, ou afficher un blanc là où l'auteur attendait
   * un texte.
   *
   * ⛔ REPLI VIDE. Un modèle indisponible ne doit pas empêcher un envoi : l'édition part sans son
   * introduction, `ai_status` vaut `failed` et `ai_reason` dit pourquoi. Inventer une phrase de
   * remplacement ferait partir un texte que personne n'a écrit ni relu.
   *
   * ⚠️ `{{ai_preheader}}` se pose dans le PREHEADER DU MODÈLE (`doc.meta.preheader`), pas dans la
   * colonne `campaign.preheader` : c'est `mj-preview` qui atteint la boîte du lecteur, et le
   * compilé porte alors le jeton, hydraté par destinataire comme tous les autres.
   */
  ai_intro: { kind: "text", fallback: "", label: "AI intro paragraph" },
  ai_preheader: { kind: "text", fallback: "", label: "AI preheader line" },
  locale: { kind: "text", fallback: "en", label: "Locale" },
  market: { kind: "text", fallback: "", label: "Market" },
  unsubscribe_url: { kind: "url", fallback: "#", label: "Unsubscribe link" },
  preferences_url: { kind: "url", fallback: "#", label: "Preferences link" },
  privacy_url: { kind: "url", fallback: "#", label: "Privacy policy link" },
  web_version_url: { kind: "url", fallback: "#", label: "View in browser link" },
  /**
   * Lien de confirmation du double opt-in (`email_outbox.action_url`). N'a de valeur que sur une
   * ligne de kind `confirmation` ; ailleurs il retombe sur son repli.
   *
   * ⛔ AJOUTÉ AU REGISTRE AVANT D'ÊTRE EXIGÉ (5A). Tant qu'il n'y était pas, un auteur qui écrivait
   * `{{confirm_url}}` le voyait RETIRÉ en silence à l'envoi (`applyTokens` remplace tout jeton
   * inconnu par du vide), le menu d'insertion du builder ne le proposait pas, et le pré-vol n'en
   * disait qu'un avertissement. Exiger un jeton que le produit ne sait pas résoudre aurait été le
   * pire des deux mondes : la publication refusée, et l'e-mail cassé si elle passait.
   */
  confirm_url: { kind: "url", fallback: "#", label: "Confirmation link" },
  is_premium: { kind: "flag", fallback: "", label: "Is premium subscriber" },
  has_first_name: { kind: "flag", fallback: "", label: "Has a first name" },
  /**
   * Régime de conformité de l'édition qui envoie (`asset_edition.compliance_regime`), pour faire
   * varier le CORPS de l'e-mail — mentions, finalités listées, durée de validité d'un consentement.
   *
   * ⛔ EXACTEMENT UN DES TROIS EST VRAI, TOUJOURS. Le moteur n'a pas de `else` : sans exhaustivité,
   * un régime inconnu rendrait les trois faux et l'e-mail partirait sans aucune mention, sans qu'une
   * ligne de code échoue. Le calcul vit dans `@nf/config` `regimeFlags()`, seul endroit qui décide.
   *
   * ⛔ ILS NE SERVENT PAS À REFAIRE LE FOOTER. Celui-ci varie déjà par régime ET par marché dans
   * `buildFooter()`, et le compilateur interdit tout `visibleIf` sur un bloc de footer légal. Deux
   * sources de vérité dans le même e-mail se contrediraient un jour.
   *
   * ⚠️ `market` est DÉJÀ dans ce registre : `<!--nf:if market=="DE"-->` fonctionne sans rien ajouter.
   */
  is_gdpr: { kind: "flag", fallback: "", label: "GDPR regime" },
  is_lgpd: { kind: "flag", fallback: "", label: "LGPD regime" },
  is_can_spam: { kind: "flag", fallback: "", label: "CAN-SPAM regime" },
  /** Footer conforme rendu par @nf/email `buildFooter()` — HTML de confiance, non échappé. */
  legal_footer_html: { kind: "raw", fallback: "", label: "Legal footer (system)" },
  /** Équivalent texte du footer, pour le `text_shell`. */
  legal_footer_text: { kind: "text", fallback: "", label: "Legal footer, plain text (system)" },
} as const satisfies Record<string, MergeVarSpec>;

export type MergeVarName = keyof typeof MERGE_VARS;

export const MERGE_VAR_NAMES: MergeVarName[] = Object.keys(MERGE_VARS) as MergeVarName[];

/** Champs autorisés dans `<!--nf:if x-->` : tout le registre (les `flag` en sont l'usage principal). */
export const CONDITION_FIELDS: MergeVarName[] = MERGE_VAR_NAMES;

/* ------------------------------------------------------------------ *
 * Repli du prénom — par LANGUE du modèle, et réglable par modèle
 * ------------------------------------------------------------------ */

/**
 * Ce que `{{first_name}}` affiche quand l'abonné n'a pas de prénom, par langue.
 *
 * ⛔ LE DÉFAUT QUE CETTE TABLE FERME (22/09/2026) : le repli du registre est « there », en anglais,
 * pour TOUTES les langues — « Olá there » partait chez un abonné brésilien sans prénom. Mesuré ce
 * jour-là : 2 modèles pt-BR en base écrivent `{{first_name}}` nu.
 *
 * ⚠️ Des mots qui tiennent après une salutation (« Hola amigo », « Hallo zusammen »), faute de mieux :
 * aucun repli ne s'accorde à toutes les phrases. Le réglage exact est `meta.firstNameFallback`, par
 * modèle. L'anglais garde « there » : c'est ce qui laisse ses shells identiques octet pour octet.
 *
 * ⛔ UNE `Map`, PAS UN LITTÉRAL OBJET — même raison que la table des CTA (`cta.ts`) : la locale vient
 * de la base, et `["constructor"]` sur un littéral rendrait une fonction.
 */
const FIRST_NAME_FALLBACKS: ReadonlyMap<string, string> = new Map([
  ["en", "there"],
  ["es", "amigo"],
  ["pt", "amigo"],
  ["fr", "cher lecteur"],
  ["de", "zusammen"],
  ["it", "amico"],
]);

/**
 * Le repli du prénom pour un tag BCP-47 (`pt-BR` → portugais). Inconnu, absent ou vide ⇒ « there ».
 * `override` = le repli choisi pour CE modèle (`meta.firstNameFallback`) : non blanc, il l'emporte —
 * même contrat que `defaultArticleCta(locale, override)`.
 */
export function defaultFirstName(locale?: string, override?: string): string {
  if (override !== undefined && override.trim() !== "") return override;
  const lang = (locale ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return FIRST_NAME_FALLBACKS.get(lang) ?? MERGE_VARS.first_name.fallback;
}

/**
 * Écrit le repli DANS chaque jeton `{{first_name}}` nu d'un shell compilé : `{{first_name|amigo}}`.
 *
 * Pourquoi dans le shell et pas à l'hydratation : le repli dépend de la langue du MODÈLE (celle des
 * mots qui entourent le jeton) et d'un réglage du modèle — deux choses que le worker ne voit pas. Le
 * repli en ligne est déjà compris partout (`applyTokens`, `extractTokens`, le pré-vol) : rien de neuf
 * à apprendre au chemin d'envoi.
 *
 * ⚠️ Le repli est posé BRUT, jamais échappé : `hydrate()` échappe un repli en ligne au moment de
 * l'insérer. L'échapper ici le ferait échapper deux fois (« l&amp;#39;ami » chez l'abonné). Le schéma
 * refuse `{ } | < > "`, qui casseraient le jeton ou le HTML avant hydratation.
 *
 * Un jeton qui porte DÉJÀ un repli (`{{first_name|Ana}}`) n'est pas touché : c'est un choix d'auteur.
 * Repli égal à celui du registre ⇒ shell rendu tel quel (identité), ce qui garde l'anglais inchangé.
 */
export function poserRepliPrenom(shell: string, repli: string): string {
  if (repli === MERGE_VARS.first_name.fallback) return shell;
  // Remplacement par FONCTION : une chaîne de remplacement interpréterait `$&` ou `$1` tapés dans
  // le repli par l'auteur.
  const jeton = `{{first_name|${repli}}}`;
  return shell.replace(/\{\{\s*first_name\s*\}\}/g, () => jeton);
}

/* ------------------------------------------------------------------ *
 * Marqueurs conditionnels — la grammaire vit ICI, ÉMISSION COMPRISE
 * ------------------------------------------------------------------ */

/**
 * Condition d'affichage d'une row / colonne / bloc, évaluée PAR DESTINATAIRE.
 *
 * L'interface est redéclarée ici plutôt qu'importée de `schema.ts` : ce fichier n'importe rien
 * (voir l'en-tête). `schema.ts` en fournit la validation Zod et la ré-exporte.
 *
 *  - sans `equals` : test de véracité du champ (usage principal des `flag`) ;
 *  - avec `equals` : égalité avec la valeur du destinataire, casse et espaces de bord ignorés ;
 *  - `exists: false` inverse le test dans les deux cas.
 */
export interface VisibleIfSpec {
  token: string;
  equals?: string;
  exists?: boolean;
}

/** Fermeture d'un bloc conditionnel. */
export const CONDITION_END = "<!--nf:endif-->";

/**
 * Marqueur d'ouverture, émis par le compilateur autour de l'élément conditionnel.
 *
 * ⚠️ Les caractères capables de refermer le commentaire ou la chaîne (`"`, `<`, `>`) sont retirés :
 * un `-->` glissé dans une valeur couperait le marqueur en deux et ferait fuiter le contenu
 * conditionnel chez TOUS les destinataires. Le schéma les interdit déjà — cette seconde barrière
 * est délibérée, la grammaire n'ayant qu'un seul propriétaire.
 */
export function conditionMarker(cond: VisibleIfSpec): string {
  const not = cond.exists === false ? "!" : "";
  const token = cond.token.replace(/[^A-Za-z0-9_]/g, "");
  if (cond.equals === undefined) return `<!--nf:if ${not}${token}-->`;
  return `<!--nf:if ${not}${token}=="${cond.equals.replace(/["<>]/g, "")}"-->`;
}

export type MergeVarValue = string | number | boolean | null | undefined;
export type MergeVars = Partial<Record<MergeVarName, MergeVarValue>> & Record<string, MergeVarValue>;

export interface HydrateReport {
  html: string;
  /** Tokens rencontrés hors registre — retirés du rendu, remontés ici pour le diagnostic. */
  unknownTokens: string[];
  /** Conditions rencontrées hors registre — bloc masqué (fail-closed). */
  unknownConditions: string[];
}

/* ------------------------------------------------------------------ *
 * Échappement
 * ------------------------------------------------------------------ */

/**
 * Échappe une valeur pour insertion HTML — contexte texte ET attribut (guillemets compris).
 * Exporté : tout texte non fiable inséré par le compilateur DOIT passer par là.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ *
 * Preheader — la ligne d'aperçu de la boîte de réception
 * ------------------------------------------------------------------ */

/**
 * LE DIV MASQUÉ QUE `mj-preview` PRODUIT, reconnu par sa SIGNATURE STRUCTURELLE.
 *
 * ⛔⛔ L'ANCRAGE NE PEUT PAS PORTER SUR LA COULEUR, ET C'EST MESURÉ. MJML écrit `color:#ffffff`,
 * puis `patchHtml` (`compile/mjml.ts`) réécrit tous les `#ffffff` en `doc.theme.contentBackground` :
 * sur un thème clair standard le HTML publié porte `color:#FEFEFE`, pas `#ffffff`. Un motif calé sur
 * la couleur ne matcherait donc AUCUN document réel — et, pire, il échouerait en silence : le
 * preheader de la campagne serait simplement ignoré, exactement la panne qu'on corrige.
 *
 * Les trois déclarations retenues sont celles qui DÉFINISSENT un preheader et qu'aucun autre div du
 * corps ne porte ensemble : `display:none`, `max-height:0px`, `overflow:hidden`.
 *
 * ⚠️ `[^"]*` APRÈS `overflow:hidden;` ET PAS UN GUILLEMET IMMÉDIAT. Le banc l'a montré tout de
 * suite : le div que cette même fonction POSE se termine par `mso-hide:all;`, donc un motif exigeant
 * la fin de l'attribut juste après `overflow:hidden;` ne se reconnaissait pas lui-même — le second
 * appel empilait un deuxième div au lieu de remplacer, et la ligne d'aperçu portait deux phrases.
 * La tolérance vaut aussi pour une déclaration que MJML ajouterait demain.
 */
const DIV_PREHEADER =
  /(<div style="display:none;[^"]*max-height:0px;[^"]*overflow:hidden;[^"]*"\s*>)([\s\S]*?)(<\/div>)/i;

/**
 * Le div qu'on POSE quand le modèle n'en a pas — c'est-à-dire quand son preheader était vide et que
 * la campagne, elle, en a écrit un. Cas courant, pas marginal.
 *
 * ⛔ AUCUNE COULEUR, DÉLIBÉRÉMENT. La couleur de fond du thème n'est pas connue ici (cette fonction
 * ne voit qu'une chaîne de HTML, par construction — le worker ne doit jamais tirer le compilateur).
 * En inventer une poserait du texte gris clair sur un fond peut-être sombre chez le lecteur dont le
 * client ignore `display:none`. Les trois autres barrières suffisent et ne supposent rien :
 * `opacity:0`, `max-height:0px` et `overflow:hidden` masquent le div même sans `display`.
 */
const OUVRANT_NEUF =
  '<div style="display:none;font-size:1px;line-height:1px;max-height:0px;max-width:0px;' +
  'opacity:0;overflow:hidden;mso-hide:all;">';

/**
 * ⭐ POSE LE PREHEADER EFFECTIF DANS UN SHELL DÉJÀ COMPILÉ.
 *
 * ⛔ LE DÉFAUT QUE CETTE FONCTION FERME (18/09/2026). Le champ « Preheader » de l'écran campagne
 * était saisi, sauvegardé, gelé, affiché… et n'atteignait JAMAIS la boîte du lecteur. La preuve la
 * plus forte du dépôt : la garde d'énumération de colonnes de la vue `outbox_context`
 * (`0065_legal_footer_template.sql`) porte `campaign_ai_preheader` et `occurrence_ai_preheader`, et
 * **aucun `preheader` nu** ; `apps/worker/src/render.ts` n'en lit aucun. Seul `mj-preview` — donc le
 * preheader DU MODÈLE — arrivait jusqu'à l'e-mail. Deux campagnes partageant un modèle avaient donc
 * forcément la même ligne d'aperçu, quoi qu'on tape dans leur champ.
 *
 * ⚠️ HTML SEULEMENT, JAMAIS LE `text_shell`. La ligne d'aperçu est une notion du rendu HTML : la
 * version texte n'a pas de zone masquée, et y coller le preheader ajouterait une phrase orpheline en
 * tête du message pour les lecteurs en texte brut.
 *
 * ⚠️ LES JETONS SURVIVENT. `escapeHtml` ne touche ni `{` ni `}` : un preheader qui contient
 * `{{first_name}}` reste un jeton dans le shell, et s'hydrate par destinataire comme partout
 * ailleurs. C'est ce qui rend les puces de l'écran utiles plutôt que décoratives.
 *
 * ⚠️ IDEMPOTENTE : le div qu'elle pose porte la même signature que celui de MJML, donc un second
 * appel remplace au lieu d'empiler.
 *
 * @param html   le shell compilé (HTML complet, avec son `<body>`)
 * @param texte  le preheader EFFECTIF — au REPLI DÉJÀ RÉSOLU par l'appelant (campagne, sinon modèle)
 */
export function poserPreheader(html: string, texte: string): string {
  // ⛔ Un preheader effectif vide ne VIDE PAS celui du shell. L'appelant a déjà applique le repli :
  // « vide » signifie donc « personne n'en a écrit, ni sur la campagne ni sur le modèle ». Écraser le
  // div par du vide ne retirerait rien de visible et ferait diverger le shell du modèle pour rien.
  const propre = texte.trim();
  if (propre === "") return html;

  const ouvertureBody = html.search(/<body\b/i);
  if (ouvertureBody === -1) return html;
  const finBody = html.indexOf(">", ouvertureBody);
  if (finBody === -1) return html;

  /*
   * ⛔ LA RECHERCHE EST BORNÉE À LA TÊTE DU CORPS. Le div de preheader est la toute première chose
   * qu'écrit MJML après `<body>` (mesuré : ~90 caractères). Chercher dans le document entier
   * exposerait à capturer un div masqué appartenant à un bloc de contenu — et à remplacer du contenu
   * réel par la ligne d'aperçu. La fenêtre est large (elle couvre plusieurs fois la distance
   * observée) mais elle est FERMÉE.
   */
  const debut = finBody + 1;
  const fenetre = html.slice(debut, debut + 1500);
  const trouve = fenetre.match(DIV_PREHEADER);

  if (trouve) {
    const remplace = fenetre.replace(DIV_PREHEADER, `$1${escapeHtml(propre)}$3`);
    return html.slice(0, debut) + remplace + html.slice(debut + fenetre.length);
  }

  // Le modèle n'avait pas de preheader : on en pose un, juste après l'ouverture du corps.
  return html.slice(0, debut) + `\n${OUVRANT_NEUF}${escapeHtml(propre)}</div>` + html.slice(debut);
}

/* ------------------------------------------------------------------ *
 * API publique
 * ------------------------------------------------------------------ */

/**
 * Résout les tokens `{{var}}` et les marqueurs `<!--nf:if x-->…<!--nf:endif-->` d'un shell HTML.
 * Les valeurs sont échappées (sauf `kind: "raw"`). Les tokens inconnus sont RETIRÉS
 * (mieux vaut un blanc qu'un `{{typo}}` livré à un abonné) — utilise `hydrateReport()` pour les voir.
 */
export function hydrate(htmlShell: string, vars: MergeVars): string {
  return run(htmlShell, vars, true).html;
}

/**
 * Même substitution pour le `text_shell` : PAS d'échappement HTML
 * (`&` doit rester `&` dans une version texte).
 */
export function hydrateText(textShell: string, vars: MergeVars): string {
  return run(textShell, vars, false).html;
}

/** Variante diagnostique : renvoie aussi les tokens/conditions hors registre. */
export function hydrateReport(htmlShell: string, vars: MergeVars): HydrateReport {
  return run(htmlShell, vars, true);
}

/** Liste les tokens présents dans un shell (utile pour l'aperçu et les tests de snapshot). */
export function extractTokens(shell: string): string[] {
  const found: string[] = [];
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*(?:\|[^}]*)?\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(shell)) !== null) {
    const name = m[1] as string;
    if (found.indexOf(name) === -1) found.push(name);
  }
  return found;
}

/** Les jetons dont la valeur est ÉCRITE PAR LE MODÈLE, au gel ou au verrouillage. */
export const AI_MERGE_VARS: readonly MergeVarName[] = ["ai_intro", "ai_preheader"];

/**
 * Ce contenu réclame-t-il un texte du modèle ?
 *
 * ⛔ C'EST LA SEULE CHOSE QUI DÉCLENCHE UN APPEL PAYANT. Elle passe par `extractTokens` et jamais
 * par une recherche de la chaîne `{{ai_intro}}` : un jeton peut porter un repli inline
 * (`{{ai_intro|Le résumé du jour}}`), que la recherche littérale manquerait. Le résultat serait un
 * faux négatif silencieux — l'auteur voit son jeton dans le modèle, rien ne se génère, et aucune
 * erreur ne le dit.
 *
 * On passe le HTML compilé, le sujet et le preheader : le jeton peut vivre dans les trois.
 */
export function usesAiTokens(...textes: (string | null | undefined)[]): boolean {
  return textes.some((t) => (t ? extractTokens(t).some((n) => (AI_MERGE_VARS as readonly string[]).includes(n)) : false));
}

/* ------------------------------------------------------------------ *
 * Implémentation
 * ------------------------------------------------------------------ */

function run(shell: string, vars: MergeVars, escape: boolean): HydrateReport {
  const unknownConditions: string[] = [];
  // ORDRE CRITIQUE : conditions D'ABORD, tokens ENSUITE. Sinon une valeur d'abonné contenant
  // `<!--nf:endif-->` pourrait détourner la structure conditionnelle.
  const pruned = applyConditionals(shell, vars, unknownConditions);
  const unknownTokens: string[] = [];
  const html = applyTokens(pruned, vars, escape, unknownTokens);
  return { html, unknownTokens, unknownConditions };
}

function isKnown(name: string): name is MergeVarName {
  return Object.prototype.hasOwnProperty.call(MERGE_VARS, name);
}

function truthy(name: MergeVarName, vars: MergeVars): boolean {
  const v = vars[name];
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s !== "" && s !== "false" && s !== "0" && s !== "null";
}

/**
 * Comparaison d'un marqueur `field=="value"`. Casse et espaces de bord ignorés : une locale
 * stockée « BR » et une condition écrite « br » désignent le même destinataire, et personne ne
 * doit avoir à deviner la casse exacte de la base pour qu'un bloc s'affiche.
 * ⚠️ Le fallback du registre ne s'applique PAS ici : on compare la donnée réelle, pas son substitut.
 */
function equals(name: MergeVarName, vars: MergeVars, expected: string): boolean {
  const v = vars[name];
  const actual = v === undefined || v === null ? "" : String(v);
  return actual.trim().toLowerCase() === expected.trim().toLowerCase();
}

interface Frame {
  emit: boolean;
  buf: string[];
}

/**
 * Marqueurs supportés : `<!--nf:if field-->`, `<!--nf:if !field-->`, `<!--nf:if field=="value"-->`,
 * `<!--nf:if !field=="value"-->` (différent de), `<!--nf:endif-->`.
 * Imbrication gérée par pile. Champ hors registre → bloc masqué dans les DEUX polarités
 * (fail-closed : on n'envoie pas un contenu dont on ne sait pas s'il s'applique).
 */
function applyConditionals(input: string, vars: MergeVars, unknown: string[]): string {
  const re = /<!--\s*nf:if\s+(!?)\s*([A-Za-z0-9_]+)\s*(?:==\s*"([^"<>]*)"\s*)?-->|<!--\s*nf:endif\s*-->/g;
  const stack: Frame[] = [{ emit: true, buf: [] }];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(input)) !== null) {
    const top = stack[stack.length - 1] as Frame;
    top.buf.push(input.slice(last, m.index));
    last = re.lastIndex;

    const field = m[2];
    if (field !== undefined) {
      let emit: boolean;
      if (isKnown(field)) {
        // `equals` absent → test de véracité ; présent → comparaison avec la valeur du destinataire.
        emit = m[3] === undefined ? truthy(field, vars) : equals(field, vars, m[3]);
        if (m[1] === "!") emit = !emit;
      } else {
        if (unknown.indexOf(field) === -1) unknown.push(field);
        emit = false;
      }
      stack.push({ emit: top.emit && emit, buf: [] });
    } else if (stack.length > 1) {
      closeFrame(stack);
    }
    // `endif` orphelin : ignoré silencieusement (on ne casse jamais un envoi pour ça).
  }

  (stack[stack.length - 1] as Frame).buf.push(input.slice(last));
  while (stack.length > 1) closeFrame(stack); // `if` non fermé → refermé implicitement
  return (stack[0] as Frame).buf.join("");
}

function closeFrame(stack: Frame[]): void {
  const frame = stack.pop() as Frame;
  const parent = stack[stack.length - 1] as Frame;
  if (frame.emit) parent.buf.push(frame.buf.join(""));
}

/** `{{ field }}` ou `{{ field|inline fallback }}`. */
function applyTokens(input: string, vars: MergeVars, escape: boolean, unknown: string[]): string {
  return input.replace(
    /\{\{\s*([A-Za-z0-9_]+)\s*(?:\|([^}]*))?\}\}/g,
    (_all: string, rawName: string, inlineFallback?: string): string => {
      if (!isKnown(rawName)) {
        if (unknown.indexOf(rawName) === -1) unknown.push(rawName);
        return "";
      }
      const spec: MergeVarSpec = MERGE_VARS[rawName];
      // Un `flag` sert aux conditions, il ne s'imprime jamais (sinon « true » fuiterait).
      if (spec.kind === "flag") return "";

      const value = vars[rawName];
      const provided = value === undefined || value === null ? "" : String(value);
      const fallback = inlineFallback !== undefined ? inlineFallback : spec.fallback;
      const out = provided.trim() === "" ? fallback : provided;
      if (!escape) return out;
      return spec.kind === "raw" ? out : escapeHtml(out);
    },
  );
}
