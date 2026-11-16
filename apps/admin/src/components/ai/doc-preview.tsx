"use client";

/**
 * APERÇU DU DOCUMENT GÉNÉRÉ — passe par `POST /api/builder/preview`, donc par le MÊME compilateur
 * MJML que l'email réellement envoyé. Un aperçu maison serait une jolie approximation ; il mentirait.
 *
 * L'iframe est `sandbox=""` (aucune capacité) et `srcDoc` : le HTML compilé ne peut ni scripter,
 * ni naviguer, ni charger la page hôte.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { GMAIL_CLIP_BYTES, type EmailDoc } from "@nf/render/schema";
import { Btn } from "@/components/ui";
import { cn } from "@/lib/utils";
import { AiError, requestPreview, type PreviewResult } from "./api";

const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export function DocPreview({ doc, onResult }: { doc: EmailDoc; onResult?: (r: PreviewResult) => void }) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [width, setWidth] = useState<600 | 375>(600);

  // Le callback est gardé dans une ref : sinon un `onResult` inline chez le parent ferait
  // muter `run` à chaque rendu, et l'effet ci-dessous recompilerait en boucle.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await requestPreview(doc);
      setResult(r);
      onResultRef.current?.(r);
    } catch (err) {
      setError(err instanceof AiError ? err.message : err instanceof Error ? err.message : "Preview failed");
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [doc]);

  // Le doc change à chaque illustration insérée → on recompile, l'aperçu ne doit jamais dater.
  useEffect(() => {
    void run();
  }, [run]);

  const over = result !== null && result.sizeBytes > GMAIL_CLIP_BYTES;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-border p-0.5" role="group" aria-label="Preview width">
          {([600, 375] as const).map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={width === w}
              onClick={() => setWidth(w)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors",
                width === w ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w === 600 ? <Monitor className="h-3.5 w-3.5" strokeWidth={2} /> : <Smartphone className="h-3.5 w-3.5" strokeWidth={2} />}
              {w}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {result && (
            <span
              className={cn(
                "rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold tabular-nums",
                over ? "bg-[#fdf0dd] text-[#b9790a]" : "bg-accent text-muted-foreground",
              )}
              title={over ? "Over the Gmail clipping threshold" : "Compiled HTML size"}
            >
              {fmtBytes(result.sizeBytes)}
            </span>
          )}
          <Btn onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <RefreshCw className="h-[15px] w-[15px]" />}
            Recompile
          </Btn>
        </div>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-[10px] border border-[#f3c9c9] bg-[#fdecec] px-3 py-2.5 text-[12.5px] text-[#a33]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>{error}</span>
        </div>
      )}

      {busy && !result && (
        <div className="flex h-[320px] items-center justify-center rounded-[12px] border border-border text-[12.5px] text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Compiling with MJML…
        </div>
      )}

      {result && (
        <div className="flex justify-center overflow-auto rounded-[12px] border border-border bg-[#f4f4f7] p-4" style={{ maxHeight: "56vh" }}>
          <iframe
            key={`${width}-${result.sizeBytes}`}
            title="Generated email preview"
            sandbox=""
            srcDoc={result.html}
            className="h-[54vh] shrink-0 rounded-[8px] border border-border bg-white"
            style={{ width }}
          />
        </div>
      )}

      {result && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
          This is the compiled shell — merge tags stay unresolved and the legal footer is injected at send time.
        </p>
      )}

      {result && result.warnings.length > 0 && (
        <div className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
            {result.warnings.length} compiler warning{result.warnings.length === 1 ? "" : "s"}
          </div>
          <ul className="list-disc space-y-1 pl-4 text-[11.5px] leading-snug text-amber-800">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
