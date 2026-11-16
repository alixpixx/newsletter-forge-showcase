"use client";

import { useEffect, useState } from "react";
import { dict, type Locale } from "@/lib/i18n";

/**
 * Bandeau cookies conforme (kit Example Media) — PRÊT mais DORMANT : nos surfaces (widget iframe +
 * pages hostées) sont aujourd'hui COOKIE-FREE (le pixel d'ouverture est côté email, soumis à
 * `tracking_consent`). On ne le monte donc PAS (un bandeau sans cookie = dark pattern « faux choix »).
 * Le jour où une page pose un cookie non essentiel : `<CookieBanner locale hasNonEssential />`.
 *
 * Anti-dark-pattern (CNIL/AEPD/Garante/DPDP) : « Refuser » = MÊME poids que « Accepter »,
 * non-essentiels OFF par défaut, pas de cookie-wall, choix persisté (pas de re-sollicitation).
 */
const KEY = "nf_cookie_consent";

export function CookieBanner({ locale = "en", hasNonEssential = false }: { locale?: Locale; hasNonEssential?: boolean }) {
  const t = dict(locale).cookie;
  const [open, setOpen] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [analytics, setAnalytics] = useState(false); // non-essentiel, OFF par défaut

  useEffect(() => {
    if (!hasNonEssential) return; // dormant tant qu'aucun cookie non essentiel
    try {
      if (!localStorage.getItem(KEY)) setOpen(true);
    } catch {
      setOpen(true);
    }
  }, [hasNonEssential]);

  function persist(choice: { analytics: boolean }) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...choice, at: new Date().toISOString() }));
    } catch {
      /* stockage indisponible : on ferme quand même, sans re-nagger cette session */
    }
    setOpen(false);
  }

  if (!hasNonEssential || !open) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t bg-white p-4" style={{ borderColor: "var(--line)" }}>
      <div className="mx-auto max-w-[720px]">
        <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
          {t.text}{" "}
          <a href="/cookies" className="underline">{t.policy} ↗</a>
        </p>

        {showPrefs && (
          <div className="mt-3 space-y-1.5 rounded-lg border p-3" style={{ borderColor: "var(--line)" }}>
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="font-medium">{t.essential}</span>
              <span style={{ color: "var(--muted)" }}>{t.essentialNote}</span>
            </div>
            <label className="flex items-center justify-between text-[12.5px]">
              <span className="font-medium">Analytics</span>
              <input type="checkbox" checked={analytics} onChange={(e) => setAnalytics(e.target.checked)} className="h-4 w-4" style={{ accentColor: "#ff368d" }} />
            </label>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Refuser et Accepter = même taille / même prominence (anti-dark-pattern) */}
          <button onClick={() => persist({ analytics: false })}
            className="rounded-[10px] border px-4 py-2 text-[13px] font-semibold" style={{ borderColor: "var(--line)" }}>
            {t.reject}
          </button>
          {showPrefs ? (
            <button onClick={() => persist({ analytics })}
              className="rounded-[10px] px-4 py-2 text-[13px] font-semibold text-white" style={{ background: "#ff368d" }}>
              {t.save}
            </button>
          ) : (
            <button onClick={() => persist({ analytics: true })}
              className="rounded-[10px] px-4 py-2 text-[13px] font-semibold text-white" style={{ background: "#ff368d" }}>
              {t.acceptAll}
            </button>
          )}
          {!showPrefs && (
            <button onClick={() => setShowPrefs(true)} className="text-[12.5px] font-medium underline" style={{ color: "var(--muted)" }}>
              {t.preferences}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
