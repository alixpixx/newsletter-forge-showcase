import {
  AlertTriangle,
  ArrowRight,
  Check,
  Inbox,
  MailCheck,
  MailQuestion,
  ShieldCheck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Pill, type Tone } from "@/components/ui";
import { cn } from "@/lib/utils";

/*
 * Schémas de la page `/docs` — des écrans et des parcours REDESSINÉS, jamais des captures.
 *
 * ⛔ Aucune donnée réelle : ni adresse, ni marque, ni chiffre d'une base. Les exemples sont inventés
 * et reconnaissables comme tels.
 * ⛔ Chaque libellé repris d'un écran (« Not queued », « Start series », « Save cadence », les sept
 * statuts d'édition…) a été relu dans son composant le 21/09/2026 — et ceux des séries le 22/09/2026,
 * quand « Turn on / Turn off » est devenu « Start series / Stop series ». Un libellé renommé à
 * l'écran doit l'être ici aussi, sinon la documentation montre un bouton qui n'existe plus.
 * Les teintes de statut sont celles de `statusTone` (campagne) et de `occurrence-list.tsx` (édition).
 */

/** Cadre commun : une carte en retrait, légendée, qui défile seule si elle déborde. */
function Figure({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <figure className="my-4 rounded-[12px] border border-border bg-accent/40 p-4">
      <div className="overflow-x-auto">{children}</div>
      <figcaption className="mt-3 text-[11.5px] leading-snug text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

/** Flèche de flux : vers le bas sur mobile, vers la droite dès que la ligne tient. */
function FlowArrow() {
  return (
    <ArrowRight
      aria-hidden="true"
      className="h-4 w-4 shrink-0 rotate-90 self-center text-muted-foreground md:rotate-0"
      strokeWidth={2}
    />
  );
}

function Step({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-[10px] border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold">
        <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={1.9} />
        {title}
      </div>
      <p className="text-[11.5px] leading-snug text-muted-foreground">{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 1. Le chemin d'une adresse, de l'inscription à la boîte de réception
 * ------------------------------------------------------------------ */

export function EmailJourney() {
  return (
    <Figure caption="Nobody receives a campaign before clicking the confirmation link, and every email is checked again at the moment it leaves.">
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
        <Step icon={UserPlus} title="Signs up">
          A signup form, an optinforge creative, or Add / Import CSV on Subscribers.
        </Step>
        <FlowArrow />
        <Step icon={MailQuestion} title="Pending">
          Receives the Confirmation email. No campaign reaches a pending address.
        </Step>
        <FlowArrow />
        <Step icon={MailCheck} title="Confirmed">
          Clicked the link. Receives the Welcome email and becomes sendable.
        </Step>
        <FlowArrow />
        <Step icon={Users} title="Targeted">
          A campaign names a segment and a purpose. The rule is stored, never a list.
        </Step>
        <FlowArrow />
        <Step icon={ShieldCheck} title="Send gate">
          Consent, suppression list and sending allowlist, checked again for each email.
        </Step>
        <FlowArrow />
        <Step icon={Inbox} title="Delivered">
          Handed to Mailgun. Opens and clicks are not measured.
        </Step>
      </div>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * 2. L'assistant de campagne, étape par étape
 * ------------------------------------------------------------------ */

const WIZARD: { name: string; decides: string }[] = [
  { name: "Content", decides: "Name, template, subject and preheader. Only templates with a published version are offered." },
  { name: "Audience", decides: "Segment — or the whole brand — and the purpose. The count shown is the real figure." },
  { name: "Schedule", decides: "Send now, one date in the readers' timezone, or a weekly cadence." },
  {
    name: "Review",
    decides:
      "Checks, then one button. A one-off send locks subject, preheader and version. A series shows its first send and starts with Start series — each edition freezes its own content 90 minutes before it goes out.",
  },
];

export function WizardSteps() {
  return (
    <Figure caption="New campaign opens this four-step wizard. Closing it keeps the draft — it reopens where you stopped.">
      <ol className="flex flex-col gap-2 md:flex-row md:items-stretch">
        {WIZARD.map((s, i) => (
          <li key={s.name} className="contents">
            {i > 0 && <FlowArrow />}
            <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-[10px] border border-border bg-card px-3 py-2.5">
              <div className="flex items-center gap-2 text-[12.5px] font-semibold">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-bold text-brand-soft-foreground">
                  {i + 1}
                </span>
                {s.name}
              </div>
              <p className="text-[11.5px] leading-snug text-muted-foreground">{s.decides}</p>
            </div>
          </li>
        ))}
      </ol>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Une campagne unique dans le temps
 * ------------------------------------------------------------------ */

type Moment = { when: string; pill?: { tone: Tone; label: string }; text: string; warn?: boolean };

const ONE_OFF: Moment[] = [
  { when: "Any time before", pill: { tone: "grey", label: "Draft" }, text: "Being written. Nothing is frozen and nothing is queued." },
  {
    when: "You schedule",
    pill: { tone: "blue", label: "Scheduled" },
    text: "The content is frozen, the date is recorded and the recipient count is snapshotted. The queue is still empty.",
  },
  {
    when: "Send time",
    pill: { tone: "violet", label: "Sending" },
    text: "Within seconds, the send worker queues every recipient who passes the consent gate. Nothing is queued before the send time — Send now makes that time the moment you confirm.",
  },
  { when: "Right after", pill: { tone: "green", label: "Sent" }, text: "Emails leave in batches. The campaign closes once the queue is drained." },
  {
    when: "30 min after",
    text: "Still not one recipient in the queue? The campaign list shows “Not queued” in amber under the date.",
    warn: true,
  },
  {
    when: "3 hours after",
    pill: { tone: "amber", label: "Paused" },
    text: "Too late to send. The worker stops the campaign and writes why on its page. It never retries on its own.",
    warn: true,
  },
];

export function OneOffTimeline() {
  return (
    <Figure caption="The two amber rows are what a missed send looks like. A campaign never goes out hours late by surprise: past 3 hours, it is stopped instead.">
      {/* `ml-3` : les pastilles débordent à gauche de la ligne, et le cadre défile en `overflow-x-auto` —
          sans cette marge, il les rogne. */}
      <ol className="relative ml-3 flex flex-col gap-3 border-l border-border pl-5">
        {ONE_OFF.map((m) => (
          <li key={m.when} className="relative">
            <span
              aria-hidden="true"
              className={cn(
                "absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full border-2 border-card",
                m.warn ? "bg-amber-500" : "bg-brand",
              )}
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{m.when}</span>
              {m.pill && (
                <Pill tone={m.pill.tone} dot>
                  {m.pill.label}
                </Pill>
              )}
            </div>
            <p className={cn("mt-0.5 max-w-[70ch] text-[12.5px] leading-snug", m.warn ? "text-amber-800" : "text-foreground/85")}>
              {m.text}
            </p>
          </li>
        ))}
      </ol>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * 4. Une série : Running ou Stopped, et un seul geste pour la démarrer
 * ------------------------------------------------------------------ */

export function SeriesSwitch() {
  return (
    <Figure caption="A series only sends while it is Running. Start series is the last button of the New campaign wizard, and it is also on the campaign page. Closing the wizard without it keeps the series Stopped — nothing is sent. The count in the last button is an example.">
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
          <span className="w-fit rounded-md border border-border px-2 py-0.5 text-[11.5px] font-semibold">Cadence</span>
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            The rhythm is stored — “Every 2 weeks on Mon and Fri at 07:30”: Next in the wizard, or Save cadence on the
            campaign page.
          </p>
          <p className="text-[11.5px] italic text-muted-foreground">Stopped · no edition, no email</p>
        </div>
        <FlowArrow />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
          <span className="w-fit rounded-md bg-brand px-2 py-0.5 text-[11.5px] font-semibold text-brand-foreground">Start series</span>
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            The planner creates one edition per date for the next 21 days, and keeps adding dates as time moves. Each
            edition goes out on its own.
          </p>
          <p className="text-[11.5px] text-foreground/85">Running · next edition dated on the campaign page</p>
        </div>
        <FlowArrow />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
          <span className="w-fit rounded-md border border-border px-2 py-0.5 text-[11.5px] font-semibold">Stop series</span>
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            Stops planning AND cancels the editions already planned — the button then reads “Stop and cancel 3”.
            A cancelled date is never re-created, even after Resume series.
          </p>
          <p className="text-[11.5px] italic text-muted-foreground">Stopped · planned editions cancelled</p>
        </div>
      </div>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * 5. La vie d'une édition de série
 * ------------------------------------------------------------------ */

const EDITION_PATH: { status: string; tone: Tone; when: string; meaning: string }[] = [
  { status: "planned", tone: "grey", when: "Up to 21 days ahead", meaning: "Date reserved. Content is not frozen yet." },
  { status: "frozen", tone: "blue", when: "90 min before", meaning: "Content frozen with the articles of the day." },
  { status: "sending", tone: "blue", when: "Send time", meaning: "Recipients are in the send queue." },
  { status: "sent", tone: "green", when: "Once drained", meaning: "Delivered to the queue and closed." },
];

const EDITION_EXITS: { status: string; tone: Tone; meaning: string }[] = [
  { status: "held", tone: "amber", meaning: "Held on purpose — nothing went out. The campaign page says why." },
  { status: "cancelled", tone: "grey", meaning: "Cancelled by a human, or by stopping the series." },
  { status: "failed", tone: "red", meaning: "Finished without a single delivery." },
  { status: "missed", tone: "red", meaning: "Still planned after its time: it will never go out, and nothing catches it up." },
];

export function EditionLifecycle() {
  return (
    <Figure caption="Solid cards: the normal path. Dashed cards: the four ways an edition ends without being sent. “missed” is not stored — the screen shows it when a planned edition's time has passed.">
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
        {EDITION_PATH.map((e, i) => (
          <div key={e.status} className="contents">
            {i > 0 && <FlowArrow />}
            <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-[10px] border border-border bg-card px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <Pill tone={e.tone} dot>
                  {e.status}
                </Pill>
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{e.when}</span>
              </div>
              <p className="text-[11.5px] leading-snug text-muted-foreground">{e.meaning}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {EDITION_EXITS.map((e) => (
          <div key={e.status} className="flex flex-col gap-1 rounded-[10px] border border-dashed border-border bg-card/70 px-3 py-2">
            <Pill tone={e.tone} dot className="w-fit">
              {e.status}
            </Pill>
            <p className="text-[11.5px] leading-snug text-muted-foreground">{e.meaning}</p>
          </div>
        ))}
      </div>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * 6. Paliers d'engagement
 * ------------------------------------------------------------------ */

export function EngagementScale() {
  const bands: { tone: Tone; label: string; range: string; width: string }[] = [
    { tone: "green", label: "Active", range: "under 30 days", width: "md:w-[30%]" },
    { tone: "amber", label: "Dormant", range: "30 to 90 days", width: "md:w-[40%]" },
    { tone: "grey", label: "Lapsed", range: "90 days and more", width: "md:w-[30%]" },
  ];
  return (
    <Figure caption="Days since the last recorded open or click — or, when none was ever recorded, since the last email delivered. Fewer than 3 editions delivered always counts as Active: too early to judge.">
      <div className="flex flex-col gap-1.5 md:flex-row">
        {bands.map((b) => (
          <div key={b.label} className={cn("flex flex-col gap-1 rounded-[10px] border border-border bg-card px-3 py-2.5", b.width)}>
            <Pill tone={b.tone} dot className="w-fit">
              {b.label}
            </Pill>
            <span className="text-[11.5px] text-muted-foreground">{b.range}</span>
          </div>
        ))}
      </div>
      {/* Graduations posées sur les frontières des bandes (30 % et 70 %), pas réparties au hasard. */}
      <div className="relative mt-2 hidden h-4 text-[10.5px] font-semibold tabular-nums text-muted-foreground md:block">
        <span className="absolute left-1">day 0</span>
        <span className="absolute left-[30%] -translate-x-1/2">30</span>
        <span className="absolute left-[70%] -translate-x-1/2">90</span>
      </div>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * 7. La porte d'envoi — ce qui écarte un e-mail, et sous quel nom
 * ------------------------------------------------------------------ */

const GATE: { check: string; reason: string }[] = [
  { check: "Subscription still active, purpose still granted", reason: "not active · purpose not granted" },
  { check: "Not on the suppression list", reason: "Address is on the suppression list" },
  { check: "Picked up within 7 days of being queued", reason: "Too old when the worker picked it up" },
  { check: "Brand has a sending domain", reason: "Brand has no sending domain" },
  { check: "Legal footer is complete", reason: "Legal footer incomplete" },
  { check: "Address or its domain is on the sending allowlist", reason: "Recipient not on the sending allowlist" },
];

export function SendGate() {
  return (
    <Figure caption="Solid: what must be true for an email to leave. Dashed: the reason Deliverability › Not sent shows when it is not. A set-aside email is never retried.">
      <ul className="flex flex-col gap-1.5">
        {GATE.map((g) => (
          <li key={g.check} className="grid gap-1.5 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <div className="flex items-center gap-2 rounded-[9px] border border-border bg-card px-3 py-2 text-[12px]">
              <Check className="h-3.5 w-3.5 shrink-0 text-[#1f9d57]" strokeWidth={2.4} />
              {g.check}
            </div>
            <span aria-hidden="true" className="hidden text-[11px] text-muted-foreground sm:block">
              otherwise
            </span>
            <div className="flex items-center gap-2 rounded-[9px] border border-dashed border-border bg-card/70 px-3 py-2 text-[12px] text-muted-foreground">
              <X className="h-3.5 w-3.5 shrink-0 text-[#c0334a]" strokeWidth={2.4} />
              {g.reason}
            </div>
          </li>
        ))}
      </ul>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * 8. « Ma campagne n'est pas partie » — où regarder
 * ------------------------------------------------------------------ */

const SYMPTOMS: { where: string; see: string; means: string; act: string }[] = [
  {
    where: "Campaign list",
    see: "Not queued",
    means: "The time passed and not one recipient entered the queue.",
    act: "The worker that fills the queue is not running, or not in live mode. Tell the tech team — the campaign itself is fine.",
  },
  {
    where: "Campaign page",
    see: "The send worker stopped this campaign.",
    means: "The worker refused it and wrote the reason in the banner.",
    act: "Fix the cause, then schedule it again. A stopped campaign is never retried.",
  },
  {
    where: "Campaign page",
    see: "The queue was filled, but nothing was sent.",
    means: "Recipients were queued, then set aside one by one.",
    act: "Open Deliverability › Not sent: each email carries its reason.",
  },
  {
    where: "Campaign list, series",
    see: "Stopped — nothing planned",
    means: "The cadence is saved but the series is not running: it was never started, or someone stopped it.",
    act: "Open the campaign and click Start series (Resume series if it already sent).",
  },
  {
    where: "Campaign list, series",
    see: "No edition created yet",
    means: "The series is running but no edition exists yet.",
    act: "The planner creates editions on its own pass. If none ever appears, it is not running — tell the tech team.",
  },
  {
    where: "Campaign list, series",
    see: "2 held",
    means: "The planner created these editions, then held them back.",
    act: "Open the campaign: each held edition carries its reason.",
  },
  {
    where: "Campaign list, series",
    see: "Overdue since …",
    means: "An edition was due and has still not been sent.",
    act: "The send worker may not be running. Tell the tech team.",
  },
  {
    where: "Campaign page, editions",
    see: "missed",
    means: "Its time passed while it was still planned, so its content was never frozen.",
    act: "It will not go out and nothing catches it up. The planner did not run in time — tell the tech team.",
  },
];

export function DidNotSend() {
  return (
    <Figure caption="Read the screen before guessing: every one of these messages names a fact read from the database, never a supposed cause.">
      <div className="grid gap-2 md:grid-cols-2">
        {SYMPTOMS.map((s) => (
          <div key={s.see} className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{s.where}</span>
            <span className="flex items-start gap-1.5 text-[12.5px] font-semibold text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              {s.see}
            </span>
            <p className="text-[11.5px] leading-snug text-muted-foreground">{s.means}</p>
            <p className="text-[11.5px] leading-snug text-foreground/85">
              <span className="font-semibold">Do: </span>
              {s.act}
            </p>
          </div>
        ))}
      </div>
    </Figure>
  );
}
