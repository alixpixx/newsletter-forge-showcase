"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Search, Users } from "lucide-react";
import { Pill, type Tone } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { SegmentMemberRow } from "@/lib/data/segment-members";

/**
 * Les abonnés d'un segment enregistré, dépliés sous sa ligne.
 *
 * ⛔ LE NOMBRE ICI EST MESURÉ À L'OUVERTURE ; CELUI DE LA COLONNE « Last measured size » L'EST AU
 * CHARGEMENT DE LA PAGE (ou, si cette mesure a échoué, c'est l'instantané daté — 25/09/2026). Les deux
 * sont affichés l'un au-dessus de l'autre : un écart entre eux se lirait comme une panne. La phrase
 * dit donc ce que le nombre mesure — qui un envoi servirait maintenant — et ce qu'une campagne peut
 * encore retirer (sa finalité de consentement).
 *
 * ⛔ TROIS ÉTATS VIDES DISTINCTS. « Personne dans ce segment », « aucune adresse ne correspond » et
 * « la liste n'a pas pu être lue » appellent trois gestes différents ; les afficher pareil enverrait
 * chercher une panne dans la règle — ou rassurerait sur une panne réelle.
 */

interface MembersPage {
  rows: SegmentMemberRow[];
  total: number;
  segmentTotal: number;
  page: number;
  pageSize: number;
  query: string;
  truncated: boolean;
  unsupported: string[];
}

type Failure = { message: string; reason: string | null; unsupported: string[] };

const LEVEL_PILL: Record<string, { tone: Tone; label: string }> = {
  active: { tone: "green", label: "Active" },
  dormant: { tone: "amber", label: "Dormant" },
  churned: { tone: "grey", label: "Lapsed" },
};

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
};

const n = (v: number) => v.toLocaleString("en-US");

export function SegmentMembers({ segmentId }: { segmentId: string }) {
  const searchId = useId();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<MembersPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (q: string, p: number) => {
      // Une frappe rapide lance plusieurs requêtes : seule la dernière compte.
      inFlight.current?.abort();
      const ac = new AbortController();
      inFlight.current = ac;
      setLoading(true);
      setFailure(null);
      try {
        // POST : la recherche est une adresse, elle n'a rien à faire dans une URL (journaux d'accès).
        const res = await fetch(`/api/segments/${segmentId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, page: p }),
          signal: ac.signal,
        });
        const body = (await res.json().catch(() => null)) as
          | (MembersPage & { error?: string; reason?: string; unsupported?: string[] })
          | null;
        if (!res.ok || !body) {
          setData(null);
          setFailure({
            message: body?.error ?? `Request failed (${res.status})`,
            reason: body?.reason ?? null,
            unsupported: Array.isArray(body?.unsupported) ? body.unsupported : [],
          });
          return;
        }
        setData(body);
        // Le serveur a pu ramener la page dans les bornes (segment rétréci entre deux clics).
        if (body.page !== p) setPage(body.page);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setData(null);
        setFailure({ message: err instanceof Error ? err.message : "Network error", reason: null, unsupported: [] });
      } finally {
        if (inFlight.current === ac) setLoading(false);
      }
    },
    [segmentId],
  );

  // Recherche débattue (250 ms) ; une nouvelle recherche repart de la première page.
  useEffect(() => {
    const next = input.trim();
    if (next === query) return;
    const t = setTimeout(() => {
      setQuery(next);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [input, query]);

  useEffect(() => {
    void load(query, page);
  }, [query, page, load]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const first = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.total, data.page * data.pageSize) : 0;
  const hasPrev = !!data && data.page > 1;
  const hasNext = !!data && data.page * data.pageSize < data.total;
  const incomplete = failure?.reason === "targeting-incomplete";

  return (
    <div className="space-y-3 border-t border-border bg-[#fcfcfe] px-[18px] py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[240px] flex-1">
          <div className="flex items-center gap-2 text-[13px]">
            <Users className="h-[15px] w-[15px] text-muted-foreground" strokeWidth={1.9} />
            {data ? (
              <span>
                <span className="font-semibold tabular-nums">{n(data.segmentTotal)}</span>
                {` subscriber${data.segmentTotal === 1 ? "" : "s"} would receive a send to this segment now`}
              </span>
            ) : failure ? (
              <span className="text-muted-foreground">
                {incomplete ? "No live count — the targeting is incomplete" : "Live count unavailable"}
              </span>
            ) : (
              <span className="text-muted-foreground">Counting subscribers…</span>
            )}
            {loading && data && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            Live count, not the stored snapshot. Unsubscribed, suppressed and demo contacts are already excluded; a
            campaign&apos;s consent purpose can still narrow it.
          </p>
        </div>
        <div className="relative w-full max-w-[300px]">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            strokeWidth={2}
          />
          <label htmlFor={searchId} className="sr-only">
            Search an email in this segment
          </label>
          <input
            id={searchId}
            type="search"
            value={input}
            maxLength={100}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search an email…"
            disabled={incomplete}
            className="w-full rounded-[9px] border border-border bg-card py-2 pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground focus:border-brand/60 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </div>

      {failure && incomplete && (
        <div className="flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p>
              Some conditions of this segment can&apos;t be applied right now, so the list would be wider than the
              rule. Nobody is listed. Open the segment in the builder to fix or remove them.
            </p>
            {failure.unsupported.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {failure.unsupported.map((u) => (
                  <code key={u} className="rounded bg-amber-100 px-1.5 py-0.5 text-[11.5px]">
                    {u}
                  </code>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {failure && !incomplete && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-700">
          <span className="flex-1">{failure.message}</span>
          <button
            onClick={() => void load(query, page)}
            className="rounded-lg border border-red-200 bg-card px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      )}

      {!data && !failure && loading && (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading subscribers…
        </div>
      )}

      {data && data.unsupported.length > 0 && (
        <p className="flex items-start gap-2 text-[12px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {`Some conditions could not be applied (${data.unsupported.join(", ")}) — this list may be narrower than the rule.`}
        </p>
      )}

      {data && data.truncated && (
        <p className="flex items-start gap-2 text-[12px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {`Too many addresses contain “${data.query}” — only part of them were checked. Type more of the address to narrow the search.`}
        </p>
      )}

      {data && data.total === 0 && (
        <div className="py-6 text-center text-[13px] text-muted-foreground">
          {data.query ? `No email matches “${data.query}”.` : "Nobody in this segment right now."}
        </div>
      )}

      {data && data.rows.length > 0 && (
        <div className={cn("overflow-hidden rounded-[10px] border border-border bg-card", loading && "opacity-60")}>
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-[11.5px] uppercase tracking-[0.02em] text-foreground/60">
                <th className="border-b border-border px-3.5 py-2 font-semibold">Email</th>
                <th className="border-b border-border px-3.5 py-2 font-semibold">Joined</th>
                <th className="border-b border-border px-3.5 py-2 font-semibold">Engagement</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const lvl = r.engagementLevel ? LEVEL_PILL[r.engagementLevel] : undefined;
                return (
                  <tr key={r.subscriptionId} className="[&:last-child>td]:border-b-0">
                    <td className="border-b border-border px-3.5 py-2 font-medium">
                      {r.email || <span className="text-muted-foreground">address unavailable</span>}
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-3.5 py-2 text-muted-foreground">
                      {fmtDate(r.joinedAt)}
                    </td>
                    <td className="border-b border-border px-3.5 py-2">
                      {lvl ? <Pill tone={lvl.tone}>{lvl.label}</Pill> : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground">
          <span className="tabular-nums">
            {`Showing ${n(first)}–${n(last)} of ${n(data.total)}${data.query ? ` matching “${data.query}”` : ""}`}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={!hasPrev || loading}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[12px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNext || loading}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[12px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
