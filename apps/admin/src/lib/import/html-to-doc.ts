/**
 * Import d'un modèle HTML étranger → EmailDoc v2.
 *
 * POURQUOI un analyseur écrit à la main plutôt qu'une dépendance : on ingère du HTML dont on ne
 * sait rien. Un parseur maison n'accepte QUE ce qu'on a explicitement listé — les balises
 * exécutables et les attributs `on*` n'ont même pas de chemin pour entrer dans l'arbre. Avec une
 * lib généraliste il faudrait ensuite tout re-filtrer, et la liste des choses à filtrer est celle
 * qu'on aurait oubliée.
 *
 * POURQUOI on reconstruit de VRAIS blocs plutôt qu'un gros bloc `html` : un import qu'on ne peut
 * pas éditer ensuite ne sert à rien. Le bloc `html` reste la trappe de secours pour ce qu'on ne
 * sait pas traduire — il est compté et signalé à l'utilisateur, jamais la sortie par défaut.
 *
 * Les URLs ne sont pas re-filtrées ici : `Href` et `ImageSrc` (schéma) portent déjà la règle des
 * schémas dangereux. Une seule définition, donc aucune divergence possible.
 *
 * POURQUOI un `<style>` est LU alors qu'il est supprimé : sans ça un modèle stylé par classes
 * arrivait en noir et blanc, et l'utilisateur croyait à un import raté. La feuille interne est
 * traitée comme une SOURCE DE DONNÉES — jamais réinjectée — et seules les propriétés que notre
 * schéma sait porter en ressortent (voir `INLINABLE_PROPS`). Ce n'est pas un moteur CSS : pas de
 * combinateurs, pas de pseudo-classes, pas de media queries, pas d'héritage. Le dire vaut mieux
 * que le simuler à moitié, donc ce qui est ignoré est COMPTÉ et remonté dans le rapport.
 */
import {
  BoxStyle,
  EmailDoc,
  HexColor,
  Href,
  ImageSrc,
  MAX_BUTTON_LABEL,
  NEAR_BLACK,
  NEAR_WHITE,
  Spacing,
  escapeHtml,
  type Align,
  type Block,
  type BlockType,
  type Column,
  type EmailDoc as EmailDocT,
  type InlineSpan,
  type MenuItem,
  type Paragraph,
  type Row,
  type RowLayout,
  type SocialItem,
  type SocialPlatform,
  type TextPreset,
} from "@nf/render/schema";

/* ------------------------------------------------------------------ *
 * Plafonds — un fichier hostile ne doit pas pouvoir faire tomber la route
 * ------------------------------------------------------------------ */

/** Taille d'entrée maximale. Au-delà, on refuse AVANT de tokeniser. */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
/** Plafonds du schéma (rows ≤ 200, blocks ≤ 100 par colonne) — on ne les frôle pas par accident. */
const MAX_ROWS = 200;
const MAX_BLOCKS_PER_COLUMN = 100;
const MAX_BLOCKS = 400;
const MAX_NODES = 40_000;
const MAX_DEPTH = 40;
/** Au-delà, un bloc de secours devient illisible dans l'éditeur : on garde son texte à la place. */
const MAX_FALLBACK_CHARS = 20_000;
/** Feuille interne : on cesse de collecter au-delà, un `<style>` géant est du bruit, pas du style. */
const MAX_CSS_BYTES = 256 * 1024;
const MAX_CSS_RULES = 3_000;

/* ------------------------------------------------------------------ *
 * Rapport
 * ------------------------------------------------------------------ */

export interface ImportReport {
  rows: number;
  blocks: number;
  /**
   * ⚠️ Indexé sur `Block["type"]` et non sur `BlockType` : le flux d'articles est un type de bloc
   * du document que `BLOCK_TYPES` ne liste pas. Un import HTML n'en produit jamais, mais le
   * compteur est alimenté depuis `block.type` — restreindre la clé refusait la ligne à la
   * compilation pour un cas qui ne se produira pas.
   */
  byType: Partial<Record<Block["type"], number>>;
  /** Blocs `html` de secours — ce que l'import n'a pas su traduire. */
  fallbackHtml: number;
  /** Éléments supprimés pour raison de sécurité, par balise. */
  removed: { tag: string; count: number }[];
  strippedAttributes: number;
  unsafeUrls: number;
  unsubscribeLinks: number;
  flattenedRows: number;
  hiddenSkipped: number;
  trackingPixels: number;
  inlineImagesDropped: number;
  /**
   * Alt repris de l'`aria-label` de la MÊME balise `<img>`. ⚠️ Compté à part de l'`alt` d'origine
   * parce que la note doit dire D'OÙ vient le texte : le relecteur doit pouvoir aller vérifier la
   * bonne balise avant de publier.
   * ⛔ Il n'y a plus de compteur « depuis le title » : cette source a été RETIRÉE — voir le bloc
   * ALT plus bas. Ne pas le réintroduire sans réintroduire la source, sinon il comptera zéro et
   * fera croire à un chemin actif.
   */
  altFromAriaLabel: number;
  /**
   * Attributs `alt` D'ORIGINE écartés parce qu'ils étaient une URL ou un nom de fichier. ⛔ Compté à
   * part du repli : ici on a RETIRÉ quelque chose que le document source portait, et le relecteur
   * doit pouvoir le savoir — sinon un champ redevenu vide ressemble à une image que la source
   * n'avait jamais décrite.
   */
  altDropped: number;
  /**
   * Nombre de FOIS où une valeur noire / blanche pure a été LUE puis ramenée au quasi-noir /
   * quasi-blanc du schéma. ⚠️ Ce n'est PAS le nombre de couleurs du document : une même
   * déclaration est relue par plusieurs appelants (`bgOf` puis `boxStyleFrom`, la sonde
   * `isButtonLike` puis le style du bouton). C'est un MAJORANT — d'où une note qui dit QUE la
   * substitution a eu lieu et laquelle, sans avancer un compte que ces relectures gonfleraient.
   */
  pureBlackReads: number;
  pureWhiteReads: number;
  /** Déclarations reprises d'un `<style>` et posées en style inline sur l'élément visé. */
  inlinedDeclarations: number;
  /** Sélecteurs hors de portée de l'inliner minimal (descendants, pseudo-classes, media queries…). */
  skippedSelectors: number;
  /** `<link rel="stylesheet">` rencontrés — jamais téléchargés : leur style est perdu. */
  externalStylesheets: number;
  /** true si un plafond a été atteint : le document rendu est incomplet. */
  truncated: boolean;
  /** Messages destinés à l'utilisateur (UI admin en anglais). */
  notes: string[];
}

export interface HtmlImportOptions {
  assetSlug: string;
  locale?: string;
  /** Sujet de repli quand le HTML ne porte pas de `<title>`. */
  subject?: string;
}

export type ImportResult =
  | { ok: true; doc: EmailDocT; report: ImportReport }
  | { ok: false; code: "too_large" | "empty" | "invalid_doc"; error: string; issues?: string[]; report: ImportReport };

/* ------------------------------------------------------------------ *
 * Contexte d'import
 * ------------------------------------------------------------------ */

interface Ctx {
  report: ImportReport;
  removed: Map<string, number>;
  run: string;
  seq: number;
  blocks: number;
  title: string | null;
  preheader: string | null;
  /** Contenu brut des `<style>` du document, collecté à la tokenisation (jamais réinjecté). */
  css: string[];
  cssBytes: number;
}

function newCtx(): Ctx {
  return {
    report: {
      rows: 0,
      blocks: 0,
      byType: {},
      fallbackHtml: 0,
      removed: [],
      strippedAttributes: 0,
      unsafeUrls: 0,
      unsubscribeLinks: 0,
      flattenedRows: 0,
      hiddenSkipped: 0,
      trackingPixels: 0,
      inlineImagesDropped: 0,
      altFromAriaLabel: 0,
      altDropped: 0,
      pureBlackReads: 0,
      pureWhiteReads: 0,
      inlinedDeclarations: 0,
      skippedSelectors: 0,
      externalStylesheets: 0,
      truncated: false,
      notes: [],
    },
    removed: new Map(),
    // Préfixe aléatoire : deux documents importés peuvent être fusionnés sans collision d'ids.
    run: Math.random().toString(36).slice(2, 6),
    seq: 0,
    blocks: 0,
    title: null,
    preheader: null,
    css: [],
    cssBytes: 0,
  };
}

/** Ids séquentiels et non aléatoires : 400 appels à `newId()` dans la même milliseconde collisionnent. */
const nid = (ctx: Ctx, prefix: string): string => `${prefix}_${ctx.run}${(ctx.seq++).toString(36)}`;

const countRemoved = (ctx: Ctx, tag: string): void => {
  ctx.removed.set(tag, (ctx.removed.get(tag) ?? 0) + 1);
};

/* ------------------------------------------------------------------ *
 * Entités
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", middot: "·", bull: "•",
  laquo: "«", raquo: "»", deg: "°", times: "×", divide: "÷", plusmn: "±", frac12: "½", shy: "",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", ccedil: "ç", ugrave: "ù",
  uuml: "ü", ouml: "ö", auml: "ä", ntilde: "ñ", aacute: "á", iacute: "í", oacute: "ó", uacute: "ú",
  atilde: "ã", otilde: "õ", ccaron: "č", szlig: "ß", oslash: "ø", aring: "å", ae: "æ",
};

/**
 * Le `;` est EXIGÉ : sans lui, « AT&Tea » se décoderait en « AT<tea ». Cette exigence ne rouvre
 * aucune faille — `&#106;avascript:` porte bien son point-virgule et est donc décodé puis refusé
 * par `Href`.
 */
function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? match : hit;
  });
}

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------ *
 * Tokenisation
 * ------------------------------------------------------------------ */

type Attrs = Record<string, string>;

interface ElNode {
  kind: "el";
  name: string;
  attrs: Attrs;
  children: DomNode[];
}
interface TextNode {
  kind: "text";
  text: string;
}
type DomNode = ElNode | TextNode;

type Tok =
  | { t: "open"; name: string; attrs: Attrs; self: boolean }
  | { t: "close"; name: string }
  | { t: "text"; text: string };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Contenu consommé BRUT : un `</td>` à l'intérieur d'un `<script>` ne doit fermer aucune cellule. */
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "noscript", "xmp"]);
/** Supprimés AVEC leur sous-arbre : exécution, formulaires, contenu externe, métadonnées. */
const DROP_SUBTREE = new Set([
  "iframe", "object", "embed", "form", "template", "base", "link", "meta", "applet", "frame",
  "frameset", "svg", "math", "canvas", "audio", "video", "input", "select", "map", "portal",
  "head", "slot", "marquee",
]);
/** Retirés sans le dire : ce sont des métadonnées, pas un risque — le signaler serait du bruit. */
const SILENT_DROP = new Set(["head", "meta", "link", "base", "title"]);

const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9:_.-]*)/;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(src: string, ctx: Ctx): Attrs {
  const out: Attrs = {};
  if (!src.trim()) return out;
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src)) !== null) {
    const key = m[1].toLowerCase();
    // Les gestionnaires d'événements n'entrent JAMAIS dans l'arbre : rien à oublier plus tard.
    if (key.startsWith("on") || key === "srcdoc" || key === "formaction" || key === "xlink:href") {
      ctx.report.strippedAttributes++;
      continue;
    }
    if (key in out) continue;
    out[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function findClose(lower: string, name: string, from: number): { start: number; next: number } {
  const at = lower.indexOf(`</${name}`, from);
  if (at < 0) return { start: lower.length, next: lower.length };
  const gt = lower.indexOf(">", at);
  return { start: at, next: gt < 0 ? lower.length : gt + 1 };
}

function tokenize(html: string, ctx: Ctx): Tok[] {
  const lower = html.toLowerCase();
  const toks: Tok[] = [];
  let i = 0;
  const pushText = (s: string) => {
    if (s) toks.push({ t: "text", text: decodeEntities(s) });
  };

  while (i < html.length && toks.length < MAX_NODES * 3) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(html.slice(i));
      i = html.length;
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    const m = TAG_RE.exec(html.slice(lt, lt + 64));
    if (!m) {
      // `<` littéral (« a < b ») : ce n'est pas une balise, c'est du texte.
      pushText("<");
      i = lt + 1;
      continue;
    }

    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    let j = lt + m[0].length;
    let quote = "";
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    const attrSrc = html.slice(lt + m[0].length, j);
    i = j < html.length ? j + 1 : html.length;

    if (closing) {
      toks.push({ t: "close", name });
      continue;
    }

    const self = /\/\s*$/.test(attrSrc) || VOID.has(name);
    if (RAW_TEXT.has(name)) {
      if (!SILENT_DROP.has(name)) countRemoved(ctx, name);
      if (self) continue;
      const end = findClose(lower, name, i);
      if (name === "title" && ctx.title === null) ctx.title = collapse(decodeEntities(html.slice(i, end.start)));
      // La balise `<style>` est supprimée comme avant ; son TEXTE est mis de côté pour l'inliner.
      // C'est une donnée à analyser, pas du code à réémettre — rien ne repart dans le document.
      if (name === "style" && ctx.cssBytes < MAX_CSS_BYTES) {
        const css = html.slice(i, end.start);
        ctx.cssBytes += css.length;
        ctx.css.push(css.slice(0, MAX_CSS_BYTES));
      }
      i = end.next;
      continue;
    }

    const attrs = parseAttrs(attrSrc, ctx);
    // Feuille externe : elle ne sera JAMAIS téléchargée (une requête sortante déclenchée par un
    // fichier étranger, c'est du SSRF). Comptée ICI et pas dans l'arbre, parce qu'un `<link>` vit
    // presque toujours dans `<head>`, dont le sous-arbre entier est jeté avant d'être visité.
    if (name === "link" && /\bstylesheet\b/i.test(attrs.rel ?? "")) ctx.report.externalStylesheets++;

    toks.push({ t: "open", name, attrs, self });
  }

  // Sortie sur plafond de jetons : le document sera incomplet, l'utilisateur doit l'apprendre ici
  // et pas en découvrant un email coupé en deux.
  if (i < html.length) ctx.report.truncated = true;
  return toks;
}

/* ------------------------------------------------------------------ *
 * Arbre tolérant
 * ------------------------------------------------------------------ */

/** Fermetures implicites du HTML réel : `<td>` ferme le `<td>` précédent, etc. */
const IMPLICIT_CLOSE: Record<string, string[]> = {
  li: ["li", "p"],
  p: ["p"],
  td: ["td", "th", "p"],
  th: ["td", "th", "p"],
  tr: ["td", "th", "tr", "p"],
  tbody: ["td", "th", "tr", "tbody", "thead", "tfoot"],
  thead: ["td", "th", "tr", "tbody", "thead", "tfoot"],
  tfoot: ["td", "th", "tr", "tbody", "thead", "tfoot"],
  dt: ["dt", "dd", "p"],
  dd: ["dt", "dd", "p"],
};

const BLOCKISH = new Set([
  "address", "article", "aside", "blockquote", "center", "div", "dl", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
  "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "li",
]);

function buildTree(toks: Tok[], ctx: Ctx): ElNode {
  const root: ElNode = { kind: "el", name: "#root", attrs: {}, children: [] };
  const stack: ElNode[] = [root];
  let skip: { name: string; depth: number } | null = null;
  let nodes = 0;

  for (const tok of toks) {
    if (skip) {
      if (tok.t === "open" && tok.name === skip.name && !tok.self) skip.depth++;
      else if (tok.t === "close" && tok.name === skip.name && --skip.depth <= 0) skip = null;
      continue;
    }

    if (tok.t === "text") {
      // Le blanc pur est conservé sous forme d'espace : il sépare deux spans (« <b>a</b> <b>b</b> »).
      stack[stack.length - 1].children.push({ kind: "text", text: tok.text.trim() ? tok.text : " " });
      continue;
    }

    if (tok.t === "close") {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === tok.name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    if (DROP_SUBTREE.has(tok.name)) {
      if (!SILENT_DROP.has(tok.name)) countRemoved(ctx, tok.name);
      if (!tok.self) skip = { name: tok.name, depth: 1 };
      continue;
    }

    if (++nodes > MAX_NODES) {
      ctx.report.truncated = true;
      break;
    }

    const implicit = IMPLICIT_CLOSE[tok.name];
    if (implicit) {
      while (stack.length > 1 && implicit.includes(stack[stack.length - 1].name)) stack.pop();
    } else if (BLOCKISH.has(tok.name)) {
      while (stack.length > 1 && stack[stack.length - 1].name === "p") stack.pop();
    }

    const el: ElNode = { kind: "el", name: tok.name, attrs: tok.attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!tok.self && !VOID.has(tok.name)) {
      // Trop profond : on cesse de descendre plutôt que d'exploser la pile. Le contenu reste
      // attaché au dernier parent ouvert — dégradé, mais jamais perdu.
      if (stack.length < MAX_DEPTH) stack.push(el);
      else ctx.report.truncated = true;
    }
  }

  return root;
}

/* ------------------------------------------------------------------ *
 * Lecture des styles
 * ------------------------------------------------------------------ */

const EMPTY_STYLE: Record<string, string> = {};

function styleOf(el: ElNode): Record<string, string> {
  const raw = el.attrs.style;
  if (!raw) return EMPTY_STYLE;
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const c = part.indexOf(":");
    if (c < 0) continue;
    const key = part.slice(0, c).trim().toLowerCase();
    const value = part.slice(c + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/**
 * ⚠️ Compteur de MODULE, pas un champ de `Ctx` : `toHex` est appelé depuis une douzaine de
 * fonctions pures (`bgOf`, `borderOf`, `boxStyleFrom`, `isButtonLike`…) qui n'ont pas le contexte
 * sous la main ; le leur faire traverser pour deux entiers coûterait plus cher que la mesure ne
 * rapporte. Sûr ici parce que `htmlToDoc` est SYNCHRONE de bout en bout — aucun `await` ne peut
 * entrelacer deux imports — et parce qu'il est remis à zéro à l'entrée.
 * ⛔ Si une étape d'import devient un jour asynchrone, ce compteur se met à mélanger deux
 * documents : il doit alors repasser dans `Ctx`.
 */
const pureSubstitutions = { black: 0, white: 0 };

/** Hex validé par le schéma. Les noirs/blancs purs sont ramenés aux quasi-noir/blanc (dark mode). */
function toHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "transparent" || v === "inherit" || v === "none") return undefined;
  if (v === "black") {
    pureSubstitutions.black++;
    return NEAR_BLACK;
  }
  if (v === "white") {
    pureSubstitutions.white++;
    return NEAR_WHITE;
  }

  let hex: string | null = null;
  if (/^#[0-9a-f]{3}$/.test(v) || /^#[0-9a-f]{6}$/.test(v)) {
    hex = v;
  } else {
    const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+)\s*)?\)/.exec(v);
    if (m) {
      const alpha = m[4] === undefined ? 1 : Number(m[4]);
      const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (alpha > 0.05 && rgb.every((n) => n >= 0 && n <= 255)) {
        hex = `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      }
    }
  }
  if (!hex) return undefined;
  if (hex === "#000" || hex === "#000000") {
    pureSubstitutions.black++;
    return NEAR_BLACK;
  }
  if (hex === "#fff" || hex === "#ffffff") {
    pureSubstitutions.white++;
    return NEAR_WHITE;
  }
  return HexColor.safeParse(hex).success ? hex : undefined;
}

function pxOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(-?\d+(?:\.\d+)?)\s*(px)?$/.exec(value.trim());
  return m ? Number(m[1]) : undefined;
}

const clampInt = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)));

function bgOf(el: ElNode): string | undefined {
  const st = styleOf(el);
  return toHex(st["background-color"]) ?? toHex(st.background) ?? toHex(el.attrs.bgcolor);
}

function alignOf(el: ElNode): Align | undefined {
  const st = styleOf(el);
  const v = (st["text-align"] ?? el.attrs.align ?? "").trim().toLowerCase();
  return v === "left" || v === "center" || v === "right" ? v : undefined;
}

/** Largeur déclarée d'une cellule/image, avec son unité — le ratio n'a de sens qu'à unité égale. */
function dimOf(el: ElNode, prop: "width" | "height"): { value: number; unit: "px" | "%" } | undefined {
  const st = styleOf(el);
  const raw = (st[prop] ?? el.attrs[prop] ?? "").trim();
  if (!raw) return undefined;
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(raw);
  if (pct) return { value: Number(pct[1]), unit: "%" };
  const px = pxOf(raw);
  return px === undefined ? undefined : { value: px, unit: "px" };
}

function paddingOf(st: Record<string, string>): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  const shorthand = st.padding;
  if (shorthand) {
    const parts = shorthand.split(/\s+/).map(pxOf);
    if (parts.length >= 1 && parts.length <= 4 && parts.every((p) => p !== undefined)) {
      const v = parts as number[];
      out.top = v[0];
      out.right = v.length > 1 ? v[1] : v[0];
      out.bottom = v.length > 2 ? v[2] : v[0];
      out.left = v.length > 3 ? v[3] : v.length > 1 ? v[1] : v[0];
    }
  }
  const sides = [
    ["padding-top", "top"],
    ["padding-right", "right"],
    ["padding-bottom", "bottom"],
    ["padding-left", "left"],
  ] as const;
  for (const [prop, side] of sides) {
    const v = pxOf(st[prop]);
    if (v !== undefined) out[side] = v;
  }
  const keys = Object.keys(out);
  if (keys.length === 0) return undefined;
  for (const k of keys) out[k] = clampInt(out[k], 0, 200);
  return Spacing.safeParse(out).success ? out : undefined;
}

/**
 * Bordure. Largeur et couleur ne sortent QU'ENSEMBLE : une largeur seule ferait dessiner au
 * compilateur un trait dans la couleur de thème (`borderColor: own ?? theme.borderColor`), soit
 * une bordure que le HTML d'origine ne demandait pas.
 */
function borderOf(st: Record<string, string>): { width: number; color: string } | undefined {
  let width: number | undefined;
  let color: string | undefined;

  const shorthand = st.border?.trim();
  if (shorthand) {
    const parts = shorthand.split(/\s+/);
    // `border: none` / `border: 0` : absence de bordure, à ne pas confondre avec « non déclarée ».
    if (parts.some((p) => p === "none" || p === "hidden")) return undefined;
    for (const part of parts) {
      if (width === undefined) {
        const px = pxOf(part);
        if (px !== undefined) {
          width = px;
          continue;
        }
      }
      if (color === undefined) color = toHex(part);
    }
  }

  const explicitWidth = pxOf(st["border-width"]);
  if (explicitWidth !== undefined) width = explicitWidth;
  const explicitColor = toHex(st["border-color"]);
  if (explicitColor) color = explicitColor;

  if (width === undefined || width <= 0 || !color) return undefined;
  return { width: clampInt(width, 1, 12), color };
}

function lineHeightOf(st: Record<string, string>, fontSize: number | undefined): number | undefined {
  const raw = st["line-height"];
  if (!raw) return undefined;
  const unitless = /^(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (unitless) {
    const n = Number(unitless[1]);
    return n >= 1 && n <= 3 ? n : undefined;
  }
  const px = pxOf(raw);
  if (px === undefined || !fontSize) return undefined;
  const ratio = px / fontSize;
  return ratio >= 1 && ratio <= 3 ? Math.round(ratio * 100) / 100 : undefined;
}

const SAFE_FONT = /^[a-zA-Z0-9 ,'"_-]+$/;

/**
 * Style de boîte porté par l'élément d'origine. Chaque champ est validé UN À UN puis l'objet
 * complet repasse par `BoxStyle` : le document produit ne peut pas contenir de style invalide.
 */
function boxStyleFrom(el: ElNode): BoxStyle | undefined {
  const st = styleOf(el);
  const draft: Record<string, unknown> = {};

  const bg = bgOf(el);
  if (bg) draft.backgroundColor = bg;
  const color = toHex(st.color ?? el.attrs.color);
  if (color) draft.textColor = color;
  const align = alignOf(el);
  if (align) draft.align = align;

  const fontSize = pxOf(st["font-size"]);
  if (fontSize !== undefined && fontSize >= 8 && fontSize <= 72) draft.fontSize = Math.round(fontSize);
  const lineHeight = lineHeightOf(st, fontSize);
  if (lineHeight) draft.lineHeight = lineHeight;

  const family = st["font-family"];
  if (family && family.length <= 200 && SAFE_FONT.test(family)) draft.fontFamily = family;

  const padding = paddingOf(st);
  if (padding) draft.padding = padding;

  const radius = pxOf(st["border-radius"]);
  if (radius !== undefined && radius >= 0 && radius <= 48) draft.borderRadius = Math.round(radius);

  const border = borderOf(st);
  if (border) {
    draft.borderWidth = border.width;
    draft.borderColor = border.color;
  }

  if (Object.keys(draft).length === 0) return undefined;
  const parsed = BoxStyle.safeParse(draft);
  return parsed.success ? parsed.data : undefined;
}

/* ------------------------------------------------------------------ *
 * Inliner minimal : `<style>` → attribut `style`
 * ------------------------------------------------------------------ */

/**
 * Propriétés reprises d'une feuille interne. Rien d'autre ne franchit la barrière, et la liste
 * n'est pas arbitraire : ce sont EXACTEMENT celles que le document sait porter ensuite —
 * `BoxStyle` (fond, texte, alignement, police, interligne, padding, bordure, rayon) et les marques
 * d'`InlineSpan` (gras, italique, souligné). Inliner autre chose reviendrait à écrire dans
 * l'attribut `style` des déclarations que personne ne relit — du poids, pas du rendu.
 *
 * `display` est volontairement absent : il ne se traduit dans aucun champ du schéma, et une classe
 * `display:none` inlinée ferait DISPARAÎTRE du contenu importé (`isHidden`) sur la foi d'une media
 * query qu'on ne sait pas évaluer.
 */
const INLINABLE_PROPS = new Set([
  "color", "background-color", "background", "text-align",
  "font-size", "font-family", "font-weight", "font-style", "text-decoration", "line-height",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-width", "border-color", "border-radius",
]);

/** Jeu de caractères d'une valeur acceptable — tout le reste est écarté sans être analysé. */
const CSS_VALUE_OK = /^[a-zA-Z0-9 ,.#%()'"/_-]{1,200}$/;
/**
 * Interdits absolus. `url(` est banni en bloc : aucune propriété de cette liste n'a besoin d'une
 * ressource externe, et une valeur inlinée peut ressortir dans un bloc `html` de secours.
 */
const CSS_VALUE_BANNED = /url\s*\(|expression\s*\(|javascript:|vbscript:|data:|@import/i;

type SelectorKind = "tag" | "class" | "id";

interface CssRule {
  kind: SelectorKind;
  key: string;
  decls: [string, string][];
  /** Spécificité puis ordre d'apparition — la cascade réelle, à ce niveau de détail. */
  rank: number;
}

const TAG_SEL = /^[a-zA-Z][a-zA-Z0-9]*$/;
const CLASS_SEL = /^\.[-_a-zA-Z][-_a-zA-Z0-9]*$/;
const ID_SEL = /^#[-_a-zA-Z][-_a-zA-Z0-9]*$/;

/** Fin du bloc ouvert en `open`, accolades équilibrées (`@media` en contient d'autres). */
function skipBlock(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return i + 1;
  }
  return css.length;
}

function parseDeclarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of body.split(";")) {
    const c = part.indexOf(":");
    if (c < 0) continue;
    const prop = part.slice(0, c).trim().toLowerCase();
    if (!INLINABLE_PROPS.has(prop)) continue;
    // `!important` n'a pas de sens une fois la déclaration devenue inline : on le retire.
    const value = part.slice(c + 1).replace(/!\s*important/i, "").trim();
    if (!value || !CSS_VALUE_OK.test(value) || CSS_VALUE_BANNED.test(value)) continue;
    out.push([prop, value]);
  }
  return out;
}

/**
 * Règles exploitables d'une feuille. Tout ce qui sort du triplet `.classe` / `#id` / `balise` est
 * compté et jeté : sans arbre de sélecteurs, un `.a .b` appliqué à `.b` seul serait FAUX, et un
 * style faux est pire qu'un style absent.
 */
function parseStylesheet(css: string, ctx: Ctx, rules: CssRule[]): void {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  let i = 0;

  while (i < src.length && rules.length < MAX_CSS_RULES) {
    const open = src.indexOf("{", i);
    if (open < 0) break;

    // Une règle-DÉCLARATION (`@charset "utf-8";`, `@import …;`) se termine par `;` et n'ouvre aucun
    // bloc : elle traîne dans le prélude de la règle suivante. On ne garde que ce qui suit.
    const head = src.slice(i, open);
    const semi = head.lastIndexOf(";");
    if (semi >= 0) ctx.report.skippedSelectors += head.slice(0, semi).split(";").filter((s) => s.trim()).length;
    const prelude = head.slice(semi + 1).trim();

    // At-rules à bloc : `@media`, `@font-face`, `@supports`… sautées, accolades comprises.
    if (prelude.startsWith("@")) {
      ctx.report.skippedSelectors++;
      i = skipBlock(src, open);
      continue;
    }

    const close = src.indexOf("}", open);
    if (close < 0) break;
    const decls = parseDeclarations(src.slice(open + 1, close));
    i = close + 1;
    if (decls.length === 0) continue;

    for (const raw of prelude.split(",")) {
      const sel = raw.trim();
      if (!sel) continue;
      const order = rules.length;
      if (TAG_SEL.test(sel)) rules.push({ kind: "tag", key: sel.toLowerCase(), decls, rank: 1_000_000 + order });
      else if (CLASS_SEL.test(sel)) rules.push({ kind: "class", key: sel.slice(1), decls, rank: 10_000_000 + order });
      else if (ID_SEL.test(sel)) rules.push({ kind: "id", key: sel.slice(1), decls, rank: 100_000_000 + order });
      else ctx.report.skippedSelectors++;
    }
  }
}

/**
 * Applique la feuille interne en écrivant dans l'attribut `style` de chaque élément visé.
 *
 * POURQUOI passer par l'attribut plutôt qu'un registre parallèle : tout le reste du fichier lit le
 * style par `styleOf(el)`. En fusionnant ici, `boxStyleFrom`, `bgOf`, `alignOf` et les marques de
 * `spansFrom` héritent du travail sans qu'aucune de ces fonctions ne change — un seul point
 * d'entrée, donc aucun endroit où l'on aurait pu oublier de brancher la cascade.
 *
 * Les déclarations de la feuille sont écrites AVANT celles déjà présentes : `styleOf` lit de gauche
 * à droite et la dernière gagne, donc le style inline d'origine reste prioritaire, comme en CSS.
 */
function applyStylesheet(root: ElNode, ctx: Ctx): void {
  const rules: CssRule[] = [];
  for (const sheet of ctx.css) parseStylesheet(sheet, ctx, rules);
  if (rules.length === 0) return;

  const index = new Map<string, CssRule[]>();
  for (const rule of rules) {
    const k = `${rule.kind}|${rule.key}`;
    const bucket = index.get(k);
    if (bucket) bucket.push(rule);
    else index.set(k, [rule]);
  }

  const walk = (el: ElNode, depth: number): void => {
    if (depth > MAX_DEPTH) return;

    const matched: CssRule[] = [];
    const byTag = index.get(`tag|${el.name}`);
    if (byTag) matched.push(...byTag);
    for (const cls of (el.attrs.class ?? "").split(/\s+/)) {
      if (!cls) continue;
      const byClass = index.get(`class|${cls}`);
      if (byClass) matched.push(...byClass);
    }
    const byId = el.attrs.id ? index.get(`id|${el.attrs.id}`) : undefined;
    if (byId) matched.push(...byId);

    if (matched.length > 0) {
      matched.sort((a, b) => a.rank - b.rank);
      const merged = new Map<string, string>();
      for (const rule of matched) for (const [prop, value] of rule.decls) merged.set(prop, value);

      const own = el.attrs.style?.trim();
      const cascade = [...merged].map(([p, v]) => `${p}:${v}`).join(";");
      el.attrs.style = own ? `${cascade};${own}` : cascade;
      ctx.report.inlinedDeclarations += merged.size;
    }

    for (const child of el.children) {
      if (child.kind === "el") walk(child, depth + 1);
    }
  };

  walk(root, 0);
}

/* ------------------------------------------------------------------ *
 * URLs — la règle vit dans le schéma, pas ici
 * ------------------------------------------------------------------ */

/** Un lien de désabonnement écrit à la main est mort : la plateforme injecte le sien, signé. */
const HAND_WRITTEN_UNSUB = /unsubscribe|unsub=|opt-?out|list-unsubscribe|desabonn|d[eé]sinscri|descadastr/i;

type UrlProbe = { ok: true; value: string } | { ok: false; reason: "missing" | "unsafe" | "unsubscribe" };

/** Espaces et caractères de contrôle retirés AVANT validation (« java script: » ne doit pas passer). */
const normalizeUrl = (raw: string): string => raw.split("").filter((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) !== 127).join("");

function probeHref(raw: string | undefined): UrlProbe {
  if (!raw) return { ok: false, reason: "missing" };
  const value = normalizeUrl(raw);
  if (!value || value === "#") return { ok: false, reason: "missing" };
  if (HAND_WRITTEN_UNSUB.test(value)) return { ok: false, reason: "unsubscribe" };
  return Href.safeParse(value).success ? { ok: true, value } : { ok: false, reason: "unsafe" };
}

function probeSrc(raw: string | undefined): UrlProbe {
  if (!raw) return { ok: false, reason: "missing" };
  const value = normalizeUrl(raw);
  if (!value) return { ok: false, reason: "missing" };
  return ImageSrc.safeParse(value).success ? { ok: true, value } : { ok: false, reason: "unsafe" };
}

function safeHref(raw: string | undefined, ctx: Ctx): string | undefined {
  const probe = probeHref(raw);
  if (probe.ok) return probe.value;
  if (probe.reason === "unsafe") ctx.report.unsafeUrls++;
  if (probe.reason === "unsubscribe") ctx.report.unsubscribeLinks++;
  return undefined;
}

function safeSrc(raw: string | undefined, ctx: Ctx): string | undefined {
  const probe = probeSrc(raw);
  if (probe.ok) return probe.value;
  if (probe.reason === "unsafe") ctx.report.unsafeUrls++;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Petits utilitaires d'arbre
 * ------------------------------------------------------------------ */

function textOf(node: DomNode, budget = { n: 8000 }): string {
  if (node.kind === "text") {
    budget.n -= node.text.length;
    return node.text;
  }
  if (budget.n <= 0) return "";
  let out = "";
  for (const child of node.children) {
    out += textOf(child, budget);
    if (budget.n <= 0) break;
  }
  return out;
}

function findAll(node: ElNode, name: string, depth: number, acc: ElNode[] = []): ElNode[] {
  if (depth < 0) return acc;
  for (const child of node.children) {
    if (child.kind !== "el") continue;
    if (child.name === name) acc.push(child);
    findAll(child, name, depth - 1, acc);
  }
  return acc;
}

const containsImage = (el: ElNode): boolean => findAll(el, "img", 8).length > 0;

/** Enfants significatifs : les blancs purs et les `<br>` ne comptent pas. */
function meaningfulChildren(el: ElNode): DomNode[] {
  return el.children.filter((c) => (c.kind === "text" ? collapse(c.text) !== "" : c.name !== "br"));
}

function soleImage(el: ElNode): ElNode | null {
  if (collapse(textOf(el))) return null;
  const imgs = findAll(el, "img", 6);
  return imgs.length === 1 ? imgs[0] : null;
}

function isHidden(el: ElNode): boolean {
  const st = styleOf(el);
  return (st.display ?? "").replace(/\s+/g, "") === "none" || el.attrs.hidden !== undefined;
}

/**
 * Un bloc masqué en tête de document est le pré-en-tête : c'est LA convention email. On le
 * récupère au lieu de le jeter, et on le dit dans le rapport.
 */
function captureHidden(el: ElNode, ctx: Ctx): void {
  ctx.report.hiddenSkipped++;
  if (ctx.preheader !== null) return;
  const text = collapse(textOf(el));
  if (text && text.length <= 200) ctx.preheader = text;
}

/* ------------------------------------------------------------------ *
 * Texte riche
 * ------------------------------------------------------------------ */

interface Marks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  href?: string;
  color?: string;
}

const sameMarks = (span: InlineSpan, marks: Marks): boolean =>
  !!span.bold === !!marks.bold &&
  !!span.italic === !!marks.italic &&
  !!span.underline === !!marks.underline &&
  span.href === marks.href &&
  span.color === marks.color;

function trimSpans(spans: InlineSpan[]): InlineSpan[] {
  const out = spans.filter((s) => s.text !== "");
  if (out.length === 0) return out;
  out[0] = { ...out[0], text: out[0].text.replace(/^\s+/, "") };
  out[out.length - 1] = { ...out[out.length - 1], text: out[out.length - 1].text.replace(/\s+$/, "") };
  const kept = out.filter((s) => s.text !== "");
  return kept.some((s) => collapse(s.text) !== "") ? kept : [];
}

const INLINE = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "cite", "code", "del", "em", "font", "i", "ins", "kbd",
  "label", "mark", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time",
  "tt", "u", "var", "wbr",
]);

function spansFrom(nodes: DomNode[], ctx: Ctx): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: InlineSpan[] = [];

  const flush = () => {
    const cleaned = trimSpans(current);
    if (cleaned.length && paragraphs.length < 200) paragraphs.push({ spans: cleaned });
    current = [];
  };

  const push = (text: string, marks: Marks) => {
    if (!text) return;
    const last = current[current.length - 1];
    if (last && sameMarks(last, marks)) {
      last.text = (last.text + text).slice(0, 5000);
      return;
    }
    if (current.length >= 200) return;
    const span: InlineSpan = { text: text.slice(0, 5000) };
    if (marks.bold) span.bold = true;
    if (marks.italic) span.italic = true;
    if (marks.underline) span.underline = true;
    if (marks.href) span.href = marks.href;
    if (marks.color) span.color = marks.color;
    current.push(span);
  };

  const walk = (node: DomNode, marks: Marks, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (node.kind === "text") {
      push(node.text.replace(/\s+/g, " "), marks);
      return;
    }
    if (node.name === "br") {
      flush();
      return;
    }
    if (isHidden(node)) {
      captureHidden(node, ctx);
      return;
    }
    if (node.name === "img") {
      // Une image ne peut pas vivre DANS un paragraphe (le schéma n'a pas d'image inline).
      ctx.report.inlineImagesDropped++;
      return;
    }

    const next: Marks = { ...marks };
    const st = styleOf(node);
    if (node.name === "b" || node.name === "strong") next.bold = true;
    if (node.name === "i" || node.name === "em") next.italic = true;
    if (node.name === "u" || node.name === "ins") next.underline = true;
    if (node.name === "a") {
      const href = safeHref(node.attrs.href, ctx);
      if (href) next.href = href;
    }
    if (/^(bold(er)?|[6-9]00)$/.test((st["font-weight"] ?? "").trim())) next.bold = true;
    if ((st["font-style"] ?? "").trim() === "italic") next.italic = true;
    if ((st["text-decoration"] ?? "").includes("underline")) next.underline = true;
    const color = toHex(st.color ?? node.attrs.color);
    if (color) next.color = color;

    const blockish = BLOCKISH.has(node.name);
    if (blockish) flush();
    for (const child of node.children) walk(child, next, depth + 1);
    if (blockish) flush();
  };

  for (const node of nodes) walk(node, {}, 0);
  flush();
  return paragraphs;
}

/* ------------------------------------------------------------------ *
 * Fabriques de blocs
 * ------------------------------------------------------------------ */

function textBlockFrom(paragraphs: Paragraph[], preset: TextPreset, source: ElNode, ctx: Ctx): Block | null {
  if (paragraphs.length === 0) return null;
  const style = boxStyleFrom(source);
  return { id: nid(ctx, "blk"), type: "text", preset, paragraphs, ...(style ? { style } : {}) };
}

/*
 * ALT — QUI A ÉCRIT LA VALEUR, ET RIEN D'AUTRE.
 *
 * ⛔ Un alt inventé est PIRE que pas d'alt : il ment au lecteur d'écran ET il éteint le blocage de
 * publication (`EmailDocPublishable` refuse un `alt` vide). Quand aucune source fiable ne subsiste,
 * le champ VIDE est le résultat CORRECT — le blocage tient et quelqu'un écrit une vraie description.
 *
 * ⛔ POURQUOI L'ATTRIBUT `title` N'EST PLUS UNE SOURCE. Trois tours de correctifs ont tenté de
 * filtrer les valeurs inutilisables tirées du `title` d'une `<img>` — vocabulaire de mots creux,
 * comparaison au nom de fichier, marques typographiques. Chaque tour fermait une graphie et en
 * ouvrait une autre : « freepik-premium-photo » était rejeté mais « freepik premium photo » publié,
 * « hero-banner » rejeté et « hero banner » publié, « image1 » rejeté et « image 1 » publié. Le
 * verdict s'inversait sur la MÊME valeur selon son séparateur.
 * La cause n'était pas dans le filtre, elle est dans la SOURCE : sur WordPress le `title` d'une
 * image vaut par défaut le titre de médiathèque, c'est-à-dire le nom du fichier téléversé ou le nom
 * commercial d'une banque d'images. C'est une source POLLUÉE PAR CONSTRUCTION, qu'aucune liste de
 * mots ni heuristique de typographie ne nettoiera. Elle est donc RETIRÉE, pas filtrée.
 * ⚠️ LE COÛT, ASSUMÉ : un `title` qui est une vraie phrase (« Torcida do Lakeside no Maracana »)
 * est perdu lui aussi. On ne sait pas le distinguer d'un titre de médiathèque, et c'est le bon côté
 * de l'erreur — champ vide, publication bloquée, plutôt qu'une fausse description publiée.
 *
 * CE QUI RESTE — deux sources, une seule présomption. `alt` et `aria-label` sont tous deux écrits
 * DANS LE CHAMP PRÉVU POUR l'accessibilité : on les présume bons et on ne juge NI leur vocabulaire,
 * NI leur typographie, NI leur ressemblance au nom de fichier. « Flamengo », « Copa do Mundo 2026 »
 * face à `copa-do-mundo-2026.jpg`, « Estadio do Maracana com 78838 torcedores » passent INTACTS.
 * ⛔ Ne pas réintroduire ici le rapprochement avec le `src` : il punissait les sites BIEN TENUS,
 * ceux dont le nom de fichier reprend justement la description. Ni un motif d'identifiant : il
 * détruisait les alt qui portent un chiffre de foule ou une année.
 */

/** Extension de fichier en fin de valeur — `hero-banner-1024x768.jpg` ne décrit aucune image. */
const ALT_FILE_EXT = /\.(?:jpe?g|png|webp|gif|svg|avif|bmp|tiff?|heic|jfif)$/i;
/** La valeur EST une URL — elle désigne la ressource, elle ne la décrit pas. */
const ALT_URLISH = /^(?:https?:)?\/\//i;

/**
 * Les DEUX seuls verdicts incontestables : la valeur est une URL, ou elle porte une extension de
 * fichier. Aucun des deux ne juge un SENS — ils constatent une forme, dans n'importe quelle langue.
 * ⛔ Rien d'autre n'a sa place ici : tout critère qui pèse des mots refuse de vrais alt.
 */
function isFileNameOrUrl(text: string): boolean {
  return ALT_URLISH.test(text) || ALT_FILE_EXT.test(text);
}

/**
 * Repli `alt` → `aria-label`, TOUJOURS sur la MÊME balise `<img>`. ⛔ Jamais le parent, le titre de
 * l'article, le nom de fichier de l'URL, ni l'attribut `title` : ce sont des sources qui parlent
 * d'autre chose que de l'image, et les recopier fabriquerait une description fausse.
 */
function altOf(img: ElNode, ctx: Ctx): string {
  const own = collapse(img.attrs.alt ?? "").slice(0, 300);
  if (own !== "") {
    if (!isFileNameOrUrl(own)) return own;
    // Compté ICI, au moment de l'écart : c'est le seul endroit où l'on sait qu'une valeur existait.
    // Plus bas on ne saurait plus si le champ est vide faute d'attribut ou faute d'attribut UTILISABLE.
    ctx.report.altDropped++;
  }

  const aria = collapse(img.attrs["aria-label"] ?? "").slice(0, 300);
  if (aria !== "" && !isFileNameOrUrl(aria)) {
    ctx.report.altFromAriaLabel++;
    return aria;
  }
  // ⛔ Pas `own` : à ce point il est soit vide, soit une URL / un nom de fichier. Le rendre
  // publierait la chaîne qu'on vient d'écarter. Vide = blocage maintenu, c'est le bon résultat.
  return "";
}

function imageBlockFrom(img: ElNode, href: string | undefined, ctx: Ctx): Block | null {
  const src = safeSrc(img.attrs.src, ctx);
  if (!src) return null;

  const width = dimOf(img, "width");
  const height = dimOf(img, "height");
  // 1×1 : pixel de tracking du fournisseur d'origine. L'importer serait absurde (et indiscret).
  if ((width?.unit === "px" && width.value <= 3) || (height?.unit === "px" && height.value <= 3)) {
    ctx.report.trackingPixels++;
    return null;
  }

  const widthPct = width
    ? width.unit === "%"
      ? clampInt(width.value, 5, 100)
      : clampInt((width.value / 600) * 100, 5, 100)
    : 100;
  const style = boxStyleFrom(img);

  return {
    id: nid(ctx, "blk"),
    type: "image",
    src,
    // Vide reste vide quand aucun attribut de la balise ne décrit l'image : le blocage de
    // publication est le bon résultat, pas un échec à contourner.
    alt: altOf(img, ctx),
    widthPct,
    align: alignOf(img) ?? "center",
    ...(href ? { href } : {}),
    ...(style ? { style } : {}),
  };
}

function dividerBlockFrom(el: ElNode, ctx: Ctx): Block {
  const st = styleOf(el);
  const thickness = pxOf(st["border-top-width"]) ?? pxOf(st["border-width"]) ?? pxOf(el.attrs.size);
  const color = toHex(st["border-top-color"]) ?? toHex(st["border-color"]) ?? toHex(st.color) ?? bgOf(el);
  const width = dimOf(el, "width");
  const widthPct = width
    ? width.unit === "%"
      ? clampInt(width.value, 10, 100)
      : clampInt((width.value / 600) * 100, 10, 100)
    : 100;
  return {
    id: nid(ctx, "blk"),
    type: "divider",
    thickness: thickness === undefined ? 1 : clampInt(thickness, 1, 12),
    widthPct,
    ...(color ? { color } : {}),
  };
}

/** Un conteneur vide mais haut est un espaceur ; très plat et coloré, c'est un filet. */
function spacerOrDividerFrom(el: ElNode, ctx: Ctx): Block | null {
  if (collapse(textOf(el)) !== "" || containsImage(el) || findAll(el, "a", 6).length > 0) return null;
  const st = styleOf(el);
  const height =
    dimOf(el, "height")?.unit === "px"
      ? dimOf(el, "height")!.value
      : (pxOf(st["min-height"]) ?? pxOf(st["line-height"]) ?? pxOf(st["font-size"]));
  if (height === undefined || height <= 0) return null;

  const bg = bgOf(el);
  if (height <= 4 && bg) {
    return { id: nid(ctx, "blk"), type: "divider", thickness: clampInt(height, 1, 12), widthPct: 100, color: bg };
  }
  return { id: nid(ctx, "blk"), type: "spacer", height: clampInt(height, 1, 200) };
}

const BUTTON_CLASS = /\b(btn|button|cta)\b/i;

/**
 * Un « bouton » d'email est un `<a>` peint : fond, padding ou classe explicite. On accepte aussi
 * la cellule peinte qui ne contient que lui — c'est la construction bulletproof classique.
 */
function isButtonLike(a: ElNode, parent: ElNode): boolean {
  const st = styleOf(a);
  if (BUTTON_CLASS.test(a.attrs.class ?? "")) return true;
  if (toHex(st["background-color"]) ?? toHex(st.background)) return true;
  const padding = paddingOf(st);
  if (padding && (padding.top ?? 0) + (padding.bottom ?? 0) >= 12) return true;
  if (BUTTON_CLASS.test(parent.attrs.class ?? "") && meaningfulChildren(parent).length === 1) return true;
  return bgOf(parent) !== undefined && meaningfulChildren(parent).length === 1;
}

function buttonBlockFrom(a: ElNode, parent: ElNode, ctx: Ctx): Block | null {
  const href = safeHref(a.attrs.href, ctx);
  if (!href) return null;
  const label = collapse(textOf(a));
  // Trop long pour un bouton : il passerait à la ligne sous Outlook. On le laisse devenir du texte
  // lié — pas de perte, l'auteur décide ensuite.
  if (!label || label.length > MAX_BUTTON_LABEL) return null;

  const own = boxStyleFrom(a);
  const inherited = boxStyleFrom(parent);
  const style: BoxStyle = {
    ...(inherited?.backgroundColor ? { backgroundColor: inherited.backgroundColor } : {}),
    ...(own ?? {}),
  };
  const parsed = BoxStyle.safeParse(style);

  return {
    id: nid(ctx, "blk"),
    type: "button",
    label,
    href,
    align: alignOf(a) ?? alignOf(parent) ?? "center",
    ...(parsed.success && Object.keys(parsed.data).length > 0 ? { style: parsed.data } : {}),
  };
}

function listBlockFrom(el: ElNode, ctx: Ctx): Block | null {
  const ordered = el.name === "ol";
  const items = el.children.filter((c): c is ElNode => c.kind === "el" && c.name === "li");
  const paragraphs: Paragraph[] = [];
  items.forEach((li, index) => {
    const paras = spansFrom(li.children, ctx);
    if (paras.length === 0) return;
    // La puce est une convention de mise en forme, pas une donnée : elle est écrite en clair
    // pour que l'auteur puisse la retirer d'un coup de clavier.
    const marker = ordered ? `${index + 1}. ` : "• ";
    const first = paras[0];
    paragraphs.push({ spans: [{ text: marker }, ...first.spans].slice(0, 200) });
    for (const extra of paras.slice(1)) paragraphs.push(extra);
  });
  if (paragraphs.length === 0) return null;
  const style = boxStyleFrom(el);
  return {
    id: nid(ctx, "blk"),
    type: "text",
    preset: "body",
    paragraphs: paragraphs.slice(0, 200),
    ...(style ? { style } : {}),
  };
}

function menuBlockFrom(el: ElNode, ctx: Ctx): Block | null {
  const kids = meaningfulChildren(el);
  const anchors = kids.filter((c): c is ElNode => c.kind === "el" && c.name === "a");
  if (anchors.length < 2 || anchors.length > 8) return null;
  if (kids.some((c) => c.kind === "el" && c.name !== "a")) return null;

  let separator = "";
  for (const kid of kids) {
    if (kid.kind !== "text") continue;
    const t = collapse(kid.text);
    if (!t) continue;
    // Entre deux liens de menu il n'y a qu'un séparateur. Du vrai texte = ce n'est pas un menu.
    if (t.length > 8 || /[a-z0-9]/i.test(t)) return null;
    if (!separator) separator = t;
  }

  const items: MenuItem[] = [];
  for (const a of anchors) {
    if (containsImage(a)) return null;
    const label = collapse(textOf(a));
    const href = probeHref(a.attrs.href);
    if (!label || label.length > 40 || !href.ok) return null;
    items.push({ label, href: href.value });
  }

  const style = boxStyleFrom(el);
  return { id: nid(ctx, "blk"), type: "menu", items, separator: separator || "·", ...(style ? { style } : {}) };
}

const SOCIAL_HOSTS: [RegExp, SocialPlatform][] = [
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "facebook"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)(twitter\.com|x\.com)$/, "twitter"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)(t\.me|telegram\.me|telegram\.org)$/, "telegram"],
  [/(^|\.)(wa\.me|whatsapp\.com)$/, "whatsapp"],
];

function platformOf(href: string): SocialPlatform | null {
  try {
    const host = new URL(href).hostname.toLowerCase();
    for (const [re, platform] of SOCIAL_HOSTS) if (re.test(host)) return platform;
  } catch {
    /* relatif ou merge tag : pas de plateforme identifiable */
  }
  return null;
}

function socialBlockFrom(el: ElNode, ctx: Ctx): Block | null {
  const kids = meaningfulChildren(el);
  const anchors = kids.filter((c): c is ElNode => c.kind === "el" && c.name === "a");
  if (anchors.length < 1 || anchors.length > 10) return null;
  if (kids.length !== anchors.length) return null;

  const items: SocialItem[] = [];
  let recognized = 0;
  let iconSize: number | undefined;

  for (const a of anchors) {
    const img = soleImage(a);
    if (!img) return null;
    const href = probeHref(a.attrs.href);
    if (!href.ok) return null;
    const platform = platformOf(href.value);
    if (platform) recognized++;
    const iconSrc = probeSrc(img.attrs.src);
    const label = collapse(img.attrs.alt ?? "").slice(0, 40);
    const width = dimOf(img, "width");
    if (iconSize === undefined && width?.unit === "px" && width.value >= 16 && width.value <= 64) {
      iconSize = Math.round(width.value);
    }
    items.push({
      platform: platform ?? "web",
      href: href.value,
      ...(iconSrc.ok ? { iconSrc: iconSrc.value } : {}),
      ...(label ? { label } : {}),
    });
  }

  // Aucun réseau reconnu : ce sont des images cliquables ordinaires, pas une barre sociale.
  if (recognized === 0) return null;

  const style = boxStyleFrom(el);
  return {
    id: nid(ctx, "blk"),
    type: "social",
    items,
    iconSize: iconSize ?? 24,
    mode: "horizontal",
    ...(style ? { style } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Trappe de secours : sérialisation assainie
 * ------------------------------------------------------------------ */

const KEEP_ATTRS = new Set([
  "src", "href", "alt", "width", "height", "style", "bgcolor", "align", "valign", "colspan",
  "rowspan", "border", "cellpadding", "cellspacing", "dir", "title", "target",
]);
const DANGEROUS_CSS = /expression\s*\(|javascript:|vbscript:|url\s*\(\s*["']?\s*(?:javascript|vbscript|data):/i;

function serializeSafe(node: DomNode, ctx: Ctx, depth = 0): string {
  if (node.kind === "text") return escapeHtml(node.text);
  if (depth > MAX_DEPTH) return "";

  const attrs: string[] = [];
  for (const [key, raw] of Object.entries(node.attrs)) {
    if (!KEEP_ATTRS.has(key)) continue;
    let value = raw;
    if (key === "href") {
      const probe = probeHref(raw);
      if (!probe.ok) {
        if (probe.reason === "unsafe") ctx.report.unsafeUrls++;
        if (probe.reason === "unsubscribe") ctx.report.unsubscribeLinks++;
        continue;
      }
      value = probe.value;
    } else if (key === "src") {
      const probe = probeSrc(raw);
      if (!probe.ok) {
        if (probe.reason === "unsafe") ctx.report.unsafeUrls++;
        continue;
      }
      value = probe.value;
    } else if (key === "style" && DANGEROUS_CSS.test(raw)) {
      ctx.report.strippedAttributes++;
      continue;
    }
    attrs.push(` ${key}="${escapeHtml(value)}"`);
  }

  const open = `<${node.name}${attrs.join("")}>`;
  if (VOID.has(node.name)) return open;
  const inner = node.children.map((c) => serializeSafe(c, ctx, depth + 1)).join("");
  return `${open}${inner}</${node.name}>`;
}

function fallbackBlockFrom(el: ElNode, ctx: Ctx): Block | null {
  const raw = serializeSafe(el, ctx);
  if (collapse(textOf(el)) === "" && !containsImage(el)) return null;
  if (raw.length > MAX_FALLBACK_CHARS) {
    // Un pavé de HTML illisible n'aide personne : on garde le texte, qui reste éditable.
    const paragraphs = spansFrom(el.children, ctx);
    return textBlockFrom(paragraphs, "body", el, ctx);
  }
  ctx.report.fallbackHtml++;
  return { id: nid(ctx, "blk"), type: "html", raw };
}

/* ------------------------------------------------------------------ *
 * Sections → rows
 * ------------------------------------------------------------------ */

type Section =
  | { kind: "row"; layout: RowLayout; columns: Block[][]; style?: BoxStyle; colStyles: (BoxStyle | undefined)[] }
  | { kind: "blocks"; blocks: Block[]; style?: BoxStyle };

/** Deux suites de blocs ne fusionnent que si aucune ne porte de fond : sinon on perdrait la bande. */
function appendSections(out: Section[], incoming: Section[]): void {
  for (const section of incoming) {
    const last = out[out.length - 1];
    if (section.kind === "blocks" && last && last.kind === "blocks" && !last.style && !section.style) {
      last.blocks.push(...section.blocks);
    } else {
      out.push(section);
    }
  }
}

const blockBackground = (block: Block): string | undefined =>
  "style" in block ? block.style?.backgroundColor : undefined;

/** Le fond d'une cellule enveloppante retombe sur ce qu'elle contient — sans écraser l'existant. */
function applyBackground(sections: Section[], style: BoxStyle): void {
  const background = style.backgroundColor;
  for (const section of sections) {
    // Une cellule peinte qui n'enveloppe qu'un bouton déjà peint ne doit PAS repeindre toute la
    // largeur de l'email : la couleur appartenait au bouton, pas à la bande.
    if (
      section.kind === "blocks" &&
      background !== undefined &&
      section.blocks.length > 0 &&
      section.blocks.every((b) => blockBackground(b) === background)
    ) {
      continue;
    }
    section.style = { ...style, ...(section.style ?? {}) };
  }
}

function sectionsToBlocks(sections: Section[], ctx: Ctx): Block[] {
  const out: Block[] = [];
  for (const section of sections) {
    if (section.kind === "blocks") {
      out.push(...section.blocks);
    } else {
      // Une colonne ne peut pas contenir de colonnes : on aplatit et on le DIT.
      ctx.report.flattenedRows++;
      for (const column of section.columns) out.push(...column);
    }
  }
  return out.slice(0, MAX_BLOCKS_PER_COLUMN);
}

function sectionsToRows(sections: Section[], ctx: Ctx): Row[] {
  const rows: Row[] = [];
  const pushRow = (row: Row) => {
    if (rows.length >= MAX_ROWS) {
      ctx.report.truncated = true;
      return;
    }
    rows.push(row);
  };

  for (const section of sections) {
    if (section.kind === "row") {
      if (section.columns.every((c) => c.length === 0)) continue;
      const columns: Column[] = section.columns.map((blocks, i) => ({
        id: nid(ctx, "col"),
        blocks: blocks.slice(0, MAX_BLOCKS_PER_COLUMN),
        ...(section.colStyles[i] ? { style: section.colStyles[i] as BoxStyle } : {}),
      }));
      pushRow({
        id: nid(ctx, "row"),
        layout: section.layout,
        columns,
        ...(section.style ? { style: section.style } : {}),
      });
      continue;
    }
    if (section.blocks.length === 0) continue;
    // Plus de 100 blocs dans une colonne : on découpe en plusieurs rows plutôt que de tronquer.
    for (let i = 0; i < section.blocks.length; i += MAX_BLOCKS_PER_COLUMN) {
      pushRow({
        id: nid(ctx, "row"),
        layout: "1",
        columns: [{ id: nid(ctx, "col"), blocks: section.blocks.slice(i, i + MAX_BLOCKS_PER_COLUMN) }],
        ...(section.style ? { style: section.style } : {}),
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Traversée
 * ------------------------------------------------------------------ */

const TEXT_LEAF = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "figcaption", "dt", "dd", "address",
  "caption", "pre", "li", "summary",
]);
const CONTAINER = new Set([
  "#root", "html", "body", "div", "section", "article", "header", "footer", "main", "aside", "nav",
  "center", "figure", "dl", "fieldset", "details", "picture", "tbody", "thead", "tfoot", "tr",
  "td", "th", "colgroup", "col",
]);

function presetOf(name: string): TextPreset | undefined {
  if (name === "h1") return "h1";
  if (name === "h2") return "h2";
  // h4-h6 n'existent pas dans les presets : les écraser sur h3 vaut mieux que les perdre.
  if (name === "h3" || name === "h4" || name === "h5" || name === "h6") return "h3";
  return undefined;
}

function collectSections(node: ElNode, ctx: Ctx, depth: number, preset: TextPreset): Section[] {
  if (depth > MAX_DEPTH) {
    ctx.report.truncated = true;
    return [];
  }

  // Une barre sociale ou un menu se reconnaissent à l'échelle du CONTENEUR — typiquement une
  // cellule qui ne contient que des liens. Chercher au niveau de l'enfant les manquerait tous.
  const whole = socialBlockFrom(node, ctx) ?? menuBlockFrom(node, ctx);
  if (whole && ctx.blocks < MAX_BLOCKS) return [singleBlockSection(whole, ctx)];

  const out: Section[] = [];
  let inline: DomNode[] = [];

  const pushBlock = (block: Block | null) => {
    if (!block) return;
    if (ctx.blocks >= MAX_BLOCKS) {
      ctx.report.truncated = true;
      return;
    }
    ctx.blocks++;
    ctx.report.byType[block.type] = (ctx.report.byType[block.type] ?? 0) + 1;
    const last = out[out.length - 1];
    if (last && last.kind === "blocks" && !last.style) last.blocks.push(block);
    else out.push({ kind: "blocks", blocks: [block] });
  };

  const flushInline = () => {
    if (inline.length === 0) return;
    const nodes = inline;
    inline = [];
    pushBlock(textBlockFrom(spansFrom(nodes, ctx), preset, node, ctx));
  };

  for (const child of node.children) {
    if (child.kind === "text") {
      if (collapse(child.text) !== "" || inline.length > 0) inline.push(child);
      continue;
    }

    const name = child.name;
    if (isHidden(child)) {
      flushInline();
      captureHidden(child, ctx);
      continue;
    }
    if (name === "br") {
      inline.push(child);
      continue;
    }
    if (name === "img") {
      flushInline();
      pushBlock(imageBlockFrom(child, undefined, ctx));
      continue;
    }
    if (name === "hr") {
      flushInline();
      pushBlock(dividerBlockFrom(child, ctx));
      continue;
    }
    if (name === "a") {
      const img = soleImage(child);
      if (img) {
        flushInline();
        pushBlock(imageBlockFrom(img, safeHref(child.attrs.href, ctx), ctx));
        continue;
      }
      if (isButtonLike(child, node)) {
        const button = buttonBlockFrom(child, node, ctx);
        if (button) {
          flushInline();
          pushBlock(button);
          continue;
        }
      }
      inline.push(child);
      continue;
    }
    if (INLINE.has(name)) {
      // Une image emballée dans du inline doit quand même devenir un bloc image.
      if (containsImage(child)) {
        flushInline();
        appendSections(out, collectSections(child, ctx, depth + 1, preset));
        continue;
      }
      inline.push(child);
      continue;
    }

    flushInline();

    if (name === "table") {
      appendSections(out, tableSections(child, ctx, depth + 1));
      continue;
    }

    const spacer = spacerOrDividerFrom(child, ctx);
    if (spacer) {
      pushBlock(spacer);
      continue;
    }
    if (name === "ul" || name === "ol") {
      pushBlock(listBlockFrom(child, ctx));
      continue;
    }
    if (CONTAINER.has(name) || TEXT_LEAF.has(name)) {
      const sub = collectSections(child, ctx, depth + 1, presetOf(name) ?? preset);
      const background = bgOf(child);
      if (background && sub.length > 0) applyBackground(sub, { backgroundColor: background });
      appendSections(out, sub);
      continue;
    }

    pushBlock(fallbackBlockFrom(child, ctx));
  }

  flushInline();
  return out;
}

/** Un bloc seul, déjà compté au budget — utilisé quand une cellule EST un espaceur. */
function singleBlockSection(block: Block, ctx: Ctx): Section {
  ctx.blocks++;
  ctx.report.byType[block.type] = (ctx.report.byType[block.type] ?? 0) + 1;
  return { kind: "blocks", blocks: [block] };
}

/**
 * Contenu d'une cellule. L'espaceur est testé AVANT de descendre : une `<td height="32">` vide est
 * un espaceur, et descendre dedans ne trouverait qu'un `&nbsp;` qu'on jetterait en silence.
 */
function cellSections(cell: ElNode, ctx: Ctx, depth: number): Section[] {
  const spacer = spacerOrDividerFrom(cell, ctx);
  if (spacer) return [singleBlockSection(spacer, ctx)];
  return collectSections(cell, ctx, depth, "body");
}

function tableRows(table: ElNode): ElNode[] {
  const rows: ElNode[] = [];
  for (const child of table.children) {
    if (child.kind !== "el") continue;
    if (child.name === "tr") rows.push(child);
    else if (child.name === "tbody" || child.name === "thead" || child.name === "tfoot") {
      for (const inner of child.children) {
        if (inner.kind === "el" && inner.name === "tr") rows.push(inner);
      }
    }
  }
  return rows;
}

/** Ratio de largeurs → layout asymétrique. À unités différentes, le ratio ne veut rien dire. */
function layoutFor(cells: ElNode[]): RowLayout {
  if (cells.length === 3) return "1-1-1";
  if (cells.length === 4) return "1-1-1-1";
  if (cells.length !== 2) return "1";
  const a = dimOf(cells[0], "width");
  const b = dimOf(cells[1], "width");
  if (!a || !b || a.unit !== b.unit || b.value === 0) return "1-1";
  const ratio = a.value / b.value;
  if (ratio >= 1.7 && ratio <= 2.4) return "2-1";
  if (ratio >= 2.6 && ratio <= 3.6) return "3-1";
  if (ratio <= 1 / 1.7 && ratio >= 1 / 2.4) return "1-2";
  if (ratio <= 1 / 2.6 && ratio >= 1 / 3.6) return "1-3";
  return "1-1";
}

function tableSections(table: ElNode, ctx: Ctx, depth: number): Section[] {
  if (depth > MAX_DEPTH) {
    ctx.report.truncated = true;
    return [];
  }

  const spacer = spacerOrDividerFrom(table, ctx);
  if (spacer) return [singleBlockSection(spacer, ctx)];

  const rows = tableRows(table);
  if (rows.length === 0) return collectSections(table, ctx, depth + 1, "body");

  const out: Section[] = [];
  for (const tr of rows) {
    const cells = tr.children.filter((c): c is ElNode => c.kind === "el" && (c.name === "td" || c.name === "th"));

    if (cells.length === 0) {
      appendSections(out, collectSections(tr, ctx, depth + 1, "body"));
      continue;
    }

    // Une seule cellule = une enveloppe, pas une colonne : on descend en gardant la structure
    // interne (une table imbriquée à 2 colonnes doit rester une row à 2 colonnes).
    if (cells.length === 1) {
      const sub = cellSections(cells[0], ctx, depth + 1);
      const background = bgOf(cells[0]) ?? bgOf(tr) ?? bgOf(table);
      if (background && sub.length > 0) applyBackground(sub, { backgroundColor: background });
      appendSections(out, sub);
      continue;
    }

    if (cells.length > 4) {
      // Le schéma s'arrête à 4 colonnes (arithmétique des ghost tables Outlook).
      ctx.report.flattenedRows++;
      const blocks: Block[] = [];
      for (const cell of cells) blocks.push(...sectionsToBlocks(cellSections(cell, ctx, depth + 1), ctx));
      if (blocks.length > 0) appendSections(out, [{ kind: "blocks", blocks }]);
      continue;
    }

    const columns = cells.map((cell) => sectionsToBlocks(cellSections(cell, ctx, depth + 1), ctx));
    if (columns.every((c) => c.length === 0)) continue;
    out.push({
      kind: "row",
      layout: layoutFor(cells),
      columns,
      colStyles: cells.map((cell) => boxStyleFrom(cell)),
      ...(boxStyleFrom(tr) ? { style: boxStyleFrom(tr) as BoxStyle } : {}),
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Assemblage
 * ------------------------------------------------------------------ */

function findBody(root: ElNode, depth = 0): ElNode | null {
  if (depth > 4) return null;
  for (const child of root.children) {
    if (child.kind !== "el") continue;
    if (child.name === "body") return child;
    const nested = findBody(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Largeur de la première table de contenu — le gabarit d'origine, quand il est déclaré. */
function outerWidth(node: ElNode, depth = 0): number | undefined {
  if (depth > 6) return undefined;
  for (const child of node.children) {
    if (child.kind !== "el") continue;
    if (child.name === "table") {
      const w = dimOf(child, "width");
      if (w?.unit === "px" && w.value >= 320 && w.value <= 800) return Math.round(w.value);
    }
    const nested = outerWidth(child, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function finalizeReport(ctx: Ctx, rows: Row[]): void {
  const report = ctx.report;
  // Recopié ICI, donc AVANT le `safeParse` : la substitution doit être annoncée dans le rapport
  // même quand le document part ensuite en erreur pour une autre raison.
  report.pureBlackReads = pureSubstitutions.black;
  report.pureWhiteReads = pureSubstitutions.white;
  report.rows = rows.length;
  report.blocks = Object.values(report.byType).reduce((a, b) => a + b, 0);
  report.removed = [...ctx.removed.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  if (report.removed.length > 0) {
    const detail = report.removed.map((r) => `${r.count}× <${r.tag}>`).join(", ");
    report.notes.push(
      `Removed for safety: ${detail}. Scripts and embedded frames never make it into a template; a <style> block is read for its colours and spacing, then dropped.`,
    );
  }
  if (report.inlinedDeclarations > 0) {
    report.notes.push(
      `${report.inlinedDeclarations} style declaration(s) from <style> were applied to the matching elements. Only simple selectors (.class, #id, tag) and properties this editor can carry are used.`,
    );
  }
  if (report.skippedSelectors > 0) {
    report.notes.push(
      `${report.skippedSelectors} CSS rule(s) were ignored — descendant selectors, pseudo-classes and media queries are out of reach for the importer.`,
    );
  }
  if (report.externalStylesheets > 0) {
    report.notes.push(
      `${report.externalStylesheets} external stylesheet(s) were not downloaded, so that styling is lost. Paste those rules into a <style> block and import again to keep them.`,
    );
  }
  if (report.strippedAttributes > 0) {
    report.notes.push(`${report.strippedAttributes} event handler / unsafe attribute(s) were stripped.`);
  }
  if (report.unsafeUrls > 0) {
    report.notes.push(`${report.unsafeUrls} link(s) or image source(s) used a blocked URL scheme and were dropped.`);
  }
  if (report.unsubscribeLinks > 0) {
    report.notes.push(
      `${report.unsubscribeLinks} hand-written unsubscribe link(s) were unlinked — the legal footer injects a signed one per recipient.`,
    );
  }
  if (report.fallbackHtml > 0) {
    report.notes.push(`${report.fallbackHtml} chunk(s) could not be mapped to a block and were kept as raw HTML — review them.`);
  }
  if (report.flattenedRows > 0) {
    report.notes.push(`${report.flattenedRows} nested or oversized table row(s) were flattened into a single column.`);
  }
  if (report.trackingPixels > 0) {
    report.notes.push(`${report.trackingPixels} tracking pixel(s) from the source provider were removed.`);
  }
  if (report.altDropped > 0) {
    report.notes.push(
      `${report.altDropped} image(s) carried an alt attribute that was a URL or a file name (for example hero-banner-1024x768.jpg). It describes nothing, so it was dropped instead of published as a description. Publishing stays blocked on those images until someone writes a real alt text.`,
    );
  }
  if (report.altFromAriaLabel > 0) {
    report.notes.push(
      `${report.altFromAriaLabel} image(s) had no usable alt attribute, so the aria-label of the same <img> tag was used instead. Re-read those before publishing — a wrong description is worse than none. The title attribute is never used as a fallback: on a WordPress export it holds the media-library title, which is the uploaded file name, so images described only by a title are left with no alt text — and publishing stays blocked until someone writes one.`,
    );
  }
  const swaps = [
    report.pureBlackReads > 0 ? `#000000 → ${NEAR_BLACK}` : null,
    report.pureWhiteReads > 0 ? `#ffffff → ${NEAR_WHITE}` : null,
  ].filter((part): part is string => part !== null);
  if (swaps.length > 0) {
    report.notes.push(
      `Pure black/white was substituted while reading the colours: ${swaps.join(", ")}. Pure #000000 and #ffffff are hard-coded dark-mode inversion triggers in Outlook.com and Gmail Android, so the document schema refuses them.`,
    );
  }
  if (report.inlineImagesDropped > 0) {
    report.notes.push(`${report.inlineImagesDropped} image(s) sat inside a line of text and could not be kept.`);
  }
  if (report.hiddenSkipped > 0) {
    report.notes.push(`${report.hiddenSkipped} hidden element(s) were skipped.`);
  }
  if (ctx.preheader) report.notes.push("The hidden preview text was imported as the preheader.");
  if (ctx.title) report.notes.push("The subject line was taken from the document <title>.");
  if (report.truncated) {
    report.notes.push("The document hit an import limit and is incomplete — check the end of the email.");
  }
  report.notes.push("A legal footer block was appended: the platform injects the unsubscribe link and postal address.");
}

/**
 * Point d'entrée unique. Le document renvoyé a TOUJOURS passé `EmailDoc.safeParse` : un import
 * approximatif n'existe pas, c'est soit un document valide, soit une erreur avec ses issues.
 */
export function htmlToDoc(html: string, opts: HtmlImportOptions): ImportResult {
  const ctx = newCtx();
  // ⛔ Sans cette remise à zéro, le deuxième import du process hériterait du compte du premier.
  pureSubstitutions.black = 0;
  pureSubstitutions.white = 0;

  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_HTML_BYTES) {
    return {
      ok: false,
      code: "too_large",
      error: `This HTML is ${(bytes / 1024 / 1024).toFixed(1)} MB — the import limit is 2 MB.`,
      report: ctx.report,
    };
  }

  const root = buildTree(tokenize(html, ctx), ctx);
  // AVANT toute lecture de style : à partir d'ici, `styleOf` voit la feuille interne comme du
  // style inline, et plus aucune étape n'a à savoir que des classes ont existé.
  applyStylesheet(root, ctx);
  const body = findBody(root) ?? root;
  const rows = sectionsToRows(collectSections(body, ctx, 0, "body"), ctx);

  const contentBlocks = ctx.blocks;
  // Le pied de page légal est ajouté d'office : sans lui le worker refuse l'envoi, et il est le
  // SEUL endroit d'où sortent le lien de désabonnement et l'adresse postale.
  rows.push({
    id: nid(ctx, "row"),
    layout: "1",
    columns: [{ id: nid(ctx, "col"), blocks: [{ id: nid(ctx, "blk"), type: "footer_legal" }] }],
  });
  ctx.report.byType.footer_legal = (ctx.report.byType.footer_legal ?? 0) + 1;

  finalizeReport(ctx, rows);

  if (contentBlocks === 0) {
    return {
      ok: false,
      code: "empty",
      error: "No importable content was found in this HTML.",
      report: ctx.report,
    };
  }

  const theme: Record<string, unknown> = {};
  const bodyBackground = bgOf(body);
  if (bodyBackground) theme.bodyBackground = bodyBackground;
  const width = outerWidth(body);
  if (width) theme.contentWidth = width;

  const locale = opts.locale && opts.locale.length >= 2 ? opts.locale.slice(0, 12) : "en";
  const parsed = EmailDoc.safeParse({
    schema: 2,
    meta: {
      subject: (ctx.title || opts.subject || "").slice(0, 200),
      preheader: (ctx.preheader ?? "").slice(0, 200),
      assetSlug: opts.assetSlug,
      locale,
    },
    theme,
    rows,
  });

  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_doc",
      error: "The imported HTML produced a document our schema rejected.",
      issues: parsed.error.issues.slice(0, 25).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`),
      report: ctx.report,
    };
  }

  return { ok: true, doc: parsed.data, report: ctx.report };
}
