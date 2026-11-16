"use client";

/**
 * Menu d'insertion des merge tags.
 *
 * Le registre vient de `MERGE_VARS` (@nf/render/hydrate) — JAMAIS d'une liste recopiée : un token
 * hors registre est SILENCIEUSEMENT retiré à l'hydratation, donc taper `{{prenom}}` à la main
 * produirait un blanc chez l'abonné sans le moindre message d'erreur. D'où ce menu fermé.
 *
 * On n'expose pas :
 *  - les `flag` (is_premium…) : ils servent aux conditions `<!--nf:if-->`, jamais à l'impression ;
 *  - les `legal_footer_*` : injectés par le worker via le bloc footer verrouillé.
 */
import { useEffect, useRef, useState } from "react";
import { Braces, ChevronDown } from "lucide-react";
import { MERGE_VARS } from "@nf/render/schema";
import { cn } from "@/lib/utils";

interface TagEntry {
  name: string;
  label: string;
  kind: string;
}

const ENTRIES: TagEntry[] = Object.entries(MERGE_VARS as Record<string, { kind: string; label: string }>)
  .filter(([name, spec]) => spec.kind !== "flag" && spec.kind !== "raw" && !name.startsWith("legal_footer"))
  .map(([name, spec]) => ({ name, label: spec.label, kind: spec.kind }));

export function MergeTagMenu({
  onInsert,
  disabled = false,
  hint,
}: {
  /** Reçoit le token complet, ex. `{{first_name}}`. */
  onInsert: (token: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Fermeture au clic extérieur + Échap (le menu n'est pas une modale : il ne piège pas le focus).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={disabled ? (hint ?? "Focus a text field first") : "Insert a merge tag"}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1 rounded-[7px] border border-border px-1.5 py-[3px] text-[10.5px] font-semibold transition-colors",
          disabled ? "cursor-not-allowed opacity-40" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Braces className="h-3 w-3" strokeWidth={2.2} />
        Merge tag
        <ChevronDown className="h-3 w-3" strokeWidth={2.2} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 max-h-[280px] w-[230px] overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-[0_10px_36px_rgba(20,20,30,0.16)]"
        >
          {ENTRIES.map((entry) => (
            <button
              key={entry.name}
              type="button"
              role="menuitem"
              onClick={() => {
                onInsert(`{{${entry.name}}}`);
                setOpen(false);
              }}
              className="flex w-full flex-col items-start gap-0.5 rounded-[7px] px-2 py-1.5 text-left hover:bg-accent"
            >
              <span className="text-[12px] font-medium">{entry.label}</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">{`{{${entry.name}}}`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
