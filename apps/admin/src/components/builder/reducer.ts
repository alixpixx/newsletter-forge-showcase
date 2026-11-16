/**
 * Réducteur du builder — le document EST l'état.
 *
 * Deux invariants tenus ici, et nulle part ailleurs :
 *  1. IMMUABILITÉ. Chaque action produit un NOUVEAU document ; aucune mutation en place. C'est ce
 *     qui rend l'historique (undo/redo) correct et l'autosave capable de diffusion par référence.
 *  2. Une action qui ne change RIEN (déplacement en butée, bloc introuvable, footer verrouillé)
 *     renvoie `null` et n'empile PAS de snapshot : sinon ⌘Z « ne ferait rien » plusieurs fois.
 */
import type { Block, BlockType, Column, EmailDoc, Meta, Row, RowLayout } from "@nf/render/schema";
// Import d'exécution sans coût neuf : `factories.ts` charge déjà ce module.
import { isImportedFooterRow } from "@nf/render/schema";
// ⚠️ Import de TYPE seulement : le réducteur ne doit rien exécuter du pré-vol (il tourne dans les
// bancs sans React ni MJML). C'est la FORME du contrat qu'on emprunte, pas son moteur.
import type { PreflightFix } from "@/lib/preflight";
import { cloneBlock, newBlock, newRow, newRowWith } from "./factories";
import { appliquerStyleFlux, type FeedPreset } from "./feed-presets";
import { utiliserPourTousLesTitres } from "./titres-globaux";

export const HISTORY_LIMIT = 50;

/**
 * Plafond de blocs par colonne — miroir de `Column.blocks` (`z.array(Block).max(100)`).
 * Un déplacement inter-colonnes laisse le total inchangé mais peut faire déborder la DESTINATION :
 * sans ce garde-fou, le glisser-déposer produirait un document que l'API refuserait au save.
 */
const MAX_BLOCKS_PER_COLUMN = 100;

/**
 * Plafond de lignes — miroir de `EmailDoc.rows` (`z.array(Row).max(200)`). Une ligne enregistrée
 * insérée ou un bloc déposé dans un interligne CRÉENT une ligne sans passer par « add row » :
 * sans ce garde-fou, le builder produirait un document que l'API refuserait au save.
 */
const MAX_ROWS = 200;

export interface BuilderState {
  past: EmailDoc[];
  present: EmailDoc;
  future: EmailDoc[];
  /**
   * Plafond de lignes de CE document, si plus bas que `MAX_ROWS` — un en-tête ou pied de marque en
   * a 20 (`MAX_BRAND_PARTIAL_ROWS`). Porté par l'état et non par la palette : une ligne se crée
   * aussi par un dépôt entre deux lignes ou une ligne enregistrée, et le serveur refuserait la 21e
   * au save, loin du geste.
   */
  maxRows?: number;
}

/** `Partial<Block>` se distribue sur l'union (mapped type homomorphe) → un patch par variante. */
export type BlockPatch = Partial<Block>;

/**
 * Les sous-objets d'un bloc flux qui portent chacun une apparence complète : la une, les brèves,
 * le titre de section entre les deux, le filet entre deux brèves.
 */
export const FEED_PARTS = ["lead", "card", "midSection", "cardRule"] as const;
export type FeedPart = (typeof FEED_PARTS)[number];

export type BuilderAction =
  | { type: "setDoc"; doc: EmailDoc; resetHistory?: boolean }
  | { type: "updateMeta"; patch: Partial<Meta> }
  | { type: "addRow"; layout: RowLayout; index?: number }
  | { type: "moveRow"; rowId: string; dir: -1 | 1 }
  | { type: "removeRow"; rowId: string }
  | { type: "updateRow"; rowId: string; patch: Partial<Omit<Row, "id" | "columns">> }
  | { type: "addBlock"; rowId: string; colId: string; blockType?: BlockType; block?: Block; index?: number }
  | { type: "updateBlock"; blockId: string; patch: BlockPatch }
  /**
   * Écriture DANS un sous-objet d'un bloc flux (`lead`, `card`, `midSection`, `cardRule`).
   *
   * ⛔ POURQUOI UNE ACTION À PART. `updateBlock` ne fusionne qu'au premier niveau : un champ qui
   * enverrait `{ lead: { titleFont } }` REMPLACERAIT la une entière, et avec elle le « Destacada »,
   * le style de lien et tout ce que la marque y a posé — sans rien signaler, le document restant
   * valide. La fusion se fait donc ICI, contre le document PRÉSENT : un sous-objet recalculé dans
   * le composant partirait d'un rendu potentiellement périmé.
   *
   * `patch` : une clé à `undefined` est RETIRÉE. `null` retire le sous-objet entier (« Remove
   * section », « Remove rule », « Reset look »).
   */
  | { type: "updateBlockPart"; blockId: string; part: FeedPart; patch: Record<string, unknown> | null }
  | { type: "moveBlock"; blockId: string; dir: -1 | 1 }
  /**
   * Réordonnancement par glissement. `toIndex` s'entend sur la liste PRIVÉE de l'élément déplacé
   * (convention `arrayMove` de @dnd-kit) : c'est ce que produit directement l'index de la ligne
   * survolée, et ça se comporte comme `moveRow` ±1 quand on ne bouge que d'un cran.
   */
  | { type: "reorderRow"; rowId: string; toIndex: number }
  /** Déplacement d'un bloc vers n'importe quelle colonne. Même convention d'index que `reorderRow`. */
  | { type: "moveBlockTo"; blockId: string; toRowId: string; toColId: string; toIndex: number }
  /**
   * Insertion d'une ligne DÉJÀ CONSTRUITE (ligne fabriquée pour accueillir un bloc déposé entre deux
   * lignes, réparation du pré-vol). `index` s'entend sur la liste affichée : 0 = avant la première
   * ligne, `rows.length` = après la dernière.
   *
   * ⚠️ La ligne doit porter des identifiants NEUFS. Une row de la bibliothèque de marque les obtient de
   * `GET /api/builder/brand-partials/[id]`, qui les régénère à chaque lecture ; le réducteur refuse
   * l'insertion en cas de collision plutôt que de corrompre le document en silence.
   */
  | { type: "insertRow"; row: Row; index?: number }
  /**
   * Insertion de PLUSIEURS lignes en UN SEUL geste — ce que produit l'import d'articles WordPress.
   *
   * ⚠️ POURQUOI PAS N × `insertRow`. Chaque action pousse une entrée d'historique : insérer cinq
   * articles demanderait cinq Ctrl+Z pour défaire ce que l'utilisateur a vécu comme un clic. Et si
   * la troisième était refusée (plafond de lignes, collision d'id), le document resterait à
   * moitié rempli sans que rien ne le dise. Ici c'est tout ou rien, et un seul pas d'historique.
   *
   * `index` omis = **avant le pied de page légal** s'il existe, à la fin sinon. Ajouter « à la
   * fin » d'un document qui se termine par son footer placerait les articles SOUS les mentions
   * légales — un défaut qu'on ne voit qu'à l'aperçu, une fois la composition finie.
   */
  | { type: "insertRows"; rows: Row[]; index?: number }
  /**
   * Sortie d'un bloc de sa colonne vers une NOUVELLE ligne pleine largeur, insérée à `index`
   * (même convention que `insertRow`). C'est ce que produit un dépôt dans l'interligne : sans lui,
   * on ne pourrait créer une ligne qu'au clic depuis la palette.
   */
  | { type: "moveBlockToNewRow"; blockId: string; index: number }
  | { type: "duplicateBlock"; blockId: string }
  | { type: "removeBlock"; blockId: string }
  /**
   * N actions en UN SEUL geste — ce que produit une réparation de lot du pré-vol.
   *
   * ⚠️ POURQUOI PAS N `dispatch`. Même raison que `insertRows` un cran plus haut, généralisée aux
   * verbes de réparation : chaque action pousse une entrée d'historique, donc réparer huit constats
   * répartis sur trois blocs demanderait trois Ctrl+Z pour défaire ce que l'utilisateur a vécu
   * comme UN clic.
   *
   * ⛔ TOUT OU RIEN. Si une seule sous-action ne change rien (bloc disparu entre le rendu et le
   * clic, footer devenu unique, plafond de lignes), le lot ENTIER est refusé et rien n'est empilé.
   * Appliquer « ce qui passe » laisserait un document à moitié réparé sous un bouton qui vient
   * d'annoncer un nombre — le compte affiché deviendrait faux au moment même où il est lu.
   *
   * ⚠️ `undo` / `redo` dans un lot tombent dans le `default` d'`applyAction` et renvoient `null`,
   * donc annulent le lot : ce sont des gestes d'HISTORIQUE, ils n'ont pas de sens ici.
   */
  | { type: "batch"; actions: BuilderAction[] }
  /**
   * « Use for all titles » (24/09/2026) : `theme.headingColor` = `color`, et la couleur propre de chaque
   * autre titre effacée, sauf sur fond coloré (`utiliserPourTousLesTitres`). Calculé contre le document
   * PRÉSENT, en une seule étape d'annulation.
   */
  | { type: "useForAllTitles"; color: string }
  /** Style prêt d'un flux (Classic / Compact / Hero, 24/09/2026) : voir `appliquerStyleFlux`. */
  | { type: "applyFeedPreset"; blockId: string; preset: FeedPreset }
  | { type: "undo" }
  | { type: "redo" };

/**
 * Traduction du contrat `PreflightFix` en actions du réducteur.
 *
 * ⛔ L'ORDRE N'EST PAS DÉCORATIF (il est aussi écrit dans `PreflightFix`) : insérer avant de
 * supprimer décalerait l'index d'insertion, et supprimer les lignes avant les blocs ferait
 * disparaître des ids que l'étape de suppression cherche encore.
 *
 * ⚠️ Cette fonction vit ICI et pas dans le composant : elle décide de ce qui est écrit dans le
 * DOCUMENT, donc elle doit pouvoir être mesurée hors navigateur. Un `patch` vide n'engendre AUCUNE
 * action — `updateBlock` avec `{}` reconstruirait le bloc à l'identique et gonflerait le lot d'une
 * étape qui ne répare rien (les réparations purement structurelles arrivent avec `patch: {}`).
 */
export function actionsForFix(fix: PreflightFix): BuilderAction[] {
  const actions: BuilderAction[] = [];
  if (Object.keys(fix.patch).length > 0) {
    actions.push({ type: "updateBlock", blockId: fix.blockId, patch: fix.patch });
  }
  for (const blockId of fix.removeBlockIds ?? []) actions.push({ type: "removeBlock", blockId });
  for (const rowId of fix.removeRowIds ?? []) actions.push({ type: "removeRow", rowId });
  if (fix.insertRow) actions.push({ type: "insertRow", row: fix.insertRow.row, index: fix.insertRow.index });
  return actions;
}

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

export interface BlockLocation {
  rowIndex: number;
  colIndex: number;
  blockIndex: number;
  block: Block;
}

export function findBlock(doc: EmailDoc, blockId: string): BlockLocation | null {
  for (let ri = 0; ri < doc.rows.length; ri++) {
    const row = doc.rows[ri];
    for (let ci = 0; ci < row.columns.length; ci++) {
      const col = row.columns[ci];
      for (let bi = 0; bi < col.blocks.length; bi++) {
        if (col.blocks[bi].id === blockId) {
          return { rowIndex: ri, colIndex: ci, blockIndex: bi, block: col.blocks[bi] };
        }
      }
    }
  }
  return null;
}

export function findRow(doc: EmailDoc, rowId: string): { index: number; row: Row } | null {
  const index = doc.rows.findIndex((r) => r.id === rowId);
  return index === -1 ? null : { index, row: doc.rows[index] };
}

/** Le footer légal est verrouillé (D10) : ni suppression, ni duplication, ni suppression de sa ligne. */
export function rowHasLockedBlock(row: Row): boolean {
  return row.columns.some((c) => c.blocks.some((b) => b.type === "footer_legal"));
}

/** Combien de footers légaux porte une ligne — un document en dérive n'en a pas forcément zéro ou un. */
function footersInRow(row: Row): number {
  return row.columns.reduce((n, c) => n + c.blocks.filter((b) => b.type === "footer_legal").length, 0);
}

/**
 * Footers légaux du document entier.
 *
 * ⛔ L'invariant D10 est « le document garde EXACTEMENT un footer », pas « aucun bloc footer ne se
 * supprime ». Écrit sous la seconde forme, il rendait un document à deux footers irréparable par
 * TOUT chemin de l'interface : le pré-vol affichait « keep exactly one, as the last block » et le
 * réducteur refusait la seule action qui l'aurait obtenu. Compté ici, le verrou dit la vraie règle.
 */
function legalFooterCount(doc: EmailDoc): number {
  return doc.rows.reduce((n, row) => n + footersInRow(row), 0);
}

/**
 * Coupe une ligne légale « 1 » en deux : le contenu qui PRÉCÈDE le footer légal, puis le footer seul.
 *
 * ⛔ POURQUOI. Un template neuf (`initialDoc`) pose le texte d'accueil et le footer légal dans la
 * MÊME colonne, et la palette, sans sélection, ajoute dans la dernière colonne : tout le corps de
 * l'e-mail s'y empile. Insérer « avant la ligne légale » posait alors un footer importé AU-DESSUS du
 * corps (vu dans le navigateur le 16/09 ; 6 brouillons actifs sur 13 avaient cette forme).
 *
 * Le contenu garde les identifiants de la ligne et de la colonne : une sélection posée dessus y
 * reste. La ligne légale en reçoit de neufs, avec le même habillage ; le bloc légal garde le sien.
 * Une ligne à plusieurs colonnes n'a pas de coupe évidente : elle reste entière (`null`).
 */
function scinderLigneLegale(row: Row, taken: Set<string>): [Row | null, Row] {
  if (row.layout !== "1" || row.columns.length !== 1) return [null, row];
  const col = row.columns[0];
  const at = col.blocks.findIndex((b) => b.type === "footer_legal");
  if (at <= 0) return [null, row];
  let ids = newRow("1");
  while (taken.has(ids.id) || taken.has(ids.columns[0].id)) ids = newRow("1");
  return [
    { ...row, columns: [{ ...col, blocks: col.blocks.slice(0, at) }] },
    { ...row, id: ids.id, columns: [{ ...col, id: ids.columns[0].id, blocks: col.blocks.slice(at) }] },
  ];
}

/**
 * Index de la première row du PIED de l'e-mail : le premier footer importé de la bibliothèque qui
 * précède la ligne légale, sinon la ligne légale. `-1` sans ligne légale (un en-tête ou un pied de
 * marque en cours d'édition n'en a jamais : le préfixe `ftr_` de ses propres rows n'y veut rien dire).
 */
export function debutDuPied(doc: EmailDoc): number {
  const legale = doc.rows.findIndex(rowHasLockedBlock);
  if (legale === -1) return -1;
  const importe = doc.rows.findIndex((r, i) => i < legale && isImportedFooterRow(r));
  return importe === -1 ? legale : importe;
}

/** Colonne d'insertion, et position dans cette colonne quand la fin ne convient pas. */
export interface CibleInsertion {
  rowId: string;
  colId: string;
  index?: number;
}

/**
 * Où un clic de la palette pose un bloc.
 *
 * ⛔ RÈGLE : UN CLIC NE POSE JAMAIS UN BLOC SOUS LE PIED LÉGAL. Ajouter « à la fin de la colonne »
 * le faisait dès que la colonne ciblée portait le bloc légal — sur un modèle neuf, le corps et le
 * légal partagent la même colonne — et le pré-vol criait ensuite « le pied légal n'est pas le
 * dernier bloc ». Et sans sélection, la cible était la dernière row : après un import de footer,
 * c'est la row légale, donc sous le footer importé (vu au navigateur le 16/09).
 *
 *  1. Sélection valide : cette colonne ; au-dessus du bloc légal si elle le porte.
 *  2. Sans pied (en-tête/pied de marque, document sans légal) : fin de la dernière colonne.
 *  3. Pied = ligne légale dont le bloc légal a du contenu au-dessus : juste au-dessus du bloc.
 *  4. Une row précède le pied : fin de sa dernière colonne — le bas du corps.
 *  5. Le pied ouvre le document : en tête de sa première colonne (au-dessus du légal s'il y est).
 */
export function resoudreCible(doc: EmailDoc, active: { rowId: string; colId: string } | null): CibleInsertion | null {
  const auDessusDuLegal = (rowId: string, col: Column): CibleInsertion => {
    const at = col.blocks.findIndex((b) => b.type === "footer_legal");
    return at === -1 ? { rowId, colId: col.id } : { rowId, colId: col.id, index: at };
  };

  if (active) {
    const col = doc.rows.find((r) => r.id === active.rowId)?.columns.find((c) => c.id === active.colId);
    if (col) return auDessusDuLegal(active.rowId, col);
  }

  const pied = debutDuPied(doc);
  if (pied === -1) {
    const lastRow = doc.rows[doc.rows.length - 1];
    const lastCol = lastRow?.columns[lastRow.columns.length - 1];
    return lastRow && lastCol ? { rowId: lastRow.id, colId: lastCol.id } : null;
  }

  const row = doc.rows[pied];
  const colLegale = row.columns.find((c) => c.blocks.findIndex((b) => b.type === "footer_legal") > 0);
  if (colLegale) return auDessusDuLegal(row.id, colLegale);

  if (pied > 0) {
    const prev = doc.rows[pied - 1];
    const col = prev.columns[prev.columns.length - 1];
    if (col) return auDessusDuLegal(prev.id, col);
  }

  const premiere = row.columns[0];
  if (!premiere) return null;
  const at = premiere.blocks.findIndex((b) => b.type === "footer_legal");
  return { rowId: row.id, colId: premiere.id, index: at === -1 ? 0 : at };
}

/** Tous les identifiants d'une ligne (elle-même, ses colonnes, ses blocs). */
function idsOfRow(row: Row): string[] {
  const ids = [row.id];
  for (const column of row.columns) {
    ids.push(column.id);
    for (const block of column.blocks) ids.push(block.id);
  }
  return ids;
}

/** Idem pour le document entier — sert à refuser une insertion qui dupliquerait un id. */
function idsOfDoc(doc: EmailDoc): Set<string> {
  const ids = new Set<string>();
  for (const row of doc.rows) for (const id of idsOfRow(row)) ids.add(id);
  return ids;
}

/* ------------------------------------------------------------------ *
 * Écriture immuable
 * ------------------------------------------------------------------ */

/** Réécrit la liste de blocs d'une colonne donnée en clonant uniquement le chemin touché. */
function withBlocks(
  doc: EmailDoc,
  rowIndex: number,
  colIndex: number,
  next: (blocks: Block[]) => Block[],
): EmailDoc {
  const rows = doc.rows.map((row, ri) => {
    if (ri !== rowIndex) return row;
    return {
      ...row,
      columns: row.columns.map((col, ci) => (ci === colIndex ? { ...col, blocks: next([...col.blocks]) } : col)),
    };
  });
  return { ...doc, rows };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** Applique l'action au document. `null` = aucun changement (rien à empiler dans l'historique). */
function applyAction(doc: EmailDoc, action: BuilderAction, maxRows: number): EmailDoc | null {
  switch (action.type) {
    case "setDoc":
      return action.doc;

    case "updateMeta":
      return { ...doc, meta: { ...doc.meta, ...action.patch } };

    case "addRow": {
      if (doc.rows.length >= maxRows) return null;
      const rows = [...doc.rows];
      rows.splice(clamp(action.index ?? rows.length, 0, rows.length), 0, newRow(action.layout));
      return { ...doc, rows };
    }

    case "moveRow": {
      const found = findRow(doc, action.rowId);
      if (!found) return null;
      const target = found.index + action.dir;
      if (target < 0 || target >= doc.rows.length) return null;
      const rows = [...doc.rows];
      const [moved] = rows.splice(found.index, 1);
      rows.splice(target, 0, moved);
      return { ...doc, rows };
    }

    case "removeRow": {
      const found = findRow(doc, action.rowId);
      if (!found) return null;
      // Supprimer la ligne du DERNIER footer légal reviendrait à supprimer le footer → refusé.
      // Une ligne qui ne porte qu'un DOUBLON s'en va : le document en garde un, l'invariant tient.
      if (rowHasLockedBlock(found.row) && legalFooterCount(doc) - footersInRow(found.row) < 1) return null;
      return { ...doc, rows: doc.rows.filter((r) => r.id !== action.rowId) };
    }

    case "updateRow": {
      const found = findRow(doc, action.rowId);
      if (!found) return null;
      return {
        ...doc,
        rows: doc.rows.map((r) => (r.id === action.rowId ? { ...r, ...action.patch } : r)),
      };
    }

    case "addBlock": {
      const rowIndex = doc.rows.findIndex((r) => r.id === action.rowId);
      if (rowIndex === -1) return null;
      const colIndex = doc.rows[rowIndex].columns.findIndex((c) => c.id === action.colId);
      if (colIndex === -1) return null;
      // La langue ne descend PLUS jusqu'à la fabrique : aucun chemin de création n'écrit de
      // libellé de CTA, le rendu le pose seul. Le libellé ne peut donc plus dépendre du geste.
      const block = action.block ?? (action.blockType ? newBlock(action.blockType) : null);
      if (!block) return null;
      return withBlocks(doc, rowIndex, colIndex, (blocks) => {
        blocks.splice(clamp(action.index ?? blocks.length, 0, blocks.length), 0, block);
        return blocks;
      });
    }

    case "updateBlock": {
      const loc = findBlock(doc, action.blockId);
      if (!loc) return null;
      return withBlocks(doc, loc.rowIndex, loc.colIndex, (blocks) => {
        // `type` et `id` ne sont jamais patchés : le patch vient toujours d'un champ de l'inspecteur
        // déjà typé pour la variante courante.
        blocks[loc.blockIndex] = { ...loc.block, ...action.patch } as Block;
        return blocks;
      });
    }

    case "updateBlockPart": {
      const loc = findBlock(doc, action.blockId);
      if (!loc || loc.block.type !== "article-feed") return null;
      const current = loc.block[action.part] as Record<string, unknown> | undefined;
      let nextPart: Record<string, unknown> | undefined;
      if (action.patch === null) {
        nextPart = undefined;
      } else {
        // Fusion en PROFONDEUR d'un cran : c'est tout l'objet de cette action (cf. son type).
        const merged: Record<string, unknown> = { ...(current ?? {}) };
        for (const [key, value] of Object.entries(action.patch)) {
          if (value === undefined) delete merged[key];
          else merged[key] = value;
        }
        // Une une ou des brèves SANS aucune clé rendent exactement comme l'absence (`toArticle` :
        // `look ?? {}`) : on retire l'objet vide plutôt que de laisser un `{}` qui ne dit rien.
        // ⛔ PAS pour `cardRule` : `{}` y veut dire « un filet, aux valeurs par défaut », et
        // l'absence « pas de filet du tout ». Les confondre effacerait le filet au dernier Reset.
        const vide = Object.keys(merged).length === 0;
        nextPart = vide && (action.part === "lead" || action.part === "card") ? undefined : merged;
      }
      // Retirer ce qui n'existe pas ne change rien : rien à empiler dans l'historique.
      if (nextPart === undefined && current === undefined) return null;
      const next: Record<string, unknown> = { ...loc.block };
      if (nextPart === undefined) delete next[action.part];
      else next[action.part] = nextPart;
      return withBlocks(doc, loc.rowIndex, loc.colIndex, (blocks) => {
        blocks[loc.blockIndex] = next as Block;
        return blocks;
      });
    }

    case "moveBlock": {
      const loc = findBlock(doc, action.blockId);
      if (!loc) return null;
      const column = doc.rows[loc.rowIndex].columns[loc.colIndex];
      const target = loc.blockIndex + action.dir;
      // Déplacement INTRA-colonne uniquement (pas de DnD cette vague) : en butée, on ne fait rien.
      if (target < 0 || target >= column.blocks.length) return null;
      return withBlocks(doc, loc.rowIndex, loc.colIndex, (blocks) => {
        const [moved] = blocks.splice(loc.blockIndex, 1);
        blocks.splice(target, 0, moved);
        return blocks;
      });
    }

    case "reorderRow": {
      const found = findRow(doc, action.rowId);
      if (!found) return null;
      const target = clamp(action.toIndex, 0, doc.rows.length - 1);
      if (target === found.index) return null;
      const rows = [...doc.rows];
      const [moved] = rows.splice(found.index, 1);
      rows.splice(target, 0, moved);
      return { ...doc, rows };
    }

    case "moveBlockTo": {
      const loc = findBlock(doc, action.blockId);
      if (!loc) return null;
      const toRowIndex = doc.rows.findIndex((r) => r.id === action.toRowId);
      if (toRowIndex === -1) return null;
      const toColIndex = doc.rows[toRowIndex].columns.findIndex((c) => c.id === action.toColId);
      if (toColIndex === -1) return null;

      const sameColumn = toRowIndex === loc.rowIndex && toColIndex === loc.colIndex;
      // Longueur de la destination une fois le bloc retiré — le référentiel de `toIndex`.
      const destLength = doc.rows[toRowIndex].columns[toColIndex].blocks.length - (sameColumn ? 1 : 0);
      if (!sameColumn && destLength >= MAX_BLOCKS_PER_COLUMN) return null;

      const target = clamp(action.toIndex, 0, destLength);
      if (sameColumn && target === loc.blockIndex) return null;

      const moved = loc.block;
      const rows = doc.rows.map((row, ri) => {
        if (ri !== loc.rowIndex && ri !== toRowIndex) return row;
        return {
          ...row,
          columns: row.columns.map((col, ci) => {
            const isSource = ri === loc.rowIndex && ci === loc.colIndex;
            const isDest = ri === toRowIndex && ci === toColIndex;
            if (!isSource && !isDest) return col;
            const blocks = isSource ? col.blocks.filter((b) => b.id !== action.blockId) : [...col.blocks];
            if (isDest) blocks.splice(target, 0, moved);
            return { ...col, blocks };
          }),
        };
      });
      return { ...doc, rows };
    }

    case "insertRow": {
      if (doc.rows.length >= maxRows) return null;
      // Le pied de page légal est unique par document. L'API refuse déjà d'en enregistrer un en
      // bibliothèque ; cette barrière couvre tout autre appelant de l'action.
      if (rowHasLockedBlock(action.row) && doc.rows.some(rowHasLockedBlock)) return null;
      // Réinjecter un id déjà présent ne casserait rien tout de suite : le symptôme (bloc édité au
      // mauvais endroit, bloc qui disparaît au save) apparaîtrait très loin de la cause.
      const taken = idsOfDoc(doc);
      if (idsOfRow(action.row).some((id) => taken.has(id))) return null;

      const rows = [...doc.rows];
      rows.splice(clamp(action.index ?? rows.length, 0, rows.length), 0, action.row);
      return { ...doc, rows };
    }

    case "insertRows": {
      if (action.rows.length === 0) return null;
      if (doc.rows.length + action.rows.length > maxRows) return null;

      // Le pied de page est unique : ni le lot ni le document n'ont le droit d'en apporter un second.
      const lockedInBatch = action.rows.filter(rowHasLockedBlock).length;
      if (lockedInBatch > 1) return null;
      if (lockedInBatch === 1 && doc.rows.some(rowHasLockedBlock)) return null;

      // Collision d'id : avec le document, ET entre les lignes du lot. La seconde vérification
      // n'est pas théorique — `newId` mélange l'horodatage à la milliseconde et quatre caractères
      // aléatoires, et cinq lignes fabriquées dans la même boucle partagent cette milliseconde.
      const taken = idsOfDoc(doc);
      for (const row of action.rows) {
        for (const id of idsOfRow(row)) {
          if (taken.has(id)) return null;
          taken.add(id);
        }
      }

      const rows = [...doc.rows];
      // Défaut : juste avant le PIED — le footer importé s'il y en a un, sinon la ligne légale. C'est
      // la seule position qui donne le même résultat sur un document déjà terminé et sur un document
      // encore vide ; des articles WordPress ne se glissent pas entre un footer et le légal.
      // Un footer importé ne porte pas le légal : `scinderLigneLegale` le laisse entier, et le lot passe
      // devant lui.
      const footerAt = debutDuPied(doc);
      if (action.index === undefined && footerAt !== -1) {
        const [contenu, legale] = scinderLigneLegale(rows[footerAt], taken);
        // Couper coûte une ligne : au plafond, on insère avant la ligne entière plutôt que refuser.
        const coupe = contenu !== null && rows.length + action.rows.length + 1 <= maxRows;
        rows.splice(footerAt, 1, ...(coupe ? [contenu, ...action.rows, legale] : [...action.rows, rows[footerAt]]));
        return { ...doc, rows };
      }
      rows.splice(clamp(action.index ?? rows.length, 0, rows.length), 0, ...action.rows);
      return { ...doc, rows };
    }

    case "moveBlockToNewRow": {
      const loc = findBlock(doc, action.blockId);
      // Le footer légal ne change ni de colonne ni de ligne : l'UI ne le rend pas glissable, et le
      // réducteur reste seul juge (une ligne légale ailleurs qu'à la fin est une anomalie D10).
      if (!loc || loc.block.type === "footer_legal") return null;
      if (doc.rows.length >= maxRows) return null;

      const source = doc.rows[loc.rowIndex];
      // Sortir le SEUL bloc d'une ligne « 1 » pour le reposer juste au-dessus ou au-dessous ne
      // produirait qu'une ligne vide suivie de son sosie : rien à empiler dans l'historique.
      const alone =
        source.layout === "1" && source.columns.length === 1 && source.columns[0].blocks.length === 1;
      if (alone && (action.index === loc.rowIndex || action.index === loc.rowIndex + 1)) return null;

      const created = newRowWith(loc.block);
      const rows = doc.rows.map((row, ri) => {
        if (ri !== loc.rowIndex) return row;
        return {
          ...row,
          columns: row.columns.map((col, ci) =>
            ci === loc.colIndex ? { ...col, blocks: col.blocks.filter((b) => b.id !== action.blockId) } : col,
          ),
        };
      });
      // Retirer un bloc ne retire aucune ligne : `index` garde exactement le sens qu'il avait à
      // l'écran au moment du dépôt.
      rows.splice(clamp(action.index, 0, rows.length), 0, created);
      return { ...doc, rows };
    }

    case "duplicateBlock": {
      const loc = findBlock(doc, action.blockId);
      if (!loc || loc.block.type === "footer_legal") return null;
      return withBlocks(doc, loc.rowIndex, loc.colIndex, (blocks) => {
        blocks.splice(loc.blockIndex + 1, 0, cloneBlock(loc.block));
        return blocks;
      });
    }

    case "removeBlock": {
      const loc = findBlock(doc, action.blockId);
      if (!loc) return null;
      // ⛔ Un footer légal ne part QUE si le document en garde un autre. Ce n'est pas un
      // assouplissement du verrou D10 : c'est sa formulation exacte (cf. `legalFooterCount`). Le
      // bloc ne porte aucune propriété éditable, donc deux exemplaires sont interchangeables et en
      // retirer un ne détruit aucun contenu ; retirer le dernier reste impossible.
      if (loc.block.type === "footer_legal" && legalFooterCount(doc) < 2) return null;
      return withBlocks(doc, loc.rowIndex, loc.colIndex, (blocks) =>
        blocks.filter((b) => b.id !== action.blockId),
      );
    }

    case "useForAllTitles": {
      const r = utiliserPourTousLesTitres(doc, action.color);
      // Invariant 2 : un second clic (rien à effacer, couleur déjà posée) n'empile rien.
      return r.effaces === 0 && doc.theme.headingColor === action.color ? null : r.doc;
    }

    case "applyFeedPreset": {
      const loc = findBlock(doc, action.blockId);
      if (!loc || loc.block.type !== "article-feed") return null;
      const next = appliquerStyleFlux(loc.block, action.preset);
      // Le style est déjà celui du bloc : rien à empiler (c'est aussi ce qui le dit « actif »).
      if (JSON.stringify(next) === JSON.stringify(loc.block)) return null;
      return withBlocks(doc, loc.rowIndex, loc.colIndex, (blocks) => {
        blocks[loc.blockIndex] = next;
        return blocks;
      });
    }

    case "batch": {
      if (action.actions.length === 0) return null;
      let next = doc;
      for (const sub of action.actions) {
        const step = applyAction(next, sub, maxRows);
        // Tout ou rien : voir le commentaire du type d'action. On sort SANS rien avoir écrit.
        if (step === null) return null;
        next = step;
      }
      // Un lot dont chaque étape a rendu le document inchangé n'empile rien.
      return next === doc ? null : next;
    }

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Historique
 * ------------------------------------------------------------------ */

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  if (action.type === "undo") {
    if (state.past.length === 0) return state;
    const previous = state.past[state.past.length - 1];
    return {
      ...state,
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
    };
  }

  if (action.type === "redo") {
    if (state.future.length === 0) return state;
    const [next, ...rest] = state.future;
    return {
      ...state,
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: next,
      future: rest,
    };
  }

  // ⚠️ Chaque retour recopie `state` : un état reconstruit à la main perdrait `maxRows`, et le
  // plafond d'un en-tête remonterait à 200 dès la première action.
  const next = applyAction(state.present, action, Math.min(MAX_ROWS, state.maxRows ?? MAX_ROWS));
  if (next === null || next === state.present) return state;

  // `setDoc` + resetHistory : rechargement après conflit/restore → l'historique d'avant n'a plus de sens.
  if (action.type === "setDoc" && action.resetHistory) {
    return { ...state, past: [], present: next, future: [] };
  }

  return {
    ...state,
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
  };
}

export function initBuilderState(doc: EmailDoc, maxRows?: number): BuilderState {
  return { past: [], present: doc, future: [], ...(maxRows === undefined ? {} : { maxRows }) };
}
