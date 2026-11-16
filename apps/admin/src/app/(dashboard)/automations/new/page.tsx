import { PageHead, Pill } from "@/components/ui";
import { AutomationForm } from "@/components/automations/automation-form";
import { defaultsFor } from "@/components/automations/form-values";
import { BackLink, Bandeau } from "@/components/automations/views";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { declencheurInitial } from "@/lib/automations";
import {
  automationsInstalled,
  brandTimezone,
  listFilterOptions,
  listStepTemplates,
  listTimezonesInUse,
} from "@/lib/data/automations";

export const dynamic = "force-dynamic";

/**
 * Nouvelle automation sur mesure (plan, étape 10). Elle naît `draft` : l'enregistrer ne fait RIEN
 * tourner. ⛔ Pas de formulaire si la table n'existe pas (0082 non appliquée) : on ne propose pas un
 * geste dont on sait qu'il échouera.
 */
export default async function NewAutomationPage({
  searchParams,
}: {
  searchParams: Promise<{ trigger?: string | string[] }>;
}) {
  const asset = await getCurrentAsset();
  const db = getDb();
  if (!db || !asset.id) {
    return (
      <Cadre>
        <Bandeau tone="amber">Database unavailable: nothing can be created right now.</Bandeau>
      </Cadre>
    );
  }
  const installee = await automationsInstalled(db, asset.id);
  if (installee.state !== "ok") {
    return (
      <Cadre>
        {installee.state === "not-installed" ? (
          <Bandeau tone="grey">
            Custom automations are not installed on this database yet (migration 0082): nothing can be created.
          </Bandeau>
        ) : (
          <Bandeau tone="red">Custom automations could not be read: {installee.message}</Bandeau>
        )}
      </Cadre>
    );
  }

  const [modeles, filtres, fuseau, fuseaux] = await Promise.all([
    listStepTemplates(asset.id),
    listFilterOptions(asset.id),
    brandTimezone(asset.id),
    listTimezonesInUse(),
  ]);
  // « Set up » d'une ligne de la carte System arrive avec `?trigger=` : le formulaire s'ouvre sur lui.
  const premier = declencheurInitial((await searchParams).trigger);

  return (
    <Cadre brand={asset.name}>
      <AutomationForm
        mode="create"
        assetId={asset.id}
        initial={defaultsFor(premier, { name: "", timezone: fuseau ?? "UTC" })}
        options={{
          templates: modeles.value,
          templatesKnown: modeles.known,
          optins: filtres.optins,
          interests: filtres.interests,
          labels: filtres.labels,
          filtersKnown: filtres.known,
          languages: asset.languages,
          timezones: fuseaux,
        }}
      />
    </Cadre>
  );
}

function Cadre({ brand, children }: { brand?: string; children: React.ReactNode }) {
  return (
    <div className="animate-fade-up">
      <BackLink />
      <div className="mt-2">
        <PageHead title="New automation" desc="Pick a trigger from the catalogue, then its steps. It is saved as a draft.">
          {brand && (
            <Pill tone="pink" dot>
              {brand}
            </Pill>
          )}
        </PageHead>
      </div>
      {children}
    </div>
  );
}
