import { ShieldCheck, MailCheck } from "lucide-react";
import { PageHead, Card, Pill } from "@/components/ui";
import { getForms, PUBLIC_BASE } from "@/lib/data/forms";
import { EmbedCard } from "@/components/forms/embed-card";
import { getCurrentAsset } from "@/lib/asset-context";
import { getSessionUser } from "@/lib/session";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function FormsPage() {
  // Catalogue multi-marques, borné aux marques de la personne connectée. La marque courante
  // y est signalée, mais ce n'est plus le catalogue complet des neuf.
  const asset = await getCurrentAsset();
  const user = await getSessionUser();
  const { rows, source } = await getForms(user?.assetIds ?? []);
  // La marque courante d'abord — le reste garde l'ordre alphabétique de la requête.
  const ordered = [...rows].sort((a, b) => Number(b.slug === asset.slug) - Number(a.slug === asset.slug));

  return (
    <div>
      <PageHead
        title="Signup forms"
        desc="Drop-in embed widgets — paste the snippet on any site to start collecting subscribers. Shows every brand you have access to."
      >
        <Pill tone="pink" dot>Current: {asset.name}</Pill>
      </PageHead>

      {source === "none" && (
        <div className="mb-5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          Database unavailable — `SUPABASE_*` configuration missing. No brands to display.
        </div>
      )}

      {/* Double opt-in explainer */}
      <Card className="mb-6 flex items-start gap-3.5 border-brand-soft bg-brand-soft/40">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground">
          <MailCheck className="h-[18px] w-[18px]" />
        </div>
        <div className="text-[13px] leading-relaxed">
          <div className="font-semibold">Double opt-in is handled automatically</div>
          <p className="mt-0.5 max-w-[70ch] text-muted-foreground">
            Every submission triggers a confirmation email from the worker. Subscribers only become active
            after clicking the confirmation link, and each consent event is written to the immutable audit log.
            You never have to wire up confirmation flows — just embed the widget.
          </p>
        </div>
      </Card>

      {rows.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ordered.map((f) => {
            const isCurrent = f.slug === asset.slug;
            return (
              <div key={f.slug} className={cn("relative rounded-[14px]", isCurrent && "ring-2 ring-brand/55")}>
                {isCurrent && (
                  <span className="absolute -top-2 left-3.5 z-10 rounded-full bg-brand px-2 py-px text-[10.5px] font-semibold uppercase tracking-[0.03em] text-brand-foreground">
                    Current brand
                  </span>
                )}
                <EmbedCard form={f} base={PUBLIC_BASE} />
              </div>
            );
          })}
        </div>
      ) : (
        source === "db" && (
          <Card className="flex items-center gap-3 text-[13px] text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            No brands configured yet.
          </Card>
        )
      )}
    </div>
  );
}
