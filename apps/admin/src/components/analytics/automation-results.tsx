import Link from "next/link";
import { Card, Pill, Td, Th, type Tone } from "@/components/ui";
import { STATUS_LABEL, STATUS_TONE, triggerLabel } from "@/lib/automations";
import { jour, nombre, pct } from "@/lib/campaign-stats";
import { cumulAutomation, type EtapeAutomation, type ResultatsAutomation } from "@/lib/engagement";
import {
  dernierEnvoi,
  raisonNonMesure,
  tauxAutomation,
  type CompteursAutomation,
  type TauxAutomation,
} from "@/lib/automation-view";

/*
 * Résultats des automations (0094) — PRÉSENTATION SEULE, composant serveur : la page lit, ces vues
 * mettent en forme ce qui a été lu.
 *
 * ⛔ Ce qui n'est pas mesuré s'écrit « — » avec la RAISON en infobulle, jamais 0 ni 0 %.
 * ⛔ Les envois SIMULÉS sont montrés À PART : le mode simulation note qui aurait reçu l'e-mail et
 * n'envoie rien. Ils n'entrent dans aucun taux.
 */

// Le statut arrive en texte libre de la base : un statut inconnu de l'admin s'affiche tel quel, en gris.
const LIBELLE_STATUT = STATUS_LABEL as Readonly<Record<string, string | undefined>>;
const TON_STATUT = STATUS_TONE as Readonly<Record<string, Tone | undefined>>;

function NonMesure({ raison }: { raison: string | null }) {
  return (
    <span title={raison ?? undefined} className="cursor-help text-muted-foreground/60">
      —
    </span>
  );
}

/** Une carte par automation, dans l'ordre de la base (par nom). */
export function AutomationResults({ automations }: { automations: ResultatsAutomation[] }) {
  return (
    <div className="flex flex-col gap-4">
      {automations.map((a) => (
        <CarteAutomation key={a.id} a={a} />
      ))}
    </div>
  );
}

function CarteAutomation({ a }: { a: ResultatsAutomation }) {
  const total = cumulAutomation(a.steps);
  return (
    <Card>
      <div className="mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link href={`/automations/${a.id}`} className="text-[14px] font-semibold hover:text-brand hover:underline">
          {a.name || "Untitled automation"}
        </Link>
        <Pill tone={TON_STATUT[a.status] ?? "grey"} dot>
          {LIBELLE_STATUT[a.status] ?? a.status}
        </Pill>
        <span className="text-[12.5px] text-muted-foreground">{a.trigger ? triggerLabel(a.trigger) : "No trigger"}</span>
      </div>

      {a.steps.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted-foreground">No send, real or simulated, in this period.</p>
      ) : (
        <>
          <Totaux c={total} t={tauxAutomation(total)} raison={raisonNonMesure(total)} dernier={dernierEnvoi(a.steps)} />
          {total.simulated > 0 && (
            <p className="mb-3 rounded-[10px] border border-violet-200 bg-violet-50 px-3.5 py-2.5 text-[12.5px] text-violet-800">
              {nombre(total.simulated)} simulated send{total.simulated === 1 ? "" : "s"}: simulation mode records who
              would have received the email and sends nothing. They were never delivered and count in no rate.
            </p>
          )}
          <Entonnoir steps={a.steps} />
        </>
      )}
    </Card>
  );
}

/** La ligne de totaux d'une automation, toutes étapes confondues. */
function Totaux({
  c,
  t,
  raison,
  dernier,
}: {
  c: CompteursAutomation;
  t: TauxAutomation;
  raison: string | null;
  dernier: string | null;
}) {
  const tuiles: { label: string; value: React.ReactNode; hint: string }[] = [
    { label: "Real sends", value: nombre(c.real), hint: "Queued to go out" },
    { label: "Simulated", value: nombre(c.simulated), hint: "Never sent" },
    { label: "Sent", value: nombre(c.sent), hint: t.sentRate === null ? "Accepted by the provider" : `${pct(t.sentRate)} of real` },
    { label: "Failed", value: nombre(c.failed), hint: "Send error" },
    { label: "Skipped", value: nombre(c.skipped), hint: "Held back by the send checks" },
    { label: "Queued", value: nombre(c.queued), hint: "Not sent yet" },
    { label: "Delivered", value: nombre(c.delivered), hint: t.deliveryRate === null ? "Nothing accepted yet" : `${pct(t.deliveryRate)} of sent` },
    { label: "Bounce rate", value: t.bounceRate === null ? <NonMesure raison="Nothing accepted yet." /> : pct(t.bounceRate), hint: `${nombre(c.bounced)} bounced of sent` },
    { label: "Open rate", value: t.openRate === null ? <NonMesure raison={raison} /> : pct(t.openRate), hint: raison ?? `${nombre(c.opened)} of ${nombre(c.tracked)} tracked` },
    { label: "Click rate", value: t.clickRate === null ? <NonMesure raison={raison} /> : pct(t.clickRate), hint: raison ?? `${nombre(c.clicked)} of ${nombre(c.tracked)} tracked` },
    { label: "Last send", value: jour(dernier), hint: "Real or simulated" },
  ];
  return (
    <dl className="mb-3 grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2">
      {tuiles.map((k) => (
        <div key={k.label} className="rounded-[10px] border border-border px-3 py-2.5">
          <dt className="text-[11.5px] font-medium text-muted-foreground">{k.label}</dt>
          <dd className="mt-1 text-[17px] font-bold leading-none tracking-tight tabular-nums">{k.value}</dd>
          <dd className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{k.hint}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Un compte et, dessous, son taux sur l'étape précédente — « — » avec la raison s'il n'est pas mesurable. */
function Etage({ n, taux, base, raison }: { n: React.ReactNode; taux: number | null; base: string; raison: string | null }) {
  return (
    <Td className="text-right tabular-nums">
      <div>{n}</div>
      <div className="text-[11px] text-muted-foreground">
        {taux === null ? <NonMesure raison={raison} /> : `${pct(taux)} ${base}`}
      </div>
    </Td>
  );
}

const ENTETES = ["Real", "Sent", "Delivered", "Bounced", "Opened", "Clicked", "Simulated", "Last send"];

/** L'entonnoir par étape : réels → acceptés → délivrés → ouverts → cliqués. */
function Entonnoir({ steps }: { steps: EtapeAutomation[] }) {
  return (
    <>
      <p className="mb-1 text-[12px] text-muted-foreground">
        Per step: real sends → sent → delivered → opened → clicked. Open and click rates use delivered recipients
        who allow tracking.
      </p>
      <div className="-mx-[18px] overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-[13px]">
          <thead>
            <tr>
              <Th>Step</Th>
              {ENTETES.map((h) => (
                <Th key={h} className="text-right">
                  {h}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => {
              const t = tauxAutomation(s);
              const raison = raisonNonMesure(s);
              const nonEnvoyes = `${nombre(s.failed)} failed · ${nombre(s.skipped)} skipped · ${nombre(s.queued)} queued`;
              return (
                <tr key={s.step} className="hover:bg-accent/40">
                  <Td className="font-medium">Step {s.step}</Td>
                  <Td className="text-right tabular-nums">{nombre(s.real)}</Td>
                  <Etage
                    n={<span title={nonEnvoyes} className="cursor-help">{nombre(s.sent)}</span>}
                    taux={t.sentRate}
                    base="of real"
                    raison="No real send."
                  />
                  <Etage n={nombre(s.delivered)} taux={t.deliveryRate} base="of sent" raison="Nothing accepted yet." />
                  <Etage n={nombre(s.bounced)} taux={t.bounceRate} base="of sent" raison="Nothing accepted yet." />
                  <Etage n={raison ? <NonMesure raison={raison} /> : nombre(s.opened)} taux={t.openRate} base="of tracked" raison={raison} />
                  <Etage n={raison ? <NonMesure raison={raison} /> : nombre(s.clicked)} taux={t.clickRate} base="of tracked" raison={raison} />
                  <Td className="text-right tabular-nums text-muted-foreground">
                    <span title="Simulation mode: never sent">{nombre(s.simulated)}</span>
                  </Td>
                  <Td className="whitespace-nowrap text-right text-muted-foreground">{jour(s.lastAt)}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
