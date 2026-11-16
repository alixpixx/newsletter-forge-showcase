import Link from "next/link";
import { Users, Zap, Moon, UserMinus, Download, CalendarDays, Send } from "lucide-react";
import { GrowthChart } from "@/components/dashboard/growth-chart";
import { CampaignStatsTable } from "@/components/analytics/campaign-stats-table";
import { PageHead, Btn, Pill, Card, CardHead } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";

// Chiffres lus en base à chaque requête.
export const dynamic = "force-dynamic";

import { getDashboardStats } from "@/lib/data/dashboard";
import { lireStatsCampagnes } from "@/lib/data/campaign-stats";

/**
 * Overview — UNE marque : celle du sélecteur du haut (décision d'Alix du 24/09/2026, feature 6).
 * La comparaison entre marques (« By brand », « All brands ») a disparu : on change de marque par le
 * sélecteur, comme sur tous les autres écrans.
 */
export default async function DashboardPage() {
  const asset = await getCurrentAsset();
  const [s, recentes] = await Promise.all([
    getDashboardStats(asset.id),
    lireStatsCampagnes(getDb(), asset.id, { limit: 5 }),
  ]);
  const fmt = (n: number) => n.toLocaleString("en-US");
  const pct = (n: number) => (s.totalSubs ? ((n / s.totalSubs) * 100).toFixed(0) : "0");

  const kpis = [
    { label: "Active subscribers", value: fmt(s.activeSubs), sub: `+${fmt(s.new30)} in 30d`, icon: Users, bg: "bg-brand-soft", fg: "text-brand" },
    { label: "Engaged (30d)", value: fmt(s.engActive), sub: `${pct(s.engActive)}% of list`, icon: Zap, bg: "bg-[#e2f5e9]", fg: "text-[#1f9d57]" },
    { label: "Dormant", value: fmt(s.engDormant), sub: `${pct(s.engDormant)}% · 30-90d`, icon: Moon, bg: "bg-[#fdf0dd]", fg: "text-[#e8973a]" },
    { label: "Lapsed", value: fmt(s.engChurned), sub: `${pct(s.engChurned)}% · 90d+`, icon: UserMinus, bg: "bg-accent", fg: "text-muted-foreground" },
  ];

  // Le libellé doit dire la VÉRITÉ sur ce que comptent les KPI ci-dessous : sans marque, RIEN n'est
  // lu (le chargeur rend vide), et le dire vaut mieux qu'une rangée de zéros muets.
  const desc = s.scoped
    ? `${asset.name} · ${fmt(s.totalSubs)} subscribers in this brand's database.`
    : "No brand is selected, so no numbers are shown. Pick a brand in the switcher at the top.";

  return (
    <div className="animate-fade-up">
      <PageHead title="Overview" desc={desc}>
        {s.scoped ? <Pill tone="pink" dot>{asset.name}</Pill> : <Pill tone="amber" dot>No brand selected</Pill>}
        {s.source === "db" ? <Pill tone="green" dot>Database</Pill> : <Pill tone="amber" dot>Database unavailable</Pill>}
        <Btn disabled title="Coming soon" className="opacity-50 cursor-not-allowed">
          <Download className="h-[15px] w-[15px]" strokeWidth={2} /> Export
        </Btn>
        <Btn disabled title="Coming soon" className="opacity-50 cursor-not-allowed">
          <CalendarDays className="h-[15px] w-[15px]" strokeWidth={2} /> 30 days
        </Btn>
      </PageHead>

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="hover-lift rounded-[14px] border border-border bg-card p-[17px]">
            <div className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] ${k.bg}`}>
                <k.icon className={`h-[14px] w-[14px] ${k.fg}`} strokeWidth={2} />
              </span>
              {k.label}
            </div>
            <div className="text-[27px] font-bold leading-none tracking-tight tabular-nums">{k.value}</div>
            <div className="mt-2 text-[11.5px] text-muted-foreground">{k.sub}</div>
          </div>
        ))}
      </div>

      <Card>
        <CardHead title="Subscriber growth" sub={`New per week · last 8 weeks${s.scoped ? ` · ${asset.name}` : ""}`} />
        <GrowthChart weekly={s.weekly} />
      </Card>

      {/*
        Les 5 dernières campagnes de la marque qui ont ENVOYÉ, archivées comprises (décision d'Alix du
        24/09), lues par `campaign_send_stats` (0085). ⛔ Une lecture ratée le DIT avec sa raison :
        une liste vide se lirait « aucune campagne n'a envoyé ».
      */}
      <Card className="mt-4">
        <CardHead
          title="Recent campaigns"
          sub="The last 5 campaigns that sent · archived ones included"
          right={
            <Link href="/analytics" className="text-[12.5px] font-medium text-brand hover:underline">
              All campaign analytics →
            </Link>
          }
        />
        {!recentes.known ? (
          <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            Campaign statistics could not be read: {recentes.reason}.
          </p>
        ) : recentes.campaigns.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2.5 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent">
              <Send className="h-5 w-5 text-muted-foreground" strokeWidth={1.9} />
            </div>
            <div className="text-[14px] font-semibold">No campaign has sent yet</div>
            <p className="max-w-[54ch] text-[12.5px] text-muted-foreground">
              Once a campaign of {asset.name} sends, its sent, bounce, spam, open and click figures appear here.
            </p>
          </div>
        ) : (
          <CampaignStatsTable campaigns={recentes.campaigns} maxEditions={10} />
        )}
      </Card>
    </div>
  );
}
