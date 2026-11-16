import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { PageHead, Btn, Pill, Card, CardHead, type Tone } from "@/components/ui";
import { DemoBanner } from "@/components/demo-banner";
import { getAssets } from "@/lib/data/assets";
import { getCurrentAsset } from "@/lib/asset-context";
import { listWpSources } from "@/lib/data/wp-sources";
import { ASSETS } from "@nf/config";

// Lit la base à chaque requête (sinon Next prérend la page au build et fige les marques).
export const dynamic = "force-dynamic";

const GRAD = [
  "linear-gradient(135deg,#ff5fa2,#ff368d)", "#3d7fef", "#7c5cf0", "#e8973a", "#1f9d57",
  "#e5495e", "#0ea5e9", "#d4499e", "#f59e0b",
];

function initials(name: string) {
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

// Régime d'affichage par marque (depuis le registre @nf/config).
const REGIME: Record<string, { label: string; tone: Tone }> = {};
for (const a of ASSETS) {
  const multi = a.regimes.length > 1;
  REGIME[a.slug] = {
    label: multi ? "Multi" : a.regimes[0] === "gdpr" ? "GDPR" : a.regimes[0].toUpperCase(),
    tone: multi ? "amber" : a.regimes[0] === "gdpr" ? "blue" : a.regimes[0] === "lgpd" ? "amber" : "violet",
  };
}

export default async function SettingsPage() {
  const { rows, source } = await getAssets();

  // WordPress cesse d'être une ligne écrite en dur : on lit les sources réelles de la marque et on
  // compte celles qui ont RÉPONDU à une sonde. Une source déclarée mais jamais testée n'est pas
  // « configurée » — c'est précisément la distinction que l'ancienne ligne statique effaçait.
  const asset = await getCurrentAsset();
  const { rows: wpSources, error: wpError } = await listWpSources(asset.id ?? null);
  const wpOk = wpSources.filter((w) => w.status === "ok").length;
  const wpFailing = wpSources.filter((w) => w.status === "error").length;

  // Uniquement les marques réelles (base, ou registre @nf/config en repli).
  // Les compteurs d'abonnés par marque ont été RETIRÉS : ils étaient dérivés d'un hash du slug.
  const brands = rows.map((a) => ({ slug: a.slug, name: a.name, market: a.market ?? null }));

  const conn: { name: string; status: string; tone: Tone; href?: string }[] = [
    { name: "Database (Supabase · US)", status: source === "db" ? "Connected" : "Not configured", tone: source === "db" ? "green" : "amber" },
    { name: "Sending (AWS SES · EU)", status: "Not configured", tone: "amber" },
    { name: "CRM", status: "Not configured", tone: "amber" },
    {
      name: "WordPress (read-only)",
      // ⚠️ « Unreadable » n'est PAS « Not configured » : le premier est une panne à corriger, le
      // second un travail à faire. Les confondre fait chercher au mauvais endroit.
      status: wpError
        ? "Unreadable"
        : wpSources.length === 0
          ? "Not configured"
          : wpFailing > 0
            ? `${wpOk}/${wpSources.length} sources · ${wpFailing} failing`
            : `${wpOk} source${wpOk > 1 ? "s" : ""} connected`,
      tone: wpError
        ? "red"
        : wpSources.length === 0
          ? "amber"
          : wpFailing > 0
            ? "red"
            : wpOk > 0
              ? "green"
              : "grey",
      href: "/settings/wordpress",
    },
  ];

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Settings"
        desc="Brands, compliance, connections. Each brand has its own branding, language and regulation."
      />

      {/* Marques et connexions sont réelles. Depuis le 22/09/2026 (décision d'Alix) une marque se
          RÈGLE — nom, langue, marché, régime, expéditeur — mais ne se CRÉE pas encore : le bandeau
          dit exactement cette frontière. */}
      <DemoBanner text="Open a brand to edit its name, languages, markets, compliance regime and sender. Creating a brand isn't wired yet. WordPress sources are real and editable." />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHead
            title="Brands"
            right={
              <div className="flex items-center gap-2">
                {source === "db" ? <Pill tone="green" dot>Database</Pill> : <Pill tone="grey">Config</Pill>}
                {/* Aucune route de création de marque — désactivé plutôt que muet. */}
                <Btn disabled title="Coming soon" className="!px-2.5 !py-1 cursor-not-allowed text-[12px] opacity-50">
                  <Plus className="h-3.5 w-3.5" /> Add
                </Btn>
              </div>
            }
          />
          <div className="max-h-[340px] overflow-y-auto">
            {brands.map((a, i) => {
              const inner = (
                <>
                  <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[9px] font-bold text-white" style={{ background: GRAD[i % GRAD.length] }}>
                    {initials(a.name)}
                  </span>
                  <span className="text-[12.5px] font-medium">{a.name}</span>
                  <Pill tone="grey" className="ml-auto">{a.market ?? "—"}</Pill>
                  {REGIME[a.slug] && <Pill tone={REGIME[a.slug].tone}>{REGIME[a.slug].label}</Pill>}
                </>
              );
              // ⚠️ Une marque lue du REGISTRE (base injoignable) n'a pas de page de réglages à ouvrir :
              // on ne pose le lien que sur une marque lue en base, là où l'écriture a un sens.
              return source === "db" ? (
                <Link
                  key={a.slug}
                  href={`/settings/brands/${encodeURIComponent(a.slug)}`}
                  className="flex items-center gap-3 border-b border-border py-2.5 last:border-0 hover:bg-muted/50"
                >
                  {inner}
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                </Link>
              ) : (
                <div key={a.slug} className="flex items-center gap-3 border-b border-border py-2.5 last:border-0">
                  {inner}
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHead title="Connections" />
          {conn.map((c) => {
            const inner = (
              <>
                <span className="text-[12.5px] font-medium">{c.name}</span>
                <Pill tone={c.tone} dot className="ml-auto">{c.status}</Pill>
                {/* Le chevron n'apparaît que là où il y a vraiment un écran derrière. */}
                {c.href && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
              </>
            );
            return c.href ? (
              <Link
                key={c.name}
                href={c.href}
                className="flex items-center gap-3 border-b border-border py-2.5 last:border-0 hover:bg-muted/50"
              >
                {inner}
              </Link>
            ) : (
              <div key={c.name} className="flex items-center gap-3 border-b border-border py-2.5 last:border-0">
                {inner}
              </div>
            );
          })}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHead title="Roles & access" sub="Company SSO coming soon — login/password auth in the meantime" />
        {/* Les compteurs par rôle étaient inventés : on garde les rôles, on retire les chiffres. */}
        <div className="flex flex-wrap gap-2">
          <Pill tone="pink">Full access</Pill>
          <Pill tone="grey">Send only</Pill>
          <Pill tone="grey">Read only</Pill>
        </div>
      </Card>
    </div>
  );
}
