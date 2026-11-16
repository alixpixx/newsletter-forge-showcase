/// <reference path="../types/mjml.d.ts" />
// ⛔ La référence ci-dessus VOYAGE AVEC LE FICHIER, et c'est tout son intérêt : la déclaration
// ambiante de `mjml` n'est visible que des projets qui incluent `src/types/`. Le worker, lui,
// compile ce fichier depuis SON tsconfig — sans cette ligne, `mjml2html` y devient `any`, et
// l'`any` se propage en silence jusqu'à `out.errors`, qui n'est alors plus vérifié du tout.
/**
 * EmailDoc → AST JSON MJML → HTML.
 *
 * On passe par l'API JSON de MJML (`mjml2html(objet)`) et non par une string XML : pas de
 * sérialisation/parsing intermédiaire, donc pas d'échappement à refaire deux fois ni de risque
 * d'injection par un contenu utilisateur.
 *
 * Pourquoi MJML : les 20 % vraiment durs — ghost tables `mso`, VML `v:roundrect`, empilement des
 * colonnes, DPI 96 — sont corrects par construction. Les réécrire coûte des mois et se paie en
 * bugs Outlook silencieux.
 *
 * ⚠️ La cascade theme → row → column → block est résolue ICI, avant génération : le moteur Word
 * d'Outlook n'hérite d'aucun style de façon fiable, tout doit être posé explicitement.
 */
import mjml2html from "mjml";
import {
  CONDITION_END,
  LAYOUT_WEIGHTS,
  NEAR_BLACK,
  conditionMarker,
  escapeHtml,
  type Align,
  type ArticleBlock,
  type CalloutBlock,
  type Block,
  type BoxStyle,
  type Column,
  type EmailDoc,
  type OddsTableBlock,
  type Paragraph,
  type PickBlock,
  type PromoBlock,
  type ScoreboardBlock,
  type SectionTitleBlock,
  type Row,
  type RowLayout,
  type Spacing,
  type StandingsBlock,
  type TextPreset,
  type Theme,
  type VisibleIf,
} from "../schema";
import { defaultFirstName, poserRepliPrenom } from "../hydrate";
import { calloutLayoutHtml } from "./callout-layouts";

/* ------------------------------------------------------------------ *
 * AST MJML
 * ------------------------------------------------------------------ */

/**
 * ⚠️ `attributes` accepte `boolean`/`number` et pas seulement `string` : l'API JSON de MJML 5
 * valide les attributs booléens par TYPE. `"fluid-on-mobile": "true"` (chaîne) est REFUSÉ,
 * seul `true` passe — vérifié sur mjml@5.4.0.
 */
export type MjmlAttrValue = string | number | boolean;

export interface MjmlNode {
  tagName: string;
  attributes: Record<string, MjmlAttrValue>;
  children?: MjmlNode[];
  content?: string;
}

export interface MjmlRenderResult {
  html: string;
  errors: string[];
}

/* ------------------------------------------------------------------ *
 * Cascade de styles
 * ------------------------------------------------------------------ */

type Box = Required<Spacing>;

interface Resolved {
  fontFamily: string;
  fontSize: number;
  fontSizeMobile?: number;
  lineHeight: number;
  letterSpacing?: number;
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  fontWeight?: string;
  verticalAlign?: "top" | "middle" | "bottom";
  textColor: string;
  /** Couleur et police des TITRES : la cascade de la rangée au bloc, sinon `theme.heading*`, sinon le texte. */
  headingColor: string;
  headingFont: string;
  linkColor: string;
  align: Align;
  backgroundColor?: string;
  padding: Box;
  paddingMobile?: Spacing;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  hideOnMobile: boolean;
}

const pick = <K extends keyof BoxStyle>(
  key: K,
  fallback: NonNullable<BoxStyle[K]>,
  ...layers: (BoxStyle | undefined)[]
): NonNullable<BoxStyle[K]> => {
  for (let i = layers.length - 1; i >= 0; i--) {
    const v = layers[i]?.[key];
    if (v !== undefined) return v as NonNullable<BoxStyle[K]>;
  }
  return fallback;
};

const optional = <K extends keyof BoxStyle>(
  key: K,
  ...layers: (BoxStyle | undefined)[]
): BoxStyle[K] => {
  for (let i = layers.length - 1; i >= 0; i--) {
    const v = layers[i]?.[key];
    if (v !== undefined) return v;
  }
  return undefined;
};

/** Fusionne les paddings côté par côté, de la couche la plus générale à la plus spécifique. */
function mergePadding(base: Box, ...layers: (Spacing | undefined)[]): Box {
  const out: Box = { ...base };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.top !== undefined) out.top = layer.top;
    if (layer.right !== undefined) out.right = layer.right;
    if (layer.bottom !== undefined) out.bottom = layer.bottom;
    if (layer.left !== undefined) out.left = layer.left;
  }
  return out;
}

const box = (s: Spacing, fallback = 0): Box => ({
  top: s.top ?? fallback,
  right: s.right ?? fallback,
  bottom: s.bottom ?? fallback,
  left: s.left ?? fallback,
});

/**
 * Cascade explicite. Deux familles de propriétés, traitées différemment — c'est le cœur de la
 * correction Outlook :
 *  - HÉRITABLES (typo, couleurs, alignement) : theme → row → column → block.
 *  - PROPRES À LA BOÎTE (padding, fond, bordure, masquage mobile) : JAMAIS héritées, sinon le
 *    padding d'une row se rajouterait à celui de chacun de ses blocs.
 */
function resolve(
  theme: Theme,
  defaultPadding: Box,
  own: BoxStyle | undefined,
  inherited: (BoxStyle | undefined)[] = [],
): Resolved {
  const chain = [...inherited, own];
  return {
    fontFamily: pick("fontFamily", theme.fontFamily, ...chain),
    fontSize: pick("fontSize", theme.fontSize, ...chain),
    fontSizeMobile: optional("fontSizeMobile", ...chain),
    lineHeight: pick("lineHeight", theme.lineHeight, ...chain),
    letterSpacing: optional("letterSpacing", ...chain),
    textTransform: optional("textTransform", ...chain),
    fontWeight: optional("fontWeight", ...chain),
    verticalAlign: optional("verticalAlign", ...chain),
    textColor: pick("textColor", theme.textColor, ...chain),
    // ⛔ Le style global des titres (24/09/2026) se glisse ENTRE le thème et la cascade : une couleur
    // ou une police posée sur la rangée, la colonne ou le bloc l'emporte (bandeau sombre intact).
    // Absent, c'est exactement `textColor` / `fontFamily` : rien ne change pour un document existant.
    headingColor: optional("textColor", ...chain) ?? theme.headingColor ?? theme.textColor,
    headingFont: optional("fontFamily", ...chain) ?? theme.headingFont ?? theme.fontFamily,
    linkColor: pick("linkColor", theme.linkColor, ...chain),
    align: pick("align", "left", ...chain),
    // Propres à la boîte : uniquement le style de l'élément lui-même.
    backgroundColor: own?.backgroundColor,
    padding: mergePadding(defaultPadding, own?.padding),
    paddingMobile: own?.paddingMobile,
    borderColor: own?.borderColor ?? theme.borderColor,
    borderWidth: own?.borderWidth ?? 0,
    borderRadius: own?.borderRadius ?? theme.radius,
    hideOnMobile: own?.hideOnMobile ?? false,
  };
}

const padAttr = (p: Box): string => `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;

/**
 * Attributs typographiques hérités, posés sur un `mj-text` UNIQUEMENT quand ils existent.
 *
 * L'omission est ce qui garantit que tous les documents antérieurs compilent octet pour octet :
 * aucun n'en porte, aucun attribut n'est donc ajouté à leur HTML.
 * ⛔ Ne pas verser ça dans `common` : il sert aussi à `mj-image` et `mj-divider`, où ces attributs
 * n'existent pas et remonteraient dans `errors`.
 */
function typoAttrs(r: Resolved): Record<string, MjmlAttrValue> {
  const a: Record<string, MjmlAttrValue> = {};
  if (r.letterSpacing !== undefined) a["letter-spacing"] = `${r.letterSpacing}px`;
  if (r.textTransform !== undefined) a["text-transform"] = r.textTransform;
  if (r.fontWeight !== undefined) a["font-weight"] = r.fontWeight;
  return a;
}

/**
 * Les mêmes, en déclarations CSS pour un style inline.
 *
 * Nécessaire EN PLUS des attributs : le moteur Word n'hérite pas de façon fiable du conteneur, et
 * une cellule qui pose sa propre typo (tous les blocs-cartes le font) coupe l'héritage CSS.
 */
function typoCss(r: Resolved): string {
  const out: string[] = [];
  if (r.letterSpacing !== undefined) out.push(`letter-spacing:${r.letterSpacing}px`);
  if (r.textTransform !== undefined) out.push(`text-transform:${r.textTransform}`);
  return out.length === 0 ? "" : `${out.join(";")};`;
}

/* ------------------------------------------------------------------ *
 * Presets typographiques
 * ------------------------------------------------------------------ */

interface PresetSpec {
  tag: string;
  size: (theme: Theme) => number;
  weight: string;
  lineHeight: number;
}

const PRESETS: Record<TextPreset, PresetSpec> = {
  h1: { tag: "h1", size: () => 28, weight: "700", lineHeight: 1.25 },
  h2: { tag: "h2", size: () => 22, weight: "700", lineHeight: 1.3 },
  h3: { tag: "h3", size: () => 18, weight: "600", lineHeight: 1.35 },
  body: { tag: "p", size: (t) => t.fontSize, weight: "400", lineHeight: 1.55 },
  small: { tag: "p", size: () => 13, weight: "400", lineHeight: 1.5 },
};

/** Les presets qui sont des TITRES : ils suivent `theme.headingColor` / `headingFont` (24/09/2026). */
const PRESETS_TITRE: ReadonlySet<TextPreset> = new Set<TextPreset>(["h1", "h2", "h3"]);

/**
 * Le preset effectif : la table ci-dessus, corrigée par `theme.textPresets` (22/09/2026) clé par
 * clé. Sans réglage, c'est l'objet de la table lui-même — rien ne change pour un thème qui n'en a pas.
 * La balise (`h1`, `p`…) n'est pas réglable : elle porte le sens du texte, pas son apparence.
 */
function presetOf(theme: Theme, name: TextPreset): PresetSpec {
  const base = PRESETS[name];
  const reglage = theme.textPresets?.[name];
  if (reglage === undefined) return base;
  const taille = reglage.size;
  return {
    tag: base.tag,
    size: taille === undefined ? base.size : () => taille,
    weight: reglage.weight ?? base.weight,
    lineHeight: reglage.lineHeight ?? base.lineHeight,
  };
}

/** MJML n'embarque une icône native que pour ces réseaux. */
const MJML_SOCIAL_ICONS = new Set(["facebook", "instagram", "twitter", "youtube", "linkedin", "web"]);

/* ------------------------------------------------------------------ *
 * Contexte de compilation
 * ------------------------------------------------------------------ */

interface Ctx {
  theme: Theme;
  /** Seuil du côte-à-côte des colonnes, en px : `theme.columnBreakpoint`, sinon celui de MJML. */
  columnBreakpoint: number;
  /** Règles injectées dans le `<style>` du head (media queries UNIQUEMENT — plafond Gmail 16 Ko). */
  mobileCss: string[];
  /**
   * Règles « écran large » des cartes en vignette, émises sous `min-width:${COLUMN_BREAKPOINT}px`
   * dans un `<style>` À PART (cf. `headNode`). Sens inverse de `mobileCss` : ici le HTML est
   * mobile par défaut et c'est le côte-à-côte qu'on ajoute — cf. `sideBySide`.
   */
  desktopCss: string[];
  /**
   * Règles « colonnes empilées » : émises sous `max-width:${columnBreakpoint − 1}px`, le seuil où MJML
   * empile ses colonnes (et où son `fluid-on-mobile` agissait). Aucune ne touche l'écran large, pas
   * même à 600 px, que la media query de `mobileCss` atteint encore. Cf. `centrerImageEmpilee`.
   */
  stackedCss: string[];
  /**
   * Gabarits de côte-à-côte déjà émis : `largeur|vignette|écart` → classe. Une édition a autant de
   * cartes en vignette que d'articles et elles partagent TOUTES le même gabarit ; sans ce cache,
   * chacune ajoutait ses trois règles identiques au head. Mesuré le 22/09/2026 sur l'édition
   * Copper Kettle du jour : 12 règles pour 4 cartes, ~1,2 Ko de `<style>` pour zéro information —
   * du poids pris sur les 102 Ko au-delà desquels Gmail tronque le message.
   */
  colClasses: Map<string, string>;
  /** Fonds de conteneurs sans texte à ré-affirmer en thème sombre : couleur → classe CSS (dédupliqué par couleur). */
  darkKeep: Map<string, string>;
  warnings: string[];
  seq: number;
}

/** Types de blocs qui ne portent AUCUN texte : seuls eux rendent un conteneur épinglable (cf. `pinClass`). */
const BLOCS_SANS_TEXTE = new Set(["image", "spacer", "divider"]);

/**
 * Classe qui ÉPINGLE le fond d'un conteneur SANS TEXTE contre le thème sombre des clients mail.
 *
 * Pourquoi : un client en thème sombre recolore l'e-mail lui-même, et un logo PNG TRANSPARENT montre
 * le fond que le client a choisi, pas celui du modèle. Mesuré le 23/09/2026 : les 4 logos de marque
 * en base sont transparents à 73-76 % ; celui de Copper Kettle a un lettrage #F8F8F8 invisible dès que
 * son fond s'éclaircit, celui de Northwind Sports du noir et un bordeaux invisibles dès que le sien s'assombrit.
 * C'est le FILET DE SÉCURITÉ sous la déclaration `light only` (cf. `headNode`), pour les clients qui
 * recolorent quand même. L'épingle est posée par deux chemins complémentaires dans `headNode` :
 *  - `linear-gradient` HORS media query : Gmail ignore la media query mais ne recolore pas un dégradé
 *    sombre (⚠️ Gmail Android assombrit un dégradé qu'il juge clair — rapporté le 30/01/2024 dans
 *    hteumeuleu/email-bugs#68 : l'épingle d'un fond clair y est sans effet, jamais nuisible) ;
 *  - un bloc `prefers-color-scheme: dark` (Apple Mail, Outlook.com, Outlook mobile).
 * `[data-ogsb]` d'Outlook.com n'est PAS utilisé : Outlook.com n'accepte ce sélecteur que seul ou
 * avec un sélecteur d'élément (hteumeuleu.com, 26/02/2021), donc pas avec nos classes.
 *
 * ⛔ STRICTEMENT limité aux conteneurs SANS TEXTE (rangée d'images, bloc image, filet, espaceur).
 * Épingler un fond sans épingler aussi la couleur du texte — que le client, lui, a déjà inversée —
 * donne du texte illisible : c'est la mise en garde de Litmus, et nos couleurs de texte sont inline
 * dans trente endroits, impossible de les ré-affirmer proprement depuis le head. Sans texte, ce cas ne
 * peut pas se produire : ce qu'on y peint (image, filet) n'est jamais lu en contraste d'un texte.
 *
 * ⚠️ PLUS DE SEUIL DE LUMINANCE (23/09/2026). Jusque-là seuls les bandeaux SOMBRES étaient épinglés ;
 * or le seuil ne protégeait que du cas « texte », que le critère « sans texte » exclut déjà, et il
 * laissait le logo sombre d'une marque claire (Northwind Sports) disparaître sur un fond assombri.
 *
 * Dédupliqué par couleur : dix conteneurs du même fond partagent une classe et une seule règle —
 * le `<style>` du head est plafonné à 16 Ko chez Gmail.
 */
function pinClass(ctx: Ctx, color: string | undefined): string | undefined {
  if (!color) return undefined;
  const key = color.trim().toLowerCase();
  // On n'épingle que des couleurs littérales `#rgb`/`#rrggbb` : le reste finirait en sélecteur invalide.
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(key)) return undefined;
  const known = ctx.darkKeep.get(key);
  if (known) return known;
  const cls = `nf-bg-${key.slice(1)}`;
  ctx.darkKeep.set(key, cls);
  return cls;
}

/** Une rangée ne portant que des images / filets / espaceurs : aucun texte que le client puisse inverser. */
const rangeeSansTexte = (row: Row): boolean => {
  const blocs = row.columns.flatMap((col) => col.blocks);
  return blocs.length > 0 && blocs.every((b) => BLOCS_SANS_TEXTE.has(b.type));
};

/**
 * Une rangée sans texte est épinglée quand son fond COMPTE : posé par l'auteur, ou sous une image.
 * ⛔ Pas une rangée de filet ou d'espaceur sur le fond du contenu : épinglée, elle resterait claire au
 * milieu d'un e-mail que Gmail a inversé — une bande blanche que le modèle n'a pas, sans rien sauver.
 */
const rangeeAEpingler = (row: Row): boolean =>
  rangeeSansTexte(row) &&
  (row.style?.backgroundColor !== undefined || row.columns.some((col) => col.blocks.some((b) => b.type === "image")));

const cssId = (ctx: Ctx, prefix: string): string => `nf-${prefix}-${(ctx.seq++).toString(36)}`;

/**
 * Overrides mobiles d'un niveau : classe dédiée + règles dans la media query du `<style>` du head.
 * Renvoie la classe à poser sur le nœud, ou `undefined` si le niveau n'a aucun override.
 *
 * ⚠️ `where` dit OÙ MJML pose la classe, et c'est toute la difficulté :
 *  - `"cell"` (bloc) : la classe atterrit directement sur le `<td>` qui porte le padding, une
 *    règle suffit donc.
 *  - `"wrapper"` (row / column) : elle atterrit sur le `<div>` extérieur, et le padding est porté
 *    par `div > table > tbody > tr > td`. D'où le sélecteur enfant : un `.cls td` toucherait AUSSI
 *    les cellules des cartes imbriquées (pick, promo, standings) et démolirait leur mise en page
 *    sous 600px. Structure vérifiée sur mjml@5.4.0.
 *
 * ⚠️ ORDRE D'APPEL = ORDRE DE CASCADE. Les règles sortent dans l'ordre où elles sont poussées et
 * ont toutes la même spécificité pour la typo : row, PUIS column, PUIS bloc — le plus spécifique
 * doit être poussé en dernier pour gagner.
 */
function mobileClass(
  ctx: Ctx,
  prefix: string,
  where: "cell" | "wrapper",
  fontSizeMobile: number | undefined,
  paddingMobile: Spacing | undefined,
): string | undefined {
  if (fontSizeMobile === undefined && paddingMobile === undefined) return undefined;

  const font = fontSizeMobile === undefined ? [] : [`font-size:${fontSizeMobile}px !important`];
  const pad: string[] = [];
  if (paddingMobile) {
    if (paddingMobile.top !== undefined) pad.push(`padding-top:${paddingMobile.top}px !important`);
    if (paddingMobile.right !== undefined) pad.push(`padding-right:${paddingMobile.right}px !important`);
    if (paddingMobile.bottom !== undefined) pad.push(`padding-bottom:${paddingMobile.bottom}px !important`);
    if (paddingMobile.left !== undefined) pad.push(`padding-left:${paddingMobile.left}px !important`);
  }
  if (font.length === 0 && pad.length === 0) return undefined;

  const cls = cssId(ctx, prefix);
  if (where === "cell") {
    ctx.mobileCss.push(`.${cls}, .${cls} td, .${cls} div { ${[...font, ...pad].join(";")}; }`);
  } else {
    if (pad.length > 0) ctx.mobileCss.push(`.${cls} > table > tbody > tr > td { ${pad.join(";")}; }`);
    if (font.length > 0) ctx.mobileCss.push(`.${cls}, .${cls} td, .${cls} div { ${font.join(";")}; }`);
  }
  return cls;
}

/**
 * Centre, colonnes empilées, une image à taille réglée alignée à gauche ou à droite (24/09/2026).
 *
 * Tant que `fluid-on-mobile` passait toute image à 100 % de sa colonne, l'alignement ne se voyait pas
 * sur mobile : l'image remplissait la ligne. Rendue à sa taille réglée, le logo « Giro do Tricolor »
 * (aligné à gauche dans la moitié gauche d'un 1-1, marges 32 / 0) restait collé à gauche une fois la
 * colonne empilée. Alix : « garder une taille normale et CENTRER ». L'écran large ne change pas.
 *  - `> table { margin:auto }` : la table MJML de l'image est l'enfant direct de la cellule qui porte
 *    la classe ; des marges auto la centrent malgré le `align="left"` de la cellule ;
 *  - marges latérales égales, la plus grande des deux (mobiles si l'auteur en a réglé) : centrer
 *    entre 32 et 0 px laisserait le logo 16 px à droite du milieu de l'écran.
 * Classe nommée par la marge et non par `cssId` : un compteur décalerait la numérotation de toutes les
 * classes suivantes du document ; ici dix images partagent une règle, et rien d'autre ne bouge.
 */
function centrerImageEmpilee(ctx: Ctx, pad: Box, padMobile: Spacing | undefined): string {
  const marge = Math.max(padMobile?.left ?? pad.left, padMobile?.right ?? pad.right);
  const cls = `nf-img-c${marge}`;
  const regle = `.${cls} { padding-left:${marge}px !important; padding-right:${marge}px !important; }`;
  if (!ctx.stackedCss.includes(regle)) {
    ctx.stackedCss.push(regle, `.${cls} > table { margin-left:auto !important; margin-right:auto !important; }`);
  }
  return cls;
}

/* ------------------------------------------------------------------ *
 * Largeurs de colonnes — l'arithmétique des ghost tables
 * ------------------------------------------------------------------ */

/** Pourcentages exacts (le dernier absorbe l'arrondi pour que la somme fasse pile 100). */
export function columnPercents(layout: RowLayout): string[] {
  const weights = LAYOUT_WEIGHTS[layout];
  const total = weights.reduce((a, b) => a + b, 0);
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < weights.length; i++) {
    if (i === weights.length - 1) {
      out.push(`${round6(100 - used)}%`);
    } else {
      const pct = round6(((weights[i] as number) / total) * 100);
      used += pct;
      out.push(`${pct}%`);
    }
  }
  return out;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Largeur utile en px à l'intérieur d'un bloc — sert à contraindre les images par attribut. */
function innerWidthPx(theme: Theme, layout: RowLayout, index: number, rowPad: Box, colPad: Box, blockPad: Box): number {
  const weights = LAYOUT_WEIGHTS[layout];
  const total = weights.reduce((a, b) => a + b, 0);
  const rowInner = theme.contentWidth - rowPad.left - rowPad.right;
  const colWidth = Math.floor((rowInner * (weights[index] as number)) / total);
  const inner = colWidth - colPad.left - colPad.right - blockPad.left - blockPad.right;
  return Math.max(40, inner);
}

/* ------------------------------------------------------------------ *
 * Rendu du texte riche (aucun HTML libre ne peut fuiter)
 * ------------------------------------------------------------------ */

function spansToHtml(paragraph: Paragraph, linkColor: string): string {
  return paragraph.spans
    .map((span) => {
      // Maj+Entree dans l'editeur inline stocke un saut de ligne DANS le texte du span : le schema
      // n'a pas de noeud saut-de-ligne. Sans cette conversion le saut se reduisait a une espace dans
      // l'email HTML alors qu'il survivait dans la version texte — les deux rendus divergeaient.
      let html = multiline(span.text);
      if (span.bold) html = `<strong>${html}</strong>`;
      if (span.italic) html = `<em>${html}</em>`;
      if (span.underline) html = `<u>${html}</u>`;
      // `<s>` et pas `text-decoration:line-through` sur un `<span>` : Word (Outlook) honore la
      // balise, alors qu'il jette la déclaration CSS sur un élément inline.
      if (span.strike) html = `<s>${html}</s>`;
      if (span.color) html = `<span style="color:${span.color};">${html}</span>`;
      if (span.href) {
        const color = span.color ?? linkColor;
        html = `<a href="${escapeHtml(span.href)}" style="color:${color};text-decoration:underline;" target="_blank">${html}</a>`;
      }
      return html;
    })
    .join("");
}

function paragraphsToHtml(
  paragraphs: Paragraph[],
  preset: PresetSpec,
  r: Resolved,
  size: number,
  lh: number,
  gap = 12,
): string {
  return paragraphs
    .map((p, i) => {
      const last = i === paragraphs.length - 1;
      // `Margin` avec un M majuscule : contournement documenté du moteur Word d'Outlook.
      // `gap` = `paragraphSpacing` du bloc, 12 px quand il est absent.
      const style = [
        `Margin:0 0 ${last ? 0 : gap}px 0`,
        "mso-line-height-rule:exactly",
        `font-size:${size}px`,
        `line-height:${lh}`,
        `font-weight:${r.fontWeight ?? preset.weight}`,
        `color:${r.textColor}`,
      ].join(";");
      return `<${preset.tag} style="${style};${typoCss(r)}">${spansToHtml(p, r.linkColor)}</${preset.tag}>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ *
 * Blocs métier — tout en TABLEAUX
 *
 * Ces blocs sortent en HTML brut à l'intérieur d'un `mj-text` : MJML n'a pas de composant « carte »,
 * et une carte, en email, c'est un tableau. Aucun flex ni grid (moteur Word), aucune `margin`
 * (Outlook l'écrase) — uniquement du padding de cellule et des largeurs en PIXELS : un pourcentage
 * se recalcule différemment sous Word et décale les colonnes hors de la carte.
 *
 * ⛔ Et surtout : rien n'est calculé ni complété. On pose les chaînes du document, point.
 * ------------------------------------------------------------------ */

/** Padding horizontal interne d'une carte. */
const CARD_PAD_X = 16;
/** Padding vertical (haut de la première ligne, bas de la dernière). */
const CARD_PAD_Y = 16;
/** Écart vertical entre deux lignes d'une carte. */
const CARD_GAP = 10;

const OPEN_TABLE = `<table role="presentation" border="0" cellpadding="0" cellspacing="0"`;

/**
 * ⛔ TABLE HYBRIDE (23/09/2026) — le STYLE de largeur d'une table de bloc : `width:100%;max-width:<W>px`.
 * L'ATTRIBUT `width="<W>"` reste posé à côté, en px : c'est lui, et lui seul, que lit Outlook/Word.
 * Un `width:<W>px` en style imposait W px à tout l'e-mail sur un téléphone : mesuré le 23/09/2026, 71
 * documents réels sur 125 (71 versions de modèles sur 118) débordaient à 375 px, jusqu'à 604 px
 * de large. Au bureau, le conteneur d'un bloc vaut W — ou un peu plus dans une colonne de largeur
 * fractionnaire, que le plafond ramène à W : rendu inchangé au pixel (Chromium et WebKit, 600 et 700 px).
 * `fluide: false` rend le px d'avant — cf. `tableInterieure` pour le seul cas qui le garde.
 * ⚠️ Ne pas repasser une largeur en px dans le `style` d'une TABLE : `blocs-natifs.test.ts` le refuse.
 *
 * ⛔ LES CELLULES, ELLES, GARDENT LEUR PX : une cellule à largeur fixe ne force rien, dans une table
 * fluide le navigateur la resserre jusqu'à son contenu (mesuré à 375 px, Chromium et WebKit). Un % ne
 * retombe PAS toujours sur le px au bureau — essayé et mesuré le 23/09/2026 :
 *  - un % est la part de la COLONNE, padding compris ; un px, la largeur du CONTENU : le texte d'un
 *    encart à vignette perdait ses 14 px de marge et repassait à la ligne, les colonnes du classement
 *    (8 px de padding chacune) se décalaient jusqu'à 9 px ;
 *  - même sans padding, WebKit tronque `largeur × % / 100` au 1/64 de px : la cote d'un pick (150 px
 *    sur 560) glissait d'un souffle, 6 px d'anticrénelage différents.
 * La barre à segments (1.6.1) garde ses % : ses cellules sont vides, et ses parts SONT des %.
 */
const largeurTable = (w: number, fluide = true): string => (fluide ? `width:100%;max-width:${w}px` : `width:${w}px`);

/**
 * ⛔ LA TABLE INTÉRIEURE D'UN CADRE (24/09/2026) — la ligne d'un pick, les scores d'un bandeau, la
 * vignette d'un encart : sa largeur est la place que lui laisse son cadre, `W − marges − bordures`.
 *
 * Jusqu'en 1.6.2 elle était calculée SANS la bordure : un cadre bordé (le pick par défaut, le bandeau à
 * bordure, l'encart à filet d'accent des Boletín Copper Kettle) était poussé à `W + bordures` et
 * DÉBORDAIT de sa colonne au bureau (mesuré le 23/09/2026 : cadre de 540 px dans une colonne de 536,
 * section de 604 px au lieu de 600) ; laissée en px pour ne pas toucher ce rendu, elle faisait aussi
 * déborder 45 des 125 documents réels à 375 px. DÉCISION D'ALIX (24/09/2026) : le cadre tient dans sa
 * colonne, au prix de 2 à 4 px de moins au bureau. L'attribut `width` (Outlook/Word) suit la même
 * règle : table + marges + bordures = W. Les mises en page d'encart (`callout-layouts.ts`) comptaient
 * déjà la bordure.
 *
 * Fluide (`largeurTable`), sauf quand le plancher de 120 px l'emporte (colonne trop étroite) : elle
 * garde alors son px, comme avant.
 * ⚠️ `bordures` = bordure GAUCHE + bordure DROITE réellement tracées par le cadre. En oublier une rend
 * un cadre plus large que sa colonne : `blocs-natifs.test.ts` le refuse, famille par famille.
 */
const tableInterieure = (width: number, pad: Box, bordures: number): { inner: number; fluide: boolean } => {
  const place = width - pad.left - pad.right - bordures;
  const inner = Math.max(120, place);
  return { inner, fluide: inner === place };
};

const blank = (s: string | undefined): boolean => s === undefined || s.trim() === "";

/** Texte utilisateur → HTML : échappé, sauts de ligne en `<br>`. Aucune balise ne peut fuiter. */
const multiline = (s: string): string => escapeHtml(s).replace(/\r?\n/g, "<br />");

/** `font-family` posée dans un `style="…"` : un guillemet double y refermerait l'attribut. */
const cssFont = (family: string): string => family.replace(/"/g, "'");

const textStyle = (font: string, size: number, weight: string, color: string, lh = 1.5): string =>
  `font-family:${font};font-size:${size}px;line-height:${lh};font-weight:${weight};color:${color};mso-line-height-rule:exactly;`;

/** Marges intérieures d'une carte : les constantes ci-dessus, corrigées côté par côté par `innerPadding`. */
const cardPadding = (innerPadding: Spacing | undefined): Box =>
  mergePadding({ top: CARD_PAD_Y, right: CARD_PAD_X, bottom: CARD_PAD_Y, left: CARD_PAD_X }, innerPadding);

/**
 * Empile des contenus dans une carte : un `<tr>` par ligne, padding constant, bordure optionnelle.
 *
 * `pad`, `gap` et `borderWidth` (22/09/2026) portent les réglages `innerPadding`, `rowGap` et
 * `frameWidth` des blocs pick et promo ; absents, ce sont les constantes du module et un cadre de
 * 1 px — la chaîne produite est alors exactement celle d'avant. `borderWidth: 0` = pas de cadre.
 */
function card(
  parts: string[],
  o: { width: number; align: Align; radius: number; border?: string; background?: string; pad?: Box; gap?: number; borderWidth?: number },
): string {
  const epaisseur = o.borderWidth ?? 1;
  const frame = [
    largeurTable(o.width),
    // `separate` et non `collapse` : un tableau en `collapse` perd son border-radius.
    "border-collapse:separate",
    "border-spacing:0",
    ...(o.border && epaisseur > 0 ? [`border:${epaisseur}px solid ${o.border}`, `border-radius:${o.radius}px`] : []),
    ...(o.background ? [`background-color:${o.background}`] : []),
  ].join(";");
  const p = o.pad ?? cardPadding(undefined);
  const gap = o.gap ?? CARD_GAP;
  const cells = parts
    .map((html, i) => {
      const last = i === parts.length - 1;
      const pad = `${i === 0 ? p.top : gap}px ${p.right}px ${last ? p.bottom : 0}px ${p.left}px`;
      return `<tr><td align="${o.align}" style="padding:${pad};">${html}</td></tr>`;
    })
    .join("");
  return `${OPEN_TABLE} width="${o.width}" style="${frame};">${cells}</table>`;
}

/**
 * Bouton en TABLEAU, sans VML : le padding est porté par la cellule (Word l'honore) et le lien
 * remplit la cellule. Outlook rend les angles droits au lieu d'arrondis — c'est le compromis
 * assumé, un `v:roundrect` ici obligerait à dupliquer tout le contenu de la carte.
 */
/**
 * Réglages du bouton de carte (`cardButtonLook` du schéma). Chaque clé absente rend la valeur d'avant
 * le 22/09/2026 : fond de marque, texte `buttonTextColor`, max(13, taille − 2), 700, 12/22 px, rayon
 * du bloc. `letterSpacing` / `transform` ne sont émis que posés.
 */
interface CtaLook {
  background?: string;
  textColor?: string;
  size?: number;
  weight?: string;
  padding?: Spacing;
  radius?: number;
  letterSpacing?: number;
  transform?: "none" | "uppercase" | "lowercase" | "capitalize";
}

function ctaTable(theme: Theme, r: Resolved, href: string, label: string, look: CtaLook = {}): string {
  const bg = look.background ?? theme.brandColor;
  const fg = look.textColor ?? theme.buttonTextColor;
  const align = r.align === "right" ? "right" : r.align;
  const size = look.size ?? Math.max(13, r.fontSize - 2);
  const font = cssFont(r.fontFamily);
  // Sans réglage, la forme courte « 12px 22px » d'avant : la réécrire en quatre valeurs changerait
  // les octets de tous les boutons déjà publiés pour un rendu identique.
  const pad = look.padding === undefined ? "12px 22px" : padAttr(mergePadding({ top: 12, right: 22, bottom: 12, left: 22 }, look.padding));
  const typo =
    (look.letterSpacing === undefined ? "" : `letter-spacing:${look.letterSpacing}px;`) +
    (look.transform === undefined || look.transform === "none" ? "" : `text-transform:${look.transform};`);
  return (
    `${OPEN_TABLE} align="${align}" style="border-collapse:separate;border-spacing:0;">` +
    `<tr><td align="center" bgcolor="${bg}" style="border-radius:${look.radius ?? r.borderRadius}px;background-color:${bg};padding:${pad};mso-padding-alt:${pad};">` +
    `<a href="${escapeHtml(href)}" target="_blank" style="${textStyle(font, size, look.weight ?? "700", fg, 1.2)}${typo}display:inline-block;text-decoration:none;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

/** Le jeu `cardButtonLook` d'un bloc, sous la forme que lit `ctaTable`. */
const ctaLookOf = (b: {
  ctaBackground?: string;
  ctaTextColor?: string;
  ctaSize?: number;
  ctaWeight?: string;
  ctaPadding?: Spacing;
  ctaRadius?: number;
}): CtaLook => ({
  background: b.ctaBackground,
  textColor: b.ctaTextColor,
  size: b.ctaSize,
  weight: b.ctaWeight,
  padding: b.ctaPadding,
  radius: b.ctaRadius,
});

function pickHtml(block: PickBlock, theme: Theme, r: Resolved, width: number): string {
  const font = cssFont(r.fontFamily);
  const parts: string[] = [];
  // Chaque réglage d'apparence (22/09/2026) retombe sur la valeur d'avant : c'est la hiérarchie
  // historique du pick, clé par clé.
  const pad = cardPadding(block.innerPadding);

  if (!blank(block.kickoffLabel)) {
    parts.push(
      `<div style="${textStyle(font, block.kickoffSize ?? Math.max(11, r.fontSize - 4), "700", block.kickoffColor ?? theme.mutedColor, 1.4)}text-transform:${block.kickoffTransform ?? "uppercase"};letter-spacing:0.6px;">${escapeHtml(block.kickoffLabel as string)}</div>`,
    );
  }

  // Ligne principale : libellés à gauche, cote à droite. Deux cellules à largeur FIXE en px, dans une
  // table hybride qui tient DANS le cadre, bordure comprise (`tableInterieure` ; 1 px par défaut, cf. `card`).
  const { inner, fluide } = tableInterieure(width, pad, 2 * (block.frameWidth ?? 1));
  const hasOdds = !blank(block.oddsLabel);
  const oddsW = hasOdds ? Math.min(150, Math.max(64, Math.round(inner * 0.3))) : 0;
  const labelW = inner - oddsW;

  const labels =
    (blank(block.matchLabel)
      ? ""
      : `<div style="${textStyle(font, block.matchSize ?? r.fontSize + 1, "700", block.matchColor ?? r.textColor, 1.35)}">${escapeHtml(block.matchLabel)}</div>`) +
    (blank(block.marketLabel)
      ? ""
      : `<div style="${textStyle(font, block.marketSize ?? Math.max(11, r.fontSize - 4), "400", block.marketColor ?? theme.mutedColor, 1.4)}padding-top:4px;">${escapeHtml(block.marketLabel)}</div>`) +
    (blank(block.selectionLabel)
      ? ""
      : `<div style="${textStyle(font, block.selectionSize ?? r.fontSize, "700", block.selectionColor ?? theme.brandColor, 1.4)}padding-top:2px;">${escapeHtml(block.selectionLabel)}</div>`);

  const oddsBg = block.oddsBackground ?? theme.brandColor;
  const odds = hasOdds
    ? `${OPEN_TABLE} align="right" style="border-collapse:separate;border-spacing:0;">` +
      `<tr><td align="center" bgcolor="${oddsBg}" style="border-radius:${r.borderRadius}px;background-color:${oddsBg};padding:8px 12px;${textStyle(font, block.oddsSize ?? r.fontSize + 1, "700", block.oddsTextColor ?? theme.buttonTextColor, 1.2)}white-space:nowrap;">${escapeHtml(block.oddsLabel)}</td></tr></table>`
    : "";

  parts.push(
    `${OPEN_TABLE} width="${inner}" style="${largeurTable(inner, fluide)};border-collapse:collapse;"><tr>` +
      `<td align="left" width="${labelW}" valign="middle" style="width:${labelW}px;">${labels}</td>` +
      (hasOdds ? `<td align="right" width="${oddsW}" valign="middle" style="width:${oddsW}px;">${odds}</td>` : "") +
      `</tr></table>`,
  );

  if (!blank(block.confidenceLabel)) {
    parts.push(
      `<div style="${textStyle(font, block.confidenceSize ?? Math.max(11, r.fontSize - 4), "400", block.confidenceColor ?? theme.mutedColor, 1.45)}">${escapeHtml(block.confidenceLabel as string)}</div>`,
    );
  }

  // Pas de CTA sans lien ET libellé : un bouton mort dans un email se paie en désabonnements.
  if (!blank(block.href) && !blank(block.ctaLabel)) {
    parts.push(ctaTable(theme, r, block.href as string, block.ctaLabel as string, ctaLookOf(block)));
  }

  return card(parts, {
    width,
    align: r.align,
    radius: r.borderRadius,
    border: block.frameColor ?? r.borderColor,
    pad,
    gap: block.rowGap,
    borderWidth: block.frameWidth,
  });
}

function oddsTableHtml(block: OddsTableBlock, theme: Theme, r: Resolved, width: number): string {
  const font = cssFont(r.fontFamily);
  // Réglages du 22/09/2026 ; absents = les valeurs d'avant (max(12, fs−1), 400/700, 9 px, filet de 1 px).
  const size = block.textSize ?? Math.max(12, r.fontSize - 1);
  const filet = block.ruleWidth ?? 1;
  const padY = block.rowPadding ?? 9;
  const body = block.rows
    .map((line, i) => {
      const last = i === block.rows.length - 1;
      const edge = last || filet === 0 ? "" : `border-bottom:${filet}px solid ${r.borderColor};`;
      return (
        `<tr>` +
        `<td align="left" style="padding:${padY}px 0;${edge}${textStyle(font, size, block.labelWeight ?? "400", r.textColor, 1.4)}">${escapeHtml(line.label)}</td>` +
        `<td align="right" style="padding:${padY}px 0;${edge}${textStyle(font, size, block.valueWeight ?? "700", block.valueColor ?? r.textColor, 1.4)}white-space:nowrap;">${escapeHtml(line.value)}</td>` +
        `</tr>`
      );
    })
    .join("");
  const caption = blank(block.caption)
    ? ""
    : `<tr><td colspan="2" align="left" style="padding:10px 0 0 0;${textStyle(font, block.captionSize ?? Math.max(11, r.fontSize - 4), "400", block.captionColor ?? theme.mutedColor, 1.45)}">${multiline(block.caption as string)}</td></tr>`;
  return `${OPEN_TABLE} width="${width}" style="${largeurTable(width)};border-collapse:collapse;">${body}${caption}</table>`;
}

function standingsHtml(block: StandingsBlock, theme: Theme, r: Resolved, width: number): string {
  const font = cssFont(r.fontFamily);
  // Réglages du 22/09/2026 ; absents = les valeurs d'avant, clé par clé.
  const size = block.textSize ?? Math.max(12, r.fontSize - 2);
  const filet = block.ruleWidth ?? 1;
  const filetTete = block.headerRuleWidth ?? 2;
  const count = block.columns.length;
  // La 1re colonne (nom) prend l'essentiel, les autres se partagent le reste à parts égales.
  // ⚠️ `width * 0.44` et pas `width * 44 / 100` pour le défaut : les deux flottants peuvent différer
  // au dernier bit, et un arrondi à .5 changerait alors une largeur déjà publiée.
  const firstW =
    block.firstColumnPct === undefined ? Math.round(width * 0.44) : Math.round((width * block.firstColumnPct) / 100);
  const restW = Math.max(32, Math.floor((width - firstW) / Math.max(1, count - 1)));
  const widthOf = (i: number): number => (i === 0 ? width - restW * (count - 1) : restW);
  const alignOf = (i: number): string => (i === 0 ? "left" : "center");

  // Les cellules d'en-tête gardent leur px, la table seule est hybride : cf. `largeurTable`.
  const head =
    `<tr>` +
    block.columns
      .map(
        (label, i) =>
          `<td align="${alignOf(i)}" width="${widthOf(i)}" style="width:${widthOf(i)}px;padding:0 4px 8px 4px;${filetTete > 0 ? `border-bottom:${filetTete}px solid ${r.borderColor};` : ""}${textStyle(font, block.headerSize ?? Math.max(10, size - 1), "700", block.headerColor ?? theme.mutedColor, 1.3)}text-transform:${block.headerTransform ?? "uppercase"};letter-spacing:0.5px;">${escapeHtml(label)}</td>`,
      )
      .join("") +
    `</tr>`;

  // Une ligne trop courte est COMPLÉTÉE par du vide : on n'invente jamais la cellule manquante.
  const body = block.rows
    .map((cells, ri) => {
      const last = ri === block.rows.length - 1;
      const edge = last || filet === 0 ? "" : `border-bottom:${filet}px solid ${r.borderColor};`;
      return (
        `<tr>` +
        block.columns
          .map((_, i) => {
            const value = cells[i] ?? "";
            const weight = i === 0 ? (block.firstColumnWeight ?? "600") : "400";
            return `<td align="${alignOf(i)}" style="padding:${block.rowPadding ?? 8}px 4px;${edge}${textStyle(font, size, weight, r.textColor, 1.4)}">${escapeHtml(value)}</td>`;
          })
          .join("") +
        `</tr>`
      );
    })
    .join("");

  const caption = blank(block.caption)
    ? ""
    : `<tr><td colspan="${count}" align="left" style="padding:10px 4px 0 4px;${textStyle(font, block.captionSize ?? Math.max(11, r.fontSize - 4), "400", block.captionColor ?? theme.mutedColor, 1.45)}">${multiline(block.caption as string)}</td></tr>`;

  return `${OPEN_TABLE} width="${width}" style="${largeurTable(width)};border-collapse:collapse;">${head}${body}${caption}</table>`;
}

/**
 * `fluid` : l'image suit la largeur de sa colonne SANS plafond en px — c'est ce qui la fait passer
 * pleine largeur quand la vignette s'empile sur mobile. L'attribut `width` reste la largeur
 * d'écran large : c'est lui, et lui seul, qu'Outlook (moteur Word) lit.
 */
function imgTag(src: string, alt: string, widthPx: number, radius: number, fluid = false): string {
  return (
    `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${widthPx}" border="0" ` +
    `style="display:block;width:100%;max-width:${fluid ? "100%" : `${widthPx}px`};height:auto;border:0;outline:none;text-decoration:none;${radius > 0 ? `border-radius:${radius}px;` : ""}">`
  );
}

/**
 * Seuil au-delà duquel deux colonnes se posent côte à côte. C'est le défaut de MJML
 * (`mj-breakpoint` n'est pas posé dans ce compilateur) : les cartes en vignette s'empilent donc au
 * MÊME point que les rangées à plusieurs colonnes du document.
 */
const COLUMN_BREAKPOINT = 480;

/**
 * Deux colonnes « vignette + texte » à la manière de `mj-column` — MOBILE PAR DÉFAUT.
 *
 * ⛔ POURQUOI PAS UN TABLEAU À DEUX CELLULES + `@media (max-width)`, comme avant le 22/09/2026. Ce
 * montage-là ne s'empilait QUE si le client appliquait le `<style>` du head. Constaté sur l'appli
 * Gmail iOS : la carte restait côte à côte, texte écrasé dans une colonne étroite. Tout client qui
 * ignore le `<style>` (Gmail avec un compte non Google, entre autres) faisait pareil ; et même
 * quand la règle s'appliquait, la vignette gardait son `max-width` d'écran large au lieu de passer
 * pleine largeur. Ici l'ordre est renversé, exactement comme MJML le fait pour ses colonnes :
 *  • SANS aucun CSS de head, chaque colonne est un `inline-block` à 100 % : la vignette pleine
 *    largeur AU-DESSUS du texte — le rendu mobile demandé, qui ne dépend plus de rien ;
 *  • la règle `min-width:${COLUMN_BREAKPOINT}px` (dans un `<style>` à part, cf. `headNode`) remet
 *    les deux colonnes côte à côte sur écran large, en POURCENTAGES comme `mj-column`, donc sans
 *    débordement si la fenêtre est un peu plus étroite que le gabarit ;
 *  • Outlook desktop, qui ne lit aucune media query, reçoit une ghost table `mso` à largeurs fixes.
 * Contrepartie assumée, la même que pour toutes les colonnes MJML : un client d'écran large qui
 * jetterait le `<style>` montre la carte empilée — lisible, jamais écrasée.
 *
 * `first` passe en tête dans le DOM, donc au-dessus une fois empilé.
 */
function sideBySide(
  ctx: Ctx,
  width: number,
  /** `stackGap` : l'espace sous la vignette une fois empilée (`imageGap` de l'article), 12 px absent. */
  first: { html: string; width: number; gap: number; stackGap?: number },
  second: { html: string; width: number; css: string },
): string {
  const firstCol = first.width + first.gap;
  const pct = round6((firstCol / width) * 100);
  // Deux cartes de même gabarit partagent la même classe : les règles ne dépendent que des largeurs.
  const clef = `${width}|${firstCol}|${first.gap}`;
  let cls = ctx.colClasses.get(clef);
  if (cls === undefined) {
    cls = cssId(ctx, "col");
    ctx.colClasses.set(clef, cls);
    ctx.desktopCss.push(
      `.${cls}-a { width:${pct}% !important; max-width:${pct}% !important; }`,
      `.${cls}-b { width:${round6(100 - pct)}% !important; max-width:${round6(100 - pct)}% !important; }`,
      // L'écart vignette/texte : sous la vignette quand on empile, à sa droite quand on ne l'empile pas.
      `.${cls}-g { padding:0 ${first.gap}px 0 0 !important; }`,
    );
  }
  const col = "display:inline-block;vertical-align:top;width:100%;max-width:100%;";
  return (
    // `font-size:0` : deux `inline-block` séparés par un blanc laisseraient une espace entre eux, et
    // la somme dépasserait 100 % — la seconde colonne tomberait sous la première sur écran large.
    `<div style="font-size:0;text-align:left;">` +
    `<!--[if mso | IE]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="${width}" style="width:${width}px;"><tr><td width="${firstCol}" valign="top" style="width:${firstCol}px;"><![endif]-->` +
    `<div class="${cls}-a" style="${col}">` +
    `${OPEN_TABLE} width="100%" style="width:100%;border-collapse:collapse;"><tr>` +
    `<td class="${cls}-g" align="left" valign="top" style="padding:0 0 ${first.stackGap ?? 12}px 0;mso-padding-alt:0 ${first.gap}px 0 0;">${first.html}</td>` +
    `</tr></table></div>` +
    `<!--[if mso | IE]></td><td width="${second.width}" valign="top" style="width:${second.width}px;"><![endif]-->` +
    `<div class="${cls}-b" style="${col}${second.css}">${second.html}</div>` +
    `<!--[if mso | IE]></td></tr></table><![endif]-->` +
    `</div>`
  );
}

/**
 * Une carte d'article : surtitre, image, titre, chapeau, ligne de pied, lien.
 *
 * ⛔ ORDRE DU SURTITRE. En pleine largeur il passe AU-DESSUS de l'image (c'est la une des trois
 * maquettes : « Destacada », « News », « Libertadores », puis la photo). En vignette il entre dans
 * la colonne de texte, au-dessus du titre. Le même champ, deux places — parce que c'est la même
 * information : de quoi parle cette carte.
 *
 * ⛔ NEUTRALITÉ DES CLÉS D'APPARENCE. Absentes, elles laissent le rendu à son défaut :
 * `titleFont`→`font`, `titleSize`→`fontSize+3`, `titleWeight`→"700", `titleLineHeight`→1.3,
 * surtitre et pied absents. ⚠️ Deux défauts ont CHANGÉ le 22/09/2026 (`COMPILER_VERSION` 1.4.0) :
 * le lien de lecture sans `ctaStyle` est un bouton (`articleCta`), et la vignette latérale
 * s'empile sur mobile en pleine largeur (`sideBySide`).
 */
function articleHtml(block: ArticleBlock, ctx: Ctx, r: Resolved, width: number): string {
  const theme = ctx.theme;
  const font = cssFont(r.fontFamily);
  const titleFont = cssFont(block.titleFont ?? r.headingFont);

  // Le surtitre porte la casse et l'interlettrage du bloc — et lui seul : posés sur le conteneur,
  // ils sortiraient le titre et le chapeau en capitales espacées.
  // L'accent du surtitre est un `<span>` DANS le même div : l'heure de Northwind Sports doit rester sur la
  // ligne de la catégorie, à la même ligne de base. Un second div la ferait passer dessous.
  const kickerAccent = blank(block.kickerAccent)
    ? ""
    : `<span style="color:${block.kickerAccentColor ?? theme.brandColor};">${multiline(block.kickerAccent as string)}</span>`;
  // Espacements de la carte (22/09/2026) : absents, les 5/12/6/8/10 px et l'écart de 14 px d'avant.
  const kickerGap = block.kickerGap ?? 5;
  const imageGap = block.imageGap ?? 12;
  const kicker =
    blank(block.kicker) && kickerAccent === ""
      ? ""
      : `<div style="${textStyle(cssFont(block.kickerFont ?? r.fontFamily), block.kickerSize ?? Math.max(10, r.fontSize - 4), r.fontWeight ?? "700", block.kickerColor ?? theme.mutedColor, 1.35)}${typoCss(r)}padding-bottom:${kickerGap}px;">${blank(block.kicker) ? "" : multiline(block.kicker as string)}${kickerAccent}</div>`;

  // `display:block` sur l'ancre : sans lui, un titre-lien ne prend que la largeur de son texte et
  // la zone cliquable devient un ruban irrégulier sur deux lignes.
  const titleCss = textStyle(titleFont, block.titleSize ?? r.fontSize + 3, block.titleWeight ?? "700", block.titleColor ?? r.headingColor, block.titleLineHeight ?? 1.3);
  const title = blank(block.title)
    ? ""
    : block.titleLink === true
      ? `<a href="${escapeHtml(block.href)}" target="_blank" style="display:block;${titleCss}text-decoration:none;">${escapeHtml(block.title)}</a>`
      : `<div style="${titleCss}">${escapeHtml(block.title)}</div>`;
  const excerpt = blank(block.excerpt)
    ? ""
    : `<div style="${textStyle(font, r.fontSize, block.excerptWeight ?? "400", r.textColor, block.excerptLineHeight ?? 1.55)}padding-top:${block.excerptGap ?? 6}px;">${multiline(block.excerpt)}</div>`;

  // Ligne de pied : « Michael Kenrick · » puis « 27 comments » dans SA couleur. Deux couleurs dans
  // une ligne demandent deux nœuds ; c'est pourquoi l'accent est un champ séparé et non un balisage
  // glissé dans le texte.
  const metaPlain = blank(block.meta) ? "" : multiline(block.meta as string);
  const metaAccent = blank(block.metaAccent)
    ? ""
    : `<span style="color:${block.metaAccentColor ?? theme.brandColor};font-weight:600;">${multiline(block.metaAccent as string)}</span>`;
  const meta =
    metaPlain === "" && metaAccent === ""
      ? ""
      : `<div style="${textStyle(font, block.metaSize ?? Math.max(10, r.fontSize - 3), "400", block.metaColor ?? theme.mutedColor, 1.4)}padding-top:${block.metaGap ?? 8}px;">${metaPlain}${metaAccent}</div>`;

  // ⛔ `ctaStyle:"none"` RETIRE le lien de lecture, quel que soit le libellé — y compris un libellé
  // saisi, et y compris sur une carte de flux (le look ou le flux le recopient, `withDefaultCta` ne
  // pose alors rien). C'est le seul interrupteur « pas de lien de lecture » : ne jamais l'affaiblir.
  const cta =
    blank(block.ctaLabel) || block.ctaStyle === "none"
      ? ""
      : `<div style="padding-top:${block.ctaGap ?? 10}px;">${articleCta(block, r, theme, cssFont(block.ctaFont ?? r.fontFamily))}</div>`;

  // `imageLink: false` (22/09/2026) : l'image n'est plus une ancre. Absent = liée, comme avant.
  const lier = (html: string): string =>
    block.imageLink === false ? html : `<a href="${escapeHtml(block.href)}" target="_blank">${html}</a>`;

  if (block.layout === "side" && block.imageSrc !== undefined) {
    // 38 % est le défaut historique : la clé absente rend exactement la largeur d'avant.
    const imgW = Math.max(80, Math.round((width * (block.imageWidthPct ?? 38)) / 100));
    const gap = block.sideGap ?? 14;
    const textW = width - imgW - gap;
    const vignette = lier(imgTag(block.imageSrc, block.imageAlt, imgW, r.borderRadius, true));
    const texte = `${kicker}${title}${excerpt}${meta}${cta}`;
    // ⛔ PLANCHER DE 80 px POUR LE TEXTE, comme l'encart (`calloutHtml`) : dans une colonne étroite,
    // le plancher de la vignette laissait une cellule de texte à `width="-4"` — du HTML invalide,
    // qu'aucun typage ne voit. Quand les deux ne tiennent pas côte à côte, on ne les y force pas :
    // la carte reste empilée partout, vignette au-dessus, ce que tout client sait afficher.
    // ⚠️ Ce plancher n'est PAS un réglage (22/09/2026) : c'est une garde contre du HTML invalide, et
    // l'auteur agit déjà dessus par `imageWidthPct` et `sideGap`.
    if (textW < 80) {
      return `<div style="padding-bottom:${imageGap}px;">${vignette}</div>${texte}`;
    }
    // Empilement sur mobile, vignette PLEINE LARGEUR au-dessus du texte — cf. `sideBySide`.
    return sideBySide(
      ctx,
      width,
      { html: vignette, width: imgW, gap, stackGap: imageGap },
      { html: texte, width: textW, css: `font-size:${r.fontSize}px;line-height:${r.lineHeight};text-align:left;` },
    );
  }

  const image =
    block.imageSrc === undefined
      ? ""
      : `<div style="padding-bottom:${imageGap}px;">${lier(imgTag(block.imageSrc, block.imageAlt, width, r.borderRadius))}</div>`;
  return `${OPEN_TABLE} width="${width}" style="${largeurTable(width)};border-collapse:collapse;"><tr><td align="${r.align}">${kicker}${image}${title}${excerpt}${meta}${cta}</td></tr></table>`;
}

/**
 * Le lien de lecture d'un article. Trois formes :
 *  - `button` (le DÉFAUT, clé absente comprise) : le bouton en tableau de `ctaTable`, le même que
 *    celui des blocs pick et promo, aux couleurs de marque ;
 *  - `link` avec `ctaUnderline > 1` : filet `border-bottom` sous un `inline-block`, seul moyen
 *    d'obtenir un soulignement épais qui tienne sous Outlook ;
 *  - `link` sinon : le lien souligné.
 *
 * ⛔ LE DÉFAUT EST UN BOUTON, PLUS UN LIEN SOULIGNÉ (22/09/2026). Le schéma documente `button` comme
 * défaut et l'éditeur dessine une pastille pleine aux couleurs de marque (`CtaChip`, canvas) ; le
 * compilateur, lui, rendait un lien souligné pour `button` comme pour une clé absente. Constaté sur
 * Copper Kettle : bouton rouge « Leer la nota » à l'écran, lien rouge souligné dans la boîte. Seul
 * `ctaStyle:"link"`, posé explicitement, produit désormais un lien.
 */
function articleCta(block: ArticleBlock, r: Resolved, theme: Theme, font: string): string {
  if (block.ctaStyle !== "link") {
    // `font` est déjà la police du lien de lecture (`ctaFont`, sinon celle du bloc).
    // ⚠️ Depuis le 22/09/2026 le bouton lit AUSSI `ctaSize`, `ctaLetterSpacing` et `ctaTransform`
    // (qui ne valaient jusque-là que pour la forme `link`) : l'inspecteur les propose sous « CTA »
    // quelle que soit la forme, et depuis 1.4.0 le bouton est le défaut — ils étaient sans effet sur
    // presque toutes les cartes. Mesuré le même jour : aucun article ni look en base ne les porte
    // sans `ctaStyle:"link"`, aucun envoi ne change.
    return ctaTable(theme, { ...r, fontFamily: font }, block.href, block.ctaLabel as string, {
      ...ctaLookOf(block),
      letterSpacing: block.ctaLetterSpacing,
      transform: block.ctaTransform,
    });
  }
  const href = escapeHtml(block.href);
  const label = escapeHtml(block.ctaLabel as string);
  const epais = block.ctaStyle === "link" && (block.ctaUnderline ?? 1) > 1;
  // ⚠️ `ctaUnderline` doit figurer dans cette liste comme les autres : sans elle, poser la seule
  // clé `ctaUnderline: 0` prenait la voie rapide, qui écrit `text-decoration:underline` en dur —
  // la clé était acceptée par le schéma, éditable dans l'inspecteur, et sans aucun effet.
  // Même raison pour `ctaWeight` (22/09/2026).
  if (!epais && block.ctaColor === undefined && block.ctaSize === undefined && block.ctaLetterSpacing === undefined && block.ctaTransform === undefined && block.ctaFont === undefined && block.ctaUnderline === undefined && block.ctaWeight === undefined) {
    return `<a href="${href}" target="_blank" style="${textStyle(font, r.fontSize, "700", r.linkColor, 1.4)}text-decoration:underline;">${label}</a>`;
  }
  const color = block.ctaColor ?? r.linkColor;
  const deco = epais
    ? `text-decoration:none;display:inline-block;border-bottom:${block.ctaUnderline as number}px solid ${color};padding-bottom:2px;`
    : block.ctaUnderline === 0
      ? "text-decoration:none;"
      : "text-decoration:underline;";
  return (
    `<a href="${href}" target="_blank" style="${textStyle(font, block.ctaSize ?? r.fontSize, block.ctaWeight ?? "700", color, 1.4)}` +
    `${block.ctaLetterSpacing === undefined ? "" : `letter-spacing:${block.ctaLetterSpacing}px;`}` +
    `${block.ctaTransform === undefined || block.ctaTransform === "none" ? "" : `text-transform:${block.ctaTransform};`}` +
    `${deco}">${label}</a>`
  );
}

function promoHtml(block: PromoBlock, theme: Theme, r: Resolved, width: number): string {
  const font = cssFont(r.fontFamily);
  const parts: string[] = [];

  if (!blank(block.headline)) {
    parts.push(`<div style="${textStyle(font, r.fontSize + 3, "700", r.textColor, 1.3)}">${escapeHtml(block.headline)}</div>`);
  }
  if (!blank(block.body)) {
    parts.push(`<div style="${textStyle(font, r.fontSize, "400", r.textColor, 1.55)}">${multiline(block.body as string)}</div>`);
  }
  if (!blank(block.code)) {
    // Pavé du code : chaque réglage (22/09/2026) retombe sur la valeur d'avant. Le fond n'est émis
    // que posé — l'ajouter à vide changerait les octets de toutes les promos publiées.
    parts.push(
      `${OPEN_TABLE} align="${r.align}" style="border-collapse:separate;border-spacing:0;"><tr>` +
        `<td align="center" style="border:1px ${block.codeBorderStyle ?? "dashed"} ${block.codeBorderColor ?? theme.brandColor};border-radius:6px;` +
        `${block.codeBackground === undefined ? "" : `background-color:${block.codeBackground};`}padding:10px 16px;` +
        `font-family:${block.codeFont === undefined ? "Consolas,'Courier New',monospace" : cssFont(block.codeFont)};font-size:${block.codeSize ?? r.fontSize + 1}px;line-height:1.2;font-weight:700;letter-spacing:2px;color:${block.codeColor ?? r.textColor};white-space:nowrap;">${escapeHtml(block.code as string)}</td>` +
        `</tr></table>`,
    );
  }
  if (!blank(block.ctaLabel)) {
    parts.push(ctaTable(theme, r, block.href, block.ctaLabel, ctaLookOf(block)));
  }
  if (!blank(block.terms)) {
    // Mentions légales : petites, atténuées, mais JAMAIS masquées ni tronquées.
    parts.push(
      `<div style="${textStyle(font, Math.max(10, r.fontSize - 5), "400", theme.mutedColor, 1.45)}">${multiline(block.terms as string)}</div>`,
    );
  }

  return card(parts, {
    width,
    align: r.align,
    radius: r.borderRadius,
    border: block.frameColor ?? theme.brandColor,
    pad: cardPadding(block.innerPadding),
    gap: block.rowGap,
    borderWidth: block.frameWidth,
  });
}

/**
 * Titre de section : le libellé, puis un filet qui prend la largeur restante SUR LA MÊME LIGNE DE
 * BASE. Deux cellules dans un seul tableau — c'est la seule façon de tenir cette ligne de base en
 * email, un `mj-divider` sortirait dans sa propre cellule, une ligne plus bas.
 *
 * ⚠️ `rule:"after"` pose toujours le filet À DROITE du libellé, quel que soit `align`. Le miroir
 * existe depuis le 22/09/2026 sous son propre nom — `before` (filet à gauche) et `both` (de chaque
 * côté) — plutôt qu'en réinterprétant `after` selon l'alignement, ce qui aurait changé en silence
 * les titres déjà publiés alignés à droite.
 */
function sectionTitleHtml(block: SectionTitleBlock, theme: Theme, r: Resolved, width: number): string {
  const font = cssFont(r.headingFont);
  const label = `<span style="${textStyle(font, r.fontSize, r.fontWeight ?? "700", r.headingColor, r.lineHeight)}${typoCss(r)}">${multiline(block.label)}</span>`;
  const color = block.ruleColor ?? r.borderColor;
  // `font-size:0;line-height:0` : sans ça la cellule prend la hauteur d'une ligne de texte et le
  // filet se retrouve décalé au-dessus de la ligne de base du libellé.
  const rule = `border-top:${block.ruleThickness}px solid ${color};font-size:0;line-height:0;`;
  // `ruleGap` (22/09/2026) : l'écart libellé/filet. Absent = le défaut de chaque forme (12, 9, 8).
  const gap = block.ruleGap;
  // Les six formes ouvrent la même table, hybride (`largeurTable`).
  const table = `${OPEN_TABLE} width="${width}" style="${largeurTable(width)};border-collapse:collapse;">`;

  if (block.rule === "none") {
    return `${table}<tr><td align="${r.align}">${label}</td></tr></table>`;
  }
  if (block.rule === "left") {
    // Barre verticale collée au libellé — le « News » de Harbor Tech. `line-height` serré : sinon la
    // barre dépasse le texte en haut et en bas et ne lit plus comme un repère.
    return (
      table +
      `<tr><td align="${r.align}" style="border-left:${block.ruleThickness}px solid ${color};padding-left:${gap ?? 9}px;line-height:1;">${label}</td></tr></table>`
    );
  }
  if (block.rule === "under") {
    return (
      table +
      `<tr><td align="${r.align}" style="padding-bottom:${gap ?? 8}px;">${label}</td></tr>` +
      `<tr><td style="${rule}">&nbsp;</td></tr></table>`
    );
  }
  if (block.rule === "before") {
    return (
      table +
      `<tr>` +
      `<td style="${rule}">&nbsp;</td>` +
      `<td width="1" style="white-space:nowrap;padding-left:${gap ?? 12}px;">${label}</td>` +
      `</tr></table>`
    );
  }
  if (block.rule === "both") {
    return (
      table +
      `<tr>` +
      `<td style="${rule}">&nbsp;</td>` +
      `<td width="1" style="white-space:nowrap;padding:0 ${gap ?? 12}px;">${label}</td>` +
      `<td style="${rule}">&nbsp;</td>` +
      `</tr></table>`
    );
  }
  return (
    table +
    `<tr>` +
    `<td width="1" style="white-space:nowrap;padding-right:${gap ?? 12}px;">${label}</td>` +
    `<td style="${rule}">&nbsp;</td>` +
    `</tr></table>`
  );
}

/**
 * Encart d'appel : un aplat portant surtitre / titre / texte / bouton, avec filet d'accent
 * optionnel à gauche. Padding paramétrable — c'est ce qui le distingue de `card()`, dont les
 * paddings sont des constantes du module.
 */
function calloutHtml(block: CalloutBlock, theme: Theme, r: Resolved, width: number, ctx: Ctx): string {
  // ⛔ Une mise en page (23/09/2026) est un AUTRE rendu, dans son module. Sans `layout`, rien de ce
  // qui suit ne change d'un octet, et aucune règle mobile de mise en page n'entre dans le head.
  if (block.layout !== undefined) {
    return calloutLayoutHtml(block, block.layout, {
      theme,
      look: {
        fontFamily: r.fontFamily,
        fontSize: r.fontSize,
        lineHeight: r.lineHeight,
        fontWeight: r.fontWeight,
        textColor: r.textColor,
        headingColor: r.headingColor,
        headingFont: r.headingFont,
        align: r.align,
        backgroundColor: r.backgroundColor,
        borderRadius: r.borderRadius,
        borderWidth: r.borderWidth,
        borderColor: r.borderColor,
        kickerTypo: typoCss(r),
      },
      width,
      // Dédupliqué : dix encarts de la même mise en page partagent leurs règles (plafond Gmail 16 Ko).
      mobile: (rule) => {
        if (!ctx.mobileCss.includes(rule)) ctx.mobileCss.push(rule);
      },
      // Même interrupteur que les blocs sans texte (`blockNode`) : `pinDarkRows: false` n'épingle rien.
      pin: (color) => (theme.pinDarkRows === false ? undefined : pinClass(ctx, color)),
    });
  }
  const font = cssFont(r.fontFamily);
  const titleFont = cssFont(block.titleFont ?? r.headingFont);
  const bodyFont = cssFont(block.bodyFont ?? r.fontFamily);
  const pad = box(block.innerPadding ?? { top: 20, right: 24, bottom: 20, left: 24 });
  const parts: string[] = [];

  if (!blank(block.kicker)) {
    const size = block.kickerSize ?? Math.max(11, r.fontSize - 4);
    parts.push(
      `<div style="${textStyle(font, size, r.fontWeight ?? "700", block.kickerColor ?? theme.mutedColor, 1.4)}${typoCss(r)}padding-bottom:8px;">${multiline(block.kicker)}</div>`,
    );
  }
  // Titre et corps forment un bloc : c'est LUI qui se met en colonne quand l'encart porte une
  // vignette. Le surtitre reste pleine largeur au-dessus, le bouton pleine largeur en dessous —
  // exactement la géométrie de l'encart « El partido del día ».
  const corps: string[] = [];
  if (!blank(block.title)) {
    const size = block.titleSize ?? Math.max(18, r.fontSize + 4);
    // `titleWeight` / `titleColor` / `titleLineHeight` (22/09/2026) : absents, le titre d'avant.
    corps.push(
      `<div style="${textStyle(titleFont, size, block.titleWeight ?? r.fontWeight ?? "700", block.titleColor ?? r.headingColor, block.titleLineHeight ?? 1.25)}padding-bottom:${blank(block.body) ? 0 : 10}px;">${multiline(block.title)}</div>`,
    );
  }
  if (!blank(block.body)) {
    corps.push(
      `<div style="${textStyle(bodyFont, r.fontSize, "400", block.bodyColor ?? r.textColor, r.lineHeight)}">${multiline(block.body)}</div>`,
    );
  }
  if (corps.length > 0 && block.imageSrc !== undefined) {
    // Bordures gauche + droite du cadre (l'accent remplace la bordure gauche) : cf. `tableInterieure`.
    const bordures = (block.accentWidth > 0 ? block.accentWidth : r.borderWidth) + r.borderWidth;
    const { inner, fluide } = tableInterieure(width, pad, bordures);
    const imgW = Math.max(60, Math.round((inner * (block.imageWidthPct ?? 24)) / 100));
    const gap = 14;
    const textW = Math.max(80, inner - imgW - gap);
    const vignette = imgTag(block.imageSrc, block.imageAlt ?? "", imgW, Math.max(0, r.borderRadius - 1));
    parts.push(
      `${OPEN_TABLE} width="${inner}" style="${largeurTable(inner, fluide)};border-collapse:collapse;"><tr>` +
        `<td align="left" width="${textW}" valign="top" style="width:${textW}px;padding:0 ${gap}px 0 0;">${corps.join("")}</td>` +
        `<td align="right" width="${imgW}" valign="top" style="width:${imgW}px;">` +
        // ⛔ On n'enveloppe la vignette dans une ancre QUE si son `alt` la nomme. Un `<a>` dont le
        // seul contenu est une image sans alt n'a aucun nom accessible : le lecteur d'écran annonce
        // « lien » et rien d'autre, et la case est vide dès que le client bloque les images. Le
        // bouton posé juste dessous porte déjà le même href — l'accès n'est jamais perdu.
        `${block.href === undefined || blank(block.imageAlt) ? vignette : `<a href="${escapeHtml(block.href)}" target="_blank">${vignette}</a>`}</td>` +
        `</tr></table>`,
    );
  } else {
    parts.push(...corps);
  }
  // Même garde que le CTA d'article : pas de bouton sans destination. La publication le refuse
  // déjà (EmailDocPublishable), ceci couvre le brouillon et l'aperçu.
  if (block.href !== undefined && !blank(block.ctaLabel)) {
    // Police du bouton : `ctaFont` (22/09/2026), sinon celle du titre comme avant, sinon celle du bloc.
    parts.push(
      `<div style="padding-top:16px;">${ctaTable(theme, { ...r, fontFamily: block.ctaFont ?? block.titleFont ?? r.fontFamily }, block.href, block.ctaLabel as string, ctaLookOf(block))}</div>`,
    );
  }

  const frame = [
    largeurTable(width),
    "border-collapse:separate",
    "border-spacing:0",
    ...(block.style?.backgroundColor ? [`background-color:${block.style.backgroundColor}`] : []),
    ...(r.borderRadius > 0 ? [`border-radius:${r.borderRadius}px`] : []),
    ...(r.borderWidth > 0 ? [`border:${r.borderWidth}px solid ${r.borderColor}`] : []),
    // Posé APRÈS la bordure complète : sur un panneau qui a les deux, l'accent doit gagner.
    ...(block.accentWidth > 0 ? [`border-left:${block.accentWidth}px solid ${block.accentColor ?? theme.brandColor}`] : []),
  ].join(";");
  return (
    `${OPEN_TABLE} width="${width}" style="${frame};">` +
    `<tr><td align="${r.align}" style="padding:${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px;">${parts.join("")}</td></tr>` +
    `</table>`
  );
}

/**
 * Bandeau de résultat : surtitre, puis 2 à 4 lignes « libellé à gauche, valeur à droite ».
 * Rien n'est calculé : les valeurs sont les chaînes du document, telles quelles.
 */
function scoreboardHtml(block: ScoreboardBlock, theme: Theme, r: Resolved, width: number): string {
  const font = cssFont(r.fontFamily);
  // Réglages du 22/09/2026 : absents, les couleurs, tailles, marges et filet d'avant.
  const pad = cardPadding(block.innerPadding);
  const { inner, fluide } = tableInterieure(width, pad, 2 * r.borderWidth);
  const valueSize = block.valueSize ?? Math.max(24, r.fontSize * 2);
  // Largeur FIXE en px pour la colonne de droite : un pourcentage se recalcule différemment sous
  // Word et décale la valeur hors de la carte. (La TABLE est hybride, cf. `tableInterieure`.)
  const valueW = Math.min(160, Math.max(56, Math.round(valueSize * 2.2)));
  const labelW = Math.max(60, inner - valueW);

  const rows = block.rows
    .map((row) => {
      // Une ligne mise en avant passe en couleur de marque, les autres en couleur atténuée : c'est
      // la hiérarchie qu'un bandeau de résultat doit rendre lisible d'un coup d'oeil.
      // ⛔ PAS de `typoCss` ici : la casse forcée du bloc vise le surtitre, pas des noms propres.
      const labelColor = row.highlight ? (block.highlightLabelColor ?? r.textColor) : (block.labelColor ?? theme.mutedColor);
      const valueColor = row.highlight ? (block.highlightValueColor ?? theme.brandColor) : (block.valueColor ?? theme.mutedColor);
      return (
        `<tr>` +
        `<td width="${labelW}" style="width:${labelW}px;${textStyle(font, block.labelSize ?? r.fontSize, row.highlight ? "600" : "400", labelColor, 1.3)}padding:6px 0;">${multiline(row.label)}</td>` +
        `<td width="${valueW}" align="right" style="width:${valueW}px;${textStyle(font, valueSize, "700", valueColor, 1.1)}padding:6px 0;">${multiline(row.value)}</td>` +
        `</tr>`
      );
    })
    .join("");

  const parts: string[] = [];
  if (!blank(block.kicker)) {
    parts.push(
      `<div style="${textStyle(font, block.kickerSize ?? Math.max(11, r.fontSize - 4), "700", block.kickerColor ?? theme.mutedColor, 1.4)}${typoCss(r)}padding-bottom:10px;">${multiline(block.kicker)}</div>`,
    );
  }
  parts.push(`${OPEN_TABLE} width="${inner}" style="${largeurTable(inner, fluide)};border-collapse:collapse;">${rows}</table>`);

  // Pied : un filet, puis un lien et une note. Deux `div` imbriqués parce que l'espace AVANT le
  // filet ne peut pas être un `margin-top` — Word l'ignore et le filet se colle aux scores.
  if (!blank(block.footerLabel) || !blank(block.footerNote)) {
    const couleur = block.footerColor ?? theme.mutedColor;
    const couleurLien = block.footerLabelColor ?? r.textColor;
    const lien = blank(block.footerLabel)
      ? ""
      : block.footerHref === undefined
        ? `<span style="${textStyle(font, r.fontSize - 1, "600", couleurLien, 1.4)}">${multiline(block.footerLabel as string)}</span>`
        : `<a href="${escapeHtml(block.footerHref)}" target="_blank" style="${textStyle(font, r.fontSize - 1, "600", couleurLien, 1.4)}text-decoration:none;">${multiline(block.footerLabel as string)}</a>`;
    const note = blank(block.footerNote)
      ? ""
      : `<span style="${textStyle(font, Math.max(11, r.fontSize - 2), "400", couleur, 1.4)}">${multiline(block.footerNote as string)}</span>`;
    const filet = block.footerRuleWidth ?? 1;
    parts.push(
      `<div style="padding-top:14px;"><div style="${filet > 0 ? `border-top:${filet}px solid ${block.footerRuleColor ?? r.borderColor};` : ""}padding-top:12px;">${lien}${note}</div></div>`,
    );
  }

  const frame = [
    largeurTable(width),
    "border-collapse:separate",
    "border-spacing:0",
    ...(block.style?.backgroundColor ? [`background-color:${block.style.backgroundColor}`] : []),
    ...(r.borderRadius > 0 ? [`border-radius:${r.borderRadius}px`] : []),
    ...(r.borderWidth > 0 ? [`border:${r.borderWidth}px solid ${r.borderColor}`] : []),
  ].join(";");
  return (
    `${OPEN_TABLE} width="${width}" style="${frame};">` +
    // Sans `innerPadding`, la forme courte d'avant ; réglé, les quatre côtés.
    `<tr><td style="padding:${block.innerPadding === undefined ? `${CARD_PAD_Y}px ${CARD_PAD_X}px` : padAttr(pad)};">${parts.join("")}</td></tr>` +
    `</table>`
  );
}

/* ------------------------------------------------------------------ *
 * Blocs → nœuds MJML
 * ------------------------------------------------------------------ */

function blockNode(
  block: Block,
  ctx: Ctx,
  rowStyle: BoxStyle | undefined,
  colStyle: BoxStyle | undefined,
  availableWidth: (blockPad: Box) => number,
): MjmlNode {
  const theme = ctx.theme;
  const style = block.type === "footer_legal" ? undefined : block.style;
  const r = resolve(theme, box(theme.blockPadding), style, [rowStyle, colStyle]);

  const classes: string[] = [];
  if (r.hideOnMobile) classes.push("nf-hide-mobile");

  // Overrides mobiles : classe dédiée + media query dans le <style> du head. `r.fontSizeMobile`
  // est la valeur CASCADÉE (theme → row → column → bloc), `r.paddingMobile` celle du bloc seul —
  // un padding ne s'hérite jamais, sinon il s'additionnerait à chaque niveau.
  const blockMobile = mobileClass(ctx, "m", "cell", r.fontSizeMobile, r.paddingMobile);
  if (blockMobile) classes.push(blockMobile);

  /*
   * ⛔ LE FOND D'UN BLOC SANS TEXTE EST ÉPINGLÉ, ET CELUI D'UNE IMAGE EST RENDU EXPLICITE (23/09/2026).
   * Le bandeau Copper Kettle des e-mails de cycle de vie n'est PAS un fond de rangée : ce sont trois
   * blocs (filet, logo, filet) à fond #1a1a20 sur une rangée claire — l'épingle par rangée du 18/09 ne
   * le voyait donc pas, et c'est ce bandeau-là qui cassait sur mobile. Une image sans fond propre
   * reçoit celui qu'elle a sous elle (colonne, sinon rangée, sinon contenu) : même couleur, donc rendu
   * clair identique au pixel, mais la cellule du logo porte désormais SA couleur et peut être épinglée.
   */
  let fondBloc = r.backgroundColor;
  if (theme.pinDarkRows !== false && BLOCS_SANS_TEXTE.has(block.type)) {
    if (fondBloc === undefined && block.type === "image") {
      fondBloc = colStyle?.backgroundColor ?? rowStyle?.backgroundColor ?? theme.contentBackground;
    }
    const pin = pinClass(ctx, fondBloc);
    if (pin) classes.push(pin);
  }

  const common: Record<string, MjmlAttrValue> = { padding: padAttr(r.padding) };
  if (classes.length > 0) common["css-class"] = classes.join(" ");
  if (fondBloc) common["container-background-color"] = fondBloc;

  switch (block.type) {
    case "text": {
      const preset = presetOf(theme, block.preset);
      // Le preset donne la valeur par défaut ; un style POSÉ SUR LE BLOC la remplace. Les deux
      // doivent atterrir à la fois sur `mj-text` et sur le style inline du `<p>` : Outlook lit
      // l'un, les webmails l'autre, une divergence donne deux rendus différents.
      const size = block.style?.fontSize ?? preset.size(theme);
      const lh = block.style?.lineHeight ?? preset.lineHeight;
      // Un preset de titre (h1-h3) prend la couleur et la police des titres, aux deux endroits.
      const rt = PRESETS_TITRE.has(block.preset) ? { ...r, textColor: r.headingColor, fontFamily: r.headingFont } : r;
      return {
        tagName: "mj-text",
        attributes: {
          ...common,
          align: rt.align,
          color: rt.textColor,
          "font-family": rt.fontFamily,
          "font-size": `${size}px`,
          "line-height": String(lh),
        },
        content: paragraphsToHtml(block.paragraphs, preset, rt, size, lh, block.paragraphSpacing),
      };
    }

    case "image": {
      const available = availableWidth(r.padding);
      const width = Math.max(20, Math.round((available * block.widthPct) / 100));
      const attrs: Record<string, MjmlAttrValue> = {
        ...common,
        src: block.src,
        alt: block.alt,
        align: block.align,
        width: `${width}px`,
      };
      /*
       * ⛔ 24/09/2026 — « sur le responsive c'est top sauf le logo qui reste géant » (Alix).
       * `fluid-on-mobile` passe l'image à 100 % de sa colonne sous le seuil d'empilement (MJML pose
       * `table.mj-full-width-mobile { width:100% }` et l'`<img>` est déjà à `width:100%`). Posé sur
       * TOUTES les images jusqu'ici, il ignorait la largeur réglée : le logo Copper Kettle réglé à
       * 198 px en faisait 375 à 375 px, celui de Northwind Sports 131 → 343. Mesuré sur les documents réels :
       * 164 images sur 167 sont des logos de marque, toutes réglées sous 100 %.
       * ⭐ LA RÈGLE N'EST PAS « C'EST UN LOGO » (le schéma ne le dit nulle part, et les logos sont des
       * rows COPIÉES dans les modèles, sans pointeur vers l'en-tête de marque) : c'est le SENS du
       * réglage. Largeur < 100 % = une taille choisie, gardée en px sur mobile (plafond : la cellule
       * `width:<W>px`, l'image rétrécit seule si la colonne est plus étroite) ; 100 % = « toute la
       * colonne », qui reste fluide.
       * ⚠️ Booléen NATIF, pas la chaîne "true" : MJML 5 valide les attributs booléens par type
       * et rejette `"true"`. (MJML pose déjà `display:block`, indispensable sous Gmail.)
       */
      if (block.widthPct === 100) {
        attrs["fluid-on-mobile"] = true;
      } else if (block.align !== "center") {
        attrs["css-class"] = [centrerImageEmpilee(ctx, r.padding, r.paddingMobile), ...classes].join(" ");
      }
      if (block.href) attrs["href"] = block.href;
      if (r.borderRadius > 0) attrs["border-radius"] = `${r.borderRadius}px`;
      return { tagName: "mj-image", attributes: attrs };
    }

    case "button":
      // Réglages propres au bouton (22/09/2026) ; absents, les valeurs d'avant. Les marges gardent
      // leur forme courte « 14px 26px » tant qu'elles ne sont pas réglées : mêmes octets.
      return {
        tagName: "mj-button",
        attributes: {
          ...common,
          href: block.href,
          align: block.align,
          "background-color": block.buttonBackground ?? theme.brandColor,
          color: block.buttonTextColor ?? theme.buttonTextColor,
          "border-radius": `${r.borderRadius}px`,
          "font-family": r.fontFamily,
          "font-size": `${block.labelSize ?? Math.max(14, r.fontSize - 1)}px`,
          "font-weight": block.labelWeight ?? "700",
          "inner-padding":
            block.innerPadding === undefined
              ? "14px 26px"
              : padAttr(mergePadding({ top: 14, right: 26, bottom: 14, left: 26 }, block.innerPadding)),
        },
        content: escapeHtml(block.label),
      };

    case "divider": {
      if (block.segments !== undefined) {
        // Barre multicolore : `mj-divider` ne sait faire qu'une couleur. Une table de cellules
        // colorées est le seul équivalent qui tienne sous Word.
        // ⛔ TABLE HYBRIDE (23/09/2026) : les ATTRIBUTS `width` restent en px — c'est eux que lit
        // Outlook/Word —, le STYLE est fluide : `width:100%;max-width:<W>px` sur la table, la part du
        // segment en % sur chaque cellule. Un `width:<W>px` en style imposait 600 px à tout l'e-mail
        // sur mobile : à 375 px la page débordait de 225 px et le texte voisin était coupé à droite
        // (le filet tricolore Northwind Sports : 14 versions de modèles et un pied de marque). Au bureau, 100 %
        // de la colonne vaut exactement W : rendu inchangé au pixel.
        // ⚠️ Ne pas repasser une largeur en px dans un `style` : `blocs-natifs.test.ts` le refuse.
        const width = availableWidth(r.padding);
        const cells = block.segments
          .map((seg) => {
            const w = Math.max(1, Math.round((width * seg.widthPct) / 100));
            return `<td width="${w}" style="width:${seg.widthPct}%;height:${block.thickness}px;background-color:${seg.color};font-size:0;line-height:0;">&nbsp;</td>`;
          })
          .join("");
        return {
          tagName: "mj-text",
          attributes: { ...common, padding: padAttr(r.padding) },
          content: `${OPEN_TABLE} width="${width}" style="width:100%;max-width:${width}px;border-collapse:collapse;"><tr>${cells}</tr></table>`,
        };
      }
      return {
        tagName: "mj-divider",
        attributes: {
          ...common,
          "border-color": block.color ?? r.borderColor,
          "border-width": `${block.thickness}px`,
          "border-style": block.lineStyle ?? "solid",
          width: `${block.widthPct}%`,
          align: r.align,
        },
      };
    }

    case "spacer": {
      const attrs: Record<string, MjmlAttrValue> = { ...common, height: `${block.height}px` };
      if (block.heightMobile !== undefined) {
        const cls = cssId(ctx, "sp");
        ctx.mobileCss.push(`.${cls} div, .${cls} td { height:${block.heightMobile}px !important; }`);
        attrs["css-class"] = [attrs["css-class"], cls].filter(Boolean).join(" ");
      }
      return { tagName: "mj-spacer", attributes: attrs };
    }

    case "html":
      // Échappatoire assumée (import HTML palier 0) : rendu tel quel, jamais réécrit.
      return { tagName: "mj-raw", attributes: {}, content: block.raw };

    case "social": {
      // Réglages du 22/09/2026 : absents, AUCUN attribut n'est ajouté — MJML garde ses propres
      // défauts (13 px, rayon 3 px, couleur de chaque réseau) et le HTML reste celui d'avant.
      const socialAttrs: Record<string, MjmlAttrValue> = {
        ...common,
        mode: block.mode,
        align: r.align === "left" ? "left" : r.align,
        "icon-size": `${block.iconSize}px`,
        "font-family": r.fontFamily,
        color: block.labelColor ?? theme.mutedColor,
      };
      if (block.labelSize !== undefined) socialAttrs["font-size"] = `${block.labelSize}px`;
      if (block.iconRadius !== undefined) socialAttrs["border-radius"] = `${block.iconRadius}px`;
      return {
        tagName: "mj-social",
        attributes: socialAttrs,
        children: block.items.map((item) => {
          const attrs: Record<string, MjmlAttrValue> = { href: item.href };
          if (block.iconBackground !== undefined) attrs["background-color"] = block.iconBackground;
          if (item.iconSrc) {
            attrs["src"] = item.iconSrc;
            attrs["name"] = "web";
          } else if (MJML_SOCIAL_ICONS.has(item.platform)) {
            attrs["name"] = item.platform;
          } else {
            attrs["name"] = "web";
            ctx.warnings.push(
              `Social icon for "${item.platform}" is not bundled with MJML — set iconSrc or a generic globe icon will be used.`,
            );
          }
          return {
            tagName: "mj-social-element",
            attributes: attrs,
            content: item.label ? escapeHtml(item.label) : "",
          };
        }),
      };
    }

    case "menu": {
      // Volontairement rendu en `mj-text` + ancres : `mj-navbar` embarque un hamburger CSS que
      // Gmail jette, un menu en liens inline se dégrade proprement partout.
      // Réglages du 22/09/2026 : absents, la chaîne d'avant (600, sans soulignement, fs−2, 1.8).
      const sep = ` <span style="color:${block.separatorColor ?? theme.mutedColor};">${escapeHtml(block.separator)}</span> `;
      const links = block.items
        .map(
          (item) =>
            `<a href="${escapeHtml(item.href)}" style="color:${r.linkColor};text-decoration:${block.itemUnderline === true ? "underline" : "none"};font-weight:${block.itemWeight ?? "600"};" target="_blank">${escapeHtml(item.label)}</a>`,
        )
        .join(sep);
      /*
       * ⛔ CORRECTIF (22/09/2026) — un menu ne pouvait JAMAIS être aligné à gauche : `left` était
       * réécrit en `center`. Le but était de centrer les menus SANS alignement choisi, mais `r.align`
       * vaut déjà « left » par défaut (cascade), si bien qu'un `left` DEMANDÉ était indiscernable de
       * l'absence de choix. On lit donc l'alignement réellement POSÉ (bloc, colonne ou rangée) :
       * posé, il est respecté ; absent, le menu reste centré comme avant. Mesuré le même jour : aucun
       * modèle en base ne porte de bloc menu, aucun envoi ne change.
       */
      const alignPose = optional("align", rowStyle, colStyle, style);
      return {
        tagName: "mj-text",
        attributes: {
          ...common,
          align: alignPose ?? "center",
          "font-family": r.fontFamily,
          "font-size": `${block.itemSize ?? Math.max(12, r.fontSize - 2)}px`,
          "line-height": String(block.itemLineHeight ?? "1.8"),
          color: theme.mutedColor,
        },
        content: links,
      };
    }

    case "pick":
    case "odds_table":
    case "standings":
    case "scoreboard":
    case "article":
    case "section_title":
    case "callout":
    case "promo": {
      // Les blocs métier sortent en HTML de tableau dans un `mj-text` : c'est le seul conteneur
      // MJML qui n'impose pas sa propre structure. Les attributs typo restent posés sur le
      // `mj-text` pour les clients qui les lisent là, ET en inline dans les cellules.
      const width = availableWidth(r.padding);
      const html =
        block.type === "pick"
          ? pickHtml(block, theme, r, width)
          : block.type === "odds_table"
            ? oddsTableHtml(block, theme, r, width)
            : block.type === "standings"
              ? standingsHtml(block, theme, r, width)
              : block.type === "scoreboard"
                ? scoreboardHtml(block, theme, r, width)
                : block.type === "article"
                  ? articleHtml(block, ctx, r, width)
                  : block.type === "section_title"
                    ? sectionTitleHtml(block, theme, r, width)
                    : block.type === "callout"
                      ? calloutHtml(block, theme, r, width, ctx)
                      : promoHtml(block, theme, r, width);
      // ⛔ PAS de `typoAttrs` ici : posés sur le conteneur d'une carte, `letter-spacing` et
      // `text-transform` sont hérités par TOUT son contenu. Chaque bloc-carte décide lui-même où
      // il les applique (le surtitre, jamais le titre ni le paragraphe).
      // ⛔ Et pas de fond de conteneur pour les deux panneaux : ils peignent leur propre table, et
      // le laisser ici étalait l'aplat sur toute la largeur de la colonne, gouttières comprises.
      const panneau = block.type === "callout" || block.type === "scoreboard";
      const attrs: Record<string, MjmlAttrValue> = { ...common };
      if (panneau) delete attrs["container-background-color"];
      return {
        tagName: "mj-text",
        attributes: {
          ...attrs,
          align: r.align,
          color: r.textColor,
          "font-family": r.fontFamily,
          "font-size": `${r.fontSize}px`,
          "line-height": String(r.lineHeight),
        },
        content: html,
      };
    }

    case "article-feed":
      // ⛔ INATTEIGNABLE PAR CONSTRUCTION : `compileDoc` déplie les flux en blocs article avant
      // d'appeler ce rendu. La branche existe pour que le compilateur RESTE exhaustif — si un jour
      // quelqu'un compile sans déplier, il obtient un trou visible et une carte vide, jamais un
      // email à moitié rendu.
      return { tagName: "mj-raw", attributes: {}, content: "" };

    case "footer_legal":
      // VERROUILLÉ : aucune prop éditable. Le contenu réel est injecté par le worker au moment de
      // l'envoi (liens unsub/prefs SIGNÉS, propres au destinataire) via le token brut ci-dessous.
      return {
        tagName: "mj-raw",
        attributes: {},
        content:
          `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">` +
          `<tr><td align="center" style="padding:0;">{{legal_footer_html}}</td></tr></table>`,
      };
  }
}

/* ------------------------------------------------------------------ *
 * Contenu conditionnel
 * ------------------------------------------------------------------ */

/**
 * Encadre un nœud de ses marqueurs `<!--nf:if …-->` / `<!--nf:endif-->`. `mj-raw` est le seul
 * moyen de faire traverser un commentaire à MJML, et il est accepté comme enfant de `mj-wrapper`,
 * `mj-section` et `mj-column` — les trois niveaux qui en ont besoin. Le marqueur encadre TOUT le
 * fragment de l'élément, ghost tables Outlook comprises : les retirer, c'est retirer un morceau
 * équilibré.
 *
 * ⚠️ Sans condition on renvoie le nœud SEUL : un document sans `visibleIf` doit produire un HTML
 * identique octet pour octet à celui d'avant l'ajout du mécanisme.
 */
function guard(node: MjmlNode, cond: VisibleIf | undefined): MjmlNode[] {
  if (cond === undefined) return [node];
  return [
    { tagName: "mj-raw", attributes: {}, content: conditionMarker(cond) },
    node,
    { tagName: "mj-raw", attributes: {}, content: CONDITION_END },
  ];
}

/** Le footer légal n'a pas de condition — et ne doit jamais en avoir (voir `FooterLegalBlock`). */
const blockCondition = (block: Block): VisibleIf | undefined =>
  block.type === "footer_legal" ? undefined : block.visibleIf;

/* ------------------------------------------------------------------ *
 * Head
 * ------------------------------------------------------------------ */

function headNode(doc: EmailDoc, ctx: Ctx): MjmlNode {
  const theme = ctx.theme;
  const children: MjmlNode[] = [];

  // `htmlTitle` (22/09/2026) remplace l'objet dans `<title>` ; absent, c'est l'objet comme avant.
  const titre = doc.meta.htmlTitle ?? doc.meta.subject;
  if (titre.trim() !== "") {
    children.push({ tagName: "mj-title", attributes: {}, content: escapeHtml(titre) });
  }

  // `columnBreakpoint` (22/09/2026) : posé, MJML empile ses colonnes au même seuil que nos vignettes
  // (`sideBySide`). Absent, on n'émet rien et MJML garde son défaut de 480 px — HTML inchangé.
  if (theme.columnBreakpoint !== undefined) {
    children.push({ tagName: "mj-breakpoint", attributes: { width: `${theme.columnBreakpoint}px` } });
  }

  // `mj-font` -> `<link>` + `@import` dans le head. Gmail et Outlook desktop les ignorent et
  // retombent sur la pile de repli de la `fontFamily` : c'est pour ça qu'aucune `fontFamily` ne
  // doit jamais se réduire à un seul nom.
  for (const f of theme.webFonts) {
    children.push({ tagName: "mj-font", attributes: { name: f.family, href: f.href } });
  }

  // Preheader : MJML l'émet en tête de body dans un div masqué + padding de caractères invisibles.
  if (doc.meta.preheader.trim() !== "") {
    children.push({ tagName: "mj-preview", attributes: {}, content: doc.meta.preheader });
  }

  // On n'ajoute QUE ce que MJML n'émet pas déjà. Vérifié sur mjml@5.4.0, il pose lui-même
  // `<meta name="viewport" content="width=device-width, initial-scale=1">`, le charset,
  // X-UA-Compatible et le bloc mso `<o:PixelsPerInch>96`. Les redéclarer produirait des balises
  // en double dans le `<head>` — et dupliquer le bloc mso perturbe le parseur Word.
  /*
   * ⛔ ABSENT = « light only » DEPUIS LE 23/09/2026 (avant : « light dark »), et c'est LA correction du
   * « les newsletters changent de couleur sur mobile ». Trois clients, trois sources :
   *  - Gmail iOS et Android prennent en compte `<meta name="color-scheme" content="light only">` —
   *    et SEULEMENT cette chaîne (caniemail, `html-meta-color-scheme`, mise à jour du 16/09/2026) ;
   *  - Apple Mail : « light only, informing Mail that it should not transform your light color scheme
   *    email message » (webkit.org/blog/8840) — via la notation CSS depuis Mail 13, d'où le `:root`
   *    posé en plus dans le `<style>` ;
   *  - Chromium / WebView Android (assombrissement algorithmique) : `only` exclut la page depuis
   *    Chrome 98 (chromestatus 5157621012103168). Mesuré le 23/09 : fond #FEFEFE intact avec
   *    `light only`, #121212 avec `light` seul.
   * ⚠️ ÉCRIRE « light only » ET PAS « only light » : les deux sont valides en CSS, mais c'est la chaîne
   * `light only` que Gmail a été vu honorer.
   */
  const schemes = theme.colorScheme ?? "light only";
  children.push({
    tagName: "mj-raw",
    attributes: {},
    content:
      `<meta name="color-scheme" content="${schemes}">` +
      `<meta name="supported-color-schemes" content="${schemes}">` +
      `<meta name="x-apple-disable-message-reformatting">` +
      `<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">`,
  });

  children.push({
    tagName: "mj-attributes",
    attributes: {},
    children: [
      {
        tagName: "mj-all",
        attributes: { "font-family": theme.fontFamily },
      },
      {
        tagName: "mj-text",
        attributes: {
          color: theme.textColor,
          "font-size": `${theme.fontSize}px`,
          "line-height": String(theme.lineHeight),
        },
      },
    ],
  });

  // Gmail n'accepte `<style>` que dans le `<head>` et jette le bloc ENTIER au-delà de 16 Ko :
  // on n'y met QUE des media queries, du dark mode et le :hover. Tout le reste est inline.
  const dark: string[] = [];
  if (theme.darkBodyBackground) dark.push(`body, .nf-body { background-color:${theme.darkBodyBackground} !important; }`);
  if (theme.darkContentBackground) dark.push(`.nf-content { background-color:${theme.darkContentBackground} !important; }`);
  if (theme.darkTextColor) dark.push(`.nf-content, .nf-content td, .nf-content div, .nf-content p { color:${theme.darkTextColor} !important; }`);
  // Conteneurs sans texte : on ré-affirme leur fond pour les clients qui LISENT la media query
  // (Apple Mail, Outlook.com, Outlook mobile). `> table` : MJML pose `css-class` sur le `<div>`
  // extérieur de la section mais répète le fond en style inline sur la table qu'il contient.
  for (const [color, cls] of ctx.darkKeep) {
    dark.push(`.${cls}, .${cls} > table { background-color:${color} !important; }`);
  }

  // Gmail IGNORE `prefers-color-scheme` sur ses quatre plateformes (caniemail, dernier test 03/2023 ;
  // Litmus 02/2025, Email on Acid 10/2025) : la media query ci-dessous ne l'atteindra jamais. En
  // revanche il ne recolore PAS un fond déclaré en dégradé — on repeint donc la MÊME couleur en
  // `linear-gradient` pour que les bandeaux sombres survivent à son thème sombre. Couleur identique
  // des deux côtés ⇒ rien ne change en thème clair, et un client sans dégradé (moteur Word) garde le
  // `background-color` inline posé par MJML.
  // ⛔ `, .cls > table` (23/09/2026) : sur une RANGÉE, la classe est sur le `<div>` mais la table qu'il
  // contient répète le fond en inline, et c'est ELLE qui est peinte par-dessus. Sans ce sélecteur, un
  // Gmail qui recolore la table cache le dégradé du `<div>` dessous (déduit de la structure MJML, pas
  // observé dans Gmail). Le combinateur enfant est pris en charge par Gmail (caniemail
  // `css-selector-child`, comptes Google).
  const gmail = [...ctx.darkKeep].map(
    ([color, cls]) => `.${cls}, .${cls} > table { background-image:linear-gradient(${color},${color}) !important; }`,
  );

  const css = [
    `:root { color-scheme: ${schemes}; supported-color-schemes: ${schemes}; }`,
    // `resetLinkDecoration: false` (22/09/2026) retire la remise à zéro du soulignement des liens.
    ...(theme.resetLinkDecoration === false ? [] : [`a { text-decoration: none; }`]),
    ...gmail,
    // `mobileBreakpoint` (22/09/2026) : le seuil des réglages mobiles. Absent = 600 px.
    `@media only screen and (max-width:${theme.mobileBreakpoint ?? 600}px) {`,
    `  .nf-hide-mobile { display:none !important; max-height:0 !important; overflow:hidden !important; mso-hide:all; }`,
    ...ctx.mobileCss.map((rule) => `  ${rule}`),
    `}`,
    // Colonnes empilées (24/09/2026) : le même seuil que MJML (`makeLowerBreakpoint`), jamais celui de
    // `mobileBreakpoint` — à 600 px celui-là s'applique encore, et l'écran large ne doit pas bouger.
    // Rien à émettre, rien d'émis : le HTML des documents sans image recentrée ne change pas.
    ...(ctx.stackedCss.length > 0
      ? [`@media only screen and (max-width:${ctx.columnBreakpoint - 1}px) {`, ...ctx.stackedCss.map((rule) => `  ${rule}`), `}`]
      : []),
    ...(dark.length > 0
      ? [`@media (prefers-color-scheme: dark) {`, ...dark.map((rule) => `  ${rule}`), `}`]
      : []),
  ].join("\n");

  children.push({ tagName: "mj-style", attributes: {}, content: css });

  /*
   * Le côte-à-côte des cartes en vignette (`sideBySide`), dans DEUX `<style>` À PART — la copie
   * exacte de ce que MJML émet pour ses propres `mj-column` : une media query `min-width`, et sa
   * variante `.moz-text-html` pour Thunderbird. `mj-raw` et non `mj-style` : MJML fond tous les
   * `mj-style` en un seul bloc, et cette règle ne doit pas partager le sort de celui du dessus : un
   * client qui en refuserait une seule déclaration peut jeter le bloc entier, et les cartes
   * resteraient alors empilées sur écran large. Isolée, elle se comporte comme les colonnes MJML.
   * ⚠️ Non vérifié client par client : c'est le même montage que MJML, rien de plus n'est affirmé.
   */
  if (ctx.desktopCss.length > 0) {
    children.push({
      tagName: "mj-raw",
      attributes: {},
      content:
        `<style type="text/css">\n@media only screen and (min-width:${ctx.columnBreakpoint}px) {\n` +
        ctx.desktopCss.map((rule) => `  ${rule}`).join("\n") +
        `\n}\n</style>` +
        `<style media="screen and (min-width:${ctx.columnBreakpoint}px)">\n` +
        ctx.desktopCss.map((rule) => `.moz-text-html ${rule}`).join("\n") +
        `\n</style>`,
    });
  }

  return { tagName: "mj-head", attributes: {}, children };
}

/* ------------------------------------------------------------------ *
 * Document complet
 * ------------------------------------------------------------------ */

function rowNode(row: Row, ctx: Ctx): MjmlNode {
  const theme = ctx.theme;
  const rowRes = resolve(theme, box(theme.rowPadding), row.style);
  const percents = columnPercents(row.layout);
  const rowPad = rowRes.padding;

  const classes: string[] = [];
  if (rowRes.hideOnMobile) classes.push("nf-hide-mobile");

  // Marges / typo mobiles de la ROW. Poussées AVANT celles des colonnes et des blocs : à
  // spécificité égale, c'est l'ordre d'apparition qui tranche, et le niveau le plus fin doit gagner.
  // `fontSizeMobile` est pris sur la row seule — cascadé, il ressort déjà sur chaque bloc ; ici il
  // couvre en plus ce qui ne porte pas de classe de bloc (bloc `html`, footer légal).
  const rowMobile = mobileClass(ctx, "mr", "wrapper", row.style?.fontSizeMobile, rowRes.paddingMobile);
  if (rowMobile) classes.push(rowMobile);

  const rowBackground = rowRes.backgroundColor ?? theme.contentBackground;
  // Bandeau de marque (rangée sans texte, fond posé ou image) : son fond est épinglé contre le thème
  // sombre des clients mail, sinon le logo transparent qu'il porte devient illisible (cf. `pinClass`).
  // `pinDarkRows: false` (22/09/2026) laisse le client recolorer ces bandeaux comme le reste.
  const rowDark = theme.pinDarkRows !== false && rangeeAEpingler(row) ? pinClass(ctx, rowBackground) : undefined;
  if (rowDark) classes.push(rowDark);

  const attrs: Record<string, MjmlAttrValue> = {
    padding: padAttr(rowPad),
    "background-color": rowBackground,
    "text-align": rowRes.align,
  };
  if (classes.length > 0) attrs["css-class"] = classes.join(" ");

  const children: MjmlNode[] = row.columns.flatMap((col: Column, index: number) => {
    const colRes = resolve(theme, { top: 0, right: 0, bottom: 0, left: 0 }, col.style, [row.style]);
    const colAttrs: Record<string, MjmlAttrValue> = {
      width: percents[index] as string,
      padding: padAttr(colRes.padding),
      "vertical-align": colRes.verticalAlign ?? "top",
    };
    if (col.style?.backgroundColor) colAttrs["background-color"] = col.style.backgroundColor;
    if (colRes.borderWidth > 0) {
      colAttrs["border"] = `${colRes.borderWidth}px solid ${colRes.borderColor}`;
    }

    // Une colonne peut cumuler masquage mobile et overrides mobiles : on ACCUMULE les classes au
    // lieu d'écraser l'attribut, sinon le second réglage posé effaçait le premier en silence.
    const colClasses: string[] = [];
    if (colRes.hideOnMobile) colClasses.push("nf-hide-mobile");
    const colMobile = mobileClass(ctx, "mc", "wrapper", col.style?.fontSizeMobile, colRes.paddingMobile);
    if (colMobile) colClasses.push(colMobile);
    if (colClasses.length > 0) colAttrs["css-class"] = colClasses.join(" ");

    const node: MjmlNode = {
      tagName: "mj-column",
      attributes: colAttrs,
      children: col.blocks.flatMap((block) =>
        guard(
          blockNode(block, ctx, row.style, col.style, (blockPad) =>
            innerWidthPx(theme, row.layout, index, rowPad, colRes.padding, blockPad),
          ),
          blockCondition(block),
        ),
      ),
    };
    return guard(node, col.visibleIf);
  });

  return { tagName: "mj-section", attributes: attrs, children };
}

/** Construit l'AST JSON MJML complet. Exporté pour les tests de snapshot. */
export function buildAst(doc: EmailDoc): { ast: MjmlNode; warnings: string[] } {
  const ctx: Ctx = {
    theme: doc.theme,
    columnBreakpoint: doc.theme.columnBreakpoint ?? COLUMN_BREAKPOINT,
    mobileCss: [],
    desktopCss: [],
    stackedCss: [],
    colClasses: new Map(),
    darkKeep: new Map(),
    warnings: [],
    seq: 0,
  };

  // On rend le corps AVANT le head : le head a besoin des media queries collectées en chemin.
  const sections = doc.rows.flatMap((row) => guard(rowNode(row, ctx), row.visibleIf));

  const body: MjmlNode = {
    tagName: "mj-body",
    attributes: {
      "background-color": doc.theme.bodyBackground,
      width: `${doc.theme.contentWidth}px`,
      "css-class": "nf-body",
    },
    children: [
      {
        tagName: "mj-wrapper",
        attributes: { padding: "0", "css-class": "nf-content", "background-color": doc.theme.contentBackground },
        children: sections,
      },
    ],
  };

  const ast: MjmlNode = {
    tagName: "mjml",
    // `dir` (22/09/2026) : absent = `auto`, comme avant.
    attributes: { lang: doc.meta.locale, dir: doc.meta.dir ?? "auto" },
    children: [headNode(doc, ctx), body],
  };

  return { ast, warnings: ctx.warnings };
}

/**
 * Compile l'AST en HTML via MJML. `validationLevel: "soft"` : on récolte les erreurs en warnings
 * plutôt que de faire exploser une publication pour un attribut exotique.
 *
 * ⚠️ ASYNC : MJML 5 renvoie une Promise (rupture par rapport à la v4, qui était synchrone).
 * Toute la chaîne `renderMjml` → `compileDoc` → route de publication est donc asynchrone.
 */
export async function renderMjml(doc: EmailDoc): Promise<MjmlRenderResult> {
  const { ast, warnings } = buildAst(doc);
  const out = await mjml2html(ast, {
    validationLevel: "soft",
    keepComments: true, // ⚠️ NON NÉGOCIABLE : les marqueurs <!--nf:if--> doivent survivre.
    minify: false,
  });
  const errors = out.errors.map((e) => e.formattedMessage ?? e.message);
  return { html: patchHtml(out.html, doc), errors: [...warnings, ...errors] };
}

/**
 * Derniers correctifs que MJML ne pose pas lui-même :
 *  - neutralise les `#000000` / `#ffffff` purs qui auraient pu se glisser via un bloc `html` —
 *    sauf si le thème le refuse (`neutralizePureColors: false`, 22/09/2026) ;
 *  - écrit le repli du prénom de la langue du modèle (ou celui du modèle) dans chaque
 *    `{{first_name}}` nu (`poserRepliPrenom`). Anglais sans réglage : rien ne change.
 */
function patchHtml(html: string, doc: EmailDoc): string {
  const neutre =
    doc.theme.neutralizePureColors === false
      ? html
      : html.replace(/#000000\b/gi, NEAR_BLACK).replace(/#ffffff\b/gi, doc.theme.contentBackground);
  return poserRepliPrenom(neutre, defaultFirstName(doc.meta.locale, doc.meta.firstNameFallback));
}
