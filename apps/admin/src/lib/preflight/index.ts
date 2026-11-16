/**
 * PRÉ-VOL — ce qui va mal AVANT publication, avec l'élément fautif au bout de chaque constat.
 *
 * Ce module n'est PAS un second compilateur de règles. `compileDoc()` (donc `collectWarnings`)
 * reste le propriétaire des contrôles qu'il fait déjà — sujet vide, alt manquant, sentinelle
 * `ai://`, lien `#`, `http://`, blocs métier à moitié remplis. On ingère ses avertissements tels
 * quels, on leur donne un NIVEAU (`blocking` / `advisory`) et une CIBLE cliquable, puis on ENRICHIT
 * avec ce qu'il ne sait pas faire :
 *   • poids : distance exacte au seuil de coupure Gmail, y compris avant de le franchir ;
 *   • contraste : ratio WCAG texte/fond sur la cascade résolue, bloc par bloc, DANS LES DEUX
 *     rendus — clair, puis sombre lorsque le thème pose des overrides `dark*` ;
 *   • liens : merge tag hors registre dans un href (hydrate() le retire → lien mort) ;
 *   • structure : footer légal ABSENT (le compilateur le dit aussi, mais lui seul — donc pas avant
 *     la première compilation), mal placé ou en double, boutons concurrents, libellé qui déborde ;
 *   • conformité : lien de désabonnement écrit à la main — jamais, la plateforme l'injecte signé.
 *     Le VERDICT BLOQUANT n'est pas recalculé ici : il est demandé à `EmailDocPublishable`, le
 *     schéma que `POST …/publish` interroge. Deux règles jumelles auraient dérivé, et l'utilisateur
 *     aurait vu soit un verrou que le serveur n'applique pas, soit un refus surprise à la publication.
 *
 * ⚠️ Les faits de compilation (`CompiledFacts`) viennent de `POST /api/builder/preview` : MJML ne
 * tourne pas dans le navigateur. Sans eux, le rapport reste valable — il perd simplement le poids
 * et les avertissements du compilateur, et le dit (`size: null`).
 */
// ⛔ Le libellé par défaut est IMPORTÉ, jamais recopié : le pré-vol doit juger la chaîne EXACTE que
// `withDefaultCta` posera à la compilation. Une seconde table du même libellé finirait par diverger,
// et le pré-vol se mettrait alors à juger un lien que personne ne reçoit.
import { defaultArticleCta } from "@nf/render/cta";
// ⛔ La règle « ce href ne mène nulle part » est IMPORTÉE, jamais recopiée : c'est la même
// définition que celle dont `withDefaultCta` se sert pour décider s'il pose un libellé. La recopier
// ici ferait diverger le pré-vol du rendu au premier cas ajouté — et la divergence ne se verrait
// que dans la boîte du lecteur, où plus personne ne peut la corriger.
import { goesNowhere } from "@nf/render/links";
import { checkLifecycleShell, lifecycleShellMessage, type LifecycleKind } from "@nf/render/lifecycle-checks";
import {
  EmailDocPublishable,
  GMAIL_CLIP_BYTES,
  isPlaceholderSrc,
  LAYOUT_WEIGHTS,
  MAX_BUTTON_LABEL,
  MERGE_VARS,
  newId,
  // ⚠️ Importé comme VALEUR (et plus seulement comme type) : `appendLegalFooterFix` fait passer la
  // row qu'il fabrique par `Row.parse()`. Écrire l'objet à la main aurait figé ici les défauts zod
  // du schéma, qui dériveraient au premier champ ajouté à `Row` ou `Column`.
  Row,
  type Block,
  type BlockType,
  type BoxStyle,
  type Column,
  type EmailDoc,
  type Spacing,
  type TextPreset,
  type Theme,
} from "@nf/render/schema";
import { contrastRatio, formatRatio, wcagMinimum } from "./contrast";

/* ------------------------------------------------------------------ *
 * Contrat
 * ------------------------------------------------------------------ */

/** `blocking` = la publication doit être refusée. `advisory` = à regarder, pas à interdire. */
export type PreflightLevel = "blocking" | "advisory";

export type PreflightGroup =
  | "compliance"
  | "structure"
  | "weight"
  | "contrast"
  | "links"
  | "images"
  | "content";

export const GROUP_LABELS: Record<PreflightGroup, string> = {
  compliance: "Compliance",
  structure: "Structure",
  weight: "Weight",
  contrast: "Contrast",
  links: "Links",
  images: "Images",
  content: "Content",
};

/** Ordre d'affichage : ce qui bloque un envoi d'abord, ce qui l'enlaidit ensuite. */
const GROUP_ORDER: PreflightGroup[] = [
  "compliance",
  "structure",
  "weight",
  "links",
  "images",
  "contrast",
  "content",
];

/** Où cliquer. `blockId` absent = le constat porte sur la ligne (ou sur le document). */
export interface PreflightTarget {
  rowId: string;
  colId?: string;
  blockId?: string;
  /**
   * ⚠️ `Block["type"]` et NON `BlockType` : le flux d'articles est un bloc du document mais il ne
   * figure pas dans `BLOCK_TYPES` (il ne se pose pas depuis la grille de la palette). Typer la
   * cible sur `BlockType` interdisait au pré-vol de DÉSIGNER un bloc flux — un constat portant sur
   * lui devenait incliquable.
   */
  blockType?: Block["type"];
}

/**
 * CORRECTION MÉCANIQUE — une réparation prête à appliquer, attachée à un constat.
 *
 * On n'en propose que là où la réparation est DÉTERMINÉE par le constat lui-même : passer un lien
 * en `https://`, retirer une sentinelle d'illustration, rogner un libellé qui déborde, aligner un
 * plancher sur la valeur d'à côté. Jamais une couleur : choisir une couleur de marque est une
 * décision éditoriale, pas une réparation — un bouton « corriger » qui repeint un thème donnerait
 * l'illusion d'un arbitrage qu'il n'a pas fait. Jamais un alt non plus : la seule source d'un alt
 * honnête est l'humain qui regarde l'image, et un alt fabriqué éteindrait le blocage en mentant
 * aux lecteurs d'écran.
 *
 * `label` montre le RÉSULTAT exact (« Shorten to “Get the bonus” »), pas l'intention : c'est ce qui
 * rend le bouton sûr à cliquer sans annuler derrière.
 *
 * ⚠️ TROIS VERBES, UN SEUL TYPE — ET POURQUOI PAS UNE UNION.
 * `blockId` et `patch` restent OBLIGATOIRES : `shell.tsx` lit `fix.blockId` et `fix.patch` sans
 * discriminer, et une union discriminée aurait cassé sa compilation. Les verbes ajoutés sont donc
 * des champs OPTIONNELS. Un consommateur qui ne connaît que `updateBlock` reçoit alors `patch: {}`
 * sur une réparation purement structurelle : il ne fait RIEN — pas de corruption, mais pas de
 * réparation non plus.
 *
 * ⛔ C'est pour ça qu'un verbe se BRANCHE avant de s'attacher à un constat : un bouton qui
 * s'affiche et ne fait rien est un mensonge de plus. `insertRow` EST branché (`actionsForFix()`
 * → réducteur), et `appendLegalFooterFix` est donc attachée au constat « No legal footer block ».
 * ⚠️ `removeLegalFooterDuplicatesFix`, elle, n'est PAS portée par un constat : elle n'entre dans le
 * lot que par `collectFixes()`, au global, là où le libellé du lot énumère ce qui va changer.
 * L'ORDRE dans lequel un consommateur doit traduire les verbes :
 *   1. `patch` (s'il est non vide)  → `updateBlock { blockId, patch }`
 *   2. `removeBlockIds`             → `removeBlock { blockId }`, un par id
 *   3. `removeRowIds`               → `removeRow { rowId }`, un par id (rows vidées par l'étape 2)
 *   4. `insertRow`                  → `insertRow { row, index }`
 * L'ordre n'est pas décoratif : insérer avant de supprimer décalerait l'index d'insertion, et
 * supprimer les rows avant les blocs ferait disparaître des ids que l'étape 2 cherche encore.
 */
export interface PreflightFix {
  label: string;
  /**
   * Bloc que la réparation CONCERNE. Pour une suppression c'est l'exemplaire CONSERVÉ, pour une
   * insertion c'est le bloc créé : dans les deux cas, celui que l'utilisateur doit regarder après
   * coup. Ce n'est donc pas forcément un bloc que `patch` modifie.
   */
  blockId: string;
  /** Patch partiel du bloc, à passer tel quel à l'action `updateBlock` du réducteur. `{}` = rien à patcher. */
  patch: Partial<Block>;
  /**
   * Blocs à SUPPRIMER. N'est légitime que sur un bloc SANS contenu propre — aujourd'hui le seul
   * cas est `footer_legal`, qui ne porte aucune propriété éditable (schéma) : ses exemplaires sont
   * interchangeables, en retirer un ne détruit rien. ⛔ Ne pas étendre ce verbe à un bloc porteur
   * de texte sans repasser par cette question.
   */
  removeBlockIds?: string[];
  /**
   * Rows que `removeBlockIds` laisse VIDES. Calculé ici et pas dans l'UI : c'est une conséquence
   * mécanique de la suppression, et la déduire côté composant remettrait une règle de document
   * dans une couche qui ne sait pas la tester.
   */
  removeRowIds?: string[];
  /** Row à INSÉRER, avec sa position finale. `index` est explicite : un défaut implicite dériverait. */
  insertRow?: { row: Row; index: number };
}

export interface PreflightFinding {
  /** Clé stable pour React et pour les tests — jamais un index de tableau seul. */
  id: string;
  level: PreflightLevel;
  group: PreflightGroup;
  /** Une phrase, en anglais, qui dit le problème. */
  message: string;
  /** Pourquoi ça compte / quoi faire. Facultatif. */
  detail?: string;
  target?: PreflightTarget;
  /** `compiler` = repris de `compileDoc()`, `preflight` = ajouté ici, `schema` = refusé par `EmailDocPublishable`. */
  source: "compiler" | "preflight" | "schema";
  /** Réparation mécanique proposée. Absent = la correction demande un arbitrage humain. */
  fix?: PreflightFix;
}

/** Ce que le serveur nous apprend et que le navigateur ne peut pas calculer. */
export interface CompiledFacts {
  sizeBytes: number;
  /**
   * Poids de l'email tel qu'il PART : le shell, plus le footer légal le plus lourd de la marque et
   * les liens signés que le worker injecte par destinataire.
   *
   * ⛔ C'EST LUI QU'IL FAUT COMPARER AU SEUIL GMAIL, PAS `sizeBytes`. `POST …/publish` juge sur ce
   * poids-là (`weighShell`), et l'écart entre les deux vaut plusieurs kilo-octets : mesuré le
   * 26/08, un document à 101 892 octets de shell pesait 102 407 octets hydraté — sous le seuil
   * pour le pré-vol, au-dessus pour le serveur. Toute une bande de documents s'affichait donc
   * verte et se faisait refuser en 422 au clic.
   *
   * Absent quand la compilation vient d'un appelant qui ne connaît pas la marque : on retombe
   * alors sur `sizeBytes`, en sachant qu'on sous-estime.
   */
  hydratedBytes?: number;
  warnings: string[];
  /**
   * Le HTML et le TEXTE compilés, quand l'appelant les a. Servent au contrôle des jetons de cycle
   * de vie, qui doit juger le MÊME artefact que la publication : un jeton peut vivre dans un bloc
   * `html` opaque — invisible d'un parcours de blocs typés — et, à l'inverse, un jeton présent dans
   * le document peut DISPARAÎTRE à la compilation (un CTA dont le lien ne mène nulle part n'est pas
   * émis). Absents ⇒ le contrôle se tait plutôt que de juger sur le document.
   */
  html?: string;
  text?: string;
}

export interface SizeFacts {
  bytes: number;
  limit: number;
  /** Octets restants avant coupure ; négatif au-delà. */
  remaining: number;
  /** `bytes / limit`. 1 = pile sur le seuil. */
  ratio: number;
  over: boolean;
}

export interface PreflightReport {
  findings: PreflightFinding[];
  counts: { blocking: number; advisory: number };
  /**
   * Vrai UNIQUEMENT si DEUX choses sont vraies : aucun constat `blocking` ne subsiste, ET les faits
   * compilés sont là (`size !== null`). Voir le `return` de `runPreflight()` pour le pourquoi.
   *
   * ⚠️ « Aucun blocage » et « publiable » ne sont donc PAS synonymes : avant la première
   * compilation, `counts.blocking === 0` reste un état parfaitement normal — il veut dire « rien à
   * signaler POUR L'INSTANT », pas « bon pour l'envoi ». Un consommateur qui veut armer un bouton
   * lit `canPublish`, jamais `counts.blocking` ni `findings.filter(level === "blocking")`.
   */
  canPublish: boolean;
  /** `null` tant qu'aucune compilation n'a été faite. */
  size: SizeFacts | null;
}

/** Poids à partir duquel on prévient AVANT d'avoir franchi le seuil Gmail. */
const APPROACHING_RATIO = 0.9;

/* ------------------------------------------------------------------ *
 * Cascade résolue — miroir de `resolve()` dans compile/mjml.ts
 *
 * Les propriétés HÉRITABLES descendent theme → row → column → block ; le fond, lui, est propre à
 * la boîte : le fond VU derrière un texte est celui du plus proche ancêtre qui en peint un.
 * ------------------------------------------------------------------ */

const inherit = <K extends keyof BoxStyle>(
  key: K,
  fallback: NonNullable<BoxStyle[K]>,
  layers: (BoxStyle | undefined)[],
): NonNullable<BoxStyle[K]> => {
  for (let i = layers.length - 1; i >= 0; i--) {
    const value = layers[i]?.[key];
    if (value !== undefined) return value as NonNullable<BoxStyle[K]>;
  }
  return fallback;
};

interface Resolved {
  textColor: string;
  /**
   * Couleur des TITRES (24/09/2026) : la cascade row → colonne → bloc, sinon `theme.headingColor`, sinon
   * le texte — la règle de `resolve()`. Juger un titre sur `textColor` mesurerait une couleur qui ne part pas.
   */
  headingColor: string;
  linkColor: string;
  fontSize: number;
  /** Fond effectivement vu derrière ce bloc. */
  background: string;
  /**
   * Vrai quand ce fond vient du THÈME et de rien d'autre. Décisif en mode sombre : l'override
   * `darkContentBackground` ne repeint que `.nf-content` (le wrapper). Une row, une colonne ou un
   * bloc qui pose son propre fond garde le sien en sombre — c'est un `background-color` inline sur
   * un élément imbriqué, que la media query ne vise pas.
   */
  backgroundFromTheme: boolean;
}

/** Le footer légal ne porte AUCUN style (schéma) et le compilateur ignore le sien : contenu injecté. */
const styleOf = (block: Block): BoxStyle | undefined =>
  block.type === "footer_legal" ? undefined : block.style;

function resolveBlock(theme: Theme, row: Row, column: Column, block: Block): Resolved {
  const own = styleOf(block);
  const chain = [row.style, column.style, own];
  const painted = own?.backgroundColor ?? column.style?.backgroundColor ?? row.style?.backgroundColor;
  let couleurPosee: string | undefined;
  for (let i = chain.length - 1; i >= 0 && couleurPosee === undefined; i--) couleurPosee = chain[i]?.textColor;
  return {
    textColor: inherit("textColor", theme.textColor, chain),
    headingColor: couleurPosee ?? theme.headingColor ?? theme.textColor,
    linkColor: inherit("linkColor", theme.linkColor, chain),
    fontSize: inherit("fontSize", theme.fontSize, chain),
    background: painted ?? theme.contentBackground,
    backgroundFromTheme: painted === undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Mode sombre — ce que la media query repeint VRAIMENT
 *
 * `headNode()` (compile/mjml.ts) n'émet que trois règles, et seulement pour les overrides posés :
 *   .nf-body    { background-color: darkBodyBackground }
 *   .nf-content { background-color: darkContentBackground }
 *   .nf-content, .nf-content td, .nf-content div, .nf-content p { color: darkTextColor }
 *
 * Deux conséquences qu'il faut modéliser pour ne pas raconter n'importe quoi :
 *  • un `!important` de feuille de style BAT un style inline sans `!important` (cascade CSS) : la
 *    couleur repeinte gagne donc contre celle que MJML pose sur chaque `<div>`/`<td>` ;
 *  • le sélecteur ne cite ni `a` ni `span`. Un lien inline, un libellé de bouton (`mj-button` rend
 *    un `<a>`) et un span coloré GARDENT leur couleur claire, posée sur un fond qui, lui, a changé.
 *    C'est exactement le cas qui casse : texte de marque clair resté sur un fond devenu sombre.
 * ------------------------------------------------------------------ */

/** Le thème pose-t-il un rendu sombre ? Sinon, la media query n'existe pas et il n'y a rien à juger. */
const hasDarkOverrides = (theme: Theme): boolean =>
  theme.darkBodyBackground !== undefined ||
  theme.darkContentBackground !== undefined ||
  theme.darkTextColor !== undefined;

/* ------------------------------------------------------------------ *
 * Géométrie — largeur utile d'un bloc (pour estimer un débordement de libellé)
 * ------------------------------------------------------------------ */

/**
 * ⚠️ `base` est DÉCLARÉ optionnel alors que `Theme` le rend obligatoire (defaults zod). Le type ment
 * dès qu'un appelant passe un document non parsé — un template lu en base, un JSON de maquette : les
 * `Spacing` du thème n'y sont pas écrits, `EmailDoc.parse()` seul les fabrique. Mesuré sur
 * `docs/maquettes/compile/harborTech.doc.json`, dont le thème n'a pas de `rowPadding` : un accès nu
 * `base.left` faisait tomber TOUT le pré-vol en `TypeError`, donc plus un seul constat à l'écran, y
 * compris les bloquants. Une géométrie approximative vaut mieux qu'un panneau mort.
 */
const pad = (base: Spacing | undefined, own: Spacing | undefined): { left: number; right: number } => ({
  left: own?.left ?? base?.left ?? 0,
  right: own?.right ?? base?.right ?? 0,
});

function innerWidth(theme: Theme, row: Row, colIndex: number, column: Column, block: Block): number {
  const rowPad = pad(theme.rowPadding, row.style?.padding);
  const colPad = pad({}, column.style?.padding);
  const blockPad = pad(theme.blockPadding, styleOf(block)?.padding);
  const weights = LAYOUT_WEIGHTS[row.layout];
  const total = weights.reduce((a, b) => a + b, 0);
  const rowInner = theme.contentWidth - rowPad.left - rowPad.right;
  const colWidth = Math.floor((rowInner * (weights[colIndex] ?? 1)) / total);
  return Math.max(40, colWidth - colPad.left - colPad.right - blockPad.left - blockPad.right);
}

/* ------------------------------------------------------------------ *
 * Échantillons de texte — ce que le compilateur peint réellement
 *
 * ⚠️ Ces tailles et graisses REPRODUISENT `PRESETS` et les fonctions de rendu de compile/mjml.ts,
 * qui ne les exporte pas. Une dérive donnerait un ratio calculé sur la mauvaise taille — donc un
 * seuil AA légèrement décalé, jamais un plantage.
 * ------------------------------------------------------------------ */

interface Sample {
  /** Ce qu'on regarde, en anglais, tel qu'affiché dans le constat. */
  what: string;
  color: string;
  size: number;
  bold: boolean;
  /** Fond propre (badge, bouton) quand il diffère du fond du bloc. */
  background?: string;
  /**
   * Texte peint sur un `<a>` ou un `<span>` — les deux éléments que le sélecteur du mode sombre ne
   * cite pas. Sa couleur SURVIT donc au passage en sombre, contrairement à celle des `<div>`/`<td>`.
   */
  onInline?: boolean;
}

const PRESET_SIZE: Record<TextPreset, (theme: Theme) => number> = {
  h1: () => 28,
  h2: () => 22,
  h3: () => 18,
  body: (t) => t.fontSize,
  small: () => 13,
};

const PRESET_BOLD: Record<TextPreset, boolean> = {
  h1: true,
  h2: true,
  h3: true,
  body: false,
  small: false,
};

const filled = (s: string | undefined): boolean => s !== undefined && s.trim() !== "";

/**
 * Le libellé de CTA qui PARTIRA sur cet article — pas celui qui dort en base.
 *
 * ⛔ Un article sans libellé stocké n'est PAS un article sans lien : `withDefaultCta`
 * (`@nf/render/feed`) pose le défaut de `meta.locale` sur tout bloc article DONT LE LIEN MÈNE
 * QUELQUE PART, au passage de `expandFeedBlocks`, donc à CHAQUE compilation — aperçu comme envoi. Le pré-vol, lui, tourne sur
 * le document STOCKÉ (`preflight-panel.tsx` l'appelle avec le doc brut). Lire `block.ctaLabel` tel
 * quel, c'était donc juger un email que personne ne reçoit, et se taire sur exactement la
 * population que le défaut couvre : l'auteur publiait sur du vert un lien qui arrive cassé sur
 * deux lignes chez l'abonné.
 *
 * ⚠️ Même condition que `withDefaultCta` (`!blank`) : un libellé fait d'espaces reçoit le défaut
 * là-bas, il doit recevoir le même ici, sinon les deux ne parlent plus du même email.
 *
 * ⛔ CHAÎNE VIDE = AUCUNE ANCRE N'EST ENVOYÉE, et c'est un troisième état, pas un défaut manquant.
 * `withDefaultCta` ne fabrique rien par-dessus un href qui ne mène nulle part (`goesNowhere`,
 * `@nf/render/links`) : sans libellé, `articleHtml` n'émet aucun `<a>`. Rendre le défaut ici sans
 * regarder le href, c'était PRÉDIRE un bouton que la compilation refuse de poser — mesuré sur un
 * article au href `#` : deux constats consultatifs sortaient, dont un affirmant mot pour mot que le
 * libellé « ships even though the field looks empty ».
 *
 * ⛔ L'ORDRE EST LE MÊME QU'À LA COMPILATION : le libellé est jugé AVANT le href. Un libellé SAISI
 * ressort toujours, même sur un lien douteux — la garde ne retient que ce que le produit fabrique,
 * elle n'efface jamais une saisie. Inverser les deux lignes ferait taire le pré-vol sur des
 * libellés bien réels.
 */
const effectiveArticleCta = (block: Extract<Block, { type: "article" }>, locale: string): string => {
  // ⛔ EN PREMIER, comme dans `withDefaultCta` (feed.ts) et dans `articleHtml` (compile/mjml.ts) :
  // `ctaStyle:"none"` est un refus explicite d'émettre le lien de lecture. Le tester après le
  // libellé faisait mesurer le contraste d'un lien que la compilation n'écrit jamais — un avis de
  // contraste sur un texte qui n'existe pas, au milieu d'avis bien réels.
  if (block.ctaStyle === "none") return "";
  if (filled(block.ctaLabel)) return block.ctaLabel as string;
  return goesNowhere(block.href) ? "" : defaultArticleCta(locale);
};

function samplesOf(block: Block, theme: Theme, r: Resolved, locale: string): Sample[] {
  const fs = r.fontSize;
  const out: Sample[] = [];

  switch (block.type) {
    case "text": {
      const size = block.style?.fontSize ?? PRESET_SIZE[block.preset](theme);
      const bold = PRESET_BOLD[block.preset];
      const titre = block.preset === "h1" || block.preset === "h2" || block.preset === "h3";
      out.push({ what: "body text", color: titre ? r.headingColor : r.textColor, size, bold });
      if (block.paragraphs.some((p) => p.spans.some((s) => s.href !== undefined))) {
        out.push({ what: "inline link", color: r.linkColor, size, bold, onInline: true });
      }
      // Une couleur posée sur un span écrase tout le reste : elle mérite son propre verdict.
      for (const paragraph of block.paragraphs) {
        for (const span of paragraph.spans) {
          if (span.color !== undefined) out.push({ what: "coloured text", color: span.color, size, bold, onInline: true });
        }
      }
      break;
    }

    case "button":
      out.push({
        what: "button label",
        color: theme.buttonTextColor,
        size: Math.max(14, fs - 1),
        bold: true,
        background: theme.brandColor,
        onInline: true,
      });
      break;

    case "menu":
      out.push({ what: "menu links", color: r.linkColor, size: Math.max(12, fs - 2), bold: true, onInline: true });
      break;

    case "pick":
      if (filled(block.kickoffLabel)) {
        out.push({ what: "kick-off label", color: theme.mutedColor, size: Math.max(11, fs - 4), bold: true });
      }
      if (filled(block.matchLabel)) out.push({ what: "match label", color: r.textColor, size: fs + 1, bold: true });
      if (filled(block.marketLabel)) {
        out.push({ what: "market label", color: theme.mutedColor, size: Math.max(11, fs - 4), bold: false });
      }
      if (filled(block.selectionLabel)) {
        out.push({ what: "selection label", color: theme.brandColor, size: fs, bold: true });
      }
      if (filled(block.oddsLabel)) {
        out.push({
          what: "odds badge",
          color: theme.buttonTextColor,
          size: fs + 1,
          bold: true,
          background: theme.brandColor,
        });
      }
      if (filled(block.confidenceLabel)) {
        out.push({ what: "confidence label", color: theme.mutedColor, size: Math.max(11, fs - 4), bold: false });
      }
      if (filled(block.href) && filled(block.ctaLabel)) {
        out.push({
          what: "call to action",
          color: theme.buttonTextColor,
          size: Math.max(13, fs - 2),
          bold: true,
          background: theme.brandColor,
          onInline: true,
        });
      }
      break;

    case "odds_table":
      out.push({ what: "odds rows", color: r.textColor, size: Math.max(12, fs - 1), bold: false });
      if (filled(block.caption)) {
        out.push({ what: "caption", color: theme.mutedColor, size: Math.max(11, fs - 4), bold: false });
      }
      break;

    case "standings": {
      const size = Math.max(12, fs - 2);
      out.push({ what: "column headers", color: theme.mutedColor, size: Math.max(10, size - 1), bold: true });
      if (block.rows.length > 0) out.push({ what: "table cells", color: r.textColor, size, bold: false });
      if (filled(block.caption)) {
        out.push({ what: "caption", color: theme.mutedColor, size: Math.max(11, fs - 4), bold: false });
      }
      break;
    }

    case "article": {
      // ⚠️ Les valeurs par défaut ci-dessous RECOPIENT `articleHtml` (compile/mjml.ts). Une seule
      // divergence — une taille, une couleur de repli — et le contrôle jugerait un texte qui n'est
      // pas celui qui part.
      const kickerSize = block.kickerSize ?? Math.max(10, fs - 4);
      if (filled(block.kicker)) {
        out.push({ what: "article kicker", color: block.kickerColor ?? theme.mutedColor, size: kickerSize, bold: true });
      }
      if (filled(block.kickerAccent)) {
        // L'heure du surtitre : c'est elle qui porte la couleur vive, donc elle qui casse.
        out.push({
          what: "article kicker accent",
          color: block.kickerAccentColor ?? theme.brandColor,
          size: kickerSize,
          bold: true,
        });
      }
      if (filled(block.title)) {
        out.push({
          what: "title",
          color: block.titleColor ?? r.headingColor,
          size: block.titleSize ?? fs + 3,
          // Le seuil « gros texte » de WCAG s'ouvre à partir de 700 : une graisse 300 posée à la
          // main ne doit pas hériter du seuil relâché que le titre avait en dur.
          bold: Number(block.titleWeight ?? "700") >= 700,
        });
      }
      if (filled(block.excerpt)) out.push({ what: "excerpt", color: r.textColor, size: fs, bold: false });
      const metaSize = block.metaSize ?? Math.max(10, fs - 3);
      if (filled(block.meta)) {
        out.push({ what: "article meta", color: block.metaColor ?? theme.mutedColor, size: metaSize, bold: false });
      }
      if (filled(block.metaAccent)) {
        // Rendu en 600 : sous le seuil « gras » de WCAG, donc jugé au seuil strict — le contraire
        // relâcherait la règle sur le seul mot coloré de la ligne.
        out.push({
          what: "article meta accent",
          color: block.metaAccentColor ?? theme.brandColor,
          size: metaSize,
          bold: false,
        });
      }
      // Le lien « read more » existe dans le HTML livré dès que le href mène quelque part, libellé
      // saisi ou non : le tester sur le brut rendait la règle de contraste aveugle à tous les
      // articles importés — le seul lien cliquable de la carte quand elle n'a pas de vignette.
      // Sur un href mort, en revanche, la compilation n'émet aucun `<a>` : juger sa couleur, ce
      // serait mesurer le contraste d'un texte que personne ne reçoit.
      if (filled(effectiveArticleCta(block, locale))) {
        // ⛔ DEUX FORMES, DEUX COUPLES DE COULEURS — depuis le 22/09/2026, `ctaStyle` absent ou
        // `button` sort en bouton plein (`ctaTable`), et seul `link` reste un lien souligné. Juger
        // la couleur de lien sur un bouton, c'était mesurer un contraste qui n'existe nulle part :
        // le texte du bouton n'est pas `linkColor` et il ne repose pas sur le fond du bloc.
        out.push(
          block.ctaStyle === "link"
            ? { what: "read-more link", color: block.ctaColor ?? r.linkColor, size: block.ctaSize ?? fs, bold: true, onInline: true }
            : {
                what: "read-more button",
                // Les mêmes valeurs que `ctaTable` : texte de bouton du thème sur la couleur de
                // marque, taille `fontSize - 2` avec un plancher à 13.
                color: theme.buttonTextColor,
                size: Math.max(13, (block.ctaSize ?? fs) - 2),
                bold: true,
                background: theme.brandColor,
                onInline: true,
              },
        );
      }
      break;
    }

    case "section_title":
      // Le filet n'est pas du texte : seul le libellé se mesure. Graisse 700 par défaut, comme
      // `sectionTitleHtml`.
      if (filled(block.label)) out.push({ what: "section title", color: r.headingColor, size: fs, bold: true });
      break;

    case "callout":
      // ⚠️ Le fond du callout est celui du BLOC : il est déjà résolu dans `r`, donc les échantillons
      // ci-dessous sont comparés au bon aplat. C'est exactement ce que la règle doit voir — un
      // kicker atténué sur un aplat de marque est le cas qui casse.
      //
      // ⛔ MISES EN PAGE (23/09/2026) : le texte posé sur la photo est jugé contre la COULEUR DE REPLI
      // (`style.backgroundColor`, déjà dans `r`) — c'est ce que voit le lecteur quand l'image ne vient
      // pas, et c'est le seul fond qu'on connaisse : la photo, elle, ne se mesure pas. Deux surfaces
      // ont leur propre aplat et le disent : la gélule du surtitre, la souche du ticket. Les valeurs
      // RECOPIENT `compile/callout-layouts.ts`.
      if (filled(block.kicker)) {
        const pill = block.layout !== undefined && block.kickerStyle === "pill";
        out.push({
          what: "callout kicker",
          color: block.kickerColor ?? (pill ? theme.buttonTextColor : theme.mutedColor),
          size: block.kickerSize ?? Math.max(11, fs - 4),
          bold: true,
          ...(pill ? { background: block.kickerAccent ?? theme.brandColor } : {}),
        });
      }
      if (filled(block.title)) {
        // `titleColor` est la couleur que le compilateur pose : la juger sur `r.textColor` mesurait un
        // titre que personne ne reçoit dès qu'elle était réglée (le blanc des affiches, entre autres).
        out.push({
          what: "callout title",
          color: block.titleColor ?? r.headingColor,
          size: block.titleSize ?? Math.max(18, fs + 4),
          bold: true,
        });
      }
      if (filled(block.body)) {
        out.push(
          block.layout === "ticket"
            ? {
                what: "callout body",
                color: block.stubTextColor ?? block.bodyColor ?? theme.buttonTextColor,
                size: fs,
                bold: false,
                background: block.stubBackground ?? theme.brandColor,
              }
            : { what: "callout body", color: block.bodyColor ?? r.textColor, size: fs, bold: false },
        );
      }
      // Le bouton n'existe QUE si les deux moitiés sont là — même condition que `calloutHtml`.
      // Le juger sans lien mesurerait la couleur d'un texte que personne ne reçoit.
      if (block.href !== undefined && filled(block.ctaLabel)) {
        out.push({
          what: "callout call to action",
          color: block.ctaTextColor ?? theme.buttonTextColor,
          size: Math.max(13, fs - 2),
          bold: true,
          background: block.ctaBackground ?? theme.brandColor,
          onInline: true,
        });
      }
      break;

    case "scoreboard":
      if (filled(block.kicker)) {
        out.push({
          what: "scoreboard kicker",
          color: block.kickerColor ?? theme.mutedColor,
          size: Math.max(11, fs - 4),
          bold: true,
        });
      }
      // ⚠️ Ces couleurs RECOPIENT `scoreboardHtml` : une ligne atténuée sur un aplat clair est
      // exactement le cas qui casse, et le mesurer sur la mauvaise couleur rendrait le contrôle
      // vert sur un texte illisible.
      for (const row of block.rows) {
        if (filled(row.label)) {
          out.push({
            what: "scoreboard label",
            color: row.highlight ? r.textColor : theme.mutedColor,
            size: fs,
            bold: row.highlight,
          });
        }
        if (filled(row.value)) {
          out.push({
            what: "scoreboard value",
            color: row.highlight ? theme.brandColor : theme.mutedColor,
            size: block.valueSize ?? Math.max(24, fs * 2),
            bold: true,
          });
        }
      }
      // Pied du bandeau — mêmes valeurs que `scoreboardHtml` : le lien en `textColor` 600, la note
      // en `footerColor` sinon atténuée. C'est le texte le plus petit du bloc, donc le plus exposé.
      if (filled(block.footerLabel)) {
        out.push({ what: "scoreboard footer link", color: r.textColor, size: Math.max(11, fs - 1), bold: false });
      }
      if (filled(block.footerNote)) {
        out.push({
          what: "scoreboard footer note",
          color: block.footerColor ?? theme.mutedColor,
          size: Math.max(11, fs - 2),
          bold: false,
        });
      }
      break;

    case "promo":
      if (filled(block.headline)) out.push({ what: "headline", color: r.textColor, size: fs + 3, bold: true });
      if (filled(block.body)) out.push({ what: "body copy", color: r.textColor, size: fs, bold: false });
      if (filled(block.code)) out.push({ what: "promo code", color: r.textColor, size: fs + 1, bold: true });
      if (filled(block.ctaLabel)) {
        out.push({
          what: "call to action",
          color: theme.buttonTextColor,
          size: Math.max(13, fs - 2),
          bold: true,
          background: theme.brandColor,
          onInline: true,
        });
      }
      // Les mentions légales sont le texte le plus petit et le plus atténué de l'email : c'est
      // exactement là que le contraste casse, et c'est le texte qu'un régulateur ira lire.
      if (filled(block.terms)) {
        out.push({ what: "terms", color: theme.mutedColor, size: Math.max(10, fs - 5), bold: false });
      }
      break;

    // Pas de texte peint par le compilateur : image, divider, spacer, html (opaque), social
    // (libellés optionnels rendus par MJML), footer_legal (injecté à l'envoi).
    default:
      break;
  }

  return out;
}

/** Échantillon dont le fond est arrêté — plus rien à résoudre, le ratio se calcule. */
type Painted = Sample & { background: string };

/** L'échantillon tel qu'un client en mode sombre le peindra RÉELLEMENT. */
function darkSample(sample: Sample, r: Resolved, theme: Theme): Painted {
  return {
    ...sample,
    color: sample.onInline ? sample.color : (theme.darkTextColor ?? sample.color),
    // Le fond PROPRE d'un badge ou d'un bouton est un `background-color` inline sur un élément
    // imbriqué : la media query ne le vise pas, il reste tel quel.
    background:
      sample.background ??
      (r.backgroundFromTheme ? (theme.darkContentBackground ?? r.background) : r.background),
  };
}

/**
 * Le PIRE échantillon sous le seuil AA, ou `null` si tout passe.
 *
 * Un seul constat par bloc et par rendu : lister six lignes pour une carte dont la palette est
 * globalement fausse noie l'information au lieu de la donner.
 */
function worstFailure(samples: Painted[]): { sample: Painted; ratio: number; minimum: number } | null {
  let worst: { sample: Painted; ratio: number; minimum: number } | null = null;
  for (const sample of samples) {
    const ratio = contrastRatio(sample.color, sample.background);
    if (ratio === null) continue;
    const minimum = wcagMinimum(sample.size, sample.bold);
    if (ratio >= minimum) continue;
    if (worst === null || ratio < worst.ratio) worst = { sample, ratio, minimum };
  }
  return worst;
}

/* ------------------------------------------------------------------ *
 * Liens
 * ------------------------------------------------------------------ */

interface LinkRef {
  href: string;
  /** Texte cliquable, quand il existe — sert au constat de conformité. */
  label?: string;
  what: string;
}

/** Extraction STRUCTURELLE (pas une règle) : le compilateur garde la sienne, privée. */
function linksOf(block: Block, locale: string): LinkRef[] {
  switch (block.type) {
    case "button":
      return [{ href: block.href, label: block.label, what: `button "${block.label}"` }];
    case "image":
      return block.href ? [{ href: block.href, label: block.alt, what: "image link" }] : [];
    case "text":
      return block.paragraphs.flatMap((p) =>
        p.spans
          .filter((s) => s.href !== undefined)
          .map((s) => ({ href: s.href as string, label: s.text, what: `link "${s.text}"` })),
      );
    case "menu":
      return block.items.map((i) => ({ href: i.href, label: i.label, what: `menu item "${i.label}"` }));
    case "social":
      return block.items.map((i) => ({ href: i.href, what: `social link "${i.platform}"` }));
    case "pick":
      return block.href ? [{ href: block.href, label: block.ctaLabel, what: "pick call to action" }] : [];
    case "article": {
      // ⚠️ Le titre n'est PAS un lien dans le HTML rendu (`<div>` nu, compile/mjml.ts:538) : le seul
      // texte cliquable de la carte est le CTA, et le défaut de `meta.locale` le pose à la
      // compilation dès lors que le href mène quelque part (`withDefaultCta`, @nf/render/feed — qui
      // ne pose rien sur un lien mort, pour ne pas fabriquer un bouton qui ne tient pas sa promesse).
      // Le repli sur le titre décrivait donc un texte cliquable qui n'a jamais été envoyé — et il ne
      // servait QUE sur les articles sans libellé, c'est-à-dire là où le défaut répond désormais.
      // ⚠️ `label` reste ABSENT quand rien ne part : `LinkRef.label` dit « texte cliquable, quand
      // il existe », et une chaîne vide s'y ferait passer pour un texte. L'entrée, elle, RESTE —
      // le href est toujours stocké, et les contrôles de merge tag doivent continuer de le voir.
      // ⚠️ Depuis `titleLink`, le titre PEUT être le texte cliquable — et quand il l'est, c'est lui
      // que le lecteur voit. Il passe donc devant le libellé de lecture, qui peut être absent.
      const cta = effectiveArticleCta(block, locale);
      const texte = block.titleLink === true && block.title.trim() !== "" ? block.title : cta;
      return [{ href: block.href, ...(texte === "" ? {} : { label: texte }), what: "article link" }];
    }
    case "callout":
      return block.href === undefined
        ? []
        : [{ href: block.href, ...(filled(block.ctaLabel) ? { label: block.ctaLabel } : {}), what: "callout link" }];
    case "scoreboard":
      // ⛔ Sans cette entrée, le lien du pied échappe au contrôle https, au contrôle du lien de
      // désabonnement et au décompte des liens : il partirait sans que rien ne rougisse.
      return block.footerHref === undefined
        ? []
        : [
            {
              href: block.footerHref,
              ...(filled(block.footerLabel) ? { label: block.footerLabel } : {}),
              what: "scoreboard footer link",
            },
          ];
    case "promo":
      return [{ href: block.href, label: block.ctaLabel, what: "promo call to action" }];
    default:
      return [];
  }
}

/** Tokens `{{…}}` d'une chaîne, syntaxe de `hydrate()` (`{{name}}` ou `{{name|fallback}}`). */
function tokensIn(value: string): string[] {
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*(?:\|[^}]*)?\}\}/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(m[1] as string);
  return out;
}

const isKnownVar = (name: string): name is keyof typeof MERGE_VARS =>
  Object.prototype.hasOwnProperty.call(MERGE_VARS, name);

/* ------------------------------------------------------------------ *
 * Corrections mécaniques
 *
 * Chaque fonction rend un PATCH DE BLOC, ou `null` quand il n'y a rien de mécanique à faire. Elles
 * sont pures et exportées : elles se vérifient sans navigateur ni base.
 * ------------------------------------------------------------------ */

const HTTP_PREFIX = /^(\s*)http:\/\//i;

/** `http://…` → `https://…`, en conservant les blancs de bord (ils font partie de la valeur stockée). */
const toHttps = (href: string): string => href.replace(HTTP_PREFIX, "$1https://");

const isHttp = (href: string | undefined): boolean => href !== undefined && HTTP_PREFIX.test(href);

/**
 * Passe en `https://` TOUTES les URL en clair du bloc, d'un coup.
 *
 * Le tout-ou-rien est volontaire : un bloc menu peut porter cinq liens `http://`, et corriger le
 * premier laisserait l'utilisateur cliquer cinq fois sur le même bouton sans jamais voir le constat
 * disparaître. Le changement est mécanique — même hôte, même chemin, même paramètres — et un serveur
 * qui ne répond pas en TLS aujourd'hui fait de toute façon déjà bloquer l'image ou signaler le lien.
 */
export function httpsFix(block: Block): PreflightFix | null {
  const patch: Record<string, unknown> = {};
  let count = 0;

  const fix = (key: string, value: string | undefined): void => {
    if (!isHttp(value)) return;
    patch[key] = toHttps(value as string);
    count += 1;
  };

  switch (block.type) {
    case "image":
      fix("src", block.src);
      fix("href", block.href);
      break;
    case "button":
    case "promo":
      fix("href", block.href);
      break;
    case "callout":
      fix("href", block.href);
      // La vignette de l'encart suit la même règle que celle d'un article : une image en http
      // déclenche l'avertissement de contenu mixte dans la moitié des clients.
      fix("imageSrc", block.imageSrc);
      // Mises en page (23/09/2026) : la photo de fond et les cases de galerie sont des images comme
      // les autres. `gallery` est remplacé en ENTIER, pour la même raison que `items` plus bas.
      fix("backgroundImage", block.backgroundImage);
      if (block.gallery?.some((tile) => isHttp(tile.src))) {
        patch.gallery = block.gallery.map((tile) => (isHttp(tile.src) ? { ...tile, src: toHttps(tile.src) } : tile));
        count += block.gallery.filter((tile) => isHttp(tile.src)).length;
      }
      break;
    case "scoreboard":
      fix("footerHref", block.footerHref);
      break;
    case "pick":
      fix("href", block.href);
      break;
    case "article":
      fix("href", block.href);
      fix("imageSrc", block.imageSrc);
      break;
    case "menu":
    case "social": {
      if (!block.items.some((item) => isHttp(item.href))) break;
      // `items` est remplacé en ENTIER : le patch part dans `updateBlock`, qui fusionne au premier
      // niveau seulement. Un patch partiel du tableau perdrait les autres entrées.
      patch.items = block.items.map((item) => (isHttp(item.href) ? { ...item, href: toHttps(item.href) } : item));
      count = block.items.filter((item) => isHttp(item.href)).length;
      break;
    }
    case "text": {
      if (!block.paragraphs.some((p) => p.spans.some((span) => isHttp(span.href)))) break;
      patch.paragraphs = block.paragraphs.map((paragraph) => ({
        ...paragraph,
        spans: paragraph.spans.map((span) =>
          isHttp(span.href) ? { ...span, href: toHttps(span.href as string) } : span,
        ),
      }));
      count = block.paragraphs.reduce(
        (n, p) => n + p.spans.filter((span) => isHttp(span.href)).length,
        0,
      );
      break;
    }
    default:
      break;
  }

  if (count === 0) return null;
  return {
    blockId: block.id,
    patch: patch as Partial<Block>,
    label: count === 1 ? "Switch to https://" : `Switch ${count} URLs to https://`,
  };
}

/**
 * Retire la sentinelle d'illustration `ai://` d'un bloc article : la vignette disparaît, l'article
 * reste publiable et se rend en texte seul.
 *
 * Pas d'équivalent pour un bloc `image` : `src` y est OBLIGATOIRE (min 1 au schéma), retirer la
 * sentinelle voudrait dire supprimer le bloc — c'est-à-dire décider à la place de l'utilisateur que
 * cette illustration ne comptait pas. Il génère l'image ou il supprime le bloc lui-même.
 */
export function dropPlaceholderImageFix(block: Block): PreflightFix | null {
  if (block.type !== "article" || block.imageSrc === undefined || !isPlaceholderSrc(block.imageSrc)) return null;
  return {
    blockId: block.id,
    // `undefined` et pas `""` : `imageSrc` est optionnel, une chaîne vide serait refusée au parse.
    patch: { imageSrc: undefined } as Partial<Block>,
    label: "Remove the placeholder image",
  };
}

/**
 * Plus court libellé de bouton qu'on accepte de fabriquer. En dessous, ce n'est plus un libellé —
 * c'est le signe que la COLONNE est trop étroite, et la réparation est de l'élargir. On n'offre
 * alors aucun bouton plutôt que de proposer « Shorten to “C” », qui ne corrigerait rien.
 */
const MIN_LABEL = 3;

/**
 * Rogne un libellé de bouton pour qu'il tienne sur une ligne.
 *
 * On coupe à la FRONTIÈRE DE MOT la plus proche sous la limite : couper au milieu d'un mot
 * fabriquerait un libellé qui n'existe dans aucune langue. Si le premier mot dépasse à lui seul,
 * on tranche dedans — un libellé rogné reste plus lisible qu'un bouton cassé, et le bouton montre
 * le résultat exact avant d'être cliqué.
 */
export function shortenLabelFix(block: Block, maxChars: number): PreflightFix | null {
  const current =
    block.type === "button"
      ? block.label
      : block.type === "promo" || block.type === "pick" || block.type === "article" || block.type === "callout"
        ? block.ctaLabel
        : undefined;
  if (current === undefined) return null;

  // `MAX_BUTTON_LABEL` borne le schéma ; la géométrie de la colonne peut être plus sévère encore.
  const limit = Math.min(MAX_BUTTON_LABEL, Math.floor(maxChars));
  if (limit < MIN_LABEL) return null;
  const trimmed = current.trim();
  if (trimmed.length <= limit) return null;

  const cut = trimmed.slice(0, limit);
  const boundary = cut.lastIndexOf(" ");
  const atWord = boundary > 0 ? cut.slice(0, boundary) : "";
  const next = (atWord.length >= MIN_LABEL ? atWord : cut).replace(/[\s,.;:—–-]+$/u, "");
  if (next.length < MIN_LABEL || next === trimmed) return null;

  const patch: Partial<Block> = block.type === "button" ? ({ label: next } as Partial<Block>) : ({ ctaLabel: next } as Partial<Block>);
  return { blockId: block.id, patch, label: `Shorten to “${next}”` };
}

/**
 * Aligne le plancher d'un flux d'articles sur la quantité demandée (`minCount` ← `count`).
 *
 * ⚠️ Ce refus est ATTEIGNABLE depuis l'éditeur, contrairement à la plupart des branches de
 * `EmailDocPublishable` : `count` et `minCount` sont deux champs voisins, tous deux valides
 * isolément (1..12), et baisser `count` à 2 sans toucher au plancher laissé à 3 produit un document
 * que `EmailDoc` accepte et que la publication refuse. L'auteur voyait donc un blocage sans aucun
 * bouton, sur deux champs dont rien ne disait qu'ils étaient liés.
 *
 * La valeur n'est PAS inventée : elle est lue dans le bloc, à côté. Le sens du rabotage compte —
 * on baisse le plancher, jamais on ne monte la demande : monter `count` ferait partir plus
 * d'articles que l'auteur n'en a demandé, ce qui est une décision éditoriale.
 */
export function clampMinCountFix(block: Block): PreflightFix | null {
  if (block.type !== "article-feed" || block.minCount <= block.count) return null;
  return {
    blockId: block.id,
    patch: { minCount: block.count } as Partial<Block>,
    label: `Set the minimum to ${block.count} article${block.count > 1 ? "s" : ""}`,
  };
}

/** Tous les `footer_legal` du document, avec la row et la colonne qui les portent. */
function legalFooters(doc: EmailDoc): { blockId: string; rowId: string; colId: string }[] {
  const out: { blockId: string; rowId: string; colId: string }[] = [];
  for (const row of doc.rows) {
    for (const column of row.columns) {
      for (const block of column.blocks) {
        if (block.type === "footer_legal") out.push({ blockId: block.id, rowId: row.id, colId: column.id });
      }
    }
  }
  return out;
}

/**
 * Ne garde qu'un seul footer légal et supprime les autres.
 *
 * ⛔ POURQUOI CETTE SUPPRESSION-LÀ EST LÉGITIME, ET PAS UNE AUTRE : `FooterLegalBlock` ne déclare
 * que `id` et `type` (schéma) — aucune propriété éditable, par décision de conformité. Deux
 * exemplaires sont donc littéralement interchangeables, et en retirer un ne détruit AUCUN contenu :
 * c'est de la mécanique, pas un arbitrage. La même suppression appliquée à un bloc porteur de texte
 * effacerait du travail.
 *
 * On conserve le DERNIER : la convention du document est que le footer termine l'email, garder
 * celui d'en haut aurait laissé un `footerpos` derrière soi — une réparation qui en déclenche une
 * autre n'est pas une réparation.
 */
export function removeLegalFooterDuplicatesFix(doc: EmailDoc): PreflightFix | null {
  const footers = legalFooters(doc);
  if (footers.length < 2) return null;

  const kept = footers[footers.length - 1] as (typeof footers)[number];
  const dropped = footers.slice(0, -1);
  const droppedIds = new Set(dropped.map((f) => f.blockId));

  // Une row dont TOUS les blocs partent ne doit pas rester : elle laisserait un emplacement vide
  // dans l'éditeur, que l'utilisateur devrait supprimer à la main derrière un bouton « corriger ».
  const removeRowIds = doc.rows
    .filter((row) => {
      const blocks = row.columns.flatMap((c) => c.blocks);
      return blocks.length > 0 && blocks.every((b) => droppedIds.has(b.id));
    })
    .map((row) => row.id);

  return {
    blockId: kept.blockId,
    patch: {},
    removeBlockIds: dropped.map((f) => f.blockId),
    ...(removeRowIds.length > 0 ? { removeRowIds } : {}),
    label: `Remove ${dropped.length} duplicate legal footer${dropped.length > 1 ? "s" : ""}`,
  };
}

/**
 * Ajoute le footer légal manquant, en dernière row du document.
 *
 * ⚠️ Rien n'est inventé : le bloc ne porte AUCUN contenu (le worker injecte le footer conforme au
 * moment de l'envoi, avec les liens signés du destinataire). Seule la CONVENTION DE POSITION est à
 * poser, et elle est déjà posée ailleurs — le chemin IA fait exactement cette insertion tout seul
 * (`lib/ai/compose.ts`). Refuser de l'offrir ici pendant qu'un autre chemin la fait en silence,
 * c'était trois régimes pour une seule règle.
 *
 * ⛔ DÉPLACER un footer mal placé reste HUMAIN et n'a donc pas de fabrique : la destination n'est
 * déterministe que si la dernière row est en layout « 1 ». En multi-colonnes il faudrait CHOISIR la
 * colonne d'arrivée — un arbitrage, pas une mécanique.
 */
export function appendLegalFooterFix(doc: EmailDoc): PreflightFix | null {
  if (legalFooters(doc).length > 0) return null;

  const blockId = newId("blk");
  const row = Row.parse({
    id: newId("row"),
    layout: "1",
    columns: [{ id: newId("col"), blocks: [{ id: blockId, type: "footer_legal" }] }],
  });

  return {
    blockId,
    patch: {},
    insertRow: { row, index: doc.rows.length },
    label: "Add the legal footer at the end",
  };
}

/* ------------------------------------------------------------------ *
 * Conformité — le désabonnement ne s'écrit pas à la main
 * ------------------------------------------------------------------ */

/**
 * Vocabulaire de désabonnement des 6 langues de la plateforme (chaîne recomposée en NFC avant test).
 * Un faux positif coûte une explication ; un faux négatif coûte un lien de désabonnement mort
 * dans un envoi réel — on penche donc du côté large, et on ne signale QUE des liens (un texte
 * « you can unsubscribe at any time » sans href reste une phrase parfaitement légitime).
 */
const UNSUB_WORDS =
  /(unsubscribe|opt[-\s]?out|d[eé]sinscri|d[eé]sabonn|descadastr|cancelar (a |sua )?(inscri|assinatura|suscrip)|darse de baja|abmelden|abbestellen|annulla (l')?iscrizione|disiscriv)/i;

/** NFC avant test : un « désabonner » saisi en forme décomposée doit matcher comme un autre. */
const mentionsUnsub = (s: string | undefined): boolean =>
  s !== undefined && UNSUB_WORDS.test(s.normalize("NFC"));

/** Un href qui n'est QUE le token système (éventuellement avec des espaces autour). */
const isPlatformUnsubToken = (href: string): boolean =>
  /^\s*\{\{\s*(unsubscribe_url|preferences_url)\s*(\|[^}]*)?\}\}\s*$/.test(href);

/* ------------------------------------------------------------------ *
 * L'AUTORITÉ, c'est le schéma de publication
 *
 * `POST …/publish` refuse en 422 sur `EmailDocPublishable.safeParse()`. On interroge donc CE
 * schéma plutôt que de réécrire sa règle : une seconde implémentation aurait dérivé au premier
 * changement de vocabulaire, et l'utilisateur aurait vu soit un verrou que le serveur n'applique
 * pas, soit un refus surprise au moment de publier. Le pré-vol garde en propre le versant LARGE
 * (soupçon → consultatif) ; le versant BLOQUANT vient d'ici, à la virgule près.
 * ------------------------------------------------------------------ */

/** Début du message que le schéma produit pour un désabonnement écrit à la main. */
const SCHEMA_UNSUB_PREFIX = "hand-written unsubscribe link";

/**
 * Refus du schéma que le compilateur dit DÉJÀ, avec de meilleurs mots (`BLOCKING_WARNINGS` leur
 * donne le niveau bloquant). Les répéter afficherait deux fois la même ligne.
 *
 * ⛔ CE FILTRE ÉTAIT INCONDITIONNEL, ET C'EST CE QUI FAISAIT MENTIR LE VERROU.
 * Les avertissements du compilateur n'arrivent que dans `if (compiled)` : MJML ne tourne pas dans
 * le navigateur, ils viennent de `POST /api/builder/preview`. Or le panneau MONTE avec
 * `compiled = null`. On retirait donc quatre refus au motif que quelqu'un d'autre les dirait, au
 * moment précis où personne ne les disait : `counts.blocking` tombait à 0, `canPublish` passait à
 * vrai, le bouton « Publish » s'armait — et `POST …/publish` répondait 422 sur le refus jamais
 * affiché. Exactement le « refus surprise » que la doctrine en tête de fichier interdit.
 *
 * Le filtre est donc conditionné à la PRÉSENCE des faits compilés : sans eux, le schéma parle seul
 * et on l'écoute ; avec eux, le compilateur reprend la main et sa formulation, plus précise (elle
 * cite le bloc et le fichier), reste la seule affichée.
 *
 * Tout ce qui n'est ni dans cette liste ni un désabonnement remonte tel quel : c'est le filet qui
 * empêche le panneau d'annoncer « publiable » sur un document que le serveur refusera.
 */
const SCHEMA_MESSAGES_ALREADY_SAID = new Set([
  "subject is required to publish",
  "the legal footer cannot sit inside a conditional row or column — it must reach every recipient",
  "alt text is required to publish",
  "this image is still an AI placeholder — generate or upload the picture before publishing",
]);

const readPath = (root: unknown, path: readonly PropertyKey[]): unknown => {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
};

/** Chemin JSON d'une issue zod → cible cliquable. Tolère un chemin plus court (row, colonne). */
function targetOfPath(doc: EmailDoc, path: readonly PropertyKey[]): PreflightTarget | undefined {
  if (path[0] !== "rows") return undefined;
  const row = doc.rows[Number(path[1])];
  if (row === undefined) return undefined;
  if (path[2] !== "columns") return { rowId: row.id };
  const column = row.columns[Number(path[3])];
  if (column === undefined) return { rowId: row.id };
  if (path[4] !== "blocks") return { rowId: row.id, colId: column.id };
  const block = column.blocks[Number(path[5])];
  if (block === undefined) return { rowId: row.id, colId: column.id };
  return { rowId: row.id, colId: column.id, blockId: block.id, blockType: block.type };
}

interface SchemaVerdict {
  /** hrefs refusés comme désabonnement écrit à la main, indexés par bloc. */
  refusedUnsub: Map<string, Set<string>>;
  /** Tout autre refus de publication que le compilateur ne dit pas déjà. */
  others: {
    message: string;
    target?: PreflightTarget;
    key: string;
    /**
     * Chemin zod du refus. Conservé pour rattacher un correctif au CHAMP exact : le message est de
     * l'interface et bougera, le chemin est structurel. Sans lui on ne pourrait distinguer qu'à la
     * phrase, et un correctif attaché « au bloc » s'afficherait sous n'importe quel refus visant ce
     * bloc — un bouton qui répare autre chose que ce qu'il annonce.
     */
    path: readonly PropertyKey[];
  }[];
}

/**
 * @param compilerSpoke Vrai quand les avertissements du compilateur seront affichés à côté. Sa
 * valeur par défaut est FAUSSE — c'est-à-dire « personne d'autre ne parle, on dit tout » : un
 * appelant qui oublie l'argument obtient un rapport trop bavard, jamais un verrou désarmé.
 */
export function schemaVerdict(doc: EmailDoc, compilerSpoke = false): SchemaVerdict {
  const refusedUnsub = new Map<string, Set<string>>();
  const others: SchemaVerdict["others"] = [];

  const parsed = EmailDocPublishable.safeParse(doc);
  if (parsed.success) return { refusedUnsub, others };

  parsed.error.issues.forEach((issue, i) => {
    const target = targetOfPath(doc, issue.path);
    if (issue.message.startsWith(SCHEMA_UNSUB_PREFIX)) {
      const href = readPath(doc, issue.path);
      if (target?.blockId !== undefined && typeof href === "string") {
        const set = refusedUnsub.get(target.blockId) ?? new Set<string>();
        set.add(href);
        refusedUnsub.set(target.blockId, set);
        return;
      }
    }
    if (compilerSpoke && SCHEMA_MESSAGES_ALREADY_SAID.has(issue.message)) return;
    others.push({ message: issue.message, target, key: `${issue.path.join(".")}:${i}`, path: issue.path });
  });

  return { refusedUnsub, others };
}

/* ------------------------------------------------------------------ *
 * Ingestion des avertissements du compilateur
 * ------------------------------------------------------------------ */

/**
 * Les seuls avertissements que la PUBLICATION refuse réellement, côté serveur
 * (`EmailDocPublishable`) ou côté envoi (pas de footer légal → envoi mis en veto).
 * Tout le reste du compilateur est consultatif : un brouillon imparfait reste publiable.
 *
 * ⚠️ Le dépassement du seuil Gmail n'est PAS dans cette liste parce qu'il est traité plus bas, sur
 * les octets réels plutôt que sur le texte de l'avertissement — mais il bloque aussi (barrière 3
 * de `POST …/publish`).
 */
/**
 * L'avertissement par lequel le compilateur dit l'ABSENCE de footer légal.
 *
 * ⚠️ Nommé, parce qu'il sert DEUX fois : ici pour donner son niveau, et plus bas pour savoir si le
 * pré-vol doit dire la même chose lui-même (`footermissing`). Deux copies de cette expression
 * auraient dérivé — et la dérive se serait vue comme un DOUBLON à l'écran, ou comme un trou.
 */
const COMPILER_MISSING_FOOTER = /^No legal footer block/;

const BLOCKING_WARNINGS: RegExp[] = [
  /^Subject line is empty/,
  /required before publishing/, // alt manquant, image comme article
  /is still an AI placeholder/,
  /legal footer sits inside a conditional/,
  COMPILER_MISSING_FOOTER,
];

const WARNING_GROUPS: [RegExp, PreflightGroup][] = [
  [/^Email weighs/, "weight"],
  [/legal footer|Subject line|Preheader/, "structure"],
  [/alt text|placeholder|^Image "|^Article image/, "images"],
  [/link|href|http:\/\//i, "links"],
];

const groupOfWarning = (message: string): PreflightGroup => {
  for (const [re, group] of WARNING_GROUPS) if (re.test(message)) return group;
  return "content";
};

/**
 * Rattache un avertissement du compilateur à un bloc en cherchant, dans son texte, une chaîne
 * qui identifie ce bloc (son id, ou le libellé que le compilateur cite). HEURISTIQUE assumée :
 * quand rien ne matche, le constat reste listé, simplement non cliquable — jamais perdu.
 */
interface Needle {
  text: string;
  target: PreflightTarget;
}

function needlesOf(block: Block, target: PreflightTarget): Needle[] {
  const out: Needle[] = [{ text: block.id, target }];
  const add = (value: string | undefined) => {
    if (value !== undefined && value.trim().length >= 4) out.push({ text: value, target });
  };
  switch (block.type) {
    case "image":
      add(block.src);
      add(block.alt);
      break;
    case "button":
      add(block.label);
      break;
    case "pick":
      add(block.matchLabel);
      break;
    case "article":
      add(block.title);
      add(block.imageSrc);
      break;
    case "promo":
      add(block.headline);
      break;
    case "section_title":
      add(block.label);
      break;
    case "callout":
      add(block.title);
      add(block.kicker);
      break;
    case "scoreboard":
      add(block.kicker);
      // Le libellé du pied nomme le bloc dans les avertissements du compilateur (« Insecure http://
      // link on scoreboard footer "…" ») : sans lui, l'avis flottait sans bloc et la réparation
      // https posée pour `footerHref` n'était jamais proposée. Un libellé de pied est unique dans
      // son bloc — contrairement à une catégorie d'article, partagée par plusieurs cartes, qui
      // rattacherait l'avis à la mauvaise.
      add(block.footerLabel);
      for (const row of block.rows) add(row.label);
      break;
    case "menu":
      for (const item of block.items) add(item.label);
      break;
    case "social":
      for (const item of block.items) add(item.platform);
      break;
    default:
      break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Articles d'APERÇU — ce qui ressemble à un article et n'en est pas un
 *
 * ⛔ POURQUOI CES CONSTATS-LÀ NE PEUVENT PAS BLOQUER. `compileDoc()` déplie chaque bloc flux AVANT
 * de rendre (`expandFeedBlocks`, packages/render/src/feed.ts) : faute de résolution, il déplie
 * l'APERÇU du bloc. Les articles qu'il juge n'existent donc dans AUCUN document — ils sont
 * fabriqués à la compilation, et les vrais sont résolus au gel, 90 min avant chaque envoi. Un
 * défaut sur l'un d'eux ne décrit pas l'email qu'on publie : il décrit l'échantillon WordPress du
 * jour où l'auteur a réglé le bloc. Le garder BLOQUANT était un cul-de-sac mesurable — le serveur
 * accepte de publier ce document, le bouton restait grisé, et aucun champ de l'éditeur n'adressait
 * la cause. Un blocage sans issue est pire qu'un faux positif.
 *
 * ⚠️ CE QU'ON NE FAIT PAS : les faire disparaître. Ils disent quelque chose de VRAI — les images de
 * cette source arrivent sans alt — et ce que dit l'échantillon, les vrais articles le diront aussi
 * le soir de l'envoi. On les rétrograde donc en consultatif, avec la phrase qui manquait : d'où ils
 * viennent et pourquoi rien ici ne les répare. Éteindre le constat aurait effacé l'information ;
 * le rétrograder la laisse lisible sans mentir sur le verrou.
 *
 * COMMENT ON LES RECONNAÎT, SÛREMENT. `toArticle()` (feed.ts) fabrique l'id de chaque carte à
 * partir de celui du flux — `<idFlux>-1`, `<idFlux>-2`… tronqué à 64 —, et lui donne le titre de
 * l'item d'aperçu. Or le compilateur CITE toujours l'élément fautif entre guillemets, sous l'un de
 * ces deux noms (`Article block "<id>"`, `Article image on "<titre ou id>"`). On rejoue donc la
 * dérivation à l'identique et on compare les chaînes citées. ⛔ Toute étiquette qu'un VRAI bloc du
 * document porte aussi est retirée de l'ensemble avant usage : à ambiguïté, on garde le blocage.
 * ------------------------------------------------------------------ */

/**
 * Étiquettes sous lesquelles le compilateur désignera les articles d'aperçu de ce bloc flux.
 * ⚠️ La dérivation d'id RECOPIE `toArticle()` : si elle change là-bas, elle doit changer ici, sinon
 * les défauts d'aperçu redeviennent bloquants en silence.
 */
function previewArticleCitations(block: Block): string[] {
  if (block.type !== "article-feed") return [];
  const out: string[] = [];
  block.previewItems.forEach((item, i) => {
    const id = `${block.id}-${i + 1}`.slice(0, 64);
    out.push(id);
    const titled = item.title.trim();
    if (titled !== "") out.push(titled);
  });
  return out;
}

/**
 * Les chaînes CITÉES entre guillemets par un avertissement.
 *
 * ⚠️ On compare des citations entières, jamais des sous-chaînes : un titre d'aperçu peut être
 * contenu dans le titre d'un vrai article (« Preview » dans « Preview of the week ») et un test
 * `includes` aurait désarmé le blocage du second.
 */
function quotedIn(message: string): string[] {
  const re = /"([^"]*)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) out.push(m[1] as string);
  return out;
}

/** Ce que le constat rétrogradé doit dire, et que le texte du compilateur ne dit pas. */
const PREVIEW_ARTICLE_DETAIL =
  "This article is not in your document: the feed block was expanded from its preview sample to render this check. Those items never ship — the real ones are resolved 90 minutes before each send. The defect describes the WordPress source, not this template, and no field here repairs it, so it cannot hold the publication back. Fix the alt text at the source if you want the sent articles to carry it.";

/* ------------------------------------------------------------------ *
 * Rapport
 * ------------------------------------------------------------------ */

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

export function runPreflight(
  doc: EmailDoc,
  compiled?: CompiledFacts | null,
  /**
   * ⛔ UN TABLEAU, PAS UN KIND. `POST …/publish` boucle sur TOUS les kinds servis par le template
   * (la clé est (asset_id, kind), rien n'interdit d'en servir deux). N'en juger qu'un ici ferait
   * diverger le bouton et le refus dans le sens le plus traître : vert à l'écran, 422 au clic.
   */
  lifecycleKinds?: LifecycleKind[] | null,
): PreflightReport {
  const findings: PreflightFinding[] = [];
  const push = (f: Omit<PreflightFinding, "id"> & { id?: string }, key: string) => {
    findings.push({ ...f, id: f.id ?? `${f.group}:${key}` });
  };

  const theme = doc.theme;
  // La langue du document commande le libellé de CTA que la compilation posera sur les articles qui
  // n'en portent pas : sans elle, le pré-vol jugerait « Read more » sur une carte brésilienne.
  const locale = doc.meta.locale;
  const needles: Needle[] = [];

  // Ce que le SERVEUR refusera, demandé au schéma qu'il interroge — pas recalculé ici.
  // ⛔ Le second argument N'EST PAS décoratif : il dit au verdict si le compilateur parlera à côté.
  // À `false` (panneau monté avant la première compilation), les refus que le compilateur dirait
  // mieux sont affichés quand même — sinon le verrou s'ouvre sur un document que la publication
  // refuse. Voir `SCHEMA_MESSAGES_ALREADY_SAID`.
  const verdict = schemaVerdict(doc, Boolean(compiled));
  const dark = hasDarkOverrides(theme);

  /**
   * Correctifs mécaniques disponibles, par bloc puis par nature. Les constats du compilateur
   * arrivent en TEXTE : on ne peut pas en déduire un patch. On dérive donc les correctifs de la
   * STRUCTURE du document pendant le parcours, et on les rattache ensuite au constat qui parle du
   * même bloc — la réparation vient du document, jamais d'une phrase analysée.
   */
  type FixKind = "https" | "placeholder" | "shorten" | "minCount";
  const fixes = new Map<string, Partial<Record<FixKind, PreflightFix>>>();
  const remember = (blockId: string, kind: FixKind, fix: PreflightFix | null) => {
    if (fix === null) return;
    const entry = fixes.get(blockId) ?? {};
    entry[kind] = fix;
    fixes.set(blockId, entry);
  };
  const fixFor = (blockId: string | undefined, kind: FixKind): PreflightFix | undefined =>
    blockId === undefined ? undefined : fixes.get(blockId)?.[kind];

  /* -------------------------------------------------- Parcours du document */

  let footerCount = 0;
  let buttonCount = 0;
  let lastBlockIsFooter = false;
  let seenBlocks = 0;

  /**
   * Étiquette d'article d'aperçu → le bloc FLUX qui la produira à la compilation. C'est la seule
   * cible honnête pour ces constats : l'article, lui, n'existe pas dans le document.
   */
  const previewCitations = new Map<string, PreflightTarget>();

  doc.rows.forEach((row, ri) => {
    row.columns.forEach((column, ci) => {
      column.blocks.forEach((block, bi) => {
        const target: PreflightTarget = {
          rowId: row.id,
          colId: column.id,
          blockId: block.id,
          blockType: block.type,
        };
        const where = `${ri}.${ci}.${bi}`;
        needles.push(...needlesOf(block, target));
        for (const citation of previewArticleCitations(block)) previewCitations.set(citation, target);
        remember(block.id, "https", httpsFix(block));
        remember(block.id, "placeholder", dropPlaceholderImageFix(block));
        remember(block.id, "minCount", clampMinCountFix(block));
        seenBlocks++;
        lastBlockIsFooter = block.type === "footer_legal";
        if (block.type === "footer_legal") footerCount++;
        if (block.type === "button") buttonCount++;

        const r = resolveBlock(theme, row, column, block);
        const samples = samplesOf(block, theme, r, locale);

        /* ---------------------------------------------------- Contraste, en clair */
        const worst = worstFailure(samples.map((sample) => ({ ...sample, background: sample.background ?? r.background })));
        if (worst) {
          push(
            {
              level: "advisory",
              group: "contrast",
              source: "preflight",
              message: `${worst.sample.what} is ${formatRatio(worst.ratio)} against its background — below the ${worst.minimum}:1 WCAG AA minimum.`,
              detail: `${worst.sample.color} on ${worst.sample.background} at ${worst.sample.size}px${worst.sample.bold ? " bold" : ""}. Readers on a phone in daylight lose this text first.`,
              target,
            },
            `contrast:${where}`,
          );
        }

        /* ---------------------------------------------------- Contraste, en sombre */
        // C'est LE rendu que personne ne relit : l'éditeur travaille en clair, la media query ne
        // s'arme que chez le destinataire. Un thème dont seul le fond bascule laisse du texte de
        // marque clair sur un fond devenu noir, et rien à l'écran ne le montre.
        if (dark) {
          const worstDark = worstFailure(samples.map((sample) => darkSample(sample, r, theme)));
          if (worstDark && !(worst && worstDark.sample.what === worst.sample.what && worstDark.ratio >= worst.ratio)) {
            push(
              {
                level: "advisory",
                group: "contrast",
                source: "preflight",
                message: `In dark mode, ${worstDark.sample.what} falls to ${formatRatio(worstDark.ratio)} — below the ${worstDark.minimum}:1 WCAG AA minimum.`,
                detail: `${worstDark.sample.color} on ${worstDark.sample.background} once the prefers-color-scheme rules apply. ${
                  worstDark.sample.onInline
                    ? "The dark override repaints <div>/<td> text only — this label sits on an <a> or a <span> and keeps its light colour on the new background."
                    : "Set darkTextColor and darkContentBackground together: overriding one without the other is what breaks the pair."
                }`,
                target,
              },
              `contrastdark:${where}`,
            );
          }
        }

        /* ---------------------------------------------------- Liens */
        for (const [li, link] of linksOf(block, locale).entries()) {
          // `#`, vide et `http://` appartiennent au compilateur : on ne les redit pas.
          for (const token of tokensIn(link.href)) {
            if (!isKnownVar(token)) {
              push(
                {
                  level: "advisory",
                  group: "links",
                  source: "preflight",
                  message: `Unknown merge tag {{${token}}} in the URL of ${link.what}.`,
                  detail:
                    "hydrate() strips tags outside the registry, so every recipient gets a truncated URL. Pick one from the merge-tag menu.",
                  target,
                },
                `token:${where}:${li}:${token}`,
              );
            } else if (MERGE_VARS[token].kind !== "url" && MERGE_VARS[token].kind !== "text") {
              push(
                {
                  level: "advisory",
                  group: "links",
                  source: "preflight",
                  message: `Merge tag {{${token}}} is not a URL but is used in the link of ${link.what}.`,
                  detail: `It is declared as "${MERGE_VARS[token].kind}" in the registry — it will not resolve to an address.`,
                  target,
                },
                `tokenkind:${where}:${li}:${token}`,
              );
            }
          }

          /* ------------------------------------------------ Conformité */
          // Le REFUS du schéma se lit AVANT le vocabulaire local, et c'est tout l'enjeu : les deux
          // listes de mots ne sont pas les mêmes (le schéma reconnaît `unsub`, `abmeld`, `desuscri`
          // que `UNSUB_WORDS` ignore). Filtrer d'abord sur `looksUnsub` faisait disparaître du
          // panneau des liens que `POST …/publish` refuse — le pré-vol annonçait « publiable » et
          // la publication répondait 422 sur un constat jamais affiché.
          if (verdict.refusedUnsub.get(block.id)?.has(link.href)) {
            push(
              {
                level: "blocking",
                group: "compliance",
                source: "schema",
                message: `Hand-written unsubscribe link on ${link.what}.`,
                detail:
                  "The platform injects the unsubscribe link itself, signed and per recipient. A link written here is unsigned: it either fails to identify the subscriber or leaks a URL that never expires. Remove it — the legal footer covers this. Publishing is refused server-side on exactly this link.",
                target,
              },
              `unsub:${where}:${li}`,
            );
            continue;
          }
          const looksUnsub = mentionsUnsub(link.label) || mentionsUnsub(link.href);
          if (!looksUnsub) continue;
          if (isPlatformUnsubToken(link.href)) {
            push(
              {
                level: "advisory",
                group: "compliance",
                source: "preflight",
                message: `${link.what} duplicates the unsubscribe link that the legal footer already injects.`,
                detail: "Harmless, but two unsubscribe links in one email confuse readers and inflate opt-out reports.",
                target,
              },
              `unsubdup:${where}:${li}`,
            );
            continue;
          }
          // Le vocabulaire est là, mais le schéma de publication l'accepte — un chemin relatif, un
          // `mailto:`, une page de préférences. On le DIT sans l'interdire : bloquer ici afficherait
          // un verrou que le serveur n'applique pas, et l'utilisateur n'aurait aucun moyen de passer.
          push(
            {
              level: "advisory",
              group: "compliance",
              source: "preflight",
              message: `${link.what} reads like an unsubscribe link.`,
              detail:
                "Publishing accepts it (it is not an absolute hand-written unsubscribe URL), but the only opt-out that the platform can attribute is the one the legal footer injects. If this is a preferences page, keep it; if it is meant to unsubscribe, remove it.",
              target,
            },
            `unsubsoft:${where}:${li}`,
          );
        }

        /* ---------------------------------------------------- Libellé qui déborde */
        const ctaLabel =
          block.type === "button"
            ? block.label
            : block.type === "promo" || block.type === "callout"
              ? block.ctaLabel
              : block.type === "pick"
                ? block.ctaLabel
                : block.type === "article"
                  ? effectiveArticleCta(block, locale)
                  : undefined;
        // ⛔ DEUX FORMES DEPUIS LE 22/09/2026, ET ELLES N'OCCUPENT PAS LA MÊME PLACE. `ctaStyle`
        // absent ou `button` sort en bouton plein (`ctaTable`) : 22px de padding de chaque côté et
        // une taille `fontSize - 2`, exactement comme les cartes promo/pick. Seul `ctaStyle:"link"`
        // reste un `<a>` souligné et gras À LA TAILLE DU BLOC, dans un `<div>` qui ne pose qu'un
        // padding VERTICAL. Mesurer tous les articles au gabarit du lien sous-estimait la largeur
        // des boutons de 44px — un libellé qui déborde vraiment ne faisait plus rougir personne.
        // ⚠️ Ce qui ne change pas : en `layout: "side"`, le CTA vit dans la cellule de TEXTE et non
        // dans la colonne — la vignette prend 38 % (plancher 80px) plus 14px de gouttière. Mesurer
        // sur la colonne entière raterait le seul cas où un libellé déborde vraiment.
        const article = block.type === "article" ? block : undefined;
        const articleLink = article !== undefined && article.ctaStyle === "link";
        // Le libellé jugé vient-il du défaut de langue plutôt que du bloc ? Le constat doit le dire :
        // sinon il cite un texte que l'auteur ne trouve nulle part dans l'inspecteur, où le champ
        // est vide, et il n'a plus aucun chemin à suivre.
        const defaultedCta = article !== undefined && !filled(article.ctaLabel);
        if (ctaLabel !== undefined && ctaLabel.trim() !== "") {
          const columnWidth = innerWidth(theme, row, ci, column, block);
          const available =
            article !== undefined && article.layout === "side" && article.imageSrc !== undefined
              ? columnWidth - Math.max(80, Math.round(columnWidth * 0.38)) - 14
              : columnWidth;
          // Largeur d'un caractère ≈ 0,58 em en gras dans une pile Arial/Helvetica ; le padding
          // interne du bouton est de 26px (mj-button) ou 22px (CTA des cartes) de chaque côté.
          const size =
            block.type === "button" ? Math.max(14, r.fontSize - 1) : articleLink ? r.fontSize : Math.max(13, r.fontSize - 2);
          const padding = block.type === "button" ? 52 : articleLink ? 0 : 44;
          const estimated = Math.round(ctaLabel.length * size * 0.58) + padding;
          // Nombre de caractères qui tiennent VRAIMENT : l'inverse exact de l'estimation ci-dessus,
          // pour que le correctif proposé fasse disparaître le constat qui l'a déclenché.
          const fits = Math.floor((available - padding) / (size * 0.58));
          // ⛔ `shortenLabelFix` lit le libellé BRUT, exprès : rogner un défaut de langue écrirait
          // « Ler a » dans le document — un libellé qui n'existe dans aucune langue — et figérait
          // dans le bloc ce que la table de `@nf/render/cta` doit continuer à fournir. Un défaut
          // qui déborde se répare en élargissant la colonne, pas en mutilant la traduction.
          remember(block.id, "shorten", shortenLabelFix(block, fits));
          if (estimated > available) {
            push(
              {
                level: "advisory",
                group: "structure",
                source: "preflight",
                message:
                  article === undefined
                    ? `Button label "${ctaLabel}" needs about ${estimated}px in a ${available}px column — it wraps onto a second line.`
                    : `Article link "${ctaLabel}" needs about ${estimated}px in the ${available}px it is given — it wraps onto a second line.`,
                detail:
                  article === undefined
                    ? "Outlook wraps inside the button and the padding no longer centres, which reads as a broken button. Shorten the label or widen the column."
                    : defaultedCta
                      ? `Nothing is typed on this block: "${ctaLabel}" is the default link label for ${locale}, added to every article when the email is built, so it ships even though the field looks empty. ${articleLink ? "It is an underlined link, not a button — wrapped, it reads as two links stacked." : "It ships as a filled button — wrapped, Outlook stops centring the padding and it reads as broken."} Widen the column, or type a shorter label on the article.`
                      : articleLink
                        ? "The article call to action is an underlined link, not a button: wrapped, it reads as two links stacked. Shorten the label, or widen the column — in the side layout the thumbnail already eats 38% of it."
                        : "The article call to action is a filled button: wrapped, Outlook stops centring the padding and it reads as broken. Shorten the label, or widen the column — in the side layout the thumbnail already eats 38% of it.",
                target,
                ...(fixFor(block.id, "shorten") ? { fix: fixFor(block.id, "shorten") } : {}),
              },
              `btnwidth:${where}`,
            );
          }
        }
      });
    });
  });

  /* -------------------------------------------------- Structure globale */

  // ⛔ À AMBIGUÏTÉ, ON GARDE LE BLOCAGE. Une étiquette qu'un vrai bloc du document porte aussi
  // (même id, même titre) ne peut plus désigner un aperçu à coup sûr : on la retire de l'ensemble,
  // et le constat qui la cite reste bloquant. Rétrograder au doute aurait éteint la règle sur un
  // vrai article, exactement ce que ce lot interdit.
  for (const needle of needles) {
    if (needle.target.blockType === "article-feed") continue;
    previewCitations.delete(needle.text);
  }

  /**
   * ZÉRO FOOTER LÉGAL — le constat que SEUL le compilateur savait produire.
   *
   * ⛔ CE QU'IL RÉPARE. `EmailDocPublishable` ne dit RIEN de l'absence de footer (il ne juge que
   * le footer conditionnel) : le SCHÉMA laisse passer. C'est `POST …/publish` qui refuse, sur le
   * token `{{legal_footer_html}}` absent du shell compilé (sa barrière 3, en 422) — et, s'il ne le
   * faisait pas, l'ENVOI serait mis en veto plus tard (`render.ts` sort `footerMissing`,
   * `process.ts` saute la ligne). Le pré-vol pur, lui, ne comptait que les footers EN TROP et le footer MAL PLACÉ —
   * zéro footer ne produisait aucun constat. Résultat : au montage du panneau et pendant toute la
   * fenêtre de recompilation (dont le timer repart à chaque frappe), l'écran affichait 0 bloquant
   * sur un document dont aucun email ne partirait jamais. Un écran vert sur un envoi mort.
   *
   * ⛔ POURQUOI PAS `SCHEMA_MESSAGES_ALREADY_SAID`. Cet ensemble-là filtre des issues ZOD dans
   * `schemaVerdict()` ; l'absence de footer n'en produit aucune, rien n'y matcherait jamais. On en
   * reprend donc le PRINCIPE — ne pas dire ce qu'un autre dit déjà — mais appliqué au bon endroit :
   * la liste réelle des avertissements reçus. ⚠️ Et pas `Boolean(compiled)` : des faits PÉRIMÉS
   * (footer supprimé il y a une seconde, recompilation en vol) sont présents sans porter encore la
   * phrase. Se taire sur leur seule existence aurait rouvert la fenêtre qu'on vient de fermer.
   */
  const compilerSaidMissingFooter = compiled?.warnings.some((w) => COMPILER_MISSING_FOOTER.test(w)) === true;
  if (footerCount === 0 && !compilerSaidMissingFooter) {
    /**
     * ⚠️ LA CHAÎNE DU CORRECTIF TIENT DE BOUT EN BOUT — vérifiée sur disque, pas supposée :
     * `shell.tsx` passe `onApplyFixes` au panneau, qui dispatche un `batch` d'actions produites par
     * `actionsForFix()` ; celle-ci traduit le verbe `insertRow` en action `insertRow` ; et le cas
     * correspondant du réducteur AUTORISE explicitement l'insertion d'un `footer_legal` tant que le
     * document n'en porte aucun (`rowHasLockedBlock(action.row) && doc.rows.some(rowHasLockedBlock)`).
     * Ce n'est donc pas un bouton qui ne fait rien : c'est le seul geste qui fasse disparaître ce
     * blocage sans quitter le panneau.
     *
     * ⛔ ET POURQUOI PAS AUSSI SUR LE CONSTAT JUMEAU DU COMPILATEUR (plus bas, `source: "compiler"`).
     * `collectFixes()` ne reprend le correctif porté par un constat QUE si sa source est
     * `preflight` — un constat serveur peut être en retard sur le document, son correctif est
     * re-dérivé depuis les blocs. Or ce correctif-ci est de niveau DOCUMENT : rien ne le re-dérive.
     * Attaché là-bas, le bouton s'afficherait et n'écrirait rien. Le blocage, lui, reste dit une
     * seule fois et au même niveau des deux côtés : c'est le compte qui doit coïncider, pas le bouton.
     */
    const appendFooter = appendLegalFooterFix(doc);
    push(
      {
        // Même niveau que le compilateur (`BLOCKING_WARNINGS`) et même phrase, au mot près : le
        // constat ne doit pas changer de sens quand la compilation arrive et prend le relais.
        level: "blocking",
        group: "structure",
        source: "preflight",
        message:
          "No legal footer block — the compliance footer (unsubscribe, sender identity) will not be injected and the send will be vetoed.",
        detail:
          "The publish endpoint refuses the document (422), and any send would be skipped as footer_incomplete: the rendered shell has no place to inject the unsubscribe link. Add the legal footer block as the last block of the email.",
        // ⚠️ Le libellé de la fabrique dit le RÉSULTAT exact (« at the end ») : c'est bien la
        // dernière row du document qui est écrite, `index: doc.rows.length`.
        ...(appendFooter ? { fix: appendFooter } : {}),
      },
      "footermissing",
    );
  }

  /* ------------------------------------------- Jetons du cycle de vie (5A) */
  /**
   * ⛔ MIROIR EXACT DE LA 5e BARRIÈRE DE `POST …/publish`. La règle est la MÊME fonction
   * (`@nf/render/lifecycle-checks`), appelée ici et là-bas : dupliquer la règle ferait diverger le
   * bouton « Publish » et le refus 422, et l'auteur prendrait une erreur surprise sur un écran qui
   * vient de lui dire que tout va bien. C'est la panne que ce module existe pour empêcher.
   *
   * ⛔ ET SEULEMENT SI LE TEMPLATE EST RATTACHÉ. Sans ce filtre, tous les templates ordinaires
   * deviendraient rouges faute d'un `{{confirm_url}}` qu'ils n'ont aucune raison de porter.
   *
   * ⚠️ On se tait tant que la compilation n'est pas arrivée : juger le document mentirait dans les
   * deux sens. Le pré-vol préfère ne rien dire à dire faux — la publication, elle, jugera.
   */
  if (compiled?.html) {
    // ⚠️ Un constat PAR kind, avec sa propre clé : deux e-mails servis par le même template
    // n'exigent pas les mêmes jetons, et les fondre en un seul constat ferait disparaître celui qui
    // bloquera vraiment la publication.
    for (const lifecycleKind of lifecycleKinds ?? []) {
      const rapport = checkLifecycleShell({
        kind: lifecycleKind,
        html: compiled.html,
        text: compiled.text ?? null,
        subject: doc.meta.subject,
      });
      if (!rapport.ok) {
        push(
          {
            level: "blocking",
            group: "compliance",
            source: "preflight",
            message: `Missing ${rapport.missing.map((m) => `{{${m.token}}}`).join(", ")} — this template is used for the "${lifecycleKind}" lifecycle email.`,
            detail: lifecycleShellMessage(rapport) ?? "",
          },
          `lifecycle:${lifecycleKind}`,
        );
      }
    }
  }

  if (footerCount > 1) {
    push(
      {
        level: "advisory",
        group: "structure",
        source: "preflight",
        message: `${footerCount} legal footer blocks — the compliance footer will be injected ${footerCount} times.`,
        detail: "Keep exactly one, as the last block of the email.",
      },
      "footerdup",
    );
  }

  if (footerCount > 0 && !lastBlockIsFooter && seenBlocks > 0) {
    const lastRow = doc.rows[doc.rows.length - 1];
    push(
      {
        level: "advisory",
        group: "structure",
        source: "preflight",
        message: "The legal footer is not the last block of the email.",
        detail:
          "Content sitting below the unsubscribe footer reads as a mistake, and it pushes the footer further from the end — the first thing a clipped message loses.",
        ...(lastRow ? { target: { rowId: lastRow.id } } : {}),
      },
      "footerpos",
    );
  }

  if (buttonCount > 1) {
    push(
      {
        level: "advisory",
        group: "structure",
        source: "preflight",
        message: `${buttonCount} buttons compete for the click.`,
        detail:
          "Click is the primary metric here. One primary action per email measurably outperforms several — demote the others to inline links.",
      },
      "buttons",
    );
  }

  /* -------------------------------------------------- Mode sombre : overrides dépareillés */

  // Le seul défaut de mode sombre qu'aucun bloc ne peut révéler : le fond de PAGE bascule sans le
  // fond de CONTENU, ou l'inverse. Aucun texte ne repose sur le fond de page, donc pas de ratio à
  // calculer — mais l'email arrive en deux moitiés qui ne se ressemblent pas.
  if (dark && (theme.darkBodyBackground === undefined) !== (theme.darkContentBackground === undefined)) {
    const missing = theme.darkBodyBackground === undefined ? "darkBodyBackground" : "darkContentBackground";
    push(
      {
        level: "advisory",
        group: "contrast",
        source: "preflight",
        message: `Dark-mode overrides are half set — ${missing} is missing.`,
        detail:
          "In dark mode one of the two surfaces flips and the other does not: a light card floating on a black page, or the reverse. Set both, or neither.",
      },
      "darkpair",
    );
  }

  /* -------------------------------------------------- Poids + compilateur */

  let size: SizeFacts | null = null;

  if (compiled) {
    // ⚠️ Le poids HYDRATÉ fait foi dès qu'on l'a : c'est celui que juge `POST …/publish`. Sans lui
    // (appelant sans contexte de marque), on retombe sur le shell en sous-estimant — jamais en
    // surestimant, donc le pré-vol reste plus permissif que le serveur, jamais l'inverse.
    const bytes = compiled.hydratedBytes ?? compiled.sizeBytes;
    size = {
      bytes,
      limit: GMAIL_CLIP_BYTES,
      remaining: GMAIL_CLIP_BYTES - bytes,
      ratio: bytes / GMAIL_CLIP_BYTES,
      over: bytes > GMAIL_CLIP_BYTES,
    };

    if (size.over) {
      push(
        {
          // BLOQUANT, et pas consultatif : `POST …/publish` REFUSE en 422 au-delà du seuil
          // (troisième barrière de la route). Le laisser consultatif armait le bouton « Publish »
          // pour un appel que le serveur rejette.
          //
          // ⚠️ La comparaison n'est identique à celle de la route que si `hydratedBytes` est là —
          // voir le POURQUOI sur `CompiledFacts`. Sans lui, on juge le shell et on laisse passer
          // les documents de la bande [shell ≤ seuil < hydraté].
          level: "blocking",
          group: "weight",
          source: "preflight",
          message: `Compiled HTML weighs ${kb(bytes)} — ${kb(bytes - GMAIL_CLIP_BYTES)} over the ${kb(GMAIL_CLIP_BYTES)} Gmail clipping threshold.`,
          detail:
            'Gmail cuts the message at the threshold and hides the rest behind "View entire message". Everything past the cut — including the unsubscribe footer — stops being visible, so this is a compliance risk, not a cosmetic one. Trim raw HTML blocks, shorten copy, or split the edition.',
        },
        "weightover",
      );
    } else if (size.ratio >= APPROACHING_RATIO) {
      push(
        {
          level: "advisory",
          group: "weight",
          source: "preflight",
          message: `Compiled HTML weighs ${kb(bytes)} — only ${kb(size.remaining)} left before Gmail clips the message.`,
          detail:
            "Past the threshold the unsubscribe footer disappears behind \"View entire message\". A couple of extra paragraphs are enough to cross it.",
        },
        "weightnear",
      );
    }

    // Avertissements du compilateur : niveau + cible, sans réécrire une seule de ses règles.
    compiled.warnings.forEach((message, i) => {
      // Le poids est déjà dit ci-dessus, avec les octets exacts et la distance au seuil.
      if (/^Email weighs/.test(message)) return;

      // L'avertissement cite-t-il un article d'APERÇU ? Cette question passe AVANT le rattachement
      // heuristique : l'aperçu se reconnaît à une citation exacte, le rattachement se contente
      // d'une sous-chaîne — et l'id du flux étant un préfixe de celui de ses cartes, il matchait
      // déjà, envoyant l'auteur cliquer sur un bloc dont aucun champ n'adressait la cause.
      let preview: PreflightTarget | undefined;
      for (const quoted of quotedIn(message)) {
        const found = previewCitations.get(quoted);
        if (found !== undefined) {
          preview = found;
          break;
        }
      }

      let match: Needle | null = null;
      for (const needle of needles) {
        if (!message.includes(needle.text)) continue;
        if (match === null || needle.text.length > match.text.length) match = needle;
      }

      // Nature du correctif déduite du CONSTAT, patch déduit du DOCUMENT : le texte de
      // l'avertissement ne sert qu'à choisir laquelle des réparations déjà calculées s'applique.
      const kind = /http:\/\//.test(message)
        ? ("https" as const)
        : /is still an AI placeholder/.test(message)
          ? ("placeholder" as const)
          : /^Button label /.test(message)
            ? ("shorten" as const)
            : null;
      // ⚠️ Aucun correctif sur un article d'aperçu : les fabriques partent d'un bloc du document,
      // et le seul bloc qu'on ait sous la main est le FLUX. Patcher le flux au nom d'un défaut de
      // sa carte d'aperçu réparerait autre chose que ce que le bouton annonce.
      const fix = kind === null || preview !== undefined ? undefined : fixFor(match?.target.blockId, kind);

      push(
        {
          // La rétrogradation ne va QUE dans un sens : un constat consultatif ne devient jamais
          // bloquant parce qu'il vient d'un aperçu.
          level: preview === undefined && BLOCKING_WARNINGS.some((re) => re.test(message)) ? "blocking" : "advisory",
          group: groupOfWarning(message),
          source: "compiler",
          message: preview === undefined ? message : `In the feed preview: ${message}`,
          ...(preview === undefined ? {} : { detail: PREVIEW_ARTICLE_DETAIL }),
          ...(preview !== undefined ? { target: preview } : match ? { target: match.target } : {}),
          ...(fix ? { fix } : {}),
        },
        `compiler:${i}`,
      );
    });
  }

  /* -------------------------------------------------- Filet : refus du schéma de publication */

  // Tout ce que `EmailDocPublishable` refuse et que personne d'autre n'a dit. Sans ce filet, le
  // panneau pourrait annoncer « publiable » sur un document que `POST …/publish` rejette en 422 —
  // le refus surprise que ce lot est censé supprimer.
  for (const issue of verdict.others) {
    // Correctif choisi sur le CHAMP visé, pas sur le bloc : un flux d'articles peut être refusé
    // pour son plancher ou pour son `href`, et « Set the minimum to 2 » sous le second serait un
    // bouton qui répare autre chose que ce qu'il annonce.
    const field = issue.path[issue.path.length - 1];
    const fix = field === "minCount" ? fixFor(issue.target?.blockId, "minCount") : undefined;
    push(
      {
        level: "blocking",
        group: groupOfWarning(issue.message),
        source: "schema",
        message: `Publishing is refused: ${issue.message}`,
        detail: "The publication schema rejects this document as it stands — the server returns the same refusal.",
        ...(issue.target ? { target: issue.target } : {}),
        ...(fix ? { fix } : {}),
      },
      `schema:${issue.key}`,
    );
  }

  /* -------------------------------------------------- Tri + comptes */

  const rank = (f: PreflightFinding): number =>
    (f.level === "blocking" ? 0 : 1000) + GROUP_ORDER.indexOf(f.group);
  findings.sort((a, b) => rank(a) - rank(b));

  const blocking = findings.filter((f) => f.level === "blocking").length;

  /**
   * ⛔ « RIEN À SIGNALER » N'EST PAS « PUBLIABLE ». C'est la règle générale, et elle ferme d'un coup
   * TOUTE une classe de bugs qu'on a corrigés un par un jusqu'ici :
   *   1. le FOOTER LÉGAL absent — seul `compileDoc()` le disait, le pré-vol pur ne comptait que les
   *      footers en trop ; zéro footer sortait 0 bloquant sur un email qui ne partirait jamais ;
   *   2. le POIDS — même trou, exactement : un document compilé à 415 Ko affiche 0 bloquant tant
   *      que personne n'a compilé, parce que les octets n'existent QUE dans `CompiledFacts` ;
   *   3. et tout ce que SEUL le compilateur voit — `collectWarnings()` est son propriétaire, le
   *      pré-vol l'INGÈRE et ne sait pas le recalculer (MJML ne tourne pas dans le navigateur).
   * Les deux premiers ont été rattrapés au cas par cas ; le troisième est ouvert par construction,
   * et il le restera : la liste des règles du compilateur n'est pas fermée. Rejouer le rattrapage à
   * chaque nouvelle règle, c'est signer un quatrième trou. On coupe donc à la CONCLUSION.
   *
   * ⚠️ ET CE N'EST PAS UN CAS LIMITE : le panneau MONTE avec `compiled = null` et recompile en
   * debounce après CHAQUE frappe (des faits périmés sont refusés par `factsForVerdict()`, qui rend
   * `null`). Cette fenêtre est l'état NORMAL de l'éditeur, pas un accident de démarrage.
   *
   * Un poids INCONNU n'est pas un poids acceptable. Sans faits compilés le pré-vol garde le droit
   * de dire « rien à signaler pour l'instant » — c'est `counts.blocking === 0`, qui ne change pas —
   * mais il perd celui d'AFFIRMER que le document est publiable. La prudence porte sur le verdict,
   * pas sur les constats : on n'est pas devenu plus bavard, seulement moins affirmatif.
   *
   * ⚠️ La sonde est `size !== null` et non `Boolean(compiled)` : `size` n'est peuplé que dans la
   * branche `if (compiled)` ci-dessus, c'est donc la trace de faits RÉELLEMENT exploités, pas d'un
   * argument reçu. Les deux coïncident aujourd'hui ; lire la trace plutôt que l'argument survit au
   * jour où `compiled` porterait autre chose.
   */
  const compiledFactsPresent = size !== null;

  return {
    findings,
    counts: { blocking, advisory: findings.length - blocking },
    canPublish: blocking === 0 && compiledFactsPresent,
    size,
  };
}
