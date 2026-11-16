"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill, type Tone } from "@/components/ui";

/**
 * Sources WordPress d'une marque — l'écran qui remplace la ligne statique « WordPress · Not configured ».
 *
 * CE QUE CET ÉCRAN REFUSE DE FAIRE : afficher « connecté » sur la foi d'une URL bien formée. Une
 * source naît en `unknown` et ne devient `ok` qu'après une SONDE. Sur les 9 domaines des marques,
 * quatre répondent (Atlas Review, Northwind Sports, Copper Kettle, Harbor Tech) et cinq échouent de quatre façons
 * différentes : un écran optimiste se tromperait cinq fois sur neuf, et ne se ferait démentir qu'au
 * premier envoi.
 *
 * ⛔ Le mot de passe applicatif n'a pas de champ ici et ne transite jamais par cette page. On
 * n'affiche que le NOM de la variable d'environnement attendue et un booléen « posée / absente ».
 */

/**
 * Chemin de lecture d'une source.
 *
 * ⛔ CE CHOIX DOIT EXISTER À L'ÉCRAN. Deux des marques du parc — lumen-living.example et bluefin-news.example —
 * répondent 404 sur `/wp-json` : sans ce sélecteur, la seule façon de les déclarer était un POST
 * d'API à la main, et la seule façon de réparer une source mal typée était du SQL. Un lecteur de
 * flux qu'aucun écran n'atteint n'est pas livré.
 */
type WpSourceKind = "wp-rest" | "rss";

const KIND_LABEL: Record<WpSourceKind, string> = {
  "wp-rest": "REST API",
  rss: "RSS feed",
};

export interface WpSourceView {
  id: string;
  editionId: string;
  label: string;
  restRoot: string;
  /**
   * Facultatif À DESSEIN : la page qui rend ce composant peut ne pas encore le passer. On retombe
   * alors sur `wp-rest`, qui est le défaut de la base (migration 0024) — donc jamais une invention.
   */
  kind?: WpSourceKind;
  status: "unknown" | "ok" | "error";
  statusDetail: string | null;
  lastProbedAt: string | null;
  authKind: "none" | "app_password";
  authUser: string | null;
  capabilities: Record<string, unknown>;
  editionLabel?: string | null;
  secretVarName: string;
  hasSecret: boolean;
}

export interface EditionView {
  id: string;
  label: string;
}

const INPUT =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-brand";

const TONE: Record<WpSourceView["status"], { tone: Tone; label: string }> = {
  ok: { tone: "green", label: "Connected" },
  error: { tone: "red", label: "Failing" },
  unknown: { tone: "grey", label: "Never tested" },
};

/** Nombre lisible, ou tiret : afficher « 0 » là où on n'a rien mesuré serait un chiffre inventé. */
const numOrDash = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : "—";

function ago(iso: string | null): string {
  if (!iso) return "never tested";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "never tested";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "tested minutes ago";
  if (h < 48) return `tested ${h} h ago`;
  return `tested ${Math.floor(h / 24)} d ago`;
}

export function WpSources({
  initial,
  editions,
  readError,
}: {
  initial: WpSourceView[];
  editions: EditionView[];
  /** Message de la base quand la liste n'a PAS pu être lue — distinct d'une liste vide. */
  readError?: string | null;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [label, setLabel] = useState("");
  const [restRoot, setRestRoot] = useState("");
  const [editionId, setEditionId] = useState(editions[0]?.id ?? "");
  const [authUser, setAuthUser] = useState("");
  const [kind, setKind] = useState<WpSourceKind>("wp-rest");

  async function read(res: Response): Promise<string> {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? `HTTP ${res.status}`;
  }

  /** Sonde une source existante ET enregistre le verdict — le bouton « Test ». */
  async function test(id: string) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/builder/wp/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: id }),
      });
      if (!res.ok) {
        setError(await read(res));
        return;
      }
      const body = (await res.json()) as { source?: WpSourceView | null };
      if (body.source) setRows((r) => r.map((s) => (s.id === id ? { ...s, ...body.source! } : s)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (busy) return;
    setBusy("create");
    setError(null);
    try {
      const res = await fetch("/api/builder/wp/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          editionId,
          label,
          restRoot,
          kind,
          authKind: authUser.trim() ? "app_password" : "none",
          authUser: authUser.trim() || null,
        }),
      });
      if (!res.ok) {
        setError(await read(res));
        return;
      }
      const body = (await res.json()) as { source: WpSourceView };
      setRows((r) => [body.source, ...r]);
      setAdding(false);
      setLabel("");
      setRestRoot("");
      setAuthUser("");
      setKind("wp-rest");
      // Une source déclarée n'est pas une source qui répond : on sonde tout de suite, sinon
      // l'opérateur repart avec une ligne « Never tested » qu'il croira acquise.
      void test(body.source.id);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Change le chemin de lecture d'une source existante.
   *
   * ⚠️ RE-SONDER TOUT DE SUITE. Le serveur remet `capabilities`/`status` à `unknown` quand le type
   * change — elles décrivaient l'autre chemin. Sans la sonde qui suit, la ligne resterait
   * « Never tested » et l'opérateur croirait avoir cassé une source qui répond très bien.
   */
  async function changeKind(id: string, next: WpSourceKind) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/builder/wp/sources/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: next }),
      });
      if (!res.ok) {
        setError(await read(res));
        return;
      }
      const body = (await res.json()) as { source: WpSourceView };
      setRows((r) => r.map((s) => (s.id === id ? { ...s, ...body.source } : s)));
      void test(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string, name: string) {
    if (busy) return;
    if (!window.confirm(`Delete the source "${name}"? Emails already sent are not affected.`)) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/builder/wp/sources/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await read(res));
        return;
      }
      setRows((r) => r.filter((s) => s.id !== id));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-800">
          <AlertTriangle className="mt-[1px] h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ⚠️ Une lecture impossible ne se raconte JAMAIS comme « rien à afficher » : le second est
          rassurant, le premier est une panne. Le message de la base est montré tel quel — c'est lui
          qui nomme la cause (table absente, droits refusés). */}
      {readError && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-900">
          <AlertTriangle className="mt-[1px] h-4 w-4 shrink-0" />
          <span>
            Sources could not be read — the list below is not empty, it is unknown.
            <br />
            <code className="font-mono text-[11.5px]">{readError}</code>
          </span>
        </div>
      )}

      {rows.length === 0 && !adding && !readError && (
        <p className="text-[12.5px] text-muted-foreground">
          No WordPress source yet. Add the site this brand publishes on — articles will then be
          insertable into the builder.
        </p>
      )}

      {rows.map((s) => {
        const caps = s.capabilities as {
          posts?: unknown;
          categories?: unknown;
          tags?: unknown;
          embed?: unknown;
          dateFilter?: unknown;
          popularPosts?: unknown;
          siteName?: unknown;
        };
        return (
          <div key={s.id} className="rounded-xl border border-border bg-card px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-semibold">{s.label}</span>
              <Pill tone={TONE[s.status].tone} dot>
                {TONE[s.status].label}
              </Pill>
              {s.editionLabel && <Pill tone="grey">{s.editionLabel}</Pill>}
              <span className="ml-auto text-[11.5px] text-muted-foreground">{ago(s.lastProbedAt)}</span>
              {/* Le chemin de lecture est MODIFIABLE ici : une source déclarée du mauvais type se
                  réparait jusqu'ici en SQL, ou en la supprimant pour la recréer. */}
              <select
                value={s.kind ?? "wp-rest"}
                onChange={(e) => changeKind(s.id, e.target.value === "rss" ? "rss" : "wp-rest")}
                disabled={busy !== null}
                title="How this source is read"
                aria-label={`How "${s.label}" is read`}
                className="rounded-lg border border-border bg-card px-2 py-1.5 text-[12px] outline-none focus:border-brand disabled:opacity-50"
              >
                <option value="wp-rest">{KIND_LABEL["wp-rest"]}</option>
                <option value="rss">{KIND_LABEL.rss}</option>
              </select>
              <button
                onClick={() => test(s.id)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium hover:bg-muted disabled:opacity-50"
              >
                {busy === s.id ? (
                  <Loader2 className="h-[13px] w-[13px] animate-spin" />
                ) : (
                  <RefreshCw className="h-[13px] w-[13px]" />
                )}
                Test
              </button>
              <button
                onClick={() => remove(s.id, s.label)}
                disabled={busy !== null}
                className="inline-flex items-center rounded-lg border border-border px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-muted disabled:opacity-50"
                title="Delete this source"
              >
                <Trash2 className="h-[13px] w-[13px]" />
              </button>
            </div>

            <p className="mt-1 truncate text-[11.5px] text-muted-foreground">
              {s.restRoot}
              {typeof caps.siteName === "string" ? ` · ${caps.siteName}` : ""}
            </p>

            {/* Le verdict d'échec est RACONTÉ. « Failing » sans raison oblige à deviner. */}
            {s.status === "error" && s.statusDetail && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-800">{s.statusDetail}</p>
            )}

            {s.status === "ok" && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground tabular-nums">
                <span>{numOrDash(caps.posts)} articles</span>
                <span>{numOrDash(caps.categories)} categories</span>
                <span>{numOrDash(caps.tags)} tags</span>
                <Cap ok={caps.embed === true} yes="thumbnails" no="no thumbnails" />
                <Cap ok={caps.dateFilter === true} yes="date filter" no="no date filter" />
                {/* ⛔ Mesuré absent partout, et ça reste VRAI : ce site n'expose pas de popularité.
                    ⚠️ Mais la phrase seule est devenue trompeuse par implication depuis le 01/09 —
                    on lit « donc pas de tri par vues », alors que les vues arrivent maintenant de
                    l'analytics. Elle est donc COMPLÉTÉE, pas retirée : effacer un fait vrai pour
                    éviter un malentendu remplace un demi-mensonge par un autre. */}
                <span
                  className="inline-flex items-center gap-1 text-muted-foreground/70"
                  title="View counts in the import dialog come from analytics (data-warehouse), not from this site. This line is about the WordPress site itself."
                >
                  <X className="h-3 w-3" />
                  no popularity endpoint on this site — view counts come from analytics
                </span>
              </div>
            )}

            {s.authKind === "app_password" && (
              <p className="mt-2 text-[11.5px] text-muted-foreground">
                Application password as <code className="font-mono">{s.authUser}</code> — secret read
                from <code className="font-mono">{s.secretVarName}</code>{" "}
                {s.hasSecret ? (
                  <span className="text-emerald-700">(set)</span>
                ) : (
                  <span className="text-amber-700">(missing — set it in Vercel, never in the database)</span>
                )}
              </p>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="rounded-xl border border-border bg-muted/40 px-3.5 py-3">
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11.5px] font-semibold text-foreground/80">Name</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Atlas Review · BR"
                className={INPUT}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11.5px] font-semibold text-foreground/80">Edition</label>
              <select value={editionId} onChange={(e) => setEditionId(e.target.value)} className={INPUT}>
                {editions.map((ed) => (
                  <option key={ed.id} value={ed.id}>
                    {ed.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-[11.5px] font-semibold text-foreground/80">Read via</label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value === "rss" ? "rss" : "wp-rest")}
                className={INPUT}
              >
                <option value="wp-rest">{KIND_LABEL["wp-rest"]}</option>
                <option value="rss">{KIND_LABEL.rss}</option>
              </select>
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                Pick <strong>RSS feed</strong> when the site answers 404 on <code className="font-mono">/wp-json</code>
                . A feed carries no categories and only its latest entries — the article grid says so
                above the cards. Not sure? Add it as REST API and press Test: a failing probe tells you.
              </p>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-[11.5px] font-semibold text-foreground/80">Site URL</label>
              <input
                value={restRoot}
                onChange={(e) => setRestRoot(e.target.value)}
                placeholder={kind === "rss" ? "https://www.lumen-living.example" : "https://atlas-review.example"}
                className={INPUT}
              />
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                Site root, not the API path. A language section is a separate source:{" "}
                <code className="font-mono">https://atlas-review.example/en</code>.
                {kind === "rss" && (
                  <>
                    {" "}
                    The feed is found from the site root; paste the feed URL itself only if the site
                    does not advertise it.
                  </>
                )}
              </p>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-[11.5px] font-semibold text-foreground/80">
                Application password user <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <input
                value={authUser}
                onChange={(e) => setAuthUser(e.target.value)}
                placeholder="newsletter-bot"
                className={INPUT}
              />
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                Only needed when the site blocks its REST API. The password itself goes in a Vercel
                environment variable — it is never stored here.
              </p>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={create}
              disabled={busy !== null || label.trim() === "" || restRoot.trim() === "" || editionId === ""}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-[12.5px] font-semibold text-white",
                "disabled:opacity-50",
              )}
            >
              {busy === "create" ? (
                <Loader2 className="h-[14px] w-[14px] animate-spin" />
              ) : (
                <Check className="h-[14px] w-[14px]" />
              )}
              Add and test
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
              className="rounded-lg border border-border px-3 py-2 text-[12.5px] hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          disabled={editions.length === 0}
          title={editions.length === 0 ? "This brand has no edition to attach a source to" : undefined}
          className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
        >
          <Plus className="h-[14px] w-[14px]" /> Add a source
        </button>
      )}
    </div>
  );
}

function Cap({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", ok ? "text-emerald-700" : "text-muted-foreground/70")}>
      {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      {ok ? yes : no}
    </span>
  );
}
