"use client";

/**
 * PANNEAU DE PRÉ-VOL — le tableau de bord de ce qui va mal, avant publication.
 *
 * Les honnêtetés tenues ici :
 *  1. Le poids et les avertissements du compilateur viennent d'une VRAIE compilation
 *     (`POST /api/builder/preview`), jamais d'une estimation faite dans le navigateur. Tant que le
 *     document a changé depuis la dernière compilation, le panneau le DIT (« out of date ») plutôt
 *     que d'afficher des chiffres périmés comme s'ils étaient frais — et le VERROU, lui, ne les lit
 *     pas du tout : voir `freshFacts` plus bas. Des faits qui décrivent un AUTRE document sont pires
 *     que pas de faits, parce qu'ils servent d'alibi pour taire des refus bien réels.
 *  2. Les contrôles purs (contraste, liens, conformité, structure) sont recalculés à chaque frappe :
 *     eux ne mentent jamais.
 *  3. Un constat sans cible reste affiché, simplement non cliquable. On ne cache pas un problème
 *     parce qu'on n'a pas su le rattacher à un bloc.
 *  4. Le bouton « corriger » n'apparaît QUE sur les constats dont la réparation est déterminée par
 *     le constat lui-même, et il annonce le résultat exact avant d'être cliqué — quelle que soit la
 *     BOUCHE qui parle. Un même défaut change de source selon qu'une compilation a eu lieu (le
 *     pré-vol le dit, puis le compilateur prend le relais) : une réparation qui s'évanouirait à ce
 *     moment-là serait invisible dans l'état le plus courant du panneau. Aucune couleur n'est
 *     jamais repeinte automatiquement : choisir une couleur de marque est un arbitrage éditorial.
 *  5. Les constats qui disent la MÊME chose sont repliés sous une ligne unique, mais les COMPTEURS
 *     restent ceux des constats. Replier réduit le nombre de lignes, jamais le nombre de problèmes :
 *     un regroupement qui ferait baisser « 8 blocking » cacherait des blocages au lieu du bruit.
 *  6. Les boutons de LOT (barre du panneau, tête d'une ligne repliée) annoncent le nombre de BLOCS
 *     qui vont changer, pas le nombre de constats réparés — et cet ensemble est re-dérivé du
 *     document AU CLIC, jamais recopié de la liste affichée. Voir « Réparation de lot » plus bas.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wand2,
} from "lucide-react";
import type { Block, EmailDoc } from "@nf/render/schema";
import {
  clampMinCountFix,
  dropPlaceholderImageFix,
  GROUP_LABELS,
  httpsFix,
  appendLegalFooterFix,
  removeLegalFooterDuplicatesFix,
  runPreflight,
  type CompiledFacts,
  type PreflightFinding,
  type PreflightFix,
  type PreflightGroup,
  type PreflightReport,
  type PreflightTarget,
  type SizeFacts,
} from "@/lib/preflight";
import { groupByCause, type CauseGroup } from "@/lib/preflight/group";
import type { LifecycleKind } from "@nf/render/lifecycle-checks";
import { cn } from "@/lib/utils";
import { blockLabel } from "./canvas";
import type { ActiveColumn, Selection } from "./canvas";

/** Débounce de recompilation. Aligné sur l'autosave : une frappe ne déclenche pas un MJML. */
const RECHECK_MS = 2500;

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/* ------------------------------------------------------------------ *
 * Réparation de lot
 * ------------------------------------------------------------------ */

/**
 * LE LOT SE RE-DÉRIVE DU DOCUMENT, IL NE SE RAMASSE PAS DANS LA LISTE AFFICHÉE.
 *
 * Les fabriques de `lib/preflight` sont PURES et prennent le bloc courant : les rejouer au moment
 * du clic ne coûte rien et supprime trois défauts d'un coup, qu'aucun ramassage de `finding.fix`
 * ne saurait éviter :
 *   1. LES DOUBLONS. Cinq liens `http://` dans un menu, c'est cinq constats mais UNE réparation.
 *      Compter les constats annoncerait « 5 » là où un seul bloc change.
 *   2. LA LISTE PÉRIMÉE. Les constats `http://` et `ai://` viennent du COMPILATEUR, dont les faits
 *      sont recompilés avec 2,5 s de retard (`RECHECK_MS`). Un lien en clair collé il y a une
 *      seconde n'a encore produit AUCUN constat — la fabrique, elle, le voit tout de suite.
 *   3. LE RATTACHEMENT HEURISTIQUE. Un avertissement du compilateur arrive en TEXTE et se rattache
 *      à un bloc par correspondance ; le lot, lui, part du bloc et n'a rien à deviner.
 *
 * ⛔ CE QUE LE LOT NE PEUT PAS ATTEINDRE, ET C'EST VOULU : les articles nés d'un bloc flux. Ils
 * n'existent PAS dans le document de l'éditeur — `expandFeedBlocks()` les fabrique à la
 * compilation. Le parcours ci-dessous est celui de `doc.rows`, donc un article de flux ne peut ni
 * être compté ni être patché : le patch n'aurait aucune cible au prochain rendu. Le bloc `flux`
 * lui-même reste réparable (son plancher `minCount`), parce que lui est un vrai bloc du document.
 */

/** Tous les blocs du DOCUMENT DE L'ÉDITEUR, dans l'ordre. Jamais un article déplié d'un flux. */
function docBlocks(doc: EmailDoc): Block[] {
  return doc.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
}

/**
 * Signature STRUCTURELLE d'une réparation : les champs qu'elle écrit, plus les verbes qu'elle
 * porte. Sert à reconnaître « la même réparation » d'un rendu à l'autre sans lire son libellé —
 * un libellé est de l'interface, il bougera ; les champs écrits sont la mécanique.
 *
 * ⚠️ C'est ce qui permet au bouton d'une ligne repliée de ne réparer QUE la cause annoncée : un
 * article porteur d'un lien `http://` ET d'une sentinelle `ai://` ne doit pas perdre sa vignette
 * parce qu'on a cliqué sur la ligne des liens en clair.
 */
const signatureOf = (fix: PreflightFix): string =>
  [
    Object.keys(fix.patch).sort().join("+"),
    (fix.removeBlockIds ?? []).length,
    fix.insertRow ? "insert" : "",
  ].join("/");

/** Les blocs qu'une réparation AJOUTE au document. Vide si elle n'insère rien. */
const insertedBlocks = (fix: PreflightFix): Block[] =>
  (fix.insertRow?.row.columns ?? []).flatMap((column) => column.blocks);

/**
 * Identité d'une réparation, telle que le lot et les périmètres la comparent.
 *
 * ⛔ UNE INSERTION NE S'IDENTIFIE PAS PAR SON `blockId` : `appendLegalFooterFix()` fabrique ses ids
 * avec `newId()`, donc deux dérivations de la MÊME réparation en portent deux différents. Les
 * traiter comme deux réparations distinctes ferait pousser au lot deux insertions de footer ; la
 * seconde est refusée par le réducteur (le pied de page est unique), et comme un lot est
 * TOUT-OU-RIEN, le clic n'écrirait plus rien du tout — pas même les patchs qui, eux, allaient bien.
 * On identifie donc une insertion par ce qu'elle CRÉE (les types de blocs de sa row), ce qui est
 * stable d'une dérivation à l'autre.
 */
const scopeKey = (fix: PreflightFix): string =>
  fix.insertRow
    ? `insert:${insertedBlocks(fix)
        .map((b) => b.type)
        .join("+")}`
    : `${fix.blockId}#${signatureOf(fix)}`;

export interface FixBatch {
  fixes: PreflightFix[];
  /**
   * ⛔ Nombre de BLOCS réellement touchés — patchés, supprimés ou insérés — jamais le nombre de
   * constats.
   * C'est le seul chiffre que le bouton a le droit d'annoncer : cinq liens en clair dans un menu
   * font UN bloc réparé, et écrire « 5 » serait un compteur, pas une mesure.
   */
  blocks: number;
}

const EMPTY_BATCH: FixBatch = { fixes: [], blocks: 0 };

/**
 * Réparations mécaniques applicables au document TEL QU'IL EST maintenant.
 *
 * `scope` (clés de `scopeKey`) restreint le lot à une cause précise — c'est ce que passe la ligne
 * repliée. Absent = tout le document, seul cas où les réparations de niveau DOCUMENT entrent.
 */
export function collectFixes(doc: EmailDoc, findings: PreflightFinding[], scope?: Set<string>): FixBatch {
  const candidates: PreflightFix[] = [];
  const blocks = docBlocks(doc);
  const docIds = new Set(blocks.map((block) => block.id));

  // 1. Re-dérivation depuis le document : la seule source qui ne peut pas être en retard.
  for (const block of blocks) {
    for (const fix of [httpsFix(block), dropPlaceholderImageFix(block), clampMinCountFix(block)]) {
      if (fix) candidates.push(fix);
    }
  }

  // 2. Ce que le bloc seul ne suffit pas à re-dériver : le rognage d'un libellé dépend de la
  //    GÉOMÉTRIE de sa colonne, que seul `runPreflight` calcule. On reprend donc le correctif porté
  //    par le constat.
  //
  //    ⛔ CE FILTRE NE PORTE PLUS SUR L'ORIGINE DU CONSTAT, ET C'EST LE POINT. Il ne reprenait que
  //    les constats d'origine `preflight` ; or le MÊME défaut change de bouche selon l'état du
  //    panneau. Le footer légal manquant en est le cas vivant : sans faits compilés c'est le pré-vol
  //    qui le dit (`source: "preflight"`, correctif repris), et dès que la compilation arrive c'est
  //    le compilateur (`source: "compiler"`, correctif jeté). La réparation existait, elle était
  //    branchée, elle marchait — elle disparaissait de l'écran dans l'état le plus courant du
  //    panneau, celui où une compilation a eu lieu.
  //
  //    ⚠️ LA CRAINTE D'ORIGINE TENAIT, ON LA GARDE — MAIS CIBLÉE SUR CE QU'ELLE VISAIT VRAIMENT.
  //    Un avertissement du compilateur arrive en TEXTE et se rattache à un bloc par correspondance
  //    de sous-chaîne : ce qu'on ne veut pas, c'est patcher un bloc que ce rattachement a INVENTÉ —
  //    typiquement un article né d'un bloc flux, qui n'existe pas dans le document de l'éditeur.
  //    La question honnête n'est donc pas « d'où vient le constat ? » mais « la cible existe-t-elle
  //    dans le document ? ». C'est ce que mesure `docIds`, sur le document COURANT et au moment du
  //    clic. Une insertion échappe légitimement au test : elle apporte le bloc qu'elle nomme.
  //    (Rien n'est perdu du raisonnement de départ : les correctifs d'origine `compiler`/`schema`
  //    ne sont pas périmés — `runPreflight` les re-dérive du document qu'on lui passe, via les
  //    mêmes fabriques qu'au point 1 — et ceux de niveau bloc y sont déjà, donc ce point 2
  //    n'ajoute au lot GLOBAL que ce que le bloc seul ne sait pas produire.)
  for (const finding of findings) {
    const fix = finding.fix;
    if (!fix) continue;
    if (fix.insertRow === undefined && !docIds.has(fix.blockId)) continue;
    candidates.push(fix);
  }

  // 3. Structure de niveau DOCUMENT : aucun bloc ne les re-dérive. Réservé au lot GLOBAL, où le
  //    libellé énumère ce qui va changer — une ligne repliée n'annonce qu'une cause, elle ne peut
  //    pas embarquer une suppression que rien n'a annoncée.
  //
  //    ⚠️ `appendLegalFooterFix` est aussi porté par le constat du pré-vol (point 2) mais PAS par
  //    son jumeau du compilateur, qui n'en attache aucun. Le re-dériver ici est ce qui rend la
  //    réparation indépendante de la bouche qui parle : le doublon est absorbé par `scopeKey`, qui
  //    identifie une insertion par ce qu'elle crée et non par l'id qu'elle vient de tirer.
  if (scope === undefined) {
    const duplicates = removeLegalFooterDuplicatesFix(doc);
    if (duplicates) candidates.push(duplicates);
    const missingFooter = appendLegalFooterFix(doc);
    if (missingFooter) candidates.push(missingFooter);
  }

  const fixes: PreflightFix[] = [];
  const seen = new Set<string>();
  const written = new Map<string, Set<string>>();
  for (const fix of candidates) {
    const key = scopeKey(fix);
    if (scope !== undefined && !scope.has(key)) continue;
    if (seen.has(key)) continue;
    // ⛔ Deux réparations qui écriraient le MÊME champ du même bloc ne sont plus mécaniques : la
    // seconde effacerait le résultat de la première, et le compte de blocs mentirait sur ce qui a
    // vraiment été fait. Aucun couple de fabriques ne le fait aujourd'hui (une URL en clair ne peut
    // pas être en même temps une sentinelle `ai://`) ; le garde-fou existe pour que l'ajout d'une
    // fabrique se voie au banc plutôt que chez l'utilisateur.
    const taken = written.get(fix.blockId) ?? new Set<string>();
    const keys = Object.keys(fix.patch);
    if (keys.some((k) => taken.has(k))) continue;
    for (const k of keys) taken.add(k);
    written.set(fix.blockId, taken);
    seen.add(key);
    fixes.push(fix);
  }

  const touched = new Set<string>();
  for (const fix of fixes) {
    if (Object.keys(fix.patch).length > 0) touched.add(fix.blockId);
    for (const id of fix.removeBlockIds ?? []) touched.add(id);
    // ⚠️ Un bloc INSÉRÉ est un bloc que le document gagne : c'est bien un bloc qui change, et
    // l'annoncer est la seule façon que le bouton dise vrai. Ne compter que les patchs et les
    // suppressions faisait tomber à 0 une réparation purement structurelle (ajouter le footer) :
    // le bouton disparaissait alors qu'il avait quelque chose à écrire — l'inverse exact de la
    // règle qu'il porte, qui est d'annoncer ce qui va bouger.
    for (const block of insertedBlocks(fix)) touched.add(block.id);
  }
  return { fixes, blocks: touched.size };
}

/** Libellé du bouton de lot. Il dit des BLOCS, jamais des constats. */
const batchLabel = (batch: FixBatch): string =>
  batch.blocks === 1 ? "Fix 1 block" : `Fix ${batch.blocks} blocks`;

/** Ce que le lot va écrire, ligne par ligne — repris tel quel dans le `title` du bouton. */
const batchTitle = (batch: FixBatch): string =>
  `${batch.fixes.map((f) => `• ${f.label}`).join("\n")}\n\nApplied in one step, undoable with a single Ctrl+Z.`;

export interface Compiled {
  facts: CompiledFacts;
  /** Document EXACT qui a produit ces faits — l'identité de référence suffit à détecter la dérive. */
  forDoc: EmailDoc;
}

/**
 * Faits que le PRÉ-VOL a le droit de lire : ceux du document courant, et RIEN d'autre.
 *
 * ⛔ C'est la règle qui empêche le verrou de mentir, et elle est nommée ici plutôt qu'écrite en
 * ligne dans le composant pour qu'un banc puisse la mesurer sans monter de React.
 *
 * `runPreflight` se sert de la PRÉSENCE de faits compilés pour taire quatre refus du schéma (alt
 * manquant, sentinelle `ai://`, sujet vide, footer conditionnel) : le compilateur les dit mieux,
 * inutile de les écrire deux fois. Ce raisonnement ne tient QUE si le compilateur parle du même
 * document. Or les faits survivent à l'édition pendant tout le débounce (`RECHECK_MS`, dont le
 * timer repart à chaque frappe : la fenêtre dure tant que l'auteur tape). Les passer quand même
 * revenait à taire des refus au motif qu'un compilateur décrivant le document PRÉCÉDENT était censé
 * les avoir dits — `counts.blocking` tombait à 0, `canPublish` à vrai, « Publish » s'armait, et
 * `POST …/publish` répondait 422. Des faits périmés sont donc pires que pas de faits.
 */
export function factsForVerdict(compiled: Compiled | null, doc: EmailDoc): CompiledFacts | null {
  return compiled !== null && compiled.forDoc === doc ? compiled.facts : null;
}

export function PreflightPanel({
  doc,
  lifecycleKinds,
  onSelect,
  onSelectColumn,
  onReport,
  onApplyFixes,
}: {
  doc: EmailDoc;
  /**
   * Les kinds d'e-mail de cycle de vie servis par ce template (`lifecycle_template`, 0059).
   * ⛔ Le pré-vol doit dire EXACTEMENT ce que la publication refusera : sans eux, il laisserait
   * « Publish » armé sur un template de confirmation sans lien, et l'auteur prendrait un 422 sur un
   * écran qui vient de lui annoncer que tout va bien. Et la publication les contrôle TOUS : en
   * omettre un rouvre la même panne sur le template le plus engagé du produit.
   */
  lifecycleKinds?: LifecycleKind[] | null;
  onSelect: (selection: Selection) => void;
  onSelectColumn: (column: ActiveColumn) => void;
  /** Remonte le rapport à la coquille, qui s'en sert pour verrouiller « Publish ». */
  onReport?: (report: PreflightReport) => void;
  /**
   * Applique N réparations mécaniques. Le panneau ne touche jamais au document lui-même : il rend
   * des correctifs, la coquille les traduit en actions du réducteur pour que la correction entre
   * dans l'historique et se défasse d'un Ctrl+Z comme n'importe quelle édition.
   * Absent = les boutons « corriger » ne s'affichent pas.
   *
   * ⚠️ Un tableau, même pour une réparation seule : la coquille pousse TOUJOURS un lot, donc un
   * clic = une entrée d'historique, que le clic ait réparé un bloc ou six.
   */
  onApplyFixes?: (fixes: PreflightFix[]) => void;
}) {
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runSeq = useRef(0);

  const stale = compiled !== null && compiled.forDoc !== doc;

  // ⛔ Le verrou ne lit que des faits qui décrivent le document COURANT — voir `factsForVerdict`.
  // Périmés, ils ne passent pas : le schéma reprend la parole immédiatement, sans attendre les
  // 2,5 s de l'aller-retour serveur.
  const freshFacts = factsForVerdict(compiled, doc);

  /* ⚠️ ON DÉPEND DE LA CLÉ, PAS DU TABLEAU. Une nouvelle référence à chaque rendu rejouerait le
     pré-vol, qui remonte un rapport neuf à la coquille (`onReport`), qui re-rend — une boucle sans
     fin, pour un contenu identique. La liste est courte et figée par le serveur : sa forme texte la
     décrit entièrement. */
  const kindsKey = (lifecycleKinds ?? []).join("|");
  const kinds = useMemo<LifecycleKind[]>(
    () => (kindsKey === "" ? [] : (kindsKey.split("|") as LifecycleKind[])),
    [kindsKey],
  );

  const report = useMemo(() => runPreflight(doc, freshFacts, kinds), [doc, freshFacts, kinds]);

  /**
   * ⚠️ LE POIDS ET LE VERROU N'ONT PAS LE MÊME BESOIN, d'où cette seconde mesure.
   *
   * Le verrou n'a pas le droit de se tromper : une mesure datée y devient un mensonge, donc il
   * n'en reçoit aucune (`freshFacts`). La jauge, elle, tolère une valeur datée et la signale
   * (`stale` → opacité + « out of date » dans la barre) : la faire disparaître à chaque frappe pour
   * revenir 2,5 s plus tard donnerait un clignotement illisible, qui n'apprendrait rien de plus.
   *
   * On rejoue le pré-vol sur LE document que ces faits décrivent — un seul appel par compilation,
   * pas un par frappe — plutôt que de recalculer le ratio ici : ce serait une seconde implémentation
   * du seuil Gmail, vouée à dériver de celle qui bloque la publication.
   */
  const lastKnownSize = useMemo(
    () => (compiled === null ? null : runPreflight(compiled.forDoc, compiled.facts, kinds).size),
    [compiled, kinds],
  );

  // Déplié d'entrée si quelque chose bloque déjà : un compteur rouge sans la raison ne sert à rien.
  const [open, setOpen] = useState(report.counts.blocking > 0);

  useEffect(() => {
    onReport?.(report);
  }, [report, onReport]);

  const check = useCallback(async (target: EmailDoc) => {
    const seq = ++runSeq.current;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/builder/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: target }),
      });
      const body = (await res.json().catch(() => null)) as
        | { warnings?: string[]; sizeBytes?: number; hydratedBytes?: number; html?: string; text?: string; error?: string }
        | null;
      // Une frappe plus récente a déjà relancé : ce résultat est périmé avant d'être affiché.
      if (seq !== runSeq.current) return;
      if (!res.ok || !body) {
        setError(body?.error ?? `Checks failed (${res.status})`);
      } else {
        setCompiled({
          facts: {
            sizeBytes: Number(body.sizeBytes ?? 0),
            // ⚠️ Laisser `undefined` quand la route ne l'a pas rendu, JAMAIS 0 : le pré-vol
            // retombe alors sur le shell, alors qu'un 0 lui ferait juger un email vide.
            hydratedBytes: typeof body.hydratedBytes === "number" ? body.hydratedBytes : undefined,
            warnings: Array.isArray(body.warnings) ? body.warnings : [],
            // ⛔ Le HTML et le TEXTE compilés, pour que le contrôle des jetons de cycle de vie juge
            // le MÊME artefact que la publication. Un jeton peut vivre dans un bloc `html` opaque,
            // ou disparaître à la compilation : le document ne dit pas la vérité, le compilé si.
            html: typeof body.html === "string" ? body.html : undefined,
            text: typeof body.text === "string" ? body.text : undefined,
          },
          forDoc: target,
        });
      }
    } catch (err) {
      if (seq === runSeq.current) setError(err instanceof Error ? err.message : "Network error");
    } finally {
      if (seq === runSeq.current) setBusy(false);
    }
  }, []);

  // Première compilation immédiate (le verrou de publication ne doit pas rester aveugle), puis
  // recompilation débouncée à chaque pause de frappe.
  useEffect(() => {
    if (compiled !== null && compiled.forDoc === doc) return;
    const timer = setTimeout(() => void check(doc), compiled === null ? 0 : RECHECK_MS);
    return () => clearTimeout(timer);
  }, [doc, compiled, check]);

  // Un blocage doit se voir sans avoir à déplier : on ouvre le panneau la première fois qu'il apparaît.
  const hadBlocking = useRef(false);
  useEffect(() => {
    if (report.counts.blocking > 0 && !hadBlocking.current) setOpen(true);
    hadBlocking.current = report.counts.blocking > 0;
  }, [report.counts.blocking]);

  const focus = (target: PreflightTarget | undefined) => {
    if (!target) return;
    if (target.colId) onSelectColumn({ rowId: target.rowId, colId: target.colId });
    onSelect(target.blockId ? { kind: "block", id: target.blockId } : { kind: "row", id: target.rowId });

    // Sélectionner ne suffit pas : sur un email long, le bloc fautif peut être hors écran et le clic
    // semble alors ne rien faire. Le canvas pose `data-block-id` sur chaque bloc — c'est l'ancre.
    //
    // Un constat de RANGÉE n'a pas d'ancre à lui (le canvas n'expose pas `data-row-id`) : on vise
    // alors le premier bloc de la rangée, qui est au même endroit de l'écran. Une rangée vide n'a
    // rien à montrer, et la sélection ci-dessus l'a déjà mise en évidence dans l'inspecteur.
    const anchor =
      target.blockId ??
      doc.rows.find((row) => row.id === target.rowId)?.columns.flatMap((col) => col.blocks)[0]?.id;
    if (anchor === undefined) return;
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-block-id="${CSS.escape(anchor)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  const { blocking, advisory } = report.counts;
  const clean = blocking === 0 && advisory === 0;

  // Le lot affiché sort du DOCUMENT, pas de la liste : c'est ce qui rend le nombre annoncé honnête
  // même quand les faits du compilateur ont 2,5 s de retard.
  const batch = useMemo(() => collectFixes(doc, report.findings), [doc, report.findings]);
  const applyAll = () => {
    // ⛔ Re-dérivation AU CLIC, sur le même document : le nombre lu sur le bouton et l'ensemble
    // réellement appliqué sortent du même appel, jamais d'un état capturé au rendu précédent.
    const fresh = collectFixes(doc, report.findings);
    if (fresh.fixes.length > 0) onApplyFixes?.(fresh.fixes);
  };

  return (
    <div
      className={cn(
        "mb-4 rounded-[12px] border bg-card",
        blocking > 0 ? "border-[#f3c9c9]" : "border-border",
      )}
    >
      {/* -------------------------------------------------------- Barre */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-2 rounded-[8px] px-1.5 py-1 text-[12.5px] font-semibold transition-colors hover:bg-accent"
        >
          {open ? (
            <ChevronDown className="h-[15px] w-[15px] text-muted-foreground" strokeWidth={2} />
          ) : (
            <ChevronRight className="h-[15px] w-[15px] text-muted-foreground" strokeWidth={2} />
          )}
          {blocking > 0 ? (
            <ShieldAlert className="h-4 w-4 text-[#c33]" strokeWidth={2} />
          ) : (
            <ShieldCheck className={cn("h-4 w-4", clean ? "text-[#1f9d57]" : "text-muted-foreground")} strokeWidth={2} />
          )}
          Checks
        </button>

        <div className="flex items-center gap-1.5 text-[11.5px]">
          {blocking > 0 && (
            <span className="rounded-full bg-[#fdecec] px-2 py-[3px] font-semibold text-[#c33]">
              {blocking} blocking
            </span>
          )}
          {advisory > 0 && (
            <span className="rounded-full bg-[#fdf0dd] px-2 py-[3px] font-semibold text-[#b9790a]">
              {advisory} advisory
            </span>
          )}
          {clean && (
            <span className="rounded-full bg-[#e2f5e9] px-2 py-[3px] font-semibold text-[#1f9d57]">
              Nothing to fix
            </span>
          )}
        </div>

        <SizeGauge size={lastKnownSize} stale={stale} />

        {/* Le point d'entrée du « un clic au lieu de huit ». Il n'apparaît que s'il a quelque chose
            à faire, et son libellé compte des BLOCS : c'est ce qui va changer dans le document. */}
        {onApplyFixes && batch.blocks > 0 && (
          <button
            type="button"
            onClick={applyAll}
            title={batchTitle(batch)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[8px] border border-border bg-card px-2.5 py-[5px] text-[11.5px] font-semibold text-foreground transition-colors hover:bg-accent"
          >
            <Wand2 className="h-[13px] w-[13px] shrink-0" strokeWidth={2.2} />
            {batchLabel(batch)}
          </button>
        )}

        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {busy && (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Compiling…
            </span>
          )}
          {!busy && stale && <span className="text-[#b9790a]">Size and compiler checks are out of date</span>}
          {error && <span className="text-[#c33]">{error}</span>}
          <button
            type="button"
            onClick={() => void check(doc)}
            disabled={busy}
            title="Re-compile and re-run every check"
            className={cn(
              "rounded-[7px] p-1.5 transition-colors",
              busy ? "cursor-not-allowed opacity-40" : "hover:bg-accent hover:text-foreground",
            )}
          >
            <RefreshCw className="h-[14px] w-[14px]" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* -------------------------------------------------------- Détail */}
      {open && (
        <div className="border-t border-border px-3 py-3">
          {report.findings.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              Weight, contrast, links, images, structure and compliance all pass. Preview still shows the real
              compiled email — these checks read the document, not a rendering.
            </p>
          ) : (
            <FindingList doc={doc} findings={report.findings} onFocus={focus} onApplyFixes={onApplyFixes} />
          )}
          {compiled === null && !busy && (
            <p className="mt-3 text-[11.5px] text-[#b9790a]">
              No compile yet — weight and compiler checks (missing alt text, placeholder images, empty subject) are
              not included in the counts above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Jauge de poids
 * ------------------------------------------------------------------ */

/**
 * ⚠️ La jauge reçoit la DERNIÈRE mesure connue, pas celle du rapport : le rapport, lui, n'accepte
 * que des faits frais et n'a donc plus de poids à afficher pendant la recompilation. `stale` dit
 * que la valeur date du document précédent — elle reste lisible, elle ne se fait pas passer pour
 * fraîche.
 */
function SizeGauge({ size, stale }: { size: SizeFacts | null; stale: boolean }) {
  if (!size) {
    return <span className="text-[11.5px] text-muted-foreground">Size unknown</span>;
  }
  const pct = Math.min(100, Math.round(size.ratio * 100));
  const tone = size.over ? "bg-[#c33]" : size.ratio >= 0.9 ? "bg-[#e0a020]" : "bg-[#1f9d57]";

  return (
    <span
      className={cn("flex items-center gap-2 text-[11.5px] tabular-nums", stale && "opacity-50")}
      title={
        size.over
          ? `${kb(size.bytes - size.limit)} over the Gmail clipping threshold`
          : `${kb(size.remaining)} left before Gmail clips the message`
      }
    >
      <span className="h-1.5 w-[90px] overflow-hidden rounded-full bg-accent">
        <span className={cn("block h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </span>
      <span className={size.over ? "font-semibold text-[#c33]" : "text-muted-foreground"}>
        {kb(size.bytes)} / {kb(size.limit)}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Liste des constats
 * ------------------------------------------------------------------ */

function FindingList({
  doc,
  findings,
  onFocus,
  onApplyFixes,
}: {
  doc: EmailDoc;
  findings: PreflightFinding[];
  onFocus: (target: PreflightTarget | undefined) => void;
  onApplyFixes?: (fixes: PreflightFix[]) => void;
}) {
  const blocking = findings.filter((f) => f.level === "blocking");
  const advisory = findings.filter((f) => f.level === "advisory");

  // Les constats consultatifs sont regroupés par famille : dix lignes en vrac ne se lisent pas.
  const groups: [PreflightGroup, PreflightFinding[]][] = [];
  for (const finding of advisory) {
    const last = groups[groups.length - 1];
    if (last && last[0] === finding.group) last[1].push(finding);
    else groups.push([finding.group, [finding]]);
  }

  return (
    <div className="space-y-3">
      {blocking.length > 0 && (
        <section>
          {/* ⛔ Le compte annoncé est celui des CONSTATS, jamais celui des lignes affichées : sinon
              replier ferait disparaître des blocages de l'écran ET du compteur, et le panneau
              mentirait exactement là où il doit alerter. */}
          <SectionLabel tone="red">Publication blocked — {blocking.length}</SectionLabel>
          <CauseList doc={doc} findings={blocking} onFocus={onFocus} onApplyFixes={onApplyFixes} />
        </section>
      )}

      {groups.map(([group, list]) => (
        <section key={group}>
          <SectionLabel tone="muted">
            {GROUP_LABELS[group]} — {list.length}
          </SectionLabel>
          <CauseList doc={doc} findings={list} onFocus={onFocus} onApplyFixes={onApplyFixes} />
        </section>
      ))}
    </div>
  );
}

function CauseList({
  doc,
  findings,
  onFocus,
  onApplyFixes,
}: {
  doc: EmailDoc;
  findings: PreflightFinding[];
  onFocus: (target: PreflightTarget | undefined) => void;
  onApplyFixes?: (fixes: PreflightFix[]) => void;
}) {
  return (
    <div className="space-y-1">
      {groupByCause(findings).map((cause) =>
        // Une occurrence isolée reste la ligne d'avant : un chevron et un « 1 × » pour un seul
        // constat ajouteraient un geste sans rien résumer.
        cause.findings.length === 1 ? (
          <FindingRow key={cause.head.id} doc={doc} finding={cause.head} onFocus={onFocus} onApplyFixes={onApplyFixes} />
        ) : (
          <CauseRow key={cause.key} doc={doc} cause={cause} onFocus={onFocus} onApplyFixes={onApplyFixes} />
        ),
      )}
    </div>
  );
}

/**
 * Une cause, ses occurrences repliées dessous.
 *
 * Replié par défaut : le lot n'existe que parce que lire cinq fois la même phrase ne dit rien de
 * plus que la lire une fois. Le nombre est écrit DANS la ligne — le lecteur retrouve à l'œil le
 * total annoncé en tête de section, et aucune occurrence n'est perdue : elles sont toutes là,
 * cliquables, un chevron plus loin.
 */
function CauseRow({
  doc,
  cause,
  onFocus,
  onApplyFixes,
}: {
  doc: EmailDoc;
  cause: CauseGroup;
  onFocus: (target: PreflightTarget | undefined) => void;
  onApplyFixes?: (fixes: PreflightFix[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const blocking = cause.head.level === "blocking";
  const count = cause.findings.length;

  // La cause repliée est LE cas d'usage du lot : « 5 × … » n'offrait aucun bouton, il fallait
  // déplier puis cliquer cinq fois. Le périmètre est la SIGNATURE des correctifs de cette
  // cause-là — pas les blocs qu'elle touche : un article porteur d'un lien en clair ET d'une
  // sentinelle `ai://` ne doit perdre que ce que la ligne annonce.
  const scope = useMemo(() => {
    const keys = new Set<string>();
    for (const finding of cause.findings) if (finding.fix) keys.add(scopeKey(finding.fix));
    return keys;
  }, [cause.findings]);
  const batch = useMemo(
    () => (scope.size === 0 ? EMPTY_BATCH : collectFixes(doc, cause.findings, scope)),
    [doc, cause.findings, scope],
  );
  const applyCause = () => {
    const fresh = collectFixes(doc, cause.findings, scope);
    if (fresh.fixes.length > 0) onApplyFixes?.(fresh.fixes);
  };

  return (
    <div>
      <div
        className={cn(
          "flex w-full items-start gap-1 rounded-[9px] pr-1",
          blocking ? "bg-[#fdecec]/60" : "bg-transparent",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? `Hide the ${count} blocks` : `Show the ${count} blocks this is about`}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors",
            blocking ? "hover:bg-[#fdecec]" : "hover:bg-accent",
          )}
        >
          <span className="mt-[6px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            {blocking ? (
              <AlertTriangle className="h-3.5 w-3.5 text-[#c33]" strokeWidth={2.2} />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-[#e0a020]" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn("block text-[12.5px] leading-snug text-foreground", blocking && "font-medium")}>
              <span className="font-semibold tabular-nums">{count} ×</span> {cause.label}
            </span>
          </span>
          {open ? (
            <ChevronDown className="mt-[4px] h-[14px] w-[14px] shrink-0 text-muted-foreground" strokeWidth={2} />
          ) : (
            <ChevronRight className="mt-[4px] h-[14px] w-[14px] shrink-0 text-muted-foreground" strokeWidth={2} />
          )}
        </button>

        {onApplyFixes && batch.blocks > 0 && (
          <button
            type="button"
            onClick={applyCause}
            title={batchTitle(batch)}
            className="mt-[3px] inline-flex max-w-[190px] shrink-0 items-center gap-1 truncate rounded-[7px] border border-border bg-card px-2 py-[3px] text-[10.5px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Wand2 className="h-3 w-3 shrink-0" strokeWidth={2.2} />
            <span className="truncate">{batchLabel(batch)}</span>
          </button>
        )}
      </div>

      {open && (
        <div className="ml-[9px] mt-1 space-y-1 border-l border-border pl-[9px]">
          {cause.findings.map((f) => (
            <FindingRow key={f.id} doc={doc} finding={f} onFocus={onFocus} onApplyFixes={onApplyFixes} />
          ))}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ tone, children }: { tone: "red" | "muted"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em]",
        tone === "red" ? "text-[#c33]" : "text-muted-foreground/70",
      )}
    >
      {children}
    </div>
  );
}

function FindingRow({
  doc,
  finding,
  onFocus,
  onApplyFixes,
}: {
  doc: EmailDoc;
  finding: PreflightFinding;
  onFocus: (target: PreflightTarget | undefined) => void;
  onApplyFixes?: (fixes: PreflightFix[]) => void;
}) {
  const clickable = finding.target !== undefined;
  const blocking = finding.level === "blocking";
  const fix = onApplyFixes !== undefined ? finding.fix : undefined;
  // ⚠️ Le constat isolé passe par le MÊME chemin que le lot : re-dérivation au clic, sur le
  // document courant. Sans ça, deux boutons voisins appliqueraient deux versions du même
  // correctif — celui capturé au rendu ici, celui re-dérivé là.
  const applyOne = () => {
    if (!fix) return;
    const fresh = collectFixes(doc, [finding], new Set([scopeKey(fix)]));
    if (fresh.fixes.length > 0) onApplyFixes?.(fresh.fixes);
  };

  const body = (
    <>
      <span className="mt-[6px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {blocking ? (
          <AlertTriangle className="h-3.5 w-3.5 text-[#c33]" strokeWidth={2.2} />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-[#e0a020]" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[12.5px] leading-snug", blocking ? "font-medium text-foreground" : "text-foreground")}>
          {finding.message}
        </span>
        {finding.detail && (
          <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">{finding.detail}</span>
        )}
      </span>
      {finding.target?.blockType && (
        <span className="mt-[3px] shrink-0 rounded-full bg-accent px-2 py-[2px] text-[10.5px] font-semibold text-muted-foreground">
          {/* ⚠️ `blockLabel` et non `BLOCK_LABELS` : la cible d'un constat peut être un bloc flux, que
              la palette ne liste pas — l'étiquette resterait vide sur le type de bloc dont le pré-vol
              a justement le plus à dire. */}
          {blockLabel(finding.target.blockType)}
        </span>
      )}
    </>
  );

  // Le corps du constat et le bouton « corriger » sont DEUX commandes distinctes : imbriquer un
  // bouton dans un bouton est invalide en HTML, et le clic deviendrait ambigu (sélectionner ? ou
  // réparer ?). D'où le conteneur neutre qui les porte côte à côte.
  return (
    <div
      className={cn(
        "flex w-full items-start gap-1 rounded-[9px] pr-1",
        blocking ? "bg-[#fdecec]/60" : "bg-transparent",
      )}
    >
      {clickable ? (
        <button
          type="button"
          onClick={() => onFocus(finding.target)}
          title="Select the block this is about"
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors",
            blocking ? "hover:bg-[#fdecec]" : "hover:bg-accent",
          )}
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left">{body}</div>
      )}

      {fix && (
        <button
          type="button"
          onClick={applyOne}
          // Le libellé DIT le résultat exact : on ne clique pas sur une promesse, on clique sur ce
          // qui va être écrit. Un `title` reprend le texte complet si la place manque.
          title={`${fix.label} — applied to the document, undoable with Ctrl+Z`}
          className="mt-[3px] inline-flex max-w-[190px] shrink-0 items-center gap-1 truncate rounded-[7px] border border-border bg-card px-2 py-[3px] text-[10.5px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Wand2 className="h-3 w-3 shrink-0" strokeWidth={2.2} />
          <span className="truncate">{fix.label}</span>
        </button>
      )}
    </div>
  );
}
