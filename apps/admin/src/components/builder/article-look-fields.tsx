"use client";

/**
 * APPARENCE D'UNE CARTE D'ARTICLE — un seul jeu de champs pour trois endroits.
 *
 * Le bloc `article` écrit à la main, la UNE d'un flux (`lead`) et ses BRÈVES (`card`) portent les
 * mêmes clés d'apparence (`ArticleLook` dans le schéma) : `toArticle` (`@nf/render/feed`) les étale
 * telles quelles sur un bloc article ordinaire. Trois panneaux écrits séparément auraient fini par
 * ne pas offrir les mêmes réglages — c'est exactement ce qui s'était produit : l'article manuel
 * n'exposait ni le style du lien de lecture ni les polices, et la une et les brèves n'exposaient
 * RIEN, alors que l'abonné recevait « Destacada », des liens soulignés et des brèves sans lien.
 * Règle d'Alix (22/09/2026) : tout ce que les abonnés reçoivent doit se régler dans le builder.
 *
 * ⛔ CHAQUE ÉCRITURE NOMME SA CLÉ EN CLAIR (`onPatch({ titleFont: … })`), jamais une clé calculée.
 * Le garde de couverture (`inspector-coverage.test.ts`) lit ce fichier et vérifie, clé du schéma par
 * clé du schéma, qu'un champ l'écrit : une clé calculée le rendrait aveugle.
 *
 * Lot du 22/09/2026 au soir : les réglages de carte que `articleHtml` posait EN DUR (interlignes et
 * graisse du chapeau, écarts entre les parties, image cliquable, bouton de lecture complet) et la
 * forme du lien de lecture posée sur le FLUX entier. Indication, bornes et défauts viennent du
 * manifeste `NEW_PROPS_2026_09_22` (`propSpec`).
 *
 * ⚠️ AUCUN HOOK dans ce fichier : les bancs appellent ces composants comme des fonctions pour
 * déclencher le `onChange` réel de chaque contrôle (le dépôt n'a pas de banc de rendu React).
 */
import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  ArticleBlock,
  ArticleFeedBlock,
  ArticleLook,
  MAX_BUTTON_LABEL,
  type BoxStyle,
  type Theme,
} from "@nf/render/schema";
import { defaultArticleCta } from "@nf/render/cta";
import { CheckboxInput, ColorInput, NumberInput, SectionTitle, SelectInput, TextInput } from "./fields";
import { CardButtonFields } from "./extra-fields";
import {
  ChoiceInput,
  Group,
  LINE_STYLE_LABELS,
  MiniBtn,
  Note,
  UseForAllTitles,
  WEIGHT_LABELS,
  overrides,
} from "./inspector-ui";
import {
  boundsOf,
  clampTo,
  enumOf,
  lengthOf,
  literalDefault,
  numberField,
  objectAt,
  propSpec,
  specBounds,
  type NumberBounds,
} from "./schema-bounds";
import type { FeedPart } from "./reducer";

/* ------------------------------------------------------------------ *
 * Bornes et énumérations — LUES dans le schéma (cf. `schema-bounds.ts`)
 * ------------------------------------------------------------------ */

const LOOK_NUMBERS = [
  "imageWidthPct",
  "kickerSize",
  "metaSize",
  "titleSize",
  "titleLineHeight",
  "ctaUnderline",
  "ctaSize",
  "ctaLetterSpacing",
] as const;
type LookNumber = (typeof LOOK_NUMBERS)[number];

const boundsMap = (object: Parameters<typeof boundsOf>[0]) =>
  Object.fromEntries(LOOK_NUMBERS.map((k) => [k, boundsOf(object, k)])) as Record<LookNumber, NumberBounds>;

/** L'article manuel et le look ont aujourd'hui les mêmes bornes — mais chacun lit LES SIENNES. */
const BOUNDS = { article: boundsMap(ArticleBlock), look: boundsMap(ArticleLook) };

const MID_SECTION = objectAt(ArticleFeedBlock, "midSection");
const CARD_RULE = objectAt(ArticleFeedBlock, "cardRule");
const MID_RULE_THICKNESS = boundsOf(MID_SECTION, "ruleThickness");
const MID_LABEL_MAX = lengthOf(MID_SECTION, "label").max;
const CARD_RULE_THICKNESS = boundsOf(CARD_RULE, "thickness");
const KICKER_TEXT_MAX = lengthOf(ArticleLook, "kickerText").max;

/** Libellés lisibles. Une valeur du schéma absente d'ici s'affiche sous son nom brut, jamais cachée. */
const LABELS: Record<string, Record<string, string>> = {
  ctaStyle: { button: "Button (default)", link: "Link — underlined text", none: "None — no read link" },
  // Sans « (default) » : sur un look ou sur le flux, le défaut n'est pas forcément le bouton.
  ctaStyleName: { button: "Button", link: "Link — underlined text", none: "None — no read link" },
  kickerMode: {
    none: "Nothing",
    category: "The article’s category",
    time: "Its publish time",
    "category-time": "Category · time",
    text: "A fixed label",
  },
  metaMode: { none: "Nothing", time: "Its publish time" },
  ctaTransform: { none: "As typed", uppercase: "UPPERCASE", lowercase: "lowercase", capitalize: "Capitalize" },
  titleWeight: {
    "300": "300 — light",
    "400": "400 — regular",
    "500": "500 — medium",
    "600": "600 — semibold",
    "700": "700 — bold (default)",
    "800": "800 — extrabold",
    "900": "900 — black",
  },
  layout: { stacked: "Stacked — image above the text", side: "Side by side — image left" },
  rule: {
    after: "After the label",
    under: "Under the label",
    none: "No rule",
    left: "Vertical bar, left of the label",
    before: "Before the label (right-aligned title)",
    both: "On both sides (centred title)",
  },
};

/** Les formes de filet d'un titre de section — partagées avec le bloc `section_title`, même rendu. */
export const SECTION_RULE_LABELS = LABELS.rule;

/** Écart libellé / filet quand `ruleGap` est absent — le défaut de CHAQUE forme (`sectionTitleHtml`). */
export const RULE_GAP_DEFAULT: Record<string, number> = { after: 12, before: 12, both: 12, left: 9, under: 8 };

/** Les écarts entre les parties d'une carte — regroupés et repliés : on les règle rarement. */
const GAP_KEYS = ["kickerGap", "imageGap", "excerptGap", "metaGap", "ctaGap", "sideGap"] as const;

/**
 * Les clés que compte le résumé (« defaults » / « N set ») de chaque sous-section d'apparence, dans
 * l'ordre de lecture de la carte. Chaque clé d'`ArticleLook` est comptée par UNE sous-section et une
 * seule — `style` l'est par « Card box & text » — : `inspector-groups-article.test.ts` le vérifie
 * contre le schéma, pour qu'un réglage ajouté au look ne soit jamais posé sans que son groupe le dise.
 */
export const LOOK_GROUP_KEYS = {
  kicker: ["kickerMode", "kickerText", "kickerFont", "kickerSize", "kickerColor", "kickerAccentColor"],
  image: ["layout", "imageWidthPct", "imageLink"],
  title: ["titleSize", "titleFont", "titleColor", "titleWeight", "titleLineHeight", "titleLink"],
  excerpt: ["excerptWeight", "excerptLineHeight"],
  meta: ["metaMode", "metaSize", "metaColor", "metaAccentColor"],
  readLink: [
    "ctaStyle",
    "ctaLabel",
    "ctaFont",
    "ctaSize",
    "ctaWeight",
    "ctaLetterSpacing",
    "ctaTransform",
    "ctaColor",
    "ctaUnderline",
    "ctaBackground",
    "ctaTextColor",
    "ctaPadding",
    "ctaRadius",
  ],
  spacing: GAP_KEYS,
} as const satisfies Record<string, readonly (keyof ArticleLook)[]>;

const labelled = (group: string, values: readonly string[]) =>
  values.map((v) => ({ value: v, label: LABELS[group]?.[v] ?? v }));

const CTA_STYLES = enumOf(ArticleLook, "ctaStyle");
const KICKER_MODES = enumOf(ArticleLook, "kickerMode");
const META_MODES = enumOf(ArticleLook, "metaMode");
const TRANSFORMS = enumOf(ArticleLook, "ctaTransform");
const WEIGHTS = enumOf(ArticleLook, "titleWeight");
const LAYOUTS = enumOf(ArticleLook, "layout");
const MID_RULES = enumOf(MID_SECTION, "rule");

export type CtaStyle = NonNullable<ArticleLook["ctaStyle"]>;
type KickerMode = NonNullable<ArticleLook["kickerMode"]>;
type MetaMode = NonNullable<ArticleLook["metaMode"]>;
type Transform = NonNullable<ArticleLook["ctaTransform"]>;
type Weight = NonNullable<ArticleLook["titleWeight"]>;
type Layout = NonNullable<ArticleLook["layout"]>;

/**
 * Les formes du lien de lecture, libellées (« Button (default) »…) : pour « Read link style — every
 * card » du flux, rangé depuis le 23/09/2026 dans [Read link] de `FeedCardFields` (`inspector.tsx`).
 */
export const CTA_STYLE_OPTIONS = labelled("ctaStyle", CTA_STYLES) as { value: CtaStyle; label: string }[];

/* ------------------------------------------------------------------ *
 * Polices : celles de la marque, puis des piles sûres
 * ------------------------------------------------------------------ */

/**
 * Piles « web-safe » : présentes sur à peu près tous les postes et toutes les messageries, chacune
 * terminée par une famille générique. Une police de marque passe par Style › Brand › Web fonts.
 */
export const WEB_SAFE_FONTS: readonly { value: string; label: string }[] = [
  { value: "Arial, Helvetica, sans-serif", label: "Arial" },
  { value: "Helvetica, Arial, sans-serif", label: "Helvetica" },
  { value: "Verdana, Geneva, sans-serif", label: "Verdana" },
  { value: "Tahoma, Verdana, sans-serif", label: "Tahoma" },
  { value: "'Trebuchet MS', Arial, sans-serif", label: "Trebuchet MS" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
  { value: "'Times New Roman', Times, serif", label: "Times New Roman" },
  { value: "'Courier New', Courier, monospace", label: "Courier New" },
];

/** Le premier nom d'une pile CSS, sans guillemets — ce qu'un humain appelle « la police ». */
export function firstFamily(stack: string): string {
  return (stack.split(",")[0] ?? stack).trim().replace(/^['"]|['"]$/g, "") || stack;
}

/**
 * Les piles proposées : la police du thème, chaque police web déclarée (posée devant la pile du
 * thème, qui sert de repli), les piles sûres, et la valeur COURANTE si elle n'est dans aucune.
 *
 * ⛔ LA VALEUR COURANTE RESTE DANS LA LISTE. Les modèles importés des maquettes portent des piles
 * écrites à la main (« 'Oswald', 'Arial Narrow', sans-serif ») : sans cette entrée, le `<select>`
 * afficherait la première option comme si c'était la police de la carte.
 *
 * ⚠️ Le nom de la police web est posé TEL QUEL : MJML n'émet son `<link>` que si le nom exact
 * figure dans une `font-family` du document (cf. `Theme.webFonts` dans le schéma).
 */
export function fontChoices(theme: Theme, current: string | undefined): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ value, label });
  };
  add(theme.fontFamily, `Brand: ${firstFamily(theme.fontFamily)}`);
  for (const font of theme.webFonts) {
    if (theme.fontFamily.includes(font.family)) continue;
    const name = /^[A-Za-z][A-Za-z0-9 -]*$/.test(font.family) ? font.family : `'${font.family.replace(/'/g, "")}'`;
    add(`${name}, ${theme.fontFamily}`, `Web font: ${font.family}`);
  }
  for (const f of WEB_SAFE_FONTS) add(f.value, f.label);
  if (current !== undefined && current.trim() !== "") add(current, `Custom: ${firstFamily(current)}`);
  return out;
}

export function FontInput({
  label,
  value,
  inherited,
  theme,
  onChange,
  hint,
  inheritedLabel = "Same as the card",
}: {
  label: string;
  value: string | undefined;
  /** La pile qui s'applique quand rien n'est choisi. */
  inherited: string;
  theme: Theme;
  onChange: (v: string | undefined) => void;
  hint?: string;
  /** D'où vient la pile par défaut, dit en tête de menu (« Same as the title », « Default »…). */
  inheritedLabel?: string;
}) {
  return (
    <SelectInput
      label={label}
      value={value ?? ""}
      options={[{ value: "", label: `${inheritedLabel} — ${firstFamily(inherited)}` }, ...fontChoices(theme, value)]}
      onChange={(v) => onChange(v === "" ? undefined : v)}
      hint={hint}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Valeurs par défaut EFFECTIVES — celles du compilateur (`articleHtml`)
 * ------------------------------------------------------------------ */

/** La typographie résolue de la carte (thème → row → colonne → style de la carte). */
export interface LookBase {
  fontFamily: string;
  fontSize: number;
  textColor: string;
  linkColor: string;
  /** Graisse héritée — sans valeur au thème : absente de toute la chaîne, chaque rendu a la sienne. */
  fontWeight?: BoxStyle["fontWeight"];
  /**
   * Couleur et police des TITRES (24/09/2026) — la règle de `resolve()` du compilateur : la cascade
   * (row → colonne → bloc), sinon `theme.headingColor` / `headingFont`, sinon le texte.
   */
  headingColor: string;
  headingFont: string;
  /** Vrai quand elles viennent des styles globaux de l'e-mail (rien dans la cascade, réglage posé). */
  headingColorIsEmail: boolean;
  headingFontIsEmail: boolean;
}

export function resolveLookBase(theme: Theme, layers: (BoxStyle | undefined)[]): LookBase {
  const own = <K extends "fontFamily" | "fontSize" | "textColor" | "linkColor">(key: K): BoxStyle[K] => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const v = layers[i]?.[key];
      if (v !== undefined) return v;
    }
    return undefined;
  };
  let fontWeight: BoxStyle["fontWeight"];
  for (let i = layers.length - 1; i >= 0 && fontWeight === undefined; i--) fontWeight = layers[i]?.fontWeight;
  const couleur = own("textColor");
  const police = own("fontFamily");
  return {
    fontFamily: police ?? theme.fontFamily,
    fontSize: own("fontSize") ?? theme.fontSize,
    textColor: couleur ?? theme.textColor,
    linkColor: own("linkColor") ?? theme.linkColor,
    ...(fontWeight === undefined ? {} : { fontWeight }),
    headingColor: couleur ?? theme.headingColor ?? theme.textColor,
    headingFont: police ?? theme.headingFont ?? theme.fontFamily,
    headingColorIsEmail: couleur === undefined && theme.headingColor !== undefined,
    headingFontIsEmail: police === undefined && theme.headingFont !== undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Les champs
 * ------------------------------------------------------------------ */

export interface ArticleLookFieldsProps {
  /** `article` = un bloc écrit à la main ; `look` = la une ou les brèves d'un flux. */
  mode: "article" | "look";
  value: ArticleLook;
  onPatch: (patch: Partial<ArticleLook>) => void;
  theme: Theme;
  base: LookBase;
  /** Look : la disposition du flux, qui s'applique tant que le look n'en choisit pas. */
  layoutFallback?: Layout;
  /** Couleur d'accent qui s'applique au surtitre et au pied quand rien n'est posé, et sa source. */
  accent: { color: string; from: string };
  /** Le libellé du lien de lecture quand le champ est vide, et pourquoi. */
  cta: { inherited?: string; inheritedFrom?: string; hint: string; warning?: string };
  /** Look : l'interrupteur « Show category and time » du flux, dont dépendent catégorie et heure. */
  showKicker?: boolean;
  /**
   * Look : la forme du lien de lecture posée sur le FLUX (`ctaStyle` du bloc), qui s'applique tant
   * que le look n'a pas la sienne — `toArticle` : `look.ctaStyle ?? feed.ctaStyle`.
   */
  ctaStyleFallback?: CtaStyle;
  /** Article : les champs de TEXTE que seul un article écrit à la main porte. */
  slots?: { kicker?: ReactNode; meta?: ReactNode; image?: ReactNode };
  /**
   * Look : l'éditeur de style (panneaux Style et Mobile de l'inspecteur), rendu par l'inspecteur.
   * `opts.typography: false` retire les réglages de texte — pour une boîte qui n'en dessine aucun
   * (le filet entre les cartes). Absent : le panneau complet.
   */
  renderStyle?: (
    style: BoxStyle | undefined,
    onChange: (next: BoxStyle | undefined) => void,
    opts?: { typography?: boolean; titre?: boolean },
  ) => ReactNode;
  /** Look : le style que la carte suit tant que le look n'a pas le sien (l'onglet Style du flux). */
  styleFallback?: BoxStyle;
  /**
   * Préfixe des `id` de mémoire des sous-sections (`<préfixe>.title`…). Absent : `article` pour un
   * article ; RIEN pour un look (il ne mémorise pas plutôt que de partager l'état d'un autre).
   * ⛔ La une et les brèves reçoivent des préfixes DISTINCTS (`article-feed.lead`, `article-feed.card`) :
   * sous le même, leurs sous-sections s'ouvriraient ensemble — et le garde des `id` littéraux
   * (`inspector-groups.test.ts`) ne voit pas un `id` calculé.
   */
  idPrefix?: string;
  /** « Use for all titles » sous la couleur du titre, quand elle est posée (action `useForAllTitles`). */
  onUseForAllTitles?: (color: string) => void;
}

export function ArticleLookFields(props: ArticleLookFieldsProps) {
  const { mode, value, onPatch, theme, base, accent, cta } = props;
  const B = BOUNDS[mode];
  // La une et les brèves portent les MÊMES entrées du manifeste (`articleCard()` les fabrique à
  // l'identique pour les deux cibles) : les brèves servent de référence aux deux looks.
  const spec = (path: string) => propSpec(mode === "article" ? "article" : "article-feed.card", path);
  // Sur un look, l'absence suit la forme posée sur le flux ; sur un article, c'est le bouton.
  const inheritedCtaStyle: CtaStyle = mode === "look" ? (props.ctaStyleFallback ?? "button") : "button";
  const ctaStyle: CtaStyle = value.ctaStyle ?? inheritedCtaStyle;
  const fs = base.fontSize;
  const layout: Layout = value.layout ?? props.layoutFallback ?? "stacked";
  // Défaut réel du surtitre d'une carte de flux : `showKicker` vaut « catégorie · heure » (`feed.ts`).
  const kickerDefault: KickerMode = props.showKicker === true ? "category-time" : "none";
  const kickerMode: KickerMode = value.kickerMode ?? kickerDefault;
  const kickerNeedsSwitch =
    mode === "look" && kickerMode !== "none" && kickerMode !== "text" && props.showKicker !== true;
  // Le rayon du bouton : celui de la boîte de la carte (le look, sinon le flux), sinon le thème.
  const box = mode === "look" ? (value.style ?? props.styleFallback) : value.style;
  const radius =
    box?.borderRadius !== undefined
      ? { value: box.borderRadius, from: "the card corner radius" }
      : { value: theme.radius, from: "the brand corner radius" };

  // Mémoire des sous-sections : `article.title`, `article-feed.lead.title`… (voir `idPrefix`).
  const prefix = props.idPrefix ?? (mode === "article" ? "article" : undefined);
  const gid = (part: string) => (prefix === undefined ? undefined : `${prefix}.${part}`);
  // ⛔ L'article porte TOUJOURS `layout` (le schéma le remplit à « stacked ») : compté tel quel,
  // « Image & layout » dirait « 1 set » sur un article jamais touché. Seul l'écart au défaut compte.
  // Sur un look, « stacked » ÉCRIT l'emporte sur le flux : c'est bien un réglage, il compte.
  const counted = mode === "article" && value.layout === "stacked" ? { ...value, layout: undefined } : value;

  return (
    <>
      {/* ------------------------------------------------------------ Contenu éditorial (article) */}
      {/* ⛔ CE QUE L'AUTEUR TAPE PASSE EN TÊTE, TOUJOURS VISIBLE, dans l'ordre de lecture de la carte
          (surtitre, image, ligne de pied ; titre, chapeau et lien sont au-dessus, dans
          `ArticleEditor`). Le 23/09/2026, ces emplacements étaient posés AU MILIEU des sections
          d'apparence : il fallait descendre à 1 517 px, derrière onze réglages du lien de lecture,
          pour taper le surtitre. Ne jamais les remettre dans un groupe. */}
      {props.slots?.kicker}
      {props.slots?.image}
      {props.slots?.meta}
      {/* Look : l'alerte de conflit du surtitre reste VISIBLE, en tête du look. Enfermée dans
          « Kicker » (fermé), elle ne préviendrait plus personne. `SelectInput` n'a pas
          d'emplacement d'alerte : la Note tient ce rôle. */}
      {kickerNeedsSwitch && (
        <Note tone="warn">
          “Show category and time” is off above, so this kicker is not shown. Tick it, or pick “A fixed label” under
          Kicker.
        </Note>
      )}

      {/* ------------------------------------------------------------ Apparence */}
      {/* UN intertitre, puis des sous-sections FERMÉES dans l'ordre de lecture de la carte. Sur un
          look, pas d'intertitre : tout le look est de l'apparence, et « Card looks » du flux joue ce
          rôle au-dessus. */}
      {mode === "article" && <SectionTitle>Appearance</SectionTitle>}

      {/* ------------------------------------------------------------ Surtitre */}
      <Group id={gid("kicker")} title="Kicker" summary={overrides(counted, LOOK_GROUP_KEYS.kicker)}>
        {mode === "look" && (
          <>
            <SelectInput<"" | KickerMode>
              label="Kicker shows"
              value={value.kickerMode ?? ""}
              options={[
                { value: "", label: `Default — ${LABELS.kickerMode[kickerDefault] ?? kickerDefault}` },
                ...(labelled("kickerMode", KICKER_MODES) as { value: KickerMode; label: string }[]),
              ]}
              onChange={(v) => onPatch({ kickerMode: v === "" ? undefined : v })}
              hint="The line above the title. Category and time come from the article itself: an article without a category shows none — nothing is made up."
            />
            {kickerMode === "text" && (
              <TextInput
                label="Kicker label"
                value={value.kickerText ?? ""}
                maxLength={KICKER_TEXT_MAX}
                onChange={(v) => onPatch({ kickerText: v.trim() === "" ? undefined : v })}
                onReset={value.kickerText === undefined ? undefined : () => onPatch({ kickerText: undefined })}
                placeholder="Featured"
                warning={(value.kickerText ?? "").trim() === "" ? "Empty — no kicker is shown on this card." : undefined}
                hint="The same words on every send — a place in the edition, like “Featured”, not a category."
              />
            )}
          </>
        )}
        <FontInput
          label="Kicker font"
          value={value.kickerFont}
          inherited={base.fontFamily}
          theme={theme}
          onChange={(v) => onPatch({ kickerFont: v })}
        />
        <NumberInput
          label="Kicker size"
          value={value.kickerSize}
          min={B.kickerSize.min}
          max={B.kickerSize.max}
          suffix="px"
          inherited={String(Math.max(10, fs - 4))}
          inheritedFrom="the card font size minus 4"
          onReset={value.kickerSize === undefined ? undefined : () => onPatch({ kickerSize: undefined })}
          onChange={(v) => onPatch({ kickerSize: clampTo(B.kickerSize, v) })}
        />
        <ColorInput
          label="Kicker colour"
          value={value.kickerColor}
          inherited={theme.mutedColor}
          inheritedFrom="the brand muted colour"
          onReset={value.kickerColor === undefined ? undefined : () => onPatch({ kickerColor: undefined })}
          onChange={(v) => onPatch({ kickerColor: v })}
        />
        <ColorInput
          label="Kicker accent colour"
          value={value.kickerAccentColor}
          inherited={accent.color}
          inheritedFrom={accent.from}
          onReset={value.kickerAccentColor === undefined ? undefined : () => onPatch({ kickerAccentColor: undefined })}
          onChange={(v) => onPatch({ kickerAccentColor: v })}
          hint={mode === "look" ? "The time after the category, in “Category · time”." : "The accent half of the kicker line."}
        />
      </Group>

      {/* ------------------------------------------------------------ Image et disposition */}
      <Group id={gid("image")} title="Image & layout" summary={overrides(counted, LOOK_GROUP_KEYS.image)}>
        {mode === "look" ? (
          <SelectInput<"" | Layout>
            label="Arrangement"
            value={value.layout ?? ""}
            options={[
              { value: "", label: `Same as the block — ${LABELS.layout[props.layoutFallback ?? "stacked"]}` },
              ...(labelled("layout", LAYOUTS) as { value: Layout; label: string }[]),
            ]}
            onChange={(v) => onPatch({ layout: v === "" ? undefined : v })}
          />
        ) : (
          <SelectInput<Layout>
            label="Arrangement"
            value={value.layout ?? "stacked"}
            options={labelled("layout", LAYOUTS) as { value: Layout; label: string }[]}
            onChange={(v) => onPatch({ layout: v })}
          />
        )}
        <NumberInput
          label="Thumbnail width"
          value={value.imageWidthPct}
          min={B.imageWidthPct.min}
          max={B.imageWidthPct.max}
          suffix="%"
          inherited="38"
          inheritedFrom="the article default"
          onReset={value.imageWidthPct === undefined ? undefined : () => onPatch({ imageWidthPct: undefined })}
          onChange={(v) => onPatch({ imageWidthPct: clampTo(B.imageWidthPct, v) })}
          hint={
            layout === "side"
              ? // Le seuil est celui du thème (`columnBreakpoint`, 480 par défaut) : le dire en dur aurait
                // menti dès qu'une marque le déplace.
                `Share of the card taken by the image beside the text. Below ${theme.columnBreakpoint ?? 480}px wide the image moves on top, full width. Outlook desktop keeps both columns.`
              : "Only used side by side — this card is stacked, so the image takes the full width."
          }
        />
        <CheckboxInput
          label="Clickable image"
          text="The image links to the article"
          checked={value.imageLink !== false}
          // Le défaut (cliquable) s'écrit ABSENT ; seul « non » s'écrit, en `false`.
          onChange={(v) => onPatch({ imageLink: v ? undefined : false })}
          hint={spec("imageLink").hint}
        />
      </Group>

      {/* ------------------------------------------------------------ Titre */}
      <Group id={gid("title")} title="Title" summary={overrides(counted, LOOK_GROUP_KEYS.title)}>
        <NumberInput
          label="Title size"
          value={value.titleSize}
          min={B.titleSize.min}
          max={B.titleSize.max}
          suffix="px"
          inherited={String(fs + 3)}
          inheritedFrom="the card font size plus 3"
          onReset={value.titleSize === undefined ? undefined : () => onPatch({ titleSize: undefined })}
          onChange={(v) => onPatch({ titleSize: clampTo(B.titleSize, v) })}
        />
        <FontInput
          label="Title font"
          value={value.titleFont}
          inherited={base.headingFont}
          theme={theme}
          onChange={(v) => onPatch({ titleFont: v })}
        />
        <ColorInput
          label="Title colour"
          value={value.titleColor}
          inherited={base.headingColor}
          inheritedFrom={base.headingColorIsEmail ? "the email title style" : "the text colour"}
          onReset={value.titleColor === undefined ? undefined : () => onPatch({ titleColor: undefined })}
          onChange={(v) => onPatch({ titleColor: v })}
        />
        {value.titleColor !== undefined && props.onUseForAllTitles && (
          <UseForAllTitles color={value.titleColor} onUse={props.onUseForAllTitles} />
        )}
        <SelectInput<Weight>
          label="Title weight"
          value={value.titleWeight ?? "700"}
          options={labelled("titleWeight", WEIGHTS) as { value: Weight; label: string }[]}
          onChange={(v) => onPatch({ titleWeight: v === "700" ? undefined : v })}
          hint="Weights the font does not carry are faked or ignored by the email client."
        />
        <NumberInput
          label="Title line height"
          value={value.titleLineHeight}
          min={B.titleLineHeight.min}
          max={B.titleLineHeight.max}
          step={0.05}
          inherited="1.3"
          inheritedFrom="the article default"
          onReset={value.titleLineHeight === undefined ? undefined : () => onPatch({ titleLineHeight: undefined })}
          onChange={(v) => onPatch({ titleLineHeight: clampTo(B.titleLineHeight, v) })}
          hint="A multiple of the title size — 1.1 for a tight display title, 1.4 for an airy one."
        />
        <CheckboxInput
          label="Clickable title"
          text="The title links to the article"
          checked={value.titleLink === true}
          onChange={(v) => onPatch({ titleLink: v ? true : undefined })}
          hint="Off, the title is plain text. With no image and no read link, a card whose title is not clickable carries no link at all."
        />
      </Group>

      {/* ------------------------------------------------------------ Chapeau */}
      <Group id={gid("excerpt")} title="Excerpt" summary={overrides(counted, LOOK_GROUP_KEYS.excerpt)}>
        <ChoiceInput<Weight>
          label="Excerpt weight"
          value={value.excerptWeight}
          def={spec("excerptWeight").default as Weight}
          options={WEIGHTS as Weight[]}
          labels={WEIGHT_LABELS}
          onChange={(v) => onPatch({ excerptWeight: v })}
          hint={spec("excerptWeight").hint}
        />
        <NumberInput
          label="Excerpt line height"
          value={value.excerptLineHeight}
          {...numberField(spec("excerptLineHeight"))}
          inherited={literalDefault(spec("excerptLineHeight"))}
          inheritedFrom="the article default"
          onReset={value.excerptLineHeight === undefined ? undefined : () => onPatch({ excerptLineHeight: undefined })}
          onChange={(v) => onPatch({ excerptLineHeight: clampTo(specBounds(spec("excerptLineHeight")), v) })}
        />
        <Note>
          {mode === "look"
            ? "The excerpt size and colour are the text size and colour of the card box below."
            : "The excerpt size and colour are the font size and text colour of the Style tab."}
        </Note>
      </Group>

      {/* ------------------------------------------------------------ Ligne de pied */}
      <Group id={gid("meta")} title="Meta line" summary={overrides(counted, LOOK_GROUP_KEYS.meta)}>
        {mode === "look" && (
          <SelectInput<"" | MetaMode>
            label="Meta line shows"
            value={value.metaMode ?? ""}
            options={[
              { value: "", label: "Default — nothing" },
              ...(labelled("metaMode", META_MODES) as { value: MetaMode; label: string }[]),
            ]}
            onChange={(v) => onPatch({ metaMode: v === "" ? undefined : v })}
            hint="A line under the excerpt. The publish time is written in the block’s time zone, in the accent colour."
          />
        )}
        <NumberInput
          label="Meta size"
          value={value.metaSize}
          min={B.metaSize.min}
          max={B.metaSize.max}
          suffix="px"
          inherited={String(Math.max(10, fs - 3))}
          inheritedFrom="the card font size minus 3"
          onReset={value.metaSize === undefined ? undefined : () => onPatch({ metaSize: undefined })}
          onChange={(v) => onPatch({ metaSize: clampTo(B.metaSize, v) })}
        />
        <ColorInput
          label="Meta colour"
          value={value.metaColor}
          inherited={theme.mutedColor}
          inheritedFrom="the brand muted colour"
          onReset={value.metaColor === undefined ? undefined : () => onPatch({ metaColor: undefined })}
          onChange={(v) => onPatch({ metaColor: v })}
        />
        <ColorInput
          label="Meta accent colour"
          value={value.metaAccentColor}
          inherited={accent.color}
          inheritedFrom={accent.from}
          onReset={value.metaAccentColor === undefined ? undefined : () => onPatch({ metaAccentColor: undefined })}
          onChange={(v) => onPatch({ metaAccentColor: v })}
        />
      </Group>

      {/* ------------------------------------------------------------ Lien de lecture */}
      <Group id={gid("read-link")} title="Read link" summary={overrides(counted, LOOK_GROUP_KEYS.readLink)}>
        {mode === "look" ? (
          <SelectInput<"" | CtaStyle>
            label="Read link style"
            value={value.ctaStyle ?? ""}
            options={[
              { value: "", label: `Same as the block — ${LABELS.ctaStyleName[inheritedCtaStyle] ?? inheritedCtaStyle}` },
              ...(labelled("ctaStyleName", CTA_STYLES) as { value: CtaStyle; label: string }[]),
            ]}
            // ⛔ Sur un look, « Button » s'ÉCRIT : le flux peut avoir posé « Link » ou « None » pour
            // toutes ses cartes, et seul un `ctaStyle` du look l'emporte pour celles-ci.
            onChange={(v) => onPatch({ ctaStyle: v === "" ? undefined : v })}
            hint="Button takes the brand button colours. Link is text in the link colour. None sends no read link at all — the image, and the title if it is clickable, still lead to the article."
          />
        ) : (
          <SelectInput<CtaStyle>
            label="Read link style"
            value={ctaStyle}
            options={labelled("ctaStyle", CTA_STYLES) as { value: CtaStyle; label: string }[]}
            // ⛔ « None » s'ÉCRIT : c'est la seule façon de dire « pas de lien de lecture ». Un libellé
            // vide serait re-rempli par le défaut de langue au rendu (`withDefaultCta`). « Button » est
            // le défaut du compilateur : il s'écrit ABSENT, comme la graisse 700.
            onChange={(v) => onPatch({ ctaStyle: v === "button" ? undefined : v })}
            hint="Button takes the brand button colours. Link is text in the link colour. None sends no read link at all — the image, and the title if it is clickable, still lead to the article."
          />
        )}
        {ctaStyle === "none" ? (
          // ⛔ LE LIBELLÉ N'EST PAS AFFICHÉ QUAND IL EST MORT : un champ saisissable sous « None »
          // promettrait un texte que la compilation n'émettra jamais.
          <Note>No read link is sent, so there is no label to set. Pick Button or Link to bring it back.</Note>
        ) : (
          <>
            <TextInput
              label="Read link label"
              value={value.ctaLabel ?? ""}
              maxLength={MAX_BUTTON_LABEL}
              onChange={(v) => onPatch({ ctaLabel: v.trim() === "" ? undefined : v })}
              inherited={cta.inherited}
              inheritedFrom={cta.inheritedFrom}
              onReset={value.ctaLabel === undefined ? undefined : () => onPatch({ ctaLabel: undefined })}
              hint={cta.hint}
              warning={cta.warning}
            />
            <FontInput
              label="Read link font"
              value={value.ctaFont}
              inherited={base.fontFamily}
              theme={theme}
              onChange={(v) => onPatch({ ctaFont: v })}
            />
            {/* ⛔ TAILLE, GRAISSE, INTERLETTRAGE ET CASSE VALENT POUR LES DEUX FORMES depuis le 22/09/2026
                (`articleCta` les passe au bouton) : cachés sous « Link », ils laissaient le bouton — le
                défaut, donc presque toutes les cartes — sans aucun réglage de texte. */}
            <NumberInput
              label="Read link size"
              value={value.ctaSize}
              min={B.ctaSize.min}
              max={B.ctaSize.max}
              suffix="px"
              // Deux défauts, deux rendus : le lien prend la taille de la carte, le bouton `ctaTable`
              // la réduit de 2 (13 au moins).
              inherited={String(ctaStyle === "link" ? fs : Math.max(13, fs - 2))}
              inheritedFrom={ctaStyle === "link" ? "the card font size" : "the card font size minus 2 (at least 13)"}
              onReset={value.ctaSize === undefined ? undefined : () => onPatch({ ctaSize: undefined })}
              onChange={(v) => onPatch({ ctaSize: clampTo(B.ctaSize, v) })}
            />
            <ChoiceInput<Weight>
              label="Read link weight"
              value={value.ctaWeight}
              def={spec("ctaWeight").default as Weight}
              options={WEIGHTS as Weight[]}
              labels={WEIGHT_LABELS}
              onChange={(v) => onPatch({ ctaWeight: v })}
              hint={spec("ctaWeight").hint}
            />
            <NumberInput
              label="Read link letter spacing"
              value={value.ctaLetterSpacing}
              min={B.ctaLetterSpacing.min}
              max={B.ctaLetterSpacing.max}
              step={0.1}
              suffix="px"
              inherited="0"
              inheritedFrom="normal spacing"
              onReset={value.ctaLetterSpacing === undefined ? undefined : () => onPatch({ ctaLetterSpacing: undefined })}
              onChange={(v) => onPatch({ ctaLetterSpacing: clampTo(B.ctaLetterSpacing, v) })}
            />
            <SelectInput<"" | Transform>
              label="Read link case"
              value={value.ctaTransform ?? ""}
              options={[{ value: "", label: "As typed (default)" }, ...(labelled("ctaTransform", TRANSFORMS) as { value: Transform; label: string }[])]}
              onChange={(v) => onPatch({ ctaTransform: v === "" ? undefined : v })}
            />
          </>
        )}
        {ctaStyle === "link" && (
          <>
            <ColorInput
              label="Read link colour"
              value={value.ctaColor}
              inherited={base.linkColor}
              inheritedFrom="the link colour"
              onReset={value.ctaColor === undefined ? undefined : () => onPatch({ ctaColor: undefined })}
              onChange={(v) => onPatch({ ctaColor: v })}
            />
            <NumberInput
              label="Underline"
              value={value.ctaUnderline}
              min={B.ctaUnderline.min}
              max={B.ctaUnderline.max}
              suffix="px"
              inherited="1"
              inheritedFrom="a normal underline"
              onReset={value.ctaUnderline === undefined ? undefined : () => onPatch({ ctaUnderline: undefined })}
              onChange={(v) => onPatch({ ctaUnderline: clampTo(B.ctaUnderline, v) })}
              hint="0 = no underline, 1 = a normal underline, 2 and more = a thicker rule under the text, drawn as a border so Outlook keeps it."
            />
          </>
        )}
        {ctaStyle === "button" && (
          // Le même bouton que pick, promo et encart (`ctaTable`) : son fond, sa couleur de texte, ses
          // marges et son rayon. Taille et graisse sont au-dessus, communes aux deux formes.
          <CardButtonFields
            target={mode === "article" ? "article" : "article-feed.card"}
            value={value}
            onPatch={onPatch}
            theme={theme}
            fontSize={fs}
            radius={radius}
            withTypography={false}
          />
        )}
      </Group>

      {/* ------------------------------------------------------------ Écarts entre les parties */}
      <Group id={gid("spacing")} title="Spacing inside the card" summary={overrides(counted, LOOK_GROUP_KEYS.spacing)}>
        <NumberInput
          label="Below the kicker"
          value={value.kickerGap}
          {...numberField(spec("kickerGap"))}
          suffix="px"
          inherited={literalDefault(spec("kickerGap"))}
          inheritedFrom="the article default"
          onReset={value.kickerGap === undefined ? undefined : () => onPatch({ kickerGap: undefined })}
          onChange={(v) => onPatch({ kickerGap: clampTo(specBounds(spec("kickerGap")), v) })}
        />
        <NumberInput
          label="Below the image"
          value={value.imageGap}
          {...numberField(spec("imageGap"))}
          suffix="px"
          inherited={literalDefault(spec("imageGap"))}
          inheritedFrom="the article default"
          onReset={value.imageGap === undefined ? undefined : () => onPatch({ imageGap: undefined })}
          onChange={(v) => onPatch({ imageGap: clampTo(specBounds(spec("imageGap")), v) })}
        />
        <NumberInput
          label="Above the excerpt"
          value={value.excerptGap}
          {...numberField(spec("excerptGap"))}
          suffix="px"
          inherited={literalDefault(spec("excerptGap"))}
          inheritedFrom="the article default"
          onReset={value.excerptGap === undefined ? undefined : () => onPatch({ excerptGap: undefined })}
          onChange={(v) => onPatch({ excerptGap: clampTo(specBounds(spec("excerptGap")), v) })}
        />
        <NumberInput
          label="Above the meta line"
          value={value.metaGap}
          {...numberField(spec("metaGap"))}
          suffix="px"
          inherited={literalDefault(spec("metaGap"))}
          inheritedFrom="the article default"
          onReset={value.metaGap === undefined ? undefined : () => onPatch({ metaGap: undefined })}
          onChange={(v) => onPatch({ metaGap: clampTo(specBounds(spec("metaGap")), v) })}
        />
        <NumberInput
          label="Above the read link"
          value={value.ctaGap}
          {...numberField(spec("ctaGap"))}
          suffix="px"
          inherited={literalDefault(spec("ctaGap"))}
          inheritedFrom="the article default"
          onReset={value.ctaGap === undefined ? undefined : () => onPatch({ ctaGap: undefined })}
          onChange={(v) => onPatch({ ctaGap: clampTo(specBounds(spec("ctaGap")), v) })}
        />
        <NumberInput
          label="Between thumbnail and text"
          value={value.sideGap}
          {...numberField(spec("sideGap"))}
          suffix="px"
          inherited={literalDefault(spec("sideGap"))}
          inheritedFrom="the article default"
          onReset={value.sideGap === undefined ? undefined : () => onPatch({ sideGap: undefined })}
          onChange={(v) => onPatch({ sideGap: clampTo(specBounds(spec("sideGap")), v) })}
        />
      </Group>

      {/* ------------------------------------------------------------ Boîte et texte (look) */}
      {mode === "look" && props.renderStyle && (
        <Group id={gid("box")} title="Card box & text" summary={overrides(value.style)}>
          <Note>
            {value.style === undefined
              ? "These cards follow the block’s Style and Mobile tabs. The values below are those; change one and these cards get their own copy, which stops following the block."
              : "These cards have their own box and text style: the block’s Style and Mobile tabs no longer reach them. Reset all overrides to follow the block again."}
          </Note>
          {/* Montré tel qu'il s'applique : le style du flux tant que le look n'a pas le sien. La
              première retouche copie donc TOUT ce que l'auteur voit, pas seulement la valeur changée —
              `toArticle` REMPLACE le style du flux par celui du look, il ne les fusionne pas. */}
          {props.renderStyle(value.style ?? props.styleFallback, (next) => onPatch({ style: next }))}
        </Group>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Le flux : une, brèves, titre de section, filet
 * ------------------------------------------------------------------ */

type RenderStyle = NonNullable<ArticleLookFieldsProps["renderStyle"]>;
type PatchPart = (part: FeedPart, patch: Record<string, unknown> | null) => void;
type LineStyle = NonNullable<NonNullable<ArticleFeedBlock["cardRule"]>["lineStyle"]>;

/** Le libellé posé à la création d'un titre de section — visible et modifiable sur-le-champ. */
export const DEFAULT_MID_SECTION_LABEL = "More news";

/**
 * Titre de section inséré entre la une et les brèves. Rendu comme un bloc `section_title`.
 *
 * Sans une (`leadCount` 0), il n'y a pas d'« entre » : le titre n'est posé que si `showWithoutLead`
 * le demande, au-dessus de la première carte (`feedCards`). L'éditeur le dit plutôt que de laisser
 * régler un titre qui ne partirait pas.
 */
export function MidSectionFields({
  mid,
  theme,
  patchPart,
  renderStyle,
  leadOn,
}: {
  mid: ArticleFeedBlock["midSection"];
  theme: Theme;
  patchPart: PatchPart;
  renderStyle: RenderStyle;
  /** Le flux a au moins une carte en une (`leadCount` ≥ 1). */
  leadOn: boolean;
}) {
  const spec = (path: string) => propSpec("article-feed", `midSection.${path}`);
  if (mid === undefined) {
    return (
      <>
        <Note>{leadOn ? "No heading between the lead and the other cards." : "No heading above the cards."}</Note>
        <MiniBtn
          label="Add a section title"
          // Sans une, un titre ajouté ne partirait pas sans `showWithoutLead` : on le pose avec, pour
          // que le geste ait un effet visible — la case reste là pour le retirer.
          onClick={() =>
            patchPart("midSection", leadOn ? { label: DEFAULT_MID_SECTION_LABEL } : { label: DEFAULT_MID_SECTION_LABEL, showWithoutLead: true })
          }
        >
          <Plus className="h-3 w-3" strokeWidth={2.2} /> Add a section title
        </MiniBtn>
      </>
    );
  }
  const rule = mid.rule ?? "after";
  const shown = leadOn || mid.showWithoutLead === true;
  return (
    <>
      <TextInput
        label="Section title"
        value={mid.label}
        maxLength={MID_LABEL_MAX}
        // Le vide s'écrit (le schéma le refusera à la sauvegarde, le champ le dit) : le rejeter ici
        // ferait revenir l'ancien libellé sous le curseur au milieu d'un Ctrl+A ⌫.
        onChange={(v) => patchPart("midSection", { label: v })}
        warning={
          mid.label.trim() === ""
            ? "Empty — the template cannot be saved like this. Type a title, or use Remove section to drop the heading."
            : !shown
              ? "Not sent: this feed has no lead card. Tick “Show without a lead” below, or set Lead cards above."
              : undefined
        }
        hint={
          leadOn
            ? "Shown after the lead, before the next card — never when there is no next card."
            : "Shown above the first card, since this feed has no lead."
        }
      />
      <CheckboxInput
        label="Show without a lead"
        text="Also show it when the feed has no lead card"
        checked={mid.showWithoutLead === true}
        onChange={(v) => patchPart("midSection", { showWithoutLead: v ? true : undefined })}
        hint={spec("showWithoutLead").hint}
      />
      <SelectInput<(typeof MID_RULES)[number]>
        label="Rule"
        value={rule}
        options={labelled("rule", MID_RULES)}
        onChange={(v) => patchPart("midSection", { rule: v === "after" ? undefined : v })}
      />
      {rule !== "none" && (
        <>
          <NumberInput
            label="Rule thickness"
            value={mid.ruleThickness}
            min={MID_RULE_THICKNESS.min}
            max={MID_RULE_THICKNESS.max}
            suffix="px"
            inherited="2"
            inheritedFrom="the section title default"
            onReset={mid.ruleThickness === undefined ? undefined : () => patchPart("midSection", { ruleThickness: undefined })}
            onChange={(v) => patchPart("midSection", { ruleThickness: clampTo(MID_RULE_THICKNESS, v) })}
          />
          <ColorInput
            label="Rule colour"
            value={mid.ruleColor}
            inherited={mid.style?.borderColor ?? theme.borderColor}
            inheritedFrom={mid.style?.borderColor ? "the heading border colour" : "the brand border colour"}
            onReset={mid.ruleColor === undefined ? undefined : () => patchPart("midSection", { ruleColor: undefined })}
            onChange={(v) => patchPart("midSection", { ruleColor: v })}
          />
          <NumberInput
            label="Gap to the rule"
            value={mid.ruleGap}
            {...numberField(spec("ruleGap"))}
            suffix="px"
            // Le défaut dépend de la forme du filet (12 / 9 / 8) : on montre celui de la forme choisie.
            inherited={String(RULE_GAP_DEFAULT[rule] ?? 12)}
            inheritedFrom="this rule’s default"
            onReset={mid.ruleGap === undefined ? undefined : () => patchPart("midSection", { ruleGap: undefined })}
            onChange={(v) => patchPart("midSection", { ruleGap: clampTo(specBounds(spec("ruleGap")), v) })}
          />
        </>
      )}
      <Group id="article-feed.mid-section.box" title="Heading box & text" summary={overrides(mid.style)}>
        <Note>Size, weight, colour, case and spacing of the heading, like the Style tab of a section title block.</Note>
        {renderStyle(mid.style, (next) => patchPart("midSection", { style: next }), { titre: true })}
      </Group>
      <MiniBtn label="Remove section" danger onClick={() => patchPart("midSection", null)}>
        <Trash2 className="h-3 w-3" strokeWidth={2.2} /> Remove section
      </MiniBtn>
    </>
  );
}

/** Filet posé entre deux brèves — jamais avant la première, jamais autour de la une. */
export function CardRuleFields({
  rule,
  theme,
  patchPart,
  renderStyle,
}: {
  rule: ArticleFeedBlock["cardRule"];
  theme: Theme;
  patchPart: PatchPart;
  renderStyle: RenderStyle;
}) {
  const spec = (path: string) => propSpec("article-feed", `cardRule.${path}`);
  if (rule === undefined) {
    return (
      <>
        <Note>The cards follow each other with no rule between them.</Note>
        {/* `{}` n'est PAS l'absence : c'est « un filet, aux valeurs par défaut » (couleur de bordure
            de la marque, 1 px). Le réducteur le sait et ne le replie pas. */}
        <MiniBtn label="Add a rule between cards" onClick={() => patchPart("cardRule", {})}>
          <Plus className="h-3 w-3" strokeWidth={2.2} /> Add a rule between cards
        </MiniBtn>
      </>
    );
  }
  return (
    <>
      <ColorInput
        label="Rule colour"
        value={rule.color}
        inherited={rule.style?.borderColor ?? theme.borderColor}
        inheritedFrom={rule.style?.borderColor ? "the rule border colour" : "the brand border colour"}
        onReset={rule.color === undefined ? undefined : () => patchPart("cardRule", { color: undefined })}
        onChange={(v) => patchPart("cardRule", { color: v })}
      />
      <NumberInput
        label="Rule thickness"
        value={rule.thickness}
        min={CARD_RULE_THICKNESS.min}
        max={CARD_RULE_THICKNESS.max}
        suffix="px"
        inherited="1"
        inheritedFrom="a hairline"
        onReset={rule.thickness === undefined ? undefined : () => patchPart("cardRule", { thickness: undefined })}
        onChange={(v) => patchPart("cardRule", { thickness: clampTo(CARD_RULE_THICKNESS, v) })}
      />
      <NumberInput
        label="Rule width"
        value={rule.widthPct}
        {...numberField(spec("widthPct"))}
        suffix="%"
        inherited={literalDefault(spec("widthPct"))}
        inheritedFrom="the full column"
        onReset={rule.widthPct === undefined ? undefined : () => patchPart("cardRule", { widthPct: undefined })}
        onChange={(v) => patchPart("cardRule", { widthPct: clampTo(specBounds(spec("widthPct")), v) })}
      />
      <ChoiceInput<LineStyle>
        label="Rule style"
        value={rule.lineStyle}
        def={spec("lineStyle").default as LineStyle}
        options={spec("lineStyle").options as readonly LineStyle[]}
        labels={LINE_STYLE_LABELS}
        onChange={(v) => patchPart("cardRule", { lineStyle: v })}
        hint={spec("lineStyle").hint}
      />
      <Group id="article-feed.card-rule.box" title="Rule box" summary={overrides(rule.style)}>
        <Note>The padding here is the space above and below the rule.</Note>
        {/* ⛔ SANS RÉGLAGE DE TEXTE : le filet n'en dessine aucun, et L4 a vérifié à la compilation
            que ses huit réglages de texte ne changent pas l'e-mail. « Alignment » reste : il place
            un filet plus étroit que la colonne. */}
        {renderStyle(rule.style, (next) => patchPart("cardRule", { style: next }), { typography: false })}
      </Group>
      <MiniBtn label="Remove rule" danger onClick={() => patchPart("cardRule", null)}>
        <Trash2 className="h-3 w-3" strokeWidth={2.2} /> Remove rule
      </MiniBtn>
    </>
  );
}

/**
 * Les quatre apparences d'un flux, chacune dans son groupe.
 *
 * ⛔ UN FLUX SANS `lead` NI `card` MONTRE QUAND MÊME TOUS LES CHAMPS, avec les valeurs qui
 * s'appliquent en grisé. Un flux ajouté depuis la palette n'a ni l'un ni l'autre ; le 22/09/2026
 * l'inspecteur promettait pourtant « the lead styling of this brand » — un style qui n'existait
 * dans aucun champ. Toute retouche passe par `updateBlockPart`, qui écrit l'objet COMPLET.
 */
export function FeedLookSections({
  block,
  locale,
  theme,
  layers,
  patchPart,
  renderStyle,
  defaultCtaLabel,
  onUseForAllTitles,
}: {
  block: ArticleFeedBlock;
  locale: string;
  theme: Theme;
  /** Styles de la row et de la colonne du flux, du plus général au plus proche. */
  layers: (BoxStyle | undefined)[];
  /**
   * La SEULE écriture des looks : `lead` / `card` / `midSection` / `cardRule` entiers. Aucune clé de
   * premier niveau du flux ne s'écrit ici depuis que « Read link style — every card » est passé dans
   * [Read link] de `FeedCardFields` (23/09/2026) : ce composant n'a plus de `patch`.
   */
  patchPart: PatchPart;
  renderStyle: RenderStyle;
  /** `meta.defaultCtaLabel` du document : il remplace le libellé de la langue sur toute carte. */
  defaultCtaLabel?: string;
  /** « Use for all titles » sous la couleur de titre d'un look (action `useForAllTitles`). */
  onUseForAllTitles?: (color: string) => void;
}) {
  // `leadCount` va de 0 à 3 depuis le 22/09/2026 : « une » = au moins une carte en une.
  const leads = block.leadCount ?? 0;
  const leadOn = leads >= 1;
  // L'heure porte UNE couleur pour tout le flux (`timeColor`) ; un look peut la surcharger.
  const accent =
    block.timeColor !== undefined
      ? { color: block.timeColor, from: "the block’s time colour" }
      : { color: theme.brandColor, from: "the brand colour" };
  const docLabel = defaultCtaLabel !== undefined && defaultCtaLabel.trim() !== "";
  const cta = {
    inherited: block.ctaLabel ?? defaultArticleCta(locale, defaultCtaLabel),
    inheritedFrom:
      block.ctaLabel !== undefined
        ? "the block’s CTA label"
        : docLabel
          ? "the document’s default read-link label"
          : "this document’s language",
    hint: "Empty = the block’s CTA label above, or the document’s default read-link label. A card whose link goes nowhere gets no read link at all.",
  };
  const common = {
    mode: "look" as const,
    theme,
    accent,
    cta,
    showKicker: block.showKicker === true,
    layoutFallback: block.layout,
    ctaStyleFallback: block.ctaStyle,
    renderStyle,
    styleFallback: block.style,
    onUseForAllTitles,
  };

  // ⛔ REPLIÉ (24/09/2026, feature 5, étape 6) : les styles prêts (« Card style », en tête de Cards) et les
  // styles de l'e-mail couvrent l'usage courant ; les looks carte par carte sont l'exception. Le résumé
  // compte les quatre parties que ce groupe écrit.
  return (
    <Group id="article-feed.looks" title="Card looks" summary={overrides(block, ["lead", "card", "midSection", "cardRule"])}>
      <Note>
        Advanced. “Card style” above sets the arrangement and sizes, and colours and fonts come from the email styles.
        Every card is drawn like a manual article block: whatever a look leaves empty falls back to this block’s
        settings, then to the defaults shown in grey.
      </Note>
      {/* « Read link style — every card » n'est plus ici : il vit dans [Read link] (`FeedCardFields`),
          à côté du libellé qu'il gouverne (lot L4 / audit §3.3). */}

      {leadOn ? (
        <Group id="article-feed.lead" title={leads > 1 ? "Lead cards" : "Lead card"} summary={overrides(block.lead)}>
          <ArticleLookFields
            {...common}
            // ⛔ Préfixe DISTINCT de celui des brèves : sous le même, « Title » de la une et « Title »
            // des brèves s'ouvriraient et se fermeraient ensemble.
            idPrefix="article-feed.lead"
            value={block.lead ?? {}}
            base={resolveLookBase(theme, [...layers, block.lead?.style ?? block.style])}
            onPatch={(p) => patchPart("lead", p)}
          />
          {block.lead !== undefined && (
            <MiniBtn label="Reset the lead card look" danger onClick={() => patchPart("lead", null)}>
              <Trash2 className="h-3 w-3" strokeWidth={2.2} /> Reset the lead card look
            </MiniBtn>
          )}
        </Group>
      ) : (
        <Note>Set “Lead cards” above to 1 or more to give the first articles their own look, and a heading after them.</Note>
      )}

      <Group id="article-feed.card" title={leadOn ? "Other cards" : "Cards"} summary={overrides(block.card)}>
        <ArticleLookFields
          {...common}
          idPrefix="article-feed.card"
          value={block.card ?? {}}
          base={resolveLookBase(theme, [...layers, block.card?.style ?? block.style])}
          onPatch={(p) => patchPart("card", p)}
        />
        {block.card !== undefined && (
          <MiniBtn label="Reset the card look" danger onClick={() => patchPart("card", null)}>
            <Trash2 className="h-3 w-3" strokeWidth={2.2} /> Reset the card look
          </MiniBtn>
        )}
      </Group>

      {/* ⛔ OFFERT MÊME SANS UNE depuis le 22/09/2026 : `showWithoutLead` pose le titre au-dessus des
          cartes. Caché sans une, ce réglage que le schéma accepte n'aurait eu aucun chemin. */}
      {/* Résumé : « defaults » = pas de titre (le défaut du flux) ; posé, le libellé est obligatoire,
          donc « N set » avec N ≥ 1. Le « non envoyé » est dit par l'alerte du champ, à l'ouverture. */}
      <Group
        id="article-feed.mid-section"
        title={leadOn ? "Section between them" : "Section title above the cards"}
        summary={overrides(block.midSection)}
      >
        <MidSectionFields
          mid={block.midSection}
          theme={theme}
          patchPart={patchPart}
          renderStyle={renderStyle}
          leadOn={leadOn}
        />
      </Group>

      {/* ⛔ Résumé sur la PRÉSENCE du filet, pas sur son contenu : `{}` est « un filet aux valeurs par
          défaut » (le réducteur ne le replie pas). Compté par `overrides(block.cardRule)`, un filet
          fraîchement ajouté dirait « defaults » exactement comme l'absence de filet. */}
      <Group id="article-feed.card-rule" title="Rule between cards" summary={overrides(block, ["cardRule"])}>
        <CardRuleFields rule={block.cardRule} theme={theme} patchPart={patchPart} renderStyle={renderStyle} />
      </Group>
    </Group>
  );
}
