/**
 * STYLES PRÊTS DU FLUX — Classic / Compact / Hero (24/09/2026, feature 5, étape 6).
 *
 * Un flux porte des dizaines de réglages de carte. Trois styles prêts couvrent les maquettes : un clic
 * écrit la DISPOSITION (arrangement, nombre de unes, taille des titres, largeur des vignettes, filet
 * entre les cartes) et rien d'autre. Les couleurs et les polices restent celles des styles de l'e-mail
 * (ou celles qu'un look pose déjà) : un style prêt ne repeint jamais.
 *
 * ⛔ PAS DE CLÉ NOUVELLE DANS LE DOCUMENT. Un style prêt n'est qu'une façon d'écrire des clés qui
 * existent : aucun modèle enregistré ne change de rendu, et le compilateur n'en sait rien.
 * ⛔ UN STYLE EST « ACTIF » SI LE CHOISIR NE CHANGERAIT RIEN (`styleFluxActif`). Aucune seconde
 * définition de ce qu'est « Compact » : la même fonction écrit et reconnaît.
 * ⚠️ `leadCount` de 2 ou 3 est gardé par Hero (une une de deux articles posée à la main n'est pas
 * ramenée à un seul) ; Classic et Compact le retirent — ce sont des listes sans une.
 *
 * Module NEUTRE (ni "use client", ni serveur) : le reducer l'appelle, le banc aussi.
 */
import type { ArticleFeedBlock, ArticleLook } from "@nf/render/schema";

export const FEED_PRESETS = ["classic", "compact", "hero"] as const;
export type FeedPreset = (typeof FEED_PRESETS)[number];

export const FEED_PRESET_LABELS: Record<FeedPreset, { label: string; hint: string }> = {
  classic: { label: "Classic", hint: "Every card alike: image above the text, no rule between cards." },
  compact: {
    label: "Compact",
    hint: "A list: small image on the left, smaller titles, a text read link, a rule between cards. On phones the image goes above the text.",
  },
  hero: {
    label: "Hero",
    hint: "The first article big, image above; the others as a compact list. On phones every image goes above its text.",
  },
};

/** Tailles et largeur des styles prêts. Le défaut du compilateur : titre = taille du texte + 3, vignette 38 %. */
const COMPACT = { imageWidthPct: 28, titleSize: 17 } as const;
const HERO_TITLE = 26;

type Look = ArticleLook | undefined;

/** `look` avec `patch` fusionné ; une clé à `undefined` est RETIRÉE ; un look vide redevient absent. */
function fusion(look: Look, patch: Partial<Record<keyof ArticleLook, unknown>>): Look {
  const out: Record<string, unknown> = { ...(look ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return Object.keys(out).length === 0 ? undefined : (out as ArticleLook);
}

/** Le bloc avec `k` posé, ou retiré (absent, pas `undefined` : le document reste propre à l'octet). */
function pose<K extends keyof ArticleFeedBlock>(block: ArticleFeedBlock, k: K, v: ArticleFeedBlock[K] | undefined): ArticleFeedBlock {
  const copie = { ...block };
  if (v === undefined) delete copie[k];
  else copie[k] = v;
  return copie;
}

export function appliquerStyleFlux(block: ArticleFeedBlock, preset: FeedPreset): ArticleFeedBlock {
  const leads = block.leadCount ?? 0;
  // Le lien de lecture des brèves : un lien texte en liste (le bouton pesait plus que le titre, capture à
  // 600 px du 24/09), le défaut du flux en Classic. ⛔ Un lien RETIRÉ (`none`, sur le look ou le flux) le
  // reste : un style prêt ne fait jamais réapparaître ce que l'auteur a enlevé.
  const lienRetire = (block.card?.ctaStyle ?? block.ctaStyle) === "none";
  const lienListe = lienRetire ? block.card?.ctaStyle : "link";
  const lienClassic = block.card?.ctaStyle === "none" ? "none" : undefined;
  let out: ArticleFeedBlock = { ...block };
  // Les brèves suivent `layout` du flux : le look `card` ne garde pas le sien (sinon « Arrangement »
  // montrerait une valeur et l'e-mail en rendrait une autre).
  switch (preset) {
    case "classic":
      out = pose(out, "layout", "stacked");
      out = pose(out, "leadCount", undefined);
      out = pose(out, "card", fusion(out.card, { layout: undefined, imageWidthPct: undefined, titleSize: undefined, ctaStyle: lienClassic }));
      out = pose(out, "cardRule", undefined);
      break;
    case "compact":
      out = pose(out, "layout", "side");
      out = pose(out, "leadCount", undefined);
      out = pose(out, "card", fusion(out.card, { layout: undefined, ...COMPACT, ctaStyle: lienListe }));
      out = pose(out, "cardRule", out.cardRule ?? {});
      break;
    case "hero":
      out = pose(out, "layout", "side");
      out = pose(out, "leadCount", leads >= 1 ? leads : 1);
      out = pose(out, "lead", fusion(out.lead, { layout: "stacked", imageWidthPct: undefined, titleSize: HERO_TITLE }));
      out = pose(out, "card", fusion(out.card, { layout: undefined, ...COMPACT, ctaStyle: lienListe }));
      out = pose(out, "cardRule", out.cardRule ?? {});
      break;
  }
  return out;
}

/** Le style prêt que le bloc porte déjà — celui dont le choix ne changerait rien —, sinon `null` (« Custom »). */
export function styleFluxActif(block: ArticleFeedBlock): FeedPreset | null {
  const avant = JSON.stringify(block);
  return FEED_PRESETS.find((p) => JSON.stringify(appliquerStyleFlux(block, p)) === avant) ?? null;
}
