"use client";

/**
 * ZONE DE DÉPÔT de l'image de référence (la « direction graphique » d'entrée).
 *
 * L'image ne quitte le navigateur que sous forme base64 dans le corps de `/api/ai/art-direction` :
 * rien n'est uploadé, aucun stockage intermédiaire, donc rien à nettoyer si l'utilisateur abandonne.
 */
import { useCallback, useId, useRef, useState } from "react";
import { ImageUp, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;

/** Formats que Claude vision accepte. Un autre type est refusé À LA SOURCE, pas au 400 serveur. */
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const ACCEPT_ATTR = ACCEPTED_TYPES.join(",");

export interface Artwork {
  /** base64 SANS le préfixe `data:` — ce que réclame l'API Anthropic. */
  base64: string;
  mediaType: string;
  /** Data URL complète, uniquement pour l'aperçu local. */
  dataUrl: string;
  name: string;
  bytes: number;
}

export const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

export function ArtworkDrop({
  value,
  onChange,
  disabled = false,
}: {
  value: Artwork | null;
  onChange: (artwork: Artwork | null) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
        setError(`Unsupported format (${file.type || "unknown"}). Use PNG, JPEG, WebP or GIF.`);
        return;
      }
      if (file.size > MAX_ARTWORK_BYTES) {
        setError(`That file is ${formatBytes(file.size)} — the limit is 5 MB.`);
        return;
      }
      setBusy(true);
      try {
        const dataUrl = await readAsDataUrl(file);
        const comma = dataUrl.indexOf(",");
        if (comma < 0) throw new Error("The file could not be decoded.");
        onChange({
          base64: dataUrl.slice(comma + 1),
          mediaType: file.type,
          dataUrl,
          name: file.name,
          bytes: file.size,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "The file could not be read.");
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );

  if (value) {
    return (
      <div className="rounded-[12px] border border-border bg-accent/30 p-3">
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL locale, jamais servie par Next */}
          <img
            src={value.dataUrl}
            alt="Reference artwork preview"
            className="h-[104px] w-[104px] shrink-0 rounded-[9px] border border-border object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{value.name}</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {formatBytes(value.bytes)} · {value.mediaType.replace("image/", "").toUpperCase()}
            </p>
            <p className="mt-2 text-[11.5px] leading-snug text-muted-foreground/80">
              Only the colours, mood and typography are read from this image. It is never embedded in the email.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setError(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            disabled={disabled}
            aria-label="Remove artwork"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) void accept(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-[12px] border-2 border-dashed px-4 py-8 text-center transition-colors",
          over ? "border-brand bg-brand-soft/40" : "border-border bg-accent/20 hover:border-brand/60",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {busy ? (
          <Loader2 className="mb-2 h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <ImageUp className="mb-2 h-5 w-5 text-muted-foreground" strokeWidth={1.8} />
        )}
        <span className="text-[13px] font-medium">Drop an artwork, or click to choose a file</span>
        <span className="mt-1 text-[12px] text-muted-foreground">PNG, JPEG, WebP or GIF · 5 MB max</span>
      </label>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => void accept(e.target.files?.[0])}
      />
      {error && (
        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">{error}</p>
      )}
    </div>
  );
}
