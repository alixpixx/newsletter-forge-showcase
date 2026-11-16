import { AlertTriangle } from "lucide-react";
import { PageHead, Pill } from "@/components/ui";
import { MediaLibrary } from "@/components/media/library";
import { getCurrentAsset } from "@/lib/asset-context";

// La bibliothèque bouge à chaque téléversement : jamais de page mise en cache.
export const dynamic = "force-dynamic";

/**
 * `/media` — la bibliothèque d'images de la MARQUE COURANTE.
 *
 * La grille est chargée côté client (recherche, filtres et pagination vivent déjà dans
 * `/api/builder/media`) : la rendre côté serveur imposerait de recharger la page à chaque frappe.
 * Le serveur ne fournit donc que le contexte de marque — et l'état dégradé quand la base est
 * injoignable, plutôt qu'une grille vide qui ferait croire à une bibliothèque perdue.
 */
export default async function MediaPage() {
  const asset = await getCurrentAsset();

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Media library"
        desc="Every image available to this brand's emails — uploaded, generated or pulled in by an import. Alt text edited here becomes the default for each new insertion."
      />

      <div className="mb-4 flex items-center gap-2">
        <Pill tone="pink" dot>
          {asset.name}
        </Pill>
        <span className="text-[12px] text-muted-foreground">Images are never shared between brands</span>
      </div>

      {!asset.id && (
        <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Database unavailable — the brand could not be resolved, so no image can be listed or
            uploaded right now.
          </span>
        </div>
      )}

      <MediaLibrary disabled={!asset.id} />
    </div>
  );
}
