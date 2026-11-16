import Link from "next/link";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { SegmentBuilder } from "@/components/segments/segment-builder";
import { SavedSegments, type SavedSegment } from "@/components/segments/saved-segments";
import { listSegments } from "@/lib/data/segments";
import { measureSegmentSizes } from "@/lib/data/segment-sizes";
import { getDb } from "@/lib/supabase";
import { summarize } from "@nf/segments/fields";
import { Pill } from "@/components/ui";
import { getActiveTotal } from "@/lib/data/subscribers";
import { getCurrentAsset } from "@/lib/asset-context";

// Le compte de segment interroge la base à chaque requête.
export const dynamic = "force-dynamic";

/**
 * Automations › Targeting — l'écran Segments DÉPLACÉ TEL QUEL depuis `/segments` (Monitoring) le
 * 24/09/2026 : « tout ce qui est custom newsletter targeting sera dans cette nouvelle section »
 * (Alix). Liste, création, édition, membres : mêmes composants, mêmes routes `/api/segments/*`.
 * `/segments` et ses sous-chemins redirigent ici (`proxy.ts`, `lib/adresses-demenagees.ts`).
 */
export default async function TargetingPage() {
  const asset = await getCurrentAsset();
  // Dénominateur du % de segment : DOIT être le total actif de la marque courante,
  // sinon le pourcentage affiché est faux (il l'était : agrégat 9 marques).
  const baseTotal = await getActiveTotal(asset.id);
  const scoped = asset.id !== null;

  const segments = await listSegments(asset.id);
  // La taille ACTUELLE de chaque segment, mesurée à chaque affichage : `cached_count` n'est écrit qu'à
  // l'enregistrement et ne suit pas les inscriptions (voir `segment-sizes.ts`).
  const sizes = await measureSegmentSizes(getDb(), asset.id, segments);
  const saved: SavedSegment[] = segments.map((s) => ({
    id: s.id,
    name: s.name,
    summary: s.rule ? summarize(s.rule) : "no rule",
    cachedCount: s.cachedCount,
    cachedAt: s.cachedAt,
    live: sizes.get(s.id) ?? null,
    usedByAutomation: s.usedByAutomation,
    updatedAt: s.updatedAt,
  }));

  return (
    <div className="animate-fade-up">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight">Targeting</h1>
          <p className="mt-1 max-w-[62ch] text-[13px] text-muted-foreground">
            Segment builder. Target precisely: build a rule set and see how many subscribers it matches.
          </p>
          <div className="mt-2 flex items-center gap-2">
            {scoped ? <Pill tone="pink" dot>{asset.name}</Pill> : <Pill tone="amber" dot>All brands</Pill>}
            <span className="text-[12px] text-muted-foreground">
              {baseTotal === null
                ? "Active subscribers in scope: could not be read right now"
                : `${baseTotal.toLocaleString("en-US")} active subscribers in scope`}
            </span>
          </div>
        </div>
        {/* L'enregistrement vit dans le constructeur, qui détient la règle et le compte : un bouton
            ici devrait dupliquer cet état, et les deux dériveraient. */}
        <div className="flex items-center gap-2.5">
          <Link
            href="/campaigns"
            className="flex items-center gap-2 rounded-[9px] border border-border bg-card px-3.5 py-2 text-[13px] font-medium transition-colors hover:bg-accent"
          >
            Use in campaign <ArrowRight className="h-[15px] w-[15px]" strokeWidth={2} />
          </Link>
        </div>
      </div>

      {/* Numérateur (POST /api/segments/count) et dénominateur (getActiveTotal) sont tous deux
          scopés sur la marque courante : le pourcentage affiché est cohérent. */}
      {!scoped && (
        <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Database unavailable — counts below cover all brands instead of a single one.</span>
        </div>
      )}

      {/* Total illisible ⇒ 0 : `segmentSize` n'affiche alors AUCUN pourcentage (pct null). */}
      <SegmentBuilder baseTotal={baseTotal ?? 0} />

      <SavedSegments segments={saved} />

    </div>
  );
}
