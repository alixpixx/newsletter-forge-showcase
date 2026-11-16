import { getCurrentAsset } from "@/lib/asset-context";
import { AiGenerator, type BrandContext } from "@/components/ai/generator";

/*
 * GÉNÉRATION IA — /builder/new
 *
 * La page est un simple hôte serveur : elle résout la MARQUE courante (langue, marché, nom) et la
 * passe au générateur. Le contexte de marque ne vient jamais du prompt utilisateur — la langue et le
 * pied de page légal en dépendent, et c'est précisément ce qui doit rester non négociable.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Generate with AI" };

export default async function AiGeneratorPage() {
  const asset = await getCurrentAsset();

  const brand: BrandContext = {
    slug: asset.slug,
    name: asset.name,
    market: asset.market ?? null,
    languages: asset.languages,
    fromDb: asset.fromDb,
    ready: Boolean(asset.id),
  };

  return <AiGenerator brand={brand} />;
}
