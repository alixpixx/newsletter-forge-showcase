import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHead, Card, CardHead } from "@/components/ui";
import { WpSources, type EditionView, type WpSourceView } from "@/components/settings/wp-sources";
import { getCurrentAsset } from "@/lib/asset-context";
import { listEditions, listWpSources } from "@/lib/data/wp-sources";
import { authEnvVarFor, hasAuthSecret } from "@nf/wp/client";

// L'écran porte l'état de sondes qui vieillissent : le prérendre afficherait un « Connected » figé.
export const dynamic = "force-dynamic";

/**
 * Réglages › WordPress — les sources d'articles de la marque courante.
 *
 * Cette page remplace la ligne statique « WordPress (read-only) · Not configured » des réglages :
 * elle mesure au lieu de déclarer. C'est le préalable du bloc de contenu demandé par la collègue
 * d'Alix (« la partie content doit être une preview de nos articles WP ») : sans source sondée, le
 * sélecteur d'articles n'aurait rien à proposer et l'échec se découvrirait dans le builder.
 */
export default async function WordPressSettingsPage() {
  const asset = await getCurrentAsset();
  const [{ rows: sources, error: readError }, editions] = await Promise.all([
    listWpSources(asset.id ?? null),
    listEditions(asset.id ?? null),
  ]);

  // `hasSecret` ne peut se calculer que côté serveur (process.env). On envoie le booléen, jamais
  // la valeur — le mot de passe applicatif ne doit pas exister dans le HTML rendu.
  const view: WpSourceView[] = sources.map((s) => ({
    id: s.id,
    editionId: s.editionId,
    label: s.label,
    restRoot: s.restRoot,
    // Le chemin de lecture réel : sans lui l'écran afficherait « REST API » sur une source RSS.
    kind: s.kind,
    status: s.status,
    statusDetail: s.statusDetail,
    lastProbedAt: s.lastProbedAt,
    authKind: s.authKind,
    authUser: s.authUser,
    capabilities: s.capabilities,
    editionLabel: s.editionLabel ?? null,
    secretVarName: authEnvVarFor(s.restRoot),
    hasSecret: hasAuthSecret(s.restRoot),
  }));

  const editionView: EditionView[] = editions.map((e) => ({ id: e.id, label: e.label }));

  return (
    <div className="animate-fade-up">
      <PageHead
        title="WordPress sources"
        desc={`Where ${asset.name} pulls its articles from. One source per site section — a language section is its own source.`}
      >
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] font-medium hover:bg-muted"
        >
          <ArrowLeft className="h-[14px] w-[14px]" /> Settings
        </Link>
      </PageHead>

      <Card>
        <CardHead
          title="Sources"
          sub="A source is only 'Connected' once it has answered a probe — declaring is not verifying."
        />
        <div className="px-4 pb-4">
          <WpSources initial={view} editions={editionView} readError={readError} />
        </div>
      </Card>

      <p className="mt-4 max-w-[80ch] text-[11.5px] leading-relaxed text-muted-foreground">
        Application passwords are read from Vercel environment variables named after the host — the
        database never stores a secret. Sites that block their REST API stay in <em>Failing</em> until
        that variable is set.
      </p>
    </div>
  );
}
