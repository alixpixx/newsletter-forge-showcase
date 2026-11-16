/**
 * CONTRAT CLIENT du générateur IA — types partagés par tous les composants de `components/ai/**`.
 *
 * Principe non négociable rappelé ici parce que tout ce fichier en découle : Claude ne produit
 * JAMAIS de HTML. Il produit un `EmailDoc` validé par le MÊME schéma Zod que le builder. L'UI ne
 * « répare » rien : un document refusé par l'API est affiché comme un échec, pas rafistolé.
 *
 * La palette de la direction graphique est volontairement indexée par les CLÉS DU THÈME
 * (`Theme` de @nf/render/schema). Conséquence directe : ce que l'utilisateur corrige à l'étape 2
 * est exactement ce qui atterrit dans `doc.theme`, sans table de correspondance intermédiaire.
 */
import { isPlaceholderSrc } from "@nf/render/schema";
import type { EmailDoc, ImageBlock } from "@nf/render/schema";

/* ------------------------------------------------------------------ Direction */

/** Rôles de couleur — miroir 1:1 des champs couleur de `Theme`. */
export const PALETTE_ROLES = [
  "bodyBackground",
  "contentBackground",
  "textColor",
  "mutedColor",
  "linkColor",
  "brandColor",
  "buttonTextColor",
  "borderColor",
] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];

export const PALETTE_LABELS: Record<PaletteRole, string> = {
  bodyBackground: "Page background",
  contentBackground: "Content background",
  textColor: "Body text",
  mutedColor: "Muted text",
  linkColor: "Links",
  brandColor: "Brand / buttons",
  buttonTextColor: "Button label",
  borderColor: "Borders",
};

export const DENSITIES = ["compact", "cozy", "airy"] as const;
export type Density = (typeof DENSITIES)[number];

export interface ArtDirection {
  /** Une phrase : l'ambiance perçue dans l'image de référence. */
  mood: string;
  palette: Record<PaletteRole, string>;
  fontFamily: string;
  headingFontFamily?: string;
  baseFontSize: number;
  radius: number;
  density: Density;
  contentWidth: number;
  /** Observations libres du modèle (jamais interprétées par l'UI, seulement affichées). */
  notes?: string;
}

/** Valeurs de repli = defaults de `Theme` (packages/render/src/schema.ts). */
export const DEFAULT_DIRECTION: ArtDirection = {
  mood: "",
  palette: {
    bodyBackground: "#F4F4F7",
    contentBackground: "#FEFEFE",
    textColor: "#1A1A20",
    mutedColor: "#6B6B76",
    linkColor: "#FF368D",
    brandColor: "#FF368D",
    buttonTextColor: "#FEFEFE",
    borderColor: "#E9E9EF",
  },
  fontFamily: "Arial, Helvetica, sans-serif",
  baseFontSize: 16,
  radius: 8,
  density: "cozy",
  contentWidth: 600,
};

/* ------------------------------------------------------- Validation couleur */

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Même règle que `HexColor` côté schéma : les noirs/blancs PURS déclenchent l'inversion dark mode
 * d'Outlook.com et Gmail Android. On la rejoue ici pour que l'utilisateur le voie AVANT de composer,
 * plutôt que de découvrir un 400 après quatre minutes d'attente.
 */
export function hexError(value: string): string | null {
  if (!HEX_RE.test(value)) return "Use a hex colour such as #1A1A20";
  const n = value.toLowerCase();
  if (n === "#000" || n === "#000000") return "Pure black triggers dark-mode inversion — use #0E0E0E";
  if (n === "#fff" || n === "#ffffff") return "Pure white triggers dark-mode inversion — use #FEFEFE";
  return null;
}

/** Toutes les erreurs de la direction, prêtes à afficher. Vide = composable. */
export function directionErrors(d: ArtDirection): string[] {
  const out: string[] = [];
  for (const role of PALETTE_ROLES) {
    const err = hexError(d.palette[role] ?? "");
    if (err) out.push(`${PALETTE_LABELS[role]}: ${err}`);
  }
  if (!Number.isInteger(d.radius) || d.radius < 0 || d.radius > 48) out.push("Radius must be between 0 and 48.");
  if (!Number.isInteger(d.baseFontSize) || d.baseFontSize < 10 || d.baseFontSize > 24)
    out.push("Base font size must be between 10 and 24.");
  if (!Number.isInteger(d.contentWidth) || d.contentWidth < 320 || d.contentWidth > 800)
    out.push("Content width must be between 320 and 800.");
  return out;
}

/* --------------------------------------------------------- Normalisation IA */

const asString = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const asInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
};

/**
 * Rend une direction utilisable quelle que soit la forme rendue par la route.
 * Deux formes de palette sont acceptées — objet `{ role: hex }` ou tableau `[{ role, hex }]` —
 * parce que c'est le seul point du contrat où un modèle dérive naturellement. Tout le reste
 * (le document) reste strict : aucune tolérance là où le schéma Zod fait autorité.
 */
export function normalizeDirection(raw: unknown): ArtDirection {
  const src = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  const inner = src.direction && typeof src.direction === "object" ? (src.direction as Record<string, unknown>) : src;

  const palette: Record<PaletteRole, string> = { ...DEFAULT_DIRECTION.palette };
  const rawPalette = inner.palette;
  if (Array.isArray(rawPalette)) {
    for (const entry of rawPalette) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const role = asString(e.role) as PaletteRole | null;
      const hex = asString(e.hex) ?? asString(e.color) ?? asString(e.value);
      if (role && hex && (PALETTE_ROLES as readonly string[]).includes(role)) palette[role] = hex;
    }
  } else if (rawPalette && typeof rawPalette === "object") {
    const p = rawPalette as Record<string, unknown>;
    for (const role of PALETTE_ROLES) {
      const hex = asString(p[role]);
      if (hex) palette[role] = hex;
    }
  }

  const density = asString(inner.density);
  const typography =
    inner.typography && typeof inner.typography === "object" ? (inner.typography as Record<string, unknown>) : {};

  return {
    mood: asString(inner.mood) ?? asString(inner.ambience) ?? "",
    palette,
    fontFamily:
      asString(inner.fontFamily) ?? asString(typography.fontFamily) ?? DEFAULT_DIRECTION.fontFamily,
    headingFontFamily:
      asString(inner.headingFontFamily) ?? asString(typography.headingFontFamily) ?? undefined,
    baseFontSize:
      asInt(inner.baseFontSize) ?? asInt(typography.baseFontSize) ?? DEFAULT_DIRECTION.baseFontSize,
    radius: asInt(inner.radius) ?? DEFAULT_DIRECTION.radius,
    density: (DENSITIES as readonly string[]).includes(density ?? "")
      ? (density as Density)
      : DEFAULT_DIRECTION.density,
    contentWidth: asInt(inner.contentWidth) ?? DEFAULT_DIRECTION.contentWidth,
    notes: asString(inner.notes) ?? undefined,
  };
}

/* ---------------------------------------------------------------- Documents */

/** Compte les blocs sans dépendre de `eachBlock` (le doc peut venir d'une réponse non parsée). */
export function countBlocks(doc: EmailDoc): number {
  let n = 0;
  for (const row of doc.rows) for (const col of row.columns) n += col.blocks.length;
  return n;
}

/**
 * Sentinelle d'illustration. La composition ne peut pas inventer une URL d'image : elle pose
 * `ai://<brief de l'image>` et l'étape « Generate images » la remplace par une URL réelle.
 *
 * ⚠️ Le test vient de `@nf/render/schema` — la MÊME fonction que celle utilisée par le garde-fou de
 * PUBLICATION (`EmailDocPublishable`). Une seconde définition ici finirait par dériver, et l'écran
 * afficherait « prêt à publier » sur un document que la publication refuse.
 */
export function isPlaceholderImage(block: ImageBlock): boolean {
  const s = block.src.trim();
  return s === "" || isPlaceholderSrc(s);
}

/** Brief d'illustration porté par la sentinelle, sinon le texte alternatif. */
export function imagePromptOf(block: ImageBlock): string {
  const m = /^\s*(?:ai:|placeholder:)(?:\/\/)?(.*)$/i.exec(block.src);
  const fromSrc = m?.[1] ? decodeURIComponent(m[1]).replace(/[_+]/g, " ").trim() : "";
  return fromSrc || block.alt.trim();
}

export interface PendingImage {
  blockId: string;
  prompt: string;
  alt: string;
  widthPct: number;
}

/** Brief d'illustration d'une vignette d'article — même sentinelle, autre porteur. */
function articlePromptOf(src: string, alt: string): string {
  const m = /^\s*(?:ai:|placeholder:)(?:\/\/)?(.*)$/i.exec(src);
  const fromSrc = m?.[1] ? decodeURIComponent(m[1]).replace(/[_+]/g, " ").trim() : "";
  return fromSrc || alt.trim();
}

/**
 * Tous les visuels encore en attente d'une vraie source.
 *
 * ⚠️ Deux blocs portent une image, pas un : `image.src` ET `article.imageSrc`. Ne collecter que le
 * premier laissait les vignettes d'article dans un cul-de-sac — la composition les pose en `ai://`,
 * le compilateur les signale, `EmailDocPublishable` refuse de publier, et l'assistant n'offrait
 * AUCUN moyen de les remplir. Le garde-fou existait des deux côtés ; c'est l'offre de réparation
 * qui n'en couvrait qu'un.
 */
export function pendingImages(doc: EmailDoc): PendingImage[] {
  const out: PendingImage[] = [];
  for (const row of doc.rows)
    for (const col of row.columns)
      for (const block of col.blocks) {
        if (block.type === "image" && isPlaceholderImage(block)) {
          out.push({ blockId: block.id, prompt: imagePromptOf(block), alt: block.alt, widthPct: block.widthPct });
        } else if (block.type === "article" && block.imageSrc !== undefined && isPlaceholderSrc(block.imageSrc)) {
          out.push({
            blockId: block.id,
            prompt: articlePromptOf(block.imageSrc, block.imageAlt),
            alt: block.imageAlt,
            // La vignette d'article n'a pas de largeur propre : elle suit sa colonne.
            widthPct: 100,
          });
        }
      }
  return out;
}

/** Remplace immuablement la source d'un visuel, quel que soit le bloc qui le porte. */
export function setImageSrc(doc: EmailDoc, blockId: string, src: string): EmailDoc {
  return {
    ...doc,
    rows: doc.rows.map((row) => ({
      ...row,
      columns: row.columns.map((col) => ({
        ...col,
        blocks: col.blocks.map((b) => {
          if (b.id !== blockId) return b;
          if (b.type === "image") return { ...b, src };
          if (b.type === "article") return { ...b, imageSrc: src };
          return b;
        }),
      })),
    })),
  };
}
