/**
 * « USE FOR ALL TITLES » (24/09/2026, feature 5, étape 5).
 *
 * Écrit la couleur dans le style global des titres (`theme.headingColor`) ET efface la couleur propre
 * de chaque autre titre. Les deux sont nécessaires : un modèle importé porte une couleur PAR BLOC, et
 * un style global seul ne l'atteindrait jamais (la couleur du bloc gagne).
 *
 * ⛔ UN TITRE POSÉ SUR UN FOND COLORÉ GARDE SA COULEUR. Un bandeau sombre porte souvent un titre blanc
 * posé sur le BLOC (et non sur la rangée) : l'effacer le repeindrait dans la couleur globale, du sombre
 * sur du sombre. Est « coloré » un fond peint (bloc, sinon colonne, sinon rangée ; look ou intertitre
 * d'un flux, sinon le flux) différent du fond du contenu. Un encart mis en page (`layout`) est toujours
 * gardé : ses zones portent leurs propres fonds et photos.
 *
 * Ce qui est effacé, et rien d'autre : `style.textColor` des blocs texte h1-h3 et des titres de section,
 * `titleColor` des articles, des encarts et des looks `card`/`lead` d'un flux, `style.textColor` de
 * l'intertitre d'un flux. Les couleurs de rangée et de colonne ne sont jamais touchées.
 *
 * Module NEUTRE (ni "use client", ni serveur) : le reducer l'appelle, le banc aussi.
 */
import type { Block, BoxStyle, EmailDoc, Theme } from "@nf/render/schema";

export interface ResultatTitres {
  doc: EmailDoc;
  /** Couleurs propres effacées (le titre suit désormais le style global). */
  effaces: number;
  /** Couleurs propres gardées parce que le titre est posé sur un fond coloré. */
  gardes: number;
}

type Compte = { effaces: number; gardes: number };

const surFondColore = (theme: Theme, fond: string | undefined): boolean =>
  fond !== undefined && fond.toLowerCase() !== theme.contentBackground.toLowerCase();

/** Le style sans sa couleur de texte ; `undefined` s'il ne reste rien (un style vide n'est pas écrit). */
function sansCouleur(style: BoxStyle | undefined): BoxStyle | undefined {
  if (style === undefined) return undefined;
  const { textColor: _retiree, ...reste } = style;
  return Object.keys(reste).length === 0 ? undefined : reste;
}

/** `obj` sans la clé `k` (absente, et non `undefined` : le document reste propre à l'octet). */
function sans<T extends object, K extends keyof T>(obj: T, k: K): T {
  const copie = { ...obj };
  delete copie[k];
  return copie;
}

function traiterBloc(block: Block, fondParent: string | undefined, theme: Theme, n: Compte): Block {
  const fondDe = (style: BoxStyle | undefined, repli: string | undefined) => style?.backgroundColor ?? repli;

  switch (block.type) {
    case "text":
    case "section_title": {
      if (block.type === "text" && block.preset !== "h1" && block.preset !== "h2" && block.preset !== "h3") return block;
      if (block.style?.textColor === undefined) return block;
      if (surFondColore(theme, fondDe(block.style, fondParent))) {
        n.gardes++;
        return block;
      }
      n.effaces++;
      const style = sansCouleur(block.style);
      return (style === undefined ? sans(block, "style") : { ...block, style }) as Block;
    }
    case "article": {
      if (block.titleColor === undefined) return block;
      if (surFondColore(theme, fondDe(block.style, fondParent))) {
        n.gardes++;
        return block;
      }
      n.effaces++;
      return sans(block, "titleColor");
    }
    case "callout": {
      if (block.titleColor === undefined) return block;
      if (block.layout !== undefined || surFondColore(theme, fondDe(block.style, fondParent))) {
        n.gardes++;
        return block;
      }
      n.effaces++;
      return sans(block, "titleColor");
    }
    case "article-feed": {
      const fondFlux = fondDe(block.style, fondParent);
      let out = block;
      for (const cle of ["card", "lead"] as const) {
        const look = out[cle];
        if (look?.titleColor === undefined) continue;
        if (surFondColore(theme, fondDe(look.style, fondFlux))) {
          n.gardes++;
          continue;
        }
        n.effaces++;
        out = { ...out, [cle]: sans(look, "titleColor") };
      }
      const mid = out.midSection;
      if (mid?.style?.textColor !== undefined) {
        if (surFondColore(theme, fondDe(mid.style, fondFlux))) n.gardes++;
        else {
          n.effaces++;
          const style = sansCouleur(mid.style);
          out = { ...out, midSection: style === undefined ? sans(mid, "style") : { ...mid, style } };
        }
      }
      return out;
    }
    default:
      return block;
  }
}

export function utiliserPourTousLesTitres(doc: EmailDoc, couleur: string): ResultatTitres {
  const n: Compte = { effaces: 0, gardes: 0 };
  const theme: Theme = { ...doc.theme, headingColor: couleur };
  const rows = doc.rows.map((row) => ({
    ...row,
    columns: row.columns.map((col) => ({
      ...col,
      blocks: col.blocks.map((b) => traiterBloc(b, col.style?.backgroundColor ?? row.style?.backgroundColor, theme, n)),
    })),
  }));
  return { doc: { ...doc, theme, rows }, ...n };
}
