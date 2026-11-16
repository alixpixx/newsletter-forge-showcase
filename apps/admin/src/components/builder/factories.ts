/**
 * Fabriques de noeuds EmailDoc — la SEULE façon de créer un bloc/colonne/ligne dans le builder.
 *
 * Les valeurs par défaut sont volontairement VALIDES au regard du schéma Zod (ex. `src` non vide,
 * `label` ≤ 28) : un brouillon fraîchement créé doit toujours passer `EmailDoc.parse()` côté API.
 * Seule exception assumée : `alt` d'image est laissé vide — c'est un choix produit (l'auteur DOIT
 * l'écrire, l'inspecteur affiche un avertissement, et `EmailDocPublishable` bloque la publication).
 */
import {
  LAYOUT_WEIGHTS,
  newId,
  type Block,
  type BlockType,
  type Column,
  type Row,
  type RowLayout,
} from "@nf/render/schema";

export function newBlock(type: BlockType): Block {
  const id = newId("blk");
  switch (type) {
    case "text":
      return { id, type: "text", preset: "body", paragraphs: [{ spans: [{ text: "New text block." }] }] };
    case "image":
      // alt vide EXPRÈS → l'inspecteur avertit, la publication refuse. Jamais de faux alt auto.
      return { id, type: "image", src: "https://placehold.co/600x240", alt: "", widthPct: 100, align: "center" };
    case "button":
      return { id, type: "button", label: "Read more", href: "https://example.com", align: "center" };
    case "divider":
      return { id, type: "divider", thickness: 1, widthPct: 100 };
    case "spacer":
      return { id, type: "spacer", height: 24 };
    case "html":
      return { id, type: "html", raw: "<!-- paste your HTML here -->" };
    case "social":
      return {
        id,
        type: "social",
        items: [{ platform: "instagram", href: "https://instagram.com" }],
        iconSize: 24,
        mode: "horizontal",
      };
    case "menu":
      return { id, type: "menu", items: [{ label: "Home", href: "https://example.com" }], separator: "·" };
    case "section_title":
      return { id, type: "section_title", label: "", rule: "after", ruleThickness: 2 };

    /* --------------------------------------------------------------
     * Blocs métier — TOUS les libellés naissent VIDES.
     *
     * Un défaut parlant serait ici un mensonge : « Both teams to score », « 1.85 » ou une position
     * de classement ressemblent à de la donnée sportive et finiraient par partir en production sans
     * que personne ne les relise. Le canvas affiche des repères visuels à la place (chrome de
     * l'éditeur, jamais du contenu), et l'inspecteur montre les champs à remplir.
     *
     * Une seule exception, qui n'est pas de la donnée sportive : les `href` requis par le schéma
     * (`min(1)`), qui reçoivent le même `https://example.com` neutre que le bouton.
     *
     * ⛔ ET SURTOUT PAS DE `ctaLabel` D'ARTICLE — c'est le POURQUOI de tout ce lot. Un libellé
     * présent dans un document signifie désormais, toujours, qu'un HUMAIN l'a tapé. C'est cette
     * équivalence qui permet au rendu (`withDefaultCta`, `packages/render/src/feed.ts`) de
     * distinguer une saisie d'une absence, donc de REFUSER de fabriquer un bouton sur un lien qui
     * ne mène nulle part. En posant le défaut ici, on la rompait : la garde voyait un libellé, le
     * prenait pour une saisie, sortait avant même de regarder l'href, et l'email partait avec une
     * ancre vers le `https://example.com` que cette fabrique venait d'écrire deux lignes plus haut.
     * Le défaut se pose AU RENDU et nulle part ailleurs ; le réécrire à la création rouvre le bug.
     * -------------------------------------------------------------- */
    case "pick":
      return { id, type: "pick", matchLabel: "", marketLabel: "", selectionLabel: "", oddsLabel: "" };
    case "odds_table":
      // 2 lignes = le minimum du schéma. Vides : l'éditeur les remplit ou y met un merge tag.
      return {
        id,
        type: "odds_table",
        rows: [
          { label: "", value: "" },
          { label: "", value: "" },
        ],
      };
    case "standings":
      // 2 colonnes (minimum du schéma) × 3 lignes vides — juste assez pour voir la grille.
      return {
        id,
        type: "standings",
        columns: ["", ""],
        rows: [
          ["", ""],
          ["", ""],
          ["", ""],
        ],
      };
    case "article":
      // `imageAlt` vide EXPRÈS, même contrat que l'image : la publication le refuse.
      return {
        id,
        type: "article",
        title: "",
        excerpt: "",
        imageAlt: "",
        href: "https://example.com",
        layout: "stacked",
      };
    case "callout":
      return { id, type: "callout", kicker: "", title: "", body: "", accentWidth: 0 };
    case "scoreboard":
      // 2 lignes = le minimum du schéma, vides comme les autres blocs sportifs.
      return {
        id,
        type: "scoreboard",
        kicker: "",
        rows: [
          { label: "", value: "", highlight: false },
          { label: "", value: "", highlight: false },
        ],
      };
    case "promo":
      return { id, type: "promo", headline: "", href: "https://example.com", ctaLabel: "" };

    case "footer_legal":
      return { id, type: "footer_legal" };
  }
}

export function newColumn(): Column {
  return { id: newId("col"), blocks: [] };
}

export function newRow(layout: RowLayout): Row {
  return {
    id: newId("row"),
    layout,
    columns: LAYOUT_WEIGHTS[layout].map(() => newColumn()),
  };
}

/**
 * Ligne pleine largeur ne contenant qu'un bloc — forme produite par un dépôt ENTRE deux lignes.
 *
 * Le layout est forcé à « 1 » : un bloc lâché dans l'interligne n'exprime aucune intention de
 * colonnage, et « 1 » est le seul layout qui ne laisse aucune colonne vide derrière lui.
 */
export function newRowWith(block: Block): Row {
  const row = newRow("1");
  row.columns[0].blocks = [block];
  return row;
}

/** Copie profonde d'un bloc avec de NOUVEAUX identifiants (duplication). */
export function cloneBlock(block: Block): Block {
  const copy = structuredClone(block) as Block;
  copy.id = newId("blk");
  return copy;
}

/** Libellés anglais de la palette (l'UI admin est en anglais). */
export const BLOCK_LABELS: Record<BlockType, string> = {
  text: "Text",
  image: "Image",
  button: "Button",
  divider: "Divider",
  spacer: "Spacer",
  html: "Raw HTML",
  social: "Social icons",
  menu: "Menu",
  pick: "Pick",
  odds_table: "Odds table",
  standings: "Standings",
  scoreboard: "Scoreboard",
  article: "Article",
  section_title: "Section title",
  callout: "Callout",
  promo: "Promo",
  footer_legal: "Legal footer",
};
