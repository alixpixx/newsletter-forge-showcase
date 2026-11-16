"use client";

/**
 * GÉNÉRATEUR DE TEMPLATE IA — orchestrateur des 4 étapes (brief → direction → composition → actions).
 *
 * Trois règles tenues à l'écran, pas seulement dans le code :
 *  1. **Zéro faux succès.** Toute étape ratée affiche le message de l'API tel quel, avec sa nature
 *     (clé refusée, crédit épuisé, quota…). Rien n'avance sur une réponse non 2xx.
 *  2. **Attente honnête.** La durée réellement attendue est écrite AVANT de lancer, et un compteur
 *     de secondes tourne pendant — pas de barre de progression inventée.
 *  3. **Le document est le produit.** Claude rend un `EmailDoc` validé par le même schéma Zod que le
 *     builder ; l'aperçu passe par le compilateur d'envoi. Ce qu'on voit est ouvrable et modifiable.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  PenLine,
  RotateCcw,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { EmailDoc } from "@nf/render/schema";
import { Btn, Card, CardHead, PageHead, Pill } from "@/components/ui";
import { TEMPLATE_CATEGORIES, categoryLabel, type TemplateCategory } from "@/components/templates/categories";
import { cn } from "@/lib/utils";
import {
  AiError,
  EXPECTED_ART_DIRECTION,
  EXPECTED_COMPOSE,
  errorLabel,
  requestApply,
  requestArtDirection,
  requestCompose,
  type AiErrorKind,
  type PreviewResult,
} from "./api";
import { ArtworkDrop, type Artwork } from "./artwork-drop";
import { DirectionEditor } from "./direction-editor";
import { DocPreview } from "./doc-preview";
import { Illustrations } from "./illustrations";
import { countBlocks, directionErrors, normalizeDirection, pendingImages, setImageSrc, type ArtDirection } from "./types";

/* La catégorie `transactional` n'est pas proposée ici : ces messages sont déclenchés par le système
   et leur copie est contrainte par la conformité — les générer serait une fausse bonne idée. */
const AI_CATEGORIES = TEMPLATE_CATEGORIES.filter((c) => c !== "transactional");

export interface BrandContext {
  slug: string;
  name: string;
  market: string | null;
  languages: string[];
  /** false = base injoignable : la génération est possible mais rien ne pourra être enregistré. */
  fromDb: boolean;
  ready: boolean;
}

type Stage = "brief" | "direction" | "result";
type Failure = { kind: AiErrorKind; message: string; issues: string[] };

const toFailure = (err: unknown): Failure =>
  err instanceof AiError
    ? { kind: err.kind, message: err.message, issues: err.issues }
    : { kind: "network", message: err instanceof Error ? err.message : "Unexpected error", issues: [] };

/** Compteur de secondes — la seule mesure d'attente honnête dont on dispose. */
function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const start = Date.now();
    const id = window.setInterval(() => setSeconds(Math.round((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return seconds;
}

function ErrorPanel({ failure, onDismiss }: { failure: Failure; onDismiss: () => void }) {
  return (
    <div className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-red-800">{errorLabel(failure.kind)}</p>
          <p className="mt-0.5 break-words text-[12.5px] leading-snug text-red-700">{failure.message}</p>
          {failure.issues.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 font-mono text-[11px] leading-snug text-red-700">
              {failure.issues.slice(0, 12).map((i, n) => (
                <li key={n}>{i}</li>
              ))}
            </ul>
          )}
          {failure.kind === "credit" && (
            <p className="mt-1.5 text-[11.5px] leading-snug text-red-700/90">
              Nothing was generated and nothing was saved. Top up the Anthropic account, then retry.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-medium text-red-700 hover:bg-red-100"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

const STEPS = ["Brief", "Art direction", "Compose"] as const;

function Stepper({ stage }: { stage: Stage }) {
  const index = stage === "brief" ? 0 : stage === "direction" ? 1 : 2;
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-2 text-[12px]">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] font-semibold",
              i < index && "bg-[#e2f5e9] text-[#1f9d57]",
              i === index && "bg-foreground text-background",
              i > index && "bg-accent text-muted-foreground",
            )}
          >
            {i < index ? <Check className="h-3 w-3" strokeWidth={2.5} /> : <span className="tabular-nums">{i + 1}</span>}
            {label}
          </span>
          {i < STEPS.length - 1 && <ArrowRight className="h-3 w-3 text-muted-foreground/50" />}
        </li>
      ))}
    </ol>
  );
}

export function AiGenerator({ brand }: { brand: BrandContext }) {
  const router = useRouter();

  const [stage, setStage] = useState<Stage>("brief");
  const [failure, setFailure] = useState<Failure | null>(null);

  // Étape 1
  const [artwork, setArtwork] = useState<Artwork | null>(null);
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<TemplateCategory>("newsletter");

  // Étape 2
  const [direction, setDirection] = useState<ArtDirection | null>(null);

  // Étape 3
  const [doc, setDoc] = useState<EmailDoc | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  const [busyArt, setBusyArt] = useState(false);
  const [busyCompose, setBusyCompose] = useState(false);
  const [busyApply, setBusyApply] = useState(false);
  const elapsed = useElapsed(busyArt || busyCompose);

  const language = brand.languages[0] ?? null;
  const promptReady = prompt.trim().length >= 12;
  const nameReady = name.trim().length > 0;

  /* ------------------------------------------------------------ Étape 1 → 2 */

  async function analyze() {
    if (!artwork || !promptReady || busyArt) return;
    setBusyArt(true);
    setFailure(null);
    try {
      const res = await requestArtDirection({
        image: { base64: artwork.base64, mediaType: artwork.mediaType },
        prompt: prompt.trim(),
        category,
      });
      setDirection(normalizeDirection(res));
      setStage("direction");
    } catch (err) {
      setFailure(toFailure(err));
    } finally {
      setBusyArt(false);
    }
  }

  /* ------------------------------------------------------------ Étape 2 → 3 */

  const compose = useCallback(
    async (dir: ArtDirection) => {
      if (busyCompose) return;
      setBusyCompose(true);
      setFailure(null);
      setStage("result");
      try {
        const res = await requestCompose({
          prompt: prompt.trim(),
          category,
          direction: dir,
          name: name.trim() || "AI template",
        });
        if (!res.doc || typeof res.doc !== "object" || !Array.isArray(res.doc.rows)) {
          throw new AiError("The server did not return a document.", "invalid_doc");
        }
        setDoc(res.doc);
        setPreview(null);
      } catch (err) {
        setFailure(toFailure(err));
        setDoc(null);
        // Retour à la direction : l'utilisateur peut ajuster puis relancer, rien n'est perdu.
        setStage("direction");
      } finally {
        setBusyCompose(false);
      }
    },
    [busyCompose, prompt, category, name],
  );

  /* ---------------------------------------------------------------- Étape 4 */

  async function openInBuilder() {
    if (!doc || busyApply) return;
    setBusyApply(true);
    setFailure(null);
    try {
      const res = await requestApply({
        name: name.trim() || "AI template",
        category,
        doc,
        subject: doc.meta.subject ?? "",
        preheader: doc.meta.preheader ?? "",
      });
      if (!res.id) throw new AiError("The server did not return a template id.", "server");
      router.push(`/builder/${res.id}`);
    } catch (err) {
      setFailure(toFailure(err));
      setBusyApply(false);
    }
  }

  function startOver() {
    setStage("brief");
    setDirection(null);
    setDoc(null);
    setPreview(null);
    setFailure(null);
  }

  const onImage = useCallback((blockId: string, src: string) => {
    setDoc((current) => (current ? setImageSrc(current, blockId, src) : current));
  }, []);

  const onPreview = useCallback((r: PreviewResult) => setPreview(r), []);

  const pending = doc ? pendingImages(doc) : [];

  /* ------------------------------------------------------------------ Rendu */

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Generate a template with AI"
        desc="Claude never writes HTML. It returns a document validated by the builder's own schema — so everything it produces opens in the editor and stays editable, block by block."
      >
        {stage !== "brief" && (
          <Btn variant="ghost" onClick={startOver} disabled={busyCompose || busyApply}>
            <RotateCcw className="h-[15px] w-[15px]" /> Start over
          </Btn>
        )}
      </PageHead>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Pill tone="pink" dot>
          {brand.name}
        </Pill>
        <span className="text-[12px] text-muted-foreground">
          Copy language: <strong className="font-semibold text-foreground/80">{language ?? "not set"}</strong>
          {brand.market ? ` · market ${brand.market}` : ""} — inherited from the brand, not from the prompt.
        </span>
      </div>

      {!brand.ready && (
        <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The brand could not be resolved from the database, so a generated template cannot be saved. Fix the
            connection before generating — otherwise the work is lost at the last step.
          </span>
        </div>
      )}

      <Stepper stage={stage} />

      {failure && (
        <div className="mb-4">
          <ErrorPanel failure={failure} onDismiss={() => setFailure(null)} />
        </div>
      )}

      {/* ------------------------------------------------------- Étape 1 */}
      {stage === "brief" && (
        <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
          <Card>
            <CardHead title="Reference artwork" sub="The graphic direction is read from this image" />
            <ArtworkDrop value={artwork} onChange={setArtwork} disabled={busyArt} />
          </Card>

          <Card>
            <CardHead title="Brief" sub="What this email is about" />

            <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="ai-name">
              Template name
            </label>
            <input
              id="ai-name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="Weekly roundup — August"
              className="mb-3 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
            />

            <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="ai-category">
              Template type
            </label>
            <select
              id="ai-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as TemplateCategory)}
              className="mb-3 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
            >
              {AI_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>

            <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="ai-prompt">
              Prompt
            </label>
            <textarea
              id="ai-prompt"
              value={prompt}
              rows={6}
              maxLength={2000}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A weekly roundup: a bold hero, three story cards with a short teaser each, one call to action to the site, and a closing note from the editor."
              className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] leading-relaxed outline-none focus:border-brand"
            />
            <p className="mt-1 flex justify-between text-[11px] text-muted-foreground/80">
              <span>Describe the structure and the intent — not the colours, those come from the artwork.</span>
              <span className="tabular-nums">{prompt.trim().length}/2000</span>
            </p>

            <p className="mt-3 rounded-[10px] border border-border bg-accent/30 px-3 py-2.5 text-[11.5px] leading-snug text-muted-foreground">
              No odds, scores or fixtures are ever invented. If the brief asks for match data, leave a placeholder and
              fill it from a real source in the builder.
            </p>

            <div className="mt-3.5 flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-muted-foreground">
                {busyArt ? (
                  <span className="tabular-nums">Analyzing artwork… {elapsed}s elapsed ({EXPECTED_ART_DIRECTION})</span>
                ) : (
                  `Claude vision reads the image — ${EXPECTED_ART_DIRECTION}.`
                )}
              </span>
              <Btn
                variant="primary"
                onClick={() => void analyze()}
                disabled={!artwork || !promptReady || busyArt}
                className={cn((!artwork || !promptReady || busyArt) && "cursor-not-allowed opacity-50")}
                title={!artwork ? "Drop an artwork first" : !promptReady ? "Write a prompt of at least 12 characters" : undefined}
              >
                {busyArt ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <Sparkles className="h-[15px] w-[15px]" />}
                Analyze artwork
              </Btn>
            </div>
          </Card>
        </div>
      )}

      {/* ------------------------------------------------------- Étape 2 */}
      {stage === "direction" && direction && (
        <Card>
          <CardHead
            title="Art direction"
            sub="Read from the artwork — correct anything before composing"
            right={
              <span className="text-[11.5px] text-muted-foreground">
                {artwork ? artwork.name : "artwork removed"}
              </span>
            }
          />
          <DirectionEditor direction={direction} onChange={setDirection} disabled={busyCompose} />

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3.5">
            <span className="text-[11.5px] text-muted-foreground">
              Composing takes {EXPECTED_COMPOSE}. Nothing is saved until you open it in the builder.
            </span>
            <div className="flex items-center gap-2.5">
              <Btn variant="ghost" onClick={() => setStage("brief")} disabled={busyCompose}>
                <ArrowLeft className="h-[15px] w-[15px]" /> Back
              </Btn>
              <Btn
                variant="primary"
                onClick={() => void compose(direction)}
                disabled={busyCompose || directionErrors(direction).length > 0}
                className={cn((busyCompose || directionErrors(direction).length > 0) && "cursor-not-allowed opacity-50")}
              >
                {busyCompose ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <Wand2 className="h-[15px] w-[15px]" />}
                Generate template
              </Btn>
            </div>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------- Étapes 3 & 4 */}
      {stage === "result" && (
        <Card>
          {busyCompose && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Loader2 className="mb-3 h-6 w-6 animate-spin text-brand" />
              <p className="text-[13.5px] font-semibold">Composing the document…</p>
              <p className="mt-1 text-[12px] tabular-nums text-muted-foreground">
                {elapsed}s elapsed · {EXPECTED_COMPOSE}
              </p>
              <p className="mt-2 max-w-[54ch] text-[11.5px] leading-snug text-muted-foreground/80">
                Claude is writing rows, columns and blocks against the builder schema. Leaving this page cancels the
                request — nothing is saved yet.
              </p>
            </div>
          )}

          {!busyCompose && doc && (
            <>
              <CardHead
                title="Ready"
                sub="Compiled through the same renderer as the sent email"
                right={
                  <Pill tone="green" dot>
                    Schema-valid
                  </Pill>
                }
              />

              <dl className="mb-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-[10px] border border-border bg-accent/25 px-3 py-2.5">
                  <dt className="text-[11px] font-semibold text-muted-foreground">Subject</dt>
                  <dd className="mt-0.5 text-[13px]">{doc.meta.subject?.trim() || <em className="text-muted-foreground">empty — required before publishing</em>}</dd>
                </div>
                <div className="rounded-[10px] border border-border bg-accent/25 px-3 py-2.5">
                  <dt className="text-[11px] font-semibold text-muted-foreground">Preheader</dt>
                  <dd className="mt-0.5 text-[13px]">{doc.meta.preheader?.trim() || <em className="text-muted-foreground">none</em>}</dd>
                </div>
                <div className="rounded-[10px] border border-border bg-accent/25 px-3 py-2.5">
                  <dt className="text-[11px] font-semibold text-muted-foreground">Structure</dt>
                  <dd className="mt-0.5 text-[13px] tabular-nums">
                    {doc.rows.length} row{doc.rows.length === 1 ? "" : "s"} · {countBlocks(doc)} block
                    {countBlocks(doc) === 1 ? "" : "s"}
                  </dd>
                </div>
                <div className="rounded-[10px] border border-border bg-accent/25 px-3 py-2.5">
                  <dt className="text-[11px] font-semibold text-muted-foreground">Compiled size</dt>
                  <dd className="mt-0.5 text-[13px] tabular-nums">
                    {preview ? `${(preview.sizeBytes / 1024).toFixed(1)} KB` : "measuring…"}
                  </dd>
                </div>
              </dl>

              {pending.length > 0 && direction && (
                <div className="mb-4">
                  <Illustrations pending={pending} direction={direction} onImage={onImage} disabled={busyApply} />
                </div>
              )}

              <DocPreview doc={doc} onResult={onPreview} />

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3.5">
                <span className="text-[11.5px] text-muted-foreground">
                  Opening in the builder creates the template and writes this document into its draft. Nothing is
                  published.
                </span>
                <div className="flex flex-wrap items-center gap-2.5">
                  <Btn variant="ghost" onClick={startOver} disabled={busyApply}>
                    <RotateCcw className="h-[15px] w-[15px]" /> Start over
                  </Btn>
                  <Btn variant="ghost" onClick={() => setStage("direction")} disabled={busyApply}>
                    <PenLine className="h-[15px] w-[15px]" /> Edit direction
                  </Btn>
                  <Btn
                    variant="default"
                    onClick={() => direction && void compose(direction)}
                    disabled={busyApply || !direction}
                  >
                    <Wand2 className="h-[15px] w-[15px]" /> Regenerate
                  </Btn>
                  <Btn
                    variant="primary"
                    onClick={() => void openInBuilder()}
                    disabled={busyApply || !brand.ready}
                    title={!brand.ready ? "The brand is unavailable — the template cannot be saved" : undefined}
                    className={cn((busyApply || !brand.ready) && "cursor-not-allowed opacity-50")}
                  >
                    {busyApply ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <ArrowRight className="h-[15px] w-[15px]" />}
                    {busyApply ? "Saving…" : "Open in builder"}
                  </Btn>
                </div>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
