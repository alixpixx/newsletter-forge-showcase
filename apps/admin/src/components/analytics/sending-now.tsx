import Link from "next/link";
import { AutoReload } from "@/components/analytics/auto-reload";
import { Card, CardHead, Pill } from "@/components/ui";
import {
  cibleEnvoi,
  duree,
  finEstimee,
  heure,
  jour,
  nombre,
  pct,
  raisonNonMesure,
  restants,
  rythmeParHeure,
  taux,
  type EnvoiEnCours,
  type EnvoisEnCours,
} from "@/lib/campaign-stats";

/** Toutes les 60 s : le travailleur envoie par fenêtres de 5 min, une minute suffit à voir bouger. */
const RECHARGEMENT_S = 60;

/** « 14:19 UTC », précédé du jour quand ce n'est pas celui de la lecture. */
function quand(iso: string | null, asOf: string): string {
  if (!iso) return "—";
  return iso.slice(0, 10) === asOf.slice(0, 10) ? heure(iso) : `${jour(iso)}, ${heure(iso)}`;
}

function Mesure({ label, valeur, detail, title }: { label: string; valeur: string; detail?: string; title?: string }) {
  return (
    <div title={title} className={title ? "cursor-help" : undefined}>
      <dt className="text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className="text-[13px] font-semibold tabular-nums">
        {valeur}
        {detail && <span className="ml-1 font-normal text-muted-foreground">{detail}</span>}
      </dd>
    </div>
  );
}

function Envoi({ e, asOf }: { e: EnvoiEnCours; asOf: string }) {
  const cible = cibleEnvoi(e);
  const reste = restants(e);
  const rythme = rythmeParHeure(e);
  const fin = finEstimee(e, asOf);
  const t = taux(e);
  const nonMesure = raisonNonMesure(e);
  const largeur = (n: number) => `${cible > 0 ? Math.min(100, (n / cible) * 100) : 0}%`;
  const ecartes = e.failed + e.skipped;
  // ⛔ LA QUESTION D'ALIX (« je sais pas si ça envoie vraiment ») : rien parti depuis 15 min alors qu'il
  // en reste, c'est CE qu'il faut voir en premier — une barre immobile ne le dit pas.
  const immobile = e.sentLast15m === 0 && reste > 0;

  return (
    <div className="rounded-[10px] border border-border p-3.5 [&+&]:mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/campaigns/${e.campaignId}`} className="font-semibold hover:underline">
          {e.name || "Untitled campaign"}
        </Link>
        <Pill tone={e.recurring ? "violet" : "blue"}>
          {e.recurring ? `Edition ${e.seq !== null ? `#${e.seq}` : ""} · ${jour(e.localDate ?? e.scheduledAt)}` : "One-shot"}
        </Pill>
      </div>

      <div className="mt-2.5 flex items-baseline justify-between gap-3 text-[13px]">
        <span>
          <strong className="tabular-nums">{nombre(e.sent)}</strong> of <span className="tabular-nums">{nombre(cible)}</span> sent
        </span>
        <span className="tabular-nums text-muted-foreground">{pct(cible > 0 ? e.sent / cible : null)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${e.name}: ${nombre(e.sent)} of ${nombre(cible)} sent`}
        aria-valuemin={0}
        aria-valuemax={cible}
        aria-valuenow={e.sent}
        className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-accent"
      >
        <div className="h-full bg-[#1f9d57]" style={{ width: largeur(e.sent) }} />
        <div className="h-full bg-[#c0334a]" style={{ width: largeur(ecartes) }} />
      </div>

      {immobile && (
        <p className="mt-2.5 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
          {e.firstSentAt
            ? `Nothing sent in the last 15 minutes (last email ${quand(e.lastSentAt, asOf)}) while ${nombre(reste)} are still waiting — the send may be held by the email provider or paused.`
            : `Not started yet — scheduled for ${quand(e.scheduledAt, asOf)}.`}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
        <Mesure
          label="Waiting"
          valeur={nombre(reste)}
          title={e.inFlight > 0 ? `${nombre(e.inFlight)} being handed to the email provider right now.` : undefined}
        />
        <Mesure
          label="Failed"
          valeur={nombre(ecartes)}
          title={e.skipped > 0 ? `${nombre(e.failed)} refused by the provider, ${nombre(e.skipped)} skipped by the send gate.` : undefined}
        />
        <Mesure label="Pace" valeur={rythme > 0 ? `≈ ${nombre(rythme)}/h` : "—"} detail="last 15 min" />
        <Mesure
          label="Finishes"
          valeur={fin ? `≈ ${quand(fin, asOf)}` : "—"}
          detail={fin ? `in ${duree(Date.parse(fin) - Date.parse(asOf))}` : undefined}
          title={fin ? "At the pace of the last 15 minutes." : "No estimate: nothing was sent in the last 15 minutes."}
        />
        <Mesure label="Delivered" valeur={nombre(e.delivered)} detail={t.deliveryRate === null ? undefined : pct(t.deliveryRate)} />
        <Mesure label="Bounce" valeur={nombre(e.bounced)} detail={t.bounceRate === null ? undefined : pct(t.bounceRate)} />
        <Mesure label="Spam" valeur={nombre(e.complained)} detail={t.spamRate === null ? undefined : pct(t.spamRate)} />
        <Mesure
          label="Open · Click"
          valeur={nonMesure ? "—" : `${nombre(e.opened)} · ${nombre(e.clicked)}`}
          detail={nonMesure ? undefined : `${pct(t.openRate)} · ${pct(t.ctr)}`}
          title={nonMesure ?? "Open rate and CTR count only delivered recipients who allow tracking."}
        />
      </dl>

      <p className="mt-3 text-[12px] text-muted-foreground">
        {e.firstSentAt ? `Started ${quand(e.firstSentAt, asOf)} · last email ${quand(e.lastSentAt, asOf)}` : `Scheduled for ${quand(e.scheduledAt, asOf)}`}
        {e.nextAttemptAt && Date.parse(e.nextAttemptAt) > Date.parse(asOf) && ` · next batch ${quand(e.nextAttemptAt, asOf)}`}
      </p>
    </div>
  );
}

/**
 * « Sending now » (0096) — au-dessus du tableau d'Analytics, les envois qui partent EN CE MOMENT : le
 * tableau, lui, ne montre une campagne qu'une fois son dernier mail parti (`campaign.sent_at`).
 *
 * Rien en cours = rien rendu (ni carte vide, ni rechargement). Une lecture ratée le DIT, en une ligne.
 */
export function SendingNow({ lu }: { lu: EnvoisEnCours }) {
  if (!lu.known) {
    return (
      <p className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
        Sends in progress could not be read: {lu.reason}.
      </p>
    );
  }
  if (lu.sending.length === 0) return null;
  const n = lu.sending.length;
  return (
    <Card className="mb-4">
      <CardHead
        title="Sending now"
        sub={`${n} send${n === 1 ? "" : "s"} in progress · as of ${heure(lu.asOf)} · this page refreshes every minute. A campaign joins the list below once its last email is sent.`}
        right={<Pill tone="green" dot>Live</Pill>}
      />
      {lu.sending.map((e) => (
        <Envoi key={`${e.campaignId}-${e.occurrenceId ?? "unique"}`} e={e} asOf={lu.asOf} />
      ))}
      <AutoReload seconds={RECHARGEMENT_S} />
    </Card>
  );
}
