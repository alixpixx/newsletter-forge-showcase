"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronRight, FolderOpen, Loader2, Trash2 } from "lucide-react";
import { Td, Th } from "@/components/ui";
import { SegmentMembers } from "@/components/segments/segment-members";
import { savedSegmentSize } from "@/components/segments/saved-segment-size";
import type { LiveSegmentSize } from "@/lib/data/segment-sizes";
import { cn } from "@/lib/utils";

/**
 * Segments enregistrés de la marque.
 *
 * Le compte affiché est MESURÉ au chargement de la page (`live`, voir `segment-sizes.ts`). Si la mesure
 * échoue, on retombe sur l'instantané enregistré À CÔTÉ DE SA DATE et de la raison — un nombre sans son
 * âge laisserait croire qu'il est d'aujourd'hui.
 */
export interface SavedSegment {
  id: string;
  name: string;
  summary: string;
  cachedCount: number | null;
  cachedAt: string | null;
  live: LiveSegmentSize | null;
  usedByAutomation: boolean;
  updatedAt: string;
}

const fmt = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
};

export function SavedSegments({ segments }: { segments: SavedSegment[] }) {
  // Un seul segment déplié à la fois : chaque dépliage interroge la base, et deux listes ouvertes
  // l'une sous l'autre se liraient comme une seule.
  const [open, setOpen] = useState<string | null>(null);

  if (segments.length === 0) {
    return (
      <div className="mt-4 overflow-hidden rounded-[14px] border border-border bg-card">
        <div className="px-[18px] pb-3 pt-4">
          <h3 className="text-[13.5px] font-semibold">Saved segments</h3>
        </div>
        <div className="flex flex-col items-center justify-center gap-2.5 border-t border-border py-12 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent">
            <FolderOpen className="h-5 w-5 text-muted-foreground" strokeWidth={1.9} />
          </div>
          <div className="text-[14px] font-semibold">No saved segments yet</div>
          <p className="max-w-[52ch] text-[12.5px] text-muted-foreground">
            Build a rule above and save it — campaigns pick their audience from this list.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 overflow-hidden rounded-[14px] border border-border bg-card">
      <div className="flex items-center justify-between px-[18px] pb-3 pt-4">
        <h3 className="text-[13.5px] font-semibold">Saved segments</h3>
        <span className="text-[12px] text-muted-foreground">
          {segments.length} segment{segments.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[680px] border-collapse text-[13px]">
          <thead>
            <tr className="bg-[#fcfcfe]">
              <Th>Segment</Th>
              <Th>Last measured size</Th>
              <Th>Updated</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => {
              const isOpen = open === s.id;
              const panelId = `segment-members-${s.id}`;
              return (
                <Fragment key={s.id}>
                  <tr className={cn("transition-colors hover:bg-brand-soft/40", isOpen && "bg-brand-soft/30")}>
                    <Td className="font-semibold">
                      <div className="flex items-start gap-2">
                        <button
                          onClick={() => setOpen(isOpen ? null : s.id)}
                          aria-expanded={isOpen}
                          aria-controls={panelId}
                          aria-label={`${isOpen ? "Hide" : "Show"} the subscribers of ${s.name}`}
                          title={isOpen ? "Hide subscribers" : "Show subscribers"}
                          className="mt-px rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <ChevronRight className={cn("h-4 w-4 transition-transform", isOpen && "rotate-90")} strokeWidth={2} />
                        </button>
                        <div className="min-w-0">
                          {s.name}
                          <div className="mt-0.5 max-w-[46ch] truncate font-normal text-[11.5px] text-muted-foreground">
                            {s.summary}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">
                      <SizeCell s={s} />
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{fmt(s.updatedAt)}</Td>
                    <Td>
                      <DeleteSegment id={s.id} name={s.name} locked={s.usedByAutomation} />
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr>
                      {/* `Td` ne prend pas de colSpan : cellule simple, la liste porte son propre cadre. */}
                      <td id={panelId} colSpan={4} className="border-b border-border p-0">
                        <SegmentMembers segmentId={s.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Exportée pour le banc (`saved-segment-size.test.ts`) : c'est la case que lit Alix. */
export function SizeCell({ s }: { s: SavedSegment }) {
  const v = savedSegmentSize({ count: s.cachedCount, at: s.cachedAt }, s.live);
  if (v.kind === "live") {
    return (
      <>
        {v.count.toLocaleString("en-US")}
        <span className="ml-1.5 text-[11.5px] text-muted-foreground">now</span>
      </>
    );
  }
  return (
    <>
      {v.kind === "none" ? (
        <span className="text-muted-foreground">never measured</span>
      ) : (
        <>
          {v.count.toLocaleString("en-US")}
          <span className="ml-1.5 text-[11.5px] text-muted-foreground">on {fmt(v.at)}</span>
        </>
      )}
      <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-amber-700">
        <AlertTriangle className="h-3 w-3 shrink-0" strokeWidth={2} />
        {v.why}
      </div>
    </>
  );
}

function DeleteSegment({ id, name, locked }: { id: string; name: string; locked: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    if (!window.confirm(`Delete “${name}”? Campaigns that already went out are not affected.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/segments/${id}`, { method: "DELETE" });
      if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try {
          const b = (await res.json()) as { error?: string };
          if (b?.error) msg = b.error;
        } catch {
          /* corps non-JSON */
        }
        setError(msg);
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
      <button
        onClick={run}
        disabled={busy || locked}
        aria-label={`Delete ${name}`}
        title={locked ? "Used by an automation — detach it there first" : undefined}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] transition-colors hover:bg-accent",
          (busy || locked) && "cursor-not-allowed opacity-50",
        )}
      >
        {busy ? <Loader2 className="h-[13px] w-[13px] animate-spin" /> : <Trash2 className="h-[13px] w-[13px]" />}
        Delete
      </button>
      {error && <span className="max-w-[34ch] text-[11.5px] text-red-700">{error}</span>}
    </span>
  );
}
