"use client";

/**
 * MÉDIATHÈQUE — écran de gestion (`/media`).
 *
 * Le sélecteur (`picker.tsx`) sert à CHOISIR une image dans le flux du builder ; cet écran-ci sert
 * à ENTRETENIR la bibliothèque. D'où trois différences assumées :
 *
 *  1. **L'`alt` édité ici est celui du FICHIER**, pas celui d'un email. Il devient le défaut proposé
 *     à toutes les insertions futures — c'est le seul endroit où l'on répare une image muette une
 *     fois pour toutes, au lieu de ressaisir la même description à chaque usage.
 *  2. **Le retrait est une opération de rangement, pas une destruction.** Le fichier reste hébergé :
 *     son URL est figée dans les emails déjà partis, et rien ne doit pouvoir trouer une boîte de
 *     réception a posteriori. L'écran le dit avant de retirer.
 *  3. **Rien n'est présélectionné.** Un clic ouvre la fiche ; aucune action n'est destructrice au
 *     premier clic.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, ImageUp, Loader2, Search, Trash2, X } from "lucide-react";
import { Modal } from "@/components/builder/modal";
import { Btn } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  ACCEPTED_MEDIA_TYPES,
  ACCEPT_ATTR,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_MB,
  deleteMedia,
  fetchMedia,
  formatBytes,
  patchMediaAlt,
  uploadMedia,
  type MediaFilter,
  type MediaItem,
} from "./api";

const PAGE_SIZE = 40;
const MAX_ALT = 300;

const INPUT =
  "w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground " +
  "placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

const FILTERS: { value: MediaFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "upload", label: "Uploaded" },
  { value: "ai", label: "AI generated" },
  { value: "import", label: "Imported" },
];

const SOURCE_LABEL: Record<MediaItem["source"], string> = {
  upload: "Uploaded",
  ai: "AI generated",
  import: "Imported",
};

/** Format fixe : la date ne doit pas changer de forme selon la machine qui affiche l'écran. */
const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

export function MediaLibrary({ disabled = false }: { disabled?: boolean }): React.ReactElement {
  const searchId = useId();
  const fileId = useId();

  const [items, setItems] = useState<MediaItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MediaFilter>("all");

  const [selected, setSelected] = useState<MediaItem | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (offset: number) => {
      if (disabled) return;
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
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
        });
        setHasMore(page.hasMore);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "The media library could not be loaded.");
      } finally {
        if (inFlight.current === ac) setLoading(false);
      }
    },
    [query, filter, disabled],
  );

  // Recherche débattue : 250 ms pour la frappe, immédiat pour un changement de filtre.
  useEffect(() => {
    const t = setTimeout(() => void load(0), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, load]);

  useEffect(() => () => inFlight.current?.abort(), []);

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
      setNotice(
        deduplicated
          ? "That image was already in the library — the existing file is reused."
          : "Image uploaded. Add alternative text so it can be published.",
      );
      // On ouvre la fiche : une image sans alt ne doit pas rejoindre la grille en silence.
      setSelected(item);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "The upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, []);

  /** Une fiche modifiée doit se voir dans la grille sans recharger toute la page. */
  const replaceItem = useCallback((next: MediaItem) => {
    setItems((prev) => prev.map((i) => (i.id === next.id ? next : i)));
    setSelected(next);
  }, []);

  const dropItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    setSelected(null);
    setNotice("Removed from the library. The file stays hosted — emails already sent are untouched — and uploading it again brings it back.");
  }, []);

  const missingAlt = items.filter((i) => !i.alt.trim()).length;
  const empty = !loading && items.length === 0 && !error;

  return (
    <div className="space-y-3.5">
      {/* Recherche + filtres */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
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
            disabled={disabled}
            className={cn(INPUT, "pl-8 disabled:opacity-50")}
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-accent/30 p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              disabled={disabled}
              onClick={() => setFilter(f.value)}
              className={cn(
                "rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50",
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
          "flex cursor-pointer flex-wrap items-center justify-center gap-2 rounded-[12px] border-2 border-dashed px-4 py-5 text-center transition-colors",
          over ? "border-brand bg-brand-soft/40" : "border-border bg-accent/20 hover:border-brand/60",
          (uploading || disabled) && "pointer-events-none opacity-60",
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
        disabled={disabled}
        onChange={(e) => void upload(e.target.files?.[0])}
      />

      {uploadError && <Banner tone="error" text={uploadError} onDismiss={() => setUploadError(null)} />}
      {notice && <Banner tone="info" text={notice} onDismiss={() => setNotice(null)} />}
      {error && <Banner tone="error" text={error} />}

      {/* Compteur + rappel d'accessibilité : un chiffre visible vaut mieux qu'une alerte de plus. */}
      {items.length > 0 && (
        <p className="text-[12px] text-muted-foreground">
          {items.length} image{items.length === 1 ? "" : "s"} shown
          {missingAlt > 0 && (
            <span className="ml-1.5 font-medium text-[#b9790a]">
              · {missingAlt} without alt text (they cannot be published)
            </span>
          )}
        </p>
      )}

      {empty ? (
        <p className="rounded-[12px] border border-dashed border-border px-4 py-12 text-center text-[12.5px] text-muted-foreground">
          {query || filter !== "all"
            ? "No image matches this search."
            : "No image yet for this brand — drop one above to start the library."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {items.map((m) => (
              <Tile key={m.id} item={m} onOpen={() => setSelected(m)} />
            ))}
          </div>
          {(hasMore || loading) && (
            <div className="mt-4 flex justify-center">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <Btn onClick={() => void load(items.length)}>Load more</Btn>
              )}
            </div>
          )}
        </>
      )}

      {selected && (
        <MediaDetails
          item={selected}
          onClose={() => setSelected(null)}
          onSaved={replaceItem}
          onRemoved={() => dropItem(selected.id)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Vignette */

function Tile({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  const alt = item.alt.trim();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={alt ? `Open image details: ${alt}` : "Open details of an image without alt text"}
      className={cn(
        "overflow-hidden rounded-[10px] border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
        alt ? "border-border hover:border-brand/60" : "border-[#f0d9a8] hover:border-[#b9790a]",
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
          <span className="flex items-center gap-1 text-[11.5px] font-medium text-[#b9790a]">
            <AlertTriangle className="h-3 w-3 shrink-0" strokeWidth={2} />
            No alt text
          </span>
        )}
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {formatBytes(item.bytes)} · {SOURCE_LABEL[item.source]} · {formatDate(item.createdAt)}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ Fiche */

function MediaDetails({
  item,
  onClose,
  onSaved,
  onRemoved,
}: {
  item: MediaItem;
  onClose: () => void;
  onSaved: (next: MediaItem) => void;
  onRemoved: () => void;
}) {
  const altId = useId();
  const [alt, setAlt] = useState(item.alt);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Le retrait demande un second clic : la première pression n'efface rien. */
  const [confirming, setConfirming] = useState(false);

  // Changer d'image sans fermer la fiche ne doit jamais faire écrire l'alt sur la mauvaise ligne.
  useEffect(() => {
    setAlt(item.alt);
    setErr(null);
    setConfirming(false);
  }, [item.id, item.alt]);

  const dirty = alt.trim() !== item.alt.trim();

  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setErr(null);
    try {
      onSaved(await patchMediaAlt(item.id, alt.trim()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The alt text could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await deleteMedia(item.id);
      onRemoved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The image could not be removed.");
      setBusy(false);
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(item.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Presse-papiers refusé (contexte non sécurisé) : l'URL reste sélectionnable à la main.
      setErr("The clipboard is unavailable here — select the URL and copy it manually.");
    }
  }

  return (
    <Modal
      title="Image details"
      onClose={onClose}
      width="max-w-[620px]"
      footer={
        <>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className={cn(
              "mr-auto inline-flex items-center gap-2 rounded-[9px] px-3 py-2 text-[13px] font-medium transition-colors disabled:opacity-50",
              confirming
                ? "bg-red-600 text-white hover:bg-red-700"
                : "text-red-700 hover:bg-red-50",
            )}
          >
            <Trash2 className="h-[14px] w-[14px]" strokeWidth={2} />
            {confirming ? "Confirm removal" : "Remove from library"}
          </button>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Btn>
          <Btn
            variant="primary"
            onClick={() => void save()}
            disabled={busy || !dirty}
            className="disabled:opacity-50"
          >
            {busy && <Loader2 className="h-[14px] w-[14px] animate-spin" />}
            Save alt text
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        <div className="overflow-hidden rounded-[10px] border border-border bg-accent/30">
          {/* eslint-disable-next-line @next/next/no-img-element -- URL Storage publique, hors loader Next */}
          <img src={item.url} alt="" className="mx-auto max-h-[240px] w-auto max-w-full object-contain" />
        </div>

        <div>
          <label htmlFor={altId} className="mb-1.5 block text-[11px] font-semibold text-muted-foreground">
            Alternative text
          </label>
          <textarea
            id={altId}
            value={alt}
            maxLength={MAX_ALT}
            rows={2}
            onChange={(e) => setAlt(e.target.value)}
            placeholder="Describe this image for screen readers…"
            className={cn(INPUT, "resize-y")}
          />
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            {alt.trim()
              ? `${alt.trim().length}/${MAX_ALT} · offered as the default every time this image is inserted.`
              : "Without alt text this image cannot be published — the document schema refuses it."}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
          <Meta label="Source" value={SOURCE_LABEL[item.source]} />
          <Meta label="Added" value={formatDate(item.createdAt)} />
          <Meta label="Size" value={formatBytes(item.bytes)} />
          <Meta label="Type" value={item.mime} />
        </dl>

        <div className="flex items-center gap-2">
          <input readOnly value={item.url} className={cn(INPUT, "flex-1 font-mono text-[11.5px]")} />
          <Btn onClick={() => void copyUrl()}>
            {copied ? <Check className="h-[14px] w-[14px] text-[#1f9d57]" /> : <Copy className="h-[14px] w-[14px]" />}
            {copied ? "Copied" : "Copy URL"}
          </Btn>
        </div>

        {confirming && (
          <Banner
            tone="info"
            text="Removing takes the image out of the library only. The file stays hosted, so emails already sent keep showing it — and any published template that uses it keeps working."
          />
        )}
        {err && <Banner tone="error" text={err} />}
      </div>
    </Modal>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
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
