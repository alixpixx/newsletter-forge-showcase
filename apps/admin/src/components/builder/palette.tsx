"use client";

/**
 * PALETTE (panneau gauche) — deux gestes, tous deux réels.
 *
 *  • CLIC : ajoute à la colonne SÉLECTIONNÉE (contour pointillé sur le canvas), sinon à la dernière
 *    colonne du document. La cible est affichée en clair sous les boutons — l'utilisateur sait
 *    toujours où le bloc va atterrir avant de cliquer. C'est la voie CLAVIER, et elle reste la voie
 *    de référence : un glissement ne s'opère pas au clavier.
 *  • GLISSEMENT : dépose le bloc à un emplacement PRÉCIS du canvas (un trait montre où). On passe
 *    par le glisser-déposer HTML natif et non par @dnd-kit, parce que la palette et le canvas sont
 *    deux frères dans `shell.tsx` : un `DndContext` commun aurait exigé de modifier ce fichier.
 *    Le canvas revalide le type reçu — `dataTransfer` est un canal ouvert.
 *
 * BIBLIOTHÈQUE DE BLOCS — la section « Saved blocks » lit `GET /api/builder/brand-partials` (fente
 * `block`), donc la marque courante et elle seule. Un clic ne réutilise JAMAIS la copie affichée dans
 * la liste : il redemande les rows à `GET /api/builder/brand-partials/[id]`, qui régénère les
 * identifiants à chaque lecture. Insérer deux fois depuis une liste chargée une seule fois dupliquerait
 * sinon les ids de row/colonnes/blocs dans le document — ce que le schéma et le compilateur supposent
 * impossible.
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bookmark,
  Code2,
  Columns2,
  Image as ImageIcon,
  LayoutTemplate,
  Link2,
  Loader2,
  Lock,
  Minus,
  MousePointerClick,
  MoveVertical,
  Megaphone,
  Newspaper,
  Plus,
  Rss,
  Share2,
  Swords,
  Table2,
  TextQuote,
  Tag,
  Target,
  Trash2,
  Trophy,
  Type,
} from "lucide-react";
import {
  BLOCK_TYPES,
  LAYOUT_WEIGHTS,
  MAX_DOC_ROWS,
  ROW_LAYOUTS,
  newId,
  type ArticleFeedBlock,
  type Block,
  type BlockType,
  type EmailDoc,
  type RowLayout,
} from "@nf/render/schema";
import { cn } from "@/lib/utils";
import { fetchPartialRows, fetchPartials, type PartialEntry } from "@/components/templates/library-client";
import { BLOCK_LABELS, newBlock, newRow } from "./factories";
import { BLOCK_DRAG_MIME, SAVED_BLOCKS_EVENT, type ActiveColumn, type Selection } from "./canvas";
import { actionImport, blocsDeLaBibliotheque, ouInsererBloc } from "./library-insert";
import { resoudreCible, type BuilderAction, type CibleInsertion } from "./reducer";

const BLOCK_ICONS: Record<BlockType, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  text: Type,
  image: ImageIcon,
  button: MousePointerClick,
  divider: Minus,
  spacer: MoveVertical,
  html: Code2,
  social: Share2,
  menu: Link2,
  pick: Target,
  odds_table: Table2,
  standings: Trophy,
  scoreboard: Swords,
  article: Newspaper,
  section_title: TextQuote,
  callout: Megaphone,
  promo: Tag,
  footer_legal: Lock,
};

/**
 * Blocs métier — séparés des blocs de structure dans la palette. Quatorze vignettes d'affilée
 * noieraient les six qu'on utilise à chaque édition ; l'ordre de `BLOCK_TYPES` reste la source de
 * vérité à l'intérieur de chaque groupe.
 */
const CONTENT_TYPES: readonly BlockType[] = [
  "pick",
  "odds_table",
  "standings",
  "scoreboard",
  "article",
  "callout",
  "promo",
];

/* ------------------------------------------------------------------ *
 * Flux WordPress — le bloc qui se recalcule tout seul
 * ------------------------------------------------------------------ */

/** Ce que la palette a besoin de savoir d'une source, et rien de plus. */
interface FeedSourceOption {
  id: string;
  label: string;
}

/** Valeurs de départ d'un flux — celles du schéma, réécrites ici parce qu'on ne passe pas par Zod. */
const FEED_DEFAULTS = { count: 5, minCount: 3, dedupeDays: 14 } as const;

/**
 * Bouton « WordPress feed » — il pose un bloc `article-feed`, pas des articles.
 *
 * ⛔ IL N'Y A PAS DE BLOC FLUX SANS SOURCE. `sourceId` est `min(1)` au schéma : un bloc posé avec
 * une source vide rendrait le BROUILLON ENTIER insauvegardable (`EmailDoc.safeParse` refuse avant
 * toute écriture), et l'auteur découvrirait la panne au moment d'enregistrer, loin d'ici. D'où la
 * lecture des sources de la marque AVANT le clic : on pose la première, l'inspecteur permet d'en
 * changer. Sans aucune source déclarée, le bouton est désarmé AVEC sa raison — un bouton actif qui
 * échoue au clic vaut moins qu'un bouton éteint qui dit pourquoi.
 *
 * ⚠️ Pas de `draggable`, contrairement aux vignettes de la grille : le glissement transporte un
 * `BlockType` brut que le canvas refabrique à l'arrivée, or le flux n'est pas dans `BLOCK_TYPES`
 * (il ne se fabrique pas sans source). Ses deux voisins d'import ne se glissent pas non plus.
 */
function WpFeedButton({
  enabled,
  disabledReason,
  onAdd,
}: {
  enabled: boolean;
  disabledReason: string;
  onAdd: (block: ArticleFeedBlock) => void;
}) {
  const [sources, setSources] = useState<FeedSourceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/builder/wp/sources");
        if (!res.ok) {
          if (!cancelled) setError(await readApiError(res));
          return;
        }
        const body = (await res.json()) as { sources?: unknown; error?: unknown };
        if (cancelled) return;
        const list = Array.isArray(body.sources) ? body.sources : [];
        setSources(
          list.map((raw) => {
            const r = raw as Record<string, unknown>;
            return { id: String(r.id ?? ""), label: String(r.label ?? "") };
          }),
        );
        // ⚠️ La base a refusé la lecture : ce n'est PAS « aucune source configurée ».
        if (typeof body.error === "string" && body.error) setError(body.error);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const first = sources?.[0] ?? null;
  const ready = enabled && first !== null;
  const title = !enabled
    ? disabledReason
    : sources === null
      ? "Loading this brand's WordPress sources…"
      : first === null
        ? "No WordPress source on this brand yet — declare one in Settings before using a feed block"
        : `Add a feed block reading ${first.label} — the articles are picked 90 minutes before each send`;

  return (
    <>
      <button
        type="button"
        disabled={!ready}
        onClick={() => {
          if (!first) return;
          onAdd({
            id: newId("blk"),
            type: "article-feed",
            sourceId: first.id,
            sourceLabel: first.label,
            categories: [],
            categoryNames: [],
            tags: [],
            tagNames: [],
            count: FEED_DEFAULTS.count,
            minCount: FEED_DEFAULTS.minCount,
            dedupeDays: FEED_DEFAULTS.dedupeDays,
            // Un bloc neuf s'ordonne par DATE. Le tri par vues est un choix explicite : il dépend
            // d'une propriété d'analytics élue pour la marque, et il refuse quand les articles sont
            // trop récents pour avoir été mesurés — ce serait une mauvaise surprise par défaut.
            orderby: "date",
            // Sans effet tant que `orderby` vaut `date` — mais le champ est écrit dès la création
            // pour que le bloc porte la même valeur que le schéma, plutôt qu'un défaut appliqué
            // plus tard : le modèle enregistré doit dire ce qu'il fera si on bascule sur `views`.
            viewsWindow: "cadence",
            layout: "stacked",
            // Pas de `ctaLabel` : le flux recopie le sien TEL QUEL sur chaque carte (`feed.ts`,
            // `toArticle`), et une carte sans libellé reçoit le défaut de `meta.locale` au rendu.
            // En l'écrivant ici, il devenait indiscernable d'une saisie — cf. `factories.ts`.
            // Aucun aperçu au départ : le canvas invite à en demander un. Poser des articles
            // au moment de la création laisserait croire que ce sont EUX qui partiront.
            previewItems: [],
          });
        }}
        title={title}
        className={cn(
          "mb-1.5 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-border bg-card px-2 py-2.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 motion-reduce:transition-none",
          ready ? "hover:border-brand hover:text-brand" : "cursor-not-allowed opacity-40",
        )}
      >
        <Rss className="h-3.5 w-3.5" strokeWidth={2} /> WordPress feed
      </button>

      {sources !== null && sources.length === 0 && (
        <p className="mb-1.5 text-[11px] leading-snug text-muted-foreground/80">
          No WordPress source on this brand yet — declare one in Settings to use a feed block.
        </p>
      )}

      {error && (
        <p className="mb-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-[#a33]">
          <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
          {error}
        </p>
      )}
    </>
  );
}

/**
 * Résout la cible d'un clic : colonne (et position) où le bloc sera posé. La règle — jamais sous le
 * pied légal, jamais dans un footer importé sans l'avoir choisi — vit dans le réducteur, où elle se
 * teste sans React : voir `resoudreCible`.
 */
export function resolveTarget(doc: EmailDoc, active: ActiveColumn | null): CibleInsertion | null {
  return resoudreCible(doc, active);
}

async function readApiError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${res.status})`;
}

/**
 * « Saved blocks » — les BLOCS de la bibliothèque de marque (`brand_partial`, fente `block`, 0080).
 *
 * ⛔ UNE SEULE BIBLIOTHÈQUE (décision du 23/09). Cette section lisait `saved_row` (0020), une seconde
 * bibliothèque sans aperçu, sans édition, au nom réservé à vie : deux endroits pour « enregistrer une
 * row » finissaient par ne plus montrer les mêmes choses. « Save this row » écrit désormais un bloc, et
 * ce que la palette liste est EXACTEMENT ce que l'onglet Blocks de la modale « Import template » et
 * l'écran Templates › Headers, footers & blocks listent.
 *
 * Position d'insertion : juste APRÈS la row de la colonne sélectionnée, sinon au-dessus du pied — la
 * règle vit dans `library-insert.ts`, partagée avec la modale, et elle est affichée en clair pour que
 * le geste ne soit pas un coup de dé.
 */
function SavedBlocks({
  doc,
  activeColumn,
  dispatch,
  onSelect,
  plein,
  maxRows,
}: {
  doc: EmailDoc;
  activeColumn: ActiveColumn | null;
  dispatch: React.Dispatch<BuilderAction>;
  onSelect: (sel: Selection) => void;
  /** Raison du refus quand le document a atteint son plafond de lignes, sinon `null`. */
  plein: string | null;
  /** Plafond de rows de CE document (en-tête, pied ou bloc en cours d'édition), sinon celui du schéma. */
  maxRows?: number;
}) {
  const [entries, setEntries] = useState<PartialEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(blocsDeLaBibliotheque(await fetchPartials()));
      setError(null);
    } catch (err) {
      // ⛔ « La bibliothèque n'a pas répondu » ne s'écrit pas « rien d'enregistré » : pas de liste vide.
      setEntries(null);
      setError(err instanceof Error ? err.message : "Network error");
    }
  }, []);

  // Le canvas enregistre, la palette affiche : aucun état partagé, juste un événement de fenêtre.
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener(SAVED_BLOCKS_EVENT, refresh);
    return () => window.removeEventListener(SAVED_BLOCKS_EVENT, refresh);
  }, [load]);

  const ouInserer = ouInsererBloc(doc, activeColumn);
  const plafond = maxRows ?? MAX_DOC_ROWS;

  async function insert(entry: PartialEntry) {
    if (busyId) return;
    setBusyId(entry.id);
    setError(null);
    try {
      // ⛔ Ids FRAIS obligatoires : les rows sont RELUES à chaque clic (`fetchPartialRows`), jamais
      // reprises de la liste chargée une fois — insérer deux fois la même copie dupliquerait les ids,
      // et le réducteur refuserait la seconde en silence.
      const rows = await fetchPartialRows(entry.id);
      if (doc.rows.length + rows.length > plafond) {
        // Le réducteur refuserait sans rien dire : on le dit ici, avec le compte.
        setError(
          `"${entry.name}" has ${rows.length} row${rows.length === 1 ? "" : "s"} — that would go past the ${plafond} rows this can hold.`,
        );
        return;
      }
      dispatch(actionImport("block", rows, doc, activeColumn));
      onSelect({ kind: "row", id: rows[0]!.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusyId(null);
    }
  }

  async function archive(entry: PartialEntry) {
    if (busyId) return;
    if (
      !window.confirm(
        `Archive "${entry.name}"? It leaves this brand's library; emails that already imported it keep their copy, and its name becomes free again.`,
      )
    ) {
      return;
    }
    setBusyId(entry.id);
    setError(null);
    try {
      const res = await fetch(`/api/builder/brand-partials/${entry.id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <SectionTitle>Saved blocks</SectionTitle>

      {entries === null && error === null && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
          <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} /> Loading the brand library…
        </p>
      )}

      {entries !== null && entries.length === 0 && (
        <p className="text-[11px] leading-snug text-muted-foreground/80">
          No block yet. Use <span className="font-semibold text-foreground/70">Save this row</span> on a row&rsquo;s
          toolbar, or create one in Templates › Headers, footers &amp; blocks — the library belongs to this brand only.
        </p>
      )}

      {entries !== null && entries.length > 0 && (
        <ul className="flex flex-col gap-1">
          {entries.map((entry) => (
            <li key={entry.id} className="group/saved flex items-stretch gap-1">
              <button
                type="button"
                disabled={busyId !== null || plein !== null}
                onClick={() => void insert(entry)}
                title={plein ?? `Insert "${entry.name}" ${ouInserer}`}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 rounded-[9px] border border-border bg-card px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 motion-reduce:transition-none",
                  busyId !== null
                    ? "cursor-wait opacity-50"
                    : plein !== null
                      ? "cursor-not-allowed opacity-40"
                      : "hover:border-brand hover:text-brand",
                )}
              >
                {busyId === entry.id ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" strokeWidth={2} />
                ) : (
                  <Bookmark className="h-3 w-3 shrink-0" strokeWidth={2} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px] font-medium leading-tight">{entry.name}</span>
                  <span className="block truncate text-[10px] leading-tight text-muted-foreground">
                    {entry.rows.length} row{entry.rows.length === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
              <button
                type="button"
                disabled={busyId !== null}
                aria-label={`Archive ${entry.name}`}
                title="Archive — it leaves the library; emails that imported it keep their copy"
                onClick={() => void archive(entry)}
                className="rounded-[9px] border border-transparent px-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-[#fdecec] hover:text-[#c33] focus-visible:opacity-100 focus-visible:outline-none group-hover/saved:opacity-100 motion-reduce:transition-none"
              >
                <Trash2 className="h-3 w-3" strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-[#a33]">
          <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
          {error}
        </p>
      )}

      {entries !== null && entries.length > 0 && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
          A click inserts a fresh copy <span className="font-semibold text-foreground/70">{ouInserer}</span>. The
          copy is independent: editing it here changes nothing in the library.
        </p>
      )}
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
      {children}
    </div>
  );
}

function BlockButton({
  type,
  enabled,
  onAdd,
}: {
  type: BlockType;
  enabled: boolean;
  onAdd: (type: BlockType) => void;
}) {
  const Icon = BLOCK_ICONS[type];
  const label = BLOCK_LABELS[type];
  return (
    <button
      type="button"
      disabled={!enabled}
      // Le glissement reste possible sans colonne cible cliquée : on dépose où l'on veut.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(BLOCK_DRAG_MIME, type);
        // Repli lisible si le glissement finit dans un champ texte plutôt que sur le canvas.
        e.dataTransfer.setData("text/plain", label);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={enabled ? `Add a ${label.toLowerCase()} block — click, or drag it onto the canvas` : "Add a row first"}
      onClick={() => onAdd(type)}
      className={cn(
        "flex cursor-grab flex-col items-center gap-1 rounded-[10px] border border-border bg-card px-2 py-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 active:cursor-grabbing motion-reduce:transition-none",
        enabled ? "hover:border-brand hover:text-brand" : "cursor-not-allowed opacity-40",
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={1.9} />
      {label}
    </button>
  );
}

export function Palette({
  doc,
  activeColumn,
  dispatch,
  onSelect,
  onSelectColumn,
  onPasteHtml,
  onImportWordPress,
  onImportTemplate,
  footerLegalInterdit = false,
  maxRows,
}: {
  doc: EmailDoc;
  activeColumn: ActiveColumn | null;
  dispatch: React.Dispatch<BuilderAction>;
  onSelect: (sel: Selection) => void;
  onSelectColumn: (col: ActiveColumn) => void;
  /**
   * Absents = pas de bouton. Un bouton branché sur `() => {}` se clique et ne fait rien : l'éditeur
   * d'un en-tête ou d'un pied de marque les montrait ainsi jusqu'au 16/09.
   */
  onPasteHtml?: () => void;
  onImportWordPress?: () => void;
  /** Absent = pas de bouton (l'éditeur d'un header/footer n'importe pas dans un header/footer). */
  onImportTemplate?: () => void;
  /** Vrai dans un en-tête ou un pied de marque, où le bloc légal est refusé par le serveur. */
  footerLegalInterdit?: boolean;
  /**
   * Plafond de lignes à AFFICHER, le même que celui passé au réducteur (qui, lui, refuse). Sans lui,
   * les boutons de ligne resteraient actifs au plafond et un clic ne produirait rien, sans dire pourquoi.
   */
  maxRows?: number;
}) {
  const target = resolveTarget(doc, activeColumn);
  const plein =
    maxRows !== undefined && doc.rows.length >= maxRows
      ? `This already has ${maxRows} rows, the most a header or footer can hold — remove one to add another.`
      : null;
  const hasFooter = doc.rows.some((r) => r.columns.some((c) => c.blocks.some((b) => b.type === "footer_legal")));

  // Position lisible de la cible ("Row 2 · column 1") — sinon l'ajout au clic serait un coup de dé.
  const targetLabel = (() => {
    if (!target) return null;
    const rowIndex = doc.rows.findIndex((r) => r.id === target.rowId);
    const colIndex = doc.rows[rowIndex]?.columns.findIndex((c) => c.id === target.colId) ?? -1;
    if (rowIndex < 0 || colIndex < 0) return null;
    const lieu = `Row ${rowIndex + 1} · column ${colIndex + 1}`;
    if (target.index === undefined) return lieu;
    const avant = doc.rows[rowIndex].columns[colIndex].blocks[target.index];
    return avant?.type === "footer_legal" ? `${lieu}, above the legal footer` : `${lieu}, at the top`;
  })();

  /**
   * Pose un bloc DÉJÀ fabriqué et le sélectionne.
   *
   * Le bloc naît côté appelant (et non dans le réducteur) pour pouvoir être sélectionné aussitôt :
   * ajouter un bloc qu'on ne peut pas éditer dans la foulée n'aurait aucun intérêt. C'est aussi ce
   * qui permet au flux WordPress, qui a besoin d'une source, d'être construit ailleurs qu'ici.
   */
  function placeBlock(block: Block) {
    if (!target) return;
    dispatch({ type: "addBlock", rowId: target.rowId, colId: target.colId, block, index: target.index });
    // ⚠️ La colonne SEULE, jamais `index` : une position mémorisée poserait les blocs suivants
    // au-dessus du précédent, dans l'ordre inverse des clics.
    onSelectColumn({ rowId: target.rowId, colId: target.colId });
    onSelect({ kind: "block", id: block.id });
  }

  /** Une row neuve se pose avant le pied (défaut du réducteur) et devient la cible des clics. */
  function addRow(layout: RowLayout) {
    const row = newRow(layout);
    dispatch({ type: "insertRows", rows: [row] });
    const col = row.columns[0];
    if (col) onSelectColumn({ rowId: row.id, colId: col.id });
  }

  function addBlock(type: BlockType) {
    placeBlock(newBlock(type));
  }

  // ⛔ DEUX RAISONS DE MASQUER LE PIED LÉGAL, ET ELLES NE SE RECOUVRENT PAS. `hasFooter` dit « ce
  // document en a déjà un » — vrai dans un modèle, JAMAIS dans un en-tête ou un pied de marque, qui
  // n'en contient par construction aucun. Sans `footerLegalInterdit`, la palette le proposerait donc
  // dans un partial : l'auteur le pose, rien ne l'arrête à l'écran, et il prend un 422 à
  // l'enregistrement — le refus est porté par le serveur (`validateBrandPartialRows`), qui ne peut
  // pas être l'endroit où on l'apprend.
  const visible = BLOCK_TYPES.filter(
    (t) => t !== "footer_legal" || (!hasFooter && !footerLegalInterdit),
  );
  const structure = visible.filter((t) => !CONTENT_TYPES.includes(t));
  const content = visible.filter((t) => CONTENT_TYPES.includes(t));

  return (
    <aside className="flex w-full flex-col gap-5 lg:w-[186px] lg:shrink-0" aria-label="Block palette">
      <section>
        <SectionTitle>Blocks</SectionTitle>
        <div className="grid grid-cols-2 gap-1.5">
          {structure.map((type) => (
            <BlockButton key={type} type={type} enabled={target !== null} onAdd={addBlock} />
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
          {targetLabel ? (
            <>
              Click adds to <span className="font-semibold text-foreground/70">{targetLabel}</span> — click a column on
              the canvas to change the target, or drag a block straight where you want it.
            </>
          ) : (
            "Add a row before adding blocks."
          )}
        </p>
      </section>

      <section>
        <SectionTitle>Import</SectionTitle>
        {/* En tête de section et sans cible requise : un header se pose en haut, un footer avant le
            pied légal, un pied légal sur son bloc — aucun des trois ne dépend de la colonne active. */}
        {onImportTemplate && (
          <button
            type="button"
            onClick={onImportTemplate}
            title="Insert one of this brand's headers, footers, blocks or legal footers"
            className="mb-1.5 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-brand/40 bg-brand-soft/50 px-2 py-2.5 text-[11.5px] font-semibold text-brand transition-colors hover:border-brand hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 motion-reduce:transition-none"
          >
            <LayoutTemplate className="h-3.5 w-3.5" strokeWidth={2} /> Import template
          </button>
        )}
        {/* ⚠️ PAS de `disabled={!target}` ici, contrairement à « Paste HTML ». L'import d'articles
            ne verse pas dans la colonne active : il crée ses propres lignes pleine largeur (une par
            article), donc il n'a besoin d'aucune cible. Le désarmer par symétrie visuelle aurait
            rendu la fonction inaccessible sur un document vide — c'est-à-dire au moment précis où
            l'on compose une newsletter. */}
        {onImportWordPress && (
          <button
            type="button"
            onClick={onImportWordPress}
            title="Pick real articles from a connected WordPress site"
            className="mb-1.5 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-border bg-card px-2 py-2.5 text-[11.5px] font-medium transition-colors hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 motion-reduce:transition-none"
          >
            <Newspaper className="h-3.5 w-3.5" strokeWidth={2} /> WordPress articles
          </button>
        )}
        {/* Le flux, lui, EXIGE une colonne cible : c'est un bloc unique, pas une série de lignes
            pleine largeur comme l'import article par article juste au-dessus. */}
        <WpFeedButton
          enabled={target !== null}
          disabledReason="Add a row first"
          onAdd={placeBlock}
        />
        {onPasteHtml && (
          <button
            type="button"
            disabled={!target}
            onClick={onPasteHtml}
            title={target ? "Paste existing HTML into a raw block" : "Add a row first"}
            className={cn(
              "flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-border bg-card px-2 py-2.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 motion-reduce:transition-none",
              target ? "hover:border-brand hover:text-brand" : "cursor-not-allowed opacity-40",
            )}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} /> Paste HTML
          </button>
        )}
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground/80">
          <Rss className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
          {onImportWordPress ? (
            <span>
              <span className="font-semibold text-foreground/70">WordPress articles</span> copies today&rsquo;s articles
              into blocks you then own. <span className="font-semibold text-foreground/70">WordPress feed</span> keeps a
              rule instead — its articles are picked 90 minutes before each send, so a recurring newsletter never ships
              last week&rsquo;s.
            </span>
          ) : (
            <span>
              <span className="font-semibold text-foreground/70">WordPress feed</span> keeps a rule — its articles are
              picked 90 minutes before each send.
            </span>
          )}
        </p>
        {onPasteHtml && (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground/80">
            <Columns2 className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
            Pasted markup is kept as-is and never checked for email-client compatibility.
          </p>
        )}
      </section>

      <section>
        <SectionTitle>Rows</SectionTitle>
        <div className="grid grid-cols-2 gap-1.5">
          {ROW_LAYOUTS.map((layout) => (
            <button
              key={layout}
              type="button"
              disabled={plein !== null}
              title={plein ?? `Add a ${layout} row`}
              onClick={() => addRow(layout as RowLayout)}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-[10px] border border-border bg-card px-2 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 motion-reduce:transition-none",
                plein !== null ? "cursor-not-allowed opacity-40" : "hover:border-brand",
              )}
            >
              <span className="flex h-4 w-full items-stretch gap-[2px]">
                {LAYOUT_WEIGHTS[layout].map((w, i) => (
                  <span key={i} className="rounded-[2px] bg-accent" style={{ flexGrow: w, flexBasis: 0 }} />
                ))}
              </span>
              <span className="text-[10.5px] font-medium text-muted-foreground">{layout}</span>
            </button>
          ))}
        </div>
        {plein ? (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] font-medium leading-snug text-[#b9790a]">
            <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" strokeWidth={2} />
            {plein}
          </p>
        ) : (
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
            A new row goes just above the footer. Reorder rows and blocks by dragging their handle, or with the arrow buttons on the canvas. Dropping a block
            between two rows creates a new full-width row for it.
            {maxRows !== undefined && (
              <span className="mt-1 block tabular-nums">
                {doc.rows.length} of {maxRows} rows used.
              </span>
            )}
          </p>
        )}
      </section>

      <SavedBlocks
        doc={doc}
        activeColumn={activeColumn}
        dispatch={dispatch}
        onSelect={onSelect}
        plein={plein}
        maxRows={maxRows}
      />

      <section>
        <SectionTitle>Manual content</SectionTitle>
        <div className="grid grid-cols-2 gap-1.5">
          {content.map((type) => (
            <BlockButton key={type} type={type} enabled={target !== null} onAdd={addBlock} />
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
          For the odd block an import can&rsquo;t give you. These come out empty on purpose — every label, odds
          included, is text you write or a merge tag.
        </p>
      </section>
    </aside>
  );
}
