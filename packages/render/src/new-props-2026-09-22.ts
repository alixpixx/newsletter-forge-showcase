/**
 * MANIFESTE DES RÉGLAGES AJOUTÉS LE 22/09/2026 — lu par l'inspecteur du builder pour les câbler.
 *
 * Règle d'Alix : « je veux tout pouvoir modifier dans le builder ce que les users vont recevoir sans
 * exception !! ». Chaque entrée est une décision que le compilateur prenait SEUL et qui devient une
 * clé du schéma : optionnelle, bornée, et qui rend EXACTEMENT la valeur d'avant quand elle est absente
 * (banc `compile/golden.test.ts`). Les numéros `item` sont ceux de
 * `tasks/inventaire-builder-editable-2026-09-22.md`.
 *
 * ⛔ AUCUNE DÉPENDANCE : de la donnée pure, importable par un composant client sans tirer Zod.
 * ⛔ TENU À JOUR PAR DES BANCS : `reglages.test.ts` vérifie que chaque entrée existe dans le schéma
 * avec les mêmes bornes, et qu'un test de rendu la couvre. Une entrée ajoutée sans son effet rougit.
 *
 * Conventions pour l'inspecteur :
 *  - `target` : le type de bloc, `theme`, `meta`, ou `article-feed.card` / `article-feed.lead` (le
 *    look des brèves / de la une d'un flux — l'inspecteur les écrit par `updateBlockPart`, qui
 *    fusionne DANS l'objet `card`/`lead` ; un `updateBlock` ne fusionnerait qu'un niveau) ;
 *  - `path` : chemin pointé DANS la cible (`plainText.header`, `textPresets.h1.size`) ;
 *  - `default` : la valeur qui s'applique quand la clé est absente. `computed: true` = c'est une
 *    règle et non une valeur littérale (à afficher en indication, jamais à écrire dans le document) ;
 *  - `status` : `new` = clé nouvelle ; `extended` = clé existante dont le domaine ou l'effet s'élargit.
 */

/**
 * `images` (23/09/2026) : une liste de `{ src, alt }` — la grille de l'encart `gallery`. `min`/`max`
 * y comptent des CASES, pas des caractères.
 */
export type NewPropKind = "number" | "color" | "boolean" | "enum" | "string" | "spacing" | "font" | "images";

export interface NewPropSpec {
  target: string;
  path: string;
  kind: NewPropKind;
  min?: number;
  max?: number;
  /** Pas conseillé pour un champ numérique (les interlignes acceptent des décimales). */
  step?: number;
  options?: readonly string[];
  default: string | number | boolean;
  computed?: true;
  status: "new" | "extended";
  /** Numéro de l'inventaire du 22/09/2026. */
  item: number;
  hint: string;
}

const WEIGHTS = ["300", "400", "500", "600", "700", "800", "900"] as const;
const TRANSFORMS = ["none", "uppercase", "lowercase", "capitalize"] as const;
const LINE_STYLES = ["solid", "dashed", "dotted"] as const;
const PRESETS = ["h1", "h2", "h3", "body", "small"] as const;

/** Valeurs d'aujourd'hui des presets de texte (`PRESETS` de `compile/mjml.ts`). */
const PRESET_DEFAULTS: Record<(typeof PRESETS)[number], { size: number | string; weight: string; lineHeight: number }> = {
  h1: { size: 28, weight: "700", lineHeight: 1.25 },
  h2: { size: 22, weight: "700", lineHeight: 1.3 },
  h3: { size: 18, weight: "600", lineHeight: 1.35 },
  body: { size: "theme.fontSize", weight: "400", lineHeight: 1.55 },
  small: { size: 13, weight: "400", lineHeight: 1.5 },
};

/** Le jeu commun des boutons de carte (pick, promo, encart, article en forme `button`). */
const cardButton = (target: string, item: number, withSize: boolean): NewPropSpec[] => [
  { target, path: "ctaBackground", kind: "color", default: "theme.brandColor", computed: true, status: "new", item, hint: "Button background colour." },
  { target, path: "ctaTextColor", kind: "color", default: "theme.buttonTextColor", computed: true, status: "new", item, hint: "Button label colour." },
  ...(withSize
    ? [{ target, path: "ctaSize", kind: "number", min: 8, max: 40, default: "max(13, block font size − 2)", computed: true, status: "new", item, hint: "Button label size in px." } as NewPropSpec]
    : []),
  { target, path: "ctaWeight", kind: "enum", options: WEIGHTS, default: "700", status: "new", item, hint: "Button label weight." },
  { target, path: "ctaPadding", kind: "spacing", min: 0, max: 200, default: "12 / 22 / 12 / 22", computed: true, status: "new", item, hint: "Button inner padding, side by side (px)." },
  { target, path: "ctaRadius", kind: "number", min: 0, max: 48, default: "block radius, else theme.radius", computed: true, status: "new", item, hint: "Button corner radius in px." },
];

/** Réglages de carte d'article : bloc `article` ET looks `lead`/`card` d'un flux (mêmes noms). */
const articleCard = (target: string): NewPropSpec[] => [
  { target, path: "excerptLineHeight", kind: "number", min: 1, max: 3, step: 0.05, default: 1.55, status: "new", item: 80, hint: "Line height of the excerpt." },
  { target, path: "excerptWeight", kind: "enum", options: WEIGHTS, default: "400", status: "new", item: 80, hint: "Font weight of the excerpt." },
  { target, path: "kickerGap", kind: "number", min: 0, max: 48, default: 5, status: "new", item: 81, hint: "Space below the kicker, px." },
  { target, path: "imageGap", kind: "number", min: 0, max: 48, default: 12, status: "new", item: 81, hint: "Space below the image (full width, or stacked on mobile), px." },
  { target, path: "excerptGap", kind: "number", min: 0, max: 48, default: 6, status: "new", item: 81, hint: "Space above the excerpt, px." },
  { target, path: "metaGap", kind: "number", min: 0, max: 48, default: 8, status: "new", item: 81, hint: "Space above the meta line, px." },
  { target, path: "ctaGap", kind: "number", min: 0, max: 48, default: 10, status: "new", item: 81, hint: "Space above the read link, px." },
  { target, path: "sideGap", kind: "number", min: 0, max: 48, default: 14, status: "new", item: 81, hint: "Gap between thumbnail and text in the side layout, px." },
  { target, path: "imageLink", kind: "boolean", default: true, status: "new", item: 82, hint: "Off = the image is not clickable." },
  { target, path: "ctaWeight", kind: "enum", options: WEIGHTS, default: "700", status: "new", item: 83, hint: "Read-link weight (button and link forms)." },
  { target, path: "ctaBackground", kind: "color", default: "theme.brandColor", computed: true, status: "new", item: 74, hint: "Read-button background (button form)." },
  { target, path: "ctaTextColor", kind: "color", default: "theme.buttonTextColor", computed: true, status: "new", item: 74, hint: "Read-button label colour (button form)." },
  { target, path: "ctaPadding", kind: "spacing", min: 0, max: 200, default: "12 / 22 / 12 / 22", computed: true, status: "new", item: 74, hint: "Read-button inner padding (button form), px." },
  { target, path: "ctaRadius", kind: "number", min: 0, max: 48, default: "block radius, else theme.radius", computed: true, status: "new", item: 74, hint: "Read-button corner radius (button form), px." },
];

export const NEW_PROPS_2026_09_22: readonly NewPropSpec[] = [
  /* --- Thème ------------------------------------------------------------------------------ */
  ...PRESETS.flatMap((p): NewPropSpec[] => [
    { target: "theme", path: `textPresets.${p}.size`, kind: "number", min: 8, max: 72, default: PRESET_DEFAULTS[p].size, ...(typeof PRESET_DEFAULTS[p].size === "string" ? { computed: true as const } : {}), status: "new", item: 63, hint: `Font size of the ${p} text preset, px.` },
    { target: "theme", path: `textPresets.${p}.weight`, kind: "enum", options: WEIGHTS, default: PRESET_DEFAULTS[p].weight, status: "new", item: 63, hint: `Font weight of the ${p} text preset.` },
    { target: "theme", path: `textPresets.${p}.lineHeight`, kind: "number", min: 1, max: 3, step: 0.05, default: PRESET_DEFAULTS[p].lineHeight, status: "new", item: 63, hint: `Line height of the ${p} text preset.` },
  ]),
  // 23/09/2026 : défaut « light only » (avant « light dark ») — cf. `colorScheme` dans le schéma.
  { target: "theme", path: "colorScheme", kind: "enum", options: ["light only", "light dark", "light"], default: "light only", status: "new", item: 94, hint: "Colour schemes the email declares. 'light only' (default) asks Gmail apps, Apple Mail and Android not to recolour it; 'light dark' lets them darken it; 'light' (legacy) does not stop forced darkening." },
  { target: "theme", path: "resetLinkDecoration", kind: "boolean", default: true, status: "new", item: 94, hint: "Off = drop the head rule that removes link underlines." },
  { target: "theme", path: "mobileBreakpoint", kind: "number", min: 320, max: 800, default: 600, status: "new", item: 95, hint: "Screen width (px) below which mobile settings apply." },
  { target: "theme", path: "columnBreakpoint", kind: "number", min: 320, max: 800, default: 480, status: "new", item: 95, hint: "Screen width (px) from which columns and thumbnails sit side by side." },
  { target: "theme", path: "pinDarkRows", kind: "boolean", default: true, status: "new", item: 96, hint: "Off = text-free bands (logo rows, image blocks, coloured rules and spacers) may be recoloured by dark-mode clients." },
  { target: "theme", path: "neutralizePureColors", kind: "boolean", default: true, status: "new", item: 97, hint: "Off = keep pure #ffffff / #000000 as written (dark-mode inversion risk)." },
  // 24/09/2026 (styles globaux, feature 5) : hors inventaire du 22/09, numérotés à la suite.
  { target: "theme", path: "headingColor", kind: "color", default: "theme.textColor", computed: true, status: "new", item: 101, hint: "Colour of every title (H1–H3 text, section titles, article and callout titles). A colour set on a row, column or block still wins." },
  { target: "theme", path: "headingFont", kind: "font", default: "theme.fontFamily", computed: true, status: "new", item: 101, hint: "Font of every title. A font set on a row, column or block still wins." },

  /* --- Méta du document ---------------------------------------------------------------------- */
  { target: "meta", path: "htmlTitle", kind: "string", max: 200, default: "meta.subject", computed: true, status: "new", item: 94, hint: "HTML <title> (browser tab of webmail); empty = none." },
  { target: "meta", path: "dir", kind: "enum", options: ["auto", "ltr", "rtl"], default: "auto", status: "new", item: 94, hint: "Text direction declared on <html>." },
  { target: "meta", path: "defaultCtaLabel", kind: "string", max: 28, default: "language default (defaultArticleCta)", computed: true, status: "new", item: 84, hint: "Read-link label for every article without its own label." },
  { target: "meta", path: "firstNameFallback", kind: "string", min: 1, max: 40, default: "language default (defaultFirstName)", computed: true, status: "new", item: 99, hint: "What {{first_name}} shows when the subscriber has no first name." },
  { target: "meta", path: "plainText.header", kind: "string", max: 300, default: "", status: "new", item: 98, hint: "Line at the very top of the plain-text version." },
  { target: "meta", path: "plainText.includePreheader", kind: "boolean", default: true, status: "new", item: 98, hint: "Off = the plain-text version does not repeat the preheader." },
  { target: "meta", path: "plainText.rule", kind: "string", min: 1, max: 80, default: "----------------------------------------", status: "new", item: 98, hint: "Separator line used in the plain-text version." },
  // ⚠️ `options` recopie `DATE_STYLES` de `@nf/email/dates` parce que ce fichier n'importe RIEN (voir
  // l'en-tête) ; `reglages.test.ts` compare ces options au schéma, qui lit la vraie liste.
  { target: "meta", path: "dateFormats.edition_date", kind: "enum", options: ["full", "long", "medium", "short", "day_month", "weekday", "weekday_short"], default: "long", status: "new", item: 100, hint: "How {{edition_date}} is written, in the template's language." },
  { target: "meta", path: "dateFormats.edition_date_short", kind: "enum", options: ["full", "long", "medium", "short", "day_month", "weekday", "weekday_short"], default: "medium", status: "new", item: 100, hint: "How {{edition_date_short}} is written, in the template's language." },
  { target: "meta", path: "dateFormats.weekday", kind: "enum", options: ["full", "long", "medium", "short", "day_month", "weekday", "weekday_short"], default: "weekday", status: "new", item: 100, hint: "How {{weekday}} is written, in the template's language." },

  /* --- Blocs simples ---------------------------------------------------------------------- */
  { target: "text", path: "paragraphSpacing", kind: "number", min: 0, max: 64, default: 12, status: "new", item: 64, hint: "Space between paragraphs, px." },
  { target: "button", path: "buttonBackground", kind: "color", default: "theme.brandColor", computed: true, status: "new", item: 65, hint: "Button background colour." },
  { target: "button", path: "buttonTextColor", kind: "color", default: "theme.buttonTextColor", computed: true, status: "new", item: 66, hint: "Button label colour." },
  { target: "button", path: "labelSize", kind: "number", min: 8, max: 40, default: "max(14, block font size − 1)", computed: true, status: "new", item: 67, hint: "Button label size, px." },
  { target: "button", path: "labelWeight", kind: "enum", options: WEIGHTS, default: "700", status: "new", item: 67, hint: "Button label weight." },
  { target: "button", path: "innerPadding", kind: "spacing", min: 0, max: 200, default: "14 / 26 / 14 / 26", computed: true, status: "new", item: 67, hint: "Button inner padding, side by side (px)." },
  { target: "divider", path: "lineStyle", kind: "enum", options: LINE_STYLES, default: "solid", status: "new", item: 68, hint: "Line style of a single-colour divider." },
  { target: "social", path: "labelColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 69, hint: "Colour of the labels next to the icons." },
  { target: "social", path: "labelSize", kind: "number", min: 8, max: 40, default: 13, status: "new", item: 69, hint: "Label size, px." },
  { target: "social", path: "iconBackground", kind: "color", default: "each network's colour", computed: true, status: "new", item: 69, hint: "One background colour for every icon." },
  { target: "social", path: "iconRadius", kind: "number", min: 0, max: 32, default: 3, status: "new", item: 69, hint: "Icon corner radius, px." },
  { target: "menu", path: "itemSize", kind: "number", min: 8, max: 40, default: "max(12, block font size − 2)", computed: true, status: "new", item: 71, hint: "Menu link size, px." },
  { target: "menu", path: "itemWeight", kind: "enum", options: WEIGHTS, default: "600", status: "new", item: 71, hint: "Menu link weight." },
  { target: "menu", path: "itemUnderline", kind: "boolean", default: false, status: "new", item: 71, hint: "Underline the menu links." },
  { target: "menu", path: "itemLineHeight", kind: "number", min: 1, max: 3, step: 0.1, default: 1.8, status: "new", item: 71, hint: "Menu line height (when it wraps)." },
  { target: "menu", path: "separatorColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 71, hint: "Colour of the separator between links." },

  /* --- Pick ------------------------------------------------------------------------------- */
  { target: "pick", path: "kickoffSize", kind: "number", min: 8, max: 40, default: "max(11, block font size − 4)", computed: true, status: "new", item: 72, hint: "Kick-off line size, px." },
  { target: "pick", path: "kickoffColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 72, hint: "Kick-off line colour." },
  { target: "pick", path: "kickoffTransform", kind: "enum", options: TRANSFORMS, default: "uppercase", status: "new", item: 72, hint: "Kick-off line case." },
  { target: "pick", path: "matchSize", kind: "number", min: 8, max: 40, default: "block font size + 1", computed: true, status: "new", item: 72, hint: "Match label size, px." },
  { target: "pick", path: "matchColor", kind: "color", default: "block text colour", computed: true, status: "new", item: 72, hint: "Match label colour." },
  { target: "pick", path: "marketSize", kind: "number", min: 8, max: 40, default: "max(11, block font size − 4)", computed: true, status: "new", item: 72, hint: "Market label size, px." },
  { target: "pick", path: "marketColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 72, hint: "Market label colour." },
  { target: "pick", path: "selectionSize", kind: "number", min: 8, max: 40, default: "block font size", computed: true, status: "new", item: 72, hint: "Selection label size, px." },
  { target: "pick", path: "selectionColor", kind: "color", default: "theme.brandColor", computed: true, status: "new", item: 72, hint: "Selection label colour." },
  { target: "pick", path: "confidenceSize", kind: "number", min: 8, max: 40, default: "max(11, block font size − 4)", computed: true, status: "new", item: 72, hint: "Confidence line size, px." },
  { target: "pick", path: "confidenceColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 72, hint: "Confidence line colour." },
  { target: "pick", path: "oddsBackground", kind: "color", default: "theme.brandColor", computed: true, status: "new", item: 73, hint: "Odds badge background." },
  { target: "pick", path: "oddsTextColor", kind: "color", default: "theme.buttonTextColor", computed: true, status: "new", item: 73, hint: "Odds badge text colour." },
  { target: "pick", path: "oddsSize", kind: "number", min: 8, max: 40, default: "block font size + 1", computed: true, status: "new", item: 73, hint: "Odds badge text size, px." },
  { target: "pick", path: "innerPadding", kind: "spacing", min: 0, max: 200, default: "16 / 16 / 16 / 16", computed: true, status: "new", item: 75, hint: "Card inner padding, side by side (px)." },
  { target: "pick", path: "rowGap", kind: "number", min: 0, max: 48, default: 10, status: "new", item: 75, hint: "Gap between the card's lines, px." },
  { target: "pick", path: "frameColor", kind: "color", default: "block border colour, else theme.borderColor", computed: true, status: "new", item: 75, hint: "Card frame colour." },
  { target: "pick", path: "frameWidth", kind: "number", min: 0, max: 12, default: 1, status: "new", item: 75, hint: "Card frame thickness, px (0 = none)." },
  ...cardButton("pick", 74, true),

  /* --- Tableaux sportifs ------------------------------------------------------------------ */
  { target: "odds_table", path: "textSize", kind: "number", min: 8, max: 40, default: "max(12, block font size − 1)", computed: true, status: "new", item: 76, hint: "Row text size, px." },
  { target: "odds_table", path: "labelWeight", kind: "enum", options: WEIGHTS, default: "400", status: "new", item: 76, hint: "Label weight." },
  { target: "odds_table", path: "valueWeight", kind: "enum", options: WEIGHTS, default: "700", status: "new", item: 76, hint: "Value weight." },
  { target: "odds_table", path: "valueColor", kind: "color", default: "block text colour", computed: true, status: "new", item: 76, hint: "Value colour." },
  { target: "odds_table", path: "rowPadding", kind: "number", min: 0, max: 32, default: 9, status: "new", item: 76, hint: "Space above and below each row, px." },
  { target: "odds_table", path: "ruleWidth", kind: "number", min: 0, max: 6, default: 1, status: "new", item: 76, hint: "Line between rows, px (0 = none)." },
  { target: "odds_table", path: "captionSize", kind: "number", min: 8, max: 40, default: "max(11, block font size − 4)", computed: true, status: "new", item: 76, hint: "Caption size, px." },
  { target: "odds_table", path: "captionColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 76, hint: "Caption colour." },
  { target: "standings", path: "textSize", kind: "number", min: 8, max: 40, default: "max(12, block font size − 2)", computed: true, status: "new", item: 77, hint: "Row text size, px." },
  { target: "standings", path: "headerSize", kind: "number", min: 8, max: 40, default: "max(10, row text size − 1)", computed: true, status: "new", item: 77, hint: "Header size, px." },
  { target: "standings", path: "headerColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 77, hint: "Header colour." },
  { target: "standings", path: "headerTransform", kind: "enum", options: TRANSFORMS, default: "uppercase", status: "new", item: 77, hint: "Header case." },
  { target: "standings", path: "headerRuleWidth", kind: "number", min: 0, max: 6, default: 2, status: "new", item: 77, hint: "Line under the header, px (0 = none)." },
  { target: "standings", path: "firstColumnWeight", kind: "enum", options: WEIGHTS, default: "600", status: "new", item: 77, hint: "Weight of the first (name) column." },
  { target: "standings", path: "firstColumnPct", kind: "number", min: 20, max: 80, default: 44, status: "new", item: 77, hint: "Width of the first column, % of the table." },
  { target: "standings", path: "rowPadding", kind: "number", min: 0, max: 32, default: 8, status: "new", item: 77, hint: "Space above and below each row, px." },
  { target: "standings", path: "ruleWidth", kind: "number", min: 0, max: 6, default: 1, status: "new", item: 77, hint: "Line between rows, px (0 = none)." },
  { target: "standings", path: "captionSize", kind: "number", min: 8, max: 40, default: "max(11, block font size − 4)", computed: true, status: "new", item: 77, hint: "Caption size, px." },
  { target: "standings", path: "captionColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 77, hint: "Caption colour." },
  { target: "scoreboard", path: "labelColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 78, hint: "Label colour of ordinary rows." },
  { target: "scoreboard", path: "valueColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 78, hint: "Value colour of ordinary rows." },
  { target: "scoreboard", path: "highlightLabelColor", kind: "color", default: "block text colour", computed: true, status: "new", item: 78, hint: "Label colour of highlighted rows." },
  { target: "scoreboard", path: "highlightValueColor", kind: "color", default: "theme.brandColor", computed: true, status: "new", item: 78, hint: "Value colour of highlighted rows." },
  { target: "scoreboard", path: "labelSize", kind: "number", min: 8, max: 40, default: "block font size", computed: true, status: "new", item: 79, hint: "Label size, px." },
  { target: "scoreboard", path: "kickerSize", kind: "number", min: 8, max: 40, default: "max(11, block font size − 4)", computed: true, status: "new", item: 79, hint: "Kicker size, px." },
  { target: "scoreboard", path: "innerPadding", kind: "spacing", min: 0, max: 200, default: "16 / 16 / 16 / 16", computed: true, status: "new", item: 79, hint: "Panel inner padding, side by side (px)." },
  { target: "scoreboard", path: "footerRuleColor", kind: "color", default: "block border colour, else theme.borderColor", computed: true, status: "new", item: 79, hint: "Colour of the line above the footer." },
  { target: "scoreboard", path: "footerRuleWidth", kind: "number", min: 0, max: 6, default: 1, status: "new", item: 79, hint: "Line above the footer, px (0 = none)." },
  { target: "scoreboard", path: "footerLabelColor", kind: "color", default: "block text colour", computed: true, status: "new", item: 79, hint: "Footer link colour." },

  /* --- Article et flux -------------------------------------------------------------------- */
  ...articleCard("article"),
  { target: "article", path: "ctaSize", kind: "number", min: 8, max: 40, default: "block font size (link) · max(13, block font size − 2) (button)", computed: true, status: "extended", item: 74, hint: "Read-link size — now applies to the button form too." },
  { target: "article", path: "ctaLetterSpacing", kind: "number", min: -2, max: 12, step: 0.5, default: "none", computed: true, status: "extended", item: 74, hint: "Read-link letter spacing — now applies to the button form too." },
  { target: "article", path: "ctaTransform", kind: "enum", options: TRANSFORMS, default: "none", status: "extended", item: 74, hint: "Read-link case — now applies to the button form too." },
  ...articleCard("article-feed.card"),
  ...articleCard("article-feed.lead"),
  { target: "article-feed", path: "ctaStyle", kind: "enum", options: ["button", "link", "none"], default: "button", status: "new", item: 85, hint: "Read-link form for every card of the feed; 'none' removes it (a look's own ctaStyle wins)." },
  { target: "article-feed", path: "timeFormat", kind: "enum", options: ["24h", "12h"], default: "24h", status: "new", item: 86, hint: "Time format in kickers and meta lines." },
  { target: "article-feed", path: "kickerSeparator", kind: "string", min: 1, max: 12, default: " · (non-breaking spaces)", computed: true, status: "new", item: 87, hint: "Separator between category and time in the kicker." },
  { target: "article-feed", path: "leadCount", kind: "number", min: 0, max: 3, default: 0, status: "extended", item: 89, hint: "Number of lead articles (was 0–1, now 0–3)." },
  { target: "article-feed", path: "midSection.showWithoutLead", kind: "boolean", default: false, status: "new", item: 89, hint: "Also show the section title when the feed has no lead (above the first card)." },
  { target: "article-feed", path: "midSection.ruleGap", kind: "number", min: 0, max: 48, default: "12 (after/before/both) · 9 (left) · 8 (under)", computed: true, status: "new", item: 90, hint: "Gap between the section label and its line, px." },
  { target: "article-feed", path: "midSection.rule", kind: "enum", options: ["after", "under", "none", "left", "before", "both"], default: "after", status: "extended", item: 90, hint: "Section-title line; adds 'before' and 'both'." },
  { target: "article-feed", path: "cardRule.widthPct", kind: "number", min: 10, max: 100, default: 100, status: "new", item: 89, hint: "Width of the line between cards, %." },
  { target: "article-feed", path: "cardRule.lineStyle", kind: "enum", options: LINE_STYLES, default: "solid", status: "new", item: 89, hint: "Style of the line between cards." },

  /* --- Titre de section, encart, promo ---------------------------------------------------- */
  { target: "section_title", path: "rule", kind: "enum", options: ["after", "under", "none", "left", "before", "both"], default: "after", status: "extended", item: 90, hint: "Adds 'before' (line left of the label) and 'both' (line on each side)." },
  { target: "section_title", path: "ruleGap", kind: "number", min: 0, max: 48, default: "12 (after/before/both) · 9 (left) · 8 (under)", computed: true, status: "new", item: 90, hint: "Gap between the label and its line, px." },
  { target: "callout", path: "titleColor", kind: "color", default: "block text colour", computed: true, status: "new", item: 91, hint: "Title colour." },
  { target: "callout", path: "titleWeight", kind: "enum", options: WEIGHTS, default: "block weight, else 700", computed: true, status: "new", item: 91, hint: "Title weight." },
  { target: "callout", path: "titleLineHeight", kind: "number", min: 0.9, max: 2.4, step: 0.05, default: 1.25, status: "new", item: 91, hint: "Title line height." },
  { target: "callout", path: "ctaFont", kind: "font", min: 1, max: 200, default: "titleFont, else block font", computed: true, status: "new", item: 91, hint: "Button font." },
  ...cardButton("callout", 91, true).filter((p) => p.path !== "ctaBackground" && p.path !== "ctaTextColor"),

  /*
   * --- Encart : les 7 mises en page (23/09/2026, `tasks/plan-blocs-importables.md` étape 13) ------
   * Hors inventaire du 22/09 : `item` 100 les regroupe. Toutes ces clés, sauf `layout`, n'ont
   * d'effet QUE sous un `layout` posé (l'encart classique ne les lit pas) — d'où les défauts
   * « par mise en page », calculés, et le contexte que `reglages.test.ts` pose avant de les mesurer.
   */
  { target: "callout", path: "layout", kind: "enum", options: ["poster", "player", "cover", "wave", "gallery", "strip", "ticket"], default: "none (classic panel)", computed: true, status: "new", item: 100, hint: "Layout of the callout: poster, player, cover, wave, gallery, strip or ticket." },
  { target: "callout", path: "backgroundImage", kind: "string", min: 1, max: 2048, default: "none", computed: true, status: "new", item: 100, hint: "Background picture (poster, player, cover, strip, ticket). The block background is its fallback colour." },
  { target: "callout", path: "backgroundPosition", kind: "enum", options: ["left", "center", "right"], default: "center", status: "new", item: 100, hint: "Horizontal framing of the background picture." },
  { target: "callout", path: "minHeight", kind: "number", min: 40, max: 800, default: "poster 360 · player 280 · cover 224 · strip 130 · ticket 320", computed: true, status: "new", item: 100, hint: "Height of the picture area, px." },
  { target: "callout", path: "contentVAlign", kind: "enum", options: ["top", "middle", "bottom"], default: "middle (poster, strip) · bottom (ticket)", computed: true, status: "new", item: 100, hint: "Vertical position of the text on the picture." },
  { target: "callout", path: "kickerStyle", kind: "enum", options: ["plain", "dot", "pill"], default: "plain", status: "new", item: 100, hint: "Kicker: plain text, a leading dot, or a pill." },
  { target: "callout", path: "kickerAccent", kind: "color", default: "theme.brandColor", computed: true, status: "new", item: 100, hint: "Colour of the kicker dot or pill." },
  { target: "callout", path: "playBackground", kind: "color", default: "button background", computed: true, status: "new", item: 100, hint: "Background of the play / plus badge." },
  { target: "callout", path: "playColor", kind: "color", default: "button label colour", computed: true, status: "new", item: 100, hint: "Glyph colour of the play / plus badge." },
  { target: "callout", path: "progress", kind: "number", min: 0, max: 100, default: "36 (player) · 42 (wave)", computed: true, status: "new", item: 100, hint: "Played share of the progress bar and waveform, %." },
  { target: "callout", path: "progressColor", kind: "color", default: "theme.brandColor", computed: true, status: "new", item: 100, hint: "Colour of the played part (bar and waveform)." },
  { target: "callout", path: "progressTrackColor", kind: "color", default: "theme.mutedColor", computed: true, status: "new", item: 100, hint: "Colour of the rest of the bar and waveform." },
  { target: "callout", path: "waveSeed", kind: "number", min: 0, max: 10, step: 0.1, default: 1, status: "new", item: 100, hint: "Shape of the waveform: two neighbouring waves should not look alike." },
  { target: "callout", path: "stubBackground", kind: "color", default: "theme.brandColor", computed: true, status: "new", item: 100, hint: "Ticket stub, and the picture box of cover and gallery when images are off." },
  { target: "callout", path: "stubTextColor", kind: "color", default: "body colour, else theme.buttonTextColor", computed: true, status: "new", item: 100, hint: "Text on the ticket stub (and gallery alt text when images are off)." },
  { target: "callout", path: "gallery", kind: "images", min: 1, max: 3, default: "none", computed: true, status: "new", item: 100, hint: "Up to three pictures, each with its alt text; each links to the button URL." },
  { target: "callout", path: "ctaFullWidth", kind: "boolean", default: false, status: "new", item: 100, hint: "Button spans the full width of its area." },
  { target: "promo", path: "frameColor", kind: "color", default: "theme.brandColor", computed: true, status: "new", item: 92, hint: "Card frame colour." },
  { target: "promo", path: "frameWidth", kind: "number", min: 0, max: 12, default: 1, status: "new", item: 92, hint: "Card frame thickness, px (0 = none)." },
  { target: "promo", path: "innerPadding", kind: "spacing", min: 0, max: 200, default: "16 / 16 / 16 / 16", computed: true, status: "new", item: 75, hint: "Card inner padding, side by side (px)." },
  { target: "promo", path: "rowGap", kind: "number", min: 0, max: 48, default: 10, status: "new", item: 75, hint: "Gap between the card's lines, px." },
  { target: "promo", path: "codeColor", kind: "color", default: "block text colour", computed: true, status: "new", item: 93, hint: "Promo code text colour." },
  { target: "promo", path: "codeBorderColor", kind: "color", default: "theme.brandColor", computed: true, status: "new", item: 93, hint: "Promo code border colour." },
  { target: "promo", path: "codeBorderStyle", kind: "enum", options: LINE_STYLES, default: "dashed", status: "new", item: 93, hint: "Promo code border style." },
  { target: "promo", path: "codeBackground", kind: "color", default: "none", computed: true, status: "new", item: 93, hint: "Promo code background." },
  { target: "promo", path: "codeSize", kind: "number", min: 8, max: 40, default: "block font size + 1", computed: true, status: "new", item: 93, hint: "Promo code size, px." },
  { target: "promo", path: "codeFont", kind: "font", min: 1, max: 200, default: "Consolas,'Courier New',monospace", status: "new", item: 93, hint: "Promo code font." },
  ...cardButton("promo", 74, true),
];

/** Clé stable d'une entrée — `target:path` — celle que les bancs et l'inspecteur utilisent. */
export const newPropKey = (p: Pick<NewPropSpec, "target" | "path">): string => `${p.target}:${p.path}`;
