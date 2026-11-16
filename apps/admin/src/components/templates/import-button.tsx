"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, CheckCircle2, FileCode, Loader2, Paintbrush, ShieldAlert, Upload, X } from "lucide-react";
import { Btn } from "@/components/ui";
import { TEMPLATE_CATEGORIES, categoryLabel, type TemplateCategory } from "@/components/templates/categories";
import type { ImportReport } from "@/lib/import";
import { cn } from "@/lib/utils";

/*
 * Import d'un modèle HTML écrit ailleurs.
 *
 * Règle d'honnêteté, en deux temps : on n'ouvre JAMAIS l'éditeur directement. Le rapport d'import
 * s'affiche d'abord — l'utilisateur doit voir ce qui a été retiré (scripts, liens dangereux) et ce
 * qui n'a pas pu être traduit AVANT de découvrir un email amputé dans le builder.
 *
 * Deuxième destination possible : REMPLACER le brouillon d'un modèle existant. C'est la seule
 * action de cet écran qui détruit du travail, donc elle coûte trois gestes délibérés — choisir le
 * mode, choisir le modèle, cocher que l'on a compris — et le bouton reste inerte tant que les trois
 * ne sont pas faits. Un import « qui écrase » ne doit jamais pouvoir arriver par inadvertance.
 */

const DISABLED = "cursor-not-allowed opacity-50";

/** Destination de l'import : nouveau modèle, ou remplacement du brouillon d'un modèle existant. */
type Mode = "new" | "replace";

interface TemplateChoice {
  id: string;
  name: string;
  publishedVersion: number | null;
}

/** Miroir de `MAX_HTML_BYTES` — garde côté client pour ne pas envoyer 5 Mo qui seront refusés. */
const MAX_BYTES = 2 * 1024 * 1024;

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; issues?: string[] };
    if (body?.error) {
      // Les issues de schéma sont la seule information utile quand un import échoue : on les montre.
      return body.issues?.length ? `${body.error} (${body.issues.slice(0, 3).join(" · ")})` : body.error;
    }
  } catch {
    /* corps non-JSON — on garde le statut */
  }
  return `Request failed (${res.status})`;
}

export function ImportTemplateButton({
  disabled = false,
  disabledReason,
}: {
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<TemplateCategory>("newsletter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; report: ImportReport; replaced: boolean } | null>(null);

  const [mode, setMode] = useState<Mode>("new");
  /** `null` = jamais chargée ; la liste n'est demandée que si l'on choisit d'écraser. */
  const [templates, setTemplates] = useState<TemplateChoice[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [ack, setAck] = useState(false);

  // Liste chargée à la demande : la plupart des imports créent un nouveau modèle et n'en ont
  // aucun besoin. Un échec ici ne bloque pas le mode « nouveau modèle ».
  useEffect(() => {
    if (mode !== "replace" || templates !== null) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/builder/templates", { cache: "no-store" });
        if (!res.ok) throw new Error(await readError(res));
        const body = (await res.json()) as { templates?: TemplateChoice[] };
        if (alive) setTemplates(body.templates ?? []);
      } catch (err) {
        if (alive) {
          setTemplates([]);
          setError(err instanceof Error ? err.message : "The template list could not be loaded.");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [mode, templates]);

  if (disabled) {
    return (
      <Btn variant="default" disabled title={disabledReason ?? "Unavailable"} className={DISABLED}>
        <FileCode className="h-[15px] w-[15px]" strokeWidth={2} /> Import HTML
      </Btn>
    );
  }

  function close() {
    setOpen(false);
    setHtml("");
    setFileName(null);
    setName("");
    setError(null);
    setDone(null);
    setBusy(false);
    // La confirmation d'écrasement ne survit JAMAIS à la fermeture : la case cochée hier ne
    // doit pas autoriser l'import de demain.
    setMode("new");
    setTemplateId("");
    setAck(false);
  }

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — the import limit is 2 MB.`);
      return;
    }
    setError(null);
    setFileName(file.name);
    setHtml(await file.text());
    // Nom vide : le fichier en propose un, l'utilisateur peut le changer avant d'importer.
    if (!name.trim()) setName(file.name.replace(/\.[a-z]+$/i, "").slice(0, 120));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      let payload: Record<string, unknown> = { html, name: name.trim(), category };

      if (replacing) {
        // Le serveur exige l'horodatage du brouillon qu'on s'apprête à écraser : c'est ce qui
        // distingue un remplacement voulu d'un accident, et ce qui fait échouer proprement le cas
        // où quelqu'un a modifié ce brouillon pendant qu'on remplissait ce formulaire.
        const head = await fetch(`/api/builder/templates/${templateId}`);
        if (!head.ok) {
          setError(await readError(head));
          setBusy(false);
          return;
        }
        const current = (await head.json()) as { draft?: { updatedAt?: string; updated_at?: string } };
        const baseUpdatedAt = current.draft?.updatedAt ?? current.draft?.updated_at;
        if (!baseUpdatedAt) {
          setError("Could not read the current draft — reload the page and try again.");
          setBusy(false);
          return;
        }
        payload = { html, templateId, baseUpdatedAt };
      }

      const res = await fetch("/api/builder/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // 409 = le brouillon a bougé sous nos pieds. On le dit sans jargon plutôt que d'afficher
        // « conflict », et surtout on ne réessaie pas tout seul.
        if (res.status === 409) {
          setError("This template's draft changed while you were setting up the import — nothing was replaced. Reload and try again.");
        } else {
          setError(await readError(res));
        }
        setBusy(false);
        return;
      }
      const body = (await res.json()) as { id?: string; report?: ImportReport; replaced?: boolean };
      if (!body?.id || !body?.report) {
        setError("The server did not return an imported template.");
        setBusy(false);
        return;
      }
      setDone({ id: body.id, report: body.report, replaced: body.replaced === true });
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  // Mesuré seulement quand la boîte est ouverte : recréer un Blob de 2 Mo à chaque frappe
  // hors dialogue serait du travail pour rien.
  const bytes = open && html ? new Blob([html]).size : 0;
  const tooBig = bytes > MAX_BYTES;

  const replacing = mode === "replace";
  const target = templates?.find((t) => t.id === templateId) ?? null;
  // Un seul prédicat pour l'activation du bouton ET pour la garde du submit : impossible qu'un
  // chemin autorise ce que l'autre interdit.
  const ready =
    html.trim() !== "" && !tooBig && (replacing ? templateId !== "" && ack : name.trim() !== "");

  return (
    <>
      <Btn variant="default" onClick={() => setOpen(true)}>
        <FileCode className="h-[15px] w-[15px] text-brand" strokeWidth={2} /> Import HTML
      </Btn>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Import HTML template"
        >
          <div className="max-h-[88vh] w-full max-w-[560px] overflow-y-auto rounded-[14px] border border-border bg-card p-[18px] shadow-xl">
            <div className="mb-3.5 flex items-start justify-between">
              <div>
                <h3 className="text-[13.5px] font-semibold">Import an HTML template</h3>
                <span className="text-[12px] text-muted-foreground">
                  Rebuilt into editable blocks. Scripts and unsafe links are dropped; simple CSS
                  rules are inlined so the layout keeps its colours.
                </span>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {done ? (
              <ImportSummary report={done.report} replaced={done.replaced} />
            ) : (
              <form onSubmit={submit}>
                <span className="mb-1.5 block text-[11px] font-semibold text-muted-foreground">Destination</span>
                <div
                  role="radiogroup"
                  aria-label="Import destination"
                  className="mb-3 flex items-center gap-1 rounded-lg border border-border bg-accent/30 p-0.5"
                >
                  {(["new", "replace"] as Mode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      onClick={() => setMode(m)}
                      className={cn(
                        "flex-1 rounded-[7px] px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
                        mode === m
                          ? "bg-card text-foreground shadow-[0_1px_2px_rgba(20,20,30,0.10)]"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {m === "new" ? "New template" : "Replace a draft"}
                    </button>
                  ))}
                </div>

                {replacing ? (
                  <>
                    <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="imp-target">
                      Template to overwrite
                    </label>
                    <select
                      id="imp-target"
                      value={templateId}
                      onChange={(e) => {
                        setTemplateId(e.target.value);
                        // Changer de cible invalide la confirmation : elle portait sur l'autre modèle.
                        setAck(false);
                      }}
                      className="mb-3 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
                    >
                      <option value="">
                        {templates === null ? "Loading templates…" : "Choose a template…"}
                      </option>
                      {(templates ?? []).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.publishedVersion !== null ? ` (published v${t.publishedVersion})` : ""}
                        </option>
                      ))}
                    </select>

                    {templates !== null && templates.length === 0 && (
                      <p className="mb-3 text-[11.5px] text-muted-foreground">
                        This brand has no template yet — import as a new template instead.
                      </p>
                    )}

                    {target && (
                      <label className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-800">
                        <input
                          type="checkbox"
                          checked={ack}
                          onChange={(e) => setAck(e.target.checked)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#b9790a]"
                        />
                        <span>
                          Replace the current draft of <strong>{target.name}</strong>. Everything unsaved in
                          its draft is lost and cannot be recovered.
                          {target.publishedVersion !== null && (
                            <> Published version {target.publishedVersion} is untouched and keeps being sent.</>
                          )}
                        </span>
                      </label>
                    )}
                  </>
                ) : (
                  <>
                    <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="imp-name">
                      Name
                    </label>
                    <input
                      id="imp-name"
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Weekly roundup"
                      maxLength={120}
                      className="mb-3 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-brand"
                    />

                    <label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor="imp-category">
                      Category
                    </label>
                    <select
                      id="imp-category"
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
                  </>
                )}

                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-[11px] font-semibold text-muted-foreground" htmlFor="imp-html">
                    HTML
                  </label>
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Upload className="h-[13px] w-[13px]" /> Choose a .html file
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".html,.htm,text/html"
                    className="hidden"
                    onChange={pickFile}
                  />
                </div>
                <textarea
                  id="imp-html"
                  value={html}
                  onChange={(e) => {
                    setHtml(e.target.value);
                    setFileName(null);
                  }}
                  rows={8}
                  spellCheck={false}
                  placeholder="Paste your HTML here, or pick a file above."
                  className="mb-1 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[12px] outline-none focus:border-brand"
                />
                <p className="mb-3 text-[11.5px] text-muted-foreground">
                  {fileName ? `${fileName} · ` : ""}
                  {html.trim() ? `${(bytes / 1024).toFixed(0)} KB` : "Nothing to import yet"}
                  {tooBig && <span className="ml-1 text-red-700">— over the 2 MB limit</span>}
                </p>

                {error && (
                  <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">
                    {error}
                  </p>
                )}

                <div className="flex justify-end gap-2.5">
                  <Btn type="button" variant="ghost" onClick={close} disabled={busy}>
                    Cancel
                  </Btn>
                  <Btn
                    type="submit"
                    variant="primary"
                    disabled={busy || !ready}
                    className={cn((busy || !ready) && DISABLED)}
                  >
                    {busy && <Loader2 className="h-[14px] w-[14px] animate-spin" />}
                    {busy ? "Importing…" : replacing ? "Replace draft" : "Import"}
                  </Btn>
                </div>
              </form>
            )}

            {done && (
              <div className="mt-4 flex justify-end gap-2.5">
                <Btn type="button" variant="ghost" onClick={close}>
                  Stay here
                </Btn>
                <Btn variant="primary" onClick={() => router.push(`/builder/${done.id}`)}>
                  Open in builder <ArrowRight className="h-[14px] w-[14px]" strokeWidth={2} />
                </Btn>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Rapport */

function ImportSummary({ report, replaced }: { report: ImportReport; replaced: boolean }) {
  const types = Object.entries(report.byType).filter(([, n]) => (n ?? 0) > 0);
  const risky = report.fallbackHtml > 0 || report.truncated;

  return (
    <div className="text-[12.5px]">
      <div className="mb-3 flex items-start gap-2.5 rounded-[10px] border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-emerald-800">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {replaced ? "Replaced the draft with " : "Imported "}
          <strong>{report.blocks}</strong> block{report.blocks === 1 ? "" : "s"} across{" "}
          <strong>{report.rows}</strong> row{report.rows === 1 ? "" : "s"}.
        </span>
      </div>

      {/* Le style repris compte autant que ce qui a été retiré : sans ce chiffre, un import
          « en noir et blanc » ressemble à une panne alors que la source n'avait aucun style. */}
      {(report.inlinedDeclarations > 0 || report.externalStylesheets > 0) && (
        <div className="mb-3 flex items-start gap-2.5 rounded-[10px] border border-border bg-background px-3 py-2.5">
          <Paintbrush className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            {report.inlinedDeclarations > 0 && (
              <>
                {report.inlinedDeclarations} style declaration{report.inlinedDeclarations === 1 ? "" : "s"} from{" "}
                <code>&lt;style&gt;</code> applied to the matching elements
                {report.skippedSelectors > 0 && `, ${report.skippedSelectors} rule(s) too complex to apply`}.{" "}
              </>
            )}
            {report.externalStylesheets > 0 && (
              <>
                {report.externalStylesheets} external stylesheet{report.externalStylesheets === 1 ? "" : "s"}{" "}
                {report.externalStylesheets === 1 ? "was" : "were"} not downloaded — paste those rules into a{" "}
                <code>&lt;style&gt;</code> block to keep them.
              </>
            )}
          </span>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {types.map(([type, n]) => (
          <span key={type} className="rounded-full bg-accent px-2.5 py-[3px] text-[11.5px] font-semibold text-muted-foreground">
            {n}× {type}
          </span>
        ))}
      </div>

      {risky && (
        <div className="mb-3 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {report.fallbackHtml > 0 && (
              <>
                {report.fallbackHtml} chunk{report.fallbackHtml === 1 ? "" : "s"} could not be turned into an editable
                block and {report.fallbackHtml === 1 ? "was" : "were"} kept as raw HTML.{" "}
              </>
            )}
            {report.truncated && <>The document hit an import limit, so the end may be missing.</>}
          </span>
        </div>
      )}

      {report.removed.length > 0 && (
        <div className="mb-3 flex items-start gap-2.5 rounded-[10px] border border-border bg-background px-3 py-2.5">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            Removed for safety:{" "}
            {report.removed.map((r) => `${r.count}× <${r.tag}>`).join(", ")}
            {report.strippedAttributes > 0 && `, ${report.strippedAttributes} unsafe attribute(s)`}
            {report.unsafeUrls > 0 && `, ${report.unsafeUrls} unsafe URL(s)`}.
          </span>
        </div>
      )}

      {report.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-[12px] text-muted-foreground">
          {report.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
