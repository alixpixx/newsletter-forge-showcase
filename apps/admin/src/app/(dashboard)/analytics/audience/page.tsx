import { AnalyticsPeriods, AnalyticsTabs } from "@/components/analytics/analytics-tabs";
import { AudienceHeatmap } from "@/components/analytics/audience-heatmap";
import { AudienceLevels, AudienceSources } from "@/components/analytics/audience-sources";
import { AudienceWeekly } from "@/components/analytics/audience-weekly";
import { Card, CardHead, PageHead, Pill } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { lireAudienceDeMarque } from "@/lib/data/engagement";
import { lirePeriode } from "@/lib/analytics-params";
import { bornesSemaines, debutAudience } from "@/lib/audience-view";

export const dynamic = "force-dynamic";

type Params = { period?: string | string[] };

/**
 * Analytics › Audience (0094, demande d'Alix du 07/10/2026) : niveaux d'engagement, meilleurs moments
 * d'envoi, sources, semaine par semaine — pour LA marque courante.
 *
 * ⛔ La marque vient de la session (`getCurrentAsset`), jamais de l'URL. ⛔ « All time » passe une date
 * lointaine (`debutAudience`) : un début NUL vaut « 26 semaines » côté SQL. ⛔ Une lecture ratée
 * s'affiche avec sa raison, jamais comme des tableaux vides.
 */
export default async function AudienceAnalyticsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const periode = lirePeriode(sp.period);
  const asset = await getCurrentAsset();
  const maintenant = new Date();
  const lu = await lireAudienceDeMarque(getDb(), asset.id, debutAudience(periode, maintenant));

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Analytics"
        desc="Who your subscribers are and when they read: engagement levels, the best moments to send, where subscribers come from, and week-by-week growth. Opens and clicks are only recorded for recipients who allow tracking."
      >
        {asset.id ? <Pill tone="pink" dot>{asset.name}</Pill> : <Pill tone="amber" dot>No brand selected</Pill>}
      </PageHead>

      <AnalyticsTabs active="audience" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <AnalyticsPeriods path="/analytics/audience" periode={periode} />
        <span className="text-[12px] text-muted-foreground">Applies to the best moments and to week by week.</span>
      </div>

      {!lu.known ? (
        <Card>
          <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            Audience analytics could not be read: {lu.reason}.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHead
              title="Engagement levels"
              sub="Active subscribers right now, whatever the period. A level follows the last reaction (open, click or reply) — or the last delivery for someone who never reacted."
            />
            <AudienceLevels levels={lu.value.levels} />
          </Card>

          <Card>
            <CardHead title="Best moments to send" sub="When your emails get opened and clicked, by day of week and hour" />
            <AudienceHeatmap cases={lu.value.heatmap} timezone={lu.value.timezone} />
          </Card>

          <Card>
            <CardHead
              title="Sources"
              sub="All subscribers by recorded source, whatever the period. Engaged = active subscribers who have opened or clicked at least once. “Content upgrade” also collects any unrecognised source value, so it is not always the real origin."
            />
            <AudienceSources sources={lu.value.sources} />
          </Card>

          <Card>
            <CardHead title="Week by week" sub="What happened each week of the period" />
            <AudienceWeekly
              weekly={lu.value.weekly}
              bornes={bornesSemaines(lu.value.since, periode, maintenant, lu.value.timezone)}
              timezone={lu.value.timezone}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
