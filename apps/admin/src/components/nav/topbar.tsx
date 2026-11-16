import Link from "next/link";
import { Search, Plus } from "lucide-react";
import { Notifications } from "./notifications";
import { MobileNav, type NavProps } from "./sidebar";

export function Topbar({ current, options, viewer }: NavProps) {
  return (
    <header className="sticky top-0 z-20 flex h-[60px] items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur sm:gap-4 sm:px-7">
      {/* Navigation mobile : la sidebar est masquée sous 768 px. */}
      <MobileNav current={current} options={options} viewer={viewer} />

      {/* Marque courante — dérivée du contexte, plus « Quartz Tips · BR » en dur. */}
      <span
        className="truncate rounded-full bg-brand-soft px-2 py-[3px] text-[11px] font-semibold text-brand-soft-foreground"
        title={current.fromDb ? undefined : "Read from local config — database unreachable"}
      >
        {current.market ? `${current.name} · ${current.market}` : current.name}
      </span>

      {/* Recherche globale non branchée : désactivée plutôt que de simuler un champ actif. */}
      <div
        className="ml-auto hidden items-center gap-2 rounded-[9px] border border-border bg-card px-2.5 py-[7px] text-muted-foreground opacity-60 sm:flex sm:w-[230px]"
        title="Coming soon"
      >
        <Search className="h-[15px] w-[15px] text-muted-foreground/60" />
        <input
          placeholder="Search…"
          aria-label="Search (coming soon)"
          disabled
          className="flex-1 cursor-not-allowed border-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="ml-auto flex items-center gap-3 sm:ml-0 sm:gap-4">
        <Notifications />

        {/* Raccourci global (navigation) — la création réelle se fait via l'assistant sur /campaigns */}
        <Link
          href="/campaigns"
          className="flex items-center gap-2 rounded-[9px] bg-brand px-3 py-2 text-[13px] font-medium text-brand-foreground shadow-[0_1px_3px_rgba(255,54,141,0.35)] transition-colors hover:bg-[#ec2079] sm:px-3.5"
        >
          <Plus className="h-[15px] w-[15px]" strokeWidth={2} />
          <span className="hidden sm:inline">New campaign</span>
          <span className="sr-only sm:hidden">New campaign</span>
        </Link>
      </div>
    </header>
  );
}
