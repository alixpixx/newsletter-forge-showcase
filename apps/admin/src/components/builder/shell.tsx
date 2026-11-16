"use client";

/**
 * BUILDER SHELL — orchestration de l'éditeur.
 *
 * L'ÉTAT EST LE DOCUMENT (`useReducer` sur l'EmailDoc, cf. `reducer.ts`). Tout le reste — sélection,
 * statut de sauvegarde, dialogues — est périphérique.
 *
 * Règles d'honnêteté tenues ici :
 *  • Autosave : `PATCH …/draft` avec `baseUpdatedAt`. Un 409 ARRÊTE l'autosave et affiche un
 *    bandeau : on n'écrase jamais en silence le travail d'un autre onglet.
 *  • ⛔ Corollaire : le 409 doit rester le SIGNE d'un vrai conflit. Toute sauvegarde passe donc par
 *    `save` — jamais deux PATCH concurrents avec le même `baseUpdatedAt`, qui s'auto-annonceraient
 *    en conflit avec eux-mêmes et pousseraient l'auteur à jeter son travail.
 *  • ⛔ Un document venu du serveur est VALIDÉ avant d'entrer dans le reducer, exactement comme au
 *    chargement initial : un cast n'a jamais vérifié qu'une charge utile respecte le schéma.
 *  • Publication : le brouillon est sauvegardé D'ABORD. Publier ce qui est à l'écran sans l'avoir
 *    enregistré publierait une version différente de ce qu'on voit.
 *  • Test : « Queued » ne s'affiche que si l'API a répondu 2xx. Aucun faux succès optimiste.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  Loader2,
  MailCheck,
  Newspaper,
  Palette as PaletteIcon,
  Redo2,
  RotateCcw,
  Send,
  Undo2,
  UploadCloud,
} from "lucide-react";
import { EmailDoc, newId, type Row } from "@nf/render/schema";
import type { PreflightReport } from "@/lib/preflight";
import { Btn, Pill } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Canvas, type ActiveColumn, type Selection } from "./canvas";
import { Inspector } from "./inspector";
import { Modal } from "./modal";
import { Palette, resolveTarget } from "./palette";
import type { LifecycleKind } from "@nf/render/lifecycle-checks";
import { adresseSysteme, isLifecycleEditable } from "@/lib/automations";
import { LIFECYCLE_LABELS } from "@/components/templates/lifecycle-labels";
import { PreflightPanel } from "./preflight-panel";
import { PreviewDialog } from "./preview";
import { WpImportDialog } from "./wp-import";
import { ImportTemplateDialog } from "./import-template-dialog";
import { actionsForFix, builderReducer, initBuilderState } from "./reducer";

const AUTOSAVE_MS = 800;

type SaveStatus =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "error"; message: string }
  // ⚠️ `reloadError` : un rechargement REFUSÉ ne doit pas remplacer le bandeau de conflit par une
  // pastille d'erreur — cela retirerait de l'écran le seul bouton « Reload » et l'auteur resterait
  // coincé, autosave éteint, sans aucune sortie. Le conflit reste affiché, le refus s'y ajoute.
  | { kind: "conflict"; serverUpdatedAt: string | null; reloadError?: string };

const hhmm = (d: Date): string => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* corps non-JSON : on garde le statut HTTP */
  }
  return `Request failed (${res.status})`;
}

export function BuilderShell({
  templateId,
  templateName,
  doc: initialDoc,
  subject,
  preheader,
  updatedAt,
  assetName,
  publishedVersion,
  lifecycleKinds,
}: {
  templateId: string;
  templateName: string;
  doc: EmailDoc;
  subject: string;
  preheader: string;
  /** Jeton anti-conflit renvoyé tel quel dans `baseUpdatedAt`. */
  updatedAt: string;
  assetName: string;
  publishedVersion: number | null;
  /**
   * Les kinds d'e-mail de cycle de vie que ce template sert (`lifecycle_template`, 0059) — vide
   * pour presque tous les templates.
   *
   * ⛔ ILS DOIVENT DESCENDRE JUSQU'AU PRÉ-VOL, ET TOUS. Sans eux, le panneau ignore que ce template
   * sert une confirmation, laisse le bouton « Publish » armé, et l'auteur reçoit un 422 sur un
   * écran qui vient de lui dire que tout va bien. Et à l'inverse, un pré-vol qui les supposerait
   * ferait rougir TOUS les templates ordinaires. N'en descendre qu'un rouvre la même panne dès
   * qu'un template en sert deux : la publication, elle, les contrôle tous.
   */
  lifecycleKinds: LifecycleKind[];
}) {
  // Les colonnes `subject`/`preheader` de la ligne font foi pour les listes : on les aligne d'emblée
  // sur `meta`, et on considère ce document comme déjà enregistré (pas de sauvegarde parasite).
  const bootDoc = useMemo<EmailDoc>(
    () => ({ ...initialDoc, meta: { ...initialDoc.meta, subject, preheader } }),
    [initialDoc, subject, preheader],
  );

  const [state, dispatch] = useReducer(builderReducer, bootDoc, initBuilderState);
  const doc = state.present;

  const [selection, setSelection] = useState<Selection>(null);
  const [activeColumn, setActiveColumn] = useState<ActiveColumn | null>(null);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [showPreview, setShowPreview] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [showWpImport, setShowWpImport] = useState(false);
  const [showImportTemplate, setShowImportTemplate] = useState(false);
  /** Ce que la dernière insertion WordPress a produit — annoncé une fois, sous la barre d'outils. */
  const [wpNotice, setWpNotice] = useState<string | null>(null);
  const [showPublish, setShowPublish] = useState(false);
  const [showTest, setShowTest] = useState(false);
  // Rapport de pré-vol remonté par le panneau : il conditionne le bouton « Publish ».
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);

  const savedDoc = useRef<EmailDoc>(bootDoc);
  const baseUpdatedAt = useRef<string>(updatedAt);
  const conflicted = useRef(false);

  // Dernier document COMMITÉ. `sendDraft` le lit à l'instant de l'envoi et non à sa création : sans
  // ça la fonction devrait dépendre de `doc`, changer d'identité à chaque frappe, et le débounce
  // ci-dessous ne pourrait plus garder un timer stable qu'un appel externe sait désarmer.
  const docRef = useRef<EmailDoc>(bootDoc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  /** Timer du débounce, dans une ref : un appel EXTERNE à `save` doit pouvoir le désarmer. */
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Sauvegarde EN VOL. C'est une file d'attente, pas un verrou — cf. `save`. */
  const inFlight = useRef<Promise<boolean> | null>(null);
  /** `updatedAt` annoncé par le 409 — conservé pour réafficher le conflit après un refus de reload. */
  const conflictServerUpdatedAt = useRef<string | null>(null);

  const dirty = doc !== savedDoc.current;

  /* ---------------------------------------------------------------- Autosave */

  const disarmAutosave = useCallback(() => {
    if (autosaveTimer.current === null) return;
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
  }, []);

  /** L'aller-retour lui-même. ⛔ Ne JAMAIS l'appeler directement : passer par `save`. */
  const sendDraft = useCallback(async (): Promise<boolean> => {
    if (conflicted.current) return false;
    const snapshot = docRef.current;
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(`/api/builder/templates/${templateId}/draft`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc: snapshot,
          subject: snapshot.meta.subject,
          preheader: snapshot.meta.preheader,
          baseUpdatedAt: baseUpdatedAt.current,
        }),
      });

      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { updatedAt?: string } | null;
        conflicted.current = true;
        conflictServerUpdatedAt.current = body?.updatedAt ?? null;
        setStatus({ kind: "conflict", serverUpdatedAt: conflictServerUpdatedAt.current });
        return false;
      }
      if (!res.ok) {
        setStatus({ kind: "error", message: await readError(res) });
        return false;
      }

      const body = (await res.json().catch(() => null)) as { updatedAt?: string } | null;
      if (body?.updatedAt) baseUpdatedAt.current = body.updatedAt;
      savedDoc.current = snapshot;
      setStatus({ kind: "saved", at: hhmm(new Date()) });
      return true;
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Network error" });
      return false;
    }
  }, [templateId]);

  /**
   * SEULE porte d'entrée de la sauvegarde — autosave, publication, envoi de test, bouton « retry ».
   *
   * ⛔ Deux PATCH concurrents partiraient avec le MÊME `baseUpdatedAt` : le serveur écrit le premier
   * (compare-and-swap sur `updated_at`) et refuse le second en 409. L'éditeur annoncerait alors
   * « This draft changed in another tab or by another user » alors que personne d'autre n'y a
   * touché, arrêterait l'autosave, et n'offrirait pour sortir qu'un rechargement qui JETTE le
   * travail local. Le conflit serait inventé de toutes pièces. D'où les deux gardes :
   *  1. l'appel désarme le timer de débounce, sinon il part en parallèle de l'appel externe ;
   *  2. une sauvegarde déjà en vol n'est pas doublée — on l'ATTEND.
   *
   * ⚠️ Attendre ne suffit pas : la sauvegarde en vol portait un instantané ANTÉRIEUR. Si le document
   * a bougé depuis (l'auteur tape pendant l'enregistrement), il FAUT un second aller-retour, sinon
   * on publierait autre chose que ce qui est à l'écran. C'est une file, pas un verrou : on ne
   * s'économise le second envoi que si le document affiché est déjà celui qui vient d'être écrit.
   */
  const save = useCallback((): Promise<boolean> => {
    disarmAutosave();
    const pending = inFlight.current;
    const run = (async (): Promise<boolean> => {
      if (pending) {
        const ok = await pending;
        if (!ok) return false;
        if (docRef.current === savedDoc.current) return true;
      }
      return sendDraft();
    })();
    inFlight.current = run;
    const release = () => {
      // ⚠️ Un appel plus récent a pu prendre la place : ne libérer que SA propre promesse.
      if (inFlight.current === run) inFlight.current = null;
    };
    void run.then(release, release);
    return run;
  }, [disarmAutosave, sendDraft]);

  // Débounce : une frappe ne déclenche pas un PATCH, une pause de 800 ms oui.
  // ⚠️ `save` est stable : l'effet ne se rejoue que si le document ou l'état « sale » bougent. Une
  // frappe PENDANT un enregistrement rearme donc bien un timer — la modification n'est pas perdue.
  useEffect(() => {
    if (!dirty || conflicted.current) return;
    setStatus((s) => (s.kind === "saving" ? s : { kind: "dirty" }));
    const timer = setTimeout(() => {
      autosaveTimer.current = null;
      void save();
    }, AUTOSAVE_MS);
    autosaveTimer.current = timer;
    return () => {
      if (autosaveTimer.current === timer) autosaveTimer.current = null;
      clearTimeout(timer);
    };
  }, [doc, dirty, save]);

  // Un onglet fermé pendant la fenêtre de débounce perdrait la dernière frappe → on prévient.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /** Recharge le brouillon du serveur — SEULE sortie du conflit, et elle jette les édits locaux. */
  const reloadFromServer = useCallback(async () => {
    // Un refus laisse le conflit EN PLACE (donc le bouton « Reload » accessible) et y accroche sa
    // raison ; hors conflit, il retombe sur la pastille d'erreur ordinaire.
    const refuse = (message: string) =>
      setStatus(
        conflicted.current
          ? { kind: "conflict", serverUpdatedAt: conflictServerUpdatedAt.current, reloadError: message }
          : { kind: "error", message },
      );

    setStatus({ kind: "saving" });
    try {
      const res = await fetch(`/api/builder/templates/${templateId}`, { cache: "no-store" });
      if (!res.ok) {
        refuse(await readError(res));
        return;
      }
      const body = (await res.json()) as { draft?: { doc?: unknown; updatedAt?: string } };
      if (!body.draft?.doc || typeof body.draft.doc !== "object") {
        refuse("The server returned no draft to reload.");
        return;
      }
      // ⛔ MÊME porte que le chargement initial (`app/(dashboard)/builder/[id]/page.tsx`), qui
      // REFUSE d'ouvrir l'éditeur sur un document hors schéma. Ce chemin-ci contournait la porte
      // par un simple `as EmailDoc` : un document invalide s'installait à l'écran et le canvas
      // lisait des champs absents. Un cast n'a jamais validé quoi que ce soit.
      const parsed = EmailDoc.safeParse(body.draft.doc);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        refuse(
          `The server draft does not match the current schema${
            issue ? ` (${issue.path.join(".") || "(root)"}: ${issue.message})` : ""
          }, so it was not loaded. Restore a published version from the template's version history.`,
        );
        return;
      }
      const fresh = parsed.data;
      conflicted.current = false;
      baseUpdatedAt.current = body.draft?.updatedAt ?? baseUpdatedAt.current;
      savedDoc.current = fresh;
      docRef.current = fresh;
      setSelection(null);
      setActiveColumn(null);
      dispatch({ type: "setDoc", doc: fresh, resetHistory: true });
      setStatus({ kind: "saved", at: hhmm(new Date()) });
    } catch (err) {
      refuse(err instanceof Error ? err.message : "Network error");
    }
  }, [templateId]);

  /* ---------------------------------------------------------------- Undo / redo */

  const canUndo = state.past.length > 0;
  const canRedo = state.future.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      // Dans un champ de saisie, ⌘Z appartient au navigateur (annuler la frappe) — on ne le vole pas.
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;

      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "undo" });
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------------------------------------------------------------- Actions */

  function pasteHtml(raw: string) {
    const target = resolveTarget(doc, activeColumn);
    if (!target) return;
    const block = { id: newId("blk"), type: "html" as const, raw: raw.slice(0, 200_000) };
    dispatch({ type: "addBlock", rowId: target.rowId, colId: target.colId, block, index: target.index });
    // La colonne seule : voir `placeBlock` dans la palette.
    setActiveColumn({ rowId: target.rowId, colId: target.colId });
    setSelection({ kind: "block", id: block.id });
    setShowPaste(false);
  }

  /**
   * Insertion d'une fournée d'articles WordPress.
   *
   * UNE seule action pour N lignes : l'auteur a fait un clic, il doit pouvoir le défaire d'un
   * Ctrl+Z. `insertRows` est aussi tout-ou-rien — un document à moitié rempli après un refus
   * partiel serait pire que pas d'insertion du tout.
   *
   * La sélection saute sur le PREMIER article inséré : sans ça, cinq lignes apparaissent quelque
   * part dans un long document et il faut les chercher.
   */
  function insertWpRows(rows: Row[], summary: string) {
    dispatch({ type: "insertRows", rows });
    const first = rows[0]?.columns[0]?.blocks[0];
    if (first) setSelection({ kind: "block", id: first.id });
    setWpNotice(summary);
  }

  const conflict = status.kind === "conflict";
  const reloadError = status.kind === "conflict" ? status.reloadError : undefined;
  // Un bouton qui échoue APRÈS le clic n'apprend rien : les constats bloquants désarment le bouton
  // et disent lesquels, dans son `title` et dans le panneau juste en dessous.
  const blockers = preflight?.findings.filter((f) => f.level === "blocking") ?? [];

  /*
   * ⛔ LE BOUTON S'ARME SUR `canPublish`, JAMAIS SUR LE SEUL COMPTE DE BLOCAGES.
   *
   * « aucun blocage trouvé » et « publiable » ne sont pas la même affirmation : tant qu'aucune
   * compilation n'a eu lieu, le pré-vol n'a pas VU le HTML, donc il ignore le poids et tout ce que
   * seul le compilateur sait dire. `runPreflight` refuse pour cette raison d'affirmer `canPublish`
   * sans faits compilés — mais ce verrou n'avait ici aucun lecteur : le bouton comptait les
   * blocages lui-même et s'armait pendant toute la fenêtre de recompilation, sur un document que
   * `POST …/publish` refuse en 422.
   *
   * ⚠️ Poser un verrou que personne ne lit revient à ne pas l'avoir posé. Le compte de blocages ne
   * sert plus qu'à ÉCRIRE la raison ; c'est `canPublish` qui DÉCIDE.
   */
  const canPublish = preflight?.canPublish ?? false;
  const publishBlockedReason =
    blockers.length > 0
      ? `Publishing is blocked by ${blockers.length} pre-flight ${blockers.length === 1 ? "issue" : "issues"}: ${blockers
          .map((f) => f.message)
          .join(" · ")}`
      : "Checking this email — publishing opens as soon as the preview has been compiled.";

  return (
    <div className="animate-fade-up">
      {/* ---------------------------------------------------------- En-tête */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/builder"
            className="inline-flex items-center gap-1.5 rounded-[9px] border border-border bg-card px-2.5 py-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={2} />
            Templates
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-[17px] font-bold tracking-tight">{templateName}</h1>
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Pill tone="pink" dot>
                {assetName}
              </Pill>
              <span>{publishedVersion === null ? "Never published" : `Published v${publishedVersion}`}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SaveIndicator status={status} dirty={dirty} onRetry={() => void save()} />

          <div className="inline-flex rounded-[9px] border border-border bg-card p-0.5">
            <button
              type="button"
              aria-label="Undo"
              title="Undo (Ctrl/⌘ Z)"
              disabled={!canUndo}
              onClick={() => dispatch({ type: "undo" })}
              className={cn(
                "rounded-[7px] p-1.5 transition-colors",
                canUndo ? "text-muted-foreground hover:bg-accent hover:text-foreground" : "cursor-not-allowed opacity-35",
              )}
            >
              <Undo2 className="h-[15px] w-[15px]" strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label="Redo"
              title="Redo (Ctrl/⌘ ⇧ Z)"
              disabled={!canRedo}
              onClick={() => dispatch({ type: "redo" })}
              className={cn(
                "rounded-[7px] p-1.5 transition-colors",
                canRedo ? "text-muted-foreground hover:bg-accent hover:text-foreground" : "cursor-not-allowed opacity-35",
              )}
            >
              <Redo2 className="h-[15px] w-[15px]" strokeWidth={2} />
            </button>
          </div>

          {/* Styles de l'e-mail entier (24/09/2026) : désélectionner, c'est ce qui ouvre le panneau. */}
          <Btn onClick={() => setSelection(null)} title="Colours and fonts of the whole email">
            <PaletteIcon className="h-[15px] w-[15px]" strokeWidth={2} /> Styles
          </Btn>
          <Btn onClick={() => setShowPreview(true)}>
            <Eye className="h-[15px] w-[15px]" strokeWidth={2} /> Preview
          </Btn>
          <Btn onClick={() => setShowTest(true)}>
            <Send className="h-[15px] w-[15px]" strokeWidth={2} /> Send test
          </Btn>
          <Btn
            variant="primary"
            disabled={!canPublish}
            title={canPublish ? undefined : publishBlockedReason}
            onClick={() => setShowPublish(true)}
          >
            {blockers.length > 0 ? (
              <>
                <AlertTriangle className="h-[15px] w-[15px]" strokeWidth={2} /> Publish blocked ({blockers.length})
              </>
            ) : !canPublish ? (
              // Ni bloqué ni publiable : le HTML n'a pas encore été compilé. Le dire, plutôt que de
              // montrer « Publish blocked (0) », qui se lirait comme une panne.
              <>
                <UploadCloud className="h-[15px] w-[15px]" strokeWidth={2} /> Checking…
              </>
            ) : (
              <>
                <UploadCloud className="h-[15px] w-[15px]" strokeWidth={2} /> Publish
              </>
            )}
          </Btn>
        </div>
      </div>

      {/* ------------------------------------------------- Import WordPress */}
      {/* Un accusé de réception, pas une alerte : l'insertion a réussi. Il se referme d'un clic et
          ne réapparaît jamais seul — le poids, lui, est déjà suivi par le panneau de pré-vol. */}
      {wpNotice && (
        <div className="mb-4 flex items-center gap-3 rounded-[12px] border border-border bg-accent/50 px-4 py-2.5 text-[12.5px]">
          <Newspaper className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
          <span className="min-w-0 flex-1">
            Inserted from WordPress — <strong className="font-semibold">{wpNotice}</strong>. They are ordinary article
            blocks now: edit, reorder or delete them like any other.
          </span>
          <button
            type="button"
            onClick={() => setWpNotice(null)}
            className="rounded-lg px-2 py-1 text-[11.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ---------------------------------------------------------- Conflit */}
      {conflict && (
        <div className="mb-4 flex flex-wrap items-start gap-3 rounded-[12px] border border-amber-300 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
          <div className="min-w-0 flex-1">
            <strong className="font-semibold">This draft changed in another tab or by another user.</strong> Autosave is
            stopped so nothing gets overwritten. Reloading brings the server version in and{" "}
            <strong className="font-semibold">discards the edits you made in this tab</strong> — copy anything you need
            first.
            {reloadError && (
              <div className="mt-2 rounded-[8px] border border-[#f3c9c9] bg-[#fdecec] px-2.5 py-1.5 text-[12px] text-[#a33]">
                <strong className="font-semibold">Reload refused —</strong> {reloadError} Nothing on screen was changed.
              </div>
            )}
          </div>
          <Btn onClick={() => void reloadFromServer()}>
            <RotateCcw className="h-[15px] w-[15px]" strokeWidth={2} /> Reload
          </Btn>
        </div>
      )}

      {/* ------------------------------------------------ Contexte cycle de vie */}
      {/* ⛔ Un modèle de cycle de vie se publie EN SERVICE : pas de campagne, pas de relecture avant
          l'envoi suivant. L'auteur doit le savoir ICI, pas seulement sur la liste des modèles. */}
      {lifecycleKinds.length > 0 && (
        <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-sky-200 bg-sky-50 px-3.5 py-2.5 text-[12.5px] leading-snug text-sky-900">
          <MailCheck className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
          <span>
            This template is the{" "}
            <span className="font-semibold">{lifecycleKinds.map((k) => LIFECYCLE_LABELS[k].titre).join(" and ")}</span>{" "}
            email of {assetName}. Publishing puts the new version in service for the next send — no campaign involved.
            Use <span className="font-semibold">Import template</span> to add your brand header, footer and legal footer.
            Confirmation and preference links only work in real sends; a test send shows placeholders.{" "}
            {lifecycleKinds.some((k) => LIFECYCLE_LABELS[k].pasEnvoye) && (
              <span className="font-medium text-amber-800">
                {lifecycleKinds
                  .map((k) => LIFECYCLE_LABELS[k].pasEnvoye)
                  .filter(Boolean)
                  .join(" ")}{" "}
              </span>
            )}
            <Link href={reglageCycle(lifecycleKinds)} className="font-medium underline">
              Email settings
            </Link>
          </span>
        </div>
      )}

      {/* ---------------------------------------------------------- Pré-vol */}
      {/* `onApplyFixes` est ce qui fait EXISTER les boutons « corriger » : sans lui, `PreflightPanel`
          masque les correctifs (`finding.fix` n'est lu que si le rappel est fourni) et le moteur de
          patches tournait à chaque frappe pour rien.
          ⚠️ UN SEUL `dispatch`, même pour N correctifs : `batch` n'empile qu'UNE entrée d'historique,
          donc une réparation vécue comme un clic se défait d'un seul Ctrl+Z. La traduction
          correctif → actions, et son ORDRE imposé, vit dans `reducer.ts` et pas ici : elle décide de
          ce qui est écrit dans le document, donc elle doit pouvoir se mesurer hors navigateur. */}
      <PreflightPanel
        doc={doc}
        lifecycleKinds={lifecycleKinds}
        onSelect={setSelection}
        onSelectColumn={setActiveColumn}
        onReport={setPreflight}
        onApplyFixes={(fixes) => dispatch({ type: "batch", actions: fixes.flatMap(actionsForFix) })}
      />

      {/* ---------------------------------------------------------- 3 panneaux */}
      <div className="flex flex-col items-start gap-4 lg:flex-row">
        <Palette
          doc={doc}
          activeColumn={activeColumn}
          dispatch={dispatch}
          onSelect={setSelection}
          onSelectColumn={setActiveColumn}
          onPasteHtml={() => setShowPaste(true)}
          onImportWordPress={() => setShowWpImport(true)}
          onImportTemplate={() => setShowImportTemplate(true)}
        />

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground/80">
            <span>Compiled email, desktop and light mode — use Preview for mobile, dark mode and a recipient’s view.</span>
            <span className="tabular-nums">{doc.theme.contentWidth}px content width</span>
          </div>
          <div className="overflow-hidden rounded-[14px] border border-border bg-card">
            <Canvas
              doc={doc}
              selection={selection}
              activeColumn={activeColumn}
              dispatch={dispatch}
              onSelect={setSelection}
              onSelectColumn={setActiveColumn}
            />
          </div>
        </div>

        <Inspector doc={doc} selection={selection} dispatch={dispatch} />
      </div>

      {/* ---------------------------------------------------------- Dialogues */}
      {showPreview && <PreviewDialog doc={doc} onClose={() => setShowPreview(false)} />}
      {showPaste && <PasteHtmlDialog onClose={() => setShowPaste(false)} onSubmit={pasteHtml} />}
      {showWpImport && <WpImportDialog onClose={() => setShowWpImport(false)} onInsert={insertWpRows} />}
      {showImportTemplate && (
        <ImportTemplateDialog
          doc={doc}
          assetName={assetName}
          activeColumn={activeColumn}
          dispatch={dispatch}
          onSelect={setSelection}
          onClose={() => setShowImportTemplate(false)}
        />
      )}
      {showPublish && (
        <PublishDialog
          templateId={templateId}
          dirty={dirty}
          blocked={conflict}
          onSave={save}
          onClose={() => setShowPublish(false)}
        />
      )}
      {showTest && <TestSendDialog templateId={templateId} dirty={dirty} blocked={conflict} onSave={save} onClose={() => setShowTest(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Indicateur de sauvegarde
 * ------------------------------------------------------------------ */

function SaveIndicator({
  status,
  dirty,
  onRetry,
}: {
  status: SaveStatus;
  dirty: boolean;
  onRetry: () => void;
}) {
  if (status.kind === "conflict") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fdf0dd] px-2.5 py-[5px] text-[11.5px] font-semibold text-[#b9790a]">
        <AlertTriangle className="h-3 w-3" strokeWidth={2.2} /> Conflict — not saving
      </span>
    );
  }
  if (status.kind === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-[5px] text-[11.5px] font-semibold text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (status.kind === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        title={status.message}
        className="inline-flex items-center gap-1.5 rounded-full bg-[#fdecec] px-2.5 py-[5px] text-[11.5px] font-semibold text-[#c33] hover:bg-[#fbdede]"
      >
        <AlertTriangle className="h-3 w-3" strokeWidth={2.2} /> Not saved — retry
      </button>
    );
  }
  if (dirty) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-[5px] text-[11.5px] font-semibold text-muted-foreground">
        Unsaved changes
      </span>
    );
  }
  if (status.kind === "saved") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e2f5e9] px-2.5 py-[5px] text-[11.5px] font-semibold text-[#1f9d57]">
        <CheckCircle2 className="h-3 w-3" strokeWidth={2.2} /> Saved {status.at}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-[5px] text-[11.5px] font-semibold text-muted-foreground">
      Draft up to date
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Import HTML (palier 0)
 * ------------------------------------------------------------------ */

function PasteHtmlDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (raw: string) => void }) {
  const [raw, setRaw] = useState("");
  const trimmed = raw.trim();

  return (
    <Modal
      title="Paste HTML"
      onClose={onClose}
      width="max-w-[720px]"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={trimmed === ""} onClick={() => onSubmit(trimmed)}>
            Insert block
          </Btn>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
        The markup is inserted as a single raw HTML block and compiled through untouched: it is never sanitised,
        reformatted or checked for email-client support. Paste the <strong>body</strong> of an existing email — a full
        document with <code className="font-mono">&lt;html&gt;</code> and <code className="font-mono">&lt;head&gt;</code>{" "}
        will be nested inside the generated one and most clients will drop the extra tags.
      </p>
      <textarea
        autoFocus
        rows={14}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        aria-label="HTML to insert"
        placeholder="<table role='presentation'>…</table>"
        className="w-full resize-y rounded-lg border border-border bg-card px-2.5 py-2 font-mono text-[11.5px] leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      />
      <p className="mt-1.5 text-[11px] text-muted-foreground/70">{raw.length.toLocaleString()} / 200,000 characters</p>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Publication
 * ------------------------------------------------------------------ */

function PublishDialog({
  templateId,
  dirty,
  blocked,
  onSave,
  onClose,
}: {
  templateId: string;
  dirty: boolean;
  blocked: boolean;
  onSave: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [done, setDone] = useState<{ version: number; sizeBytes: number } | null>(null);

  async function publish() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setWarnings([]);

    // Publier sans avoir enregistré publierait une version différente de celle affichée.
    if (dirty && !(await onSave())) {
      setError("The draft could not be saved, so nothing was published.");
      setBusy(false);
      return;
    }

    try {
      const res = await fetch(`/api/builder/templates/${templateId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() || undefined }),
      });
      const body = (await res.json().catch(() => null)) as
        | { version?: number; warnings?: string[]; sizeBytes?: number; error?: string }
        | null;

      if (!res.ok) {
        setError(body?.error ?? `Publish failed (${res.status})`);
        setWarnings(Array.isArray(body?.warnings) ? (body?.warnings as string[]) : []);
        setBusy(false);
        return;
      }
      setWarnings(Array.isArray(body?.warnings) ? (body?.warnings as string[]) : []);
      setDone({ version: Number(body?.version ?? 0), sizeBytes: Number(body?.sizeBytes ?? 0) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
    setBusy(false);
  }

  return (
    <Modal
      title="Publish template"
      onClose={onClose}
      footer={
        done ? (
          <Btn variant="primary" onClick={onClose}>
            Done
          </Btn>
        ) : (
          <>
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" disabled={busy || blocked} onClick={() => void publish()}>
              {busy && <Loader2 className="h-[15px] w-[15px] animate-spin" />}
              {busy ? "Publishing…" : "Publish"}
            </Btn>
          </>
        )
      }
    >
      {done ? (
        <div className="flex items-start gap-2.5 rounded-[10px] border border-[#bfe6cd] bg-[#e2f5e9] px-3 py-2.5 text-[12.5px] text-[#1f7a47]">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
          <span>
            Published as <strong>version {done.version}</strong>
            {done.sizeBytes > 0 && <> · {(done.sizeBytes / 1024).toFixed(1)} KB of compiled HTML</>}. Campaigns do not
            switch on their own: open each campaign that should send this version and save it — a series then moves
            its upcoming editions too.
          </span>
        </div>
      ) : (
        <>
          <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
            Publishing compiles the draft with MJML and freezes an immutable version. The draft stays editable; earlier
            versions stay restorable. Recipients only ever receive a published version.
          </p>
          {blocked && (
            <p className="mb-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              Resolve the draft conflict first — publishing now would freeze a document the server does not have.
            </p>
          )}
          <label htmlFor="publish-note" className="mb-1 block text-[11px] font-semibold text-muted-foreground">
            Version note (optional)
          </label>
          <input
            id="publish-note"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What changed in this version?"
            className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          />
        </>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-[#f3c9c9] bg-[#fdecec] px-3 py-2.5 text-[12.5px] text-[#a33]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>{error}</span>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2.5">
          <div className="mb-1.5 text-[11.5px] font-semibold text-amber-800">
            {done ? "Published with warnings" : "Blocking issues / warnings"}
          </div>
          <ul className="list-disc space-y-1 pl-4 text-[11.5px] leading-snug text-amber-800">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Envoi de test
 * ------------------------------------------------------------------ */

function TestSendDialog({
  templateId,
  dirty,
  blocked,
  onSave,
  onClose,
}: {
  templateId: string;
  dirty: boolean;
  blocked: boolean;
  onSave: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  // ⛔ « Queued » ne suffisait pas : le 24/09, deux tests écartés par le worker (adresse exclue) sont
  // restés « Queued » à l'écran. On suit la ligne jusqu'à la décision du worker (`test-send-verdict.ts`).
  const [suivi, setSuivi] = useState<{ etat: string; message: string } | null>(null);
  const suiviActif = useRef(true);
  useEffect(() => {
    suiviActif.current = true;
    return () => {
      suiviActif.current = false;
    };
  }, []);

  async function suivre(id: string) {
    // Le worker réclame les envois interactifs toutes les 5 s : 40 s couvrent plusieurs passages.
    for (let i = 0; i < 16 && suiviActif.current; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      if (!suiviActif.current) return;
      try {
        const res = await fetch(`/api/builder/test-send?id=${encodeURIComponent(id)}`);
        if (!res.ok) continue;
        const e = (await res.json()) as { etat: string; message: string };
        setSuivi(e);
        if (e.etat !== "pending") return;
      } catch {
        // Réseau coupé un instant : on retente au tour suivant.
      }
    }
    if (suiviActif.current) {
      setSuivi((s) =>
        s && s.etat !== "pending"
          ? s
          : { etat: "pending", message: "Still queued after 40 s — the worker may be paused. Check Deliverability later." },
      );
    }
  }

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());

  async function send() {
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    setQueued(false);
    setSuivi(null);

    if (dirty && !(await onSave())) {
      setError("The draft could not be saved, so no test was sent.");
      setBusy(false);
      return;
    }

    try {
      const res = await fetch("/api/builder/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, to: to.trim() }),
      });
      if (!res.ok) {
        setError(await readError(res));
        setBusy(false);
        return;
      }
      // « Queued » uniquement sur 2xx : la remise reste le travail du worker, qu'on suit ensuite.
      setQueued(true);
      const { id } = (await res.json().catch(() => ({}))) as { id?: string | null };
      if (id) void suivre(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
    setBusy(false);
  }

  return (
    <Modal
      title="Send a test"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Close</Btn>
          <Btn variant="primary" disabled={busy || !valid || blocked} onClick={() => void send()}>
            {busy && <Loader2 className="h-[15px] w-[15px] animate-spin" />}
            {busy ? "Sending…" : "Send test"}
          </Btn>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
        The current draft is saved and compiled, then queued as a test email. Merge tags are filled with their fallback
        values and the legal footer is injected exactly as in a real send.
      </p>
      <label htmlFor="test-to" className="mb-1 block text-[11px] font-semibold text-muted-foreground">
        Recipient
      </label>
      <input
        id="test-to"
        type="email"
        autoFocus
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="you@example.com"
        className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      />
      {to.trim() !== "" && !valid && (
        <p className="mt-1 text-[11px] text-[#b9790a]">That does not look like an email address.</p>
      )}
      {blocked && (
        <p className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Resolve the draft conflict first — a test would be sent from a document the server does not have.
        </p>
      )}
      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-[#f3c9c9] bg-[#fdecec] px-3 py-2.5 text-[12.5px] text-[#a33]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>{error}</span>
        </div>
      )}
      {queued && (!suivi || suivi.etat === "pending") && (
        <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={2} />
          <span>
            Queued for <strong>{to.trim()}</strong>. {suivi?.message ?? "Waiting for the worker, which passes every few seconds."}
          </span>
        </div>
      )}
      {suivi?.etat === "sent" && (
        <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-[#bfe6cd] bg-[#e2f5e9] px-3 py-2.5 text-[12.5px] text-[#1f7a47]">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>
            Sent to <strong>{to.trim()}</strong>. {suivi.message}
          </span>
        </div>
      )}
      {suivi && (suivi.etat === "not_sent" || suivi.etat === "failed") && (
        <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-[#f3c9c9] bg-[#fdecec] px-3 py-2.5 text-[12.5px] text-[#a33]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>{suivi.message}</span>
        </div>
      )}
    </Modal>
  );
}

/**
 * Où se règle l'e-mail de cycle de vie que sert ce modèle : sa page sous Automations › System (24/09/2026).
 * La relance n'y a pas de page (elle vit dans le moteur) : elle mène à la carte System.
 */
function reglageCycle(kinds: LifecycleKind[]): string {
  const k = kinds.find(isLifecycleEditable);
  return k ? adresseSysteme(k) : "/automations";
}
