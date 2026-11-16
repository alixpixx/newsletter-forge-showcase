"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Pill, Th, Td } from "@/components/ui";
import {
  cumuler,
  jour,
  nombre,
  nomEnvoi,
  noteExclues,
  pct,
  raisonNonMesure,
  taux,
  type CampagneStats,
  type Cumul,
  type EnvoiStats,
} from "@/lib/campaign-stats";
import { cn } from "@/lib/utils";

/** Un envoi, ou le cumul d'une campagne (qui dit en plus ce qu'il laisse de côté). */
type Compteurs = EnvoiStats | Cumul;

/**
 * Les 7 colonnes de chiffres, pour une campagne entière ou pour un envoi.
 *
 * ⛔ Ce qui n'est pas mesuré s'écrit « — » avec la RAISON en infobulle, jamais 0 ni 0 % : le 24/09,
 * 1 abonnement sur 1 269 acceptait le suivi des ouvertures.
 */
function Chiffres({ c }: { c: Compteurs }) {
  const t = taux(c);
  const raison = raisonNonMesure(c);
  const note = "exclues" in c ? noteExclues(c) : null;
  const nonMesure = (
    <span title={raison ?? undefined} className="cursor-help text-muted-foreground/60">
      —
    </span>
  );
  const mesure = (v: string) => (note ? <span title={note} className="cursor-help underline decoration-dotted underline-offset-2">{v}</span> : v);
  return (
    <>
      <Td className="text-right tabular-nums">{nombre(c.sent)}</Td>
      <Td className="text-right tabular-nums">
        <span title={t.bounceRate === null ? undefined : `${pct(t.bounceRate)} of sent`}>{nombre(c.bounced)}</span>
      </Td>
      <Td className="text-right tabular-nums">
        <span title={t.spamRate === null ? undefined : `${pct(t.spamRate)} of delivered`}>{nombre(c.complained)}</span>
      </Td>
      <Td className="text-right tabular-nums">{raison ? nonMesure : mesure(nombre(c.opened))}</Td>
      <Td className="text-right tabular-nums">{t.openRate === null ? nonMesure : mesure(pct(t.openRate))}</Td>
      <Td className="text-right tabular-nums">{raison ? nonMesure : mesure(nombre(c.clicked))}</Td>
      <Td className="text-right tabular-nums">{t.ctr === null ? nonMesure : mesure(pct(t.ctr))}</Td>
    </>
  );
}

const ENTETES = ["Sent", "Bounce", "Spam", "Open", "Open rate", "Click", "CTR"];

/**
 * Tableau des campagnes qui ont envoyé — le même à l'Overview (5 campagnes, 10 éditions dépliées au
 * plus) et sur Analytics › Campaigns. Une campagne récurrente se déplie en une ligne par édition, la
 * plus récente en haut ; une one-shot porte ses chiffres sur sa ligne.
 */
export function CampaignStatsTable({
  campaigns,
  maxEditions = 10,
}: {
  campaigns: CampagneStats[];
  /** Au-delà, un lien « See all N editions » vers la page de la campagne. */
  maxEditions?: number;
}) {
  const [ouvertes, setOuvertes] = useState<Set<string>>(new Set());
  const basculer = (id: string) =>
    setOuvertes((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="-mx-[18px] overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-[13px]">
        <thead>
          <tr>
            <Th>Campaign</Th>
            <Th>Last sent</Th>
            {ENTETES.map((h) => (
              <Th key={h} className="text-right">
                {h}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => {
            const depliable = c.recurring && c.editions.length > 0;
            const ouverte = ouvertes.has(c.id);
            const visibles = c.editions.slice(0, maxEditions);
            return (
              <Fragment key={c.id}>
                <tr className="hover:bg-accent/40">
                  <Td>
                    <div className="flex items-center gap-2">
                      {depliable ? (
                        <button
                          type="button"
                          onClick={() => basculer(c.id)}
                          aria-expanded={ouverte}
                          aria-label={`${ouverte ? "Hide" : "Show"} the editions of ${c.name}`}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          <ChevronRight className={cn("h-4 w-4 transition-transform", ouverte && "rotate-90")} />
                        </button>
                      ) : (
                        <span className="w-6 shrink-0" />
                      )}
                      <Link href={`/analytics/campaigns/${c.id}`} className="font-semibold hover:underline">
                        {c.name || "Untitled campaign"}
                      </Link>
                      <Pill tone={c.recurring ? "violet" : "blue"}>
                        {c.recurring
                          ? `Recurring · ${c.editions.length} edition${c.editions.length === 1 ? "" : "s"}`
                          : "One-shot"}
                      </Pill>
                      {c.archived && <Pill tone="grey">Archived</Pill>}
                      {/* Masquée des analytics (0093) : n'apparaît ici que sur « Show hidden ». */}
                      {c.hidden && (
                        <span title="Hidden from analytics: left out of the lists unless Show hidden is on. Its figures are unchanged.">
                          <Pill tone="amber">Hidden</Pill>
                        </span>
                      )}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-muted-foreground">{jour(c.lastSentAt)}</Td>
                  <Chiffres c={cumuler(c.editions)} />
                </tr>
                {depliable &&
                  ouverte &&
                  visibles.map((e: EnvoiStats) => (
                    <tr key={e.occurrenceId ?? `${c.id}-unique`} className="bg-accent/25">
                      <Td className="pl-14 text-muted-foreground">{nomEnvoi(e)}</Td>
                      <Td className="whitespace-nowrap text-muted-foreground">{jour(e.sentAt)}</Td>
                      <Chiffres c={e} />
                    </tr>
                  ))}
                {depliable && ouverte && c.editions.length > maxEditions && (
                  <tr className="bg-accent/25">
                    <Td className="pl-14">
                      <Link href={`/analytics/campaigns/${c.id}`} className="text-[12.5px] font-medium text-brand hover:underline">
                        See all {c.editions.length} editions →
                      </Link>
                    </Td>
                    <td colSpan={ENTETES.length + 1} className="border-b border-border" />
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
