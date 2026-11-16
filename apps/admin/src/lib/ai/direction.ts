/**
 * Étape 1 — DIRECTION GRAPHIQUE par vision.
 *
 * Claude regarde l'image de référence et en extrait une direction *exploitable en email*.
 * Le schéma est le MIROIR EXACT des clés couleur de `Theme` (@nf/render/schema) : ce que
 * l'utilisateur corrige à l'écran atterrit tel quel dans `doc.theme`, sans table de correspondance.
 */
import { z } from "zod";
import { callClaude, parseJsonLoose, type ClaudeUsage } from "./claude";

const Hex = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb")
  // Le noir et le blanc PURS déclenchent l'inversion automatique du dark mode chez plusieurs
  // clients : on les décale d'un cran, visuellement identique, invisible pour le déclencheur.
  .transform((v) => {
    const up = v.toUpperCase();
    if (up === "#FFFFFF") return "#FEFEFE";
    if (up === "#000000") return "#0E0E0E";
    return up;
  });

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

export const ArtDirection = z
  .object({
    mood: z.string().min(1).max(400),
    palette: z.object({
      bodyBackground: Hex,
      contentBackground: Hex,
      textColor: Hex,
      mutedColor: Hex,
      linkColor: Hex,
      brandColor: Hex,
      buttonTextColor: Hex,
      borderColor: Hex,
    }),
    fontFamily: z.string().min(1).max(200),
    headingFontFamily: z.string().max(200).optional(),
    baseFontSize: z.number().int().min(12).max(20),
    radius: z.number().int().min(0).max(24),
    density: z.enum(["compact", "cozy", "airy"]),
    contentWidth: z.number().int().min(480).max(700),
    notes: z.string().max(1200).optional(),
  })
  .strict();

export type ArtDirectionT = z.infer<typeof ArtDirection>;

/**
 * SYSTEM PROMPT — STATIQUE et byte-stable (condition du prompt caching).
 * Tout ce qui varie (image, brief, catégorie) passe par le message utilisateur.
 */
const SYSTEM = `You are an art director specialised in HTML email design.

You receive a reference image and a short brief. Extract a design direction that can actually be
rendered in an email client. Answer with ONE JSON object and nothing else — no prose, no code fence.

Shape:
{
  "mood": "one sentence describing the atmosphere you read in the image",
  "palette": {
    "bodyBackground": "#rrggbb",     // page background, outside the content card
    "contentBackground": "#rrggbb",  // the email card itself
    "textColor": "#rrggbb",          // body copy
    "mutedColor": "#rrggbb",         // secondary copy, must stay readable
    "linkColor": "#rrggbb",
    "brandColor": "#rrggbb",         // buttons and accents
    "buttonTextColor": "#rrggbb",    // label ON the brand colour
    "borderColor": "#rrggbb"
  },
  "fontFamily": "web-safe CSS stack",
  "headingFontFamily": "web-safe CSS stack (optional)",
  "baseFontSize": 16,
  "radius": 8,
  "density": "compact" | "cozy" | "airy",
  "contentWidth": 600,
  "notes": "anything a designer should know (optional)"
}

Hard rules, because this is email and not the web:
- Every colour is a 6-digit hex. Never #000000 and never #ffffff exactly — they trigger automatic
  colour inversion in several clients. Use #0E0E0E and #FEFEFE instead.
- textColor on contentBackground must reach at least 4.5:1 contrast. mutedColor at least 3:1.
  buttonTextColor on brandColor must reach at least 4.5:1. Adjust the palette until it does.
- The palette must work on a LIGHT content background. Do not propose a dark-background design.
- fontFamily must be a web-safe stack (Arial, Helvetica, Georgia, "Segoe UI", Tahoma, Verdana,
  system-ui…). Custom web fonts are ignored by Outlook, which falls back to Times New Roman.
- contentWidth stays between 480 and 700; 600 is the safe norm.
- radius is a single number in px; gradients, shadows and blurs cannot be rendered — ignore them and
  translate the intent into flat colour instead.
- Take the colours from the image, not from your imagination. If the image is monochrome, derive a
  restrained palette and say so in "notes".`;

export async function analyzeArtDirection(a: {
  imageBase64: string;
  mediaType: string;
  brief: string;
  category: string;
}): Promise<{ direction: ArtDirectionT; usage: ClaudeUsage; model: string; warnings: string[] }> {
  const { text, usage, model } = await callClaude({
    system: SYSTEM,
    userContent: [
      { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.imageBase64 } },
      {
        type: "text",
        text: `Template kind: ${a.category}\n\nBrief from the marketer:\n${a.brief || "(no brief provided — rely on the image)"}`,
      },
    ],
    // ⚠️ Sur Opus 5 la reflexion est active par defaut et consomme du `max_tokens` : un plafond de
    // 2000 coupait la reponse AVANT le JSON. Effort `low` suffit — lire une image est une tache de
    // perception, pas de raisonnement.
    maxTokens: 8_000,
    timeoutMs: 90_000,
    effort: "low",
  });

  const parsed = ArtDirection.safeParse(parseJsonLoose(text));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    // Pas de reprise ici : la direction est bon marché à relancer, et l'utilisateur peut de toute
    // façon corriger la palette à la main juste après. Mieux vaut échouer lisiblement.
    const { ClaudeError } = await import("./claude");
    throw new ClaudeError("Claude returned an art direction that does not match the schema.", "bad_response", issues);
  }

  return { direction: parsed.data, usage, model, warnings: contrastWarnings(parsed.data) };
}

/* ------------------------------------------------------------------ contraste */

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/**
 * On AVERTIT plutôt que de bloquer : la palette reste éditable à l'écran, et un contraste faible
 * n'empêche pas de composer. Ce qui compte est que le défaut soit VISIBLE avant l'envoi.
 */
export function contrastWarnings(d: ArtDirectionT): string[] {
  const w: string[] = [];
  const p = d.palette;
  const body = contrastRatio(p.textColor, p.contentBackground);
  if (body < 4.5) w.push(`Body text contrast is ${body}:1 on the content background (4.5:1 needed).`);
  const muted = contrastRatio(p.mutedColor, p.contentBackground);
  if (muted < 3) w.push(`Muted text contrast is ${muted}:1 (3:1 needed).`);
  const button = contrastRatio(p.buttonTextColor, p.brandColor);
  if (button < 4.5) w.push(`Button label contrast is ${button}:1 on the brand colour (4.5:1 needed).`);
  return w;
}

/** Traduit la direction en `theme` du document (les clés sont déjà alignées). */
export function directionToTheme(d: ArtDirectionT): Record<string, unknown> {
  const pad = d.density === "compact" ? 6 : d.density === "airy" ? 16 : 10;
  return {
    ...d.palette,
    contentWidth: d.contentWidth,
    fontFamily: d.fontFamily,
    fontSize: d.baseFontSize,
    radius: d.radius,
    blockPadding: { top: pad, right: 24, bottom: pad, left: 24 },
  };
}
