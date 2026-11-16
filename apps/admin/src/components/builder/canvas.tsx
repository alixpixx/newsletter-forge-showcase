"use client";

/**
 * CANVAS — le HTML QUE LE COMPILATEUR ÉMET, bloc par bloc, avec l'édition posée par-dessus.
 *
 * ⛔ PLUS AUCUN BLOC N'EST DESSINÉ ICI. Jusqu'au 22/09/2026 chaque bloc avait son JSX, recopie à la
 * main de ce que fait `compileDoc` — et la recopie mentait : fond du bouton peint sur le bouton quand
 * l'e-mail le peint autour, rayon d'image codé à 4 px, taille et graisse du texte ignorées, filet
 * multicolore absent, pictos sociaux remplacés par des pastilles, menu souligné quand l'e-mail ne
 * l'est pas, pied légal et en-têtes de marque absents (inventaire « Canvas ≠ email »). Désormais le
 * contenu d'un bloc EST le fragment compilé (`lib/canvas-render.ts`, via `POST /api/builder/canvas-render`),
 * isolé dans une racine d'ombre. Une prop que le compilateur apprend apparaît ici sans une ligne de plus.
 *
 * CE QUE LE CANVAS DESSINE ENCORE LUI-MÊME, et pourquoi c'est sans risque d'écart :
 *  - les CADRES de row et de colonne (padding, fond, bordure, alignement) : ils portent la sélection
 *    et le glisser-déposer. Leurs valeurs viennent de `compiled-fragment.ts`, dont le banc exige
 *    chaque valeur DANS le HTML compilé ;
 *  - le bloc texte PENDANT la frappe : un `contentEditable` stylé avec les valeurs du compilateur
 *    (`textEditStyle`, même banc) ; le fragment compilé revient dès que l'édition se ferme ;
 *  - le CHROME (barres d'outils, repères « à remplir », bandeau de flux, badges) : posé par-dessus,
 *    jamais à l'intérieur du rendu, et il ne part jamais dans un e-mail.
 *
 * GLISSER-DÉPOSER — deux mécaniques, et c'est volontaire :
 *  1. À l'INTÉRIEUR du canvas (réordonner une ligne, déplacer un bloc d'une colonne à l'autre) :
 *     @dnd-kit, capteur clavier compris. Le `DndContext` vit ici parce que c'est le plus petit
 *     ancêtre commun des lignes et des blocs.
 *  2. Depuis la PALETTE : glisser-déposer HTML natif (`dataTransfer`). @dnd-kit ne fait pas
 *     traverser un draggable d'un `DndContext` à un autre, et la palette est un frère du canvas
 *     dans `shell.tsx` — un contexte commun aurait exigé de modifier un fichier qui ne nous
 *     appartient pas. Le natif traverse n'importe quelle frontière React sans rien partager.
 *
 * Le glissement N'EST PAS la voie accessible : les boutons ↑ / ↓ et l'ajout au clic depuis la
 * palette restent la voie clavier de premier choix, le capteur clavier de @dnd-kit n'étant qu'un
 * secours. C'est aussi pour ça que le réducteur reste seul juge de la validité d'un dépôt.
 */
import { Fragment, createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type Active,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Over,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, type SortingStrategy } from "@dnd-kit/sortable";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bookmark,
  Copy,
  Eye,
  GripVertical,
  Loader2,
  Lock,
  Plus,
  Rss,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  BLOCK_TYPES,
  LAYOUT_WEIGHTS,
  type Block,
  type BlockType,
  type Column,
  type EmailDoc,
  type Row,
  type Theme,
  type VisibleIf,
} from "@nf/render/schema";
// ⛔ `feedCards` est LA définition de « ce qu'un flux affiche », celle qu'emprunte l'envoi : elle ne
// sert plus ici qu'à savoir s'il y a quelque chose à montrer — les cartes elles-mêmes sont compilées.
import { describeFeed, feedCards } from "@nf/render/feed";
import { usesAiTokens } from "@nf/render/hydrate";
import { Btn } from "@/components/ui";
import { cn } from "@/lib/utils";
import { BLOCK_LABELS, newBlock, newRowWith } from "./factories";
import { Modal } from "./modal";
import { InlineRichText } from "./rich-text";
import { SourceRibbon } from "./source-ribbon";
import { rowHasLockedBlock, type BuilderAction } from "./reducer";
import { corpsSaveThisRow } from "./library-insert";
import {
  RawHtmlFrame,
  ShadowHtml,
  editionLabel,
  useCanvasRender,
  useCompiledSheets,
  useLegalFooter,
  useWebFonts,
  type CanvasRenderState,
  type CompiledSheet,
  type LegalFooterState,
} from "./compiled-block";
import {
  columnFrameStyle,
  fragmentKeys,
  hasLegalFooter,
  hintsFor,
  rowFrameStyle,
  textEditStyle,
  withLegalFooter,
} from "./compiled-fragment";

export type Selection = { kind: "block"; id: string } | { kind: "row"; id: string } | null;
export interface ActiveColumn {
  rowId: string;
  colId: string;
}

/**
 * Type MIME du glissement palette → canvas. Payload = un `BlockType` brut, revalidé à l'arrivée :
 * `dataTransfer` est un canal ouvert, n'importe quelle page peut y écrire n'importe quoi.
 */
export const BLOCK_DRAG_MIME = "application/x-nf-block-type";

/**
 * La barre d'outils d'une ligne (canvas) enregistre, la palette affiche la bibliothèque : deux
 * frères qui ne se connaissent pas et dont le parent, `shell.tsx`, n'appartient à personne ici.
 * Un événement de fenêtre est le plus petit lien possible entre eux — la palette se recharge, elle
 * ne partage aucun état.
 */
export const SAVED_BLOCKS_EVENT = "nf:saved-blocks-changed";

/* ------------------------------------------------------------------ *
 * Glisser-déposer — types et calcul de la cible
 * ------------------------------------------------------------------ */

/** Identifiant droppable d'une colonne — préfixé pour ne jamais entrer en collision avec un bloc. */
const colDropId = (colId: string): string => `col:${colId}`;

type DragData =
  | { kind: "row"; rowId: string; index: number; label: string }
  | { kind: "block"; rowId: string; colId: string; colDropId: string; index: number; label: string }
  | { kind: "column"; rowId: string; colId: string }
  /** Interligne. `index` = position d'insertion de la ligne à créer (0 = avant la première). */
  | { kind: "gap"; index: number };

/**
 * Cible de dépôt. Deux index, et ce n'est pas de la redondance :
 *  • `toIndex` part vers le réducteur — il s'entend sur la liste PRIVÉE de l'élément déplacé
 *    (convention `arrayMove`) ;
 *  • `lineIndex` positionne le trait à l'écran — il s'entend sur la liste TELLE QU'AFFICHÉE.
 * Les deux diffèrent d'exactement 1 quand on descend un élément dans sa propre liste.
 */
type DropTarget =
  | { kind: "row"; toIndex: number; lineIndex: number }
  | { kind: "block"; rowId: string; colId: string; toIndex: number; lineIndex: number }
  /** Dépôt dans un interligne : le bloc sort de sa colonne et une ligne « 1 » naît à `index`. */
  | { kind: "newRow"; index: number };

/**
 * Cible d'un dépôt palette : rien n'est retiré du document, l'index d'insertion EST l'index affiché.
 * Deux formes — dans une colonne existante, ou dans un INTERLIGNE (qui fera naître une ligne « 1 »).
 */
type PaletteTarget =
  | { kind: "column"; rowId: string; colId: string; index: number }
  | { kind: "gap"; index: number };

interface DragInfo {
  kind: "row" | "block";
  label: string;
}

/** Le rectangle traîné a-t-il dépassé le milieu de la cible ? */
function pastMidpoint(active: ClientRect | null, over: ClientRect): boolean {
  if (!active) return false;
  return active.top + active.height / 2 > over.top + over.height / 2;
}

function blockCount(doc: EmailDoc, rowId: string, colId: string): number {
  const row = doc.rows.find((r) => r.id === rowId);
  return row?.columns.find((c) => c.id === colId)?.blocks.length ?? 0;
}

function computeDrop(doc: EmailDoc, active: Active, over: Over | null, activeRect: ClientRect | null): DropTarget | null {
  if (!over) return null;
  const a = active.data.current as DragData | undefined;
  const o = over.data.current as DragData | undefined;
  if (!a || !o) return null;

  if (a.kind === "row") {
    if (o.kind !== "row" || a.index === o.index) return null;
    // Descendre = le trait passe SOUS la ligne survolée ; monter = au-dessus.
    return { kind: "row", toIndex: o.index, lineIndex: a.index < o.index ? o.index + 1 : o.index };
  }

  if (a.kind !== "block") return null;

  // Interligne → une nouvelle ligne « 1 » naîtra là, avec le bloc dedans.
  if (o.kind === "gap") {
    const srcIndex = doc.rows.findIndex((r) => r.id === a.rowId);
    const src = srcIndex === -1 ? null : doc.rows[srcIndex];
    // Même refus que le réducteur, recopié ici pour que le trait n'apparaisse PAS là où le dépôt
    // ne changerait rien : sortir le seul bloc d'une ligne « 1 » juste au-dessus ou au-dessous
    // d'elle-même ne produirait qu'une ligne vide suivie de son sosie.
    const alone = src !== null && src.layout === "1" && src.columns.length === 1 && src.columns[0].blocks.length === 1;
    if (alone && (o.index === srcIndex || o.index === srcIndex + 1)) return null;
    return { kind: "newRow", index: o.index };
  }

  // Dépôt sur la colonne elle-même (colonne vide, ou zone sous le dernier bloc) → en fin de colonne.
  if (o.kind === "column") {
    const count = blockCount(doc, o.rowId, o.colId);
    const sameColumn = a.rowId === o.rowId && a.colId === o.colId;
    const toIndex = sameColumn ? count - 1 : count;
    if (sameColumn && a.index === toIndex) return null;
    return { kind: "block", rowId: o.rowId, colId: o.colId, toIndex, lineIndex: count };
  }

  if (o.kind === "block") {
    const sameColumn = a.rowId === o.rowId && a.colId === o.colId;
    if (sameColumn) {
      if (a.index === o.index) return null;
      return {
        kind: "block",
        rowId: o.rowId,
        colId: o.colId,
        toIndex: o.index,
        lineIndex: a.index < o.index ? o.index + 1 : o.index,
      };
    }
    // Autre colonne : la liste de destination ne contient pas le bloc, les deux index coïncident.
    const index = o.index + (pastMidpoint(activeRect, over.rect) ? 1 : 0);
    return { kind: "block", rowId: o.rowId, colId: o.colId, toIndex: index, lineIndex: index };
  }

  return null;
}

/**
 * `onDragMove` et `dragover` se déclenchent à chaque pixel. Sans cette comparaison, chacun
 * remplacerait l'état par un objet neuf ~60 fois par seconde et re-rendrait tout le document
 * alors que la cible n'a pas bougé d'un cran.
 */
function sameDrop(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind === "row" && b.kind === "row") return a.toIndex === b.toIndex && a.lineIndex === b.lineIndex;
  if (a.kind === "block" && b.kind === "block") {
    return a.rowId === b.rowId && a.colId === b.colId && a.toIndex === b.toIndex && a.lineIndex === b.lineIndex;
  }
  if (a.kind === "newRow" && b.kind === "newRow") return a.index === b.index;
  return false;
}

function samePaletteTarget(a: PaletteTarget | null, b: PaletteTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind === "gap" && b.kind === "gap") return a.index === b.index;
  if (a.kind === "column" && b.kind === "column") {
    return a.rowId === b.rowId && a.colId === b.colId && a.index === b.index;
  }
  return false;
}

const dragKindOf = (c: { data: { current?: unknown } }): string | undefined =>
  (c.data.current as DragData | undefined)?.kind;

/**
 * Détection de collision. `closestCenter` seul « aimanterait » vers le bloc géométriquement le plus
 * proche, même dans une autre colonne — on borne donc les blocs candidats à la colonne survolée, et
 * on retombe sur la colonne elle-même quand elle n'a aucun bloc.
 */
const collisionDetection: CollisionDetection = (args) => {
  const kind = (args.active.data.current as DragData | undefined)?.kind;

  if (kind === "row") {
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => dragKindOf(c) === "row") });
  }

  // Les bandes d'interligne sont étroites et CHEVAUCHENT le bord des lignes : sans priorité, la
  // colonne qui les englobe gagnerait toujours et elles seraient inatteignables. Elles n'existent
  // que sous le pointeur — le capteur clavier n'a pas de « entre deux lignes » à viser, il utilise
  // les flèches de la barre d'outils et la palette « Rows ».
  if (args.pointerCoordinates !== null) {
    const gaps = pointerWithin({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => dragKindOf(c) === "gap"),
    });
    if (gaps.length > 0) return gaps;
  }

  const blocks = args.droppableContainers.filter((c) => dragKindOf(c) === "block");
  const columns = args.droppableContainers.filter((c) => dragKindOf(c) === "column");

  // Sans pointeur (capteur clavier), on retient la colonne dont le centre est le plus proche.
  const overColumns =
    args.pointerCoordinates !== null
      ? pointerWithin({ ...args, droppableContainers: columns })
      : closestCenter({ ...args, droppableContainers: columns });

  const columnId = overColumns[0]?.id;
  if (columnId !== undefined) {
    const inColumn = blocks.filter((b) => (b.data.current as { colDropId?: string } | undefined)?.colDropId === columnId);
    const nearest = inColumn.length > 0 ? closestCenter({ ...args, droppableContainers: inColumn }) : [];
    return nearest.length > 0 ? nearest : overColumns;
  }

  return closestCenter({ ...args, droppableContainers: blocks });
};

/**
 * Aucun décalage visuel des éléments : le trait de dépôt est la SEULE promesse faite à l'utilisateur.
 * Deux signaux concurrents (les voisins qui s'écartent + un trait) se contredisent dès que la liste
 * de destination n'est pas celle d'origine — c'est-à-dire dans le cas le plus fréquent ici.
 */
const NO_REFLOW: SortingStrategy = () => null;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** Trait de dépôt — hauteur 0 dans le flux : il ne pousse rien, donc ne fausse aucune mesure. */
function DropLine() {
  return (
    <div aria-hidden className="pointer-events-none relative h-0">
      <div className="absolute -top-[1.5px] left-0 right-0 h-[3px] rounded-full bg-brand">
        <span className="absolute -left-[2px] -top-[2.5px] block h-2 w-2 rounded-full bg-brand" />
      </div>
    </div>
  );
}

/**
 * Trait d'un dépôt ENTRE deux lignes. Volontairement différent du trait intra-colonne : il traverse
 * toute la largeur et s'annonce « New row », parce que le résultat n'est pas le même geste — un bloc
 * lâché là ne rejoint aucune colonne existante, il en crée une.
 */
function NewRowDropLine() {
  return (
    <div aria-hidden className="pointer-events-none absolute -top-[1.5px] left-0 right-0 z-30">
      <div className="h-[3px] rounded-full bg-brand" />
      <span className="absolute -top-[9px] left-1/2 -translate-x-1/2 rounded-full bg-brand px-2 py-[1px] text-[9px] font-bold uppercase tracking-[0.06em] text-brand-foreground">
        New row
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Contenu conditionnel
 * ------------------------------------------------------------------ */

function describeCondition(c: VisibleIf): string {
  if (c.equals !== undefined) return `${c.token} ${c.exists === false ? "is not" : "is"} “${c.equals}”`;
  return c.exists === false ? `${c.token} is empty` : `${c.token} has a value`;
}

/** Un élément conditionnel ne part pas à toute la liste : ça doit se voir sans ouvrir l'inspecteur. */
function ConditionBadge({ cond, scope }: { cond: VisibleIf; scope: string }) {
  return (
    <span
      title={`Conditional ${scope} — kept only for recipients where ${describeCondition(cond)}. Everyone else receives the email without it.`}
      className="inline-flex items-center gap-1 rounded-full border border-[#cdbaf2] bg-[#f4eeff] px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#5b3fa8]"
    >
      <Eye className="h-2.5 w-2.5" strokeWidth={2.4} />
      If
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Contexte interne du canvas
 *
 * Une douzaine de valeurs traversent trois niveaux (ligne → colonne → bloc) sans qu'aucun
 * intermédiaire n'ait à les connaître. Les faire descendre en props aurait triplé les signatures
 * sans rien clarifier.
 * ------------------------------------------------------------------ */

interface CanvasContextValue {
  doc: EmailDoc;
  theme: Theme;
  selection: Selection;
  dispatch: React.Dispatch<BuilderAction>;
  onSelect: (sel: Selection) => void;
  onSelectColumn: (col: ActiveColumn) => void;
  activeColumn: ActiveColumn | null;
  drag: DragInfo | null;
  drop: DropTarget | null;
  paletteTarget: PaletteTarget | null;
  setPaletteTarget: (t: PaletteTarget | null) => void;
  dropFromPalette: (rawType: string, at: PaletteTarget) => void;
  /** Un glissement natif (palette → canvas) est en cours : les bandes d'interligne s'arment. */
  nativeDrag: boolean;
  setNativeDrag: (v: boolean) => void;
  /** Ouvre le dialogue « Save this row » sur la ligne donnée. */
  requestSaveRow: (row: Row) => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  /** Le rendu compilé du document, et de quoi savoir si un fragment est encore à jour. */
  compiled: CanvasRenderState;
  sheets: CompiledSheet[];
  freshKeys: Map<string, string>;
  /** Polices chargées dans l'éditeur — rechargées dans l'`<iframe>` d'un bloc html brut. */
  fontHrefs: string[];
  legal: LegalFooterState;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

function useCanvas(): CanvasContextValue {
  const value = useContext(CanvasContext);
  if (!value) throw new Error("Canvas subcomponents must render inside <Canvas>");
  return value;
}

const isBlockType = (v: string): v is BlockType => (BLOCK_TYPES as readonly string[]).includes(v);

/* ------------------------------------------------------------------ *
 * Rendu d'un bloc
 * ------------------------------------------------------------------ */

/**
 * Libellé d'un bloc, y compris ceux qui n'existent pas dans la palette.
 *
 * ⚠️ `BLOCK_LABELS` est indexé par `BlockType`, et le flux d'articles n'y figure pas : il ne se
 * pose pas depuis la grille de la palette, il a besoin d'une source. Il porte pourtant un nom
 * partout où un bloc en porte un — barre d'outils, étiquette de glissement, titre de l'inspecteur.
 * Un seul endroit le décide, sinon la barre d'outils et l'inspecteur finissent par le nommer
 * différemment.
 */
export const blockLabel = (type: Block["type"]): string =>
  type === "article-feed" ? "WordPress feed" : BLOCK_LABELS[type];

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Ce qui remplace `{{legal_footer_html}}` dans le canvas : le VRAI pied de la marque, et sinon une
 * mention qui dit pourquoi il manque — jamais le jeton nu, qui se lirait comme du texte de l'e-mail.
 */
function legalFooterStandIn(legal: LegalFooterState): string {
  if (legal.html !== null) return legal.html;
  const message = legal.loading
    ? "Loading this brand’s legal footer…"
    : `Legal footer — added at send time. Could not load it here: ${legal.error ?? "unknown error"}`;
  return (
    '<div style="font:12px/1.5 Arial,Helvetica,sans-serif;color:#8a6412;background:#fdf7ec;' +
    `border:1px dashed #c9a227;padding:12px 16px;text-align:center;">${escapeText(message)}</div>`
  );
}

/**
 * Le rendu compilé d'UN bloc — le cœur du canvas. Aucun style n'est ajouté au fragment : la boîte du
 * bloc (padding, fond de conteneur) est DANS le fragment, comme dans l'e-mail.
 */
function CompiledView({ block }: { block: Block }) {
  const { compiled, sheets, freshKeys, fontHrefs, legal } = useCanvas();
  const render = compiled.render;
  const frag = render?.blocks[block.id];
  const invalid = render?.invalid[block.id];

  if (!frag) {
    if (invalid) return <InvalidBlock issues={invalid} />;
    // Bloc tout juste posé : son premier rendu est en route.
    if (compiled.pending || render === null) {
      return (
        <div className="flex h-10 items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Rendering…
        </div>
      );
    }
    return <InvalidBlock issues={[compiled.error ?? "This block could not be rendered."]} />;
  }

  // Périmé = le document a changé depuis ce rendu. Pendant qu'un rendu neuf se calcule, on garde
  // l'ancien tel quel (pas de clignotement) ; s'il n'en vient pas (erreur), on l'estompe.
  const stale = compiled.renderedKeys.get(block.id) !== freshKeys.get(block.id);
  const html = block.type === "footer_legal" ? withLegalFooter(frag.html, legalFooterStandIn(legal)) : frag.html;

  return (
    <div className={cn(stale && !compiled.pending && "opacity-45")}>
      {block.type === "html" ? (
        <RawHtmlFrame html={html} css={render!.sheets[frag.sheet] ?? ""} fonts={fontHrefs} />
      ) : (
        <ShadowHtml html={html} sheet={sheets[frag.sheet]} />
      )}
      {invalid && <InvalidBlock issues={invalid} overlay />}
    </div>
  );
}

/** Un bloc que le schéma refuse ne se compile pas — et ne se publiera pas non plus : on dit pourquoi. */
function InvalidBlock({ issues, overlay }: { issues: string[]; overlay?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 rounded-[6px] border border-[#f3c9c9] bg-[#fdecec] px-2 py-1.5 text-[10.5px] leading-snug text-[#a33]",
        overlay ? "pointer-events-none absolute left-1 right-1 top-1 z-[6]" : "m-2",
      )}
    >
      <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" strokeWidth={2.2} />
      <span>
        Not rendered — {issues[0]}
        {issues.length > 1 ? ` (+${issues.length - 1})` : ""}
      </span>
    </div>
  );
}

/**
 * L'éditeur en place du bloc texte. Stylé avec les valeurs que le compilateur posera
 * (`textEditStyle`, tenu par un banc) pour que rien ne saute quand le fragment compilé revient.
 */
function TextEditor({ block, row, col }: { block: Extract<Block, { type: "text" }>; row: Row; col: Column }) {
  const { dispatch, theme } = useCanvas();
  return (
    <div style={textEditStyle(block, row, col, theme)}>
      <InlineRichText
        value={block.paragraphs}
        editable
        placeholder="Empty text block"
        onChange={(paragraphs) => dispatch({ type: "updateBlock", blockId: block.id, patch: { paragraphs } })}
      />
    </div>
  );
}

/*
 * FLUX D'ARTICLES — le bandeau est du chrome, et il reste AU-DESSUS du rendu.
 *
 * ⛔ CE QUI EST À L'ÉCRAN NE PARTIRA PAS. `previewItems` date du jour où l'auteur a réglé le bloc ;
 * les vraies cartes sont résolues 90 min avant chaque échéance par le worker. Le rendu compilé des
 * cartes d'aperçu est exact — une, surtitres, « Más noticias », filets — mais pas leur CONTENU : d'où
 * le bandeau, non négociable, et la date de l'aperçu quand il y en a une.
 *
 * ⚠️ La phrase de la règle vient de `describeFeed` (`@nf/render/feed`), la MÊME que l'écran des
 * occurrences et le journal du planificateur.
 */
function FeedBanner({ block }: { block: Extract<Block, { type: "article-feed" }> }) {
  const floor = Math.min(block.minCount, block.count);
  return (
    <div className="m-1.5 flex items-start gap-2 rounded-[8px] border border-dashed border-[#9aa3b5] bg-card/90 px-2.5 py-1.5 text-left text-foreground">
      <Rss className="mt-[3px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      <div className="min-w-0">
        <div className="text-[12px] font-semibold leading-snug">{describeFeed(block)}</div>
        <div className="text-[10.5px] leading-snug opacity-70">
          Preview — the real articles are picked 90 minutes before each send
          {/* La date rend la péremption VISIBLE. Tranchée en ISO, sans `toLocaleString` : un format
              dépendant de la locale diffère entre le rendu serveur et le client. */}
          {block.previewAt !== undefined && ` · taken ${block.previewAt.slice(0, 16).replace("T", " ")} UTC`}
        </div>
        <div className="text-[10.5px] leading-snug opacity-55">
          Held below {floor} article{floor > 1 ? "s" : ""} ·{" "}
          {block.dedupeDays > 0 ? `no repeat within ${block.dedupeDays} days` : "repeats allowed"}
          {block.orderby === "views" && " · most viewed"}
          {block.orderby === "mixed" && " · half most viewed, half newest"}
        </div>
      </div>
    </div>
  );
}

function FeedEmpty() {
  return (
    <div className="m-2 rounded-[10px] border border-dashed border-[#9aa3b5] px-3 py-4 text-center text-[11.5px] leading-snug text-muted-foreground">
      Nothing previewed yet — choose the source, categories and tags in the panel on the right, then hit{" "}
      <span className="font-semibold">Refresh preview</span> to see what this rule returns today.
    </div>
  );
}

/** Pastille de chrome posée PAR-DESSUS le rendu (jamais dans le flux, pour ne rien décaler). */
function Chip({ tone, children, title }: { tone: "todo" | "warn" | "info" | "ai"; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-full border px-1.5 py-[1px] text-[9.5px] font-semibold leading-[14px] shadow-sm",
        tone === "todo" && "border-dashed border-[#9aa3b5] bg-card/95 text-muted-foreground",
        tone === "warn" && "border-[#f0d49a] bg-[#fdf6e7] text-[#8a5a00]",
        tone === "info" && "border-border bg-card/95 text-muted-foreground",
        tone === "ai" && "border-[#cdbaf2] bg-[#f4eeff] text-[#5b3fa8]",
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Barre d'actions
 * ------------------------------------------------------------------ */

function ActionBtn({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={disabled ? `${label} (unavailable)` : label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "rounded-[6px] p-1 transition-colors motion-reduce:transition-none",
        disabled
          ? "cursor-not-allowed opacity-35"
          : danger
            ? "hover:bg-[#fdecec] hover:text-[#c33]"
            : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Poignée de glissement — seule zone qui arme un drag, pour ne pas voler la sélection au clic. */
function DragHandle({
  label,
  attributes,
  listeners,
  setActivatorNodeRef,
}: {
  label: string;
  attributes: Record<string, unknown>;
  listeners: Record<string, unknown> | undefined;
  setActivatorNodeRef: (el: HTMLElement | null) => void;
}) {
  return (
    <button
      type="button"
      ref={setActivatorNodeRef}
      title={`${label} — or use the arrow buttons`}
      onClick={(e) => e.stopPropagation()}
      className="cursor-grab touch-none rounded-[6px] p-1 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing motion-reduce:transition-none"
      {...attributes}
      {...listeners}
      aria-label={label}
    >
      <GripVertical className="h-3 w-3" strokeWidth={2.2} />
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Canvas
 * ------------------------------------------------------------------ */

export function Canvas({
  doc,
  selection,
  activeColumn,
  dispatch,
  onSelect,
  onSelectColumn,
}: {
  doc: EmailDoc;
  selection: Selection;
  activeColumn: ActiveColumn | null;
  dispatch: React.Dispatch<BuilderAction>;
  onSelect: (sel: Selection) => void;
  onSelectColumn: (col: ActiveColumn) => void;
}) {
  const theme = doc.theme;
  const reducedMotion = usePrefersReducedMotion();

  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [paletteTarget, setPaletteTarget] = useState<PaletteTarget | null>(null);
  const [nativeDrag, setNativeDrag] = useState(false);
  const [savingRow, setSavingRow] = useState<Row | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const compiled = useCanvasRender(doc);
  const sheets = useCompiledSheets(compiled.render);
  const freshKeys = useMemo(() => fragmentKeys(doc), [doc]);
  const fonts = useWebFonts(theme.webFonts);
  const legal = useLegalFooter(doc, null, hasLegalFooter(doc));

  const sensors = useSensors(
    // 4 px de tolérance : un clic de sélection ne doit jamais partir en glissement.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Un glissement natif abandonné hors du canvas ne déclenche aucun `drop` : sans ça, le trait
  // resterait affiché et les bandes d'interligne resteraient armées (elles voleraient des clics).
  useEffect(() => {
    if (!paletteTarget && !nativeDrag) return;
    const clear = () => {
      setPaletteTarget(null);
      setNativeDrag(false);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [paletteTarget, nativeDrag]);

  function dropFromPalette(rawType: string, at: PaletteTarget) {
    setPaletteTarget(null);
    setNativeDrag(false);
    if (!isBlockType(rawType)) return;
    const hasFooter = doc.rows.some((r) => r.columns.some((c) => c.blocks.some((b) => b.type === "footer_legal")));
    // Un second footer légal serait invalide à la publication — la palette le cache déjà, on refuse aussi ici.
    if (rawType === "footer_legal" && hasFooter) return;
    const block = newBlock(rawType);

    if (at.kind === "gap") {
      // Dépôt dans l'interligne : la ligne est fabriquée ici pour pouvoir sélectionner son bloc
      // dans la foulée, comme pour un ajout au clic.
      const row = newRowWith(block);
      dispatch({ type: "insertRow", row, index: at.index });
      onSelectColumn({ rowId: row.id, colId: row.columns[0].id });
    } else {
      dispatch({ type: "addBlock", rowId: at.rowId, colId: at.colId, block, index: at.index });
      onSelectColumn({ rowId: at.rowId, colId: at.colId });
    }
    onSelect({ kind: "block", id: block.id });
  }

  function onDragStart(e: DragStartEvent) {
    const data = e.active.data.current as DragData | undefined;
    if (data?.kind !== "row" && data?.kind !== "block") return;
    setDrag({ kind: data.kind, label: data.label });
    setDrop(null);
    setEditingId(null);
  }

  function onDragMove(e: DragMoveEvent) {
    const next = computeDrop(doc, e.active, e.over, e.active.rect.current.translated);
    setDrop((prev) => (sameDrop(prev, next) ? prev : next));
  }

  function onDragEnd(e: DragEndEvent) {
    const target = computeDrop(doc, e.active, e.over, e.active.rect.current.translated);
    setDrag(null);
    setDrop(null);
    if (!target) return;
    const id = String(e.active.id);
    // Le réducteur reste seul juge : il borne l'index, refuse une cible disparue et n'empile rien
    // dans l'historique quand le dépôt ne change rien.
    if (target.kind === "row") dispatch({ type: "reorderRow", rowId: id, toIndex: target.toIndex });
    else if (target.kind === "newRow") dispatch({ type: "moveBlockToNewRow", blockId: id, index: target.index });
    else
      dispatch({ type: "moveBlockTo", blockId: id, toRowId: target.rowId, toColId: target.colId, toIndex: target.toIndex });
  }

  function onDragCancel() {
    setDrag(null);
    setDrop(null);
  }

  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart: ({ active }) =>
        `Picked up the ${(active.data.current as DragData | undefined)?.kind === "row" ? "row" : "block"}. Use the arrow keys to move it, space to drop, escape to cancel.`,
      onDragOver: () => undefined,
      onDragEnd: ({ over }) => (over ? "Dropped." : "Dropped back in its original place."),
      onDragCancel: () => "Move cancelled — nothing changed.",
    }),
    [],
  );

  const ctx: CanvasContextValue = {
    doc,
    theme,
    selection,
    dispatch,
    onSelect,
    onSelectColumn,
    activeColumn,
    drag,
    drop,
    paletteTarget,
    setPaletteTarget,
    dropFromPalette,
    nativeDrag,
    setNativeDrag,
    requestSaveRow: setSavingRow,
    editingId,
    setEditingId,
    compiled,
    sheets,
    freshKeys,
    fontHrefs: fonts.loaded,
    legal,
  };

  const rowLine = drop?.kind === "row" ? drop.lineIndex : null;

  // En-tête et pied de MARQUE : posés à la compilation, là où `applyBrandPartials` les pose — l'en-tête
  // avant tout, le pied juste avant la row du pied légal (à la fin s'il n'y en a pas).
  const brandHeader = compiled.render?.header ?? [];
  const brandFooter = compiled.render?.footer ?? [];
  const legalRowIndex = doc.rows.findIndex((r) => r.columns.some((c) => c.blocks.some((b) => b.type === "footer_legal")));
  const footerAt = legalRowIndex === -1 ? doc.rows.length : legalRowIndex;

  return (
    <CanvasContext.Provider value={ctx}>
      <DndContext
        sensors={sensors}
        accessibility={{ announcements }}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div
          className="relative min-h-[420px] overflow-x-auto p-5"
          style={{ backgroundColor: theme.bodyBackground }}
          // Cliquer hors du bloc édité referme l'édition en place (le bloc édité stoppe la propagation).
          onPointerDown={() => setEditingId(null)}
          // Un clic dans le VIDE autour de l'e-mail (la cible est ce fond lui-même, pas un de ses
          // enfants) désélectionne : l'inspecteur montre alors les styles de l'e-mail entier.
          onClick={(e) => {
            if (e.target === e.currentTarget) onSelect(null);
          }}
          // Capture : les colonnes et les blocs arrêtent la propagation de `dragover`, la racine
          // ne verrait donc jamais qu'un glissement natif est en cours — or c'est ce qui arme les
          // bandes d'interligne.
          onDragOverCapture={(e) => {
            if (!e.dataTransfer.types.includes(BLOCK_DRAG_MIME)) return;
            if (!nativeDrag) setNativeDrag(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setPaletteTarget(null);
              setNativeDrag(false);
            }
          }}
        >
          <CanvasStatus refusedFonts={fonts.refused} />

          <div
            className="mx-auto shadow-[0_1px_3px_rgba(20,20,30,0.06),0_8px_24px_rgba(20,20,30,0.06)]"
            // ⛔ La LARGEUR de l'e-mail, pas un maximum : les fragments sont calculés pour elle (images
            // et cartes en pixels). Plus étroit, le canvas défile plutôt que de mentir sur la mise en page.
            style={{ width: theme.contentWidth, backgroundColor: theme.contentBackground }}
          >
            <BrandRows rows={brandHeader} slot="header" />

            {doc.rows.length === 0 && (
              <p className="px-6 py-14 text-center text-[12.5px] text-muted-foreground">
                Empty document — add a row from the left panel to start.
              </p>
            )}

            <SortableContext id="rows" items={doc.rows.map((r) => r.id)} strategy={NO_REFLOW}>
              {doc.rows.map((row, rowIndex) => (
                <Fragment key={row.id}>
                  {rowLine === rowIndex && <DropLine />}
                  <RowGap index={rowIndex} />
                  {rowIndex === footerAt && <BrandRows rows={brandFooter} slot="footer" />}
                  <RowView row={row} rowIndex={rowIndex} rowCount={doc.rows.length} />
                </Fragment>
              ))}
            </SortableContext>
            {rowLine !== null && rowLine === doc.rows.length && <DropLine />}
            <RowGap index={doc.rows.length} />
            {footerAt === doc.rows.length && <BrandRows rows={brandFooter} slot="footer" />}
          </div>
        </div>

        <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
          {drag && (
            <div className="pointer-events-none rounded-[8px] border border-brand bg-card px-2.5 py-1.5 text-[11.5px] font-semibold text-foreground shadow-lg">
              {drag.label}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {savingRow && <SaveRowDialog row={savingRow} onClose={() => setSavingRow(null)} />}
    </CanvasContext.Provider>
  );
}

/**
 * L'état du rendu. « Rendering… » flotte dans la marge (rien ne bouge) ; une erreur, elle, prend sa
 * place dans le flux : elle doit se lire, et le rendu affiché est alors en retard sur le document.
 */
function CanvasStatus({ refusedFonts }: { refusedFonts: string[] }) {
  const { compiled, legal } = useCanvas();
  const warnings = compiled.render?.warnings ?? [];
  return (
    <>
      {compiled.pending && (
        <span className="pointer-events-none absolute right-3 top-1 z-30 inline-flex items-center gap-1 rounded-full bg-card/90 px-2 py-[1px] text-[10px] font-medium text-muted-foreground shadow-sm">
          <Loader2 className="h-2.5 w-2.5 animate-spin" /> Rendering…
        </span>
      )}
      {compiled.error && !compiled.pending && (
        <div className="mx-auto mb-3 flex max-w-[600px] items-start gap-2 rounded-[10px] border border-[#f3c9c9] bg-[#fdecec] px-3 py-2 text-[11.5px] leading-snug text-[#a33]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>
            The canvas could not render the latest change ({compiled.error}
            {compiled.issues.length > 0 ? `: ${compiled.issues.slice(0, 3).join("; ")}` : ""}). Faded blocks show an older
            version.
          </span>
        </div>
      )}
      {(warnings.length > 0 || refusedFonts.length > 0 || legal.missing.length > 0) && (
        <div className="mx-auto mb-3 max-w-[600px] rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
          {legal.missing.length > 0 && (
            <div>
              The legal footer is incomplete — sending is blocked until it has: {legal.missing.join(", ")}.
            </div>
          )}
          {warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
          {refusedFonts.length > 0 && (
            <div>
              {refusedFonts.length} web font{refusedFonts.length > 1 ? "s are" : " is"} not loaded in the editor (only Google
              Fonts and Bunny Fonts are) — Preview shows {refusedFonts.length > 1 ? "them" : "it"}.
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * En-tête et pied de marque — lecture seule
 * ------------------------------------------------------------------ */

/**
 * Les rows d'un en-tête ou d'un pied de MARQUE (`meta.headerPartialId` / `footerPartialId`). Elles
 * ne sont pas dans le document : la compilation les ajoute. Les montrer ici, c'est montrer l'e-mail
 * tel qu'il part ; les rendre éditables ici modifierait une copie qui n'existe pas — elles se
 * modifient dans les partials de marque, et le cadre le dit.
 */
function BrandRows({ rows, slot }: { rows: Row[]; slot: "header" | "footer" }) {
  if (rows.length === 0) return null;
  const label = slot === "header" ? "Brand header" : "Brand footer";
  return (
    <div className="relative" aria-label={`${label} — added at send time, read-only`}>
      {rows.map((row) => (
        <StaticRow key={row.id} row={row} />
      ))}
      <span aria-hidden className="pointer-events-none absolute inset-0 z-[5] border-2 border-dashed border-[#9aa3b5]/80" />
      <span className="pointer-events-none absolute -top-[9px] left-2 z-10">
        <Chip tone="info" title="Set on this email's settings; edited in the brand's header & footer library.">
          <Lock className="h-2.5 w-2.5" strokeWidth={2.4} />
          {label} — added at send time
        </Chip>
      </span>
    </div>
  );
}

function StaticRow({ row }: { row: Row }) {
  const { theme } = useCanvas();
  const weights = LAYOUT_WEIGHTS[row.layout];
  const total = weights.reduce((a, b) => a + b, 0);
  return (
    <div style={rowFrameStyle(row, theme)}>
      <div className="flex flex-wrap items-stretch sm:flex-nowrap">
        {row.columns.map((col, i) => (
          <div
            key={col.id}
            className="min-w-0 basis-0"
            style={{ flexGrow: weights[i] ?? 1, flexBasis: `${((weights[i] ?? 1) / total) * 100}%`, ...columnFrameStyle(col, row, theme) }}
          >
            {col.blocks.map((b) => (
              <CompiledView key={b.id} block={b} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Interligne
 * ------------------------------------------------------------------ */

/**
 * Zone de dépôt ENTRE deux lignes. Hauteur 0 dans le flux, bande de 12 px en position absolue :
 * elle ne doit pas écarter les lignes, sinon le canvas cesserait de montrer le rendu réel.
 *
 * La bande CHEVAUCHE donc le bord des lignes voisines. C'est assumé — le trait « New row » dit
 * clairement ce qui va se passer — mais elle ne capte le pointeur QUE pendant un glissement natif :
 * au repos elle volerait des clics de sélection sur le premier/dernier bloc. Le glissement @dnd-kit,
 * lui, n'a pas besoin de `pointer-events` (il travaille sur des rectangles mesurés).
 */
function RowGap({ index }: { index: number }) {
  const { drop, paletteTarget, setPaletteTarget, nativeDrag, dropFromPalette } = useCanvas();
  const data: DragData = { kind: "gap", index };
  const { setNodeRef } = useDroppable({ id: `gap:${index}`, data });

  const active =
    (drop?.kind === "newRow" && drop.index === index) ||
    (paletteTarget?.kind === "gap" && paletteTarget.index === index);

  function nativeOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(BLOCK_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    const next: PaletteTarget = { kind: "gap", index };
    if (!samePaletteTarget(paletteTarget, next)) setPaletteTarget(next);
  }

  function nativeDrop(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(BLOCK_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    dropFromPalette(e.dataTransfer.getData(BLOCK_DRAG_MIME), { kind: "gap", index });
  }

  return (
    <div className="relative h-0">
      <div
        ref={setNodeRef}
        aria-hidden
        onDragOver={nativeOver}
        onDrop={nativeDrop}
        className={cn(
          "absolute -top-[6px] left-0 right-0 z-20 h-[12px]",
          nativeDrag ? "pointer-events-auto" : "pointer-events-none",
        )}
      />
      {active && <NewRowDropLine />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Enregistrer une ligne dans la bibliothèque
 * ------------------------------------------------------------------ */

async function readApiError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${res.status})`;
}

/**
 * Dialogue « Save this row ». La row part comme un BLOC de la bibliothèque de marque
 * (`POST /api/builder/brand-partials`, `slot: "block"`, 0080) — la même bibliothèque que l'onglet
 * Blocks de « Import template » et que la section « Saved blocks » de la palette. Avant le 23/09 elle
 * partait dans `saved_row`, une seconde bibliothèque que ni la modale ni l'écran Templates ne voyaient.
 *
 * Le serveur revalide la row contre le schéma et refuse tout `footer_legal` — la longueur maximale
 * ci-dessous n'est qu'un confort de saisie, le serveur reste l'autorité et renvoie le motif exact.
 * Plus de « catégorie » : `brand_partial` n'en porte pas, le nom suffit à ranger.
 */
function SaveRowDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocks = row.columns.reduce((n, c) => n + c.blocks.length, 0);

  async function submit() {
    const trimmed = name.trim();
    if (busy || trimmed === "") return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/builder/brand-partials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpsSaveThisRow(trimmed, row)),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      // La palette n'a aucun lien avec ce dialogue : elle se recharge sur l'événement.
      window.dispatchEvent(new Event(SAVED_BLOCKS_EVENT));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Save this row"
      onClose={onClose}
      width="max-w-[460px]"
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={() => void submit()} disabled={busy || name.trim() === ""}>
            {busy && <Loader2 className="h-[15px] w-[15px] animate-spin" />}
            Save as block
          </Btn>
        </>
      }
    >
      <label className="mb-1 block text-[11.5px] font-semibold text-muted-foreground">Name</label>
      <input
        autoFocus
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        placeholder="Podcast banner"
        className="w-full rounded-[9px] border border-border bg-card px-2.5 py-2 text-[13px] focus:border-brand focus:outline-none"
      />

      <p className="mt-3 text-[11.5px] leading-snug text-muted-foreground">
        Saves a copy of this {row.layout} row and its {blocks} block{blocks === 1 ? "" : "s"} as a block in this
        brand&rsquo;s library — you&rsquo;ll find it under <span className="font-medium">Saved blocks</span> in the
        palette and in <span className="font-medium">Import template › Blocks</span>. It is a snapshot: editing the row
        afterwards does not change what was saved, and inserting it later never reuses the same identifiers.
      </p>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-[#f3c9c9] bg-[#fdecec] px-3 py-2.5 text-[12.5px] text-[#a33]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>{error}</span>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Ligne
 * ------------------------------------------------------------------ */

function RowView({ row, rowIndex, rowCount }: { row: Row; rowIndex: number; rowCount: number }) {
  const { theme, selection, dispatch, onSelect, drag, requestSaveRow } = useCanvas();
  const selected = selection?.kind === "row" && selection.id === row.id;
  const locked = rowHasLockedBlock(row);
  const weights = LAYOUT_WEIGHTS[row.layout];

  const data: DragData = { kind: "row", rowId: row.id, index: rowIndex, label: `Row ${row.layout}` };
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useSortable({
    id: row.id,
    data,
    // Pendant un glissement de bloc, une ligne n'est ni une source ni une cible valable.
    disabled: drag?.kind === "block",
  });

  return (
    <div
      ref={setNodeRef}
      className={cn("group/row relative", isDragging && "opacity-40")}
      // ⛔ Le cadre de la SECTION compilée (padding thème ⊕ row, fond) — `rowFrameStyle`, tenu par un
      // banc contre le HTML émis. Aucune bordure : la sélection se dessine par-dessus, sans rien pousser.
      style={rowFrameStyle(row, theme)}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-[4] border-2",
          selected ? "border-brand" : "border-transparent",
        )}
      />
      {/* barre de ligne — visible au survol ou quand la ligne est sélectionnée */}
      <div
        className={cn(
          "absolute -top-[11px] left-2 z-10 flex items-center gap-0.5 rounded-[7px] border border-border bg-card px-1 py-0.5 text-muted-foreground shadow-sm transition-opacity motion-reduce:transition-none",
          selected ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100",
        )}
      >
        <DragHandle
          label={`Drag row ${rowIndex + 1}`}
          attributes={attributes as unknown as Record<string, unknown>}
          listeners={listeners as unknown as Record<string, unknown> | undefined}
          setActivatorNodeRef={setActivatorNodeRef}
        />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect({ kind: "row", id: row.id });
          }}
          className="rounded-[6px] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide hover:bg-accent hover:text-foreground"
          aria-label={`Select row ${rowIndex + 1} (layout ${row.layout})`}
        >
          Row {row.layout}
        </button>
        {row.visibleIf && <ConditionBadge cond={row.visibleIf} scope="row" />}
        <ActionBtn
          label="Move row up"
          disabled={rowIndex === 0}
          onClick={() => dispatch({ type: "moveRow", rowId: row.id, dir: -1 })}
        >
          <ArrowUp className="h-3 w-3" strokeWidth={2.2} />
        </ActionBtn>
        <ActionBtn
          label="Move row down"
          disabled={rowIndex === rowCount - 1}
          onClick={() => dispatch({ type: "moveRow", rowId: row.id, dir: 1 })}
        >
          <ArrowDown className="h-3 w-3" strokeWidth={2.2} />
        </ActionBtn>
        <ActionBtn
          // Refus VISIBLE plutôt que bouton absent : l'auteur doit comprendre pourquoi cette
          // ligne-là ne se met pas en bibliothèque. L'API refuse pour la même raison (le pied de
          // page légal est injecté une fois par email, avec les liens signés du destinataire).
          label={
            locked
              ? "The legal footer cannot be saved as a block"
              : "Save this row as a block in the brand library"
          }
          disabled={locked}
          onClick={() => requestSaveRow(row)}
        >
          <Bookmark className="h-3 w-3" strokeWidth={2.2} />
        </ActionBtn>
        <ActionBtn
          label={locked ? "Row contains the locked legal footer" : "Delete row"}
          danger
          disabled={locked}
          onClick={() => {
            dispatch({ type: "removeRow", rowId: row.id });
            onSelect(null);
          }}
        >
          {locked ? <Lock className="h-3 w-3" strokeWidth={2.2} /> : <Trash2 className="h-3 w-3" strokeWidth={2.2} />}
        </ActionBtn>
      </div>

      <div className="flex flex-wrap items-stretch sm:flex-nowrap">
        {row.columns.map((col, colIndex) => (
          <ColumnView
            key={col.id}
            row={row}
            col={col}
            weight={weights[colIndex] ?? 1}
            totalWeight={weights.reduce((a, b) => a + b, 0)}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Colonne
 * ------------------------------------------------------------------ */

function ColumnView({ row, col, weight, totalWeight }: { row: Row; col: Column; weight: number; totalWeight: number }) {
  const { theme, dispatch, onSelectColumn, activeColumn, drag, drop, paletteTarget, setPaletteTarget, dropFromPalette } =
    useCanvas();
  const isActive = activeColumn?.rowId === row.id && activeColumn.colId === col.id;

  const dropId = colDropId(col.id);
  const data: DragData = { kind: "column", rowId: row.id, colId: col.id };
  const { setNodeRef } = useDroppable({ id: dropId, data, disabled: drag?.kind !== "block" });

  // Deux sources possibles pour le trait, jamais simultanées : déplacement interne, ou dépôt palette.
  const line =
    drop?.kind === "block" && drop.rowId === row.id && drop.colId === col.id
      ? drop.lineIndex
      : paletteTarget?.kind === "column" && paletteTarget.rowId === row.id && paletteTarget.colId === col.id
        ? paletteTarget.index
        : null;

  /** Survol d'un dépôt natif venu de la palette. */
  function nativeOver(e: React.DragEvent, index: number) {
    if (!e.dataTransfer.types.includes(BLOCK_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    const next: PaletteTarget = { kind: "column", rowId: row.id, colId: col.id, index };
    if (!samePaletteTarget(paletteTarget, next)) setPaletteTarget(next);
  }

  function nativeDrop(e: React.DragEvent, index: number) {
    if (!e.dataTransfer.types.includes(BLOCK_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    dropFromPalette(e.dataTransfer.getData(BLOCK_DRAG_MIME), { kind: "column", rowId: row.id, colId: col.id, index });
  }

  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={`Column of row ${row.layout}`}
      onClick={() => onSelectColumn({ rowId: row.id, colId: col.id })}
      onDragOver={(e) => nativeOver(e, col.blocks.length)}
      onDrop={(e) => nativeDrop(e, col.blocks.length)}
      className={cn(
        "relative min-w-0 basis-0 outline-offset-[-2px]",
        isActive && "outline-dashed outline-1 outline-brand/50",
      )}
      style={{
        flexGrow: weight,
        flexBasis: `${(weight / totalWeight) * 100}%`,
        // ⛔ La cellule de la COLONNE compilée — `columnFrameStyle`, tenu par un banc contre le HTML émis.
        ...columnFrameStyle(col, row, theme),
      }}
    >
      {col.visibleIf && (
        <div className="absolute left-1.5 top-1.5 z-10">
          <ConditionBadge cond={col.visibleIf} scope="column" />
        </div>
      )}

      {col.blocks.length === 0 && (
        <>
          {line === 0 && <DropLine />}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectColumn({ rowId: row.id, colId: col.id });
              dispatch({ type: "addBlock", rowId: row.id, colId: col.id, blockType: "text" });
            }}
            className="m-3 flex w-[calc(100%-24px)] items-center justify-center gap-1.5 rounded-lg border border-dashed border-[#9aa3b5] px-3 py-6 text-[11.5px] text-muted-foreground opacity-70 transition-opacity hover:opacity-100 motion-reduce:transition-none"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} /> Add text block
          </button>
        </>
      )}

      {/* Un contexte sortable PAR colonne : c'est lui qui donne au capteur clavier la notion de
          « même liste », et qui empêche les blocs de retomber sur le contexte des lignes. */}
      <SortableContext id={dropId} items={col.blocks.map((b) => b.id)} strategy={NO_REFLOW}>
        {col.blocks.map((block, blockIndex) => (
          <Fragment key={block.id}>
            {line === blockIndex && <DropLine />}
            <BlockView
              block={block}
              blockIndex={blockIndex}
              blockCount={col.blocks.length}
              row={row}
              col={col}
              colDrop={dropId}
              onNativeOver={nativeOver}
              onNativeDrop={nativeDrop}
            />
          </Fragment>
        ))}
      </SortableContext>
      {col.blocks.length > 0 && line === col.blocks.length && <DropLine />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Bloc
 * ------------------------------------------------------------------ */

function BlockView({
  block,
  blockIndex,
  blockCount,
  row,
  col,
  colDrop,
  onNativeOver,
  onNativeDrop,
}: {
  block: Block;
  blockIndex: number;
  blockCount: number;
  row: Row;
  col: Column;
  colDrop: string;
  onNativeOver: (e: React.DragEvent, index: number) => void;
  onNativeDrop: (e: React.DragEvent, index: number) => void;
}) {
  const { doc, selection, dispatch, onSelect, onSelectColumn, drag, editingId, setEditingId, legal } = useCanvas();
  const selected = selection?.kind === "block" && selection.id === block.id;
  const locked = block.type === "footer_legal";
  const editing = editingId === block.id;
  const rowId = row.id;
  const colId = col.id;

  const hints = useMemo(() => hintsFor(block, doc.meta.locale), [block, doc.meta.locale]);
  // Un jeton IA s'imprime tel quel ici ; à l'envoi, le worker l'écrit. Le badge le dit.
  const ai = useMemo(() => usesAiTokens(JSON.stringify(block)), [block]);

  const data: DragData = {
    kind: "block",
    rowId,
    colId,
    colDropId: colDrop,
    index: blockIndex,
    label: blockLabel(block.type),
  };
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useSortable({
    id: block.id,
    data,
    /*
     * Pendant un glissement de ligne, un bloc n'est ni source ni cible.
     *
     * Le footer légal, lui, n'est JAMAIS une source. Les flèches ↑/↓ ne le déplaçaient que dans SA
     * colonne ; le glissement lui permettrait de changer de colonne et de ligne, et un pied de page
     * légal ailleurs qu'à la fin est une anomalie de conformité, pas une liberté de mise en page.
     * Il reste en revanche une CIBLE (`droppable: false` non posé) : un bloc lâché juste au-dessus
     * de lui doit continuer à trouver sa place.
     */
    disabled: drag?.kind === "row" ? true : locked ? { draggable: true, droppable: false } : false,
  });

  function select() {
    onSelectColumn({ rowId, colId });
    onSelect({ kind: "block", id: block.id });
  }

  /** Position du dépôt natif : moitié haute → avant ce bloc, moitié basse → après. */
  function nativeIndex(e: React.DragEvent): number {
    const rect = e.currentTarget.getBoundingClientRect();
    return blockIndex + (e.clientY > rect.top + rect.height / 2 ? 1 : 0);
  }

  const legalEdition = legal.editions.find((e) => e.id === legal.editionId);

  return (
    <div
      ref={setNodeRef}
      // Ancre stable du bloc dans le DOM. Sans elle, un constat du pré-vol peut SÉLECTIONNER le bloc
      // fautif mais pas faire défiler jusqu'à lui : sur un email long, l'utilisateur clique et rien
      // ne bouge à l'écran. Elle sert aussi de point d'accroche à la vérification automatisée.
      data-block-id={block.id}
      data-block-type={block.type}
      role="button"
      tabIndex={0}
      aria-label={`${blockLabel(block.type)} block`}
      aria-pressed={selected}
      onClick={(e) => {
        e.stopPropagation();
        select();
      }}
      // Le bloc en cours d'édition retient le pointerdown, sinon le canvas refermerait l'éditeur
      // au premier clic à l'intérieur.
      onPointerDown={editing ? (e) => e.stopPropagation() : undefined}
      onDoubleClick={
        block.type === "text"
          ? (e) => {
              e.stopPropagation();
              select();
              setEditingId(block.id);
            }
          : undefined
      }
      onKeyDown={(e) => {
        if (e.key === "Escape" && editing) {
          e.stopPropagation();
          setEditingId(null);
          return;
        }
        if (editing) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          select();
        }
      }}
      onDragOver={(e) => onNativeOver(e, nativeIndex(e))}
      onDrop={(e) => onNativeDrop(e, nativeIndex(e))}
      // ⛔ AUCUN style de boîte ici : padding, fond de conteneur et bordure sont DANS le fragment
      // compilé. Les reposer sur l'enveloppe les doublerait — c'était l'écart du bouton.
      // Un bloc à remplir garde juste de quoi porter sa pastille.
      className={cn(
        "group/block relative focus:outline-none",
        isDragging && "opacity-40",
        hints.some((h) => h.tone === "todo") && "min-h-[26px]",
      )}
    >
      {/* Cadre de sélection PAR-DESSUS le rendu : il ne décale pas un pixel du fragment. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-[5] border-2 transition-colors motion-reduce:transition-none",
          selected || editing ? "border-brand" : "border-transparent group-hover/block:border-brand-soft group-focus-visible/block:border-brand",
        )}
      />

      <div
        className={cn(
          "absolute -top-[11px] right-2 z-10 flex items-center gap-0.5 rounded-[7px] border border-border bg-card px-1 py-0.5 text-muted-foreground shadow-sm transition-opacity motion-reduce:transition-none",
          selected ? "opacity-100" : "opacity-0 group-hover/block:opacity-100 focus-within:opacity-100",
        )}
      >
        {locked ? (
          // Pas de préhenseur : l'état doit correspondre au cadenas déjà affiché sur les autres
          // actions. Les flèches ↑/↓ restent, elles, disponibles.
          <span
            title="The legal footer cannot be dragged — use the arrow buttons to move it inside its column"
            aria-label="Legal footer — locked in place"
            className="p-1 opacity-70"
          >
            <Lock className="h-3 w-3" strokeWidth={2.2} />
          </span>
        ) : (
          <DragHandle
            label={`Drag ${blockLabel(block.type).toLowerCase()} block`}
            attributes={attributes as unknown as Record<string, unknown>}
            listeners={listeners as unknown as Record<string, unknown> | undefined}
            setActivatorNodeRef={setActivatorNodeRef}
          />
        )}
        <span className="px-1 text-[10px] font-semibold uppercase tracking-wide">{blockLabel(block.type)}</span>
        {block.type !== "footer_legal" && block.visibleIf && <ConditionBadge cond={block.visibleIf} scope="block" />}
        <ActionBtn
          label="Move block up"
          disabled={blockIndex === 0}
          onClick={() => dispatch({ type: "moveBlock", blockId: block.id, dir: -1 })}
        >
          <ArrowUp className="h-3 w-3" strokeWidth={2.2} />
        </ActionBtn>
        <ActionBtn
          label="Move block down"
          disabled={blockIndex === blockCount - 1}
          onClick={() => dispatch({ type: "moveBlock", blockId: block.id, dir: 1 })}
        >
          <ArrowDown className="h-3 w-3" strokeWidth={2.2} />
        </ActionBtn>
        <ActionBtn
          label={locked ? "Legal footer cannot be duplicated" : "Duplicate block"}
          disabled={locked}
          onClick={() => dispatch({ type: "duplicateBlock", blockId: block.id })}
        >
          <Copy className="h-3 w-3" strokeWidth={2.2} />
        </ActionBtn>
        <ActionBtn
          label={locked ? "Legal footer cannot be deleted" : "Delete block"}
          danger
          disabled={locked}
          onClick={() => dispatch({ type: "removeBlock", blockId: block.id })}
        >
          {locked ? <Lock className="h-3 w-3" strokeWidth={2.2} /> : <Trash2 className="h-3 w-3" strokeWidth={2.2} />}
        </ActionBtn>
      </div>

      {block.type === "article-feed" && <FeedBanner block={block} />}

      {block.type === "text" && editing ? (
        <TextEditor block={block} row={row} col={col} />
      ) : block.type === "article-feed" && feedCards(block, doc.meta.locale).length === 0 ? (
        <FeedEmpty />
      ) : (
        <CompiledView block={block} />
      )}

      {/* Chrome d'éditeur, hors du rendu : ce bandeau ne part jamais dans le HTML compilé. Il
          n'apparaît que sur un bloc importé. */}
      {block.type === "article" && block.source && (
        <SourceRibbon block={block} source={block.source} dispatch={dispatch} />
      )}

      {/* Pastilles : PAR-DESSUS le rendu, en bas à gauche, jamais dans le flux. */}
      {(hints.length > 0 || ai || locked || block.type === "spacer") && !editing && (
        <div className="pointer-events-none absolute bottom-1 left-1 z-[6] flex max-w-[calc(100%-8px)] flex-wrap gap-1">
          {locked && (
            <Chip
              tone="info"
              title="Built per recipient at send time: signed unsubscribe and preferences links (shown as # here), the brand's address and the notices of the recipient's edition."
            >
              <Lock className="h-2.5 w-2.5" strokeWidth={2.4} />
              Added at send time{legalEdition ? ` · ${editionLabel(legalEdition)} edition` : ""}
            </Chip>
          )}
          {ai && (
            <Chip tone="ai" title="Written by the AI for each send; the tag prints as-is here. Preview → “As a recipient” shows a sample.">
              <Sparkles className="h-2.5 w-2.5" strokeWidth={2.4} />
              AI text — written at send time
            </Chip>
          )}
          {block.type === "spacer" && (
            // Un espaceur ne se voit pas — c'est son rôle. Son nom et sa hauteur ne s'affichent qu'au survol.
            <span className="opacity-0 transition-opacity group-hover/block:opacity-100 motion-reduce:transition-none">
              <Chip tone="info">Spacer · {block.height}px</Chip>
            </span>
          )}
          {hints.map((h, i) => (
            <Chip key={i} tone={h.tone}>
              {h.tone === "warn" && <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2.4} />}
              {h.text}
            </Chip>
          ))}
        </div>
      )}

      {block.type === "text" && !editing && (
        <div className="pointer-events-none absolute bottom-1 right-2 z-[6] text-[9.5px] font-medium uppercase tracking-wide opacity-0 transition-opacity group-hover/block:opacity-40 motion-reduce:transition-none">
          Double-click to edit
        </div>
      )}
    </div>
  );
}
