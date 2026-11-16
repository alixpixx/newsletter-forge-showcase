import { AnalyticsPeriods, AnalyticsTabs } from "@/components/analytics/analytics-tabs";
import { AutomationResults } from "@/components/analytics/automation-results";
import { Card, PageHead, Pill } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { lireResultatsDesAutomations } from "@/lib/data/engagement";
import { debutPeriode, libellePeriode, lirePeriode } from "@/lib/analytics-params";

export const dynamic = "force-dynamic";

type Params = { period?: string | string[] };

/**
 * Analytics › Automations (0094, demande d'Alix du 07/10/2026) : les résultats de chaque automation
 * de LA marque courante, étape par étape — envois réels, sort dans la file, livraison, ouverture, clic.
 *
 * ⛔ La marque vient de la session (`getCurrentAsset`), jamais de l'URL : `automation_send_stats`
 * filtre dessus. ⛔ Une lecture ratée s'affiche avec sa raison, jamais comme une liste vide.
 */
export default async function AutomationAnalyticsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const periode = lirePeriode(sp.period);
  const asset = await getCurrentAsset();
  const lu = await lireResultatsDesAutomations(getDb(), asset.id, { since: debutPeriode(periode, new Date()) });

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Analytics"
        desc="Results of this brand's automations, step by step: real sends, delivery, opens and clicks. Simulated sends are shown apart — simulation mode sends nothing. Anything not measured shows “—”, never 0%."
      >
        {asset.id ? <Pill tone="pink" dot>{asset.name}</Pill> : <Pill tone="amber" dot>No brand selected</Pill>}
      </PageHead>

      <AnalyticsTabs active="automations" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <AnalyticsPeriods path="/analytics/automations" periode={periode} />
        <span className="text-[12px] text-muted-foreground">Counts the sends created in the period.</span>
      </div>

      {!lu.known ? (
        <Card>
          <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            Automation results could not be read: {lu.reason}.
          </p>
        </Card>
      ) : lu.value.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-[13px] text-muted-foreground">
            No automation of {asset.name} to show ({libellePeriode(periode).toLowerCase()}). A draft appears here once
            it has sent, for real or in simulation.
          </p>
        </Card>
      ) : (
        <AutomationResults automations={lu.value} />
      )}
    </div>
  );
}
