/**
 * Contraste WCAG — calcul EXACT de la luminance relative, pas une approximation.
 *
 * Pourquoi pas la moyenne des canaux (ou une distance dans l'espace sRGB) : l'œil ne pèse pas les
 * trois canaux de la même façon et sRGB est encodé avec une courbe gamma. Un vert moyen et un bleu
 * moyen ont la même « moyenne » et deux luminances très différentes — une approximation ferait
 * passer pour lisible un `#0000FF` sur `#333333`. On applique donc la formule normative
 * (WCAG 2.x, §Relative luminance) : linéarisation par canal, puis pondération 0.2126/0.7152/0.0722.
 *
 * ⚠️ Ce module ne connaît que des couleurs OPAQUES : le schéma n'accepte que des hex 3/6 chiffres
 * (pas d'alpha, pas de `transparent`), donc il n'y a jamais de composition à faire.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** `#abc` / `#aabbcc` → canaux 0-255. `null` si la chaîne n'est pas une couleur du schéma. */
export function parseHex(hex: string): Rgb | null {
  const value = hex.trim();
  if (!HEX_RE.test(value)) return null;
  const raw = value.slice(1);
  const full =
    raw.length === 3
      ? `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
      : raw;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** Linéarisation d'un canal sRGB (annule la courbe gamma avant toute pondération). */
const linearize = (channel: number): number => {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** Luminance relative WCAG, dans [0, 1]. */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

/**
 * Ratio de contraste WCAG, dans [1, 21]. `null` si l'une des deux couleurs est illisible —
 * l'appelant doit alors s'abstenir plutôt que d'inventer un verdict.
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) return null;
  const lf = relativeLuminance(fg);
  const lb = relativeLuminance(bg);
  const lighter = Math.max(lf, lb);
  const darker = Math.min(lf, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * « Grand texte » au sens WCAG : ≥ 18 pt, ou ≥ 14 pt en gras. Converti en pixels CSS
 * (1 pt = 4/3 px) → 24 px, ou 18,66 px en gras. Les tailles du compilateur sont en px.
 */
export const isLargeText = (fontSizePx: number, bold: boolean): boolean =>
  fontSizePx >= 24 || (bold && fontSizePx >= 18.66);

/** Seuil AA applicable : 3:1 pour le grand texte, 4,5:1 sinon. */
export const wcagMinimum = (fontSizePx: number, bold: boolean): number =>
  isLargeText(fontSizePx, bold) ? 3 : 4.5;

/** Arrondi d'affichage — deux décimales, comme les rapports d'audit d'accessibilité. */
export const formatRatio = (ratio: number): string => `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
