"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { setAsset } from "@/app/actions/asset";
// Import de TYPE uniquement : `asset-context` est serveur (next/headers), il ne doit jamais
// se retrouver dans le bundle client. `import type` est effacé à la compilation.
import type { AssetOption, CurrentAsset } from "@/lib/asset-context";
import { cn } from "@/lib/utils";

/**
 * Sélecteur de marque — remplace le bouton mort qui affichait « Quartz Tips / SD /
 * Brazil · PT-BR · LGPD » en dur. Tout est dérivé de la marque courante, et le clic
 * appelle réellement la server action `setAsset` (cookie + revalidate du layout).
 */

/** Initiales dérivées du nom : « Atlas Review » → TP, « Quartz Tips » → SU. */
export function assetInitials(name: string): string {
  const words = name.trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

/** Sous-titre : marché + langue principale, jamais de régime inventé. */
function assetSubtitle(market: string | null, language?: string): string {
  const parts = [market, language].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(" · ") : "No market set";
}

export function AssetSwitcher({
  current,
  options,
  className,
}: {
  current: CurrentAsset;
  options: AssetOption[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  // La marque courante est toujours listable, même si la requête d'options a échoué.
  const items: AssetOption[] =
    options.length > 0
      ? options
      : [{ id: current.id, slug: current.slug, name: current.name, market: current.market }];
  const foundIndex = items.findIndex((o) => o.slug === current.slug);
  const currentIndex = foundIndex >= 0 ? foundIndex : 0;

  // Clic extérieur + Échap
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // À l'ouverture, le focus part sur la marque cochée (navigation clavier au fléché).
  useEffect(() => {
    if (open) itemsRef.current[currentIndex]?.focus();
  }, [open, currentIndex]);

  function focusAt(index: number) {
    itemsRef.current[index]?.focus();
  }

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const last = items.length - 1;
    const cur = itemsRef.current.findIndex((el) => el !== null && el === document.activeElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusAt(cur < last ? cur + 1 : 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(cur > 0 ? cur - 1 : last);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(last);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  function select(slug: string) {
    setOpen(false);
    triggerRef.current?.focus();
    if (slug === current.slug) return;
    // useTransition : le déclencheur reste visible en « chargement » le temps du revalidate.
    startTransition(async () => {
      await setAsset(slug);
    });
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Current brand: ${current.name}. Switch brand`}
        disabled={pending}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-[9px] border border-border px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
          pending && "cursor-wait opacity-60",
        )}
      >
        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-[#ff5fa2] to-[#ff368d] text-[10px] font-bold text-white">
          {assetInitials(current.name)}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[12.5px] font-semibold">{current.name}</span>
          <span className="block truncate text-[10.5px] text-muted-foreground">
            {assetSubtitle(current.market, current.languages[0])}
          </span>
        </span>
        {pending ? (
          <Loader2 className="h-[15px] w-[15px] shrink-0 animate-spin text-brand" aria-hidden="true" />
        ) : (
          <ChevronsUpDown className="h-[15px] w-[15px] shrink-0 text-muted-foreground/60" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Brands"
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 right-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
        >
          <div className="max-h-[300px] overflow-y-auto py-1">
            {items.map((o, i) => {
              const selected = o.slug === current.slug;
              return (
                <button
                  key={o.slug}
                  ref={(el) => {
                    itemsRef.current[i] = el;
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => select(o.slug)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors focus-visible:outline-none",
                    selected ? "bg-accent" : "hover:bg-accent focus:bg-accent",
                  )}
                >
                  <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-[#ff5fa2] to-[#ff368d] text-[10px] font-bold text-white">
                    {assetInitials(o.name)}
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[12.5px] font-semibold">{o.name}</span>
                    <span className="block truncate text-[10.5px] text-muted-foreground">
                      {assetSubtitle(o.market)}
                    </span>
                  </span>
                  {selected && <Check className="h-[15px] w-[15px] shrink-0 text-brand" aria-hidden="true" />}
                </button>
              );
            })}
          </div>

          {/* Mode dégradé : la base n'a pas répondu, on le DIT au lieu de faire semblant. */}
          {!current.fromDb && (
            <div className="border-t border-border bg-accent/50 px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
              Offline list — brands read from local config, database unreachable.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
