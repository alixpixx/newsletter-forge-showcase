import { getComplianceData, type AuditRow } from "@/lib/data/compliance";
import { getCurrentAsset } from "@/lib/asset-context";
import { Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

function fmt(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "green" | "amber" | "red" | "brand" }) {
  const tones: Record<string, string> = {
    neutral: "border-border bg-accent text-muted-foreground",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    red: "border-red-200 bg-red-50 text-red-700",
    brand: "border-brand-soft bg-white text-brand",
  };
  return <span className={`inline-block rounded-full border px-2 py-px text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

const EVENT_TONE: Record<string, "green" | "red" | "amber" | "neutral"> = {
  granted: "green", optin_confirm: "green", resubscribe: "green",
  withdrawn: "red", unsubscribe: "red", deletion_request: "red",
  optin_request: "neutral", preference_change: "amber",
};

function eventLabel(e: AuditRow): string {
  return e.purpose ? `${e.event_type} · ${e.purpose}` : e.event_type;
}

export default async function CompliancePage() {
  const asset = await getCurrentAsset();
  const d = await getComplianceData(asset.id);
  const scoped = d.scoped;
  // Suffixe de portée réutilisé partout : jamais de chiffre sans son étiquette de portée.
  const scopeLabel = scoped ? asset.name : "all brands";

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[22px] font-bold tracking-tight">Compliance</h1>
        <p className="mt-0.5 text-[13.5px] text-muted-foreground">
          Consent audit log, DSAR requests and suppression list — the proof behind the compliance promises.
        </p>
        <div className="mt-2">
          {scoped ? <Pill tone="pink" dot>{asset.name}</Pill> : <Pill tone="amber" dot>All brands</Pill>}
        </div>
      </div>

      {d.source === "none" && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          Database unavailable — `SUPABASE_*` configuration missing.
        </div>
      )}

      {!scoped && d.source === "db" && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          Brand context unavailable — every figure below covers all 9 brands.
        </div>
      )}

      {/* KPIs — chaque tuile dit explicitement sur quoi elle porte. */}
      <div className="mb-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: "Consent events", value: d.kpis.consentEvents, hint: `immutable log · ${scopeLabel}` },
          { label: "Suppressions", value: d.kpis.suppressions, hint: `do-not-send · global + ${scopeLabel}` },
          // dsar_request n'a pas de colonne asset : ce chiffre est global, on le dit.
          { label: "Open DSAR", value: d.kpis.dsarOpen, hint: "access / erasure · all brands" },
        ].map((k) => (
          <div key={k.label} className="rounded-xl border border-border bg-card p-4">
            <div className="text-[12px] font-medium text-muted-foreground">{k.label}</div>
            <div className="mt-1 text-[26px] font-bold tabular-nums">{k.value.toLocaleString("en-US")}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground/70">{k.hint}</div>
          </div>
        ))}
      </div>

      {/* Journal d'audit */}
      <Section title="Consent audit log" subtitle={`Last 60 events · ${scopeLabel} — who, what, when, legal basis`}>
        <Table head={["Subscriber", "Brand", "Event", "Legal basis", "Country", "Method", "Date"]}>
          {d.audit.map((e, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{e.email}</td>
              <td className="px-3 py-2 text-muted-foreground">{e.asset}</td>
              <td className="px-3 py-2"><Chip tone={EVENT_TONE[e.event_type] ?? "neutral"}>{eventLabel(e)}</Chip></td>
              <td className="px-3 py-2 text-muted-foreground">{e.legal_basis ?? "—"}</td>
              <td className="px-3 py-2 text-muted-foreground">{e.country ?? "—"}</td>
              <td className="px-3 py-2 text-muted-foreground">{e.method ?? "—"}</td>
              <td className="px-3 py-2 tabular-nums text-muted-foreground">{fmt(e.occurred_at)}</td>
            </tr>
          ))}
          {d.audit.length === 0 && (
            <Empty cols={7} label={scoped ? `No consent events for ${asset.name}.` : "No consent events."} />
          )}
        </Table>
      </Section>

      {/* DSAR = une personne, pas une marque : la table n'a pas d'`asset_id`, donc ce bloc
          reste global quelle que soit la marque sélectionnée. Étiqueté explicitement. */}
      <Section
        title="DSAR requests"
        subtitle="Data-subject rights — access, portability, rectification, erasure"
        badge={<Pill tone="grey">All brands</Pill>}
      >
        <Table head={["Email", "Type", "Status", "Requested", "Due"]}>
          {d.dsar.map((r, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{r.email}</td>
              <td className="px-3 py-2 text-muted-foreground">{r.type}</td>
              <td className="px-3 py-2"><Chip tone={r.status === "done" ? "green" : r.status === "failed" ? "red" : "amber"}>{r.status}</Chip></td>
              <td className="px-3 py-2 tabular-nums text-muted-foreground">{fmt(r.requested_at)}</td>
              <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.due_at ? fmt(r.due_at) : "—"}</td>
            </tr>
          ))}
          {d.dsar.length === 0 && <Empty cols={5} label="No DSAR requests." />}
        </Table>
      </Section>

      {/* Suppression */}
      <Section
        title="Suppression list"
        subtitle={`Do-not-send addresses (erasure, global opt-out, complaints) · global + ${scopeLabel}`}
      >
        <Table head={["Email / hash", "Scope", "Reason", "Date"]}>
          {d.suppressions.map((r, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{r.email ?? <span className="text-muted-foreground/70">— (hashed)</span>}</td>
              <td className="px-3 py-2"><Chip tone={r.scope === "global" ? "red" : "neutral"}>{r.scope}</Chip></td>
              <td className="px-3 py-2 text-muted-foreground">{r.reason ?? "—"}</td>
              <td className="px-3 py-2 tabular-nums text-muted-foreground">{fmt(r.created_at)}</td>
            </tr>
          ))}
          {d.suppressions.length === 0 && <Empty cols={4} label="Suppression list empty." />}
        </Table>
      </Section>
    </div>
  );
}

function Section({
  title, subtitle, badge, children,
}: { title: string; subtitle: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <p className="text-[12px] text-muted-foreground">{subtitle}</p>
        </div>
        {badge}
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">{children}</div>
    </section>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          {head.map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Empty({ cols, label }: { cols: number; label: string }) {
  return (
    <tr className="border-t border-border">
      <td colSpan={cols} className="px-3 py-6 text-center text-[13px] text-muted-foreground">{label}</td>
    </tr>
  );
}
