import Link from "next/link";
import { AlertTriangle, ArrowRight, ExternalLink, Lock, Plus } from "lucide-react";
import { TRIGGERS, type AutomationStatus, type TriggerSpec } from "@nf/automations";
import { Card, CardHead, Pill, Td, Th } from "@/components/ui";
import { fmtInt, purposeLabel } from "@/components/campaigns/shared";
import {
  STATUS_LABEL,
  STATUS_MEANING,
  STATUS_TONE,
  SYSTEM_ROWS,
  adresseSysteme,
  canTurnOff,
  formatDelay,
  isCreatableTrigger,
  policyText,
  rangerParDeclencheur,
  systemRowDoes,
  systemRowName,
  triggerLabel,
  type SystemRow,
} from "@/lib/automations";
import { AutomationActions } from "./row-actions";

/*
 * Vues des écrans Automations — PRÉSENTATION SEULE, aucun accès base, aucun hook.
 *
 * ⚠️ Pourquoi un module à part : les pages lisent la base et passent ici des valeurs DÉJÀ lues (et,
 * pour les adresses, déjà masquées). Un banc peut donc rendre ces vues avec des exemples sans
 * serveur ni base — jamais une page ou une route de démonstration dans l'application.
 *
 * ⛔ UN COMPTE NON LU N'EST PAS ZÉRO : chaque nombre est `number | null`, et `null` s'écrit « — »
 * avec la raison au survol ou à côté, jamais « 0 ».
 */

/* ------------------------------------------------------------------ *
 * Types d'affichage (structurels : aucun import de `lib/data`)
 * ------------------------------------------------------------------ */

export type ListeLue<T> =
  | { state: "ok"; value: T }
  | { state: "not-installed"; detail: string }
  | { state: "error"; message: string }
  | { state: "no-db" };

export interface CustomRow {
  id: string;
  name: string;
  trigger: string;
  status: AutomationStatus;
  lastRunAt: string | null;
  sent7d: number | null;
  simulated7d: number | null;
}

export interface StepView {
  n: number;
  delayHours: number | null;
  /** « Welcome v3 » ; `null` = modèle non ouvrable par la personne, ou version introuvable. */
  template: string | null;
  templateNote: string | null;
  /** Le sujet de la version épinglée (il se change dans le modèle, pas ici) ; `null` si non ouvrable. */
  subject?: string | null;
  /** Pour « Edit template » (builder, nouvel onglet) ; `null` si la personne ne peut pas l'ouvrir. */
  templateId?: string | null;
}

export interface ProbeView {
  step: number;
  eligible: number | null;
  allowed: number | null;
  sample: string[];
  reason: string | null;
}

export interface LogRow {
  id: string;
  createdAt: string;
  who: string | null;
  step: number;
  periodKey: string;
  reason: string;
  outboxStatus: string | null;
  sentAt: string | null;
}

/** Un instant en UTC, dit comme tel : une page rendue sur le serveur n'a pas le fuseau du lecteur. */
export function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

export function StatusPill({ status }: { status: AutomationStatus }) {
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {STATUS_LABEL[status]}
    </Pill>
  );
}

function Bandeau({ tone, children }: { tone: "amber" | "red" | "grey"; children: React.ReactNode }) {
  const cls =
    tone === "red"
      ? "border-red-200 bg-red-50 text-red-800"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-border bg-accent/40 text-muted-foreground";
  return (
    <div className={`flex items-start gap-2.5 rounded-[10px] border px-4 py-3 text-[13px] ${cls}`}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export const primaryLinkClass =
  "inline-flex items-center gap-2 rounded-[9px] bg-brand px-3.5 py-2 text-[13px] font-medium text-brand-foreground shadow-[0_1px_3px_rgba(255,54,141,0.35)] transition-colors hover:bg-[#ec2079]";

/* ------------------------------------------------------------------ *
 * Liste /automations
 * ------------------------------------------------------------------ */

/** L'état des interrupteurs d'e-mails, tel que lu (`known: false` = non lu : l'écran le dit). */
export interface LifecycleSwitches {
  known: boolean;
  value: Record<"welcome" | "unsubscribe_ack", boolean>;
}

const SORTE: Record<SystemRow["type"], string> = { lifecycle: "Email", engine: "Automation", rule: "Rule" };

/**
 * La carte « System » (24/09/2026, feature 3) : les 15 lignes du tableau d'Alix, dans son ordre — les
 * e-mails de cycle de vie (éditables), les déclencheurs du moteur (avec LEURS automations, ou « Set
 * up »), et les règles toujours actives. ⛔ Une automation dont le déclencheur n'a pas de ligne est
 * affichée à part (« Other »), jamais cachée. ⛔ Lecture ratée ⇒ l'aveu, jamais un zéro ni un « Off ».
 */
export function SystemCard({
  automations,
  lifecycle,
  brand,
}: {
  automations: ListeLue<CustomRow[]>;
  lifecycle: LifecycleSwitches;
  brand: string;
}) {
  const ok = automations.state === "ok";
  const { parDeclencheur, autres } = rangerParDeclencheur(ok ? automations.value : []);
  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-[18px] pt-4">
        <div>
          <h2 id="system" className="text-[14px] font-semibold">
            System
          </h2>
          <p className="mt-0.5 max-w-[80ch] text-[12.5px] text-muted-foreground">
            Everything that goes out or happens on its own for {brand}, in the order of a subscription&apos;s life. Emails
            are edited on their page. Automations start as drafts, run as simulations, and send only once a super admin
            switches them to live. Rules are always on.
          </p>
        </div>
        {ok && (
          <Link href="/automations/new" className={primaryLinkClass}>
            <Plus className="h-4 w-4" /> New automation
          </Link>
        )}
      </div>

      {!ok && (
        <div className="px-[18px] pt-3">
          {automations.state === "no-db" && (
            <Bandeau tone="amber">Database unavailable: the automations could not be read.</Bandeau>
          )}
          {automations.state === "not-installed" && (
            <Bandeau tone="grey">
              Automations are not installed on this database yet (migration 0082): nothing can be set up.
            </Bandeau>
          )}
          {automations.state === "error" && <Bandeau tone="red">The automations could not be read: {automations.message}</Bandeau>}
        </div>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              <Th className="w-[220px]">Automation</Th>
              <Th>What it does</Th>
              <Th className="hidden w-[300px] sm:table-cell">State</Th>
            </tr>
          </thead>
          <tbody>
            {/* ⚠️ Au téléphone, l'état passe SOUS la description : en troisième colonne il sortait de
                l'écran (vu en capture à 390 px) — et c'est la seule information actionnable. */}
            {SYSTEM_ROWS.map((r) => (
              <tr key={r.sheetRow} className="align-top">
                <Td>
                  <div className="font-medium">{systemRowName(r)}</div>
                  <div className="mt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    {SORTE[r.type]}
                  </div>
                </Td>
                <Td className="text-[12.5px] leading-relaxed text-foreground/80">
                  {systemRowDoes(r)}
                  {r.note && <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">{r.note}</p>}
                  <div className="mt-2 sm:hidden">
                    <EtatLigne r={r} ok={ok} liste={parDeclencheur.get(r.type === "engine" ? r.trigger : "") ?? []} lifecycle={lifecycle} />
                  </div>
                </Td>
                <Td className="hidden text-[12.5px] sm:table-cell">
                  <EtatLigne r={r} ok={ok} liste={parDeclencheur.get(r.type === "engine" ? r.trigger : "") ?? []} lifecycle={lifecycle} />
                </Td>
              </tr>
            ))}
            {autres.length > 0 && (
              <tr className="align-top">
                <Td>
                  <div className="font-medium">Other</div>
                  <div className="mt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    Automation
                  </div>
                </Td>
                <Td className="text-[12.5px] leading-relaxed text-foreground/80">
                  Automations whose trigger has no row above.
                  <div className="mt-2 sm:hidden">
                    <ListeAutomations liste={autres} />
                  </div>
                </Td>
                <Td className="hidden text-[12.5px] sm:table-cell">
                  <ListeAutomations liste={autres} />
                </Td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function EtatLigne({
  r,
  ok,
  liste,
  lifecycle,
}: {
  r: SystemRow;
  ok: boolean;
  liste: CustomRow[];
  lifecycle: LifecycleSwitches;
}) {
  const lien = "font-medium text-brand hover:underline";
  if (r.type === "lifecycle") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {!canTurnOff(r.kind) ? (
          <Pill tone="grey">
            <Lock className="h-3 w-3" /> Always on
          </Pill>
        ) : !lifecycle.known ? (
          <span className="text-amber-700">On/off could not be read</span>
        ) : lifecycle.value[r.kind] ? (
          <Pill tone="green" dot>
            On
          </Pill>
        ) : (
          <Pill tone="grey" dot>
            Off
          </Pill>
        )}
        <Link href={adresseSysteme(r.kind)} className={lien}>
          Edit
        </Link>
      </div>
    );
  }
  if (r.type === "rule") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="grey">
          <Lock className="h-3 w-3" /> Always on
        </Pill>
        {r.where.href ? (
          <Link href={r.where.href} className={lien}>
            {r.where.label}
          </Link>
        ) : (
          <span className="font-medium">{r.where.label}</span>
        )}
      </div>
    );
  }
  if (!ok) {
    return (
      <span className="text-amber-700" title="Could not be read right now">
        —
      </span>
    );
  }
  if (liste.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="grey">Not set up</Pill>
        <Link href={`/automations/new?trigger=${r.trigger}`} className={lien}>
          Set up
        </Link>
      </div>
    );
  }
  // ⭐ 25/09 (plan AUTO-EDIT) : un déclencheur qui a déjà une automation en accepte d'autres (autre délai,
  // autre filtre, autre modèle) — le lien reste, pré-réglé sur lui.
  return (
    <div className="flex flex-col gap-2">
      <ListeAutomations liste={liste} />
      {isCreatableTrigger(r.trigger) && (
        <Link href={`/automations/new?trigger=${r.trigger}`} className={`${lien} inline-flex w-fit items-center gap-1 text-[12px]`}>
          <Plus className="h-3.5 w-3.5" /> Add another
        </Link>
      )}
    </div>
  );
}

/**
 * Les automations d'une ligne : nom (lien), statut, envois réels et simulés sur 7 jours, et leurs
 * gestes — Edit, Duplicate, Delete (plan AUTO-EDIT, 25/09 : l'édition ne se cache plus derrière le nom).
 */
function ListeAutomations({ liste }: { liste: CustomRow[] }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {liste.map((a) => (
        <li key={a.id} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/automations/${a.id}`} className="font-medium hover:text-brand hover:underline">
              {a.name}
            </Link>
            <StatusPill status={a.status} />
          </div>
          <div className="text-[11.5px] tabular-nums text-muted-foreground">
            {triggerLabel(a.trigger)} · 7 days: <Compte n={a.sent7d} /> sent, <Compte n={a.simulated7d} /> simulated
          </div>
          <div className="-ml-1.5">
            <AutomationActions id={a.id} name={a.name} status={a.status} trigger={a.trigger} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Compte({ n }: { n: number | null }) {
  if (n === null) {
    return (
      <span className="text-amber-700" title="Could not be read right now">
        —
      </span>
    );
  }
  return <>{fmtInt(n)}</>;
}

/* ------------------------------------------------------------------ *
 * Page d'une automation
 * ------------------------------------------------------------------ */

export function TriggerCard({ trigger, purpose }: { trigger: string; purpose: string | null }) {
  const spec: TriggerSpec | undefined = (TRIGGERS as Record<string, TriggerSpec | undefined>)[trigger];
  return (
    <Card>
      <CardHead title="Trigger" sub={spec ? `Row ${spec.sheetRow} of the automation sheet` : undefined} />
      {spec ? (
        <>
          <p className="text-[13.5px] font-semibold">{spec.label}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/80">{spec.description}</p>
          <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">{policyText(spec)}</p>
          {spec.policy === "marketing" && (
            <p className="mt-2 text-[12.5px]">
              Purpose: <span className="font-medium">{purpose ? purposeLabel(purpose) : "none — cannot run"}</span>
            </p>
          )}
          {spec.liveBlockedReason && (
            <p className="mt-3 rounded-[9px] bg-amber-50 px-3 py-2 text-[12px] leading-snug text-amber-800">
              Cannot go live: {spec.liveBlockedReason}
            </p>
          )}
        </>
      ) : (
        <p className="text-[12.5px] text-red-700">Unknown trigger “{trigger}”: the engine skips this automation.</p>
      )}
    </Card>
  );
}

export function FiltersCard({
  optins,
  languages,
  interests,
  labels = [],
  settings,
}: {
  optins: string[];
  languages: string[];
  interests: string[];
  /** Labels d'automation (0095), par leur nom quand le registre le connaît. */
  labels?: string[];
  settings: { label: string; value: string }[];
}) {
  const aucun = optins.length === 0 && languages.length === 0 && interests.length === 0 && labels.length === 0;
  const ligne = (titre: string, xs: string[]) =>
    xs.length > 0 && (
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="w-[86px] shrink-0 text-[12px] text-muted-foreground">{titre}</span>
        {xs.map((x) => (
          <Pill key={x} tone="blue">
            {x}
          </Pill>
        ))}
      </div>
    );
  return (
    <Card>
      <CardHead title="Filters" sub="Who, among the subscriptions the trigger selects" />
      <div className="flex flex-col gap-2 text-[12.5px]">
        {aucun && <p className="text-muted-foreground">No filter: everyone in this brand that the trigger selects.</p>}
        {ligne("Opt-in", optins)}
        {ligne("Language", languages)}
        {ligne("Interests", interests)}
        {ligne("Label", labels)}
      </div>
      {settings.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          {settings.map((s) => (
            <p key={s.label} className="text-[12.5px]">
              <span className="text-muted-foreground">{s.label}:</span> <span className="font-medium">{s.value}</span>
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

export function StepsCard({ steps, sends }: { steps: StepView[]; sends: boolean }) {
  return (
    <Card className="p-0">
      <div className="px-[18px] pt-4">
        <CardHead
          title="Steps"
          sub={sends ? "Each delay counts from the trigger; step N waits for step N-1" : "This trigger sends nothing"}
        />
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr>
            <Th className="w-[70px]">Step</Th>
            <Th className="w-[160px]">After</Th>
            <Th>{sends ? "Template (published version)" : "Action"}</Th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.n}>
              <Td className="tabular-nums">{s.n}</Td>
              <Td className="tabular-nums">{s.delayHours === null ? "—" : formatDelay(s.delayHours)}</Td>
              <Td>
                {sends ? (s.template ?? <span className="text-muted-foreground">A template you cannot open</span>) : "Mark as sunsetted"}
                {sends && s.subject && (
                  <p className="mt-0.5 text-[12px] text-foreground/75">
                    <span className="text-muted-foreground">Subject:</span> {s.subject}
                  </p>
                )}
                {sends && s.templateId && (
                  <a
                    href={`/builder/${s.templateId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:underline"
                  >
                    Edit template <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {s.templateNote && <p className="mt-0.5 text-[11.5px] text-amber-700">{s.templateNote}</p>}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function GuardrailsCard({
  trigger,
  dailyCap,
  window,
}: {
  trigger: string;
  dailyCap: number;
  window: string;
}) {
  const spec: TriggerSpec | undefined = (TRIGGERS as Record<string, TriggerSpec | undefined>)[trigger];
  const fixes = [
    { t: "Daily cap", v: `${fmtInt(dailyCap)} per day (simulated and real are counted separately)` },
    { t: "Send window", v: `${window} — outside it, nothing is queued` },
    { t: "Allowlist", v: "When live, only addresses on the worker's allowlist receive it (set on the server, not shown here)" },
    { t: "Demo subscribers", v: "Never selected, for any trigger" },
    { t: "Policy", v: spec ? policyText(spec) : "—" },
  ];
  return (
    <Card>
      <CardHead title="Guardrails" sub="Enforced by the engine at every pass" />
      <dl className="grid gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-[130px_1fr]">
        {fixes.map((f) => (
          <div key={f.t} className="contents">
            <dt className="text-muted-foreground">{f.t}</dt>
            <dd className="leading-snug">{f.v}</dd>
          </div>
        ))}
      </dl>
      {spec && spec.guards.length > 0 && (
        <details className="mt-3 border-t border-border pt-3">
          <summary className="cursor-pointer text-[12.5px] font-medium">
            The {spec.guards.length} checks of this trigger
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {spec.guards.map((g) => (
              <li key={g.id} className="text-[12px] leading-snug">
                <code className="rounded bg-accent px-1 py-px text-[11px]">{g.id}</code>{" "}
                <span className="text-foreground/80">{g.why}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/** Ce que 0082 répond quand la sonde ne compte pas — en mots. */
const RAISONS_SONDE: Record<string, string> = {
  busy: "The worker is running this automation right now. Reload in a moment.",
  no_engine: "System rule: nothing to preview.",
  not_found: "Not found.",
  bad_step: "A step's delay is unreadable.",
  no_such_step: "This step does not exist.",
  missing_purpose: "No purpose: a marketing automation cannot select anyone without one.",
  bad_filters: "The filters are unreadable.",
  bad_settings: "The settings are out of bounds.",
  missing_optin_filter: "Pick at least one opt-in.",
  bad_timezone: "Unknown time zone.",
};

export function AudienceCard({ lecture }: { lecture: ListeLue<ProbeView[]> | null }) {
  return (
    <Card>
      <CardHead title="Audience preview" sub="Who the engine would select if it ran now" />
      {lecture === null && <p className="text-[12.5px] text-muted-foreground">No preview for a system rule.</p>}
      {lecture?.state === "no-db" && <Bandeau tone="amber">Database unavailable: no preview.</Bandeau>}
      {lecture?.state === "not-installed" && (
        <Bandeau tone="grey">The preview function is not installed on this database yet (migration 0082).</Bandeau>
      )}
      {lecture?.state === "error" && <Bandeau tone="red">The preview failed: {lecture.message}</Bandeau>}
      {lecture?.state === "ok" && (
        <div className="flex flex-col gap-3">
          {lecture.value.map((p) => (
            <div key={p.step} className="rounded-[10px] border border-border px-3.5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Step {p.step}
                </span>
                {p.eligible !== null ? (
                  <span className="text-[13px]">
                    <span className="text-[18px] font-bold tabular-nums">{fmtInt(p.eligible)}</span> eligible now
                    {p.allowed !== null && p.allowed < p.eligible && (
                      <span className="text-muted-foreground"> · {fmtInt(p.allowed)} within today&apos;s cap</span>
                    )}
                  </span>
                ) : (
                  <span className="text-[12.5px] text-amber-700">
                    {RAISONS_SONDE[p.reason ?? ""] ?? `No count (${p.reason ?? "no answer"})`}
                  </span>
                )}
              </div>
              {p.sample.length > 0 && (
                <p className="mt-1.5 flex flex-wrap gap-1.5">
                  {p.sample.map((e, i) => (
                    <code key={`${e}-${i}`} className="rounded bg-accent px-1.5 py-0.5 text-[11.5px]">
                      {e}
                    </code>
                  ))}
                </p>
              )}
            </div>
          ))}
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            Counted by the engine&apos;s own selection, without writing anything. Addresses are masked by the
            database. The worker&apos;s allowlist is not applied here; a step after the first counts only people who
            already received the previous one.
          </p>
        </div>
      )}
    </Card>
  );
}

/** Journal simulé (« qui aurait reçu quoi, et pourquoi ») ou historique réel. */
export function SendLogCard({
  title,
  sub,
  lecture,
  steps,
  real,
  empty,
}: {
  title: string;
  sub: string;
  lecture: ListeLue<LogRow[]>;
  steps: StepView[];
  real: boolean;
  empty: string;
}) {
  const etape = (n: number) => steps.find((s) => s.n === n);
  return (
    <Card className="p-0">
      <div className="px-[18px] pt-4">
        <CardHead title={title} sub={sub} />
        {lecture.state === "no-db" && <Bandeau tone="amber">Database unavailable.</Bandeau>}
        {lecture.state === "not-installed" && <Bandeau tone="grey">Not installed on this database yet (migration 0082).</Bandeau>}
        {lecture.state === "error" && <Bandeau tone="red">Could not be read: {lecture.message}</Bandeau>}
        {lecture.state === "ok" && lecture.value.length === 0 && (
          <p className="pb-4 text-[12.5px] text-muted-foreground">{empty}</p>
        )}
      </div>
      {lecture.state === "ok" && lecture.value.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>What</Th>
                <Th>Why</Th>
                {real && <Th>Delivery</Th>}
              </tr>
            </thead>
            <tbody>
              {lecture.value.map((l) => {
                const s = etape(l.step);
                return (
                  <tr key={l.id}>
                    <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{fmtUtc(l.createdAt)}</Td>
                    <Td>
                      <code className="text-[11.5px]">{l.who ?? "—"}</code>
                    </Td>
                    <Td>
                      Step {l.step}
                      {s?.template ? ` · ${s.template}` : ""}
                    </Td>
                    <Td className="text-muted-foreground">
                      {l.reason}
                      {l.periodKey && <span className="ml-1 text-[11px]">(period {l.periodKey})</span>}
                    </Td>
                    {real && <Td>{l.outboxStatus ? `${l.outboxStatus}${l.sentAt ? ` · ${fmtUtc(l.sentAt)}` : ""}` : "—"}</Td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function StatusSummary({
  status,
  lastRunAt,
  armedBy,
  armedAt,
}: {
  status: AutomationStatus;
  lastRunAt: string | null;
  armedBy: string | null;
  armedAt: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 text-[12.5px]">
      <div className="flex items-center gap-2">
        <StatusPill status={status} />
        <span className="text-muted-foreground">{STATUS_MEANING[status]}</span>
      </div>
      <p className="text-muted-foreground">
        Last run: {lastRunAt ? fmtUtc(lastRunAt) : "never"}
        {armedBy && armedAt && ` · last switched to live by ${armedBy}, ${fmtUtc(armedAt)}`}
      </p>
    </div>
  );
}

export function BackLink() {
  return (
    <Link href="/automations" className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
      <ArrowRight className="h-3.5 w-3.5 rotate-180" /> Automations
    </Link>
  );
}

export { Bandeau };
