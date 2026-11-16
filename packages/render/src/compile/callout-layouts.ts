/**
 * LES SEPT MISES EN PAGE DE L'ENCART (`CalloutBlock.layout`, 23/09/2026).
 *
 * Port des fonctions de `C:/tmp/nf-blocks-design/tools/build.py`, qui a produit les 20 maquettes
 * validées par Alix : `e1_affiche`/`c1_affiche` → poster, `e2_lecteur` → player, `e3_pochette` →
 * cover, `e4_onde` → wave, `c2_mosaique` → gallery, `c3_bandeau` → strip, `c4_ticket` → ticket.
 * « Duo » n'est pas une mise en page : deux rows de callouts `poster` (voir `schema.ts`).
 * Le HTML, les marges et les tailles sont ceux de build.py ; seules les valeurs de marque sont
 * devenues des props du bloc (et leurs défauts, ceux de l'encart classique).
 *
 * ⛔ APPELÉ SEULEMENT QUAND `layout` EST POSÉ (`calloutHtml`, `mjml.ts`). Sans `layout`, l'encart
 * d'avant sort à l'octet près — et AUCUNE règle de ce module n'entre dans le `<style>` du head :
 * les règles mobiles ne sont poussées (`env.mobile`) que par un layout qui sert.
 *
 * ⛔ FOND D'IMAGE « BULLETPROOF » : attribut `background` + CSS + VML Outlook (`v:rect` /
 * `v:fill type="frame"` sous `<!--[if gte mso 9]>`, gardé par `keepComments: true`), et la couleur
 * de repli PARTOUT (`bgcolor`, `background-color`, `v:fill color`). Images bloquées (Outlook par
 * défaut, clients sans images) : l'aplat de repli, texte et bouton intacts. Le voile est CUIT dans
 * le fichier : aucun voile CSS, que ni Outlook ni Gmail ne rendraient.
 *
 * ⛔ AUCUN ÉPINGLAGE D'UNE CELLULE À IMAGE DE FOND. La règle Gmail de `pinClass` pose un
 * `background-image: linear-gradient(...) !important` : sur une telle cellule, elle REMPLACERAIT la
 * photo. Seules les cellules de couleur SANS texte ni image (barre du lecteur, barres de l'onde)
 * reçoivent l'épingle — le même contrat que `BLOCS_SANS_TEXTE`.
 *
 * ⚠️ HAUTEURS. `minHeight` est la hauteur RENDUE de la zone photo. La cellule intérieure porte
 * `height = minHeight − marges verticales` et l'alignement vertical : c'est ce qui tient le bouton
 * en bas d'une tuile JUSQUE dans Outlook, où la VML (`mso-fit-shape-to-text`) ne sait rien aligner.
 * Les défauts sont les hauteurs mesurées sur les captures des maquettes (cover 224, ticket 320).
 */
import { CALLOUT_LAYOUT_DEFAULTS as D, escapeHtml, type Align, type CalloutBlock, type CalloutLayout, type Spacing, type Theme } from "../schema";

/** La typographie et la boîte RÉSOLUES du bloc (cascade thème → row → colonne → bloc de `mjml.ts`). */
export interface LayoutLook {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight?: string;
  textColor: string;
  /** Couleur et police des titres résolues (`theme.headingColor` / `headingFont`, 24/09/2026). */
  headingColor: string;
  headingFont: string;
  align: Align;
  /** Fond PROPRE du bloc (`style.backgroundColor`) : la couleur de repli des zones photo. */
  backgroundColor?: string;
  borderRadius: number;
  borderWidth: number;
  borderColor: string;
  /** Casse et interlettrage du bloc, déjà en CSS : ils ne valent que pour le SURTITRE (cf. `typoCss`). */
  kickerTypo: string;
}

export interface LayoutEnv {
  theme: Theme;
  look: LayoutLook;
  /** Largeur disponible en px (colonne − marges du bloc). */
  width: number;
  /** Pousse une règle dans la media query mobile du head, UNE fois. */
  mobile: (rule: string) => void;
  /** Classe d'épingle anti-recoloration d'une cellule de couleur sans texte (`pinClass`), sinon `undefined`. */
  pin: (color: string) => string | undefined;
}

type Box = Required<Spacing>;

const T0 = `<table role="presentation" border="0" cellpadding="0" cellspacing="0"`;
const blank = (s: string | undefined): boolean => s === undefined || s.trim() === "";
const multiline = (s: string): string => escapeHtml(s).replace(/\r?\n/g, "<br />");
const cssFont = (family: string): string => family.replace(/"/g, "'");
const textStyle = (font: string, size: number, weight: string, color: string, lh: number | string): string =>
  `font-family:${font};font-size:${size}px;line-height:${lh};font-weight:${weight};color:${color};mso-line-height-rule:exactly;`;
const padCss = (p: Box): string => `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;
const cls = (...names: (string | undefined | false)[]): string => {
  const list = names.filter((n): n is string => typeof n === "string" && n !== "");
  return list.length === 0 ? "" : ` class="${list.join(" ")}"`;
};
/**
 * URL posée dans `url('…')` : un guillemet, une parenthèse ou un blanc refermeraient la fonction CSS
 * (l'entité `&#39;` d'`escapeHtml` est décodée par le parseur HTML AVANT que le CSS ne la lise).
 */
const cssUrl = (src: string): string => src.replace(/['"()\s\\]/g, (c) => encodeURIComponent(c));

/** Marges d'une zone : le défaut de la maquette, corrigé côté par côté par `innerPadding`. */
function zonePadding(block: CalloutBlock, def: Box): Box {
  const p = block.innerPadding;
  if (p === undefined) return def;
  return {
    top: p.top ?? def.top,
    right: p.right ?? def.right,
    bottom: p.bottom ?? def.bottom,
    left: p.left ?? def.left,
  };
}

/* ------------------------------------------------------------------ *
 * Règles mobiles — préfixe `nf-lo-`, une règle par classe, poussée au premier usage
 * ------------------------------------------------------------------ */

/** Les classes de build.py (`.col`, `.pad-m`…), renommées pour ne croiser ni MJML ni nos autres règles. */
const MOBILE = {
  col: ".nf-lo-col { display:block !important; max-width:100% !important; width:100% !important; }",
  // ⛔ Pour une TABLE, jamais `col` : `display:block` sur un <table> laisse ses cellules dans une table
  // anonyme taillée au contenu, et un bouton pleine largeur y rétrécit à son libellé (Duo à 375 px, 23/09).
  txt: ".nf-lo-txt { width:100% !important; max-width:100% !important; }",
  px: ".nf-lo-px { padding-left:16px !important; padding-right:16px !important; }",
  pad: ".nf-lo-pad { padding:34px 22px 34px 22px !important; }",
  pads: ".nf-lo-pads { padding:20px 18px !important; }",
  bgr: ".nf-lo-bgr { background-position:18% center !important; }",
  mw: ".nf-lo-mw { max-width:100% !important; }",
  gap: ".nf-lo-gap { padding-left:0 !important; padding-top:18px !important; }",
  btn: ".nf-lo-btn { width:100% !important; float:none !important; }",
  stk: ".nf-lo-stk { display:block !important; width:100% !important; box-sizing:border-box; border-radius:0 !important; }",
} as const;

function use(env: LayoutEnv, key: keyof typeof MOBILE): string {
  env.mobile(MOBILE[key]);
  return `nf-lo-${key}`;
}

/**
 * Titre réduit sur mobile, à l'échelle des maquettes (`.t-xl` = 30 × échelle de marque pour un titre
 * de 36 ou 44, `.t-l` = 24 pour 27, 28 ou 32) : `ratio` = taille mobile / taille bureau de la maquette.
 */
function mobileTitle(env: LayoutEnv, size: number, ratio: number): string | undefined {
  const m = Math.round(size * ratio);
  if (m >= size) return undefined;
  env.mobile(`.nf-lo-t${m} { font-size:${m}px !important; }`);
  return `nf-lo-t${m}`;
}

/* ------------------------------------------------------------------ *
 * Éléments de texte — une fonction `(pb) => html` : le dernier élément d'une pile perd sa marge basse
 * ------------------------------------------------------------------ */

type Part = (pb: number) => string;
interface Item {
  part: Part;
  pb: number;
}

/** Empile des éléments ; le dernier perd sa marge basse quand rien ne le suit (pas de bouton). */
function stack(items: (Item | undefined)[], after: string): string {
  const list = items.filter((i): i is Item => i !== undefined);
  return (
    list.map((it, i) => it.part(i === list.length - 1 && after === "" ? 0 : it.pb)).join("") + after
  );
}

/** Surtitre : texte seul, « ● TEXTE », ou gélule. Couleur par défaut = celle de l'encart classique. */
function kicker(block: CalloutBlock, env: LayoutEnv, align: Align, pb: number, pillPb = 16): Item | undefined {
  if (blank(block.kicker)) return undefined;
  const { look, theme } = env;
  const size = block.kickerSize ?? Math.max(11, look.fontSize - 4);
  const weight = look.fontWeight ?? "700";
  const font = cssFont(look.fontFamily);
  const accent = block.kickerAccent ?? theme.brandColor;
  if (block.kickerStyle === "pill") {
    const fg = block.kickerColor ?? theme.buttonTextColor;
    return {
      pb: pillPb,
      part: (p) =>
        `${T0} align="${align}" style="border-collapse:separate;"><tr><td bgcolor="${accent}" style="background-color:${accent};border-radius:20px;padding:6px 13px;${textStyle(font, size, weight, fg, 1.2)}${look.kickerTypo}">${multiline(block.kicker)}</td></tr></table>` +
        `<div style="clear:both;height:${p}px;line-height:${p}px;font-size:0;">&nbsp;</div>`,
    };
  }
  const dot = block.kickerStyle === "dot" ? `<span style="color:${accent};">&#9679;</span>&nbsp;&nbsp;` : "";
  const color = block.kickerColor ?? theme.mutedColor;
  return {
    pb,
    part: (p) =>
      `<div style="${textStyle(font, size, weight, color, 1.4)}${look.kickerTypo}text-align:${align};padding-bottom:${p}px;">${dot}${multiline(block.kicker)}</div>`,
  };
}

function title(block: CalloutBlock, env: LayoutEnv, align: Align, pb: number, mobileRatio?: number): Item | undefined {
  if (blank(block.title)) return undefined;
  const { look } = env;
  const size = block.titleSize ?? Math.max(18, look.fontSize + 4);
  const mcls = mobileRatio === undefined ? undefined : mobileTitle(env, size, mobileRatio);
  const font = cssFont(block.titleFont ?? look.headingFont);
  const style = textStyle(font, size, block.titleWeight ?? look.fontWeight ?? "700", block.titleColor ?? look.headingColor, block.titleLineHeight ?? 1.25);
  return { pb, part: (p) => `<div${cls(mcls)} style="${style}text-align:${align};padding-bottom:${p}px;">${multiline(block.title)}</div>` };
}

function body(block: CalloutBlock, env: LayoutEnv, align: Align, pb: number, color?: string): Item | undefined {
  if (blank(block.body)) return undefined;
  const { look } = env;
  const font = cssFont(block.bodyFont ?? look.fontFamily);
  const style = textStyle(font, look.fontSize, "400", color ?? block.bodyColor ?? look.textColor, look.lineHeight);
  return { pb, part: (p) => `<div style="${style}text-align:${align};padding-bottom:${p}px;">${multiline(block.body)}</div>` };
}

/**
 * Bouton en tableau — le `button()` de build.py : `ctaTable` avec, en plus, la pleine largeur
 * (`ctaFullWidth`) et une classe mobile. Mêmes défauts que le bouton de l'encart classique.
 * Pas de bouton sans destination (même garde que `calloutHtml`).
 */
function button(block: CalloutBlock, env: LayoutEnv, align: Align, extraCls?: string): string {
  if (block.href === undefined || blank(block.ctaLabel)) return "";
  const { look, theme } = env;
  const bg = block.ctaBackground ?? theme.brandColor;
  const fg = block.ctaTextColor ?? theme.buttonTextColor;
  const size = block.ctaSize ?? Math.max(13, look.fontSize - 2);
  const p = block.ctaPadding;
  const pad =
    p === undefined ? "12px 22px" : padCss({ top: p.top ?? 12, right: p.right ?? 22, bottom: p.bottom ?? 12, left: p.left ?? 22 });
  const font = cssFont(block.ctaFont ?? block.titleFont ?? look.fontFamily);
  const full = block.ctaFullWidth === true;
  // Un tableau aligné FLOTTE : pleine largeur, il n'en a pas besoin (commentaire de build.py).
  // ⚠️ La cellule porte la taille et l'interligne du libellé : sinon elle hérite ceux du `mj-text`
  // (15 px × 1,55 = une ligne fantôme de 23 px) et le bouton gagnait 5 à 6 px sur la maquette (23/09).
  return (
    `${T0}${full ? ' width="100%"' : ` align="${align}"`}${cls(extraCls)} style="border-collapse:separate;border-spacing:0;${full ? "width:100%;" : ""}">` +
    `<tr><td align="center" bgcolor="${bg}" style="border-radius:${block.ctaRadius ?? look.borderRadius}px;background-color:${bg};padding:${pad};mso-padding-alt:${pad};font-size:${size}px;line-height:1.2;">` +
    `<a href="${escapeHtml(block.href)}" target="_blank" style="${textStyle(font, size, block.ctaWeight ?? "700", fg, 1.2)}display:inline-block;text-decoration:none;">${escapeHtml(block.ctaLabel as string)}</a>` +
    `</td></tr></table>`
  );
}

/** Le rond « ▶ » (player, cover) : fond et glyphe = ceux du bouton, sauf réglage. */
function play(block: CalloutBlock, env: LayoutEnv, size: number, align: Align): string {
  const bg = block.playBackground ?? block.ctaBackground ?? env.theme.brandColor;
  const fg = block.playColor ?? block.ctaTextColor ?? env.theme.buttonTextColor;
  const glyph = `&#9654;&#65038;`;
  const style = `display:block;font-family:Arial,sans-serif;font-size:${Math.round(size * 0.34)}px;line-height:${size}px;color:${fg};text-decoration:none;padding-left:${Math.round(size * 0.07)}px;`;
  const inner =
    block.href === undefined
      ? `<span aria-hidden="true" style="${style}">${glyph}</span>`
      : `<a href="${escapeHtml(block.href)}" target="_blank" aria-label="Play" style="${style}">${glyph}</a>`;
  return (
    `${T0} align="${align}" style="border-collapse:separate;"><tr><td width="${size}" height="${size}" align="center" valign="middle" bgcolor="${bg}" ` +
    `style="width:${size}px;height:${size}px;border-radius:${Math.floor(size / 2)}px;background-color:${bg};">${inner}</td></tr></table>`
  );
}

/**
 * Cellule à fond d'image (`bg()` de build.py) : attribut `background` + CSS + VML, repli partout.
 * Sans image, la même boîte en aplat — ni `background`, ni VML.
 */
function bgBox(
  env: LayoutEnv,
  o: {
    src: string | undefined;
    fallback: string | undefined;
    w: number;
    h: number;
    inner: string;
    radius?: string;
    pos?: string;
    tdCls?: string;
    tableCls?: string;
    valign?: string;
    fit?: boolean;
  },
): string {
  const r = o.radius === undefined ? "" : `border-radius:${o.radius};`;
  const img = o.src !== undefined && o.src.trim() !== "";
  const src = img ? (o.src as string) : "";
  const css =
    `height:${o.h}px;` +
    (o.fallback === undefined ? "" : `background-color:${o.fallback};`) +
    (img ? `background-image:url('${escapeHtml(cssUrl(src))}');background-size:cover;background-position:${o.pos ?? "center center"};background-repeat:no-repeat;` : "") +
    r;
  const vml = img
    ? [
        `<!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:${o.w}px;height:${o.h}px;">` +
          `<v:fill type="frame" src="${escapeHtml(src)}" color="${o.fallback ?? env.theme.contentBackground}" /><v:textbox inset="0,0,0,0"${o.fit === false ? "" : ' style="mso-fit-shape-to-text:true"'}><![endif]-->`,
        `<!--[if gte mso 9]></v:textbox></v:rect><![endif]-->`,
      ]
    : ["", ""];
  return (
    `${T0} width="100%"${cls(o.tableCls)} style="width:100%;max-width:${o.w}px;border-collapse:separate;border-spacing:0;${r}">` +
    `<tr><td${cls(o.tdCls)}${img ? ` background="${escapeHtml(src)}"` : ""}${o.fallback === undefined ? "" : ` bgcolor="${o.fallback}"`} valign="${o.valign ?? "top"}" height="${o.h}" style="${css}">` +
    `${vml[0]}${o.inner}${vml[1]}</td></tr></table>`
  );
}

/** Colonnes hybrides (`cols()` de build.py) : inline-block + tables MSO, empilées sous la largeur. */
function cols(env: LayoutEnv, parts: { w: number; html: string; extra?: string }[], total: number, valign = "top"): string {
  const col = use(env, "col");
  const out = [`<!--[if mso]><table role="presentation" width="${total}" cellpadding="0" cellspacing="0" border="0"><tr><![endif]-->`];
  for (const p of parts) {
    out.push(
      `<!--[if mso]><td width="${p.w}" valign="${valign}"><![endif]-->` +
        `<div${cls(col, p.extra)} style="display:inline-block;vertical-align:${valign};width:100%;max-width:${p.w}px;">${p.html}</div>` +
        `<!--[if mso]></td><![endif]-->`,
    );
  }
  out.push(`<!--[if mso]></tr></table><![endif]-->`);
  // `font-size:0` : deux inline-block séparés par un blanc laisseraient une espace entre eux.
  return `<div style="font-size:0;text-align:left;">${out.join("")}</div>`;
}

/** Cadre d'une carte : fond, bordure, rayon, barre d'accent — ce que l'encart classique pose déjà. */
function frame(block: CalloutBlock, env: LayoutEnv, background: string | undefined): string {
  const { look, theme } = env;
  return [
    `width:100%;max-width:${env.width}px;border-collapse:separate;border-spacing:0;`,
    background === undefined ? "" : `background-color:${background};`,
    look.borderWidth > 0 ? `border:${look.borderWidth}px solid ${look.borderColor};` : "",
    look.borderRadius > 0 ? `border-radius:${look.borderRadius}px;` : "",
    // Après la bordure complète, comme `calloutHtml` : l'accent doit gagner (le liseré de l'Onde PF).
    block.accentWidth > 0 ? `border-left:${block.accentWidth}px solid ${block.accentColor ?? theme.brandColor};` : "",
  ].join("");
}

const hasImage = (src: string | undefined): src is string => src !== undefined && src.trim() !== "";

/* ------------------------------------------------------------------ *
 * Les sept mises en page
 * ------------------------------------------------------------------ */

/** Affiche (`e1_affiche`) et Affiche centrée (`c1_affiche`) : la photo plein cadre, le texte posé dessus. */
function poster(block: CalloutBlock, env: LayoutEnv): string {
  const { look, width } = env;
  const align = look.align;
  const center = align === "center";
  const h = block.minHeight ?? (D.poster.minHeight as number);
  const pad = zonePadding(block, center ? { top: 60, right: 56, bottom: 56, left: 56 } : { top: 56, right: 40, bottom: 52, left: 40 });
  const btn = button(block, env, align);
  const content = stack(
    [
      kicker(block, env, align, 12),
      title(block, env, align, center ? 14 : 12, center ? 30 / 44 : 30 / 36),
      body(block, env, align, center ? 26 : 22),
    ],
    btn,
  );
  // Texte à gauche : une colonne de 340 px (celle de la maquette), le sujet de la photo à droite.
  const colW = Math.min(340, Math.max(80, width - pad.left - pad.right));
  const texte =
    align === "left" ? `${T0} width="${colW}"${cls(use(env, "txt"))} style="width:${colW}px;max-width:100%;"><tr><td>${content}</td></tr></table>` : content;
  const hi = Math.max(0, h - pad.top - pad.bottom);
  const inner =
    `${T0} width="100%"><tr><td${cls(block.innerPadding === undefined && use(env, "pad"))} align="${align}" valign="${block.contentVAlign ?? D.poster.contentVAlign}" height="${hi}" ` +
    `style="height:${hi}px;padding:${padCss(pad)};">${texte}</td></tr></table>`;
  const right = block.backgroundPosition === "right";
  return bgBox(env, {
    src: block.backgroundImage,
    fallback: look.backgroundColor,
    w: width,
    h,
    inner,
    radius: look.borderRadius > 0 ? `${look.borderRadius}px` : undefined,
    pos: `${block.backgroundPosition ?? "center"} center`,
    // Le sujet à droite : sur mobile, la fenêtre étroite glisse vers la zone calme de gauche.
    tdCls: right && hasImage(block.backgroundImage) ? use(env, "bgr") : undefined,
    tableCls: use(env, "mw"),
  });
}

/** Lecteur (`e2_lecteur`) : la photo en bandeau avec un gros ▶, une barre de lecture, le texte dessous. */
function player(block: CalloutBlock, env: LayoutEnv): string {
  const { look, theme, width } = env;
  const align = look.align;
  const h = block.minHeight ?? (D.player.minHeight as number);
  const r = look.borderRadius;
  const pad = zonePadding(block, { top: 28, right: 40, bottom: 36, left: 40 });
  const band = `${T0} width="100%"><tr><td height="${h}" align="center" valign="middle" style="height:${h}px;">${play(block, env, 78, "center")}</td></tr></table>`;
  const done = block.progress ?? (D.player.progress as number);
  const played = block.progressColor ?? theme.brandColor;
  const rest = block.progressTrackColor ?? theme.mutedColor;
  const cell = (pct: number, c: string) =>
    pct <= 0
      ? ""
      : `<td${cls(env.pin(c))} width="${pct}%" height="4" bgcolor="${c}" style="width:${pct}%;height:4px;background-color:${c};font-size:0;line-height:0;">&nbsp;</td>`;
  const bar = `${T0} width="100%" style="width:100%;border-collapse:collapse;"><tr>${cell(done, played)}${cell(100 - done, rest)}</tr></table>`;
  const btn = button(block, env, align);
  const content = stack([kicker(block, env, align, 12), title(block, env, align, 12, 24 / 28), body(block, env, align, 22)], btn);
  return (
    `${T0} width="100%" style="${frame(block, env, look.backgroundColor)}">` +
    `<tr><td>${bgBox(env, {
      src: block.backgroundImage,
      fallback: look.backgroundColor ?? theme.contentBackground,
      w: width,
      h,
      inner: band,
      radius: r > 0 ? `${r}px ${r}px 0 0` : undefined,
      pos: `${block.backgroundPosition ?? "center"} center`,
    })}</td></tr>` +
    `<tr><td${cls(use(env, "px"))} style="padding:0 ${Math.max(0, pad.right - 4)}px 0 ${Math.max(0, pad.left - 4)}px;">${bar}</td></tr>` +
    `<tr><td${cls(block.innerPadding === undefined && use(env, "pad"))} align="${align}" style="padding:${padCss(pad)};">${content}</td></tr>` +
    `</table>`
  );
}

/** Pochette (`e3_pochette`) : une carte, la pochette carrée et son ▶ à gauche, le texte à droite. */
function cover(block: CalloutBlock, env: LayoutEnv): string {
  const { look, theme, width } = env;
  const pad = zonePadding(block, { top: 16, right: 16, bottom: 16, left: 16 });
  const total = Math.max(120, width - pad.left - pad.right - 2 * look.borderWidth);
  const side = Math.min(200, total);
  const h = block.minHeight ?? (D.cover.minHeight as number);
  const badge = `${T0} width="100%"><tr><td height="${Math.max(0, h - 24)}" valign="bottom" style="height:${Math.max(0, h - 24)}px;padding:12px;">${play(block, env, 46, "left")}</td></tr></table>`;
  const photo = bgBox(env, {
    src: block.backgroundImage,
    fallback: block.stubBackground ?? theme.brandColor,
    w: side,
    h,
    inner: badge,
    radius: look.borderRadius > 2 ? `${look.borderRadius - 2}px` : undefined,
    pos: `${block.backgroundPosition ?? "center"} center`,
    tableCls: use(env, "mw"),
  });
  const align = look.align;
  const text =
    `<div${cls(use(env, "gap"))} style="padding:4px 0 4px 24px;">` +
    stack([kicker(block, env, align, 10), title(block, env, align, 10), body(block, env, align, 18)], button(block, env, align)) +
    `</div>`;
  return (
    `${T0} width="100%" style="${frame(block, env, look.backgroundColor)}">` +
    `<tr><td style="padding:${padCss(pad)};">${cols(env, [{ w: side, html: photo }, { w: total - side, html: text }], total)}</td></tr></table>`
  );
}

/**
 * L'onde sonore de build.py (`wave()`), barre pour barre : 38 barres de 4 px, hauteur tirée de la
 * graine, part jouée en couleur. Des cellules de couleur SANS texte : épinglées (`pin`).
 */
function waveform(env: LayoutEnv, played: number, seed: number, playedColor: string, restColor: string): string {
  const n = 38;
  const maxh = 34;
  const tds: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = Math.abs(Math.sin(i * 0.53 + seed) * 0.55 + Math.sin(i * 1.71 + seed * 2.3) * 0.3 + Math.sin(i * 0.19) * 0.15);
    const hh = Math.floor(6 + (maxh - 6) * Math.min(1, v));
    const c = i < n * played ? playedColor : restColor;
    tds.push(
      `<td valign="middle" style="padding:0 3px 0 0;">${T0} style="border-collapse:separate;"><tr>` +
        `<td${cls(env.pin(c))} width="4" height="${hh}" bgcolor="${c}" style="width:4px;height:${hh}px;background-color:${c};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>` +
        `</tr></table></td>`,
    );
  }
  return `${T0} style="border-collapse:collapse;"><tr>${tds.join("")}</tr></table>`;
}

/** Onde (`e4_onde`) : la vignette ronde (`imageSrc`), le surtitre et le titre, l'onde, le texte. */
function wave(block: CalloutBlock, env: LayoutEnv): string {
  const { look, theme } = env;
  const align = look.align;
  const pad = zonePadding(block, { top: 26, right: 30, bottom: 30, left: 30 });
  const k = kicker(block, env, align, 6);
  const t = title(block, env, align, 0);
  const tete = [k, t].filter((x): x is Item => x !== undefined);
  const teteHtml = tete.map((x, i) => x.part(i === tete.length - 1 ? 0 : x.pb)).join("");
  let head = teteHtml;
  if (hasImage(block.imageSrc)) {
    const alt = block.imageAlt ?? "";
    const img =
      `<img src="${escapeHtml(block.imageSrc)}" width="72" height="72" alt="${escapeHtml(alt)}" ` +
      `style="display:block;width:72px;height:72px;border-radius:36px;border:0;${textStyle(cssFont(block.bodyFont ?? look.fontFamily), 11, "400", block.bodyColor ?? look.textColor, 1.2)}">`;
    // Même règle que la vignette de l'encart classique : un lien n'enveloppe l'image que si son alt la nomme.
    const thumb = block.href === undefined || blank(alt) ? img : `<a href="${escapeHtml(block.href)}" target="_blank">${img}</a>`;
    head =
      `${T0} width="100%"><tr><td width="72" valign="middle" style="width:72px;">${thumb}</td>` +
      (teteHtml === "" ? "" : `<td valign="middle" style="padding-left:18px;">${teteHtml}</td>`) +
      `</tr></table>`;
  }
  const onde = waveform(
    env,
    (block.progress ?? (D.wave.progress as number)) / 100,
    block.waveSeed ?? 1,
    block.progressColor ?? theme.brandColor,
    block.progressTrackColor ?? theme.mutedColor,
  );
  const reste = stack([body(block, env, align, 22)], button(block, env, align));
  return (
    `${T0} width="100%" style="${frame(block, env, look.backgroundColor)}">` +
    `<tr><td${cls(block.innerPadding === undefined && use(env, "pad"))} align="${align}" style="padding:${padCss(pad)};">` +
    `${head}<div style="padding:20px 0 18px 0;">${onde}</div>${reste}</td></tr></table>`
  );
}

/** Mosaïque (`c2_mosaique`) : une carte claire, 3 photos façon profil Instagram, le bouton dessous. */
function gallery(block: CalloutBlock, env: LayoutEnv): string {
  const { look, theme, width } = env;
  const align = look.align;
  const pad = zonePadding(block, { top: 26, right: 28, bottom: 30, left: 28 });
  const inner = Math.max(120, width - pad.left - pad.right - 2 * look.borderWidth);
  const tileW = Math.round(inner * 0.32);
  const fb = block.stubBackground ?? theme.brandColor;
  const altStyle = textStyle(cssFont(block.bodyFont ?? look.fontFamily), 11, "400", block.stubTextColor ?? theme.buttonTextColor, 1.3);
  const spacer = `<td width="10" style="width:10px;font-size:0;line-height:0;">&nbsp;</td>`;
  // ⛔ Pas d'épingle sur une case : elle porte une image, dont l'alt S'AFFICHE quand l'image est bloquée.
  const tiles = (block.gallery ?? [])
    .map((t) => {
      const img =
        `<img src="${escapeHtml(t.src)}" width="${tileW}" alt="${escapeHtml(t.alt)}" ` +
        `style="display:block;width:100%;max-width:${tileW + 8}px;height:auto;border:0;border-radius:4px;${altStyle}">`;
      const linked = block.href === undefined || blank(t.alt) ? img : `<a href="${escapeHtml(block.href)}" target="_blank">${img}</a>`;
      return `<td width="32%" valign="top" bgcolor="${fb}" style="width:32%;background-color:${fb};border-radius:4px;">${linked}</td>`;
    })
    .join(spacer);
  const grille =
    tiles === "" ? "" : `${T0} width="100%" style="width:100%;border-collapse:collapse;"><tr>${tiles}</tr></table>`;
  const btn = button(block, env, align);
  const apres = grille === "" ? btn : grille + (btn === "" ? "" : `<div style="height:22px;line-height:22px;font-size:0;">&nbsp;</div>${btn}`);
  const content = stack(
    [kicker(block, env, align, 12), title(block, env, align, 8, 24 / 27), body(block, env, align, 20)],
    apres,
  );
  return (
    `${T0} width="100%" style="${frame(block, env, look.backgroundColor)}">` +
    `<tr><td${cls(block.innerPadding === undefined && use(env, "pad"))} align="${align}" style="padding:${padCss(pad)};">${content}</td></tr></table>`
  );
}

/** Bandeau (`c3_bandeau`) : une bande compacte, un rond « + », le texte, le bouton à droite. */
function strip(block: CalloutBlock, env: LayoutEnv): string {
  const { look, theme, width } = env;
  const h = block.minHeight ?? (D.strip.minHeight as number);
  const pad = zonePadding(block, { top: 22, right: 22, bottom: 22, left: 22 });
  const total = Math.max(160, width - pad.left - pad.right);
  const rightW = Math.min(212, Math.floor(total / 2));
  const bg = block.playBackground ?? block.ctaBackground ?? theme.brandColor;
  const fg = block.playColor ?? block.ctaTextColor ?? theme.buttonTextColor;
  const glyph =
    `${T0} style="border-collapse:separate;"><tr><td width="46" height="46" align="center" valign="middle" bgcolor="${bg}" ` +
    `style="width:46px;height:46px;border-radius:23px;background-color:${bg};${textStyle("Arial,sans-serif", 26, "700", fg, 1)}">+</td></tr></table>`;
  const textes = stack([kicker(block, env, "left", 4), title(block, env, "left", 4), body(block, env, "left", 0)], "");
  const left =
    `${T0} width="100%"><tr><td width="46" valign="middle" style="width:46px;">${glyph}</td>` +
    `<td valign="middle" style="padding:0 16px 0 16px;">${textes}</td></tr></table>`;
  // La classe mobile du bouton n'est demandée (donc sa règle émise) que si le bouton existe.
  const btn = block.href === undefined || blank(block.ctaLabel) ? "" : button(block, env, "right", use(env, "btn"));
  const right = btn === "" ? "" : `<div${cls(use(env, "gap"))} style="padding-top:6px;">${btn}</div>`;
  const parts = right === "" ? [{ w: total, html: left }] : [{ w: total - rightW, html: left }, { w: rightW, html: right }];
  const hi = Math.max(0, h - pad.top - pad.bottom);
  const inner =
    `${T0} width="100%"><tr><td${cls(block.innerPadding === undefined && use(env, "pads"))} valign="${block.contentVAlign ?? D.strip.contentVAlign}" height="${hi}" ` +
    `style="height:${hi}px;padding:${padCss(pad)};">${cols(env, parts, total, "middle")}</td></tr></table>`;
  return bgBox(env, {
    src: block.backgroundImage,
    fallback: look.backgroundColor,
    w: width,
    h,
    inner,
    radius: look.borderRadius > 0 ? `${look.borderRadius}px` : undefined,
    pos: `${block.backgroundPosition ?? "center"} center`,
    valign: "middle",
  });
}

/** Ticket (`c4_ticket`) : la photo et le titre à gauche, une souche pointillée et le bouton à droite. */
function ticket(block: CalloutBlock, env: LayoutEnv): string {
  const { look, theme, width } = env;
  const h = block.minHeight ?? (D.ticket.minHeight as number);
  const r = look.borderRadius;
  const stubW = Math.min(226, Math.floor(width / 2));
  const mainW = width - stubW;
  const pad = zonePadding(block, { top: 30, right: 30, bottom: 30, left: 30 });
  const fb = look.backgroundColor ?? theme.contentBackground;
  const stubBg = block.stubBackground ?? theme.brandColor;
  const stk = use(env, "stk");
  const src = hasImage(block.backgroundImage) ? block.backgroundImage : undefined;
  const hi = Math.max(0, h - pad.top - pad.bottom);
  const titre = stack([kicker(block, env, "left", 12), title(block, env, "left", 0, 24 / 32)], "");
  const main =
    `<td${cls(stk)} width="${mainW}"${src === undefined ? "" : ` background="${escapeHtml(src)}"`} bgcolor="${fb}" valign="bottom" ` +
    `style="width:${mainW}px;background-color:${fb};${src === undefined ? "" : `background-image:url('${escapeHtml(cssUrl(src))}');background-size:cover;background-position:${block.backgroundPosition ?? "center"} center;`}` +
    `${r > 0 ? `border-radius:${r}px 0 0 ${r}px;` : ""}">` +
    (src === undefined
      ? ""
      : `<!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:${mainW}px;height:${h}px;">` +
        `<v:fill type="frame" src="${escapeHtml(src)}" color="${fb}" /><v:textbox inset="0,0,0,0"><![endif]-->`) +
    `${T0} width="100%"><tr><td height="${hi}" valign="${block.contentVAlign ?? D.ticket.contentVAlign}"${cls(block.innerPadding === undefined && use(env, "pad"))} ` +
    `style="height:${hi}px;padding:${padCss(pad)};">${titre}</td></tr></table>` +
    (src === undefined ? "" : `<!--[if gte mso 9]></v:textbox></v:rect><![endif]-->`) +
    `</td>`;
  // La souche : son pointillé a la couleur du CONTENU, c'est lui qui « découpe » le billet.
  env.mobile(`.nf-lo-stub { border-left:0 !important; border-top:2px dashed ${theme.contentBackground} !important; }`);
  const stubText = block.stubTextColor ?? block.bodyColor ?? theme.buttonTextColor;
  const stub =
    `<td class="${stk} nf-lo-stub" width="${stubW}" valign="middle" bgcolor="${stubBg}" ` +
    `style="width:${stubW}px;background-color:${stubBg};border-left:2px dashed ${theme.contentBackground};${r > 0 ? `border-radius:0 ${r}px ${r}px 0;` : ""}padding:26px 20px;">` +
    stack([body(block, env, "left", 18, stubText)], button(block, env, "left")) +
    `</td>`;
  return `${T0} width="100%" style="width:100%;max-width:${width}px;border-collapse:separate;border-spacing:0;"><tr>${main}${stub}</tr></table>`;
}

const RENDERERS: Record<CalloutLayout, (block: CalloutBlock, env: LayoutEnv) => string> = {
  poster,
  player,
  cover,
  wave,
  gallery,
  strip,
  ticket,
};

/** Le HTML d'un encart à mise en page. `layout` est posé : `calloutHtml` ne l'appelle pas sinon. */
export function calloutLayoutHtml(block: CalloutBlock, layout: CalloutLayout, env: LayoutEnv): string {
  return RENDERERS[layout](block, env);
}
