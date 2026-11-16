/**
 * EmailDoc v2 — SOURCE DE VÉRITÉ UNIQUE du builder, du compilateur et du générateur IA.
 *
 * 3 niveaux : Row > Column > Block. Sérialisable, diffable, générable par un LLM sans exécuter
 * de code. Stocké tel quel dans `newsletter.template_version.doc` (jsonb).
 *
 * Deux garde-fous structurels, tous deux volontaires :
 *  1. `layout` est une ÉNUMÉRATION FERMÉE. Pas de ratio libre : les ghost tables Outlook exigent
 *     une arithmétique de largeurs exacte, un ratio arbitraire la casse en silence.
 *  2. Le texte n'est JAMAIS du HTML libre : c'est une liste de paragraphes de « spans » avec des
 *     marques inline légères. Rien à sanitiser, aucun `<div>` ne peut fuiter.
 *
 * Les objets sont `.strict()` : une propriété inventée (hallucination d'IA, reliquat d'une
 * ancienne version) échoue au parse au lieu d'être ignorée en silence.
 */
import { z } from "zod";
import { DATE_STYLES } from "@nf/email/dates";
import { CONDITION_FIELDS } from "./hydrate";

export { MERGE_VARS, MERGE_VAR_NAMES, CONDITION_FIELDS, CONDITION_END, conditionMarker, escapeHtml } from "./hydrate";
export type { MergeVarName, MergeVarKind, MergeVarSpec, MergeVars, VisibleIfSpec } from "./hydrate";

/* ------------------------------------------------------------------ *
 * Constantes partagées (builder + IA)
 * ------------------------------------------------------------------ */

/** Types de blocs implémentés. SOURCE DE VÉRITÉ : le prompt IA et la palette du builder lisent ça. */
export const BLOCK_TYPES = [
  "text",
  "image",
  "button",
  "divider",
  "spacer",
  "section_title",
  "html",
  "social",
  "menu",
  // Blocs métier : de la MISE EN PAGE, pas de la donnée. Ils ne portent que des chaînes saisies
  // par l'éditeur (ou des merge tags) — le compilateur n'invente ni cote, ni score, ni classement.
  "pick",
  "odds_table",
  "standings",
  "scoreboard",
  "article",
  "callout",
  "promo",
  // Verrouillé, toujours en dernier dans la palette.
  "footer_legal",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** Layouts de row autorisés. Fermé par conception (voir en-tête). */
export const ROW_LAYOUTS = ["1", "1-1", "1-1-1", "1-1-1-1", "2-1", "1-2", "3-1", "1-3"] as const;
export type RowLayout = (typeof ROW_LAYOUTS)[number];

/** Poids de colonnes par layout — l'unique arithmétique de largeur du compilateur. */
export const LAYOUT_WEIGHTS: Record<RowLayout, readonly number[]> = {
  "1": [1],
  "1-1": [1, 1],
  "1-1-1": [1, 1, 1],
  "1-1-1-1": [1, 1, 1, 1],
  "2-1": [2, 1],
  "1-2": [1, 2],
  "3-1": [3, 1],
  "1-3": [1, 3],
};

export const columnCount = (layout: RowLayout): number => LAYOUT_WEIGHTS[layout].length;

/** Presets typographiques du bloc texte. */
export const TEXT_PRESETS = ["h1", "h2", "h3", "body", "small"] as const;
export type TextPreset = (typeof TEXT_PRESETS)[number];

export const ALIGNMENTS = ["left", "center", "right"] as const;
export type Align = (typeof ALIGNMENTS)[number];

/** Réseaux sociaux proposés. MJML n'embarque pas d'icône pour tous → `iconSrc` sinon. */
export const SOCIAL_PLATFORMS = [
  "facebook",
  "instagram",
  "twitter",
  "youtube",
  "linkedin",
  "tiktok",
  "telegram",
  "whatsapp",
  "web",
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/**
 * ⚠️ JAMAIS de `#000000` ni `#ffffff` purs : ce sont des déclencheurs codés en dur d'inversion
 * dark mode (Outlook.com, Gmail Android). On utilise des quasi-noir / quasi-blanc.
 */
export const NEAR_BLACK = "#0E0E0E";
export const NEAR_WHITE = "#FEFEFE";

// Déplacées dans `limits.ts` (aucune dépendance) pour que le worker et `shell-checks` puissent les
// lire sans tirer Zod — sans les DUPLIQUER, ce qui donnerait deux vérités pour un seuil légal.
// Ré-exportées ici : tous les appelants existants sont inchangés.
import { GMAIL_CLIP_BYTES, MAX_BUTTON_LABEL } from "./limits";
export { GMAIL_CLIP_BYTES, MAX_BUTTON_LABEL };

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const HexColor = z
  .string()
  .regex(HEX, "expected a hex color such as #1A1A20")
  .refine((v) => {
    const n = v.toLowerCase();
    return n !== "#000" && n !== "#000000" && n !== "#fff" && n !== "#ffffff";
  }, "pure #000000/#ffffff trigger dark-mode inversion — use #0E0E0E / #FEFEFE");

/** Schémas d'URL bannis dans un email (exécution, exfiltration, pièce jointe déguisée). */
const UNSAFE_SCHEME = /^\s*(?:javascript|vbscript|data|file|blob):/i;

/**
 * Href : URL absolue, chemin relatif, mailto/tel — ou un merge tag `{{unsubscribe_url}}`.
 * On ne peut pas utiliser `z.url()` : les tokens ne sont pas des URLs valides à la publication.
 */
export const Href = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => !UNSAFE_SCHEME.test(v), "unsafe URL scheme");

/** Src d'image : https, chemin relatif ou merge tag. `http://` passe mais déclenche un warning. */
export const ImageSrc = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => !UNSAFE_SCHEME.test(v), "unsafe image source");

/**
 * SENTINELLE D'ILLUSTRATION `ai://<brief>`.
 *
 * La composition IA ne peut pas inventer une URL d'image : elle pose cette sentinelle, que l'étape
 * de génération d'images remplace par une URL hébergée. Le schéma de BROUILLON l'accepte (le document
 * doit rester sauvegardable et prévisualisable entre les deux étapes) mais `EmailDocPublishable` la
 * REFUSE : publier une sentinelle enverrait une image cassée à de vrais abonnés.
 */
const AI_PLACEHOLDER = /^\s*(?:ai|placeholder):/i;
export const isPlaceholderSrc = (src: string): boolean => AI_PLACEHOLDER.test(src);

export const Spacing = z
  .object({
    top: z.number().int().min(0).max(200).optional(),
    right: z.number().int().min(0).max(200).optional(),
    bottom: z.number().int().min(0).max(200).optional(),
    left: z.number().int().min(0).max(200).optional(),
  })
  .strict();
export type Spacing = z.infer<typeof Spacing>;

/**
 * Style commun row / column / block. Tout est optionnel : la cascade theme → row → block est
 * résolue par le compilateur AVANT génération (Outlook n'hérite d'aucun style de façon fiable).
 */
export const BoxStyle = z
  .object({
    backgroundColor: HexColor.optional(),
    padding: Spacing.optional(),
    paddingMobile: Spacing.optional(),
    align: z.enum(ALIGNMENTS).optional(),
    textColor: HexColor.optional(),
    linkColor: HexColor.optional(),
    fontFamily: z.string().min(1).max(200).optional(),
    fontSize: z.number().int().min(8).max(72).optional(),
    fontSizeMobile: z.number().int().min(8).max(72).optional(),
    lineHeight: z.number().min(1).max(3).optional(),
    /** Interlettrage en px. Négatif = resserré. Hérité, comme la police et la taille. */
    letterSpacing: z.number().min(-2).max(10).optional(),
    /** Casse forcée. Émise en CSS inline, JAMAIS en attribut MJML (voir `textStyle`). */
    textTransform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(),
    /** Graisse. Écrase celle du preset de texte quand elle est posée. */
    fontWeight: z.enum(["300", "400", "500", "600", "700", "800", "900"]).optional(),
    /**
     * Alignement vertical des colonnes d'une row. N'a de sens qu'au niveau COLONNE : c'est le seul
     * étage où le compilateur émet une cellule de tableau qui puisse s'aligner.
     */
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
    borderColor: HexColor.optional(),
    borderWidth: z.number().int().min(0).max(12).optional(),
    borderRadius: z.number().int().min(0).max(48).optional(),
    /** Masqué sous 600px via une classe CSS + media query (jamais via flex/grid). */
    hideOnMobile: z.boolean().optional(),
  })
  .strict();
export type BoxStyle = z.infer<typeof BoxStyle>;

/*
 * Vocabulaire des réglages ajoutés le 22/09/2026 (« tout ce que l'abonné reçoit se règle dans le
 * builder »). Chacun remplace une valeur que le compilateur décidait seul ; ABSENT, il rend
 * exactement la valeur d'avant — c'est ce que garde le banc octet pour octet (`golden.test.ts`).
 * Mêmes listes que `BoxStyle` : un second vocabulaire pour la même notion divergerait.
 */
const FontWeight = z.enum(["300", "400", "500", "600", "700", "800", "900"]);
const TextTransform = z.enum(["none", "uppercase", "lowercase", "capitalize"]);
/** Tracé d'un filet ou d'un cadre. `solid` est le rendu historique partout. */
const LineStyle = z.enum(["solid", "dashed", "dotted"]);
/** Taille de texte d'un élément de carte, en px. */
const TextSize = z.number().int().min(8).max(40);
/** Écart vertical entre deux éléments d'une carte, en px. */
const Gap = z.number().int().min(0).max(48);

/**
 * Le BOUTON DES CARTES (pick, promo, encart, article en forme `button`) : un seul rendu
 * (`ctaTable`), donc un seul jeu de réglages. Absents : fond = couleur de marque du thème, texte =
 * `theme.buttonTextColor`, taille = max(13, taille du bloc − 2), graisse 700, marges 12/22 px, rayon =
 * celui du bloc (sinon du thème).
 */
const cardButtonLook = {
  /** Fond du bouton. Absent = `theme.brandColor`. */
  ctaBackground: HexColor.optional(),
  /** Couleur du libellé du bouton. Absente = `theme.buttonTextColor`. */
  ctaTextColor: HexColor.optional(),
  /** Taille du libellé, en px. Absente = max(13, taille du bloc − 2). */
  ctaSize: TextSize.optional(),
  /** Graisse du libellé. Absente = 700. */
  ctaWeight: FontWeight.optional(),
  /** Marges intérieures du bouton, côté par côté. Absentes = 12 px en haut et en bas, 22 px à gauche et à droite. */
  ctaPadding: Spacing.optional(),
  /** Rayon des angles du bouton, en px. Absent = le rayon du bloc (sinon celui du thème). */
  ctaRadius: z.number().int().min(0).max(48).optional(),
};

const Id = z.string().min(1).max(64);

/* ------------------------------------------------------------------ *
 * Texte riche restreint — pas de HTML libre
 * ------------------------------------------------------------------ */

export const InlineSpan = z
  .object({
    text: z.string().max(5000),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    /** Barré (`<s>`). Optionnel : aucun document existant n'en porte, aucun ne change. */
    strike: z.boolean().optional(),
    /** Lien inline. Peut contenir un merge tag. */
    href: Href.optional(),
    color: HexColor.optional(),
  })
  .strict();
export type InlineSpan = z.infer<typeof InlineSpan>;

export const Paragraph = z
  .object({
    spans: z.array(InlineSpan).min(1).max(200),
  })
  .strict();
export type Paragraph = z.infer<typeof Paragraph>;

/* ------------------------------------------------------------------ *
 * Contenu conditionnel
 * ------------------------------------------------------------------ */

/**
 * Affichage conditionnel d'une row / colonne / bloc, tranché PAR DESTINATAIRE à l'envoi.
 *
 * Le compilateur se contente d'entourer l'élément des marqueurs `<!--nf:if …-->` / `<!--nf:endif-->`
 * déjà compris par `hydrate()` : le HTML reste figé à la publication, un seul shell sert tout le
 * monde, et c'est le worker qui retire les morceaux qui ne s'appliquent pas.
 *
 * `token` est restreint au REGISTRE des merge tags : `hydrate` masque de toute façon un champ
 * inconnu pour TOUT LE MONDE (fail-closed), autant le refuser au parse plutôt que de livrer une
 * édition dont un pan entier disparaîtrait en silence.
 */
export const VisibleIf = z
  .object({
    token: z.enum(CONDITION_FIELDS),
    /**
     * Égalité avec la valeur du destinataire (casse et espaces de bord ignorés).
     * Absent → simple test de véracité du champ, l'usage des `flag`.
     */
    equals: z
      .string()
      .max(120)
      .refine((v) => !/["<>]/.test(v), 'characters " < > would break the conditional marker')
      .optional(),
    /** `false` inverse la condition (masquer quand elle est vraie). */
    exists: z.boolean().optional(),
  })
  .strict();
export type VisibleIf = z.infer<typeof VisibleIf>;

/* ------------------------------------------------------------------ *
 * Blocs
 * ------------------------------------------------------------------ */

const blockBase = {
  id: Id,
  style: BoxStyle.optional(),
  visibleIf: VisibleIf.optional(),
};

export const TextBlock = z
  .object({
    ...blockBase,
    type: z.literal("text"),
    preset: z.enum(TEXT_PRESETS).default("body"),
    paragraphs: z.array(Paragraph).min(1).max(200),
    /** Espace sous chaque paragraphe sauf le dernier, en px. Absent = 12. */
    paragraphSpacing: z.number().int().min(0).max(64).optional(),
  })
  .strict();

export const ImageBlock = z
  .object({
    ...blockBase,
    type: z.literal("image"),
    src: ImageSrc,
    /**
     * ⚠️ OBLIGATOIRE. La clé ne peut pas être omise ; une chaîne vide reste parsable pour ne pas
     * bloquer un brouillon, mais `EmailDocPublishable` la rejette et `compileDoc` la signale.
     */
    alt: z.string().max(300),
    href: Href.optional(),
    widthPct: z.number().int().min(5).max(100).default(100),
    align: z.enum(ALIGNMENTS).default("center"),
  })
  .strict();

export const ButtonBlock = z
  .object({
    ...blockBase,
    type: z.literal("button"),
    label: z.string().min(1).max(MAX_BUTTON_LABEL),
    href: Href,
    align: z.enum(ALIGNMENTS).default("center"),
    /*
     * ⛔ Des clés PROPRES au bouton, et pas `style.backgroundColor` / `style.textColor` : ces deux-là
     * peignent déjà le CONTENEUR du bloc (et `textColor` n'a jamais atteint le libellé). Leur donner
     * un second sens changerait en silence les boutons déjà publiés qui les portent (3 en base, 22/09).
     */
    /** Fond du bouton. Absent = `theme.brandColor`. */
    buttonBackground: HexColor.optional(),
    /** Couleur du libellé. Absente = `theme.buttonTextColor`. */
    buttonTextColor: HexColor.optional(),
    /** Taille du libellé, en px. Absente = max(14, taille du bloc − 1). */
    labelSize: TextSize.optional(),
    /** Graisse du libellé. Absente = 700. */
    labelWeight: FontWeight.optional(),
    /** Marges intérieures du bouton, côté par côté. Absentes = 14 px en haut et en bas, 26 px à gauche et à droite. */
    innerPadding: Spacing.optional(),
  })
  .strict();

export const DividerBlock = z
  .object({
    ...blockBase,
    type: z.literal("divider"),
    color: HexColor.optional(),
    thickness: z.number().int().min(1).max(12).default(1),
    widthPct: z.number().int().min(10).max(100).default(100),
    /**
     * Barre multicolore (drapeau de marque). ABSENT = filet uni : la branche `mj-divider` du
     * compilateur reste alors inchangée, octet pour octet, pour tous les documents existants.
     */
    segments: z
      .array(z.object({ color: HexColor, widthPct: z.number().int().min(1).max(100) }).strict())
      .min(2)
      .max(5)
      .optional(),
    /** Tracé du filet uni : plein, tirets ou pointillés. Absent = plein. Sans effet sur une barre à `segments`. */
    lineStyle: LineStyle.optional(),
  })
  .strict();

export const SpacerBlock = z
  .object({
    ...blockBase,
    type: z.literal("spacer"),
    height: z.number().int().min(1).max(200),
    heightMobile: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const HtmlBlock = z
  .object({
    ...blockBase,
    type: z.literal("html"),
    /** Échappatoire + cible de l'import HTML (palier 0). Rendu tel quel, jamais réécrit. */
    raw: z.string().max(200_000),
  })
  .strict();

export const SocialItem = z
  .object({
    platform: z.enum(SOCIAL_PLATFORMS),
    href: Href,
    /** Icône personnalisée — requise pour les plateformes sans icône MJML native. */
    iconSrc: ImageSrc.optional(),
    label: z.string().max(40).optional(),
  })
  .strict();
export type SocialItem = z.infer<typeof SocialItem>;

export const SocialBlock = z
  .object({
    ...blockBase,
    type: z.literal("social"),
    items: z.array(SocialItem).min(1).max(10),
    iconSize: z.number().int().min(16).max(64).default(24),
    mode: z.enum(["horizontal", "vertical"]).default("horizontal"),
    /** Couleur des libellés à côté des icônes. Absente = `theme.mutedColor`. */
    labelColor: HexColor.optional(),
    /** Taille des libellés, en px. Absente = le défaut de MJML (13 px). */
    labelSize: TextSize.optional(),
    /**
     * Fond des pastilles d'icône, le même pour tous les réseaux. Absent = la couleur propre à chaque
     * réseau dans le jeu d'icônes MJML (bleu Facebook, etc.).
     */
    iconBackground: HexColor.optional(),
    /** Rayon des pastilles d'icône, en px. Absent = le défaut de MJML (3 px). */
    iconRadius: z.number().int().min(0).max(32).optional(),
  })
  .strict();

export const MenuItem = z
  .object({
    label: z.string().min(1).max(40),
    href: Href,
  })
  .strict();
export type MenuItem = z.infer<typeof MenuItem>;

export const MenuBlock = z
  .object({
    ...blockBase,
    type: z.literal("menu"),
    items: z.array(MenuItem).min(1).max(8),
    separator: z.string().max(8).default("·"),
    /** Taille des liens, en px. Absente = max(12, taille du bloc − 2). */
    itemSize: TextSize.optional(),
    /** Graisse des liens. Absente = 600. */
    itemWeight: FontWeight.optional(),
    /** `true` = liens soulignés. Absent = non soulignés. */
    itemUnderline: z.boolean().optional(),
    /** Interligne du menu (utile quand il passe sur deux lignes). Absent = 1.8. */
    itemLineHeight: z.number().min(1).max(3).optional(),
    /** Couleur du séparateur entre deux liens. Absente = `theme.mutedColor`. */
    separatorColor: HexColor.optional(),
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Blocs métier
 *
 * ⛔ RÈGLE LA PLUS STRICTE DU PROJET : aucun de ces blocs ne porte de NOMBRE. Cote, score, position
 * au classement, pourcentage de confiance — tout est une CHAÎNE que l'éditeur remplit ou qui
 * contient un merge tag. Un champ numérique inviterait à une valeur par défaut, et une valeur par
 * défaut ressemblant à une donnée sportive finirait par partir en production. D'où : chaînes
 * partout, `min(0)` partout (un brouillon vide reste sauvegardable), zéro `.default("…")` parlant.
 * ------------------------------------------------------------------ */

/**
 * Un pronostic. Chaque libellé est autonome : le bloc ne recompose rien, ne calcule rien et ne
 * met en forme aucun chiffre — il pose des chaînes dans une carte.
 */
export const PickBlock = z
  .object({
    ...blockBase,
    type: z.literal("pick"),
    /** Ex. « Team A — Team B », ou `{{edition_title}}`. */
    matchLabel: z.string().max(160),
    /** Le marché tel qu'il doit s'afficher (« Both teams to score », …). */
    marketLabel: z.string().max(80),
    /** La sélection telle qu'elle doit s'afficher. */
    selectionLabel: z.string().max(120),
    /** ⚠️ CHAÎNE, jamais un nombre : saisie par l'éditeur ou merge tag. Rien n'est calculé ici. */
    oddsLabel: z.string().max(40),
    kickoffLabel: z.string().max(80).optional(),
    confidenceLabel: z.string().max(60).optional(),
    href: Href.optional(),
    ctaLabel: z.string().max(MAX_BUTTON_LABEL).optional(),

    /* --- Apparence (22/09/2026). Des TAILLES et des COULEURS, jamais une donnée : la règle ci-dessus
     * vise les cotes et les scores, pas la typographie. Absentes = la hiérarchie historique. */

    /** Coup d'envoi : taille (absente = max(11, taille du bloc − 4)), couleur (absente = `theme.mutedColor`). */
    kickoffSize: TextSize.optional(),
    kickoffColor: HexColor.optional(),
    /** Casse du coup d'envoi. Absente = capitales. */
    kickoffTransform: TextTransform.optional(),
    /** Affiche : taille (absente = taille du bloc + 1), couleur (absente = couleur du texte). */
    matchSize: TextSize.optional(),
    matchColor: HexColor.optional(),
    /** Marché : taille (absente = max(11, taille du bloc − 4)), couleur (absente = `theme.mutedColor`). */
    marketSize: TextSize.optional(),
    marketColor: HexColor.optional(),
    /** Sélection : taille (absente = taille du bloc), couleur (absente = `theme.brandColor`). */
    selectionSize: TextSize.optional(),
    selectionColor: HexColor.optional(),
    /** Ligne de confiance : taille (absente = max(11, taille du bloc − 4)), couleur (absente = `theme.mutedColor`). */
    confidenceSize: TextSize.optional(),
    confidenceColor: HexColor.optional(),
    /** Pastille de cote : fond (absent = `theme.brandColor`), texte (absent = `theme.buttonTextColor`), taille (absente = taille du bloc + 1). */
    oddsBackground: HexColor.optional(),
    oddsTextColor: HexColor.optional(),
    oddsSize: TextSize.optional(),
    /** Marges intérieures de la carte, côté par côté. Absentes = 16 px partout. */
    innerPadding: Spacing.optional(),
    /** Écart vertical entre deux lignes de la carte, en px. Absent = 10. */
    rowGap: Gap.optional(),
    /** Cadre de la carte : couleur (absente = couleur de bordure du bloc, sinon du thème), épaisseur (absente = 1 ; 0 = sans cadre). */
    frameColor: HexColor.optional(),
    frameWidth: z.number().int().min(0).max(12).optional(),
    ...cardButtonLook,
  })
  .strict();

export const OddsRow = z
  .object({
    label: z.string().max(120),
    /** Chaîne, même raison que `PickBlock.oddsLabel`. */
    value: z.string().max(40),
  })
  .strict();
export type OddsRow = z.infer<typeof OddsRow>;

export const OddsTableBlock = z
  .object({
    ...blockBase,
    type: z.literal("odds_table"),
    rows: z.array(OddsRow).min(2).max(12),
    caption: z.string().max(200).optional(),
    /** Taille des lignes, en px. Absente = max(12, taille du bloc − 1). */
    textSize: TextSize.optional(),
    /** Graisse des libellés (absente = 400) et des valeurs (absente = 700). */
    labelWeight: FontWeight.optional(),
    valueWeight: FontWeight.optional(),
    /** Couleur des valeurs. Absente = couleur du texte. */
    valueColor: HexColor.optional(),
    /** Marge au-dessus et au-dessous de chaque ligne, en px. Absente = 9. */
    rowPadding: z.number().int().min(0).max(32).optional(),
    /** Épaisseur du filet entre deux lignes, en px. Absente = 1 ; 0 = sans filet. */
    ruleWidth: z.number().int().min(0).max(6).optional(),
    /** Légende : taille (absente = max(11, taille du bloc − 4)), couleur (absente = `theme.mutedColor`). */
    captionSize: TextSize.optional(),
    captionColor: HexColor.optional(),
  })
  .strict();

/**
 * Extrait de classement. Volontairement une grille de chaînes, sans en-tête typé ni notion
 * d'équipe : le bloc ne sait pas ce qu'il affiche, il ne peut donc rien inventer.
 */
export const StandingsBlock = z
  .object({
    ...blockBase,
    type: z.literal("standings"),
    /** En-têtes. 2 à 5 colonnes : au-delà, la largeur email ne suit plus. */
    columns: z.array(z.string().max(40)).min(2).max(5),
    /** Lignes. Une ligne trop courte est complétée par des cellules vides au rendu, jamais devinée. */
    rows: z.array(z.array(z.string().max(60)).max(5)).max(30),
    caption: z.string().max(200).optional(),
    /** Taille des lignes, en px. Absente = max(12, taille du bloc − 2). */
    textSize: TextSize.optional(),
    /** En-têtes : taille (absente = max(10, taille des lignes − 1)), couleur (absente = `theme.mutedColor`), casse (absente = capitales). */
    headerSize: TextSize.optional(),
    headerColor: HexColor.optional(),
    headerTransform: TextTransform.optional(),
    /** Épaisseur du filet sous les en-têtes, en px. Absente = 2 ; 0 = sans filet. */
    headerRuleWidth: z.number().int().min(0).max(6).optional(),
    /** Graisse de la 1re colonne (le nom). Absente = 600. */
    firstColumnWeight: FontWeight.optional(),
    /** Largeur de la 1re colonne en % du tableau. Absente = 44. */
    firstColumnPct: z.number().int().min(20).max(80).optional(),
    /** Marge au-dessus et au-dessous de chaque ligne, en px. Absente = 8. */
    rowPadding: z.number().int().min(0).max(32).optional(),
    /** Épaisseur du filet entre deux lignes, en px. Absente = 1 ; 0 = sans filet. */
    ruleWidth: z.number().int().min(0).max(6).optional(),
    /** Légende : taille (absente = max(11, taille du bloc − 4)), couleur (absente = `theme.mutedColor`). */
    captionSize: TextSize.optional(),
    captionColor: HexColor.optional(),
  })
  .strict();

/**
 * PROVENANCE D'UN BLOC IMPORTÉ — métadonnée d'ÉDITION, jamais de rendu.
 *
 * Rien de ceci n'est émis dans l'e-mail : c'est ce que l'éditeur affiche sous le bloc pour dire
 * d'où vient le contenu et depuis quand il dort là. Elle vit dans le document (et pas à côté) pour
 * une seule raison : le document est ce qui est dupliqué, publié et figé dans une occurrence de
 * série. Rangée ailleurs, elle se perdrait exactement au moment où la question « ces articles
 * datent de quand ? » devient celle qui compte.
 *
 * ⚠️ `fetchedAt` est l'instant de la RÉCUPÉRATION, pas celui de la publication de l'article. La
 * fraîcheur d'une occurrence hebdomadaire se mesure `occurrence.scheduled_at − fetchedAt` — jamais
 * `now − fetchedAt`, qui répondrait « frais » à 8 h du matin pour un envoi prévu six jours plus tard.
 */
export const BlockSource = z
  .object({
    kind: z.literal("wp"),
    /** Id de la ligne `wp_source` : c'est par lui qu'on sait où retourner chercher. */
    sourceId: z.string().max(64),
    /** Étiquette lisible (« Atlas Review — racine »), pour ne pas afficher un uuid à l'auteur. */
    sourceLabel: z.string().max(120),
    /** Id WordPress de l'article, en texte : une clé, pas un nombre sur lequel on compte. */
    postId: z.string().max(40),
    /** Instant de récupération, ISO 8601. */
    fetchedAt: z.string().max(40),
    /** Date de publication de l'article chez la source, ISO 8601 — ou absente si illisible. */
    publishedAt: z.string().max(40).optional(),
    /**
     * URL de la vignette CHEZ LA SOURCE au moment de l'import.
     *
     * Elle n'est jamais rendue — `imageSrc` porte notre URL réhébergée. Elle sert uniquement à
     * savoir, au rafraîchissement, si l'illustration a changé : comparer à `imageSrc` ne dirait
     * rien, les deux ne se ressemblent jamais.
     */
    remoteImageUrl: z.string().max(2048).optional(),
    /**
     * ÉPINGLÉ : un rafraîchissement ne doit jamais le remplacer. C'est l'article que l'auteur a
     * choisi à la main et retouché ; l'écraser au nom de la fraîcheur détruirait son travail.
     */
    pinned: z.boolean().default(false),
  })
  .strict();

export type BlockSource = z.infer<typeof BlockSource>;

/**
 * Réglages de carte d'article ajoutés le 22/09/2026 — partagés TELS QUELS par le bloc `article` et
 * par `ArticleLook` (une et brèves d'un flux), que `toArticle` recopie sans les renommer.
 * Absents : exactement les valeurs que `articleHtml` posait en dur.
 */
const articleCardLook = {
  /** Interligne du chapeau. Absent = 1.55. */
  excerptLineHeight: z.number().min(1).max(3).optional(),
  /** Graisse du chapeau. Absente = 400. */
  excerptWeight: FontWeight.optional(),
  /** Espace sous le surtitre, en px. Absent = 5. */
  kickerGap: Gap.optional(),
  /** Espace sous l'image (image pleine largeur, ou vignette empilée sur mobile), en px. Absent = 12. */
  imageGap: Gap.optional(),
  /** Espace au-dessus du chapeau, en px. Absent = 6. */
  excerptGap: Gap.optional(),
  /** Espace au-dessus de la ligne de pied, en px. Absent = 8. */
  metaGap: Gap.optional(),
  /** Espace au-dessus du lien de lecture, en px. Absent = 10. */
  ctaGap: Gap.optional(),
  /** Écart entre la vignette et le texte en disposition `side`, en px. Absent = 14. */
  sideGap: Gap.optional(),
  /** `false` = l'image n'est pas cliquable. Absent = l'image mène à l'article. */
  imageLink: z.boolean().optional(),
  /**
   * Bouton de lecture (forme `button`, le défaut) : fond, texte, graisse, marges, rayon — le jeu
   * commun des boutons de carte. `ctaSize` n'est pas repris ici : l'article l'avait déjà (mêmes
   * bornes), et il vaut désormais pour les DEUX formes du lien de lecture.
   * `ctaWeight` vaut aussi pour la forme `link` (absent = 700).
   */
  ctaBackground: cardButtonLook.ctaBackground,
  ctaTextColor: cardButtonLook.ctaTextColor,
  ctaWeight: cardButtonLook.ctaWeight,
  ctaPadding: cardButtonLook.ctaPadding,
  ctaRadius: cardButtonLook.ctaRadius,
};

export const ArticleBlock = z
  .object({
    ...blockBase,
    type: z.literal("article"),
    /** Présente uniquement sur un bloc importé. Un article tapé à la main n'en a pas. */
    source: BlockSource.optional(),
    title: z.string().max(200),
    /** Texte brut : les sauts de ligne deviennent des `<br>`, aucun HTML n'est accepté. */
    excerpt: z.string().max(1000),
    imageSrc: ImageSrc.optional(),
    /** Même contrat que `ImageBlock.alt` : la clé existe toujours, vide bloque la publication. */
    imageAlt: z.string().max(300),
    href: Href,
    ctaLabel: z.string().max(MAX_BUTTON_LABEL).optional(),
    /** `side` = image à gauche du texte sur desktop, empilé sous 600px via media query. */
    layout: z.enum(["stacked", "side"]).default("stacked"),
    /**
     * Largeur de la vignette en % de la carte, en disposition `side`. Absente = 38 %.
     * Les trois maquettes demandent trois valeurs différentes ; une constante en servait une.
     */
    imageWidthPct: z.number().int().min(15).max(60).optional(),

    /* --- Surtitre, ligne de pied et typographie du titre ------------------------------------ *
     * Les trois maquettes de marque posent un surtitre au-dessus du titre (« Noticias · 13:50 »,
     * « Opinion ») et une ligne de pied sous le chapeau (« Michael Kenrick · 27 comments »,
     * « 15:29 »). Sans ces deux lignes, un article natif ne peut pas rendre la maquette — c'est
     * exactement ce qui manquait pour que le châssis soit fidèle. */

    /** Surtitre. Absent ou vide = la ligne n'est pas émise. */
    kicker: z.string().max(120).optional(),
    kickerColor: HexColor.optional(),
    kickerSize: z.number().int().min(8).max(40).optional(),
    /**
     * Fin du surtitre, dans SA couleur — l'heure en rouge de Northwind Sports, après la catégorie.
     * Même raison que `metaAccent` : une chaîne ne porte pas deux couleurs sans balisage, et le
     * balisage dans un champ est exactement ce que ce chantier a supprimé du châssis.
     */
    kickerAccent: z.string().max(80).optional(),
    kickerAccentColor: HexColor.optional(),
    /** Police du surtitre. Absente = celle du bloc — trois polices cohabitent dans une carte. */
    kickerFont: z.string().min(1).max(200).optional(),

    /** Ligne de pied, sous le chapeau. Absente ou vide = pas de ligne. */
    meta: z.string().max(200).optional(),
    /**
     * Fin de la ligne de pied, dans SA couleur — « 27 comments » en bleu chez Harbor Tech, l'heure
     * en rouge chez Northwind Sports. Séparé de `meta` parce qu'une seule chaîne ne peut pas porter deux
     * couleurs sans HTML, et que le HTML dans un champ est précisément ce qu'on a supprimé.
     */
    metaAccent: z.string().max(80).optional(),
    metaAccentColor: HexColor.optional(),
    metaColor: HexColor.optional(),
    metaSize: z.number().int().min(8).max(40).optional(),

    titleSize: z.number().int().min(8).max(72).optional(),
    titleFont: z.string().min(1).max(200).optional(),
    titleColor: HexColor.optional(),
    titleWeight: z.enum(["300", "400", "500", "600", "700", "800", "900"]).optional(),
    /**
     * `true` = le titre est cliquable, comme dans les trois maquettes. Absent = `<div>` nu, le
     * rendu historique — c'est ce qui garde les 18 autres templates publiés inchangés.
     *
     * ⚠️ Sans image et sans lien de lecture, un titre non cliquable laisse la carte SANS aucun
     * lien : le pré-vol le sait, et c'est cette clé qui le répare pour de bon.
     */
    titleLink: z.boolean().optional(),
    /**
     * Interligne du titre, en multiple de sa taille. Absent = 1.3.
     *
     * ⛔ Pas dérivable de la taille : les six titres des maquettes vont de 17/21 (1,24) à 32/34
     * (1,06) sans monotonie. Une règle calculée serait fausse cinq fois sur six.
     */
    titleLineHeight: z.number().min(0.9).max(2.4).optional(),

    /**
     * `button` (défaut) = le bouton actuel · `link` = lien texte souligné, comme le « Leer la
     * nota » de Copper Kettle · `none` = AUCUN lien de lecture n'est émis.
     *
     * ⛔ `none` est le seul moyen de dire « cette carte n'a pas de lien de lecture » : un libellé
     * vide serait rempli par le défaut de langue au dépliage (`withDefaultCta`), et l'article
     * partirait avec un bouton que la maquette n'a pas. Les brèves de Copper Kettle sont exactement
     * ce cas — la vignette et le titre portent déjà le lien.
     */
    ctaStyle: z.enum(["button", "link", "none"]).optional(),
    /** Police du lien de lecture. Absente = celle du bloc. */
    ctaFont: z.string().min(1).max(200).optional(),
    /**
     * Épaisseur du soulignement de `ctaStyle:"link"`. Absente = souligné ordinaire.
     *
     * ⛔ Au-delà de 1, ce n'est plus `text-decoration` mais un `border-bottom` : c'est la seule
     * façon d'obtenir le filet de 2px du « Leer la nota » de Copper Kettle, et le seul rendu qui
     * tient sous Outlook.
     */
    ctaUnderline: z.number().int().min(0).max(4).optional(),
    /* Le `style` du bloc sert au SURTITRE ; le lien de lecture a donc besoin du sien. */
    ctaColor: HexColor.optional(),
    ctaSize: z.number().int().min(8).max(40).optional(),
    ctaLetterSpacing: z.number().min(-2).max(12).optional(),
    ctaTransform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(),
    ...articleCardLook,
  })
  .strict();

/**
 * Filets d'un titre de section — voir `SectionTitleBlock.rule`. Déclarés ici parce que le
 * `midSection` d'un flux décrit le même bloc et doit accepter exactement les mêmes valeurs.
 */
export const SECTION_RULES = ["after", "under", "none", "left", "before", "both"] as const;

/**
 * Mises en page de l'encart (`CalloutBlock.layout`), portées des maquettes du 23/09/2026
 * (`C:/tmp/nf-blocks-design/tools/build.py`) : poster = Affiche (et Affiche centrée), player =
 * Lecteur, cover = Pochette, wave = Onde, gallery = Mosaïque, strip = Bandeau, ticket = Ticket.
 * « Duo » n'en est pas une : il se compose de deux rows de callouts `poster`.
 */
export const CALLOUT_LAYOUTS = ["poster", "player", "cover", "wave", "gallery", "strip", "ticket"] as const;
export type CalloutLayout = (typeof CALLOUT_LAYOUTS)[number];

/**
 * Les défauts d'une mise en page que l'auteur peut surcharger — UNE source, lue par le compilateur
 * (`compile/callout-layouts.ts`) ET par l'inspecteur, qui les affiche en grisé. Une copie de chaque
 * côté finirait par annoncer une hauteur que l'e-mail n'a pas.
 * `minHeight` = hauteur RENDUE de la zone photo sur les captures des maquettes ; `progress` = part jouée.
 */
export const CALLOUT_LAYOUT_DEFAULTS: Readonly<
  Record<CalloutLayout, { minHeight?: number; contentVAlign?: "top" | "middle" | "bottom"; progress?: number }>
> = {
  poster: { minHeight: 360, contentVAlign: "middle" },
  player: { minHeight: 280, progress: 36 },
  cover: { minHeight: 224 },
  wave: { progress: 42 },
  gallery: {},
  strip: { minHeight: 130, contentVAlign: "middle" },
  ticket: { minHeight: 320, contentVAlign: "bottom" },
};

/* ------------------------------------------------------------------ *
 * Flux d'articles — un bloc qui porte une REQUÊTE, pas un contenu
 * ------------------------------------------------------------------ */

/**
 * Un article retenu par un flux, réduit à ce qu'un bloc article a besoin de savoir.
 *
 * ⚠️ La vignette est l'URL DISTANTE, telle que la source la sert. Contrairement à l'import manuel,
 * elle n'est pas réhébergée : la résolution a lieu 90 min avant l'envoi, et rapatrier cinq images
 * dans ce laps de temps ajouterait un point de panne juste avant le départ. Contrepartie assumée :
 * si la source retire l'image, l'email affichera un trou — c'est le prix du contenu du jour.
 */
export const FeedItem = z
  .object({
    postId: z.string().max(40),
    title: z.string().max(200),
    excerpt: z.string().max(1000),
    href: Href,
    imageSrc: ImageSrc.optional(),
    /** Vide = vignette DÉCORATIVE, ce que WCAG demande à côté d'un titre-lien qui la nomme. */
    imageAlt: z.string().max(300).default(""),
    publishedAt: z.string().max(40).optional(),
    /**
     * Nom de la catégorie WordPress — « Noticias », « Destacadas ». Facultatif : toutes les
     * sources ne l'exposent pas, et un flux sans catégorie doit rester publiable.
     *
     * ⛔ Ne JAMAIS la remplacer par un libellé fixe quand elle manque : les deux catégories
     * distinctes de la maquette Copper Kettle prouvent que c'est une donnée, pas une décoration.
     * Une valeur inventée serait indiscernable d'une vraie.
     */
    category: z.string().max(80).optional(),
  })
  .strict();
export type FeedItem = z.infer<typeof FeedItem>;

/**
 * BLOC FLUX — la seule façon d'avoir une newsletter récurrente qui ne se périme pas.
 *
 * ⛔ CE QU'IL CONTIENT, ET CE QU'IL NE CONTIENT PAS. Il porte une REQUÊTE (source, catégories,
 * étiquettes, combien, plancher) et un APERÇU. L'aperçu ne part JAMAIS : il sert à l'écran de
 * l'éditeur et au test. Les articles réellement envoyés sont résolus 90 min avant chaque échéance
 * — c'est tout l'intérêt. Confondre les deux enverrait la newsletter de la semaine dernière, le
 * défaut exact que ce bloc existe pour tuer.
 *
 * ⛔ `minCount` N'EST PAS DÉCORATIF. Le soir où la catégorie n'a rien produit, la série a le choix
 * entre envoyer un email d'un seul article et se taire. Un plancher rend ce choix explicite et
 * VISIBLE : sous le plancher, l'occurrence est retenue avec sa raison, jamais annulée en silence.
 *
 * ⚠️ `dedupeDays` interagit avec `minCount` : exclure ce qui est déjà parti FAIT baisser le compte,
 * donc le plancher se déclenchera pour de vrai. C'est voulu — une série qui se répète tous les
 * soirs ne se remarque pas, une série qui se tait se remarque.
 */
/**
 * L'APPARENCE d'une carte d'article, sans son contenu. Sert DEUX fois sur un flux : `card` pour
 * les brèves, `lead` pour la une. Les mêmes clés que sur un bloc `article` écrit à la main —
 * `toArticle` les étale telles quelles, il n'y a donc pas de second vocabulaire à tenir.
 */
export const ArticleLook = z
  .object({
    layout: z.enum(["stacked", "side"]).optional(),
    imageWidthPct: z.number().int().min(15).max(60).optional(),
    /**
     * D'où vient le TEXTE du surtitre :
     * `none` (défaut) · `category` = la catégorie de l'article · `time` = son heure ·
     * `category-time` = « Noticias · 13:50 » · `text` = `kickerText`, un libellé fixe — le
     * « Destacada » de la une, qui n'est pas une catégorie mais une place dans l'édition.
     *
     * ⛔ Une donnée absente ne se remplace jamais : sans catégorie, `category` n'émet rien, et
     * `category-time` n'émet que l'heure. Le séparateur ne survit pas seul.
     */
    kickerMode: z.enum(["none", "category", "time", "category-time", "text"]).optional(),
    kickerText: z.string().max(120).optional(),
    kickerAccentColor: HexColor.optional(),
    /** Ligne de pied : `none` (défaut) ou `time` = l'heure de publication, seule et en accent. */
    metaMode: z.enum(["none", "time"]).optional(),
    ctaLabel: z.string().max(MAX_BUTTON_LABEL).optional(),
    ctaStyle: z.enum(["button", "link", "none"]).optional(),
    ctaUnderline: z.number().int().min(0).max(4).optional(),
    ctaFont: z.string().min(1).max(200).optional(),
    kickerFont: z.string().min(1).max(200).optional(),
    ctaColor: HexColor.optional(),
    ctaSize: z.number().int().min(8).max(40).optional(),
    ctaLetterSpacing: z.number().min(-2).max(12).optional(),
    ctaTransform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(),
    kickerColor: HexColor.optional(),
    kickerSize: z.number().int().min(8).max(40).optional(),
    titleSize: z.number().int().min(8).max(72).optional(),
    titleFont: z.string().min(1).max(200).optional(),
    titleColor: HexColor.optional(),
    titleWeight: z.enum(["300", "400", "500", "600", "700", "800", "900"]).optional(),
    titleLineHeight: z.number().min(0.9).max(2.4).optional(),
    titleLink: z.boolean().optional(),
    metaColor: HexColor.optional(),
    metaSize: z.number().int().min(8).max(40).optional(),
    metaAccentColor: HexColor.optional(),
    /** Style de la carte : c'est lui qui porte la taille et la couleur du CHAPEAU. */
    style: BoxStyle.optional(),
    ...articleCardLook,
  })
  .strict();
export type ArticleLook = z.infer<typeof ArticleLook>;

export const ArticleFeedBlock = z
  .object({
    ...blockBase,
    type: z.literal("article-feed"),
    /** Id de la ligne `wp_source`. Sans lui le bloc ne sait pas où retourner chercher. */
    sourceId: z.string().min(1).max(64),
    sourceLabel: z.string().max(120).default(""),
    /** Ids de catégories WordPress. Vide = toute la source. */
    categories: z.array(z.number().int().nonnegative()).max(10).default([]),
    /** Noms lisibles, pour afficher la règle sans requêter WordPress. */
    categoryNames: z.array(z.string().max(80)).max(10).default([]),
    tags: z.array(z.number().int().nonnegative()).max(10).default([]),
    tagNames: z.array(z.string().max(80)).max(10).default([]),
    count: z.number().int().min(1).max(12).default(5),
    minCount: z.number().int().min(1).max(12).default(3),
    /** Fenêtre d'anti-répétition, en jours. 0 = on assume la répétition. */
    dedupeDays: z.number().int().min(0).max(60).default(14),
    /**
     * Comment choisir les `count` articles parmi ceux que la source rend.
     *
     * `date` (défaut) : les plus récents, dans l'ordre où la source les sert.
     * `views` : les plus vus sur la fenêtre de mesure, d'après l'entrepôt GA4.
     *
     * ⛔ LE `.default()` N'EST PAS COSMÉTIQUE. Le bloc est `.strict()` et les `template_version`
     * déjà enregistrés n'ont pas ce champ : sans défaut, ils cesseraient TOUS de se relire — un
     * modèle enregistré hier deviendrait illisible aujourd'hui, sans migration possible côté auteur.
     *
     * ⚠️ `views` classe sur une fenêtre qui s'arrête à J−2 (l'entrepôt n'a pas encore les deux
     * derniers jours). Les articles publiés depuis 48 h ne sont donc pas classables — ils existent,
     * mais aucune mesure ne les concerne encore. C'est pourquoi ce mode convient à un récapitulatif
     * périodique et PAS à une lettre quotidienne : cf. `orderFeedByViews` dans `@nf/wp`.
     */
    /**
     * `mixed` comble le trou de 48 h de l'entrepôt : moitié plus lus sur la période mesurable,
     * moitié plus récents sur les deux jours aveugles. Ajouté APRÈS `date`/`views`, sans toucher
     * au défaut — un modèle déjà publié se relit à l'identique.
     */
    orderby: z.enum(["date", "views", "mixed"]).default("date"),
    /**
     * SUR QUELLE PÉRIODE classer, quand `orderby` vaut `views` ou `mixed` (où elle ne borne que la
     * moitié « les plus lus » — l'autre vit dans les 48 h qui suivent). Sans effet en mode `date`.
     *
     * `"cadence"` (défaut) : la période suit l'écart entre deux envois de la campagne — une
     * hebdomadaire classe sept jours, une campagne du lundi et du vendredi classe quatre jours puis
     * trois. Un nombre : une durée fixe, en jours.
     *
     * ⛔ UNE RÈGLE, PAS UNE DURÉE, ET C'EST LE POINT ENTIER. Un modèle est réutilisable par
     * PLUSIEURS campagnes (`campaign.template_version_id` est une clé étrangère nullable et non
     * unique), et c'est déjà le cas en production : « Quartz Tips — Resumo da Semana » v1 sert à la
     * fois `Resumo da rodada — domingo` et `Friday NL TW`. Écrire « 7 jours » dans le modèle
     * donnerait donc la même période à deux cadences différentes — un chiffre juste pour l'une,
     * faux pour l'autre, et aucun écran ne le dirait. La valeur se calcule à la résolution, où la
     * campagne est connue.
     *
     * ⛔ LE `.default()` N'EST PAS COSMÉTIQUE — même raison que pour `orderby` : le bloc est
     * `.strict()`, et les `template_version` déjà enregistrés n'ont pas ce champ.
     *
     * ⚠️ Le plafond de 90 jours n'est pas prudentiel : au-delà, le pool de la fenêtre dépasse ce
     * qu'une récolte peut rapatrier chez les sources qui publient 40 à 50 articles par jour, et le
     * classement ne porterait plus que sur la partie récente de la période annoncée.
     */
    viewsWindow: z.union([z.literal("cadence"), z.number().int().min(1).max(90)]).default("cadence"),
    layout: z.enum(["stacked", "side"]).default("stacked"),
    ctaLabel: z.string().max(MAX_BUTTON_LABEL).optional(),
    /**
     * Forme du lien de lecture de TOUTES les cartes du flux — `none` retire le lien de lecture sans
     * avoir à créer un look. Un `ctaStyle` posé sur `lead` ou `card` l'emporte pour ses cartes.
     * Absent = le défaut des cartes (bouton).
     */
    ctaStyle: z.enum(["button", "link", "none"]).optional(),

    /* --- Mise en page « une + brèves » ------------------------------------------------------ *
     * Les trois maquettes ouvrent sur UN article en grand puis enchaînent des brèves à vignette.
     * Sans ça, un flux rend N cartes identiques : la hiérarchie éditoriale disparaît. */

    /**
     * Nombre d'articles en une (look `lead`), avant les brèves. Absent = 0.
     * Porté de 1 à 3 le 22/09/2026 : 0 et 1 se rendent exactement comme avant.
     */
    leadCount: z.number().int().min(0).max(3).optional(),

    /** Affiche « catégorie · heure » au-dessus de chaque titre, quand l'article les porte. */
    showKicker: z.boolean().optional(),
    /**
     * Fuseau IANA de l'heure affichée. Absent = UTC.
     *
     * ⛔ Jamais l'heure du serveur : le worker tourne en UTC, l'abonné lit à Santiago ou à Rio.
     * Une heure sans fuseau explicite serait fausse pour tout le monde sauf par accident.
     */
    timeZone: z.string().max(64).optional(),
    /** Couleur de l'heure dans le surtitre, quand elle doit trancher sur la catégorie. */
    timeColor: HexColor.optional(),
    /** Format de l'heure affichée : `24h` (« 13:50 ») ou `12h` (« 1:50 PM »). Absent = 24h. */
    timeFormat: z.enum(["24h", "12h"]).optional(),
    /**
     * Ce qui sépare la catégorie de l'heure dans le surtitre « catégorie · heure ».
     * Absent = « · » entouré d'espaces insécables (la ligne ne se coupe jamais autour du point).
     */
    kickerSeparator: z.string().min(1).max(12).optional(),

    /** Apparence des brèves, puis de la une. Voir `ArticleLook`. */
    card: ArticleLook.optional(),
    lead: ArticleLook.optional(),
    /**
     * Titre de section inséré ENTRE la une et les brèves — « Más noticias », « Mais do dia ».
     * Posé après la DERNIÈRE une (`leadCount` 1 à 3) ; sans une, il n'y a pas de « entre », et le
     * titre n'est posé que si `showWithoutLead` le demande (il passe alors au-dessus des brèves).
     *
     * Décrit un bloc `section_title` : le dépliage en fabrique un vrai, rendu par le même code que
     * celui qu'un auteur pose à la main. Un second rendu de titre de section aurait divergé.
     */
    /**
     * Filet posé ENTRE deux brèves — jamais avant la première, jamais après la dernière, jamais
     * autour de la une. Absent = les cartes se suivent sans séparateur, comme aujourd'hui.
     */
    cardRule: z
      .object({
        color: HexColor.optional(),
        thickness: z.number().int().min(1).max(12).optional(),
        style: BoxStyle.optional(),
        /** Largeur du filet en % de la colonne. Absente = 100 (pleine largeur). */
        widthPct: z.number().int().min(10).max(100).optional(),
        /** Tracé du filet. Absent = plein. */
        lineStyle: LineStyle.optional(),
      })
      .strict()
      .optional(),
    midSection: z
      .object({
        label: z.string().min(1).max(120),
        rule: z.enum(SECTION_RULES).optional(),
        ruleColor: HexColor.optional(),
        ruleThickness: z.number().int().min(1).max(6).optional(),
        /** Écart entre le libellé et son filet, en px — voir `SectionTitleBlock.ruleGap`. */
        ruleGap: Gap.optional(),
        style: BoxStyle.optional(),
        /**
         * `true` = le titre est aussi posé quand le flux n'a PAS de une : il passe alors au-dessus de
         * la première carte. Absent = seulement entre la une et les brèves, comme avant.
         */
        showWithoutLead: z.boolean().optional(),
      })
      .strict()
      .optional(),

    /** APERÇU seulement — jamais ce qui part. Voir le commentaire du bloc. */
    previewItems: z.array(FeedItem).max(12).default([]),
    previewAt: z.string().max(40).optional(),
  })
  .strict();
export type ArticleFeedBlock = z.infer<typeof ArticleFeedBlock>;

/**
 * Titre de section : un libellé et un filet qui occupe la largeur restante SUR LA MÊME LIGNE DE
 * BASE. C'est précisément ce qu'un `divider` posé sous un `text` ne sait pas faire — `mj-divider`
 * sort seul dans sa cellule. Motif le plus répété des maquettes : 3 occurrences, 3 marques.
 *
 * Toute la typographie vient de `style` (BoxStyle) : le bloc ne porte que la géométrie du filet.
 */
export const SectionTitleBlock = z
  .object({
    ...blockBase,
    type: z.literal("section_title"),
    /** Clé toujours présente, vide bloque la publication — même contrat que `ImageBlock.alt`. */
    label: z.string().max(120),
    /**
     * `after` = filet à la suite du libellé · `under` = filet dessous · `none` = pas de filet ·
     * `left` = barre verticale collée à gauche du libellé (le « News » de Harbor Tech) ·
     * `before` = filet AVANT le libellé, sur sa ligne de base (le miroir de `after`, pour un titre
     * aligné à droite) · `both` = un filet de chaque côté (titre centré).
     * `before` et `both` ajoutés le 22/09/2026 : `after` restait à droite quel que soit l'alignement.
     */
    rule: z.enum(SECTION_RULES).default("after"),
    ruleColor: HexColor.optional(),
    ruleThickness: z.number().int().min(1).max(6).default(2),
    /**
     * Écart entre le libellé et son filet, en px. Absent = le défaut de chaque forme : 12 pour
     * `after`/`before`/`both`, 9 pour la barre `left`, 8 pour `under`.
     */
    ruleGap: Gap.optional(),
  })
  .strict();

/**
 * Encart d'appel : un aplat portant surtitre / titre / texte / bouton.
 *
 * `promo` ne pouvait PAS servir — mesuré sur son rendu : pas de surtitre, et `card()` y est appelé
 * sans fond et avec une bordure `theme.brandColor` codée en dur, alors que les encarts des trois
 * marques sont des aplats pleins.
 */
export const CalloutBlock = z
  .object({
    ...blockBase,
    type: z.literal("callout"),
    /** Surtitre. Vide = pas de surtitre (la ligne n'est pas émise). */
    kicker: z.string().max(80),
    kickerColor: HexColor.optional(),
    kickerSize: z.number().int().min(8).max(40).optional(),
    title: z.string().max(200),
    titleSize: z.number().int().min(8).max(72).optional(),
    /**
     * Police du titre ET du bouton. Absente = celle du bloc.
     *
     * Deux polices, parce que les trois maquettes de marque en posent deux : une police
     * d'affichage pour le titre, une police de lecture pour le paragraphe. Une seule par bloc —
     * la limite connue du bloc `article` — rendait les trois encarts faux.
     */
    titleFont: z.string().min(1).max(200).optional(),
    body: z.string().max(1000),
    bodyColor: HexColor.optional(),
    /** Police du paragraphe. Absente = celle du bloc. */
    bodyFont: z.string().min(1).max(200).optional(),
    /** Bouton facultatif. Un `ctaLabel` sans `href` est refusé à la publication : bouton mort. */
    href: Href.optional(),
    ctaLabel: z.string().max(MAX_BUTTON_LABEL).optional(),
    ctaBackground: HexColor.optional(),
    ctaTextColor: HexColor.optional(),
    /** Filet d'accent vertical à gauche. `0` = pas de filet (le défaut). */
    accentColor: HexColor.optional(),
    accentWidth: z.number().int().min(0).max(12).default(0),
    innerPadding: Spacing.optional(),

    /**
     * Vignette posée À DROITE du texte — l'encart « El partido del día » de Copper Kettle.
     * Absente = l'encart reste sur une seule colonne, comme aujourd'hui.
     */
    imageSrc: ImageSrc.optional(),
    /** Même contrat que partout : la clé existe dès qu'il y a une image, vide = décorative. */
    imageAlt: z.string().max(300).optional(),
    /** Largeur de la vignette en % de l'encart. Absente = 24 %. */
    imageWidthPct: z.number().int().min(10).max(60).optional(),

    /* --- Titre et bouton (22/09/2026). Absents = le rendu d'avant. --- */
    /** Couleur du titre. Absente = couleur du texte du bloc. */
    titleColor: HexColor.optional(),
    /** Graisse du titre. Absente = la graisse du bloc (`style.fontWeight`), sinon 700. */
    titleWeight: FontWeight.optional(),
    /** Interligne du titre. Absent = 1.25. */
    titleLineHeight: z.number().min(0.9).max(2.4).optional(),
    /** Police du bouton. Absente = celle du titre (`titleFont`), sinon celle du bloc. */
    ctaFont: z.string().min(1).max(200).optional(),
    /** Taille, graisse, marges et rayon du bouton — `ctaBackground`/`ctaTextColor` existent déjà. */
    ctaSize: cardButtonLook.ctaSize,
    ctaWeight: cardButtonLook.ctaWeight,
    ctaPadding: cardButtonLook.ctaPadding,
    ctaRadius: cardButtonLook.ctaRadius,

    /*
     * --- MISES EN PAGE (23/09/2026) : les 20 maquettes « émission » / « rejoindre une chaîne ». ---
     *
     * ⛔ TOUTES `.optional()`, AUCUN `.default()`. Un `.default()` ajouterait la clé à chaque callout
     * déjà en base au premier `EmailDoc.parse` : le document relu ne serait plus celui qui a été écrit,
     * et `layout` ABSENT doit rendre l'encart d'avant à l'octet près (`golden.test.ts`).
     * Chacune n'a d'effet QUE sous le `layout` qui s'en sert (`compile/callout-layouts.ts`) ; sans
     * `layout`, `calloutHtml` ne les lit pas. La couleur de repli des zones photo est
     * `style.backgroundColor` (déjà là) : c'est l'aplat que voient Outlook et tout client qui bloque
     * les images.
     */
    /** Composition de l'encart. Absente = le panneau d'avant (surtitre, titre, texte, bouton). */
    layout: z.enum(CALLOUT_LAYOUTS).optional(),
    /**
     * Photo de fond de la zone image (poster, player, cover, strip, ticket). Le voile est CUIT dans le
     * fichier (aucun voile CSS : Outlook et Gmail ne le rendraient pas). `ai://` refusé à la publication.
     */
    backgroundImage: ImageSrc.optional(),
    /** Cadrage horizontal de la photo. Absent = centré. `right` = le sujet à droite, le texte à gauche. */
    backgroundPosition: z.enum(["left", "center", "right"]).optional(),
    /**
     * Hauteur de la zone photo, en px — c'est aussi la hauteur de la VML d'Outlook, qui n'en calcule
     * aucune. Absente = la hauteur RENDUE de la maquette (poster 360, player 280, cover 224, strip 130,
     * ticket 320). ⚠️ Pas la hauteur écrite dans son CSS : Chrome ajoute les paddings de la cellule à
     * sa hauteur, et c'est la hauteur mesurée sur les captures de référence qui fait foi.
     */
    minHeight: z.number().int().min(40).max(800).optional(),
    /** Position verticale du texte sur la photo (poster, strip, ticket). Absente = celle de la maquette. */
    contentVAlign: z.enum(["top", "middle", "bottom"]).optional(),
    /** Surtitre : texte seul, précédé d'une pastille ronde (`dot`), ou dans une gélule (`pill`). Absent = texte seul. */
    kickerStyle: z.enum(["plain", "dot", "pill"]).optional(),
    /** Couleur du point (`dot`) ou fond de la gélule (`pill`). Absente = couleur de marque. */
    kickerAccent: HexColor.optional(),
    /** Fond du rond « ▶ » (player, cover) et du rond « + » (strip). Absent = fond du bouton. */
    playBackground: HexColor.optional(),
    /** Couleur du glyphe dans ce rond. Absente = texte du bouton. */
    playColor: HexColor.optional(),
    /** Part jouée, en % : barre du lecteur (absente = 36) et onde (absente = 42). */
    progress: z.number().int().min(0).max(100).optional(),
    /** Couleur de la part jouée (barre et onde). Absente = couleur de marque. */
    progressColor: HexColor.optional(),
    /** Couleur du reste de la barre et de l'onde. Absente = couleur atténuée du thème. */
    progressTrackColor: HexColor.optional(),
    /** Graine du dessin de l'onde : deux ondes voisines ne se ressemblent pas. Absente = 1. */
    waveSeed: z.number().min(0).max(10).optional(),
    /**
     * Second aplat : la souche du ticket, et la case de la photo quand la carte est claire (cover,
     * gallery) — c'est ce que l'abonné voit à la place de la photo bloquée. Absent = couleur de marque.
     */
    stubBackground: HexColor.optional(),
    /**
     * Texte posé sur ce second aplat : corps de la souche du ticket (absent = `bodyColor`, sinon texte
     * du bouton du thème) et alt des cases de galerie images bloquées (absent = texte du bouton).
     */
    stubTextColor: HexColor.optional(),
    /**
     * Grille façon profil Instagram (`gallery`) : 3 photos au plus, chacune avec son alt. Chaque case
     * mène au lien du bouton. `ai://` refusé à la publication.
     */
    gallery: z
      .array(z.object({ src: ImageSrc, alt: z.string().max(300) }).strict())
      .min(1)
      .max(3)
      .optional(),
    /** Bouton sur toute la largeur de sa zone. Absent = à sa largeur. */
    ctaFullWidth: z.boolean().optional(),
  })
  .strict();

export const ScoreboardRow = z
  .object({
    label: z.string().max(120),
    /** Chaîne, même raison que `OddsRow.value` : le bloc ne calcule rien et ne valide rien. */
    value: z.string().max(8),
    /** Passe la valeur en couleur d'accent (le score du jour, la cote mise en avant). */
    highlight: z.boolean().default(false),
  })
  .strict();
export type ScoreboardRow = z.infer<typeof ScoreboardRow>;

/**
 * Bandeau de résultat : 2 à 4 couples libellé/valeur sur un aplat.
 *
 * Comme les autres blocs sportifs, il ne sait pas ce qu'il affiche : que des chaînes saisies.
 * `odds_table` ne pouvait pas le remplacer — il fige la valeur à `max(12, fontSize - 1)`, soit
 * 14 px là où la maquette en demande 30, sans couleur par ligne ni surtitre.
 */
export const ScoreboardBlock = z
  .object({
    ...blockBase,
    type: z.literal("scoreboard"),
    kicker: z.string().max(80),
    kickerColor: HexColor.optional(),
    rows: z.array(ScoreboardRow).min(2).max(4),
    valueSize: z.number().int().min(8).max(72).optional(),

    /**
     * Pied du bandeau, sous un filet : un lien puis une note. « What we learned › — Thierno Barry
     * was the star of the show. » Les trois parties sont indépendantes : un pied peut n'être
     * qu'une note, ou n'être qu'un lien.
     */
    footerLabel: z.string().max(120).optional(),
    footerHref: Href.optional(),
    footerNote: z.string().max(300).optional(),
    footerColor: HexColor.optional(),

    /* --- Couleurs et géométrie (22/09/2026). Absentes = le rendu d'avant. --- */
    /** Libellés et valeurs d'une ligne ORDINAIRE. Absents = `theme.mutedColor`. */
    labelColor: HexColor.optional(),
    valueColor: HexColor.optional(),
    /** Ligne MISE EN AVANT : libellé (absent = couleur du texte), valeur (absente = `theme.brandColor`). */
    highlightLabelColor: HexColor.optional(),
    highlightValueColor: HexColor.optional(),
    /** Taille des libellés, en px. Absente = taille du bloc. */
    labelSize: TextSize.optional(),
    /** Taille du surtitre, en px. Absente = max(11, taille du bloc − 4). */
    kickerSize: TextSize.optional(),
    /** Marges intérieures du bandeau, côté par côté. Absentes = 16 px partout. */
    innerPadding: Spacing.optional(),
    /** Filet au-dessus du pied : couleur (absente = couleur de bordure), épaisseur (absente = 1 ; 0 = sans filet). */
    footerRuleColor: HexColor.optional(),
    footerRuleWidth: z.number().int().min(0).max(6).optional(),
    /** Couleur du lien du pied. Absente = couleur du texte. */
    footerLabelColor: HexColor.optional(),
  })
  .strict();

export const PromoBlock = z
  .object({
    ...blockBase,
    type: z.literal("promo"),
    headline: z.string().max(200),
    body: z.string().max(1000).optional(),
    /** Code promo, rendu en pavé monospace. */
    code: z.string().max(60).optional(),
    /** Mentions légales de l'offre — rendues en petit et en couleur atténuée, jamais masquées. */
    terms: z.string().max(1000).optional(),
    href: Href,
    ctaLabel: z.string().max(MAX_BUTTON_LABEL),

    /* --- Cadre, code et bouton (22/09/2026). Absents = le rendu d'avant. --- */
    /**
     * Cadre de la carte : couleur (absente = `theme.brandColor`), épaisseur (absente = 1 ; 0 = sans
     * cadre). Des clés propres : la bordure du `style` n'a jamais atteint ce cadre, et lui donner ce
     * sens changerait en silence les promos déjà publiées qui en portent une.
     */
    frameColor: HexColor.optional(),
    frameWidth: z.number().int().min(0).max(12).optional(),
    /** Marges intérieures de la carte, côté par côté. Absentes = 16 px partout. */
    innerPadding: Spacing.optional(),
    /** Écart vertical entre deux lignes de la carte, en px. Absent = 10. */
    rowGap: Gap.optional(),
    /** Pavé du code : texte (absent = couleur du texte), bordure (absente = `theme.brandColor`), tracé (absent = tirets), fond (absent = aucun). */
    codeColor: HexColor.optional(),
    codeBorderColor: HexColor.optional(),
    codeBorderStyle: LineStyle.optional(),
    codeBackground: HexColor.optional(),
    /** Taille du code, en px. Absente = taille du bloc + 1. */
    codeSize: TextSize.optional(),
    /** Police du code. Absente = Consolas, 'Courier New', monospace. */
    codeFont: z.string().min(1).max(200).optional(),
    ...cardButtonLook,
  })
  .strict();

/**
 * Footer légal — VERROUILLÉ, aucune prop éditable (D10 : un footer éditable = risque LGPD/GDPR).
 * Il compile vers le token `{{legal_footer_html}}` ; c'est le worker qui y injecte le footer
 * conforme de @nf/email, avec les liens unsub/prefs SIGNÉS du destinataire.
 *
 * ⚠️ PAS de `visibleIf` non plus : un footer conditionnel, c'est un envoi sans désabonnement pour
 * une partie de la liste. La seule condition acceptable est « toujours ».
 *
 * `legalTemplateId` choisit le CONTENU du pied (un `legal_footer_template` de la marque, 0065) ;
 * absent = le pied de l'édition. Le compilateur ne le lit pas : le jeton reste le même, c'est la
 * publication qui pose le choix sur la version, et la vue d'envoi qui le lit. Les liens de
 * désinscription, eux, restent générés par destinataire quel que soit le choix.
 * ⛔ `.optional()` obligatoire : le bloc est `.strict()`, et tous les documents en base l'ont sans.
 */
export const FooterLegalBlock = z
  .object({
    id: Id,
    type: z.literal("footer_legal"),
    legalTemplateId: z.uuid().optional(),
  })
  .strict();

export const Block = z.discriminatedUnion("type", [
  TextBlock,
  ImageBlock,
  ButtonBlock,
  DividerBlock,
  SpacerBlock,
  HtmlBlock,
  SocialBlock,
  MenuBlock,
  PickBlock,
  OddsTableBlock,
  StandingsBlock,
  ScoreboardBlock,
  ArticleBlock,
  ArticleFeedBlock,
  SectionTitleBlock,
  CalloutBlock,
  PromoBlock,
  FooterLegalBlock,
]);
export type Block = z.infer<typeof Block>;
export type TextBlock = z.infer<typeof TextBlock>;
export type ImageBlock = z.infer<typeof ImageBlock>;
export type ButtonBlock = z.infer<typeof ButtonBlock>;
export type DividerBlock = z.infer<typeof DividerBlock>;
export type SpacerBlock = z.infer<typeof SpacerBlock>;
export type HtmlBlock = z.infer<typeof HtmlBlock>;
export type SocialBlock = z.infer<typeof SocialBlock>;
export type MenuBlock = z.infer<typeof MenuBlock>;
export type PickBlock = z.infer<typeof PickBlock>;
export type OddsTableBlock = z.infer<typeof OddsTableBlock>;
export type StandingsBlock = z.infer<typeof StandingsBlock>;
export type ScoreboardBlock = z.infer<typeof ScoreboardBlock>;
export type SectionTitleBlock = z.infer<typeof SectionTitleBlock>;
export type CalloutBlock = z.infer<typeof CalloutBlock>;
export type ArticleBlock = z.infer<typeof ArticleBlock>;
export type PromoBlock = z.infer<typeof PromoBlock>;
export type FooterLegalBlock = z.infer<typeof FooterLegalBlock>;

/* ------------------------------------------------------------------ *
 * Column / Row
 * ------------------------------------------------------------------ */

export const Column = z
  .object({
    id: Id,
    /**
     * Largeur informative pour l'UI. Le compilateur, lui, dérive TOUJOURS la largeur de `layout`
     * (voir LAYOUT_WEIGHTS) : c'est la seule façon de garantir l'arithmétique des ghost tables.
     */
    widthPct: z.number().min(1).max(100).optional(),
    style: BoxStyle.optional(),
    visibleIf: VisibleIf.optional(),
    blocks: z.array(Block).max(100),
  })
  .strict();
export type Column = z.infer<typeof Column>;

export const Row = z
  .object({
    id: Id,
    layout: z.enum(ROW_LAYOUTS),
    style: BoxStyle.optional(),
    visibleIf: VisibleIf.optional(),
    columns: z.array(Column).min(1).max(4),
    // NOTE : pas de `reverseOnMobile` en v1. L'inversion mobile ne se fait proprement qu'en
    // flexbox, que le moteur Word d'Outlook ignore en silence — on n'expose pas une option qui
    // marcherait sur la moitié du parc seulement. À rouvrir avec un vrai test Litmus.
  })
  .strict()
  .superRefine((row, ctx) => {
    const expected = columnCount(row.layout);
    if (row.columns.length !== expected) {
      ctx.addIssue({
        code: "custom",
        message: `layout "${row.layout}" requires exactly ${expected} column(s), got ${row.columns.length}`,
        path: ["columns"],
      });
    }
  });
export type Row = z.infer<typeof Row>;

/* ------------------------------------------------------------------ *
 * Theme / Meta / Doc
 * ------------------------------------------------------------------ */

export const Theme = z
  .object({
    /** Fond de la page email (hors zone de contenu). */
    bodyBackground: HexColor.default("#F4F4F7"),
    contentBackground: HexColor.default(NEAR_WHITE),
    contentWidth: z.number().int().min(320).max(800).default(600),
    fontFamily: z.string().min(1).max(200).default("Arial, Helvetica, sans-serif"),
    fontSize: z.number().int().min(10).max(24).default(16),
    lineHeight: z.number().min(1).max(3).default(1.5),
    textColor: HexColor.default("#1A1A20"),
    mutedColor: HexColor.default("#6B6B76"),
    /**
     * ROSE DE MARQUE — #E11D48 et non #ff368d.
     *
     * Le rose clair d'origine donne 3,38:1 sur le fond de contenu, pour un minimum WCAG AA de 4,5:1 —
     * et il sert AUX DEUX ENDROITS qui portent du texte : les liens inline, et le texte blanc des
     * boutons posé dessus. Autrement dit, presque tout email produit avec le thème par défaut
     * échouait au contraste, et le pré-vol l'aurait signalé sur chacun d'eux jusqu'à ce que
     * l'avertissement devienne du bruit qu'on ignore.
     *
     * #E11D48 est la même famille de rose, déjà utilisée par la marque ailleurs, et mesure 4,66:1.
     * Ce n'est qu'un DÉFAUT : un template qui fixe explicitement sa couleur n'est pas touché, et les
     * versions déjà publiées ont leur HTML figé.
     */
    linkColor: HexColor.default("#E11D48"),
    brandColor: HexColor.default("#E11D48"),
    buttonTextColor: HexColor.default(NEAR_WHITE),
    borderColor: HexColor.default("#E9E9EF"),
    radius: z.number().int().min(0).max(48).default(8),
    /** Padding par défaut d'une row. */
    rowPadding: Spacing.default({ top: 0, right: 0, bottom: 0, left: 0 }),
    /** Padding par défaut d'un bloc. */
    blockPadding: Spacing.default({ top: 8, right: 24, bottom: 8, left: 24 }),
    /**
     * Polices web à charger dans l'email (`mj-font` -> `<link>` + `@import` dans le `<head>`).
     *
     * Sans ça, une `fontFamily` de marque n'est qu'un NOM : le client de messagerie ne trouve pas
     * la fonte et retombe en silence sur sa pile système. Mesuré le 28/08 : aucune des 29
     * `font-family` des maquettes n'était chargée nulle part — l'aperçu navigateur les avait, pas
     * l'abonné. Contrepartie connue : Gmail et Outlook desktop ignorent les polices distantes,
     * d'où l'obligation de garder une pile de repli dans chaque `fontFamily`.
     *
     * ⛔ PIÈGE MJML, mesuré : le `<link>` n'est émis QUE si la famille est effectivement nommée
     * dans une `fontFamily` du document. Déclarer « Archivo » sans qu'aucun bloc ne l'emploie ne
     * charge RIEN, sans le moindre avertissement — et le nom doit correspondre EXACTEMENT, à la
     * casse près. Un banc le vérifie dans les deux sens (`blocs-natifs.test.ts`).
     */
    webFonts: z
      .array(z.object({ family: z.string().min(1).max(120), href: z.string().min(1).max(500) }).strict())
      .max(4)
      .default([]),
    /** Overrides dark mode (facultatifs) — appliqués via @media prefers-color-scheme. */
    darkBodyBackground: HexColor.optional(),
    darkContentBackground: HexColor.optional(),
    darkTextColor: HexColor.optional(),

    /* --- Décisions du compilateur rendues réglables (22/09/2026). Absentes = le rendu d'avant. --- */

    /**
     * Presets du bloc texte, preset par preset : taille (px), graisse, interligne. Absents = h1
     * 28/700/1.25 · h2 22/700/1.3 · h3 18/600/1.35 · body taille du thème/400/1.55 · small 13/400/1.5.
     * Un `style` posé sur un bloc texte l'emporte toujours sur son preset.
     */
    textPresets: z
      .partialRecord(
        z.enum(TEXT_PRESETS),
        z
          .object({
            size: z.number().int().min(8).max(72).optional(),
            weight: FontWeight.optional(),
            lineHeight: z.number().min(1).max(3).optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * Thèmes que l'email déclare supporter (`color-scheme` + `supported-color-schemes`).
     *
     * ⛔ ABSENT = « light only » DEPUIS LE 23/09/2026 (avant : « light dark »). Exigence d'Alix : « que ce
     * soit en dark ou white mode ça doit être identique à notre template ». Le mot-clé `only` interdit à
     * l'agent utilisateur tout assombrissement forcé (CSS Color Adjustment 1, § color-scheme).
     * Mesuré le 23/09 sous Chrome avec l'assombrissement automatique forcé (le moteur de l'assombrissement
     * algorithmique des WebView Android) : un fond #FEFEFE reste #FEFEFE avec `light only` comme avec
     * `light dark`, mais devient #121212 avec `light` seul ou sans déclaration.
     *  - `light only` : clair, jamais recoloré par un client qui écoute la déclaration ;
     *  - `light dark` : l'email se dit capable du sombre — à réserver à une marque qui pose sa palette
     *    `dark*` ; ailleurs, le client peint en sombre tout ce qui n'a pas de couleur explicite ;
     *  - `light` : conservé pour les documents existants (0 en base le 23/09) ; ⚠️ n'empêche PAS
     *    l'assombrissement forcé, contrairement à ce que son libellé laissait croire.
     */
    colorScheme: z.enum(["light only", "light dark", "light"]).optional(),
    /**
     * `false` = ne pas poser la règle `a { text-decoration: none; }` dans le head (les liens gardent
     * le soulignement du client). Absent = règle posée.
     */
    resetLinkDecoration: z.boolean().optional(),
    /** Largeur d'écran (px) sous laquelle s'appliquent les réglages mobiles et le masquage mobile. Absente = 600. */
    mobileBreakpoint: z.number().int().min(320).max(800).optional(),
    /**
     * Largeur d'écran (px) à partir de laquelle les colonnes (rangées multi-colonnes et vignettes
     * d'article) se posent côte à côte ; en dessous elles s'empilent. Absente = 480, le défaut de MJML.
     */
    columnBreakpoint: z.number().int().min(320).max(800).optional(),
    /**
     * `false` = ne pas épingler le fond des bandeaux sans texte (rangée d'images, bloc image, filet ou
     * espaceur coloré) contre le thème sombre des clients mail (voir `pinClass`). Absent = épinglés.
     * Le nom date du 22/09, quand seuls les bandeaux SOMBRES l'étaient ; il est gardé pour les documents.
     */
    pinDarkRows: z.boolean().optional(),
    /**
     * `false` = laisser les `#ffffff` / `#000000` purs tels quels, y compris dans les blocs HTML.
     * Absent = remplacés par le fond du contenu et par #0E0E0E (anti-inversion du thème sombre).
     */
    neutralizePureColors: z.boolean().optional(),

    /* --- Styles globaux de l'e-mail (24/09/2026, feature 5). Absents = le rendu d'avant. --- */

    /**
     * Couleur des TITRES : presets h1-h3 du bloc texte, titre de section, titre d'article (et des
     * cartes d'un flux), titre d'encart. Absente = `textColor`.
     * ⛔ Elle se glisse ENTRE le thème et le reste de la cascade : une couleur de texte posée sur la
     * rangée, la colonne ou le bloc l'emporte toujours (un bandeau sombre garde son titre clair), et
     * la couleur de titre propre au bloc (`titleColor`) aussi.
     */
    headingColor: HexColor.optional(),
    /**
     * Police des mêmes titres. Absente = `fontFamily`. Même place dans la cascade que `headingColor`.
     * Le bouton d'un encart NE la suit PAS (il suit `ctaFont`, puis le `titleFont` du bloc).
     */
    headingFont: z.string().min(1).max(200).optional(),
  })
  .strict();
export type Theme = z.infer<typeof Theme>;

export const Meta = z
  .object({
    subject: z.string().max(200).default(""),
    preheader: z.string().max(200).default(""),
    /** Slug de la marque (voir @nf/config `AssetSlug`). Non contraint ici pour éviter un couplage dur. */
    assetSlug: z.string().min(1).max(64),
    /** Locale BCP-47 de l'édition (kit conformité : le footer suit cette langue). */
    locale: z.string().min(2).max(12).default("en"),

    /* --- Pointeurs vers l'en-tête et le pied de marque (`newsletter.brand_partial`, 0064) ----- *
     *
     * Le document ne stocke PAS les rows du partial, seulement son id : les rows sont résolues à la
     * COMPILATION (voir `applyBrandPartials`). Corriger un en-tête et republier suffit donc à le
     * changer partout ; une copie dans chaque document aurait exigé de rouvrir chaque modèle.
     *
     * ⛔ `.optional()` N'EST PAS UN CONFORT. `Meta` est `.strict()` : une clé nouvelle NON optionnelle
     * ferait échouer le parse de TOUS les `template_version.doc` déjà en base — c'est-à-dire de tous
     * les documents existants, d'un coup, sans migration possible côté auteur. */
    headerPartialId: z.uuid().optional(),
    footerPartialId: z.uuid().optional(),

    /* --- Ce que le compilateur décidait seul (22/09/2026). Tout `.optional()`, même raison que
     * ci-dessus ; absent = le rendu d'avant. */

    /** Titre du document HTML (`<title>`, onglet d'un client web). Absent = l'objet (`subject`). Vide = pas de `<title>`. */
    htmlTitle: z.string().max(200).optional(),
    /** Sens d'écriture déclaré sur `<html dir>`. Absent = `auto`. */
    dir: z.enum(["auto", "ltr", "rtl"]).optional(),
    /**
     * Libellé du lien de lecture posé sur tout article qui n'en a pas (carte de flux ou bloc écrit à
     * la main). Absent = le libellé de la langue (`defaultArticleCta`, « Leer la nota »…).
     */
    defaultCtaLabel: z.string().max(MAX_BUTTON_LABEL).optional(),
    /**
     * Ce qu'affiche `{{first_name}}` quand l'abonné n'a pas de prénom. Absent = le repli de la langue
     * du modèle (`defaultFirstName` : « there », « amigo »…).
     *
     * ⛔ Les caractères `{ } | < > "` sont refusés : le repli est écrit DANS le jeton du shell
     * (`{{first_name|…}}`), dont ils casseraient la grammaire ou le HTML avant hydratation.
     */
    firstNameFallback: z
      .string()
      .min(1)
      .max(40)
      .refine((v) => v.trim() !== "" && !/[{}|<>"]/.test(v), 'use plain words — { } | < > " are not allowed')
      .optional(),
    /**
     * VERSION TEXTE BRUT (la partie `text/plain`, générée depuis le document). Absente = le rendu
     * d'avant : le preheader, un filet de 40 tirets, puis les blocs.
     */
    plainText: z
      .object({
        /** Ligne posée tout en haut de la version texte. Absente = rien. */
        header: z.string().max(300).optional(),
        /** `false` = ne pas recopier le preheader (et son filet) en tête. Absent = recopié. */
        includePreheader: z.boolean().optional(),
        /** Filet sous le preheader et à la place de chaque séparateur. Absent = 40 tirets. */
        rule: z.string().min(1).max(80).optional(),
      })
      .strict()
      .optional(),
    /**
     * Le STYLE de chacun des trois jetons de date (`{{edition_date}}`, `{{edition_date_short}}`,
     * `{{weekday}}`). Absent = les formats d'avant (`DEFAULT_DATE_FORMATS`).
     *
     * ⛔ La liste des styles vit dans `@nf/email/dates`, À CÔTÉ de la fonction qui les formate au
     * moment de l'envoi : une seconde liste ici finirait par proposer un style que le worker ignore.
     * Le choix voyage jusqu'au worker dans un marqueur du shell (`dateFormatsMarker`, posé par
     * `compileDoc`) — le worker ne voit jamais le document.
     */
    dateFormats: z
      .object({
        edition_date: z.enum(DATE_STYLES).optional(),
        edition_date_short: z.enum(DATE_STYLES).optional(),
        weekday: z.enum(DATE_STYLES).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Meta = z.infer<typeof Meta>;

/**
 * Plafond de rows d'un document. Nommé parce qu'il est désormais lu AILLEURS qu'ici : l'insertion
 * d'un en-tête et d'un pied de marque ajoute des rows à un document déjà parsé (`applyBrandPartials`),
 * et doit refuser de fabriquer un document que le schéma ne relirait plus.
 */
export const MAX_DOC_ROWS = 200;

export const EmailDoc = z
  .object({
    schema: z.literal(2),
    meta: Meta,
    theme: Theme.prefault({}),
    rows: z.array(Row).max(MAX_DOC_ROWS),
  })
  .strict();
export type EmailDoc = z.infer<typeof EmailDoc>;
/** Forme ACCEPTÉE en entrée (defaults non encore appliqués) — ce que produit l'IA ou le builder. */
export type EmailDocInput = z.input<typeof EmailDoc>;

/* ------------------------------------------------------------------ *
 * Désabonnement écrit à la main — refusé à la PUBLICATION
 *
 * Le pré-vol du builder le signale déjà, mais il ne vit que dans l'écran : un appel direct à
 * `POST /api/builder/templates/[id]/publish` passait à côté. La règle vit donc ICI, dans le
 * schéma, seul endroit que le serveur ne peut pas contourner.
 * ------------------------------------------------------------------ */

/** Href ABSOLU écrit à la main. Un merge tag, un chemin relatif ou un `mailto:` n'en sont pas. */
const isAbsoluteUrl = (href: string): boolean => /^\s*https?:\/\//i.test(href);

/** Séparateurs d'URL ramenés à des espaces : `/unsubscribe-now?x=1` doit se lire comme du texte. */
const normalizeForMatch = (s: string): string =>
  s.normalize("NFC").toLowerCase().replace(/%20/g, " ").replace(/[-_+./?&=:#]/g, " ");

/**
 * Vocabulaire de désabonnement — VOLONTAIREMENT PLUS ÉTROIT que celui du pré-vol.
 *
 * Le pré-vol penche large parce qu'un faux positif n'y coûte qu'une explication. Ici il REFUSE une
 * publication : on ne garde donc que les formes dont le sens est univoque, et on laisse tout le
 * reste (soupçons, tournures approchantes) à `collectWarnings`.
 */
const UNSUBSCRIBE_VOCABULARY: RegExp[] = [
  /\bunsubscribe\b/,
  /\bunsub\b/,
  /\bopt ?outs?\b/,
  /\bd[eé]sabonn/,
  /\bd[eé]sinscri/,
  /\bdescadastr/,
  /\bcancelar (a |sua )?(inscri|assinatura|suscrip)/,
  /\bdesuscri/,
  /\bdarse de baja\b/,
  /\babmeld/,
  /\babbestell/,
  /\bdisiscriv/,
  /\b(annulla|cancella) (l )?iscrizione\b/,
];

/**
 * Échappatoire de la page de préférences — le seul faux positif vraiment probable : une page de
 * gestion d'abonnement porte très souvent « unsubscribe » dans son URL, et c'est un lien
 * parfaitement légitime. Il redevient un simple avertissement, jamais un refus.
 */
const PREFERENCES_VOCABULARY: RegExp[] = [
  /\bpr[eé]f[eé]ren/,
  /\beinstellungen\b/,
  /\bmanage\b/,
  /\bgerenciar\b/,
  /\bgestion/,
];

interface DocLink {
  href: string;
  /** Libellé cliquable quand il existe — le vocabulaire peut n'apparaître que là. */
  label?: string;
  path: (string | number)[];
}

/** Extraction STRUCTURELLE des liens d'un bloc, avec leur chemin JSON exact. Aucune règle ici. */
function linksOfBlock(block: Block, path: (string | number)[]): DocLink[] {
  switch (block.type) {
    case "text":
      return block.paragraphs.flatMap((p, pi) =>
        p.spans.flatMap((span, si) =>
          span.href === undefined
            ? []
            : [{ href: span.href, label: span.text, path: [...path, "paragraphs", pi, "spans", si, "href"] }],
        ),
      );
    case "image":
      return block.href === undefined ? [] : [{ href: block.href, label: block.alt, path: [...path, "href"] }];
    case "button":
      return [{ href: block.href, label: block.label, path: [...path, "href"] }];
    case "menu":
    case "social":
      return block.items.map((item, ii) => ({
        href: item.href,
        label: item.label,
        path: [...path, "items", ii, "href"],
      }));
    case "pick":
      return block.href === undefined ? [] : [{ href: block.href, label: block.ctaLabel, path: [...path, "href"] }];
    case "article":
      // Le TITRE n'est pas cliquable (voir `articleHtml`) : seul le libellé du CTA est un libellé
      // de lien. L'y ajouter refuserait un article qui PARLE de désabonnement.
      return [{ href: block.href, label: block.ctaLabel, path: [...path, "href"] }];
    case "callout":
      return block.href === undefined ? [] : [{ href: block.href, label: block.ctaLabel, path: [...path, "href"] }];
    case "scoreboard":
      // Le pied du bandeau est un vrai lien cliquable : sans lui ici, il échappe au contrôle
      // https, au contrôle de désabonnement écrit à la main et au décompte de liens.
      return block.footerHref === undefined
        ? []
        : [{ href: block.footerHref, label: block.footerLabel, path: [...path, "footerHref"] }];
    case "promo":
      return [{ href: block.href, label: block.ctaLabel, path: [...path, "href"] }];
    default:
      return [];
  }
}

const HAND_WRITTEN_UNSUBSCRIBE_MESSAGE =
  "hand-written unsubscribe link — the platform injects that link itself, signed and unique to each recipient. " +
  "A URL typed here is unsigned: the opt-outs it collects are never attributed, which breaks unsubscribe tracking and consent compliance. " +
  "Remove it — the legal footer already carries the unsubscribe link.";

/**
 * Le cas NON AMBIGU, et lui seul : une URL absolue tapée à la main qui parle de désabonnement.
 * `{{unsubscribe_url}}` et `{{preferences_url}}` ne sont pas des URLs absolues — ils passent, et
 * c'est précisément le chemin qu'on veut voir emprunté.
 */
function isHandWrittenUnsubscribe(link: DocLink): boolean {
  if (!isAbsoluteUrl(link.href)) return false;
  const haystack = `${normalizeForMatch(link.href)} ${normalizeForMatch(link.label ?? "")}`;
  if (PREFERENCES_VOCABULARY.some((re) => re.test(haystack))) return false;
  return UNSUBSCRIBE_VOCABULARY.some((re) => re.test(haystack));
}

/**
 * Variante STRICTE exigée à la PUBLICATION : `alt` non vide sur chaque image, sujet renseigné.
 * Un brouillon incomplet reste sauvegardable et prévisualisable ; il n'est simplement pas publiable.
 */
export const EmailDocPublishable = EmailDoc.superRefine((doc, ctx) => {
  if (doc.meta.subject.trim() === "") {
    ctx.addIssue({ code: "custom", message: "subject is required to publish", path: ["meta", "subject"] });
  }
  eachBlock(doc, (block, path, row, column) => {
    // Un footer légal sous condition = des abonnés qui reçoivent un email sans lien de
    // désabonnement. Le bloc n'accepte pas `visibleIf`, mais sa row ou sa colonne, si.
    if (block.type === "footer_legal" && (row.visibleIf !== undefined || column.visibleIf !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "the legal footer cannot sit inside a conditional row or column — it must reach every recipient",
        path: [...path],
      });
    }
    for (const link of linksOfBlock(block, path)) {
      if (isHandWrittenUnsubscribe(link)) {
        ctx.addIssue({ code: "custom", message: HAND_WRITTEN_UNSUBSCRIBE_MESSAGE, path: link.path });
      }
    }
    // Un plancher au-dessus de la demande retiendrait TOUTES les échéances, y compris celles où la
    // source a fait son travail : la série ne partirait jamais, sans que rien n'ait échoué.
    // ⚠️ Vérifié ICI et pas dans le bloc : un `.superRefine()` sur un membre d'union discriminée
    // l'enveloppe et casse la lecture du discriminant.
    if (block.type === "article-feed" && block.minCount > block.count) {
      ctx.addIssue({
        code: "custom",
        message: "the minimum cannot exceed how many articles are requested",
        path: [...path, "minCount"],
      });
    }
    // Les trois blocs de châssis suivent le contrat d'`ImageBlock.alt` : la clé existe toujours,
    // le brouillon reste sauvegardable, et c'est la PUBLICATION qui exige un contenu.
    if (block.type === "section_title" && block.label.trim() === "") {
      ctx.addIssue({ code: "custom", message: "section title is required to publish", path: [...path, "label"] });
    }
    if (block.type === "callout") {
      // Une tuile de mise en page peut ne porter QUE son bouton (les deux tuiles du « Duo » : une
      // photo, un bouton pleine largeur). Elle n'est pas vide pour autant. Sans `layout`, la règle
      // d'avant reste entière : un panneau classique sans titre ni texte est un aplat muet.
      const boutonSeul =
        block.layout !== undefined && block.href !== undefined && (block.ctaLabel ?? "").trim() !== "";
      if (block.title.trim() === "" && block.body.trim() === "" && !boutonSeul) {
        ctx.addIssue({
          code: "custom",
          message: "a callout needs a title or a body to publish",
          path: [...path, "title"],
        });
      }
      // Un libellé sans destination = un bouton qui ne mène nulle part. Le compilateur n'en émet
      // pas (même garde que le CTA d'article) : sans cette règle, l'auteur verrait son bouton
      // disparaître à l'envoi sans qu'on le lui ait jamais dit.
      if (block.ctaLabel !== undefined && block.ctaLabel.trim() !== "" && block.href === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "this button has a label but no link — add a URL or clear the label",
          path: [...path, "href"],
        });
      }
      // ⛔ Mêmes sentinelles que l'image seule : publier `ai://…` en fond ou dans la grille enverrait
      // une case cassée à de vrais abonnés. Le brouillon, lui, reste sauvegardable.
      if (block.backgroundImage !== undefined && isPlaceholderSrc(block.backgroundImage)) {
        ctx.addIssue({
          code: "custom",
          message: "this background is still an AI placeholder — generate or upload the picture before publishing",
          path: [...path, "backgroundImage"],
        });
      }
      block.gallery?.forEach((tile, ti) => {
        if (isPlaceholderSrc(tile.src)) {
          ctx.addIssue({
            code: "custom",
            message: "this gallery picture is still an AI placeholder — generate or upload the picture before publishing",
            path: [...path, "gallery", ti, "src"],
          });
        }
      });
    }
    if (block.type === "scoreboard") {
      block.rows.forEach((r, ri) => {
        if (r.label.trim() === "" && r.value.trim() === "") {
          ctx.addIssue({ code: "custom", message: "fill this row or remove it", path: [...path, "rows", ri, "label"] });
        }
      });
    }
    if (block.type === "image" && block.alt.trim() === "") {
      ctx.addIssue({ code: "custom", message: "alt text is required to publish", path: [...path, "alt"] });
    }
    if (block.type === "image" && isPlaceholderSrc(block.src)) {
      ctx.addIssue({
        code: "custom",
        message: "this image is still an AI placeholder — generate or upload the picture before publishing",
        path: [...path, "src"],
      });
    }
    // ⛔ LA VIGNETTE D'UN ARTICLE N'OBÉIT PAS À LA MÊME RÈGLE QU'UNE IMAGE SEULE, et confondre les
    // deux rendait l'import WordPress inutilisable : cinq articles importés = cinq blocages, alors
    // que WordPress ne remplit `alt_text` que très rarement.
    // Une vignette collée au titre-lien qui la nomme est DÉCORATIVE : WCAG demande alors `alt=""`,
    // faute de quoi le lecteur d'écran annonce deux fois la même phrase. L'alt vide est donc ici la
    // BONNE valeur, pas un oubli — et on ne recopie surtout pas le titre dedans.
    // L'exigence subsiste quand RIEN ne nomme l'image : un bloc article sans titre laisse la
    // vignette muette, et là l'alt est la seule description disponible.
    if (block.type === "article" && block.imageSrc !== undefined) {
      if (block.imageAlt.trim() === "" && block.title.trim() === "") {
        ctx.addIssue({ code: "custom", message: "alt text is required to publish", path: [...path, "imageAlt"] });
      }
      if (isPlaceholderSrc(block.imageSrc)) {
        ctx.addIssue({
          code: "custom",
          message: "this image is still an AI placeholder — generate or upload the picture before publishing",
          path: [...path, "imageSrc"],
        });
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Helpers partagés
 * ------------------------------------------------------------------ */

/** Parcourt tous les blocs du document avec leur chemin JSON (rows/i/columns/j/blocks/k). */
export function eachBlock(
  doc: EmailDoc,
  visit: (block: Block, path: (string | number)[], row: Row, column: Column) => void,
): void {
  doc.rows.forEach((row, ri) => {
    row.columns.forEach((col, ci) => {
      col.blocks.forEach((block, bi) => {
        visit(block, ["rows", ri, "columns", ci, "blocks", bi], row, col);
      });
    });
  });
}

/** Identifiant court pour un nouveau row/column/block. */
export function newId(prefix = "b"): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Préfixe d'id des rows d'un FOOTER DE BIBLIOTHÈQUE, posé quand la bibliothèque les sert.
 *
 * Le document ne garde aucune trace d'un import (les rows sont des copies, `Row` refuse tout champ
 * inconnu) ; sans repère, la palette ne sait pas où finit le corps et ajoutait les blocs DANS le
 * footer importé. L'id porte donc l'indice. ⚠️ Un indice seulement, jamais une règle de sécurité ni
 * de rendu : une row dupliquée le perd, un footer composé à la main ne l'a jamais eu.
 */
export const IMPORTED_FOOTER_ROW_PREFIX = "ftr";

/**
 * Plafond de rows d'un en-tête ou d'un pied de MARQUE (20 est déjà très large pour un châssis).
 * Ici et pas dans la couche de données : le serveur le refuse (422), et l'éditeur doit l'appliquer
 * AVANT — un module client ne peut pas importer le module serveur qui le portait.
 */
export const MAX_BRAND_PARTIAL_ROWS = 20;

export function isImportedFooterRow(row: { id: string }): boolean {
  return row.id.startsWith(`${IMPORTED_FOOTER_ROW_PREFIX}_`);
}

/**
 * Copie d'une row avec des identifiants NEUFS (row, colonnes, blocs).
 *
 * ⛔ POURQUOI C'EST OBLIGATOIRE AVANT TOUTE RÉINSERTION. Les ids de rows sont HUMAINS et déjà
 * dupliqués entre modèles en production : `pf_head` existe à l'identique sur les quatre modèles
 * Copper Kettle. Réinjecter une row telle qu'elle est stockée pose donc un id déjà présent, et
 * l'échec est SILENCIEUX — le reducer du builder rend `null`, et la résolution de flux
 * (`expandFeedBlocks`, qui indexe ses résultats PAR id de bloc) servirait les articles d'un bloc à
 * un autre.
 *
 * `newId()` tire 4 caractères aléatoires derrière un horodatage : deux appels dans la même
 * milliseconde peuvent théoriquement tomber sur le même id. Le suffixe incrémental rend l'unicité
 * INTERNE à la copie certaine — c'est précisément ce que cette fonction promet à son appelant.
 */
export function withFreshRowIds(row: Row, rowPrefix = "row"): Row {
  const copy = structuredClone(row) as Row;
  let n = 0;
  const fresh = (prefix: string) => `${newId(prefix)}${(n++).toString(36)}`;

  copy.id = fresh(rowPrefix);
  for (const column of copy.columns) {
    column.id = fresh("col");
    for (const block of column.blocks) {
      block.id = fresh("blk");
    }
  }
  return copy;
}

/**
 * Cette row porte-t-elle le bloc de pied légal ?
 *
 * Sert des deux côtés de la même règle : refuser qu'un partial de marque en embarque un (il y aurait
 * alors DEUX sources pour la mention de désabonnement) et savoir OÙ s'insère le pied éditorial — juste
 * avant celle-ci, jamais à sa place.
 */
export function rowCarriesFooterLegal(row: Row): boolean {
  return row.columns.some((column) => column.blocks.some((block) => block.type === "footer_legal"));
}

/** Document vide valide — point de départ d'un nouveau template. */
export function emptyDoc(assetSlug: string, locale = "en"): EmailDoc {
  return EmailDoc.parse({
    schema: 2,
    meta: { subject: "", preheader: "", assetSlug, locale },
    theme: {},
    rows: [
      {
        id: newId("row"),
        layout: "1",
        columns: [{ id: newId("col"), blocks: [{ id: newId("blk"), type: "footer_legal" }] }],
      },
    ],
  });
}

/** Construit un bloc texte depuis du texte brut (une ligne = un paragraphe). Aucun HTML accepté. */
export function textBlock(plain: string, preset: TextPreset = "body"): TextBlock {
  const paragraphs = plain
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ spans: [{ text: line }] }));
  return TextBlock.parse({
    id: newId("txt"),
    type: "text",
    preset,
    paragraphs: paragraphs.length > 0 ? paragraphs : [{ spans: [{ text: "" }] }],
  });
}
