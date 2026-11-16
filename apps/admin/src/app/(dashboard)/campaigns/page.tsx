import Link from "next/link";
import { AlertTriangle, Archive } from "lucide-react";
import { PageHead, Pill } from "@/components/ui";
import { getCurrentAsset } from "@/lib/asset-context";
import { CAMPAIGN_PURPOSES, compterCampagnesParOnglet, listCampaigns } from "@/lib/data/campaigns";
import { cn } from "@/lib/utils";
import { listPublishedVersions, listSegmentOptions } from "@/components/campaigns/campaign-data";
import { CampaignEmptyState, CampaignTable } from "@/components/campaigns/campaign-table";
import { NewCampaignButton } from "@/components/campaigns/new-campaign-button";
import { estUneSerie } from "@/components/campaigns/cadence";
import { listEditions } from "@/lib/data/wp-sources";
import { echeancesDesSeries, type EcheanceSerie } from "@/lib/data/occurrences";
import { getDb } from "@/lib/supabase";

// Une campagne change d'état à chaque action (verrou, planification, annulation) : jamais de cache.
export const dynamic = "force-dynamic";

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const asset = await getCurrentAsset();
  const sp = await searchParams;
  /*
   * L'ONGLET (0077) — Active par défaut, Archived sur `?tab=archived`.
   * ⚠️ Comparaison FERMÉE : toute autre valeur retombe sur l'onglet actif, jamais sur un écran vide
   * ni sur un mélange des deux.
   */
  const onglet: "active" | "archived" = sp.tab === "archived" ? "archived" : "active";
  const db = getDb();

  // Base injoignable → `asset.id` null : on n'invente rien, on affiche l'état dégradé.
  const [campaigns, versions, segments, editions, parOnglet] = await Promise.all([
    listCampaigns(asset.id, { archived: onglet === "archived" }),
    listPublishedVersions(asset.id),
    listSegmentOptions(asset.id),
    listEditions(asset.id),
    db && asset.id ? compterCampagnesParOnglet(db, asset.id) : Promise.resolve({ active: null, archived: null }),
  ]);

  /*
   * Fuseau de l'édition, pour pré-remplir la cadence d'une série.
   *
   * ⛔ PAS celui du navigateur. L'assistant écrivait « saisi dans le fuseau de votre navigateur » :
   * une newsletter chilienne programmée depuis Paris partait avec cinq heures d'écart, et rien à
   * l'écran ne le disait. `null` quand l'édition n'en déclare pas — on ne devine pas à sa place.
   */
  const editionTimezone = editions.find((e) => e.timezone)?.timezone ?? null;

  const segmentNames: Record<string, string> = {};
  for (const s of segments) segmentNames[s.id] = s.name;

  /*
   * La prochaine échéance de chaque SÉRIE — une seule requête, et seulement pour les séries.
   *
   * ⛔ Une campagne ponctuelle est exclue exprès : sa date est sur la ligne (`scheduledAt`), elle
   * n'a pas d'occurrence. L'inclure ferait chercher en base une réponse qu'on tient déjà.
   * ⚠️ `estUneSerie` plutôt qu'un `recurrenceDays.length > 0` recopié ici : la même question posée
   * à deux endroits finit par recevoir deux réponses.
   */
  const echeances: Record<string, EcheanceSerie> = {};
  // L'onglet Archived n'affiche aucune échéance : une campagne rangée n'a pas de prochain envoi.
  if (db && asset.id && onglet === "active") {
    const series = campaigns.filter(estUneSerie).map((c) => c.id);
    for (const [id, etat] of await echeancesDesSeries(db, series, asset.id, new Date().toISOString())) {
      echeances[id] = etat;
    }
  }

  /*
   * ⛔ UN SEUL EXEMPLAIRE, MONTÉ UNE SEULE FOIS. Ce bouton était injecté ici ET dans l'état vide :
   * sur une marque sans campagne, l'écran affichait DEUX boutons « New campaign » et montait DEUX
   * assistants — le dédoublement signalé par Alix le 18/09/2026 (« certains block se dedoublait »).
   * Un élément React réutilisé à deux endroits n'est pas partagé : ce sont deux instances, deux
   * états, deux formulaires qui divergent. L'état vide renvoie donc vers CE bouton au lieu d'en
   * fabriquer un second.
   */
  const newButton = (
    <NewCampaignButton
      versions={versions}
      segments={segments}
      purposes={[...CAMPAIGN_PURPOSES]}
      editionTimezone={editionTimezone}
      disabled={!asset.id}
      disabledReason="Database unavailable — cannot create a campaign"
    />
  );

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Campaigns"
        desc="A campaign points a published template version at a segment. It goes out once on a date you pick, or repeats on a weekly cadence — its content is frozen the moment it is scheduled, so republishing the template never rewrites an approved send."
      >
        {newButton}
      </PageHead>

      <div className="mb-4 flex items-center gap-2">
        <Pill tone="pink" dot>
          {asset.name}
        </Pill>
        {/* Le compteur NOMME ce qu'il compte : « 9 campaigns » sous l'onglet Active laisserait croire
            que les archivées n'existent plus, ou qu'elles sont dedans. */}
        <span className="text-[12px] text-muted-foreground">
          {campaigns.length} {onglet} campaign{campaigns.length === 1 ? "" : "s"} in scope
        </span>
      </div>

      {/* Onglets SERVEUR (même forme que la bibliothèque de modèles) : l'onglet vit dans l'URL, il se
          partage et revient tel quel après un `router.refresh()`. */}
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Campaign sections">
        {(
          [
            { cle: "active", label: "Active", href: "/campaigns", n: parOnglet.active },
            { cle: "archived", label: "Archived", href: "/campaigns?tab=archived", n: parOnglet.archived },
          ] as const
        ).map((o) => (
          <Link
            key={o.cle}
            href={o.href}
            aria-current={onglet === o.cle ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-[9px] border px-3 py-[7px] text-[12.5px] font-medium transition-colors",
              onglet === o.cle
                ? "border-brand-soft bg-brand-soft text-brand-soft-foreground"
                : "border-border bg-card text-foreground/75 hover:bg-accent",
            )}
          >
            {o.label}
            {/* `null` = compte illisible : rien plutôt qu'un zéro inventé. */}
            {o.n !== null && <span className="tabular-nums opacity-70">{o.n}</span>}
          </Link>
        ))}
      </nav>

      {!asset.id && (
        <div className="mb-4 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Database unavailable — the brand could not be resolved, so no campaign can be listed or
            created right now.
          </span>
        </div>
      )}

      {campaigns.length === 0 ? (
        !asset.id ? null : onglet === "archived" ? (
          <div className="flex flex-col items-center justify-center gap-2.5 rounded-[14px] border border-dashed border-border bg-accent/30 px-6 py-14 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
              <Archive className="h-5 w-5 text-brand" strokeWidth={1.9} />
            </div>
            <div className="text-[14px] font-semibold">No archived campaigns</div>
            <p className="max-w-[56ch] text-[12.5px] leading-relaxed text-muted-foreground">
              Archive a campaign from the Active tab or from its page. Archiving stops what it was doing — a
              running series stops and its planned editions are cancelled, a scheduled send comes off the
              schedule — and Reactivate here starts it again.
            </p>
          </div>
        ) : (
          <CampaignEmptyState brand={asset.name} />
        )
      ) : (
        <CampaignTable rows={campaigns} segmentNames={segmentNames} echeances={echeances} onglet={onglet} />
      )}

      {/*
        ⛔⛔ CE TEXTE AFFIRMAIT « no campaign email leaves yet ». C'était vrai jusqu'au fan-out (S-6)
        et à la réconciliation (S-7) ; ça ne l'est plus, et le worker est passé en mode d'envoi réel
        le 18/09/2026 à 12:58 UTC. Un écran qui promet que rien ne part, devant des campagnes qui
        partent pour de vrai, est le plus cher des textes périmés : il désarme la prudence de celui
        qui clique. Ce qui reste vrai — et seulement ça — est écrit ici.
      */}
      <p className="mt-3 max-w-[74ch] text-[12px] text-muted-foreground/80">
        A scheduled campaign is picked up by the send worker at its date and really goes out. Opens, clicks and bounces are not collected yet, so the recipient counts above come from
        the send queue itself, not from a delivery report.
      </p>
    </div>
  );
}
