import Link from "next/link";
import { RotateCw, TriangleAlert } from "lucide-react";
import { PageHead, Pill, Card, CardHead, Th, Td, type Tone } from "@/components/ui";
import { cn } from "@/lib/utils";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { getReengagementResult, totalReengagement } from "@/lib/data/lifecycle";
import { isLifecycleKind } from "@nf/render/lifecycle-checks";
import { LIFECYCLE_LABELS } from "@/components/templates/lifecycle-labels";
import {
  COMPLAINT_THRESHOLD,
  DAY_WINDOWS,
  MIN_DELIVERED_FOR_VERDICT,
  complaintVerdict,
  getDeliverability,
  parseDayWindow,
  part,
  pct,
  reasonLabel,
  suppressionLabel,
  type ComplaintVerdict,
  type DailyPoint,
  type Deliverability,
} from "@/lib/data/deliverability";

// Les chiffres bougent à chaque webhook : rien à figer au build.
export const dynamic = "force-dynamic";

/** Au-delà, une ligne en attente n'est plus « en cours » : plus rien ne la prend. */
const QUEUE_STALE_MINUTES = 15;

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Un chiffre réel, avec la seule chose qui le rende lisible : ce qu'il est. « Queued » porte
 * « not a denominator » parce que c'est exactement l'erreur qu'on ferait en le lisant vite.
 */
function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: React.ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-[10px] border border-border px-3.5 py-3">
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
      <b className={cn(
        "block text-[22px] font-extrabold tracking-tight tabular-nums",
        tone === "good" && "text-[#1f9d57]",
        tone === "bad" && "text-[#b9790a]",
      )}>
        {value}
      </b>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function age(depuis: string, maintenant: string): string {
  const min = Math.max(0, Math.round((Date.parse(maintenant) - Date.parse(depuis)) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

const jourCourt = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const VERDICT: Record<ComplaintVerdict, { tone: Tone; label: string; text: string }> = {
  "no-data": { tone: "grey", label: "No deliveries", text: "Nothing was delivered in this window, so there is no complaint rate to judge." },
  above: {
    tone: "red",
    label: "Above 0.3%",
    text: "Spam complaints are above the 0.3% limit. Pause sends for this brand and look at who received what.",
  },
  thin: {
    tone: "amber",
    label: "Too few to judge",
    text: `No complaints, but under ${fmt(MIN_DELIVERED_FOR_VERDICT)} deliveries a single complaint is already above 0.3% — this is not yet a clean record.`,
  },
  ok: { tone: "green", label: "Under 0.3%", text: "Spam complaints are under the 0.3% limit." },
};

function kindLabel(kind: string, name: string | null): string {
  if (kind === "campaign") return name?.trim() || "Untitled campaign";
  if (kind === "test") return "Test sends";
  return isLifecycleKind(kind) ? `${LIFECYCLE_LABELS[kind].titre} email` : kind;
}

/** Envois par jour : la part remise en vert, les rebonds en rouge, le reste (sans réponse) en gris. */
function DailyChart({ daily }: { daily: DailyPoint[] }) {
  const max = Math.max(1, ...daily.map((d) => d.sent));
  const milieu = daily[Math.floor((daily.length - 1) / 2)];
  return (
    <div>
      <div className="flex items-stretch gap-2">
        <div className="flex w-8 shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-muted-foreground">
          <span>{fmt(max)}</span>
          <span>0</span>
        </div>
        <div className="flex h-[120px] flex-1 items-end gap-px border-b border-border" role="img" aria-label="Emails sent per day">
          {daily.map((d) => {
            const bounced = Math.min(d.bounced, d.sent);
            const delivered = Math.min(d.delivered, d.sent - bounced);
            const rest = d.sent - bounced - delivered;
            return (
              <div
                key={d.day}
                title={`${jourCourt(d.day)} · ${fmt(d.sent)} sent · ${fmt(d.delivered)} delivered · ${fmt(d.bounced)} bounced · ${fmt(d.complained)} spam`}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
              >
                {d.sent > 0 && (
                  <div className="flex min-h-[3px] flex-col overflow-hidden rounded-t-[2px]" style={{ height: `${(d.sent / max) * 100}%` }}>
                    {rest > 0 && <span className="bg-foreground/15" style={{ flexGrow: rest }} />}
                    {bounced > 0 && <span className="bg-[#c0334a]" style={{ flexGrow: bounced }} />}
                    {delivered > 0 && <span className="bg-[#1f9d57]" style={{ flexGrow: delivered }} />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between pl-10 text-[10.5px] tabular-nums text-muted-foreground">
        <span>{daily[0] ? jourCourt(daily[0].day) : ""}</span>
        <span>{milieu ? jourCourt(milieu.day) : ""}</span>
        <span>{daily.at(-1) ? jourCourt(daily.at(-1)!.day) : ""}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-3.5 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-[#1f9d57]" /> Delivered</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-[#c0334a]" /> Hard bounce</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-foreground/15" /> No answer from the provider yet</span>
      </div>
    </div>
  );
}

function Health({ d, brand }: { d: Deliverability; brand: string }) {
  const t = d.totals;
  const verdict = complaintVerdict(t);
  const v = VERDICT[verdict];
  const complaintRate = part(t.complained, t.delivered);
  return (
    <>
      <Card>
        <CardHead
          title="Sending health"
          sub={`Emails that left the queue in the last ${d.days} days (UTC), and what the mail provider reported for them`}
          right={<Pill tone={v.tone} dot>{v.label}</Pill>}
        />
        {t.sent === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">Nothing was sent for {brand} in the last {d.days} days.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Sent" value={fmt(t.sent)} hint="handed to the provider" />
              <Stat label="Delivered" value={fmt(t.delivered)} hint={`${pct(part(t.delivered, t.sent))} of sent`} tone="good" />
              <Stat label="Hard bounces" value={fmt(t.bounced)} hint={`${pct(part(t.bounced, t.sent))} of sent`} tone={t.bounced > 0 ? "bad" : undefined} />
              <Stat
                label="Spam complaints"
                value={fmt(t.complained)}
                hint={`${pct(complaintRate)} of delivered · limit ${pct(COMPLAINT_THRESHOLD)}`}
                tone={verdict === "above" ? "bad" : undefined}
              />
              <Stat label="Unsubscribes" value={fmt(t.unsubscribed)} hint={`${pct(part(t.unsubscribed, t.delivered))} of delivered`} />
              <Stat
                label="No answer yet"
                value={fmt(t.noOutcome)}
                hint={t.softFailed > 0 ? `${fmt(t.softFailed)} with a temporary failure` : "neither delivered nor bounced"}
                tone={t.noOutcome > 0 ? "bad" : undefined}
              />
            </div>
            <p className={cn(
              "mt-3 rounded-[10px] border px-3.5 py-2.5 text-[12px]",
              verdict === "above" ? "border-[#f5c6cf] bg-[#fdeaec] text-[#8f2336]" : verdict === "thin" ? "border-[#f3dcae] bg-[#fdf0dd]" : "border-border bg-accent/40",
            )}>
              {v.text}
            </p>
            <div className="mt-4">
              <DailyChart daily={d.daily} />
            </div>
          </>
        )}
        <div className="mt-4 grid gap-1.5 border-t border-border pt-3 text-[11.5px] text-muted-foreground">
          <p>
            <b className="font-semibold text-foreground">Opens and clicks are not measured.</b> Mailgun adds no pixel and
            rewrites no link without tracking consent, which almost every subscription declines — the{" "}
            {fmt(t.opened)} open{t.opened === 1 ? "" : "s"} and {fmt(t.clicked)} click{t.clicked === 1 ? "" : "s"} recorded
            are not a rate.
          </p>
          <p>
            Sending domain: <b className="font-semibold text-foreground">{d.sendingSubdomain ?? "none set"}</b>. SPF, DKIM
            and DMARC are not checked from this screen — check them in the Mailgun dashboard. Inbox placement and domain
            reputation are not measured either.
          </p>
        </div>
      </Card>

      {d.unlinkedEvents > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-[10px] border border-[#f3dcae] bg-[#fdf0dd] px-3.5 py-2.5 text-[11.5px]">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-[#e8973a]" strokeWidth={2.2} />
          <span>
            <b>{fmt(d.unlinkedEvents)}</b> provider event{d.unlinkedEvents === 1 ? "" : "s"} in this window could not be
            matched to any send, on any brand. They are left out of every number above.
          </span>
        </p>
      )}
    </>
  );
}

function Queue({ d }: { d: Deliverability }) {
  const { pending, sending, oldestPending } = d.queue;
  const bloque =
    oldestPending !== null && Date.parse(d.measuredAt) - Date.parse(oldestPending) > QUEUE_STALE_MINUTES * 60_000;
  const nonEnvoyes = d.notSent.reduce((s, r) => s + r.count, 0);
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHead title="Queue right now" sub="Emails waiting to be picked up by the sending worker" />
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Waiting" value={fmt(pending)} hint={oldestPending ? `oldest: ${age(oldestPending, d.measuredAt)}` : "nothing waiting"} tone={bloque ? "bad" : undefined} />
          <Stat label="Being sent" value={fmt(sending)} />
        </div>
        {bloque && (
          <p className="mt-3 rounded-[10px] border border-[#f3dcae] bg-[#fdf0dd] px-3.5 py-2.5 text-[12px]">
            Nothing has picked these up for {age(oldestPending!, d.measuredAt)}. Check that the sending worker is running.
          </p>
        )}
      </Card>

      <Card>
        <CardHead title="Not sent" sub={`Emails the worker set aside in the last ${d.days} days, and why`} />
        {nonEnvoyes === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">None.</p>
        ) : (
          <ul className="flex flex-col">
            {d.notSent.map((r) => (
              <li key={`${r.status}:${r.reason}`} className="flex items-center gap-3 border-b border-border py-2 text-[12.5px] last:border-0">
                <Pill tone={r.status === "failed" ? "red" : "grey"}>{r.status === "failed" ? "Failed" : "Skipped"}</Pill>
                <span className="flex-1">{reasonLabel(r.reason)}</span>
                <b className="tabular-nums">{fmt(r.count)}</b>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function BySend({ d }: { d: Deliverability }) {
  if (d.bySend.length === 0) return null;
  return (
    <Card className="mt-4">
      <CardHead title="By email" sub="Campaigns and automatic emails sent in this window, largest first" />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <Th>Email</Th>
              <Th className="text-right">Sent</Th>
              <Th className="text-right">Delivered</Th>
              <Th className="text-right">Bounced</Th>
              <Th className="text-right">Spam</Th>
              <Th className="text-right">Unsub</Th>
              <Th className="text-right">Last sent</Th>
            </tr>
          </thead>
          <tbody>
            {d.bySend.map((g) => (
              <tr key={g.campaignId ?? g.kind} className="hover:bg-accent/40">
                <Td className="font-medium">
                  {g.campaignId ? (
                    <Link href={`/campaigns/${g.campaignId}`} className="hover:underline">{kindLabel(g.kind, g.name)}</Link>
                  ) : (
                    kindLabel(g.kind, g.name)
                  )}
                </Td>
                <Td className="text-right tabular-nums">{fmt(g.sent)}</Td>
                <Td className="text-right tabular-nums">
                  {fmt(g.delivered)} <span className="text-muted-foreground">· {pct(part(g.delivered, g.sent))}</span>
                </Td>
                <Td className={cn("text-right tabular-nums", g.bounced > 0 ? "font-semibold text-[#b9790a]" : "text-muted-foreground")}>{fmt(g.bounced)}</Td>
                <Td className={cn("text-right tabular-nums", g.complained > 0 ? "font-semibold text-[#c0334a]" : "text-muted-foreground")}>{fmt(g.complained)}</Td>
                <Td className="text-right tabular-nums text-muted-foreground">{fmt(g.unsubscribed)}</Td>
                <Td className="text-right tabular-nums text-muted-foreground">{g.lastSentAt ? g.lastSentAt.slice(0, 10) : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Suppressions({ d }: { d: Deliverability }) {
  const total = d.suppressions.reduce((s, r) => s + r.count, 0);
  return (
    <Card className="mt-4">
      <CardHead title="Suppression list" sub={`Addresses blocked for this brand in the last ${d.days} days — they will not be emailed again`} />
      {total === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">No address was added for this brand.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {d.suppressions.map((s) => (
            <Pill key={s.reason} tone={s.reason === "hard_bounce" || s.reason === "spam_complaint" ? "amber" : "grey"}>
              {suppressionLabel(s.reason)} · {fmt(s.count)}
            </Pill>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11.5px] text-muted-foreground">
        {fmt(d.globalSuppressions)} address{d.globalSuppressions === 1 ? " was" : "es were"} also blocked for every brand
        in this window (spam complaints, global opt-outs, erasure requests). Those entries carry no brand, so they are
        counted across all brands.
      </p>
    </Card>
  );
}

function Reengagement({ rows, t, source, reason, brand }: {
  rows: Awaited<ReturnType<typeof getReengagementResult>>["rows"];
  t: ReturnType<typeof totalReengagement>;
  source: string;
  reason: string | null | undefined;
  brand: string;
}) {
  return (
    <Card className="mt-4">
      <CardHead
        title="Re-engagement outcomes"
        sub={source === "db" ? `What the dormant-subscriber waves for ${brand} actually produced` : "Could not be read"}
        right={t.orphanEvents > 0 ? <Pill tone="amber">{t.orphanEvents} unlinked event{t.orphanEvents === 1 ? "" : "s"}</Pill> : undefined}
      />
      {source !== "db" ? (
        // ⛔ Un écran qui ne peut pas lire le dit. Afficher des zéros ferait passer une panne de
        // lecture pour une absence de résultats.
        <p className="text-[12.5px] text-muted-foreground">
          {reason === "no-asset" ? "Pick a brand to see its re-engagement results." : `Read failed: ${reason}.`}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          No re-engagement has been queued for {brand} yet. Re-engagement sending is switched off on the server, so
          nothing is sent until it is turned on.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Queued" value={fmt(t.enqueued)} hint="not a denominator" />
            <Stat label="Delivered" value={fmt(t.delivered)} hint="the denominator" />
            <Stat label="Responded" value={fmt(t.responded)} hint={pct(t.responseRate)} tone="good" />
            <Stat
              label="Unsub + spam"
              value={fmt(t.unsubscribed + t.complained)}
              hint={pct(t.costRate)}
              tone={t.costRate !== null && t.responseRate !== null && t.costRate > t.responseRate ? "bad" : undefined}
            />
            <Stat label="Bounced" value={fmt(t.bounced)} hint="dead addresses" />
          </div>

          {/* ⛔ Le discriminant, en toutes lettres : sans lui « 0 réaction » et « la mesure ne mord
              pas » s'affichent exactement pareil. */}
          {t.orphanEvents > 0 && (
            <p className="mt-3 rounded-[10px] border border-[#f3dcae] bg-[#fdf0dd] px-3.5 py-2.5 text-[11.5px]">
              <b>{t.orphanEvents}</b> provider event{t.orphanEvents === 1 ? " has" : "s have"} no matching
              outbox row. Every number above is a <b>floor</b>, not a measurement.
            </p>
          )}

          <p className="mt-3 text-[11.5px] text-muted-foreground">
            “Responded” means the person opened their preference page from the email — a first-party signal that
            needs no pixel.
          </p>

          <div className="mt-3.5 overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <Th>Step</Th>
                  <Th className="text-right">Queued</Th>
                  <Th className="text-right">Delivered</Th>
                  <Th className="text-right">Responded</Th>
                  <Th className="text-right">Unsub</Th>
                  <Th className="text-right">Spam</Th>
                  <Th className="text-right">Last sent</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.step} className="hover:bg-accent/40">
                    <Td className="font-medium">Step {r.step}</Td>
                    <Td className="text-right tabular-nums text-muted-foreground">{fmt(r.enqueued)}</Td>
                    <Td className="text-right tabular-nums">{fmt(r.delivered)}</Td>
                    <Td className="text-right tabular-nums font-semibold">{fmt(r.responded)}</Td>
                    <Td className="text-right tabular-nums">{fmt(r.unsubscribed)}</Td>
                    <Td className={cn("text-right tabular-nums", r.complained > 0 && "font-semibold text-[#b9790a]")}>{fmt(r.complained)}</Td>
                    <Td className="text-right tabular-nums text-muted-foreground">
                      {r.lastSentAt ? new Date(r.lastSentAt).toISOString().slice(0, 10) : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * ⛔ TOUT CE QUI EST SUR CET ÉCRAN EST LU EN BASE. La maquette d'avant le 16/09 (placement en boîte,
 * réputation par sous-domaine, SPF/DKIM « ✓ », alertes) a été retirée : aucune de ces mesures n'existe
 * dans le produit, et un écran qui mêle vrais et faux chiffres ne laisse plus savoir lesquels croire.
 * Ce qui n'est pas mesuré est NOMMÉ comme tel, jamais dessiné.
 */
export default async function DeliverabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const days = parseDayWindow((await searchParams).days);
  const asset = await getCurrentAsset();
  const [lu, reeng] = await Promise.all([
    getDeliverability(getDb(), asset.id, days),
    getReengagementResult(asset.id),
  ]);
  const t = totalReengagement(reeng.rows);

  return (
    <div className="animate-fade-up">
      <PageHead
        title="Deliverability"
        desc="What left the queue for this brand and what the mail provider reported back. Every number is read from the database; nothing is estimated."
      >
        <Pill tone="pink" dot>{asset.name}</Pill>
        <nav aria-label="Time window" className="inline-flex rounded-[9px] border border-border bg-card p-0.5">
          {DAY_WINDOWS.map((w) => (
            <Link
              key={w}
              href={`?days=${w}`}
              aria-current={w === days ? "page" : undefined}
              className={cn(
                "rounded-[7px] px-2.5 py-1.5 text-[12.5px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                w === days ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {w} days
            </Link>
          ))}
        </nav>
        {/* Un vrai rechargement : la page est dynamique, et un lien client pourrait resservir un rendu en cache. */}
        <a
          href={`?days=${days}`}
          className="inline-flex items-center gap-2 rounded-[9px] border border-border bg-card px-3.5 py-2 text-[13px] font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <RotateCw className="h-[15px] w-[15px]" strokeWidth={2} /> Refresh
        </a>
      </PageHead>

      {lu.known ? (
        <>
          <Health d={lu.value} brand={asset.name} />
          <Queue d={lu.value} />
          <BySend d={lu.value} />
          <Suppressions d={lu.value} />
          <p className="mt-2 text-right text-[11px] tabular-nums text-muted-foreground">
            Measured {lu.value.measuredAt.slice(0, 16).replace("T", " ")} UTC
          </p>
        </>
      ) : (
        // ⛔ Pas de zéros sur une panne : « rien d'envoyé » et « rien de lisible » ne se confondent pas.
        <Card>
          <CardHead title="Sending health" sub="Could not be read" />
          <p className="text-[12.5px] text-muted-foreground">Read failed: {lu.reason}.</p>
        </Card>
      )}

      <Reengagement rows={reeng.rows} t={t} source={reeng.source} reason={reeng.reason} brand={asset.name} />
    </div>
  );
}
