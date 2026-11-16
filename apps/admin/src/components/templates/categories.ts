import type { Tone } from "@/components/ui";

/*
 * Catégories de modèles — miroir EXACT de la contrainte CHECK de `newsletter.template.category`
 * (migration 0017). Toute valeur absente de cette liste est refusée par la base : le sélecteur
 * de création ne doit donc jamais proposer autre chose.
 */

export const TEMPLATE_CATEGORIES = [
  "newsletter",
  "daily_pick",
  "preview",
  "roundup",
  "win_back",
  "welcome",
  "transactional",
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

const LABELS: Record<TemplateCategory, string> = {
  newsletter: "Newsletter",
  daily_pick: "Daily pick",
  preview: "Preview",
  roundup: "Roundup",
  win_back: "Win-back",
  welcome: "Welcome",
  transactional: "Transactional",
};

const TONES: Record<TemplateCategory, Tone> = {
  newsletter: "grey",
  daily_pick: "green",
  preview: "blue",
  roundup: "violet",
  win_back: "amber",
  welcome: "pink",
  transactional: "grey",
};

/** Libellé affichable — une catégorie inconnue (base plus récente que l'UI) est affichée telle quelle. */
export function categoryLabel(category: string): string {
  return LABELS[category as TemplateCategory] ?? category;
}

export function categoryTone(category: string): Tone {
  return TONES[category as TemplateCategory] ?? "grey";
}
