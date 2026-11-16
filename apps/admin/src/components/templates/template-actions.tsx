"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Copy, Pencil, Plus, RotateCcw, Loader2, X } from "lucide-react";
import { Btn } from "@/components/ui";
import { TEMPLATE_CATEGORIES, categoryLabel, type TemplateCategory } from "@/components/templates/categories";
import { cn } from "@/lib/utils";

/*
 * Actions RÉELLES de la bibliothèque de modèles — elles appellent le contrat /api/builder/*.
 * Règle d'honnêteté : aucun faux succès. Une erreur réseau/HTTP est affichée telle quelle,
 * et la navigation (push/refresh) n'a lieu qu'après une réponse 2xx.
 */

const DISABLED = "cursor-not-allowed opacity-50";

/** Lit `{ error }` du corps JSON, sinon retombe sur le statut HTTP. */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* corps non-JSON — on garde le statut */
  }
  return `Request failed (${res.status})`;
}

/* ------------------------------------------------------------------ New template */

export function NewTemplateButton({
  disabled = false,
  disabledReason,
}: {
  /** true quand aucune marque n'est résolue en base : créer échouerait côté API. */
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<TemplateCategory>("newsletter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (disabled) {
    return (
      <Btn variant="primary" disabled title={disabledReason ?? "Unavailable"} className={DISABLED}>
        <Plus className="h-[15px] w-[15px]" strokeWidth={2} /> New template
      </Btn>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/builder/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, category }),
      });
      if (!res.ok) {
        setError(await readError(res));
        setBusy(false);
        return;
      }
      const body = (await res.json()) as { id?: string };
      if (!body?.id) {
        setError("The server did not return a template id.");
        setBusy(false);
        return;
      }
      // Succès réel uniquement : on part directement éditer le brouillon.
      router.push(`/builder/${body.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  return (
    <>
      <Btn variant="primary" onClick={() => setOpen(true)}>
        <Plus className="h-[15px] w-[15px]" strokeWidth={2} /> New template
      </Btn>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="New template"
        >
          <form
            onSubmit={submit}
            className="w-full max-w-[420px] rounded-[14px] border border-border bg-card p-[18px] shadow-xl"
          >
            <div className="mb-3.5 flex items-start justify-between">
              <div>
                <h3 className="text-[13.5px] font-semibold">New template</h3>
                <span className="text-[12px] text-muted-foreground">
                  Creates an empty draft in the current brand.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="tpl-name">
              Name
            </label>
            <input
              id="tpl-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Daily pick"
              maxLength={120}
              className="mb-3 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
            />

            <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="tpl-category">
              Category
            </label>
            <select
              id="tpl-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as TemplateCategory)}
              className="mb-3 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
            >
              {TEMPLATE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>

            {error && (
              <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2.5">
              <Btn type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Btn>
              <Btn
                type="submit"
                variant="primary"
                disabled={busy || name.trim().length === 0}
                className={cn((busy || name.trim().length === 0) && DISABLED)}
              >
                {busy && <Loader2 className="h-[14px] w-[14px] animate-spin" />}
                {busy ? "Creating…" : "Create & edit"}
              </Btn>
            </div>
          </form>
        </div>
      )}
    </>
  );
}


/* ------------------------------------------------------------------- Rename */

/**
 * Renomme le template. Le SLUG ne bouge pas : c'est l'identifiant stable, le nom n'est qu'un
 * affichage. Les changer ensemble casserait les références pour un simple confort d'étiquette.
 */
export function RenameButton({ id, name, category }: { id: string; name: string; category: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [cat, setCat] = useState<TemplateCategory>(category as TemplateCategory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/builder/templates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, category: cat }),
      });
      if (!res.ok) {
        setError(await readError(res));
        setBusy(false);
        return;
      }
      setBusy(false);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  return (
    <>
      <Btn variant="ghost" onClick={() => { setValue(name); setCat(category as TemplateCategory); setOpen(true); }} aria-label={`Rename ${name}`}>
        <Pencil className="h-[14px] w-[14px]" /> Rename
      </Btn>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Rename template">
          <form onSubmit={submit} className="w-full max-w-[420px] rounded-[14px] border border-border bg-card p-[18px] shadow-xl">
            <div className="mb-3.5 flex items-start justify-between">
              <div>
                <h3 className="text-[13.5px] font-semibold">Rename template</h3>
                <span className="text-[12px] text-muted-foreground">
                  The identifier stays the same — only the label changes.
                </span>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor={`rn-${id}`}>Name</label>
            <input
              id={`rn-${id}`}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={120}
              className="mb-3 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
            />

            <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor={`rc-${id}`}>Category</label>
            <select
              id={`rc-${id}`}
              value={cat}
              onChange={(e) => setCat(e.target.value as TemplateCategory)}
              className="mb-3 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
            >
              {TEMPLATE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{categoryLabel(c)}</option>
              ))}
            </select>

            {error && <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">{error}</p>}

            <div className="flex justify-end gap-2.5">
              <Btn type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Btn>
              <Btn type="submit" variant="primary" disabled={busy || value.trim().length === 0} className={cn((busy || value.trim().length === 0) && DISABLED)}>
                {busy && <Loader2 className="h-[14px] w-[14px] animate-spin" />}
                {busy ? "Saving…" : "Save"}
              </Btn>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Archive */

/**
 * ARCHIVE, et non suppression. Détruire un template emporterait ses versions publiées — donc la
 * trace de ce qui a réellement été envoyé aux abonnés. On ne détruit pas une preuve d'envoi pour
 * ranger une bibliothèque. Le libellé le dit franchement plutôt que de promettre une suppression.
 */
export function ArchiveButton({ id, name, published }: { id: string; name: string; published: number | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    const extra =
      published !== null
        ? `\n\nIt has published version${published > 1 ? "s" : ""} up to v${published}. Those stay in the send history — nothing already sent is affected.`
        : "";
    if (!window.confirm(`Archive "${name}"? It disappears from the library but is not destroyed.${extra}`)) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/builder/templates/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await readError(res));
        setBusy(false);
        return;
      }
      setBusy(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Btn variant="ghost" onClick={run} disabled={busy} aria-label={`Archive ${name}`} className={cn(busy && DISABLED)}>
        {busy ? <Loader2 className="h-[14px] w-[14px] animate-spin" /> : <Archive className="h-[14px] w-[14px]" />}
        Archive
      </Btn>
      {error && <span className="text-[11.5px] text-red-700">{error}</span>}
    </span>
  );
}

/* -------------------------------------------------------------------- Duplicate */

export function DuplicateButton({
  id,
  name,
  variant = "ghost",
  label = "Duplicate",
}: {
  id: string;
  name: string;
  variant?: "default" | "ghost";
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/builder/templates/${id}/duplicate`, { method: "POST" });
      if (!res.ok) {
        setError(await readError(res));
        setBusy(false);
        return;
      }
      setBusy(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Btn
        variant={variant}
        onClick={run}
        disabled={busy}
        aria-label={`Duplicate ${name}`}
        className={cn(busy && DISABLED)}
      >
        {busy ? <Loader2 className="h-[14px] w-[14px] animate-spin" /> : <Copy className="h-[14px] w-[14px]" />}
        {label}
      </Btn>
      {error && <span className="text-[11.5px] text-red-700">{error}</span>}
    </span>
  );
}

/* ---------------------------------------------------------------------- Restore */

export function RestoreButton({ id, version }: { id: string; version: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    // La restauration ÉCRASE le brouillon courant : on demande confirmation, elle n'est pas annulable.
    const ok = window.confirm(
      `Restore version ${version}? This overwrites the current draft — unpublished changes are lost.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/builder/templates/${id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        setError(await readError(res));
        setBusy(false);
        return;
      }
      setBusy(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Btn
        variant="default"
        onClick={run}
        disabled={busy}
        aria-label={`Restore version ${version}`}
        className={cn("px-3 py-1.5 text-[12.5px]", busy && DISABLED)}
      >
        {busy ? <Loader2 className="h-[13px] w-[13px] animate-spin" /> : <RotateCcw className="h-[13px] w-[13px]" />}
        Restore
      </Btn>
      {error && <span className="text-[11.5px] text-red-700">{error}</span>}
    </span>
  );
}
