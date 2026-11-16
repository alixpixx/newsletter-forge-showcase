import { Card, CardHead, Td, Th } from "@/components/ui";
import { nombre, pct } from "@/lib/campaign-stats";
import { DIMENSIONS, valeurDimension, type EngagementCampagne, type LigneDimension, type Lecture } from "@/lib/engagement";
import {
  LIBELLES_DIMENSIONS,
  regrouperPremieresActions,
  suiviCoupe,
  tauxClicSurOuverture,
  type Tranche,
} from "@/lib/engagement-csv";

/**
 * L'ENGAGEMENT D'UNE CAMPAGNE (0094) sous ses chiffres d'envoi : ouvertures et clics, liens cliqués,
 * délai jusqu'à la 1re action, appareils, clients, systèmes, pays, villes. Composant SERVEUR (aucun
 * état) : il reçoit la lecture déjà faite par la page.
 *
 * ⛔ CE QUI N'EST PAS MESURÉ NE S'AFFICHE JAMAIS EN ZÉROS :
 *  - lecture ratée (0094 absente, réponse illisible) ⇒ la raison, pas des tableaux vides ;
 *  - suivi coupé pour tous les envois ⇒ « non mesuré », pas « 0 ouverture » ;
 *  - taux de clic sur ouverture sans ouverture humaine ⇒ « — ».
 * Un tableau vide n'apparaît que quand le suivi était actif : là, « aucun clic » est un vrai résultat.
 */

const ROSE = "#ff368d";
const VIOLET = "#7c5cf0";

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[10px] border border-border bg-accent/40 px-4 py-3 text-[13px] text-muted-foreground">{children}</p>
  );
}

export function EngagementSections({ lecture }: { lecture: Lecture<EngagementCampagne> }) {
  if (!lecture.known) {
    return <Note>Engagement details could not be read: {lecture.reason}.</Note>;
  }
  const e = lecture.value;
  if (e.sent === 0) {
    return <Note>Nothing was sent for this selection, so there is no engagement to show.</Note>;
  }
  if (suiviCoupe(e)) {
    return (
      <Note>
        Open and click tracking was off for all {nombre(e.sent)} sends of this selection, so opens, clicks, links,
        devices and locations are not measured. This does not mean nobody opened.
      </Note>
    );
  }

  return (
    <div className="space-y-4">
      <OuverturesEtClics e={e} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Liens liens={e.links} />
        <PremieresActions tranches={regrouperPremieresActions(e.firstActionHours)} />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {DIMENSIONS.map((d) => (
          <Dimension key={d} titre={LIBELLES_DIMENSIONS[d].titre} lignes={e.dimensions[d]} />
        ))}
      </div>
      <p className="text-[11.5px] leading-snug text-muted-foreground">
        Device, client, system and location come from the mail provider for each open and click; “Unknown” when it
        could not tell. Share = recipients with that value ÷ all recipients counted in the table — someone who opened
        on two devices counts in both.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function OuverturesEtClics({ e }: { e: EngagementCampagne }) {
  const ctor = tauxClicSurOuverture(e);
  const tuiles = [
    { label: "Unique opens", value: nombre(e.opens.unique), hint: "Recipients who opened at least once" },
    { label: "Total opens", value: nombre(e.opens.total), hint: "Every open, repeats included" },
    { label: "Human unique opens", value: nombre(e.opens.uniqueHuman), hint: "Recipients with at least one open not made by a machine" },
    {
      label: "Machine opens",
      value: nombre(e.opens.bot),
      hint: "Opens by mail-provider robots, e.g. Apple Mail Privacy Protection pre-loading images — not a person reading",
    },
    { label: "Unique clicks", value: nombre(e.clicks.unique), hint: "Recipients who clicked at least once" },
    { label: "Total clicks", value: nombre(e.clicks.total), hint: "Every click, repeats included" },
    {
      label: "Click-to-open rate",
      value: pct(ctor),
      hint: ctor === null ? "No human open yet, so no rate" : "Unique clicks ÷ human unique opens",
    },
  ];
  const nonSuivis = e.sent - e.tracked - e.trackingUnknown;
  return (
    <Card>
      <CardHead title="Opens & clicks" sub="Unique counts recipients once; total counts every event" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {tuiles.map((t) => (
          <div key={t.label} className="rounded-[10px] bg-accent/40 p-3">
            <div className="text-[11.5px] font-medium text-muted-foreground">{t.label}</div>
            <div className="mt-1 text-[20px] font-bold leading-none tracking-tight tabular-nums">{t.value}</div>
            <div className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{t.hint}</div>
          </div>
        ))}
      </div>
      {(e.trackingUnknown > 0 || nonSuivis > 0) && (
        <p className="mt-3 text-[12px] leading-snug text-muted-foreground">
          {nonSuivis > 0 &&
            `${nombre(e.tracked)} of ${nombre(e.sent)} recipients allowed tracking: opens and clicks come from them only. `}
          {e.trackingUnknown > 0 &&
            `${nombre(e.trackingUnknown)} send${e.trackingUnknown === 1 ? "" : "s"} left before tracking was recorded: their opens and clicks count when they happened, but whether they could be tracked is unknown.`}
        </p>
      )}
    </Card>
  );
}

function Liens({ liens }: { liens: EngagementCampagne["links"] }) {
  return (
    <Card>
      <CardHead title="Links clicked" sub={liens.length >= 25 ? "Top 25 links, by unique clickers" : "By unique clickers"} />
      {liens.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted-foreground">No link was clicked.</p>
      ) : (
        <div className="-mx-[18px] overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <Th className="px-3 py-2">Link</Th>
                <Th className="px-3 py-2 text-right">Unique</Th>
                <Th className="px-3 py-2 text-right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {liens.map((l) => (
                <tr key={l.url} className="hover:bg-accent/40">
                  {/* En texte, jamais en lien : une URL de campagne peut porter des paramètres de suivi. */}
                  <Td className="max-w-0 px-3 py-2">
                    <span title={l.url} className="block truncate font-mono text-[12px]">
                      {l.url}
                    </span>
                  </Td>
                  <Td className="w-20 px-3 py-2 text-right tabular-nums">{nombre(l.unique)}</Td>
                  <Td className="w-20 px-3 py-2 text-right tabular-nums">{nombre(l.total)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PremieresActions({ tranches }: { tranches: Tranche[] }) {
  const max = Math.max(0, ...tranches.flatMap((t) => [t.opens, t.clicks]));
  const barre = (v: number, couleur: string, nom: string, label: string) => (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-accent/60">
        <div
          className="h-full rounded-full"
          style={{ width: v === 0 ? 0 : `${Math.max(1.5, (v / max) * 100)}%`, background: couleur }}
        />
      </div>
      <span className="w-12 text-right text-[11.5px] tabular-nums text-muted-foreground" aria-label={`${nombre(v)} ${nom} ${label}`}>
        {nombre(v)}
      </span>
    </div>
  );
  return (
    <Card>
      <CardHead title="Time to first open / first click" sub="Hours from each recipient's own send to their first action" />
      {max === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted-foreground">No open or click yet.</p>
      ) : (
        <>
          <div className="mb-2 flex gap-4 text-[11.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: ROSE }} /> First open
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: VIOLET }} /> First click
            </span>
          </div>
          <ul className="space-y-1.5">
            {tranches.map((t) => (
              <li key={t.label} className="grid grid-cols-[56px_1fr] items-center gap-2">
                <span className="text-[12px] tabular-nums text-muted-foreground">{t.label}</span>
                <div className="space-y-0.5">
                  {barre(t.opens, ROSE, "first opens", t.label)}
                  {barre(t.clicks, VIOLET, "first clicks", t.label)}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11.5px] leading-snug text-muted-foreground">
            Each recipient counts once per action. Machine opens are included, so the first hour can look busier than
            real reading.
          </p>
        </>
      )}
    </Card>
  );
}

function Dimension({ titre, lignes }: { titre: string; lignes: LigneDimension[] }) {
  const somme = lignes.reduce((s, l) => s + l.unique, 0);
  return (
    <Card>
      <CardHead title={titre} sub={lignes.length >= 20 ? "Top 20 — share is among these" : undefined} />
      {lignes.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted-foreground">No open or click recorded.</p>
      ) : (
        <div className="-mx-[18px] overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <Th className="px-3 py-2">Value</Th>
                <Th className="px-3 py-2 text-right">Recipients</Th>
                <Th className="px-3 py-2 text-right">Share</Th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => (
                <tr key={l.value ?? "∅"} className="hover:bg-accent/40">
                  <Td className={l.value === null ? "px-3 py-2 italic text-muted-foreground" : "px-3 py-2"}>
                    {valeurDimension(l.value)}
                  </Td>
                  <Td className="px-3 py-2 text-right tabular-nums">
                    <span title={`${nombre(l.total)} events`}>{nombre(l.unique)}</span>
                  </Td>
                  <Td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {pct(somme > 0 ? l.unique / somme : null)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
