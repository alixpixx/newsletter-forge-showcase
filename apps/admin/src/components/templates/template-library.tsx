"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import type { LifecycleKind } from "@nf/render/lifecycle-checks";
import { Btn } from "@/components/ui";
import { TemplateTable, type TemplateListRow } from "@/components/templates/template-table";
import {
  FILTRE_VIDE,
  compteur,
  filtrerModeles,
  lireFiltre,
  messageAucun,
  urlFiltre,
  type FiltreModeles,
} from "@/components/templates/template-filter";
import { cn } from "@/lib/utils";

/*
 * La liste des modèles avec sa recherche et son filtre par catégorie (Chloé, 26/09/2026).
 *
 * ⛔ L'ÉTAT VIT DANS L'URL (`?q=&type=`) SANS ALLER-RETOUR SERVEUR. La page est `force-dynamic` :
 * un `router.replace` relirait la base à chaque lettre. On écrit donc l'adresse avec
 * `history.replaceState`, que Next intègre à son routeur depuis la 14.1 — le lien se partage, un
 * rechargement retrouve le filtre, et le retour arrière depuis le builder aussi : l'état initial est
 * lu dans `useSearchParams()` (l'adresse COURANTE), jamais dans une prop du serveur, qu'un retour
 * arrière resservirait depuis le cache du routeur avec la requête d'origine.
 *
 * ⚠️ L'écriture se fait DANS le geste (frappe, clic), jamais dans un minuteur : un `replaceState`
 * tiré pendant une navigation en cours ferait abandonner celle-ci par le routeur de Next.
 */
export function TemplateLibrary({
  rows,
  lifecycle,
}: {
  rows: TemplateListRow[];
  lifecycle?: Map<string, LifecycleKind[]>;
}) {
  const params = useSearchParams();
  const [filtre, setFiltre] = useState<FiltreModeles>(() => lireFiltre((k) => params?.get(k) ?? null));
  const r = useMemo(() => filtrerModeles(rows, filtre), [rows, filtre]);

  function poser(suivant: FiltreModeles) {
    setFiltre(suivant);
    const { pathname, search } = window.location;
    const url = urlFiltre(pathname, search, suivant);
    if (url === pathname + search) return; // un espace final ne réécrit pas l'adresse
    try {
      window.history.replaceState(null, "", url);
    } catch {
      /* Safari lève au-delà de 100 écritures en 30 s. Le filtre affiché reste juste ; seule
         l'adresse retarde, et la frappe suivante la rattrape. */
    }
  }

  const libelle = compteur(r);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Search templates by name or slug</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={filtre.recherche}
            onChange={(e) => poser({ ...filtre, recherche: e.target.value })}
            placeholder="Search templates"
            maxLength={200}
            className="h-[34px] w-[240px] rounded-[9px] border border-border bg-card pl-8 pr-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          />
        </label>
        <div role="group" aria-label="Filter by category" className="flex flex-wrap items-center gap-1.5">
          <Pastille actif={filtre.type === ""} n={r.nRecherche} onClick={() => poser({ ...filtre, type: "" })}>
            All
          </Pastille>
          {r.categories.map((c) => (
            <Pastille
              key={c.categorie}
              actif={filtre.type === c.categorie}
              n={c.n}
              // Re-cliquer la pastille active la relâche : c'est le geste qu'on tente d'abord.
              onClick={() => poser({ ...filtre, type: filtre.type === c.categorie ? "" : c.categorie })}
            >
              {c.label}
            </Pastille>
          ))}
        </div>
        <span aria-live="polite" className="ml-auto text-[12px] tabular-nums text-muted-foreground">
          {libelle}
        </span>
      </div>

      {r.visibles.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2.5 rounded-[14px] border border-dashed border-border bg-accent/30 px-6 py-10 text-center">
          <div className="text-[13.5px] font-semibold">{messageAucun(filtre)}</div>
          <Btn type="button" onClick={() => poser(FILTRE_VIDE)}>
            Clear filters
          </Btn>
        </div>
      ) : (
        <TemplateTable rows={r.visibles} lifecycle={lifecycle} />
      )}
    </>
  );
}

function Pastille({
  actif,
  n,
  onClick,
  children,
}: {
  actif: boolean;
  n: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={actif}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
        actif
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-card text-foreground/75 hover:bg-accent",
        !actif && n === 0 && "opacity-50",
      )}
    >
      {children}
      <span className="tabular-nums opacity-70">{n}</span>
    </button>
  );
}
