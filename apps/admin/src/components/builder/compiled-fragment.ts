/**
 * Ce que le canvas pose AUTOUR du HTML compilé d'un bloc — et rien dedans.
 *
 * Le contenu d'un bloc vient du compilateur (`lib/canvas-render.ts`). Restent au canvas trois choses,
 * toutes ici, toutes mesurables sans navigateur :
 *  1. le CONTEXTE que l'e-mail donne à ce HTML (la colonne MJML qui l'entoure) ;
 *  2. les CADRES de row et de colonne, qui ne sont pas des blocs et que le canvas dessine lui-même
 *     pour garder la sélection et le glisser-déposer — ils suivent la cascade de `rowNode` ;
 *  3. le CHROME d'édition (champs à remplir, alt manquant…) : des repères, jamais du contenu.
 */
import type { CSSProperties } from "react";
import { isPlaceholderSrc, type Block, type Column, type EmailDoc, type Row, type Spacing, type Theme } from "@nf/render/schema";
import { defaultArticleCta } from "@nf/render/cta";
import { goesNowhere } from "@nf/render/links";

/* ------------------------------------------------------------------ *
 * Contexte du fragment
 * ------------------------------------------------------------------ */

/**
 * La colonne MJML telle qu'elle entoure un bloc dans l'e-mail (mesuré sur mjml@5.4.0) : un `div` à
 * `font-size:0`, puis la table intérieure dont chaque bloc est une ligne. Sans elle, un fragment
 * `<tr>…</tr>` posé nu serait jeté par l'analyseur HTML, et un bloc `html` brut n'hériterait pas de la
 * taille de police nulle qu'il hérite chez l'abonné.
 *
 * ⚠️ Le padding, le fond et la bordure de la colonne n'y sont PAS : le cadre de colonne du canvas les
 * porte déjà (`columnFrameStyle`). Les répéter ici les doublerait.
 */
export const FRAGMENT_OPEN =
  '<div class="nfc-col" style="font-size:0px;text-align:left;direction:ltr;word-spacing:normal;">' +
  '<table border="0" cellpadding="0" cellspacing="0" role="presentation" style="" width="100%"><tbody>';
export const FRAGMENT_CLOSE = "</tbody></table></div>";

export const fragmentMarkup = (html: string): string => `${FRAGMENT_OPEN}${html}${FRAGMENT_CLOSE}`;

/**
 * Feuille propre à chaque racine d'ombre.
 *  - `all: initial` : le HTML compilé n'hérite de RIEN de l'interface (police, couleur, casse du bloc
 *    parent…), exactement comme dans une boîte de réception où il n'a que le `<body>` au-dessus de lui.
 *  - `pointer-events: none` sur tout le contenu : un clic tombe sur l'hôte, donc sur le bloc — la
 *    sélection, le double-clic d'édition et les dépôts de la palette continuent de marcher, et un lien
 *    de l'e-mail ne peut pas faire quitter l'éditeur.
 */
export const SHADOW_RESET_CSS = ":host{all:initial;display:block;}\n*{pointer-events:none !important;}";

/**
 * Ce qu'on retire d'un fragment AVANT de le poser dans une racine d'ombre.
 *
 * ⛔ POURQUOI, ALORS QUE LE COMPILATEUR ÉCHAPPE DÉJÀ. Une racine d'ombre vit dans l'ORIGINE DE L'ADMIN :
 * un `<img onerror>` qui s'y glisserait s'exécuterait avec la session de l'auteur. Le compilateur échappe
 * le texte, mais un attribut mal fermé quelque part (une URL d'image, une icône sociale) suffirait. Le
 * fragment est donc d'abord analysé dans un `<template>` — inerte : rien n'y charge ni ne s'y exécute —
 * puis nettoyé selon ces deux règles, puis seulement adopté. Le bloc `html` brut, lui, ne passe jamais
 * par là : il va dans une `<iframe sandbox>` (voir `rawFrameDocument`).
 *
 * Rien de ce qui est retiré n'a d'effet dans une boîte de réception (aucun client n'exécute de script) :
 * le nettoyage ne change pas ce que l'abonné voit.
 */
const BALISES_INTERDITES = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "base", "meta", "link", "form", "noscript"]);
export const dangerousTag = (tag: string): boolean => BALISES_INTERDITES.has(tag.toLowerCase());

const ATTRIBUTS_URL = new Set(["href", "src", "action", "formaction", "xlink:href", "background", "poster"]);
export function dangerousAttr(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith("on") || n === "srcdoc") return true;
  // Les navigateurs ignorent blancs et caractères de contrôle en tête d'URL : `\tjavascript:` s'exécute.
  return ATTRIBUTS_URL.has(n) && /^(?:javascript|vbscript|data:text\/html)/i.test(value.replace(/[\u0000- ]/g, ""));
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Document d'une `<iframe>` isolée pour un bloc `html` BRUT. Son contenu passe tel quel dans l'e-mail
 * (c'est le contrat du bloc) : il peut porter des gestionnaires d'événements qu'une racine d'ombre
 * exécuterait dans l'origine de l'admin. L'`<iframe sandbox>` sans `allow-scripts` n'en exécute aucun.
 * Les polices de la marque y sont rechargées : celles de l'éditeur ne traversent pas une `<iframe>`.
 */
export function rawFrameDocument(html: string, css: string, fontHrefs: readonly string[] = []): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    fontHrefs.map((h) => `<link rel="stylesheet" href="${attr(h)}">`).join("") +
    `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>` +
    "</head>" +
    '<body style="margin:0;display:flow-root;word-spacing:normal;">' +
    fragmentMarkup(html) +
    "</body></html>"
  );
}

/**
 * La feuille du compilateur, en thème CLAIR seulement.
 *
 * Ses règles `prefers-color-scheme: dark` sont faites pour la boîte de réception. Dans l'éditeur,
 * elles s'appliqueraient selon le réglage du SYSTÈME de l'auteur : deux personnes verraient deux
 * canvas différents pour le même document, sans rien qui le dise. Le thème sombre se regarde dans
 * l'aperçu, qui a son interrupteur et l'annonce. `color-scheme` part avec : dans une `<iframe>`, il
 * suffit à peindre le fond en noir.
 */
export function lightOnly(css: string): string {
  return css
    .replace(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, "@media not all")
    .replace(/(?:supported-)?color-schemes?\s*:[^;}]*;?/gi, "");
}

/** Jeton que le worker remplit avec le pied légal du destinataire (`packages/render/src/compile/mjml.ts`). */
export const LEGAL_FOOTER_TOKEN = "{{legal_footer_html}}";

/**
 * Pose le VRAI pied légal de la marque à la place du jeton. Le HTML vient de `buildFooter` via
 * `GET /api/builder/legal-footer-preview` : texte échappé, liens personnels remplacés par `#`.
 */
export function withLegalFooter(html: string, footerHtml: string | null): string {
  if (footerHtml === null) return html;
  return html.split(LEGAL_FOOTER_TOKEN).join(footerHtml);
}

/**
 * Le pied légal CHOISI par le document (`footer_legal.legalTemplateId`), ou `null` pour celui de
 * l'édition. Même lecture que `legalTemplateIdOf` (`lib/data/legal-footer-templates.ts`), que ce
 * module client ne peut pas importer : il tire la base et la session.
 */
export function chosenLegalTemplateId(doc: Pick<EmailDoc, "rows">): string | null {
  for (const row of doc.rows) {
    for (const col of row.columns) {
      for (const block of col.blocks) if (block.type === "footer_legal") return block.legalTemplateId ?? null;
    }
  }
  return null;
}

export const hasLegalFooter = (doc: Pick<EmailDoc, "rows">): boolean =>
  doc.rows.some((r) => r.columns.some((c) => c.blocks.some((b) => b.type === "footer_legal")));

/* ------------------------------------------------------------------ *
 * Cadres de row et de colonne — la cascade de `rowNode`, pas celle de `boxCss`
 * ------------------------------------------------------------------ */

type Box = Required<Spacing>;

const complet = (s: Spacing | undefined, base: Box): Box => ({
  top: s?.top ?? base.top,
  right: s?.right ?? base.right,
  bottom: s?.bottom ?? base.bottom,
  left: s?.left ?? base.left,
});

const ZERO: Box = { top: 0, right: 0, bottom: 0, left: 0 };

const padding = (b: Box): CSSProperties => ({
  paddingTop: b.top,
  paddingRight: b.right,
  paddingBottom: b.bottom,
  paddingLeft: b.left,
});

/**
 * Cadre d'une row, comme `mj-section` le pose.
 *
 * ⛔ Le padding du thème est la BASE, celui de la row le complète CÔTÉ PAR CÔTÉ (`mergePadding`). Le
 * canvas remplaçait l'un par l'autre ; une row sans style perdait donc `theme.rowPadding` à l'écran.
 * ⛔ Pas de bordure ni d'arrondi : le compilateur n'en émet aucun sur une section.
 */
export function rowFrameStyle(row: Row, theme: Theme): CSSProperties {
  return {
    ...padding(complet(row.style?.padding, complet(theme.rowPadding, ZERO))),
    backgroundColor: row.style?.backgroundColor ?? theme.contentBackground,
  };
}

/** `vertical-align` d'une cellule MJML -> `align-self` d'un enfant flex. */
const VERTICAL_ALIGN_CSS: Record<"top" | "middle" | "bottom", CSSProperties["alignSelf"]> = {
  top: "flex-start",
  middle: "center",
  bottom: "flex-end",
};

/**
 * Cadre d'une colonne, comme `mj-column` le pose : padding de la colonne seule (aucun défaut de thème),
 * fond, bordure pleine à la couleur de bordure du thème par défaut, alignement vertical hérité de la row.
 * Pas d'arrondi : le compilateur n'en émet pas sur une colonne.
 */
export function columnFrameStyle(col: Column, row: Row, theme: Theme): CSSProperties {
  const largeur = col.style?.borderWidth ?? 0;
  return {
    ...padding(complet(col.style?.padding, ZERO)),
    ...(col.style?.backgroundColor ? { backgroundColor: col.style.backgroundColor } : {}),
    ...(largeur > 0 ? { border: `${largeur}px solid ${col.style?.borderColor ?? theme.borderColor}` } : {}),
    alignSelf: VERTICAL_ALIGN_CSS[col.style?.verticalAlign ?? row.style?.verticalAlign ?? "top"],
  };
}

/* ------------------------------------------------------------------ *
 * Bloc texte EN COURS D'ÉDITION
 * ------------------------------------------------------------------ */

type TextBlock = Extract<Block, { type: "text" }>;

/**
 * Les presets du compilateur (`PRESETS`, `packages/render/src/compile/mjml.ts`), non exportés.
 * ⚠️ Recopiés, donc tenus par un banc : `compiled-fragment.test.ts` compile chaque preset et exige
 * ces valeurs dans le HTML émis. Une valeur qui bouge là-bas rougit ici.
 */
export const TEXT_PRESETS: Record<TextBlock["preset"], { size: (t: Theme) => number; weight: string; lineHeight: number }> = {
  h1: { size: () => 28, weight: "700", lineHeight: 1.25 },
  h2: { size: () => 22, weight: "700", lineHeight: 1.3 },
  h3: { size: () => 18, weight: "600", lineHeight: 1.35 },
  body: { size: (t) => t.fontSize, weight: "400", lineHeight: 1.55 },
  small: { size: () => 13, weight: "400", lineHeight: 1.5 },
};

/**
 * Le style de l'éditeur en place d'un bloc texte.
 *
 * Pendant la frappe, le canvas ne peut pas montrer le HTML compilé : il faut un `contentEditable`
 * sous le curseur. On lui donne alors EXACTEMENT les valeurs que le compilateur posera — même cascade
 * (row → colonne → bloc pour la typo, le bloc seul pour la boîte), même preset — pour que le texte ne
 * saute pas quand l'édition se ferme et que le fragment compilé revient.
 */
export function textEditStyle(block: TextBlock, row: Row, col: Column, theme: Theme): CSSProperties {
  const herite = <K extends "fontFamily" | "textColor" | "align" | "letterSpacing" | "textTransform" | "fontWeight">(k: K) =>
    block.style?.[k] ?? col.style?.[k] ?? row.style?.[k];
  const preset = TEXT_PRESETS[block.preset];
  // Un preset de titre suit les styles globaux des titres (24/09/2026), comme `PRESETS_TITRE` du compilateur.
  const titre = block.preset === "h1" || block.preset === "h2" || block.preset === "h3";
  return {
    ...padding(complet(block.style?.padding, complet(theme.blockPadding, ZERO))),
    ...(block.style?.backgroundColor ? { backgroundColor: block.style.backgroundColor } : {}),
    fontFamily: herite("fontFamily") ?? (titre ? theme.headingFont : undefined) ?? theme.fontFamily,
    color: herite("textColor") ?? (titre ? theme.headingColor : undefined) ?? theme.textColor,
    textAlign: herite("align") ?? "left",
    fontSize: block.style?.fontSize ?? preset.size(theme),
    lineHeight: block.style?.lineHeight ?? preset.lineHeight,
    fontWeight: herite("fontWeight") ?? preset.weight,
    letterSpacing: herite("letterSpacing"),
    textTransform: herite("textTransform"),
  };
}

/* ------------------------------------------------------------------ *
 * Fraîcheur d'un fragment
 * ------------------------------------------------------------------ */

/**
 * Tout ce dont dépend le rendu d'un bloc, en une chaîne : le bloc, sa place (mise en page, index de
 * colonne) et ses héritages (styles de row et de colonne, thème, langue — qui décide du CTA par défaut).
 * Deux clés différentes = le fragment affiché ne correspond plus au document : le canvas l'estompe
 * jusqu'à la compilation suivante, plutôt que de montrer comme actuel un rendu périmé.
 */
export function fragmentKeys(doc: EmailDoc): Map<string, string> {
  const racine = JSON.stringify([doc.theme, doc.meta.locale]);
  const out = new Map<string, string>();
  for (const row of doc.rows) {
    const rangee = JSON.stringify([row.layout, row.style ?? null]);
    row.columns.forEach((col, i) => {
      const colonne = JSON.stringify([i, col.style ?? null]);
      for (const block of col.blocks) out.set(block.id, `${racine}|${rangee}|${colonne}|${JSON.stringify(block)}`);
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Chrome d'édition
 * ------------------------------------------------------------------ */

export interface Hint {
  text: string;
  /** `warn` : ce qui part cassé ou incomplet ; `todo` : un champ encore vide. */
  tone: "todo" | "warn";
}

const vide = (s: string | undefined): boolean => s === undefined || s.trim() === "";

/** Ce que la pastille dit quand rien ne part : la CAUSE (le lien), pas le champ vide. */
export const NO_CTA_HINT = "Link goes nowhere — no CTA ships";

/**
 * Le libellé du lien de lecture qu'un article EMPORTERA : celui saisi, sinon le défaut de la langue —
 * mais seulement si le lien mène quelque part. Même ordre qu'à la compilation (`withDefaultCta`).
 */
export function articleCtaLabel(label: string | undefined, href: string, locale: string): string {
  if (label !== undefined && label.trim() !== "") return label;
  return goesNowhere(href) ? "" : defaultArticleCta(locale);
}

const aRemplir = (champs: [string, boolean][]): Hint[] => {
  const manquants = champs.filter(([, manque]) => manque).map(([nom]) => nom);
  return manquants.length === 0 ? [] : [{ text: `To fill: ${manquants.join(", ")}`, tone: "todo" }];
};

/**
 * Les repères d'édition d'un bloc. Le compilateur rend un champ vide… vide : sans ces repères, un bloc
 * métier fraîchement posé (tous ses libellés naissent vides, `factories.ts`) serait une bande blanche
 * sans rien qui dise quoi y mettre. Ils s'affichent PAR-DESSUS le rendu, jamais dedans.
 */
export function hintsFor(block: Block, locale: string): Hint[] {
  switch (block.type) {
    case "text":
      return block.paragraphs.every((p) => p.spans.every((s) => s.text.trim() === ""))
        ? [{ text: "Empty text block — double-click to write", tone: "todo" }]
        : [];
    case "image":
      if (isPlaceholderSrc(block.src)) return [{ text: `Illustration to be generated — ${block.src.slice(0, 70)}`, tone: "warn" }];
      // ⛔ Témoin INCONDITIONNEL : une image seule n'a aucun texte voisin qui la nomme (`schema.ts`).
      return vide(block.alt) ? [{ text: "Missing alt text", tone: "warn" }] : [];
    case "button":
      return aRemplir([["button label", vide(block.label)]]);
    case "html":
      return vide(block.raw) ? [{ text: "Empty HTML block", tone: "todo" }] : [];
    case "pick":
      return aRemplir([
        ["match label", vide(block.matchLabel)],
        ["selection", vide(block.selectionLabel)],
        ["market", vide(block.marketLabel)],
        ["odds", vide(block.oddsLabel)],
      ]);
    case "odds_table":
      return aRemplir([["rows", block.rows.every((r) => vide(r.label) && vide(r.value))]]);
    case "standings":
      return aRemplir([
        ["column names", block.columns.every(vide)],
        ["rows", block.rows.length === 0 || block.rows.every((r) => r.every(vide))],
      ]);
    case "scoreboard":
      return aRemplir([["rows", block.rows.every((r) => vide(r.label) && vide(r.value))]]);
    case "section_title":
      return aRemplir([["section title", vide(block.label)]]);
    case "callout":
      return aRemplir([["title or text", vide(block.title) && vide(block.body)]]);
    case "promo":
      return aRemplir([
        ["headline", vide(block.headline)],
        ["button label", vide(block.ctaLabel)],
      ]);
    case "article": {
      const out = aRemplir([
        ["title", vide(block.title)],
        ["excerpt", vide(block.excerpt)],
      ]);
      if (block.ctaStyle !== "none" && articleCtaLabel(block.ctaLabel, block.href, locale) === "") {
        out.push({ text: NO_CTA_HINT, tone: "warn" });
      }
      if (block.imageSrc !== undefined && isPlaceholderSrc(block.imageSrc)) {
        out.push({ text: "Illustration to be generated", tone: "warn" });
      } else if (block.imageSrc !== undefined && vide(block.imageAlt) && vide(block.title)) {
        // ⛔ Même seuil que `schema.ts`, MOT POUR MOT : une vignette TITRÉE est décorative.
        out.push({ text: "Missing alt text", tone: "warn" });
      }
      return out;
    }
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ *
 * Polices web
 * ------------------------------------------------------------------ */

/**
 * Hôtes dont le canvas charge la feuille de polices DANS LE DOCUMENT DE L'ADMIN.
 *
 * ⛔ POURQUOI UNE LISTE. Une `@font-face` déclarée dans une racine d'ombre est ignorée par Chrome : la
 * feuille doit entrer dans le document de l'interface, où une CSS quelconque pourrait restyler — ou
 * lire par sélecteurs d'attribut — tout l'écran. On n'y admet que des services de polices. Mesuré le
 * 22/09/2026 : les 62 `webFonts` en base pointent toutes sur `fonts.googleapis.com`. Une autre adresse
 * reste chargée dans l'aperçu, qui l'isole dans son `<iframe>`, et le canvas le dit.
 */
export const EDITOR_FONT_HOSTS: readonly string[] = ["fonts.googleapis.com", "fonts.bunny.net"];

/** L'URL à charger dans l'éditeur, ou `null` si elle n'est pas admise. */
export function editorFontHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !EDITOR_FONT_HOSTS.includes(url.hostname)) return null;
  return url.href;
}
