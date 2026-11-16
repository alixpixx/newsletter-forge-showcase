import { Td, Th } from "@/components/ui";
import { METRIQUES_SEMAINE, type MetriqueSemaine } from "@/lib/engagement";
import { pivotSemaines } from "@/lib/audience-view";
import { jour, nombre } from "@/lib/campaign-stats";

/*
 * « Week by week » (0094) — composant serveur. Ici un 0 est un VRAI compte (rien n'a eu lieu cette
 * semaine-là) : les semaines sans événement sont des lignes à 0, pas des trous.
 */

const LIBELLE: Record<MetriqueSemaine, string> = {
  signups: "Signups",
  imported: "Imported",
  confirmations: "Confirmations",
  unsubscribes: "Unsubscribes",
  readers: "Readers",
};

export function AudienceWeekly({
  weekly,
  bornes,
  timezone,
}: {
  weekly: { week: string; metric: MetriqueSemaine; count: number }[];
  bornes: { debut: string | null; fin: string };
  timezone: string;
}) {
  const lignes = pivotSemaines(weekly, bornes);
  return (
    <>
      {lignes.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted-foreground">
          No signup, import, confirmation, unsubscribe or recorded open in this period.
        </p>
      ) : (
        <div className="-mx-[18px] max-h-[520px] overflow-auto">
          <table className="w-full min-w-[640px] border-collapse text-[13px]">
            <thead className="sticky top-0 bg-card">
              <tr>
                <Th>Week of</Th>
                {METRIQUES_SEMAINE.map((m) => (
                  <Th key={m} className="text-right">
                    {LIBELLE[m]}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => (
                <tr key={l.week} className="hover:bg-accent/40">
                  <Td className="whitespace-nowrap font-medium">{jour(l.week)}</Td>
                  {METRIQUES_SEMAINE.map((m) => (
                    <Td key={m} className={l.counts[m] === 0 ? "text-right tabular-nums text-muted-foreground/70" : "text-right tabular-nums"}>
                      {nombre(l.counts[m])}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="mt-3 flex flex-col gap-1 text-[11.5px] leading-snug text-muted-foreground">
        <li>Weeks start on Monday, in {timezone}; the first week of the period may be partial.</li>
        <li>Signups = new subscriptions, except imports and CRM syncs (counted under Imported).</li>
        <li>
          Unsubscribes only count those recorded with a date. Subscribers imported already unsubscribed have no
          unsubscribe date and are not counted here.
        </li>
        <li>Readers = distinct subscribers with at least one recorded open that week; opens are only recorded for recipients who allow tracking.</li>
      </ul>
    </>
  );
}
