import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Card, CardHead, PageHead } from "@/components/ui";
import { BrandSettingsForm } from "@/components/settings/brand-settings-form";
import { lireReglagesMarque } from "@/lib/data/brand-settings";
import { getDb } from "@/lib/supabase";

// Les réglages se relisent à chaque requête : un nom renommé doit s'afficher aussitôt.
export const dynamic = "force-dynamic";

/**
 * Réglages › Marque — nom, suivi des ouvertures/clics (0092 ; grisé tant qu'elle n'est pas appliquée, voir
 * `lireReglagesMarque`), et pour chaque édition : langue, marché, régime légal, expéditeur.
 *
 * ⛔ RÉSERVÉE AU SUPER_ADMIN, DEUX FOIS. Le proxy réserve `/settings` (et ses sous-chemins) ; la route
 * d'écriture `PATCH /api/brands/[id]` refuse d'elle-même un autre rôle. La page seule ne garderait rien :
 * un appel direct à l'API contournerait l'écran.
 *
 * C'est aussi la cible du lien « Brand settings » que le panneau de thème du builder peut poser :
 * `/settings/brands/<slug de la marque>`.
 */
export default async function BrandSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();
  const lu = db ? await lireReglagesMarque(db, slug) : { known: false, value: null };
  if (lu.known && !lu.value) notFound();

  return (
    <div className="animate-fade-up">
      <PageHead
        title={lu.value ? lu.value.name : "Brand settings"}
        desc="What every subscriber of this brand sees in the From line, in which language, under which legal regime — and whether their opens and clicks are tracked."
      >
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] font-medium hover:bg-muted"
        >
          <ArrowLeft className="h-[14px] w-[14px]" /> Settings
        </Link>
      </PageHead>

      {!lu.known || !lu.value ? (
        <Card>
          <CardHead
            title="Brand settings could not be read"
            sub="This is not the same as a brand with nothing set — try again in a moment rather than filling it in from scratch."
          />
        </Card>
      ) : (
        <BrandSettingsForm marque={lu.value} />
      )}
    </div>
  );
}
