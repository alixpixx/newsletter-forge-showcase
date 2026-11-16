import { Td, Th } from "@/components/ui";
import type { SourceAudience } from "@/lib/engagement";
import { libelleSource, lignesNiveaux, partEngagee } from "@/lib/audience-view";
import { nombre, pct } from "@/lib/campaign-stats";

/*
 * Niveaux d'engagement et sources (0094) — composants serveur, présentation seule. Les deux décrivent
 * l'audience telle qu'elle EST, pas la période choisie.
 *
 * ⛔ Une part sans dénominateur (aucun actif) s'écrit « — », jamais 0 %.
 */

const SENS_NIVEAU: Record<string, string> = {
  active: "Reacted recently — or too new to judge",
  dormant: "No reaction for a while",
  churned: "No reaction for a long time",
  unknown: "No level computed yet",
};

/** Les abonnés ACTIFS par niveau d'engagement, avec leur part. */
export function AudienceLevels({ levels }: { levels: Record<string, number> }) {
  const lignes = lignesNiveaux(levels);
  if (lignes.every((l) => l.count === 0)) {
    return <p className="py-4 text-center text-[13px] text-muted-foreground">No active subscriber right now.</p>;
  }
  return (
    <div className="-mx-[18px] overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-[13px]">
        <thead>
          <tr>
            <Th>Level</Th>
            <Th className="text-right">Subscribers</Th>
            <Th className="w-[40%]">Share of active</Th>
          </tr>
        </thead>
        <tbody>
          {lignes.map((l) => (
            <tr key={l.level} className="hover:bg-accent/40">
              <Td>
                <div className="font-medium">{l.label}</div>
                {SENS_NIVEAU[l.level] && <div className="text-[11.5px] text-muted-foreground">{SENS_NIVEAU[l.level]}</div>}
              </Td>
              <Td className="text-right tabular-nums">{nombre(l.count)}</Td>
              <Td>
                <div className="flex items-center gap-2.5">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${(l.share ?? 0) * 100}%` }} />
                  </div>
                  <span className="w-12 text-right text-[12px] tabular-nums text-muted-foreground">{pct(l.share)}</span>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ENTETES = ["Total", "Active", "Pending", "Contacts", "Unsubscribed", "Engaged", "Avg score"];

/** Une ligne par source enregistrée, de la plus grosse à la plus petite (ordre de la base). */
export function AudienceSources({ sources }: { sources: SourceAudience[] }) {
  if (sources.length === 0) {
    return <p className="py-4 text-center text-[13px] text-muted-foreground">No subscriber yet.</p>;
  }
  const aucunActif = (
    <span title="No active subscriber from this source" className="cursor-help text-muted-foreground/60">
      —
    </span>
  );
  return (
    <div className="-mx-[18px] overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-[13px]">
        <thead>
          <tr>
            <Th>Source</Th>
            {ENTETES.map((h) => (
              <Th key={h} className="text-right">
                {h}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => {
            const part = partEngagee(s);
            return (
              <tr key={s.source} className="hover:bg-accent/40">
                <Td className="font-medium">{libelleSource(s.source)}</Td>
                <Td className="text-right tabular-nums">{nombre(s.total)}</Td>
                <Td className="text-right tabular-nums">{nombre(s.active)}</Td>
                <Td className="text-right tabular-nums">{nombre(s.pending)}</Td>
                <Td className="text-right tabular-nums">{nombre(s.contacts)}</Td>
                <Td className="text-right tabular-nums">{nombre(s.unsubscribed)}</Td>
                <Td className="text-right tabular-nums">
                  {part === null ? (
                    aucunActif
                  ) : (
                    <span title={`${nombre(s.engaged)} of ${nombre(s.active)} active subscribers`}>
                      {nombre(s.engaged)} <span className="text-[11.5px] text-muted-foreground">({pct(part)})</span>
                    </span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">
                  {s.avgScore === null ? aucunActif : <span title="Average engagement score of active subscribers, 0–100">{s.avgScore}</span>}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
