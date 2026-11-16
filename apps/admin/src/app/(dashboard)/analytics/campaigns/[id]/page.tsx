import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { EditionsChart } from "@/components/analytics/editions-chart";
import { EditionsTable } from "@/components/analytics/editions-table";
import { EngagementSections } from "@/components/analytics/engagement-sections";
import { VisibilityButton } from "@/components/analytics/visibility-button";
import { Card, CardHead, PageHead, Pill } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { getCampaign } from "@/lib/data/campaigns";
import { lireStatsCampagnes } from "@/lib/data/campaign-stats";
import { lireEngagementDeCampagne } from "@/lib/data/engagement";
import { cumuler, nombre, nomEnvoi, noteExclues, pct, raisonNonMesure, taux } from "@/lib/campaign-stats";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const BOUTON =
  "inline-flex items-center gap-2 rounded-[9px] border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

/**
 * Analytics d'UNE campagne (feature 7) : 6 tuiles, une barre par envoi, le tableau des envois, l'export
 * — puis l'ENGAGEMENT (0094) : ouvertures et clics, liens, délai jusqu'à la 1re action, appareils,
 * clients, systèmes, pays, villes ; toutes éditions, ou une seule (`?edition=<occurrenceId>`).
 *
 * ⛔ Une campagne d'une autre marque est INDISCERNABLE d'une campagne absente (404), comme sur
 * `/campaigns/[id]` : `getCampaign` filtre sur la marque de la session, et la fonction SQL aussi.
 * ⛔ `?edition` n'est retenu que s'il désigne une édition DE CETTE campagne (lue ci-dessous) ; sinon il
 * est ignoré — jamais transmis tel quel à la fonction SQL.
 * La bascule « Hide from analytics » (0093) ne change rien ici : la fiche reste servie, avec un badge.
 */
export default async function CampaignAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edition?: string | string[] }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const asset = await getCurrentAsset();
  const db = getDb();
  if (!db || !asset.id) {
    return (
      <Cadre titre="Campaign analytics">
        <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          Database unavailable: this campaign could not be read.
        </p>
      </Cadre>
    );
  }
  const campagne = await getCampaign(id, asset.id);
  if (!campagne) notFound();
  const lu = await lireStatsCampagnes(db, asset.id, { campaignId: id, limit: 1 });

  if (!lu.known) {
    return (
      <Cadre titre={campagne.name} id={id}>
        <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          Campaign statistics could not be read: {lu.reason}.
        </p>
      </Cadre>
    );
  }
  const stats = lu.campaigns[0];
  if (!stats || stats.editions.length === 0) {
    return (
      <Cadre titre={campagne.name} id={id}>
        <Card>
          <p className="py-8 text-center text-[13px] text-muted-foreground">
            This campaign has not sent yet. Its figures appear here after its first send.
          </p>
        </Card>
      </Cadre>
    );
  }

  // L'édition demandée, si (et seulement si) c'en est une de cette campagne.
  const demandee = Array.isArray(sp.edition) ? sp.edition[0] : sp.edition;
  const edition = stats.recurring
    ? (stats.editions.find((e) => e.occurrenceId !== null && e.occurrenceId === demandee) ?? null)
    : null;
  const engagement = await lireEngagementDeCampagne(db, asset.id, id, edition?.occurrenceId ?? null);
  const selection = edition ? nomEnvoi(edition) : stats.recurring ? "All editions" : "Single send";
  const exportEngagement = `/api/analytics/campaigns/${id}/export?part=engagement${
    edition?.occurrenceId ? `&edition=${encodeURIComponent(edition.occurrenceId)}` : ""
  }`;
  const lienEdition = (occ: string | null) =>
    `/analytics/campaigns/${id}${occ ? `?edition=${encodeURIComponent(occ)}` : ""}#engagement`;
  const choixEditions: { occ: string | null; label: string }[] = [
    { occ: null, label: "All editions" },
    ...stats.editions.flatMap((e) => (e.occurrenceId ? [{ occ: e.occurrenceId, label: nomEnvoi(e) }] : [])),
  ];

  const total = cumuler(stats.editions);
  const t = taux(total);
  const raison = raisonNonMesure(total);
  const note = noteExclues(total);
  const tuiles = [
    { label: "Sent", value: nombre(total.sent), hint: "Accepted by the mail provider" },
    { label: "Delivery rate", value: pct(t.deliveryRate), hint: `${nombre(total.delivered)} delivered` },
    { label: "Bounce rate", value: pct(t.bounceRate), hint: `${nombre(total.bounced)} permanent bounces` },
    { label: "Spam rate", value: pct(t.spamRate), hint: `${nombre(total.complained)} complaints` },
    { label: "Open rate", value: t.openRate === null ? "Not measured" : pct(t.openRate), hint: raison ?? `${nombre(total.opened)} unique opens of ${nombre(total.tracked)} tracked` },
    { label: "CTR", value: t.ctr === null ? "Not measured" : pct(t.ctr), hint: raison ?? `${nombre(total.clicked)} unique clickers of ${nombre(total.tracked)} tracked` },
  ];

  return (
    <Cadre
      titre={stats.name || campagne.name}
      id={id}
      sous={stats.recurring ? `Recurring · ${stats.editions.length} edition${stats.editions.length === 1 ? "" : "s"}` : "One-shot"}
      archivee={stats.archived}
      masquee={stats.hidden}
      marque={asset.name}
      actions={<VisibilityButton campaignId={id} hidden={stats.hidden} />}
    >
      {stats.hidden && (
        <p className="mb-4 rounded-[10px] border border-border bg-accent/40 px-4 py-3 text-[13px] text-muted-foreground">
          Hidden from analytics: this campaign is left out of the Analytics list unless Show hidden is on. Nothing else
          changes — its figures below and its exports are complete.
        </p>
      )}
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {tuiles.map((k) => (
          <div key={k.label} className="rounded-[14px] border border-border bg-card p-[15px]">
            <div className="text-[12px] font-medium text-muted-foreground">{k.label}</div>
            <div className={k.value === "Not measured" ? "mt-2 text-[15px] font-semibold text-muted-foreground" : "mt-1.5 text-[24px] font-bold leading-none tracking-tight tabular-nums"}>
              {k.value}
            </div>
            <div className="mt-2 text-[11.5px] leading-snug text-muted-foreground">{k.hint}</div>
          </div>
        ))}
      </div>
      {note && <p className="-mt-1 mb-4 text-[12px] text-muted-foreground">{note}</p>}

      {stats.editions.length > 1 && (
        <Card className="mb-4">
          <CardHead title="Sent per edition" sub="Oldest to newest · violet dots: open rate, where measured" />
          <EditionsChart editions={stats.editions} />
        </Card>
      )}

      <Card>
        <CardHead
          title={stats.recurring ? "Editions" : "Send"}
          sub="Open and click count unique recipients; rates use delivered recipients who allow tracking"
          right={
            <a href={`/api/analytics/campaigns/${id}/export`} className={BOUTON}>
              <Download className="h-[14px] w-[14px]" strokeWidth={2} /> Export CSV
            </a>
          }
        />
        <EditionsTable editions={stats.editions} />
      </Card>

      <section id="engagement" aria-labelledby="engagement-titre" className="mt-8 scroll-mt-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="engagement-titre" className="text-[16px] font-semibold tracking-tight">
              Engagement
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              {selection} · who opened and clicked, which links, how fast, on what and where
            </p>
          </div>
          {/* L'export n'est proposé que si la lecture a réussi : la route rendrait sinon une erreur. */}
          {engagement.known && (
            <a href={exportEngagement} className={BOUTON}>
              <Download className="h-[14px] w-[14px]" strokeWidth={2} /> Export engagement CSV
            </a>
          )}
        </div>

        {stats.recurring && stats.editions.length > 1 && (
          <nav aria-label="Edition" className="mb-4 flex max-h-[92px] flex-wrap gap-1.5 overflow-y-auto">
            {choixEditions.map(({ occ, label }) => {
              const actif = (edition?.occurrenceId ?? null) === occ;
              return (
                <Link
                  key={occ ?? "toutes"}
                  href={lienEdition(occ)}
                  aria-current={actif ? "page" : undefined}
                  className={cn(
                    "rounded-[7px] border px-2.5 py-1 text-[12px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                    actif
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {label}
                </Link>
              );
            })}
          </nav>
        )}

        <EngagementSections lecture={engagement} />
      </section>
    </Cadre>
  );
}

function Cadre({
  titre,
  id,
  sous,
  archivee,
  masquee,
  marque,
  actions,
  children,
}: {
  titre: string;
  id?: string;
  sous?: string;
  archivee?: boolean;
  masquee?: boolean;
  marque?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="animate-fade-up">
      <Link href="/analytics" className="text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        ← Analytics
      </Link>
      <div className="mt-2">
        <PageHead title={titre} desc={sous}>
          {marque && <Pill tone="pink" dot>{marque}</Pill>}
          {archivee && <Pill tone="grey">Archived</Pill>}
          {masquee && <Pill tone="amber">Hidden from analytics</Pill>}
          {actions}
          {id && (
            <Link href={`/campaigns/${id}`} className="text-[12.5px] font-medium text-brand hover:underline">
              Open the campaign →
            </Link>
          )}
        </PageHead>
      </div>
      {children}
    </div>
  );
}
