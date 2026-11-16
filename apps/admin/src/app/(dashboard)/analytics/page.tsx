import Link from "next/link";
import { Eye, EyeOff, Search } from "lucide-react";
import { AnalyticsTabs } from "@/components/analytics/analytics-tabs";
import { CampaignStatsTable } from "@/components/analytics/campaign-stats-table";
import { SendingNow } from "@/components/analytics/sending-now";
import { Card, PageHead, Pill } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { lireEnvoisEnCours, lireStatsCampagnes } from "@/lib/data/campaign-stats";
import {
  PAR_PAGE,
  PERIODES,
  debutPeriode,
  libellePeriode,
  lireMasquees,
  lirePage,
  lirePeriode,
  lireRecherche,
  urlListe,
} from "@/lib/analytics-params";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = { period?: string | string[]; q?: string | string[]; page?: string | string[]; hidden?: string | string[] };

/**
 * Analytics › Campaigns (feature 7, 24/09/2026) — toutes les campagnes de LA marque courante qui ont
 * envoyé, archivées comprises, avec le même tableau dépliable que l'Overview.
 *
 * ⛔ La marque vient de la session (`getCurrentAsset`), jamais de l'URL : `campaign_send_stats` filtre
 * dessus, et c'est tout ce qui sépare une marque d'une autre ici.
 *
 * Les campagnes masquées des analytics (0093) n'y figurent pas, sauf `?hidden=1` (« Show hidden ») :
 * elles reviennent alors avec un badge « Hidden ». Sur une base d'avant 0093, rien n'est masqué.
 *
 * Au-dessus du tableau, « Sending now » (0096) : les envois qui partent EN CE MOMENT, que le tableau
 * ne montre qu'une fois leur dernier mail parti. Indépendant de la période et de la recherche.
 */
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const periode = lirePeriode(sp.period);
  const recherche = lireRecherche(sp.q);
  const page = lirePage(sp.page);
  const masquees = lireMasquees(sp.hidden);
  const asset = await getCurrentAsset();
  const db = getDb();
  const [lu, enCours] = await Promise.all([
    lireStatsCampagnes(db, asset.id, {
      since: debutPeriode(periode, new Date()),
      search: recherche,
      limit: PAR_PAGE,
      offset: (page - 1) * PAR_PAGE,
      includeHidden: masquees,
    }),
    lireEnvoisEnCours(db, asset.id),
  ]);
  const pages = lu.known ? Math.max(1, Math.ceil(lu.total / PAR_PAGE)) : 1;

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Analytics"
        desc="Campaigns of this brand that sent, with their sent, bounce, spam, open and click figures. Open rate and CTR count only recipients who allow tracking; anything not measured shows “—”, never 0%."
      >
        {asset.id ? <Pill tone="pink" dot>{asset.name}</Pill> : <Pill tone="amber" dot>No brand selected</Pill>}
      </PageHead>

      <AnalyticsTabs active="campaigns" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <nav aria-label="Period" className="inline-flex rounded-[9px] border border-border bg-card p-0.5">
          {PERIODES.map((p) => (
            <Link
              key={p}
              href={urlListe({ periode: p, recherche, page: 1, masquees })}
              aria-current={p === periode ? "page" : undefined}
              className={cn(
                "rounded-[7px] px-2.5 py-1.5 text-[12.5px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                p === periode ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {libellePeriode(p)}
            </Link>
          ))}
        </nav>
        {/* Un formulaire GET : la recherche vit dans l'URL, se partage et survit au rechargement. */}
        <form action="/analytics" method="get" className="flex items-center gap-2">
          {periode !== "90" && <input type="hidden" name="period" value={periode} />}
          {masquees && <input type="hidden" name="hidden" value="1" />}
          <label className="relative">
            <span className="sr-only">Search campaigns by name</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              name="q"
              defaultValue={recherche}
              placeholder="Search campaigns"
              maxLength={200}
              className="h-[34px] w-[240px] rounded-[9px] border border-border bg-card pl-8 pr-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            />
          </label>
        </form>
        {/* Bascule par lien : garde période et recherche, repart en page 1 (le total change). */}
        <Link
          href={urlListe({ periode, recherche, page: 1, masquees: !masquees })}
          aria-pressed={masquees}
          title={
            masquees
              ? "Hidden campaigns are listed, with a Hidden badge. Click to leave them out again."
              : "Campaigns hidden from analytics are left out of this list. Click to list them too."
          }
          className={cn(
            "inline-flex h-[34px] items-center gap-2 rounded-[9px] border px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
            masquees
              ? "border-foreground bg-foreground text-background"
              : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {masquees ? <Eye className="h-3.5 w-3.5" aria-hidden="true" /> : <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />}
          {masquees ? "Showing hidden" : "Show hidden"}
        </Link>
      </div>

      <SendingNow lu={enCours} />

      <Card>
        {!lu.known ? (
          <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            Campaign statistics could not be read: {lu.reason}.
          </p>
        ) : lu.campaigns.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-muted-foreground">
            {recherche
              ? `No campaign matching “${recherche}” sent in this period.`
              : `No campaign of ${asset.name} sent in this period (${libellePeriode(periode).toLowerCase()}).`}
            {!masquees && " Campaigns hidden from analytics are not listed — use Show hidden to see them."}
          </p>
        ) : (
          <>
            <CampaignStatsTable campaigns={lu.campaigns} maxEditions={10} />
            <div className="mt-3 flex items-center justify-between text-[12.5px] text-muted-foreground">
              <span className="tabular-nums">
                {lu.total.toLocaleString("en-US")} campaign{lu.total === 1 ? "" : "s"} · page {page} of {pages}
              </span>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link href={urlListe({ periode, recherche, page: page - 1, masquees })} className="font-medium text-foreground hover:underline">
                    ← Previous
                  </Link>
                )}
                {page < pages && (
                  <Link href={urlListe({ periode, recherche, page: page + 1, masquees })} className="font-medium text-foreground hover:underline">
                    Next →
                  </Link>
                )}
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
