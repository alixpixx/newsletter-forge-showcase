/**
 * LE CANVAS AFFICHE LE HTML DU COMPILATEUR, BLOC PAR BLOC — plus aucun dessin écrit à côté.
 *
 * ⛔ POURQUOI. Le canvas dessinait chaque bloc avec son propre JSX, et chaque réglage lu par le
 * compilateur devait être recopié là pour se voir à l'écran. Il ne l'était jamais tout à fait : fond
 * du bouton peint sur le bouton, rayon d'image codé à 4 px, taille du texte ignorée, filet multicolore
 * absent, flux Copper Kettle faux jusqu'au 22/09/2026 (inventaire « Canvas ≠ email »). Chaque prop
 * ajoutée au compilateur rouvrait l'écart. Ici, il n'y a plus de seconde lecture : le fragment d'un bloc
 * EST ce que `compileDoc` émet pour lui, et une prop que le compilateur apprend demain apparaît dans
 * l'éditeur sans une ligne de plus.
 *
 * ⚙️ COMMENT, SANS TOUCHER AU COMPILATEUR. On compile un document SYNTHÉTIQUE avec `compileDoc`,
 * l'entrée publique et la seule : chaque bloc y reçoit sa propre row, qui reprend la mise en page, le
 * style de row, le style de colonne et l'INDEX de colonne de sa row d'origine — les seules données dont
 * dépend son rendu (largeur utile des images et des cartes, cascade typographique). Le bloc y est
 * encadré de deux blocs `html` qui ne portent qu'un commentaire ; `mj-raw` les rend tels quels, et le
 * fragment se lit entre les deux.
 *
 * ⚠️ CE QUE LE DOCUMENT SYNTHÉTIQUE CHANGE, ET POURQUOI C'EST SANS EFFET SUR LE FRAGMENT :
 *  - la NUMÉROTATION des classes générées (`nf-m-3` au lieu de `nf-m-7`) : la feuille de style
 *    renvoyée est celle de CETTE compilation, donc cohérente avec ses propres classes ;
 *  - l'épinglage sombre d'une rangée sans texte (`darkKeepClass`) : il se pose sur la SECTION, que le
 *    fragment ne contient pas ;
 *  - les `visibleIf` sont retirés : l'éditeur montre tout, le badge « If » dit ce qui est conditionnel.
 * Le banc `canvas-render.test.ts` le mesure : chaque fragment se retrouve MOT POUR MOT dans le HTML
 * du vrai document compilé, numéros de classe mis à part.
 */
import { applyBrandPartials, compileDoc, type BrandPartials } from "@nf/render/compile";
import {
  EmailDoc,
  MAX_DOC_ROWS,
  type Block,
  type EmailDocInput,
  type Row,
} from "@nf/render/schema";

export interface CanvasFragment {
  /** HTML émis par le compilateur pour ce bloc, tokens `{{…}}` non résolus. */
  html: string;
  /** Index dans `sheets` de la feuille qui accompagne ce fragment (une par passe de compilation). */
  sheet: number;
}

export interface CanvasRender {
  /** Par id de bloc — y compris les blocs des rows d'en-tête et de pied de marque. */
  blocks: Record<string, CanvasFragment>;
  /** CSS du `<head>` compilé, prête pour une feuille de style (voir `headCss`). */
  sheets: string[];
  /** Blocs que le schéma refuse : ils ne peuvent pas se compiler, le canvas dit pourquoi. */
  invalid: Record<string, string[]>;
  /** Rows de l'en-tête de marque, posées AVANT le document à la compilation. */
  header: Row[];
  /** Rows du pied de marque, posées juste AVANT la row du pied légal. */
  footer: Row[];
  warnings: string[];
}

/** Échec qui n'est pas imputable à un bloc : thème ou méta invalides, compilateur en panne. */
export class CanvasRenderError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ *
 * Marqueurs
 * ------------------------------------------------------------------ */

const debut = (n: number): string => `<!--nfc:${n}:s-->`;
const fin = (n: number): string => `<!--nfc:${n}:e-->`;

const marqueur = (n: number, bord: "s" | "e"): Block => ({
  id: `nfc-m${n}${bord}`,
  type: "html",
  raw: bord === "s" ? debut(n) : fin(n),
});

/** Le bloc sans sa condition — l'éditeur montre tout ; le badge « If » porte l'information. */
function sansCondition(block: Block): Block {
  if (block.type === "footer_legal" || block.visibleIf === undefined) return block;
  const { visibleIf: _retire, ...reste } = block;
  return reste as Block;
}

/* ------------------------------------------------------------------ *
 * Validation bloc par bloc
 * ------------------------------------------------------------------ */

type Brut = Record<string, unknown>;
const objet = (v: unknown): v is Brut => typeof v === "object" && v !== null && !Array.isArray(v);
const liste = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * ⛔ UN BLOC INVALIDE NE DOIT PAS ÉTEINDRE TOUT LE CANVAS. `EmailDoc.parse` refuse le document entier
 * pour un seul `href` vide ; le canvas se serait figé pendant que l'auteur tape. On retire donc du
 * document les blocs que le schéma désigne, on compile le reste, et on rend leurs motifs : le canvas
 * garde leur dernier rendu et dit pourquoi il ne bouge plus. C'est aussi la vérité de l'envoi — un bloc
 * que le schéma refuse ne part pas.
 */
function elaguer(input: unknown): { doc: EmailDoc; invalid: Record<string, string[]> } {
  const premier = EmailDoc.safeParse(input);
  if (premier.success) return { doc: premier.data, invalid: {} };

  if (!objet(input)) throw new CanvasRenderError("invalid document", ["(root): expected an object"]);
  const invalid: Record<string, string[]> = {};
  const blocsRetires = new Set<string>();
  const rowsRetirees = new Set<number>();
  const fatales: string[] = [];

  const idDe = (r: number, c: number, b: number): string => {
    const row = liste(input.rows)[r];
    const col = objet(row) ? liste(row.columns)[c] : undefined;
    const blk = objet(col) ? liste(col.blocks)[b] : undefined;
    return objet(blk) && typeof blk.id === "string" ? blk.id : `#${r}.${c}.${b}`;
  };

  for (const issue of premier.error.issues) {
    const p = issue.path;
    const message = `${p.slice(6).map(String).join(".") || p.map(String).join(".") || "(root)"}: ${issue.message}`;
    if (p[0] === "rows" && typeof p[1] === "number") {
      if (p[2] === "columns" && typeof p[3] === "number" && p[4] === "blocks" && typeof p[5] === "number") {
        const id = idDe(p[1], p[3], p[5]);
        (invalid[id] ??= []).push(message);
        blocsRetires.add(`${p[1]}.${p[3]}.${p[5]}`);
        continue;
      }
      // Défaut porté par la row ou une colonne : tous ses blocs sont suspendus, pas le document.
      rowsRetirees.add(p[1]);
      const row = liste(input.rows)[p[1]];
      liste(objet(row) ? row.columns : []).forEach((col, c) => {
        liste(objet(col) ? col.blocks : []).forEach((_b, b) => {
          (invalid[idDe(p[1] as number, c, b)] ??= []).push(`row: ${issue.message}`);
        });
      });
      continue;
    }
    fatales.push(`${p.map(String).join(".") || "(root)"}: ${issue.message}`);
  }
  if (fatales.length > 0) throw new CanvasRenderError("invalid document", fatales);

  const rows = liste(input.rows)
    .map((row, r) => ({ row, r }))
    .filter(({ r }) => !rowsRetirees.has(r))
    .map(({ row, r }) => {
      if (!objet(row)) return row;
      return {
        ...row,
        columns: liste(row.columns).map((col, c) =>
          objet(col)
            ? { ...col, blocks: liste(col.blocks).filter((_b, b) => !blocsRetires.has(`${r}.${c}.${b}`)) }
            : col,
        ),
      };
    });
  const second = EmailDoc.safeParse({ ...input, rows });
  if (!second.success) {
    throw new CanvasRenderError(
      "invalid document",
      second.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`),
    );
  }
  return { doc: second.data, invalid };
}

/* ------------------------------------------------------------------ *
 * Feuille de style du head
 * ------------------------------------------------------------------ */

/**
 * La CSS que le `<head>` compilé applique au corps, prête pour une feuille de style d'ombre.
 *
 * ⛔ LES COMMENTAIRES SONT RETIRÉS AVANT DE CHERCHER LES `<style>`, ET C'EST CE QUI TRIE LES CLIENTS.
 * `<!--[if mso]>…<![endif]-->` est UN commentaire pour un navigateur : les règles réservées à Outlook
 * (`.mj-outlook-group-fix`) ne doivent pas s'appliquer à l'écran. `<!--[if !mso]><!-->`, lui, se
 * referme aussitôt : ce qu'il entoure est bien lu par un navigateur, et l'est ici aussi.
 *
 * ⚠️ `media="…"` d'une balise devient un `@media` englobant : une feuille construite n'a pas d'attribut.
 * ⚠️ `@import` est retiré : une feuille construite le refuse, et les polices web sont chargées dans le
 * document par le canvas (une `@font-face` déclarée dans une racine d'ombre est ignorée par Chrome).
 */
export function headCss(html: string): string {
  const corps = html.search(/<body\b/i);
  const tete = (corps === -1 ? html : html.slice(0, corps)).replace(/<!--[\s\S]*?-->/g, "");
  const out: string[] = [];
  for (const m of tete.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)) {
    const attrs = m[1] ?? "";
    const regles = (m[2] ?? "").replace(/@import\s[^;]*;/gi, "").trim();
    if (regles === "") continue;
    const media = /\bmedia\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    out.push(media ? `@media ${media} {\n${regles}\n}` : regles);
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Rendu
 * ------------------------------------------------------------------ */

interface Cible {
  n: number;
  id: string;
  row: Row;
  colIndex: number;
  block: Block;
}

/** La row synthétique d'un bloc : sa row d'origine, vidée de tout sauf lui (et ses deux marqueurs). */
function rowSynthetique(c: Cible): Row {
  const { row } = c;
  return {
    id: `nfc-r${c.n}`,
    layout: row.layout,
    ...(row.style ? { style: row.style } : {}),
    columns: row.columns.map((col, i) => ({
      id: `nfc-c${c.n}-${i}`,
      ...(col.style ? { style: col.style } : {}),
      blocks: i === c.colIndex ? [marqueur(c.n, "s"), sansCondition(c.block), marqueur(c.n, "e")] : [],
    })),
  };
}

/**
 * Compile chaque bloc du document — en-tête et pied de marque compris — et rend son fragment.
 *
 * `partials` : les rows déjà résolues par l'appelant (la base n'est pas lue ici). Absentes alors que le
 * document pointe sur un partial, l'avertissement de `applyBrandPartials` le dit.
 */
export async function renderCanvas(input: unknown, partials?: BrandPartials): Promise<CanvasRender> {
  const { doc, invalid } = elaguer(input);

  const warnings: string[] = [];
  let complet: EmailDoc = doc;
  try {
    const applique = applyBrandPartials(doc, partials);
    complet = applique.doc;
    warnings.push(...applique.warnings);
  } catch (err) {
    // Un partial inapplicable n'empêche pas d'éditer : l'éditeur montre le document sans lui, et dit
    // pourquoi. La publication, elle, refusera pour la même raison.
    warnings.push(err instanceof Error ? err.message : String(err));
  }

  // Les rows du document gardent leur identité à travers `applyBrandPartials` ; les autres sont
  // celles de la marque. Celles d'avant la première row du document sont l'en-tête.
  const propres = new Set<Row>(doc.rows);
  const premiere = complet.rows.findIndex((r) => propres.has(r));
  const header: Row[] = [];
  const footer: Row[] = [];
  complet.rows.forEach((r, i) => {
    if (propres.has(r)) return;
    if (premiere === -1 || i < premiere) header.push(r);
    else footer.push(r);
  });

  const cibles: Cible[] = [];
  for (const row of complet.rows) {
    row.columns.forEach((col, colIndex) => {
      for (const block of col.blocks) cibles.push({ n: cibles.length, id: block.id, row, colIndex, block });
    });
  }

  // ⛔ TOUT LE `meta` DU DOCUMENT, SAUF LES POINTEURS DE PARTIALS. Une liste blanche (slug, langue,
  // objet, preheader) laissait tomber ce que le compilateur lit AUSSI dans le corps : `defaultCtaLabel`
  // (le libellé de lecture choisi pour ce modèle) et `firstNameFallback` (le repli de `{{first_name}}`).
  // Le canvas montrait alors « Leer la nota » là où l'e-mail portait le libellé du modèle (relevé le
  // 23/09/2026). Les pointeurs, eux, sont retirés : leurs rows sont déjà posées dans `complet`.
  const { headerPartialId: _entete, footerPartialId: _pied, ...meta } = complet.meta;
  const blocks: Record<string, CanvasFragment> = {};
  const sheets: string[] = [];

  // Une row par bloc : au-delà du plafond du schéma, on compile en plusieurs passes. Chaque passe a sa
  // propre feuille — ses classes générées ne valent que pour elle.
  for (let depart = 0; depart < cibles.length; depart += MAX_DOC_ROWS) {
    const lot = cibles.slice(depart, depart + MAX_DOC_ROWS);
    const synthetique: EmailDocInput = {
      schema: 2,
      meta,
      theme: complet.theme,
      rows: lot.map(rowSynthetique),
    };
    const { html } = await compileDoc(synthetique);
    const sheet = sheets.length;
    sheets.push(headCss(html));
    for (const c of lot) {
      const a = html.indexOf(debut(c.n));
      const b = html.indexOf(fin(c.n), a);
      // Un marqueur introuvable serait une panne du montage, pas un bloc vide : on le dit.
      if (a === -1 || b === -1) throw new CanvasRenderError(`could not locate the rendering of block ${c.id}`);
      blocks[c.id] = { html: html.slice(a + debut(c.n).length, b), sheet };
    }
  }

  return { blocks, sheets, invalid, header, footer, warnings };
}
