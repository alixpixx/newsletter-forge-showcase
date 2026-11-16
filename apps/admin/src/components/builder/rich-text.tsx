"use client";

/**
 * Édition de texte riche INLINE — pilote un `Paragraph[]` du schéma, jamais du HTML libre.
 *
 * Deux invariants portent tout le fichier :
 *
 *  1. **Le nœud éditable n'est pas re-rendu par React pendant la frappe.** React pose l'arbre une
 *     fois, le navigateur édite, et l'état remonte par SÉRIALISATION du DOM. Re-rendre un
 *     `contentEditable` à chaque touche remet le caret au début du nœud réécrit — c'est le bug
 *     classique de ce composant, et la seule parade est de ne pas toucher au DOM qu'on vient
 *     d'éditer (voir l'effet de synchronisation plus bas).
 *
 *  2. **La sérialisation est FERMÉE.** Tout élément hors allowlist est réduit à son texte, et les
 *     branches sans contenu utile (`<script>`, namespaces Office) sont jetées entières. Aucune
 *     balise étrangère ne peut donc traverser un collage depuis Word ou une page web : c'est ce qui
 *     rend ce composant acceptable en amont d'une chaîne de rendu email, où un `<div>` égaré casse
 *     Outlook et où un attribut inconnu casse la compatibilité.
 *
 * Les fonctions de sérialisation et de nettoyage sont exportées et PURES — elles se testent sans
 * navigateur (voir le script de vérification du scratchpad).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  Check,
  Italic,
  Link as LinkIcon,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Unlink,
  X,
} from "lucide-react";
import { escapeHtml, type InlineSpan, type Paragraph } from "@nf/render/schema";
import { cn } from "@/lib/utils";
import { MergeTagMenu } from "./merge-tags";

/* ------------------------------------------------------------------ *
 * Bornes — RECOPIÉES de packages/render/src/schema.ts
 *
 * Les dépasser ne dégrade pas le rendu : ça rend le document INVALIDE au parse, donc insauvegardable.
 * On préfère replier proprement ici plutôt que découvrir l'échec au moment de publier.
 * ------------------------------------------------------------------ */

const MAX_SPANS = 200;
const MAX_PARAGRAPHS = 200;
const MAX_SPAN_TEXT = 5000;
const MAX_HREF = 2048;
/** Garde-fou de récursion : un HTML Word imbrique volontiers très profond. */
const MAX_DEPTH = 60;

/* ------------------------------------------------------------------ *
 * Assainissement des valeurs
 * ------------------------------------------------------------------ */

/** Mêmes schémas bannis que `Href` / `ImageSrc` dans le schéma. */
const UNSAFE_SCHEME = /^\s*(?:javascript|vbscript|data|file|blob):/i;

export function safeHref(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const href = raw.trim();
  if (href === "" || href.length > MAX_HREF) return undefined;
  return UNSAFE_SCHEME.test(href) ? undefined : href;
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const BANNED_HEX = new Set(["#000", "#000000", "#fff", "#ffffff"]);

/**
 * Couleur → hex utilisable par le schéma, ou `undefined`.
 *
 * `HexColor` REFUSE le noir et le blanc purs (déclencheurs d'inversion dark mode) : les laisser
 * passer rendrait le document impossible à parser. Un `color:windowtext` de Word ou un nom CSS
 * tombe pour la même raison — on perd la couleur, la cascade du thème reprend la main.
 */
export function safeColor(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(value);
  const hex = rgb
    ? `#${[rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`
    : value;
  if (!HEX_RE.test(hex)) return undefined;
  return BANNED_HEX.has(hex) ? undefined : hex;
}

/**
 * Bloc Latin-1 de HTML 4, dans l'ordre des points de code 160→255. Word en émet massivement
 * (`&nbsp;`, `&eacute;`, `&laquo;`) et les noms sont SENSIBLES À LA CASSE — `&Eacute;` ≠ `&eacute;`.
 */
const LATIN1_ENTITIES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn " +
  "sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml " +
  "ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml " +
  "eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";

/** Autres entités courantes des presse-papiers réels. Une entité inconnue reste du texte. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "",
  hellip: "…", mdash: "—", ndash: "–", minus: "−", dagger: "†", permil: "‰", bull: "•",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  trade: "™", euro: "€", oelig: "œ", OElig: "Œ", scaron: "š", Scaron: "Š", Yuml: "Ÿ",
};
// Table Latin-1 dépliée : 96 noms, aucun à recopier à la main.
LATIN1_ENTITIES.split(" ").forEach((name, index) => {
  NAMED_ENTITIES[name] = String.fromCharCode(160 + index);
});

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/* ------------------------------------------------------------------ *
 * Arbre intermédiaire
 *
 * Le DOM du navigateur et le tokenizer du collage convergent vers CE type. La sérialisation ne
 * connaît que lui : elle est donc identique dans les deux chemins, et testable hors navigateur.
 * ------------------------------------------------------------------ */

export interface RichNode {
  /** 1 = élément, 3 = texte — mêmes valeurs que `Node.ELEMENT_NODE` / `Node.TEXT_NODE`. */
  type: 1 | 3;
  name?: string;
  text?: string;
  attrs?: Record<string, string>;
  children?: RichNode[];
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Contenu TEXTE BRUT au sens HTML : ce qu'il y a dedans n'est pas du balisage — et ne doit surtout
 * pas ressortir en texte visible. On saute jusqu'à la balise fermante au lieu de tokeniser.
 */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

/** Éléments qui ne s'imbriquent pas : une ouverture ferme implicitement la précédente. */
const AUTO_CLOSE = new Set(["p", "li", "td", "th", "tr", "option"]);

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/**
 * HTML → arbre. Tokenizer maison plutôt que `DOMParser` : mêmes résultats dans le navigateur et
 * sous `bun`, donc le nettoyage du collage — la fonction où tout se joue — est réellement testable.
 * Il n'a pas à être un parseur HTML complet : sa sortie n'est jamais réinjectée en HTML, elle est
 * réduite à des `Paragraph`, et une balise mal comprise dégénère au pire en texte.
 */
export function parseHtmlFragment(html: string): RichNode[] {
  const lower = html.toLowerCase();
  const root: RichNode = { type: 1, name: "#root", attrs: {}, children: [] };
  const stack: RichNode[] = [root];
  const top = (): RichNode => stack[stack.length - 1];
  const pushText = (raw: string) => {
    if (raw === "") return;
    top().children?.push({ type: 3, text: decodeEntities(raw) });
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    // Commentaires, y compris les conditionnels Word `<!--[if gte mso 9]>…<![endif]-->` : leur
    // contenu est du balisage Office, il n'a rien à faire dans un document.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    TAG_RE.lastIndex = lt;
    const match = TAG_RE.exec(html);
    if (match === null || match.index !== lt) {
      // Un `<` isolé : c'est du texte, pas une balise.
      pushText("<");
      i = lt + 1;
      continue;
    }
    i = TAG_RE.lastIndex;
    const name = match[2].toLowerCase();

    if (match[1] === "/") {
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    if (RAW_TEXT_TAGS.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      const end = close < 0 ? -1 : html.indexOf(">", close);
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let attr: RegExpExecArray | null = ATTR_RE.exec(match[3]);
    while (attr !== null) {
      attrs[attr[1].toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? "");
      attr = ATTR_RE.exec(match[3]);
    }

    if (AUTO_CLOSE.has(name) && top().name === name) stack.pop();
    const element: RichNode = { type: 1, name, attrs, children: [] };
    top().children?.push(element);
    if (!VOID_TAGS.has(name) && match[4] !== "/" && stack.length < MAX_DEPTH) stack.push(element);
  }

  return root.children ?? [];
}

/* ------------------------------------------------------------------ *
 * Arbre → Paragraph[] — l'allowlist
 * ------------------------------------------------------------------ */

interface Marks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  href?: string;
  color?: string;
}

const sameMarks = (span: InlineSpan, marks: Marks): boolean =>
  !!span.bold === !!marks.bold &&
  !!span.italic === !!marks.italic &&
  !!span.underline === !!marks.underline &&
  !!span.strike === !!marks.strike &&
  span.href === marks.href &&
  span.color === marks.color;

/** Éléments qui bornent un paragraphe. */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "center", "dd", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "html",
  "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "ul",
]);

/** Bloc « feuille » : s'il ne produit rien, c'est un paragraphe volontairement vide. */
const LEAF_BLOCK = new Set(["blockquote", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "p", "pre", "td", "th"]);

/**
 * Branches jetées ENTIÈREMENT (contenu compris) — pas seulement dépouillées de leur balise.
 * Réduire un `<script>` à son texte ferait apparaître son code dans la newsletter.
 */
const DROP = new Set([
  "script", "style", "noscript", "head", "title", "meta", "link", "base", "iframe", "object", "embed",
  "param", "template", "svg", "math", "canvas", "map", "area", "img", "picture", "video", "audio",
  "source", "track", "input", "select", "option", "textarea", "col", "colgroup",
]);

/** Namespaces Office (`<o:p>`, `<v:shape>`, `<w:sdt>`, `<st1:place>`) : du bruit Word, jamais du contenu. */
const OFFICE_NS = /^(?:o|v|w|m|x|st\d*):/;

function parseStyle(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  for (const declaration of raw.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    out[declaration.slice(0, colon).trim().toLowerCase()] = declaration.slice(colon + 1).trim();
  }
  // Les `mso-*` de Word atterrissent ici et n'en ressortent jamais : rien ne les lit.
  return out;
}

/** Retire le `<br>` fantôme que les navigateurs laissent en fin de bloc éditable. */
function stripFillerBreak(spans: InlineSpan[]): InlineSpan[] {
  const out = spans.map((s) => ({ ...s }));
  const last = out[out.length - 1];
  if (last !== undefined && last.text.endsWith("\n")) last.text = last.text.slice(0, -1);
  return out.filter((s) => s.text !== "");
}

/** Rogne les blancs de bord d'un paragraphe collé ; rend `[]` s'il ne restait que du vide. */
function trimEdges(spans: InlineSpan[]): InlineSpan[] {
  const out = spans.map((s) => ({ ...s })).filter((s) => s.text !== "");
  if (out.length === 0) return out;
  out[0].text = out[0].text.replace(/^\s+/, "");
  out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, "");
  const kept = out.filter((s) => s.text !== "");
  return kept.some((s) => s.text.trim() !== "") ? kept : [];
}

/**
 * Cœur de la sérialisation. `collapse` réduit les suites de blancs (sémantique HTML, pour le
 * collage) ; `keepEmpty` conserve les paragraphes vides (édition : une ligne blanche est une
 * intention de l'utilisateur, pas du bruit).
 */
export function paragraphsFromNodes(
  nodes: RichNode[],
  opts: { collapse?: boolean; keepEmpty?: boolean } = {},
): Paragraph[] {
  const out: Paragraph[] = [];
  let current: InlineSpan[] = [];

  const push = (raw: string, marks: Marks) => {
    let text = raw;
    if (opts.collapse && text.startsWith(" ")) {
      // Le HTML est plein de blancs de mise en forme ENTRE les balises : sans cette réduction
      // par-dessus la frontière des spans, un collage Word ressort criblé de doubles espaces.
      const previous = current[current.length - 1];
      if (previous === undefined || /\s$/.test(previous.text)) text = text.slice(1);
    }
    if (text === "") return;
    const last = current[current.length - 1];
    if (last !== undefined && sameMarks(last, marks)) {
      last.text = (last.text + text).slice(0, MAX_SPAN_TEXT);
      return;
    }
    const span: InlineSpan = { text: text.slice(0, MAX_SPAN_TEXT) };
    if (marks.bold) span.bold = true;
    if (marks.italic) span.italic = true;
    if (marks.underline) span.underline = true;
    if (marks.strike) span.strike = true;
    if (marks.href !== undefined) span.href = marks.href;
    if (marks.color !== undefined) span.color = marks.color;
    current.push(span);
  };

  const flush = () => {
    if (current.length === 0) return;
    const spans = opts.keepEmpty ? stripFillerBreak(current) : trimEdges(current);
    current = [];
    if (spans.length === 0) {
      if (opts.keepEmpty) out.push({ spans: [{ text: "" }] });
      return;
    }
    out.push({ spans });
  };

  const walk = (node: RichNode, marks: Marks, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (node.type === 3) {
      const text = node.text ?? "";
      push(opts.collapse ? text.replace(/\s+/g, " ") : text, marks);
      return;
    }
    const name = node.name ?? "";
    if (DROP.has(name) || OFFICE_NS.test(name)) return;
    // Le schéma n'a pas de nœud « saut de ligne » : un `<br>` devient un `\n` DANS le span. Le
    // document et la version texte le conservent ; le HTML email le voit comme un blanc (Outlook
    // n'accepte pas de `<br>` sans balise, et on ne touche pas au compilateur depuis ici).
    if (name === "br") {
      push("\n", marks);
      return;
    }

    const style = parseStyle(node.attrs?.style);
    const next: Marks = { ...marks };
    if (name === "b" || name === "strong") next.bold = true;
    if (name === "i" || name === "em") next.italic = true;
    if (name === "u" || name === "ins") next.underline = true;
    // `execCommand("strikeThrough")` rend `<strike>` sous Chrome, `<s>` ailleurs ; Word colle du
    // `<del>` ou une déclaration `line-through`. Les quatre formes disent la même chose.
    if (name === "s" || name === "strike" || name === "del") next.strike = true;
    if (name === "a") {
      const href = safeHref(node.attrs?.href);
      if (href !== undefined) next.href = href;
    }
    if (/^(?:bold(?:er)?|[6-9]00)$/.test((style["font-weight"] ?? "").toLowerCase())) next.bold = true;
    if ((style["font-style"] ?? "").toLowerCase() === "italic") next.italic = true;
    const decoration = (style["text-decoration"] ?? style["text-decoration-line"] ?? "").toLowerCase();
    if (decoration.includes("underline")) next.underline = true;
    if (decoration.includes("line-through")) next.strike = true;
    const color = safeColor(style.color ?? node.attrs?.color);
    if (color !== undefined) next.color = color;

    const children = node.children ?? [];
    // Tout ce qui n'est pas un bloc — y compris les balises INCONNUES — est transparent : on garde
    // le texte, on jette l'élément. C'est la clause qui ferme la sérialisation.
    if (!BLOCK.has(name)) {
      for (const child of children) walk(child, next, depth + 1);
      return;
    }

    flush();
    const before = out.length;
    for (const child of children) walk(child, next, depth + 1);
    const produced = current.length > 0;
    flush();
    if (opts.keepEmpty && !produced && out.length === before && LEAF_BLOCK.has(name)) {
      out.push({ spans: [{ text: "" }] });
    }
  };

  for (const node of nodes) walk(node, {}, 0);
  flush();
  return out;
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

function mergeSpans(spans: InlineSpan[]): InlineSpan[] {
  const merged: InlineSpan[] = [];
  for (const raw of spans) {
    const span: InlineSpan = { ...raw, text: raw.text.slice(0, MAX_SPAN_TEXT) };
    if (span.text === "") continue;
    const last = merged[merged.length - 1];
    // Sans cette fusion, chaque frappe ajoute un span et `spans` franchit la limite de 200 en
    // quelques phrases — le document devient insauvegardable sans qu'aucune erreur ne le dise.
    if (last !== undefined && sameMarks(last, span)) {
      last.text = (last.text + span.text).slice(0, MAX_SPAN_TEXT);
      continue;
    }
    merged.push(span);
  }
  if (merged.length === 0) return [{ text: "" }];
  if (merged.length <= MAX_SPANS) return merged;
  // Au-delà de 200 spans le document ne passe plus le parse. On replie la queue en un span neutre
  // plutôt que de la tronquer : perdre du GRAS est réparable, perdre des MOTS ne l'est pas.
  const head = merged.slice(0, MAX_SPANS - 1);
  const tail: InlineSpan = { text: merged.slice(MAX_SPANS - 1).map((s) => s.text).join("").slice(0, MAX_SPAN_TEXT) };
  const last = head[head.length - 1];
  // La queue repliée est neutre : si le span qui la précède l'est aussi, elle s'y fond — sinon
  // l'aller-retour par le HTML les fusionnerait quand même et le compte danserait d'un tour à l'autre.
  if (last !== undefined && sameMarks(last, tail)) last.text = (last.text + tail.text).slice(0, MAX_SPAN_TEXT);
  else head.push(tail);
  return head;
}

/** Fusionne les spans adjacents identiques et ramène le document dans les bornes du schéma. */
export function normalizeParagraphs(paragraphs: Paragraph[]): Paragraph[] {
  const out = paragraphs.map((p) => ({ spans: mergeSpans(p.spans) }));
  if (out.length === 0) return [{ spans: [{ text: "" }] }];
  if (out.length <= MAX_PARAGRAPHS) return out;
  const kept = out.slice(0, MAX_PARAGRAPHS);
  const overflow = out
    .slice(MAX_PARAGRAPHS)
    .map((p) => p.spans.map((s) => s.text).join(""))
    .join("\n");
  const last = kept[MAX_PARAGRAPHS - 1];
  kept[MAX_PARAGRAPHS - 1] = { spans: mergeSpans([...last.spans, { text: `\n${overflow}` }]) };
  return kept;
}

/* ------------------------------------------------------------------ *
 * Entrées / sorties publiques
 * ------------------------------------------------------------------ */

/**
 * Presse-papiers HTML → `Paragraph[]`. C'EST la fonction critique : elle est le seul chemin par
 * lequel du balisage extérieur (Word, page web) peut approcher le document, et elle n'en laisse
 * survivre que le texte, plus gras / italique / souligné / barré / lien / couleur.
 */
export function sanitizePastedHtml(html: string): Paragraph[] {
  return normalizeParagraphs(paragraphsFromNodes(parseHtmlFragment(html), { collapse: true }));
}

/** Presse-papiers texte brut → `Paragraph[]` : ligne vide = nouveau paragraphe, `\n` = saut de ligne. */
export function paragraphsFromPlainText(text: string): Paragraph[] {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n+/);
  return normalizeParagraphs(
    blocks.map((block) => ({ spans: [{ text: block.replace(/^\n+|\n+$/g, "") }] })).filter((p) => p.spans[0].text !== ""),
  );
}

function spansToHtml(spans: InlineSpan[]): string {
  const body = spans
    .map((span) => {
      let html = escapeHtml(span.text).replace(/\n/g, "<br>");
      if (span.bold) html = `<strong>${html}</strong>`;
      if (span.italic) html = `<em>${html}</em>`;
      if (span.underline) html = `<u>${html}</u>`;
      // Ordre d'imbrication IDENTIQUE à `spansToHtml` de compile/mjml.ts (strong → em → u → s →
      // couleur → lien) : l'aperçu de l'éditeur et l'email compilé produisent le même arbre.
      if (span.strike) html = `<s>${html}</s>`;
      // Re-validées ici et pas seulement à l'entrée : ce HTML part dans un `innerHTML`, il n'a le
      // droit de contenir que des valeurs dont on vient de prouver la forme.
      const color = safeColor(span.color);
      if (color !== undefined) html = `<span style="color:${color}">${html}</span>`;
      const href = safeHref(span.href);
      if (href !== undefined) html = `<a href="${escapeHtml(href)}">${html}</a>`;
      return html;
    })
    .join("");
  // Les navigateurs ne savent pas placer le caret dans un bloc vide sans `<br>`.
  return body === "" ? "<br>" : body;
}

/**
 * `Paragraph[]` → HTML de l'éditeur. C'est le SEUL HTML que ce composant produise : texte échappé,
 * jeu de balises fermé, attributs revalidés. D'où la légitimité du `innerHTML` de l'effet de
 * synchronisation — aucune chaîne étrangère n'atteint jamais le parseur du navigateur.
 */
export function paragraphsToHtml(paragraphs: Paragraph[]): string {
  const source = paragraphs.length > 0 ? paragraphs : [{ spans: [{ text: "" }] }];
  return source.map((p) => `<p>${spansToHtml(p.spans)}</p>`).join("");
}

/** DOM → arbre intermédiaire. Seule fonction du fichier qui touche à l'API DOM en lecture. */
function nodesFromDom(node: Node): RichNode[] {
  const out: RichNode[] = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      out.push({ type: 3, text: child.nodeValue ?? "" });
      return;
    }
    if (child.nodeType !== 1) return; // commentaire, CDATA… : rien à en tirer
    const element = child as Element;
    const attrs: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) attrs[attribute.name.toLowerCase()] = attribute.value;
    out.push({ type: 1, name: element.nodeName.toLowerCase(), attrs, children: nodesFromDom(element) });
  });
  return out;
}

/** DOM éditable → `Paragraph[]`. Appelée à chaque `input` : c'est elle qui remonte l'état. */
export function serializeEditable(root: HTMLElement): Paragraph[] {
  return normalizeParagraphs(paragraphsFromNodes(nodesFromDom(root), { keepEmpty: true }));
}

/**
 * Forme d'un document une fois passé par le DOM éditable — idempotente, et donc comparable à ce que
 * `serializeEditable` rendra. Sans elle, un document dont l'aller-retour n'est pas exact au
 * caractère près (un `\n` final, que le navigateur ne distingue pas de son `<br>` de remplissage)
 * ferait réécrire le DOM à chaque rendu du parent — c'est-à-dire à chaque touche.
 */
export function canonicalize(paragraphs: Paragraph[]): Paragraph[] {
  return normalizeParagraphs(
    paragraphsFromNodes(parseHtmlFragment(paragraphsToHtml(paragraphs)), { keepEmpty: true }),
  );
}

const isBlank = (paragraphs: Paragraph[]): boolean => paragraphs.every((p) => p.spans.every((s) => s.text === ""));

/* ------------------------------------------------------------------ *
 * execCommand — confiné
 * ------------------------------------------------------------------ */

/**
 * SEUL appel à `document.execCommand` du composant.
 *
 * L'API est officiellement dépréciée, mais elle reste le seul moyen largement supporté d'appliquer
 * une marque à une SÉLECTION. L'alternative — découper les nœuds de texte à la main, réinsérer,
 * recalculer le `Range` — est précisément ce qui fait sauter le caret, c'est-à-dire le bug que tout
 * ce fichier cherche à éviter. Elle est donc isolée ici pour être remplaçable d'un bloc le jour où
 * une API standard (edit intents / Highlight API) sera généralisée.
 */
function runCommand(name: string, arg?: string): void {
  try {
    // `foreColor` sans CSS produit un `<font>` déprécié ; les autres commandes rendent des balises
    // sémantiques (`<b>`, `<i>`, `<u>`) qu'on préfère au `<span style>`.
    document.execCommand("styleWithCSS", false, name === "foreColor" ? "true" : "false");
    document.execCommand(name, false, arg);
  } catch {
    /* Navigateur sans execCommand : la frappe reste possible, seule la mise en forme est perdue. */
  }
}

/** Même famille dépréciée que `runCommand` — l'état des boutons de la barre. */
function commandState(name: string): boolean {
  try {
    return document.queryCommandState(name);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Composant
 * ------------------------------------------------------------------ */

interface ToolbarState {
  top: number;
  left: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  href: string | null;
}

const TOOL_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

export function InlineRichText({
  value,
  onChange,
  placeholder,
  className,
  editable = true,
}: {
  value: Paragraph[];
  onChange: (next: Paragraph[]) => void;
  placeholder?: string;
  className?: string;
  /** false = lecture seule (aperçu). */
  editable?: boolean;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const painted = useRef(false);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);

  /**
   * L'UNIQUE endroit où le DOM éditable est écrit. On ne le réécrit que si le document reçu diffère
   * VRAIMENT de ce que le DOM représente déjà : pendant la frappe, `value` change à chaque touche
   * (c'est notre propre écho), et toucher au DOM à ce moment-là replacerait le caret au début.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    if (painted.current && JSON.stringify(canonicalize(value)) === JSON.stringify(serializeEditable(host))) return;
    painted.current = true;
    host.innerHTML = paragraphsToHtml(value);
  }, [value]);

  const emit = useCallback(() => {
    const host = hostRef.current;
    if (host === null) return;
    onChange(serializeEditable(host));
  }, [onChange]);

  const anchorOfSelection = useCallback((node: Node | null): HTMLAnchorElement | null => {
    let current: Node | null = node;
    while (current !== null && current !== hostRef.current) {
      if (current.nodeType === 1 && (current as Element).tagName === "A") return current as HTMLAnchorElement;
      current = current.parentNode;
    }
    return null;
  }, []);

  const refreshToolbar = useCallback(() => {
    const host = hostRef.current;
    const selection = window.getSelection();
    if (host === null || selection === null || selection.rangeCount === 0) {
      setToolbar(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!host.contains(range.commonAncestorContainer)) {
      // Le focus est peut-être passé dans la barre elle-même (saisie de l'URL) : on ne referme que
      // si la sélection est vraiment partie ailleurs.
      if (toolbarRef.current === null || !toolbarRef.current.contains(document.activeElement)) {
        setToolbar(null);
        setLinkDraft(null);
      }
      return;
    }
    if (selection.isCollapsed) {
      setToolbar(null);
      setLinkDraft(null);
      return;
    }
    savedRange.current = range.cloneRange();
    const rect = range.getBoundingClientRect();
    setToolbar({
      top: rect.top,
      left: rect.left + rect.width / 2,
      bold: commandState("bold"),
      italic: commandState("italic"),
      underline: commandState("underline"),
      strike: commandState("strikeThrough"),
      href: anchorOfSelection(range.commonAncestorContainer)?.getAttribute("href") ?? null,
    });
  }, [anchorOfSelection]);

  const restoreRange = useCallback(() => {
    const range = savedRange.current;
    const selection = window.getSelection();
    hostRef.current?.focus();
    if (range === null || selection === null) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  useEffect(() => {
    if (!editable) return;
    // Firefox insère un `<br>` sur Entrée dans un `div[contenteditable]` : on lui réclame des `<p>`,
    // pour que « Entrée = nouveau paragraphe » corresponde vraiment à un `Paragraph` du schéma.
    runCommand("defaultParagraphSeparator", "p");
  }, [editable]);

  useEffect(() => {
    if (!editable) return;
    const onScroll = () => refreshToolbar();
    document.addEventListener("selectionchange", refreshToolbar);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("selectionchange", refreshToolbar);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [editable, refreshToolbar]);

  const applyMark = useCallback(
    (command: string, arg?: string) => {
      restoreRange();
      runCommand(command, arg);
      emit();
      refreshToolbar();
    },
    [emit, refreshToolbar, restoreRange],
  );

  /**
   * Insertion d'une variable de personnalisation AU CURSEUR.
   *
   * La barre flottante n'apparaît que sur une sélection non vide : insérer tel quel remplacerait le
   * texte sélectionné. On replie donc la plage sur sa FIN — la sélection survit, la variable
   * atterrit juste après. `insertText` et non `insertHTML` : `{{first_name}}` doit rester du TEXTE
   * littéral dans le span, c'est `hydrate()` qui le résout à l'envoi.
   */
  const insertMergeTag = useCallback(
    (token: string) => {
      const range = savedRange.current;
      if (range !== null) {
        const collapsed = range.cloneRange();
        collapsed.collapse(false);
        savedRange.current = collapsed;
      }
      restoreRange();
      runCommand("insertText", token);
      emit();
      refreshToolbar();
    },
    [emit, refreshToolbar, restoreRange],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      // Maj+X est LE raccourci de barré partagé par Docs, Notion et Slack — on ne l'invente pas.
      // Les trois autres exigent l'ABSENCE de Maj : sans ça Ctrl+Maj+B (bascule des favoris dans
      // plusieurs navigateurs) mettrait la sélection en gras au passage.
      const command = event.shiftKey
        ? key === "x"
          ? "strikeThrough"
          : null
        : key === "b"
          ? "bold"
          : key === "i"
            ? "italic"
            : key === "u"
              ? "underline"
              : null;
      if (command === null) return;
      // Ctrl+U est « voir la source » hors champ éditable : on tranche explicitement plutôt que de
      // dépendre du comportement par défaut, qui varie d'un navigateur à l'autre.
      event.preventDefault();
      runCommand(command);
      emit();
      refreshToolbar();
    },
    [emit, refreshToolbar],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const html = event.clipboardData.getData("text/html");
      const paragraphs =
        html.trim() === "" ? paragraphsFromPlainText(event.clipboardData.getData("text/plain")) : sanitizePastedHtml(html);
      if (isBlank(paragraphs)) return;
      // On ne réinjecte que du HTML qu'on vient de fabriquer soi-même à partir de `Paragraph`
      // assainis : c'est ici que le balisage de Word est définitivement perdu. Un collage d'un seul
      // paragraphe reste inline, pour se fondre dans la ligne courante au lieu de la couper.
      runCommand(
        "insertHTML",
        paragraphs.length === 1 ? spansToHtml(paragraphs[0].spans) : paragraphsToHtml(paragraphs),
      );
      emit();
    },
    [emit],
  );

  const submitLink = useCallback(() => {
    const href = safeHref(linkDraft ?? "");
    setLinkDraft(null);
    restoreRange();
    runCommand(href === undefined ? "unlink" : "createLink", href);
    emit();
    refreshToolbar();
  }, [emit, linkDraft, refreshToolbar, restoreRange]);

  const showToolbar = editable && toolbar !== null && typeof document !== "undefined";

  return (
    <div className="relative">
      <div
        ref={hostRef}
        role={editable ? "textbox" : undefined}
        aria-multiline={editable ? true : undefined}
        aria-label={editable ? (placeholder ?? "Rich text") : undefined}
        contentEditable={editable}
        suppressContentEditableWarning
        spellCheck={editable}
        className={cn(
          "whitespace-pre-wrap break-words outline-none [&_p]:min-h-[1em] [&_p+p]:mt-2",
          editable && "focus-visible:outline-none",
          className,
        )}
        onInput={editable ? emit : undefined}
        onBlur={editable ? emit : undefined}
        onKeyDown={editable ? onKeyDown : undefined}
        onPaste={editable ? onPaste : undefined}
        // Un glisser-déposer insère du HTML étranger SANS passer par le nettoyage du collage.
        onDrop={editable ? (event) => event.preventDefault() : undefined}
      />

      {editable && placeholder !== undefined && isBlank(value) && (
        <span aria-hidden className="pointer-events-none absolute left-0 top-0 text-muted-foreground/50">
          {placeholder}
        </span>
      )}

      {showToolbar &&
        createPortal(
          <div
            ref={toolbarRef}
            role="toolbar"
            aria-label="Text formatting"
            style={{ top: toolbar.top - 8, left: toolbar.left, transform: "translate(-50%, -100%)" }}
            className="fixed z-50 flex items-center gap-0.5 rounded-[9px] border border-border bg-card p-1 shadow-[0_10px_36px_rgba(20,20,30,0.18)]"
            // Sans ça, le simple fait d'appuyer sur un bouton détruirait la sélection à styler.
            onMouseDown={(event) => {
              if (linkDraft === null) event.preventDefault();
            }}
          >
            {linkDraft === null ? (
              <>
                <button
                  type="button"
                  aria-label="Bold"
                  aria-pressed={toolbar.bold}
                  onClick={() => applyMark("bold")}
                  className={cn(TOOL_BUTTON, toolbar.bold && "bg-foreground text-background hover:bg-foreground")}
                >
                  <Bold className="h-3.5 w-3.5" strokeWidth={2.4} />
                </button>
                <button
                  type="button"
                  aria-label="Italic"
                  aria-pressed={toolbar.italic}
                  onClick={() => applyMark("italic")}
                  className={cn(TOOL_BUTTON, toolbar.italic && "bg-foreground text-background hover:bg-foreground")}
                >
                  <Italic className="h-3.5 w-3.5" strokeWidth={2.4} />
                </button>
                <button
                  type="button"
                  aria-label="Underline"
                  aria-pressed={toolbar.underline}
                  onClick={() => applyMark("underline")}
                  className={cn(TOOL_BUTTON, toolbar.underline && "bg-foreground text-background hover:bg-foreground")}
                >
                  <Underline className="h-3.5 w-3.5" strokeWidth={2.4} />
                </button>
                <button
                  type="button"
                  aria-label="Strikethrough"
                  title="Strikethrough (Ctrl/Cmd+Shift+X)"
                  aria-pressed={toolbar.strike}
                  onClick={() => applyMark("strikeThrough")}
                  className={cn(TOOL_BUTTON, toolbar.strike && "bg-foreground text-background hover:bg-foreground")}
                >
                  <Strikethrough className="h-3.5 w-3.5" strokeWidth={2.4} />
                </button>

                <span className="mx-0.5 h-4 w-px bg-border" />

                <button
                  type="button"
                  aria-label={toolbar.href === null ? "Add link" : "Edit link"}
                  aria-pressed={toolbar.href !== null}
                  onClick={() => setLinkDraft(toolbar.href ?? "")}
                  className={cn(TOOL_BUTTON, toolbar.href !== null && "bg-foreground text-background hover:bg-foreground")}
                >
                  <LinkIcon className="h-3.5 w-3.5" strokeWidth={2.4} />
                </button>
                {toolbar.href !== null && (
                  <button type="button" aria-label="Remove link" onClick={() => applyMark("unlink")} className={TOOL_BUTTON}>
                    <Unlink className="h-3.5 w-3.5" strokeWidth={2.4} />
                  </button>
                )}

                <span className="mx-0.5 h-4 w-px bg-border" />

                <label
                  className={cn(TOOL_BUTTON, "cursor-pointer")}
                  title="Text color"
                  // La sélection doit survivre à l'ouverture du sélecteur natif, qui vole le focus.
                  onPointerDown={() => refreshToolbar()}
                >
                  <span className="sr-only">Text color</span>
                  <input
                    type="color"
                    aria-label="Text color"
                    className="h-3.5 w-3.5 cursor-pointer appearance-none border-0 bg-transparent p-0"
                    onChange={(event) => {
                      const color = safeColor(event.target.value);
                      if (color !== undefined) applyMark("foreColor", color);
                    }}
                  />
                </label>
                <button
                  type="button"
                  aria-label="Clear formatting"
                  onClick={() => applyMark("removeFormat")}
                  className={TOOL_BUTTON}
                >
                  <RemoveFormatting className="h-3.5 w-3.5" strokeWidth={2.4} />
                </button>

                <span className="mx-0.5 h-4 w-px bg-border" />

                {/* Le registre fermé de `MergeTagMenu` — jamais un second sélecteur : un token hors
                    registre est SILENCIEUSEMENT retiré à l'hydratation, donc invisible jusqu'à
                    l'arrivée du mail chez l'abonné. */}
                <MergeTagMenu onInsert={insertMergeTag} />
              </>
            ) : (
              <>
                <input
                  autoFocus
                  value={linkDraft}
                  placeholder="https://… or {{merge_tag}}"
                  aria-label="Link URL"
                  onChange={(event) => setLinkDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitLink();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setLinkDraft(null);
                    }
                  }}
                  className="w-[220px] rounded-[6px] border border-border bg-background px-2 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                />
                <button type="button" aria-label="Apply link" onClick={submitLink} className={TOOL_BUTTON}>
                  <Check className="h-3.5 w-3.5" strokeWidth={2.4} />
                </button>
                <button type="button" aria-label="Cancel link" onClick={() => setLinkDraft(null)} className={TOOL_BUTTON}>
                  <X className="h-3.5 w-3.5" strokeWidth={2.4} />
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
