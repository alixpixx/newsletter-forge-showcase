import Link from "next/link";
import { AlertTriangle, Lightbulb } from "lucide-react";
import { PageHead, Pill, Td, Th, type Tone } from "@/components/ui";
import {
  DidNotSend,
  EditionLifecycle,
  EmailJourney,
  EngagementScale,
  OneOffTimeline,
  SendGate,
  SeriesSwitch,
  WizardSteps,
} from "@/components/docs/diagrams";

/**
 * `/docs` — le mode d'emploi de l'admin, pour l'équipe éditoriale (anglais, comme l'interface).
 *
 * ⛔ CHAQUE PHRASE DE COMPORTEMENT A ÉTÉ RELUE CONTRE LE CODE LE 21/09/2026, pas seulement les
 * nouveautés : une doc qui recopie une ancienne doc hérite de ses erreurs. Les libellés cités entre
 * guillemets sont ceux des composants (`campaign-actions.tsx`, `series-panel.tsx`,
 * `occurrence-list.tsx`, `campaign-table.tsx`, `deliverability/page.tsx`, `lifecycle-labels.ts`…) ;
 * les seuils viennent de leur source (`LARGE_SEND`, `HORIZON_DAYS`, `DEFAULT_LEAD_MINUTES`,
 * `DEFAULT_MAX_LATE_MINUTES`, `DEFAULT_MAX_PER_TARGET`, `OUTBOX_AGE_MAX_JOURS`, 0056).
 * Un libellé ou un seuil qui change là-bas doit changer ici.
 *
 * Page statique : aucune lecture de base, aucune donnée de marque — elle se lit pareil pour tous.
 */

const SECTIONS: { id: string; label: string }[] = [
  { id: "journey", label: "How an email gets out" },
  { id: "recent", label: "What changed" },
  { id: "subscribers", label: "Subscribers" },
  { id: "segments", label: "Segments & purposes" },
  { id: "templates", label: "Templates" },
  { id: "automations", label: "Automations" },
  { id: "one-off", label: "One-off campaigns" },
  { id: "series", label: "Series" },
  { id: "shortcodes", label: "Shortcodes" },
  { id: "deliverability", label: "Deliverability" },
  { id: "nothing-sent", label: "When nothing went out" },
];

/* ------------------------------------------------------------------ *
 * Primitives de mise en page, propres à cette page
 * ------------------------------------------------------------------ */

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-border pt-7">
      <h2 className="text-[17px] font-bold tracking-tight [text-wrap:balance]">{title}</h2>
      {lead && <p className="mt-1 max-w-[72ch] text-[13px] leading-relaxed text-muted-foreground">{lead}</p>}
      <div className="mt-3 flex flex-col gap-3 text-[13px] leading-relaxed text-foreground/85">{children}</div>
    </section>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-2 text-[14px] font-semibold text-foreground">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="max-w-[72ch]">{children}</p>;
}

/** Un libellé tel qu'il apparaît à l'écran. */
function Ui({ children }: { children: React.ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded-[5px] border border-border bg-card px-1.5 py-px text-[12px] font-semibold text-foreground">
      {children}
    </span>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-accent px-1 py-px font-mono text-[12px] text-foreground">{children}</code>;
}

function Callout({ kind, title, children }: { kind: "warn" | "tip"; title: string; children: React.ReactNode }) {
  const warn = kind === "warn";
  const Icon = warn ? AlertTriangle : Lightbulb;
  return (
    <div
      className={
        warn
          ? "flex max-w-[80ch] items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900"
          : "flex max-w-[80ch] items-start gap-2.5 rounded-[10px] border border-border bg-brand-soft/60 px-4 py-3 text-foreground"
      }
    >
      <Icon className={warn ? "mt-0.5 h-4 w-4 shrink-0" : "mt-0.5 h-4 w-4 shrink-0 text-brand"} strokeWidth={2} />
      <div className="text-[12.5px] leading-relaxed">
        <div className="font-semibold">{title}</div>
        {children}
      </div>
    </div>
  );
}

function DocTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-[12px] border border-border bg-card">
      <table className="w-full min-w-[560px] text-[12.5px]">
        <thead>
          <tr>
            {head.map((h) => (
              <Th key={h}>{h}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((c, j) => (
                <Td key={j} className={i === rows.length - 1 ? "border-b-0" : undefined}>
                  {c}
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Données des tableaux
 * ------------------------------------------------------------------ */

const RECENT: { date: string; items: string[] }[] = [
  {
    date: "25 Sep",
    items: [
      "Saving a campaign with a newer template version now also moves its upcoming editions, except those already being prepared. Publishing a template alone still changes no campaign.",
      "The same goes for the subject, the preheader and the segment: saving a new one updates the series' upcoming editions too, and the screen says how many — and which ones keep the previous value.",
      "A “latest articles” block whose newest article is more than 24 h old shows a warning in the builder preview.",
      "Saved segments show their current size, re-counted each time the page opens.",
      "Automations have Edit, Duplicate and Delete on every row; a draft opens straight into its form, and each step shows its template's subject with a link to edit it.",
    ],
  },
  {
    date: "18–21 Sep",
    items: [
      "The subject and preheader fields both offer shortcode chips, and the preheader you type is now the one that reaches the inbox.",
      "Campaigns no longer ask for a version: they always send the template's latest published version, frozen when you schedule.",
      "A one-off whose time has passed with nobody queued now shows “Not queued” in the list instead of a quiet “Scheduled”.",
      "Series say what state they are in: “Running” or “Stopped”, then “No edition created yet”, “2 held”, “Overdue since …”.",
      "A series ends the New campaign wizard with one button, Start series, after showing its first send date. Stop series, or removing its cadence, also cancels the editions already planned — and the screen says how many before you confirm.",
      "Add and Import CSV create subscribers as pending and send them a confirmation email.",
      "A selection of subscribers can be tagged, exported or erased. Subscription options show in the list and can be used in segment rules.",
    ],
  },
  {
    date: "16–17 Sep",
    items: [
      "Deliverability reads real sends: the queue, what left, what was set aside and why, and blocked addresses.",
      "The signup widget is served by the public app — Signup forms gives the snippet to paste.",
    ],
  },
];

const CAMPAIGN_STATUSES: { status: string; tone: Tone; means: string; can: string }[] = [
  { status: "Draft", tone: "grey", means: "Being written. Nothing is frozen.", can: "Edit everything, schedule, cancel, delete." },
  {
    status: "Scheduled",
    tone: "blue",
    means: "Content frozen and date recorded. The queue is still empty.",
    can: "Unschedule to change the date or the targeting. Cancel.",
  },
  { status: "Sending", tone: "violet", means: "Recipients are in the send queue.", can: "Nothing — it cannot be cancelled from the admin." },
  { status: "Sent", tone: "green", means: "The record of what subscribers received.", can: "Read only. It can be neither cancelled nor deleted." },
  {
    status: "Paused",
    tone: "amber",
    means: "Stopped by the send worker, or closed with nothing delivered. The reason is on the campaign page.",
    can: "Unlock to edit, fix the cause, schedule again. Cancel.",
  },
  { status: "Cancelled", tone: "amber", means: "Cancelled by a human. The planned date is kept as a record.", can: "Delete it — nothing was ever sent." },
];

const PURPOSES: [string, string][] = [
  ["Content — newsletter and editorial", "The regular newsletter and editorial sends."],
  ["Offers and promotions", "Commercial offers from the brand itself."],
  ["Events and invitations", "Invitations and event announcements."],
  ["Partner offers — always a separate opt-in", "Third-party offers. Never implied by any other consent."],
];

const SHORTCODES: { code: string; becomes: string; where: string }[] = [
  { code: "first_name", becomes: "The subscriber's first name — the only shortcode that varies per recipient.", where: "Subject · preheader" },
  { code: "asset_name", becomes: "The brand name.", where: "Subject · preheader" },
  { code: "edition_date", becomes: "The send day, written out.", where: "Subject · preheader" },
  { code: "edition_date_short", becomes: "The send day, short format.", where: "Subject · preheader" },
  { code: "weekday", becomes: "The day of the week.", where: "Subject · preheader" },
  { code: "campaign_name", becomes: "The campaign's name — an internal label readers would see.", where: "Subject" },
  { code: "first_article", becomes: "The headline of the edition's lead article.", where: "Series only" },
  { code: "article_count", becomes: "The number of articles in the edition.", where: "Series only" },
  { code: "edition_number", becomes: "The edition number, one more at each send (see “Start numbering at”).", where: "Series only" },
  { code: "ai_preheader", becomes: "A preview line written by the model from the articles actually sent.", where: "Preheader" },
];

const LIFECYCLE: { name: string; when: string; today: string; live: boolean }[] = [
  { name: "Confirmation", when: "Sent when someone signs up, to confirm their address.", today: "Sent", live: true },
  { name: "Welcome", when: "Sent once the address is confirmed.", today: "Sent", live: true },
  {
    name: "Unsubscribe receipt",
    when: "Sent after someone unsubscribes on our pages (the unsubscribe page or the preferences page) — once, and not after a Gmail/Yahoo one-click unsubscribe, which confirms on its own.",
    today: "Sent",
    live: true,
  },
  {
    name: "Re-engagement",
    when: "For readers who stopped opening, before we stop writing.",
    today: "Not sent today: re-engagement sending is switched off on the server.",
    live: false,
  },
];

const NOT_SENT: [string, string][] = [
  ["Recipient not on the sending allowlist", "Expected while the allowlist is on: only listed addresses and domains receive email. Ask the tech team to add one."],
  ["Address is on the suppression list", "Bounced, complained, unsubscribed or erased. Nothing to fix — this address is not emailed again."],
  ["not active · purpose not granted", "The subscriber left, or never granted this campaign's purpose, between queueing and sending."],
  ["Too old when the worker picked it up", "The email waited more than 7 days in the queue. It is dropped rather than sent that late."],
  ["Brand has no sending domain", "The brand is not set up to send yet. Tech team."],
  ["Legal footer incomplete · Legal footer details missing", "Complete the brand's legal footer (Templates › Legal footers). No email leaves without it."],
  ["Subject missing", "The campaign or its template has no subject."],
  ["No published email to send", "The template has no published version. Publish one from the builder."],
  ["Confirmation link had expired · Subscription was already confirmed", "A confirmation email that no longer had anything to confirm."],
];

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function DocsPage() {
  return (
    <div className="animate-fade-up">
      <PageHead
        title="Documentation"
        desc="How newsletter-forge turns a signup into a delivered email, screen by screen. Every label in quotes is the one you see in the admin."
      />

      <nav aria-label="On this page" className="mb-8 flex flex-wrap gap-1.5">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-full border border-border bg-card px-3 py-1 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <div className="flex flex-col gap-9 pb-16">
        {/* ---------------------------------------------------------------- */}
        <Section
          id="journey"
          title="How an email gets out"
          lead="Three things are kept apart: who may receive (subscribers and their consent), what is sent (a published template version) and when (a campaign's date or cadence). An email leaves only when all three line up."
        >
          <EmailJourney />
          <P>
            Almost every screen is scoped to the brand picked at the top of the sidebar: subscribers, segments,
            templates, media and campaigns of one brand are never visible from another. <Ui>Signup forms</Ui> is the
            exception — it lists every brand you have access to. An administrator sets that access in{" "}
            <Ui>Users &amp; access</Ui>. Two independent switches cover what comes later: <Ui>All brands</Ui> adds
            every brand created afterwards, and <Ui>All templates</Ui> adds every template created afterwards — but
            only inside the brands that account already sees, never another brand&rsquo;s.
          </P>
          <P>
            Two background jobs do the sending, and neither is a button in the admin: the <b>planner</b> creates the
            editions of each series, and the <b>send worker</b> queues recipients and hands emails to Mailgun. When
            a screen says one of them “may not be running”, the fix is on the server side — tell the tech team.
          </P>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="recent" title="What changed recently">
          <ol className="flex max-w-[80ch] flex-col gap-4 border-l border-border pl-5">
            {RECENT.map((r) => (
              <li key={r.date} className="relative">
                <span aria-hidden="true" className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-brand" />
                <div className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{r.date}</div>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {r.items.map((it) => (
                    <li key={it}>{it}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          id="subscribers"
          title="Subscribers and double opt-in"
          lead="Every address confirms itself. The admin never records consent on someone's behalf."
        >
          <P>
            <Ui>Add</Ui> and <Ui>Import CSV</Ui> on <Link href="/subscribers" className="font-semibold underline underline-offset-2">Subscribers</Link>{" "}
            create each address as <b>pending</b> and send it a confirmation email. It joins no campaign until the
            person clicks that link. Running the same file twice is safe: addresses already accepted are recognised
            and are not emailed twice.
          </P>
          <Callout kind="warn" title="An import sends real emails">
            Each address in the file gets one email asking it to confirm, and that cannot be undone. Import only
            addresses that asked to hear from the brand.
          </Callout>

          <H3>Engagement tiers</H3>
          <P>
            The filters <Ui>All</Ui> <Ui>Active</Ui> <Ui>Dormant</Ui> <Ui>Lapsed</Ui> sort subscribers by how recently
            they engaged.
          </P>
          <EngagementScale />
          <Callout kind="tip" title="Read tiers as a hint">
            Opens and clicks are only recorded for subscribers who accepted tracking, and almost every subscription
            declines it. For everyone else the tier measures the time since the last email delivered — not interest.
          </Callout>

          <H3>Acquisition sources</H3>
          <P>
            <Link href="/subscribers/capture" className="font-semibold underline underline-offset-2">Acquisition sources</Link>{" "}
            shows where subscribers come from, in three levels: the acquisition campaign, the creative they filled
            in, and the interests they ticked on it. Signups arrive from optinforge on their own — there is nothing
            to create. When a brand shows none, one of three switches is open:
          </P>
          <ol className="ml-5 max-w-[72ch] list-decimal space-y-1">
            <li>
              <Code>NF_INGEST_SECRET</Code> is set on the public app with the same value as in optinforge. Without it
              every signup is refused, silently.
            </li>
            <li>The source site is bridged to newsletter-forge in optinforge.</li>
            <li>The newsletter box is ticked on the creative itself.</li>
          </ol>

          <H3>Working on a selection</H3>
          <P>
            Tick subscribers to <Ui>Tag</Ui>, <Ui>Export</Ui> or <Ui>Erase</Ui> them. The <Ui>Tags &amp; interests</Ui>{" "}
            column shows the subscription options each person ticked when signing up.
          </P>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          id="segments"
          title="Segments and purposes"
          lead="A segment stores a rule, never a list: who receives a campaign is decided minutes before it leaves, not when it is written."
        >
          <P>
            The rule is evaluated when the campaign is queued, so a subscriber who confirms on Monday is in Tuesday's
            send, and one who unsubscribes is out. Rules can use tags, subscription options and the acquisition
            source (campaign, creative, interest). A campaign with no segment targets the whole brand; the count
            shown in the wizard is the real figure, not an estimate.
          </P>
          <P>
            Every campaign also names a <b>purpose</b>. The send gate rejects every recipient who did not grant it:
          </P>
          <DocTable
            head={["Purpose", "Used for"]}
            rows={PURPOSES.map(([label, use]) => [<span key="l" className="font-semibold">{label}</span>, use])}
          />
          <P>
            Consent is checked twice: when recipients are queued, and again for each email at the moment it leaves.
            The recipient count shown at scheduling is a snapshot — unsubscribes and erasures before the send date
            lower it.
          </P>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          id="templates"
          title="Templates, versions and the builder"
          lead="A template has one draft and any number of published versions. Recipients only ever receive a published version."
        >
          <P>
            Every change in the <Link href="/builder" className="font-semibold underline underline-offset-2">Email builder</Link>{" "}
            is saved to the draft. <Ui>Publish</Ui> compiles the draft with MJML and freezes an immutable version;
            the draft stays editable and earlier versions stay restorable. Publishing runs the content checks —
            links, alt text, contrast, legal footer — and lists blocking issues and warnings. Campaigns do not repeat
            them.
          </P>
          <P>
            <Ui>Send test</Ui> saves and compiles the draft, then queues it as a test email. Shortcodes are filled
            with their fallback values and the legal footer is injected exactly as in a real send.
          </P>
          <Callout kind="tip" title="Keep an email under 100 KB">
            Gmail clips emails above about 100 KB of HTML and hides the rest behind a link — often the legal footer.
            The campaign review shows the published version's size against that limit.
          </Callout>

          <H3>Automatic emails</H3>
          <P>
            Four emails are tied to a subscription rather than to a campaign. Each brand customises them in{" "}
            <Link href="/automations" className="font-semibold underline underline-offset-2">Automations › System</Link>.
          </P>
          <DocTable
            head={["Email", "When", "Today"]}
            rows={LIFECYCLE.map((l) => [
              <span key="n" className="font-semibold">{l.name}</span>,
              l.when,
              <Pill key="t" tone={l.live ? "green" : "grey"}>
                {l.today}
              </Pill>,
            ])}
          />
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Plan AUTO-EDIT (25/09/2026). Libellés : `views.tsx`, `row-actions.tsx`, `edit-button.tsx`,
            `automation-form.tsx`, `status-controls.tsx` ; règles : `lib/automation-edit.ts`. */}
        <Section
          id="automations"
          title="Automations: create, edit, duplicate, delete"
          lead="An automation sends a template on its own when something happens to a subscription — a signup left unconfirmed, a reader gone quiet, an anniversary. Everything is done from Automations › System."
        >
          <P>
            <b>Create.</b> <Ui>New automation</Ui> at the top of the System card, or <Ui>Set up</Ui> on a trigger&rsquo;s
            row — <Ui>Add another</Ui> once that trigger already has one. The form opens on that trigger. It is saved
            as a <b>draft</b>, which sends nothing.
          </P>
          <P>
            <b>Edit.</b> Every automation in the list has <Ui>Edit</Ui>. A draft&rsquo;s page is its form: change it,
            then <Ui>Save draft</Ui> — the page stays open and says “Saved”. Steps are kept in order of their delay on
            their own; two steps with the same delay are refused, with both step numbers named. The send window&rsquo;s
            time zone is picked from a list, or typed under <Ui>Other…</Ui>. An automation in simulation, live or
            paused is not edited in place: <Ui>Edit</Ui> asks <Ui>Stop and edit</Ui>, which moves it back to draft —
            nothing is sent while you edit, and it must be simulated again before going live.
          </P>
          <P>
            <b>Duplicate</b> makes a copy as a new draft and opens it — the quickest way to a second automation on the
            same trigger with another delay, filter or template. <b>Delete</b> is offered on a draft or a paused
            automation only, and is refused once the automation has selected anyone, even in a simulation: its
            history is kept. The screen then says why.
          </P>
          <Callout kind="tip" title="The subject is changed in the template, not in the automation">
            Each step sends one published version of a template, frozen so that what you simulated is what goes out.
            The step shows that version&rsquo;s subject; <Ui>Edit template</Ui> opens it in the builder in a new tab.
            Publish there, come back, and the step offers <Ui>Use v…</Ui> for the new version (<Ui>Refresh
            templates</Ui> if it is not listed yet) — then <Ui>Save draft</Ui>.
          </Callout>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          id="one-off"
          title="A one-off campaign"
          lead="A campaign points a published template version at a segment. It goes out once on a date you pick — or repeats, see Series."
        >
          <WizardSteps />
          <P>
            A campaign leaves at its scheduled date — or right away with <Ui>Send now</Ui>: it starts leaving
            within seconds of your confirmation, in batches, since the send rate is capped.
            Scheduling freezes the subject, the preheader and the version — republishing the
            template afterwards does not change what this campaign sends. Until then, the campaign keeps
            the version it was saved with: a later publish is picked up only when you open the campaign and
            save it again, and a series' upcoming editions move with it.
          </P>
          <P>
            Times are entered in a timezone you choose, and <Ui>Where this brand publishes</Ui> is offered first. Pick
            the readers' timezone, not yours: a campaign prepared in one country for readers in another would
            otherwise land at the wrong hour.
          </P>
          <Callout kind="warn" title="Large sends ask for a typed confirmation">
            Above 5,000 recipients, scheduling asks you to type <b>SCHEDULE</b>.
          </Callout>
          <OneOffTimeline />
          <DocTable
            head={["Status", "What it means", "What you can do"]}
            rows={CAMPAIGN_STATUSES.map((s) => [
              <Pill key="p" tone={s.tone} dot>
                {s.status}
              </Pill>,
              s.means,
              s.can,
            ])}
          />
          <P>
            The send worker stops a campaign — status <b>Paused</b> — when it is more than 3 hours late, when a single
            pass would queue more than 20,000 recipients, or when its segment rule cannot be evaluated safely. A
            campaign where every email was set aside also ends Paused. <Ui>Cancel campaign</Ui> keeps the record;{" "}
            <Ui>Delete</Ui> removes only a campaign that never sent — or a series, whose sent editions are deleted with
            it: the confirmation says how many.
          </P>
          <H3>Archive</H3>
          <P>
            <Ui>Archive</Ui> — on each row of the list and on the campaign page — moves a campaign to the{" "}
            <Ui>Archived</Ui> tab and pauses it. A running series stops and its planned editions are cancelled (the
            confirmation lists their dates); a scheduled send comes off the schedule; anything else just changes tab.
            A campaign that is sending cannot be archived. In the Archived tab, <Ui>Reactivate</Ui> starts again what
            was running — the series from its next date, the send on its date if that date is still ahead — with the
            same checks as starting or scheduling it; <Ui>Restore</Ui> brings back a campaign that was not running.
            A cancelled edition is never re-created, and a segment used by an archived campaign still cannot be
            deleted.
          </P>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          id="series"
          title="Series: a campaign that repeats"
          lead="A series sends the same template again and again — every Monday and Friday at 10:00, for example — with the articles of each day."
        >
          <P>
            In <Ui>New campaign</Ui>, pick <Ui>Repeating series</Ui> at the Schedule step — or, on a campaign page,
            click <Ui>Make it repeating</Ui>. The cadence says every N weeks, on which days, at what time, in which
            timezone — for example “Every 2 weeks on Mon and Fri at 07:30”. <Ui>Start numbering at</Ui> sets the first
            edition number.
          </P>
          <P>
            A series is <b>Running</b> or <b>Stopped</b>, and only a running series sends. The wizard's Review shows the
            first send, the cadence and the audience, then <Ui>Start series</Ui> makes it run. Close the wizard instead
            and the series stays Stopped: start it later from its campaign page, where the button reads{" "}
            <Ui>Resume series</Ui> once editions have gone out. The campaign page also shows the next edition's date.
          </P>
          <SeriesSwitch />
          <P>
            A series is never locked: each edition freezes its own content at the <Ui>Content cut-off</Ui>, 90 minutes
            before its send by default. Saving a new subject, preheader, segment or template version updates every
            edition already planned, except those whose cut-off is less than 10 minutes away or that are held; edits
            made after an edition's cut-off go to the following one. The planner keeps the next 21 days planned; if the
            series panel says “no edition falls in the next 21 days”, check the cadence.
          </P>
          <EditionLifecycle />
          <P>
            <Ui>Remove cadence</Ui> turns the campaign back into a one-off send and cancels the planned editions too.
            A cancelled date is never re-created, even if the series is started again later.
          </P>

          <H3>Mix in the latest articles</H3>
          <P>
            Half the article cards keep the most viewed articles of the period, half take the freshest ones.
            Analytics stops two days short of today, so the newest articles have no view counts yet — this is what
            puts them back in the letter. It only affects article blocks ranked by <Ui>Most viewed</Ui>, and no
            longer changes anything once the content is frozen.
          </P>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          id="shortcodes"
          title="Subject and preheader shortcodes"
          lead="Click a chip under the subject or preheader field to insert a shortcode at the cursor. The preview under the field shows the result — with sample values until the real edition fills them in."
        >
          <DocTable
            head={["Shortcode", "Becomes", "Offered in"]}
            rows={SHORTCODES.map((s) => [
              <Code key="c">{`{{${s.code}}}`}</Code>,
              s.becomes,
              <span key="w" className="whitespace-nowrap text-muted-foreground">
                {s.where}
              </span>,
            ])}
          />
          <Callout kind="warn" title="Red text under the field means a hole in the sent email">
            An unknown shortcode is silently removed from what is sent. A series-only shortcode on a one-off
            campaign arrives blank. The field says so in red — fix it before scheduling. Shortcodes also expand: the
            sent subject is longer than what you typed.
          </Callout>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          id="deliverability"
          title="Deliverability"
          lead="Full-access accounts only. What left the queue for this brand and what the mail provider reported back — every number read from the database, nothing estimated."
        >
          <P>
            The screen has <Ui>Queue right now</Ui> (emails waiting for the send worker), <Ui>By email</Ui> (what was
            sent in the window), <Ui>Not sent</Ui> (what was set aside, and why), <Ui>Suppression list</Ui> (addresses
            that will not be emailed again), the spam complaint rate, and <Ui>Re-engagement outcomes</Ui>.
          </P>
          <SendGate />
          <P>
            In live mode the worker sends only to addresses — or whole domains — on its sending allowlist. This
            applies to every email, tests and confirmations included. The allowlist is set on the server.
          </P>
          <DocTable
            head={["Reason under Not sent", "What it means"]}
            rows={NOT_SENT.map(([label, means]) => [<span key="l" className="font-semibold">{label}</span>, means])}
          />
          <Callout kind="warn" title="Spam complaints above 0.3%">
            Pause sends for this brand and look at who received what. Under 334 deliveries, a single complaint is
            already above the limit — a clean rate there proves little.
          </Callout>
          <P>
            Opens and clicks are not measured: Mailgun adds no pixel and rewrites no link without tracking consent.
            SPF, DKIM and DMARC are not checked here either — check them in the Mailgun dashboard.
          </P>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          id="nothing-sent"
          title="When nothing went out"
          lead="Start from the message on the screen. Each one below names a fact, and points to where the answer is."
        >
          <DidNotSend />
        </Section>
      </div>
    </div>
  );
}
