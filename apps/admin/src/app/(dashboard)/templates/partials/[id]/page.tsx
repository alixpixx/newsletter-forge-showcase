import Link from "next/link";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { getBrandPartial } from "@/lib/data/brand-partials";
import { PartialShell } from "@/components/builder/partial-shell";

/**
 * ÉDITER UN EN-TÊTE OU UN PIED DE MARQUE.
 *
 * Segment STATIQUE `partials` sous `/templates` : Next.js le fait passer avant `[id]`, donc cette
 * page ne se dispute pas l'URL avec `/templates/<uuid>` (l'éditeur de modèle).
 *
 * ⛔ TROIS ÉTATS, PAS DEUX. « la base n'a pas répondu » et « ce partial n'existe pas » ne s'écrivent
 * pas pareil : afficher « not found » sur une panne enverrait quelqu'un recréer par-dessus un
 * en-tête qui existe — et le nom serait alors refusé en 409, sans que rien n'explique pourquoi.
 *
 * La marque courante fait le filtre : un id d'une autre marque est indiscernable d'un id inexistant
 * (`getBrandPartial` ne lit jamais sans `assetId`).
 */
export const dynamic = "force-dynamic";

export default async function PartialEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const asset = await getCurrentAsset();
  const db = getDb();

  if (!asset.id || !db) {
    return <Etat titre="Database unavailable">
      The brand could not be resolved, so this library item cannot be opened. Nothing is missing —
      the page simply has nothing to read from.
    </Etat>;
  }

  const lecture = await getBrandPartial(db, id, asset.id);
  if (!lecture.known) {
    return <Etat titre="Could not be read">
      This library item could not be read. This is not the same as it being gone — try again in a
      moment rather than creating a new one over it.
    </Etat>;
  }
  if (!lecture.value) {
    return <Etat titre="Not found">
      No header, footer or block with this address belongs to {asset.name ?? "this brand"}. It may have been
      archived — archived items leave the library; emails that already imported them keep their copy.
    </Etat>;
  }

  return (
    <PartialShell
      partial={{
        id: lecture.value.id,
        slot: lecture.value.slot,
        name: lecture.value.name,
        rows: lecture.value.rows,
        updatedAt: lecture.value.updatedAt,
      }}
      assetSlug={asset.slug}
    />
  );
}

function Etat({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <div className="max-w-xl">
      <Link
        href="/templates?tab=brand"
        className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.9} />
        Back to headers, footers &amp; blocks
      </Link>
      <div className="flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <span className="font-semibold">{titre}</span> — {children}
        </span>
      </div>
    </div>
  );
}
