"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Th, Td } from "@/components/ui";
import { jour, nombre, nomEnvoi, pct, raisonNonMesure, taux, type EnvoiStats } from "@/lib/campaign-stats";
import { cn } from "@/lib/utils";

type Cle = "date" | "sent" | "delivered" | "bounced" | "complained" | "opened" | "openRate" | "clicked" | "ctr";

const COLONNES: { cle: Cle; titre: string }[] = [
  { cle: "sent", titre: "Sent" },
  { cle: "delivered", titre: "Delivered" },
  { cle: "bounced", titre: "Bounce" },
  { cle: "complained", titre: "Spam" },
  { cle: "opened", titre: "Open" },
  { cle: "openRate", titre: "Open rate" },
  { cle: "clicked", titre: "Click" },
  { cle: "ctr", titre: "CTR" },
];

/** La valeur de tri. ⛔ Ce qui n'est pas mesuré vaut `null` et se range TOUJOURS en dernier, jamais comme un 0. */
function valeur(e: EnvoiStats, cle: Cle): number | null {
  const mesure = raisonNonMesure(e) === null;
  switch (cle) {
    case "date":
      return Date.parse(e.sentAt ?? "") || null;
    case "openRate":
      return taux(e).openRate;
    case "ctr":
      return taux(e).ctr;
    case "opened":
      return mesure ? e.opened : null;
    case "clicked":
      return mesure ? e.clicked : null;
    default:
      return e[cle];
  }
}

/** Les envois d'une campagne, triables par colonne (le plus récent en haut par défaut). */
export function EditionsTable({ editions }: { editions: EnvoiStats[] }) {
  const [tri, setTri] = useState<{ cle: Cle; desc: boolean }>({ cle: "date", desc: true });
  const lignes = [...editions].sort((a, b) => {
    const va = valeur(a, tri.cle);
    const vb = valeur(b, tri.cle);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return tri.desc ? vb - va : va - vb;
  });
  const trier = (cle: Cle) => setTri((t) => ({ cle, desc: t.cle === cle ? !t.desc : true }));

  // Une fonction de rendu, pas un composant déclaré dans le rendu (qui serait remonté à chaque tri).
  const enTete = (cle: Cle, titre: string, droite = true) => (
    <Th key={cle} className={cn(droite && "text-right")}>
      <button
        type="button"
        onClick={() => trier(cle)}
        aria-label={`Sort by ${titre}`}
        className="inline-flex items-center gap-1 uppercase hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        {titre}
        {tri.cle === cle && (tri.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </Th>
  );

  return (
    <div className="-mx-[18px] overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse text-[13px]">
        <thead>
          <tr>
            <Th>Edition</Th>
            {enTete("date", "Date", false)}
            {COLONNES.map((c) => enTete(c.cle, c.titre))}
          </tr>
        </thead>
        <tbody>
          {lignes.map((e) => {
            const raison = raisonNonMesure(e);
            const t = taux(e);
            const nonMesure = (
              <span title={raison ?? undefined} className="cursor-help text-muted-foreground/60">
                —
              </span>
            );
            return (
              <tr key={e.occurrenceId ?? "unique"} className="hover:bg-accent/40">
                <Td className="font-medium">{nomEnvoi(e)}</Td>
                <Td className="whitespace-nowrap text-muted-foreground">{jour(e.sentAt)}</Td>
                <Td className="text-right tabular-nums">{nombre(e.sent)}</Td>
                <Td className="text-right tabular-nums">{nombre(e.delivered)}</Td>
                <Td className="text-right tabular-nums">{nombre(e.bounced)}</Td>
                <Td className="text-right tabular-nums">{nombre(e.complained)}</Td>
                <Td className="text-right tabular-nums">{raison ? nonMesure : nombre(e.opened)}</Td>
                <Td className="text-right tabular-nums">{t.openRate === null ? nonMesure : pct(t.openRate)}</Td>
                <Td className="text-right tabular-nums">{raison ? nonMesure : nombre(e.clicked)}</Td>
                <Td className="text-right tabular-nums">{t.ctr === null ? nonMesure : pct(t.ctr)}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
