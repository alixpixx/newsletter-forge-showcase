"use client";

import { useEffect, useRef, useState } from "react";
import { dict, type Locale } from "@/lib/i18n";
import { CORE_PURPOSES } from "@nf/config";

const BRAND = "#ff368d";

type Item = { assetId: string; name: string; purposes: Record<string, boolean>; tracking: boolean };

export function PreferencesManager({
  token, email, firstName, items, locale = "en", lifecycleRef = null,
}: {
  token: string; email: string; firstName: string | null; items: Item[]; locale?: Locale;
  /** `?ls=` — la relance d'où vient le lien. Null pour toute autre provenance. */
  lifecycleRef?: string | null;
}) {
  const t = dict(locale);
  const [subs, setSubs] = useState<Item[]>(items);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [erased, setErased] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  // Replié par défaut au-delà de 3 marques (reste scannable).
  const [open, setOpen] = useState<Set<string>>(new Set(items.length <= 3 ? items.map((i) => i.assetId) : []));

  async function call(action: string, extra: Record<string, unknown> = {}) {
    const res = await fetch("/api/v1/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, action, ...extra }),
    });
    return res.json().catch(() => ({}));
  }

  /**
   * La réaction à une relance : ouvrir cet écran depuis l'e-mail.
   *
   * ⛔ C'EST LE SEUL SIGNAL D'ENGAGEMENT QUI EXISTERA. Mailgun ne pose ni pixel ni réécriture de
   * lien sans `tracking_consent`, refusé par 1 202 abonnements sur 1 203 : il n'y aura ni ouverture
   * ni clic à mesurer. Sans cet appel, `reengagement_result` afficherait 0 réaction pour toujours,
   * avec un journal parfaitement vert — et on en conclurait que la relance ne marche pas.
   *
   * ⚠️ `envoye` plutôt qu'un tableau de dépendances vide : en mode strict, React monte le composant
   * deux fois — la garde est portée par une référence, pas par une convention.
   *
   * L'échec est silencieux et sans effet visible : une mesure ne doit jamais empêcher quelqu'un
   * d'accéder à ses préférences.
   */
  const envoye = useRef(false);
  useEffect(() => {
    if (!lifecycleRef || envoye.current) return;
    envoye.current = true;
    call("engagement", { ls: lifecycleRef }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lifecycleRef]);

  async function setPurpose(assetId: string, purpose: string, active: boolean) {
    setBusy(`${assetId}:${purpose}`);
    setNotice("");
    const d = await call("set_purpose", { asset_id: assetId, purpose, active });
    if (d.ok) {
      setSubs((prev) => prev.map((s) => (s.assetId === assetId ? { ...s, purposes: { ...s.purposes, [purpose]: active } } : s)));
      setNotice(t.p.noticeReactivated);
    } else setNotice(t.p.noticeError);
    setBusy(null);
  }

  async function setTracking(assetId: string, active: boolean) {
    setBusy(`${assetId}:tracking`);
    setNotice("");
    const d = await call("set_tracking", { asset_id: assetId, active });
    if (d.ok) {
      setSubs((prev) => prev.map((s) => (s.assetId === assetId ? { ...s, tracking: active } : s)));
      setNotice(t.p.noticeReactivated);
    } else setNotice(t.p.noticeError);
    setBusy(null);
  }

  async function unsubAll() {
    setBusy("all");
    setNotice("");
    const d = await call("unsub_all");
    if (d.ok) {
      setSubs((prev) => prev.map((s) => ({ ...s, purposes: { ...s.purposes, content: false } })));
      setNotice(t.p.noticeUnsubAll);
    } else setNotice(t.p.noticeError);
    setBusy(null);
  }

  async function exportData() {
    setBusy("export");
    setNotice("");
    const d = await call("export");
    if (d.ok && d.data) {
      const blob = new Blob([JSON.stringify(d.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "newsletter-data.json";
      a.click();
      URL.revokeObjectURL(url);
      setNotice(t.p.noticeExported);
    } else setNotice(t.p.noticeError);
    setBusy(null);
  }

  async function erase() {
    setBusy("erase");
    setNotice("");
    const d = await call("erase");
    if (d.ok) setErased(true);
    else {
      setNotice(t.p.noticeError);
      setBusy(null);
    }
  }

  if (erased) {
    return (
      <Page wide>
        <div className="text-center">
          <h1 className="text-[19px] font-bold tracking-tight">{t.p.erasedTitle}</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{t.p.erasedBody}</p>
        </div>
      </Page>
    );
  }

  return (
    <Page wide>
      <h1 className="text-[19px] font-bold tracking-tight">{t.p.title}</h1>
      <p className="mt-1 text-[13px]" style={{ color: "var(--muted)" }}>{firstName ? `${firstName} · ` : ""}{email}</p>

      {notice && (
        <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px] font-medium" style={{ background: "#f0f6f1", color: "#1f9d57" }}>{notice}</p>
      )}

      <div className="mt-4 space-y-2.5">
        {subs.length === 0 && <p className="text-[13px]" style={{ color: "var(--muted)" }}>{t.p.noSubs}</p>}
        {subs.map((s) => {
          const isActive = s.purposes.content === true;
          const isOpen = open.has(s.assetId);
          const summary = CORE_PURPOSES.filter((p) => s.purposes[p]).map((p) => t.purpose[p]).join(", ") || "—";
          return (
            <div key={s.assetId} className="rounded-xl border" style={{ borderColor: "var(--line)" }}>
              <button
                onClick={() => setOpen((prev) => { const n = new Set(prev); n.has(s.assetId) ? n.delete(s.assetId) : n.add(s.assetId); return n; })}
                className="flex w-full items-center justify-between px-4 py-3 text-left">
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold">{s.name}</span>
                  {!isOpen && <span className="block truncate text-[11.5px]" style={{ color: "var(--muted)" }}>{summary}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: isActive ? "#1f9d57" : "var(--muted)" }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: isActive ? BRAND : "#c4c4cc" }} />
                    {isActive ? t.p.active : t.p.paused}
                  </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2.5"
                    style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}><path d="M6 9l6 6 6-6" /></svg>
                </span>
              </button>
              {isOpen && (
                <div className="px-4 pb-3">
                  {CORE_PURPOSES.map((p) => (
                    <Row key={p} label={t.purpose[p]} on={s.purposes[p] === true} busy={busy === `${s.assetId}:${p}`}
                      onToggle={() => setPurpose(s.assetId, p, !(s.purposes[p] === true))} />
                  ))}
                  <div className="my-1.5 border-t" style={{ borderColor: "var(--line)" }} />
                  <Row label={t.purpose.partners} muted on={s.purposes.partners === true} busy={busy === `${s.assetId}:partners`}
                    onToggle={() => setPurpose(s.assetId, "partners", !(s.purposes.partners === true))} />
                  <Row label={t.w.tracking} muted on={s.tracking} busy={busy === `${s.assetId}:tracking`}
                    onToggle={() => setTracking(s.assetId, !s.tracking)} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* MES DROITS — zone séparée, actions au niveau du compte */}
      <div className="mt-6 border-t pt-4" style={{ borderColor: "var(--line)" }}>
        <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>{t.p.myRights}</p>
        <div className="space-y-2">
          <button onClick={exportData} disabled={busy === "export"}
            className="w-full rounded-lg border px-4 py-2.5 text-left text-[13px] font-medium transition-colors hover:bg-[#faf9fb] disabled:opacity-50"
            style={{ borderColor: "var(--line)" }}>
            {t.p.export} <span style={{ color: "var(--muted)" }}>{t.p.exportHint}</span>
          </button>
          <button onClick={unsubAll} disabled={busy === "all"}
            className="w-full rounded-lg border px-4 py-2.5 text-left text-[13px] font-medium transition-colors hover:bg-[#faf9fb] disabled:opacity-50"
            style={{ borderColor: "var(--line)" }}>
            {t.p.unsubAll}
          </button>
          {!confirmErase ? (
            <button onClick={() => setConfirmErase(true)}
              className="w-full rounded-lg border px-4 py-2.5 text-left text-[13px] font-medium transition-colors hover:bg-[#fff5f7]"
              style={{ borderColor: "#f3c6d4", color: "#d33" }}>
              {t.p.erase} <span style={{ opacity: 0.75 }}>{t.p.eraseHint}</span>
            </button>
          ) : (
            <div className="rounded-lg border px-4 py-3" style={{ borderColor: "#f3c6d4", background: "#fff5f7" }}>
              <p className="text-[12.5px] font-medium" style={{ color: "#d33" }}>{t.p.eraseWarn}</p>
              <div className="mt-2.5 flex gap-2">
                <button onClick={erase} disabled={busy === "erase"}
                  className="rounded-lg px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50" style={{ background: "#d33" }}>
                  {busy === "erase" ? "…" : t.p.eraseConfirm}
                </button>
                <button onClick={() => setConfirmErase(false)}
                  className="rounded-lg border px-3.5 py-2 text-[12.5px] font-medium" style={{ borderColor: "var(--line)" }}>
                  {t.p.cancel}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}

function Row({ label, on, busy, onToggle, muted }: { label: string; on: boolean; busy: boolean; onToggle: () => void; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[13px]" style={muted ? { color: "var(--muted)" } : { fontWeight: 500 }}>{label}</span>
      <button onClick={onToggle} disabled={busy} aria-label={label}
        className="relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50"
        style={{ background: on ? BRAND : "#d4d4d8" }}>
        <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" style={{ left: on ? "22px" : "2px" }} />
      </button>
    </div>
  );
}

function Page({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4" style={{ background: "#f7f7fb" }}>
      <div className={`w-full ${wide ? "max-w-[460px]" : "max-w-[440px]"} rounded-2xl border bg-white p-7`} style={{ borderColor: "var(--line)" }}>
        {children}
      </div>
    </div>
  );
}
