"use client";

/**
 * MÉDIATHÈQUE — boîte de dialogue de sélection d'image.
 *
 * Deux partis pris expliquent la forme de cet écran :
 *
 *  1. **L'`alt` est propriété de l'USAGE, pas du fichier.** La même photo légendée « Estádio vide
 *     au crépuscule » dans un édito devient « Notre nouveau partenaire » dans un mailing. On propose
 *     donc l'alt stocké, mais on le laisse modifier à chaque insertion.
 *  2. **Une image sans alt ne peut pas être insérée telle quelle.** `EmailDocPublishable` refuse un
 *     bloc image sans alt : laisser passer ici ne ferait que reporter l'échec à la publication, une
 *     demi-heure plus tard, sans que personne comprenne pourquoi. On demande l'alt sur place.
 *
 * Le chemin courant reste donc à un clic (l'image a déjà un alt → insertion immédiate) ; seul le
 * cas défectueux coûte une saisie.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, ImageUp, Loader2, Search, X } from "lucide-react";
import { Modal } from "@/components/builder/modal";
import { Btn } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  ACCEPTED_MEDIA_TYPES,
  ACCEPT_ATTR,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_MB,
  fetchMedia,
  formatBytes,
  patchMediaAlt,
  uploadMedia,
  type MediaFilter,
  type MediaItem,
} from "./api";

const PAGE_SIZE = 40;

const INPUT =
  "w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground " +
  "placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

const FILTERS: { value: MediaFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "upload", label: "Uploaded" },
  { value: "ai", label: "AI" },
  { value: "import", label: "Imported" },
];

const SOURCE_LABEL: Record<MediaItem["source"], string> = {
  upload: "Uploaded",
  ai: "AI",
  import: "Imported",
};

export function MediaPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (m: { src: string; alt: string }) => void;
}): React.ReactElement | null {
  const searchId = useId();
  const fileId = useId();
  const altId = useId();

  const [items, setItems] = useState<MediaItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MediaFilter>("all");

  /** Image retenue dont l'alt reste à confirmer (voir l'en-tête du fichier). */
  const [pending, setPending] = useState<MediaItem | null>(null);
  const [altDraft, setAltDraft] = useState("");
  const altRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (offset: number) => {
      // Une frappe rapide dans la recherche lance plusieurs requêtes : seule la dernière compte.
      inFlight.current?.abort();
      const ac = new AbortController();
      inFlight.current = ac;

      setLoading(true);
      setError(null);
      try {
        const page = await fetchMedia({ q: query, source: filter, offset, limit: PAGE_SIZE }, ac.signal);
        setItems((prev) => {
          if (offset === 0) return page.items;
          // Un téléversement décale la pagination d'une ligne : on dédoublonne par id à l'ajout.
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
        });
        setHasMore(page.hasMore);
      } catch (err) {
        // `AbortController` lève une DOMException, pas forcément une `Error` : on teste le nom.
        if ((err as { name?: string })?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "The media library could not be loaded.");
      } finally {
        if (inFlight.current === ac) setLoading(false);
      }
    },
    [query, filter],
  );

  // Recherche débattue : 250 ms pour la frappe, immédiat pour un changement de filtre ou l'ouverture.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void load(0), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [open, query, load]);

  // Chaque ouverture repart d'une sélection propre — un alt saisi hier n'a rien à faire ici.
  useEffect(() => {
    if (!open) return;
    setPending(null);
    setAltDraft("");
    setUploadError(null);
    setNotice(null);
  }, [open]);

  useEffect(() => {
    if (pending) altRef.current?.focus();
  }, [pending]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const select = useCallback(
    (m: MediaItem) => {
      const alt = m.alt.trim();
      if (alt) {
        onPick({ src: m.url, alt });
        onClose();
        return;
      }
      setPending(m);
      setAltDraft("");
    },
    [onPick, onClose],
  );

  const confirm = useCallback(() => {
    const alt = altDraft.trim();
    if (!pending || !alt) return;

    // L'image n'avait AUCUN alt stocké : on comble le trou dans la bibliothèque, sinon la même
    // photo réinsérée demain reviendrait muette et le défaut d'accessibilité se répéterait à
    // chaque usage. On n'écrase jamais un alt déjà renseigné : celui-là décrit le fichier, celui
    // qu'on vient de saisir décrit CET email (voir l'arbitrage 1 en tête de fichier).
    // Écriture détachée : la bibliothèque ne doit pas pouvoir faire échouer une insertion.
    if (!pending.alt.trim()) {
      void patchMediaAlt(pending.id, alt).catch(() => undefined);
    }

    onPick({ src: pending.url, alt });
    onClose();
  }, [pending, altDraft, onPick, onClose]);

  const upload = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    setNotice(null);

    // `file.type` est vide sur certains systèmes : on ne refuse que ce qui est explicitement autre.
    if (file.type && !(ACCEPTED_MEDIA_TYPES as readonly string[]).includes(file.type)) {
      setUploadError(`Unsupported format (${file.type}). Use PNG, JPEG or WebP.`);
      return;
    }
    if (file.size > MAX_MEDIA_BYTES) {
      setUploadError(`That file is ${formatBytes(file.size)} — the limit is ${MAX_MEDIA_MB} MB.`);
      return;
    }

    setUploading(true);
    try {
      const { item, deduplicated } = await uploadMedia(file, "");
      setItems((prev) => [item, ...prev.filter((i) => i.id !== item.id)]);
      if (deduplicated) setNotice("That image was already in the library — the existing file is reused.");
      // On enchaîne sur l'alt : téléverser puis chercher son image dans la grille est absurde.
      setPending(item);
      setAltDraft(item.alt);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "The upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, []);

  if (!open) return null;

  const empty = !loading && items.length === 0 && !error;

  return (
    <Modal
      title="Media library"
      onClose={onClose}
      width="max-w-[860px]"
      footer={
        pending ? (
          <div className="flex w-full items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element -- URL Storage publique, hors loader Next */}
            <img
              src={pending.url}
              alt=""
              className="h-10 w-14 shrink-0 rounded-md border border-border object-cover"
            />
            <label htmlFor={altId} className="sr-only">
              Alternative text
            </label>
            <input
              id={altId}
              ref={altRef}
              value={altDraft}
              maxLength={300}
              onChange={(e) => setAltDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirm();
                }
              }}
              placeholder="Describe this image for screen readers…"
              className={cn(INPUT, "flex-1")}
            />
            <Btn variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Btn>
            <Btn variant="primary" disabled={!altDraft.trim()} onClick={confirm} className="disabled:opacity-50">
              Insert
            </Btn>
          </div>
        ) : (
          <>
            <span className="mr-auto text-[12px] text-muted-foreground">
              Click an image to insert it into the block.
            </span>
            <Btn onClick={onClose}>Close</Btn>
          </>
        )
      }
    >
      <div className="space-y-3">
        {/* Recherche + filtres */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              strokeWidth={2}
            />
            <label htmlFor={searchId} className="sr-only">
              Search images by alternative text
            </label>
            <input
              id={searchId}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by alt text…"
              className={cn(INPUT, "pl-8")}
            />
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-accent/30 p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  "rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors",
                  filter === f.value
                    ? "bg-card text-foreground shadow-[0_1px_2px_rgba(20,20,30,0.10)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Zone de dépôt */}
        <label
          htmlFor={fileId}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void upload(e.dataTransfer.files?.[0]);
          }}
          className={cn(
            "flex cursor-pointer items-center justify-center gap-2 rounded-[12px] border-2 border-dashed px-4 py-4 text-center transition-colors",
            over ? "border-brand bg-brand-soft/40" : "border-border bg-accent/20 hover:border-brand/60",
            uploading && "pointer-events-none opacity-60",
          )}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <ImageUp className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
          )}
          <span className="text-[12.5px] font-medium">
            {uploading ? "Uploading…" : "Drop an image, or click to choose a file"}
          </span>
          <span className="text-[12px] text-muted-foreground">PNG, JPEG or WebP · {MAX_MEDIA_MB} MB max</span>
        </label>
        <input
          id={fileId}
          ref={fileRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="sr-only"
          onChange={(e) => void upload(e.target.files?.[0])}
        />

        {uploadError && <Banner tone="error" text={uploadError} onDismiss={() => setUploadError(null)} />}
        {notice && <Banner tone="info" text={notice} onDismiss={() => setNotice(null)} />}
        {error && <Banner tone="error" text={error} />}

        {/* Grille */}
        {empty ? (
          <p className="rounded-[12px] border border-dashed border-border px-4 py-10 text-center text-[12.5px] text-muted-foreground">
            {query || filter !== "all"
              ? "No image matches this search."
              : "No image yet for this brand — drop one above to start the library."}
          </p>
        ) : (
          <div className="max-h-[340px] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
              {items.map((m) => (
                <Thumb key={m.id} item={m} selected={pending?.id === m.id} onSelect={() => select(m)} />
              ))}
            </div>
            {(hasMore || loading) && (
              <div className="mt-3 flex justify-center">
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <Btn onClick={() => void load(items.length)}>Load more</Btn>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Vignette */

function Thumb({ item, selected, onSelect }: { item: MediaItem; selected: boolean; onSelect: () => void }) {
  const alt = item.alt.trim();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={alt ? `Insert image: ${alt}` : "Choose image without alt text"}
      className={cn(
        "overflow-hidden rounded-[10px] border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
        selected ? "border-brand ring-2 ring-brand/30" : "border-border hover:border-brand/60",
      )}
    >
      <span className="block aspect-[4/3] w-full bg-accent/40">
        {/* eslint-disable-next-line @next/next/no-img-element -- URL Storage publique, hors loader Next */}
        <img src={item.url} alt="" loading="lazy" className="h-full w-full object-cover" />
      </span>
      <span className="block px-2 py-1.5">
        {alt ? (
          <span className="block truncate text-[11.5px] text-foreground">{alt}</span>
        ) : (
          // Défaut d'accessibilité VISIBLE : le schéma refuse de publier une image sans alt.
          <span className="flex items-center gap-1 text-[11.5px] font-medium text-[#b9790a]">
            <AlertTriangle className="h-3 w-3 shrink-0" strokeWidth={2} />
            No alt text
          </span>
        )}
        <span className="mt-0.5 block text-[11px] text-muted-foreground">
          {formatBytes(item.bytes)} · {SOURCE_LABEL[item.source]}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ Bandeau */

function Banner({ tone, text, onDismiss }: { tone: "error" | "info"; text: string; onDismiss?: () => void }) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[12px]",
        tone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-border bg-accent/40 text-muted-foreground",
      )}
    >
      <span className="flex-1">{text}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss message" className="shrink-0 opacity-70 hover:opacity-100">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </p>
  );
}
