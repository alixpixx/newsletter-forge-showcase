"use client";

/**
 * ILLUSTRATIONS — DÉCOUPLÉES de la composition, par construction.
 *
 * gpt-image-2 met 2 à 3 minutes par image. Les enchaîner dans la composition ferait tomber la
 * requête au timeout et perdrait le document déjà produit. Ici, chaque image est un job indépendant
 * lancé en parallèle : une image qui échoue n'emporte ni les autres ni le document.
 *
 * ⚠️ La route doit renvoyer une URL HÉBERGÉE. Une `data:` URI est refusée par `ImageSrc` du schéma ;
 * on le vérifie au retour et on le dit, plutôt que d'insérer une source qui bloquera la publication.
 */
import { useCallback, useState } from "react";
import { AlertTriangle, Check, ImagePlus, Loader2, RefreshCw } from "lucide-react";
import { Btn } from "@/components/ui";
import { cn } from "@/lib/utils";
import { AiError, EXPECTED_ILLUSTRATE, errorLabel, requestIllustration } from "./api";
import type { ArtDirection, PendingImage } from "./types";

type JobState = { status: "idle" | "running" | "done" | "error"; message?: string; label?: string };

export function Illustrations({
  pending,
  direction,
  onImage,
  disabled = false,
}: {
  pending: PendingImage[];
  direction: ArtDirection;
  /** Appelé par job réussi — le parent remplace la source du bloc dans le document. */
  onImage: (blockId: string, src: string) => void;
  disabled?: boolean;
}) {
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const anyRunning = Object.values(jobs).some((j) => j.status === "running");

  const runOne = useCallback(
    async (img: PendingImage) => {
      setJobs((s) => ({ ...s, [img.blockId]: { status: "running" } }));
      try {
        const res = await requestIllustration({
          prompt: img.prompt,
          alt: img.alt,
          direction,
          widthPct: img.widthPct,
        });
        const src = typeof res.src === "string" ? res.src.trim() : "";
        if (!src) throw new AiError("The image API returned no source.", "server");
        if (/^\s*data:/i.test(src)) {
          throw new AiError(
            "The image API returned an inline data: URL, which the document schema rejects — it must be hosted.",
            "invalid_doc",
          );
        }
        onImage(img.blockId, src);
        setJobs((s) => ({ ...s, [img.blockId]: { status: "done" } }));
      } catch (err) {
        const isAi = err instanceof AiError;
        setJobs((s) => ({
          ...s,
          [img.blockId]: {
            status: "error",
            label: isAi ? errorLabel(err.kind) : "Failed",
            message: err instanceof Error ? err.message : "Image generation failed",
          },
        }));
      }
    },
    [direction, onImage],
  );

  /** Une par une, EN PARALLÈLE : `allSettled` pour qu'un échec n'annule pas les jobs voisins. */
  const runAll = useCallback(() => {
    const todo = pending.filter((p) => jobs[p.blockId]?.status !== "running");
    void Promise.allSettled(todo.map(runOne));
  }, [pending, jobs, runOne]);

  if (pending.length === 0) return null;

  return (
    <div className="rounded-[12px] border border-border bg-accent/20 p-3.5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-[13px] font-semibold">
            {pending.length} image{pending.length === 1 ? "" : "s"} still a placeholder
          </h4>
          <p className="mt-0.5 max-w-[62ch] text-[11.5px] leading-snug text-muted-foreground">
            Claude wrote the briefs but cannot draw. Generating them runs {EXPECTED_ILLUSTRATE} — all requests go out
            in parallel, and the document stays usable if one fails. A placeholder source must be replaced before the
            template can be published.
          </p>
        </div>
        <Btn variant="dark" onClick={runAll} disabled={disabled || anyRunning}>
          {anyRunning ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <ImagePlus className="h-[15px] w-[15px]" />}
          {anyRunning ? "Generating…" : "Generate images"}
        </Btn>
      </div>

      <ul className="space-y-2">
        {pending.map((img) => {
          const job = jobs[img.blockId] ?? { status: "idle" as const };
          return (
            <li
              key={img.blockId}
              className={cn(
                "flex items-start gap-2.5 rounded-[10px] border bg-background px-3 py-2.5",
                job.status === "error" ? "border-red-200" : "border-border",
              )}
            >
              <span className="mt-0.5 shrink-0">
                {job.status === "running" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                {job.status === "done" && <Check className="h-4 w-4 text-[#1f9d57]" strokeWidth={2.2} />}
                {job.status === "error" && <AlertTriangle className="h-4 w-4 text-red-600" strokeWidth={2} />}
                {job.status === "idle" && <ImagePlus className="h-4 w-4 text-muted-foreground/70" strokeWidth={1.8} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] leading-snug">{img.prompt || img.alt || "(no brief — check the block)"}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {job.status === "running" && `Generating — ${EXPECTED_ILLUSTRATE}…`}
                  {job.status === "done" && "Inserted into the document."}
                  {job.status === "idle" && `Placeholder · ${img.widthPct}% width`}
                  {job.status === "error" && (
                    <span className="text-red-700">
                      {job.label}: {job.message}
                    </span>
                  )}
                </p>
              </div>
              {(job.status === "error" || job.status === "idle") && (
                <Btn
                  variant="ghost"
                  onClick={() => void runOne(img)}
                  disabled={disabled}
                  className="shrink-0 px-2 py-1 text-[12px]"
                >
                  <RefreshCw className="h-[13px] w-[13px]" /> {job.status === "error" ? "Retry" : "Generate"}
                </Btn>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
