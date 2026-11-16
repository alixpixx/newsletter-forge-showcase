import Link from "next/link";
import { PERIODES, libellePeriode, type Periode } from "@/lib/analytics-params";
import { cn } from "@/lib/utils";

/*
 * Navigation d'Analytics (0094) — composants serveur, sans état : l'onglet et la période vivent dans
 * l'URL, se partagent et survivent au rechargement.
 */

const ONGLETS = [
  { cle: "campaigns", label: "Campaigns", href: "/analytics" },
  { cle: "automations", label: "Automations", href: "/analytics/automations" },
  { cle: "audience", label: "Audience", href: "/analytics/audience" },
] as const;

/** Les trois onglets d'Analytics ; l'actif porte `aria-current="page"`. */
export function AnalyticsTabs({ active }: { active: "campaigns" | "automations" | "audience" }) {
  return (
    <nav aria-label="Analytics sections" className="mb-4 flex gap-1 border-b border-border">
      {ONGLETS.map((o) => (
        <Link
          key={o.cle}
          href={o.href}
          aria-current={o.cle === active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
            o.cle === active
              ? "border-brand font-semibold"
              : "border-transparent font-medium text-muted-foreground transition-colors hover:text-foreground",
          )}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Le filtre de période d'un onglet (30 j / 90 j / tout) — mêmes valeurs et même aspect que la liste
 * des campagnes. 90 jours est le défaut : il n'apparaît pas dans l'URL.
 */
export function AnalyticsPeriods({ path, periode }: { path: string; periode: Periode }) {
  return (
    <nav aria-label="Period" className="inline-flex rounded-[9px] border border-border bg-card p-0.5">
      {PERIODES.map((p) => (
        <Link
          key={p}
          href={p === "90" ? path : `${path}?period=${p}`}
          aria-current={p === periode ? "page" : undefined}
          className={cn(
            "rounded-[7px] px-2.5 py-1.5 text-[12.5px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
            p === periode ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {libellePeriode(p)}
        </Link>
      ))}
    </nav>
  );
}
