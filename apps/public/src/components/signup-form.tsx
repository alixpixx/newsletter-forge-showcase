"use client";

import { useEffect, useState } from "react";
import { dict, type Locale } from "@/lib/i18n";

/**
 * Widget d'inscription. Squelette FIXE en 4 zones (identité / consentement cœur / permissions
 * extra / action) — seule la Zone B change entre mode `single` (1 case énumérée) et `granular`
 * (1 case par finalité). Aucune case pré-cochée. Partenaires = toujours une case séparée (Zone C).
 * Strings via le module i18n partagé ; texte légal de consentement (single) via la DB.
 */
export function SignupForm({
  asset, assetName, consentText, brand, formToken, locale = "en", consentMode = "single", edition, trackingForAll = false,
}: {
  asset: string; assetName: string; consentText: string; brand: string; formToken: string;
  locale?: Locale; consentMode?: "single" | "granular";
  /** Slug de l'édition servie (lot E-1). Absent = édition primaire de la marque. */
  edition?: string;
  /** Marque en mode « suivi pour tous » (0092) : pas de case de suivi, le refus est dans les préférences. */
  trackingForAll?: boolean;
}) {
  const t = dict(locale);
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [consent, setConsent] = useState(false); // = finalité `content` (Newsletter, requise)
  const [offers, setOffers] = useState(false);
  const [events, setEvents] = useState(false);
  const [partner, setPartner] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [company, setCompany] = useState(""); // honeypot
  const [state, setState] = useState<"idle" | "sending" | "done" | "already">("idle");
  const [error, setError] = useState("");

  // Auto-redimensionnement de l'iframe chez le publisher.
  useEffect(() => {
    const send = () =>
      window.parent?.postMessage({ type: "nf-embed-height", height: document.documentElement.scrollHeight }, "*");
    send();
    const ro = new ResizeObserver(send);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [state, error]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!consent) {
      setError(t.w.errors["consentement-requis"]);
      return;
    }
    setState("sending");
    setError("");
    try {
      const res = await fetch("/api/v1/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email, first_name: firstName, asset,
          // Le formulaire déclare l'édition qu'il a SERVIE : le consentement vaut pour la liste dont
          // le visiteur a lu le texte, pas pour celle que le serveur choisirait par défaut.
          ...(edition ? { edition } : {}),
          consent, purposes: { offers, events }, partner_consent: partner, tracking_consent: tracking,
          company, ft: formToken,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) setState(d.already ? "already" : "done");
      else {
        setError(t.w.errors[d.error as string] ?? t.w.errorGeneric);
        setState("idle");
      }
    } catch {
      setError(t.w.errorNetwork);
      setState("idle");
    }
  }

  if (state === "done" || state === "already") {
    return (
      <div style={{ borderColor: "var(--line)" }} className="rounded-2xl border bg-white p-6 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full" style={{ background: brand }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M20 6L9 17l-5-5" /></svg>
        </div>
        <h2 className="text-[17px] font-bold">{state === "already" ? t.w.alreadyTitle : t.w.doneTitle}</h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
          {state === "already" ? t.w.alreadyBody(assetName) : t.w.doneBody(assetName)}
        </p>
      </div>
    );
  }

  const missingConsent = !!error && !consent;
  const cbClass = "mt-0.5 h-4 w-4 shrink-0";

  return (
    <form onSubmit={onSubmit} noValidate style={{ borderColor: "var(--line)" }} className="rounded-2xl border bg-white p-6">
      {/* Zone A — identité */}
      <h2 className="text-[18px] font-bold tracking-tight">{t.w.heading(assetName)}</h2>
      <p className="mb-4 mt-1 text-[13px]" style={{ color: "var(--muted)" }}>{t.w.sub}</p>

      <label className="mb-3 block">
        <span className="mb-1 block text-[12px] font-medium">{t.w.firstName} <span style={{ color: "var(--muted)" }}>{t.w.optional}</span></span>
        <input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name"
          className="w-full rounded-[10px] border px-3 py-2.5 text-[14px] outline-none focus:ring-2"
          style={{ borderColor: "var(--line)", ["--tw-ring-color" as string]: brand }} />
      </label>

      <label className="mb-4 block">
        <span className="mb-1 block text-[12px] font-medium">{t.w.email}</span>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          autoComplete="email" placeholder={t.w.emailPlaceholder}
          className="w-full rounded-[10px] border px-3 py-2.5 text-[14px] outline-none focus:ring-2"
          style={{ borderColor: "var(--line)", ["--tw-ring-color" as string]: brand }} />
      </label>

      {/* Honeypot — caché aux humains, rempli par les bots */}
      <input type="text" name="company" tabIndex={-1} autoComplete="off" value={company}
        onChange={(e) => setCompany(e.target.value)}
        style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }} aria-hidden />

      {/* Zone B — consentement cœur (SEULE partie qui change) */}
      {consentMode === "granular" ? (
        <div className="mb-4">
          <p className="mb-1.5 text-[12px] font-semibold">{t.w.purposesLabel}</p>
          <div className="rounded-xl border p-3" style={{ borderColor: missingConsent ? "#f3c6d4" : "var(--line)", background: "#faf9fb" }}>
            <label className="flex items-start gap-2.5 text-[12.5px]">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className={cbClass} style={{ accentColor: brand }} />
              <span>{t.purpose.content} <span style={{ color: "var(--muted)" }}>{t.w.required}</span></span>
            </label>
            <label className="mt-2 flex items-start gap-2.5 text-[12.5px]">
              <input type="checkbox" checked={offers} onChange={(e) => setOffers(e.target.checked)} className={cbClass} style={{ accentColor: brand }} />
              <span>{t.purpose.offers}</span>
            </label>
            <label className="mt-2 flex items-start gap-2.5 text-[12.5px]">
              <input type="checkbox" checked={events} onChange={(e) => setEvents(e.target.checked)} className={cbClass} style={{ accentColor: brand }} />
              <span>{t.purpose.events}</span>
            </label>
          </div>
        </div>
      ) : (
        <label className="mb-4 flex items-start gap-2.5 text-[12px]" style={{ color: "var(--muted)" }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className={cbClass} style={{ accentColor: brand }} />
          <span>{consentText}</span>
        </label>
      )}

      {/* Zone C — permissions extra (partenaires + suivi), toujours secondaire sous un filet */}
      <div className="mb-4 border-t pt-3" style={{ borderColor: "var(--line)" }}>
        <label className="flex items-start gap-2.5 text-[11.5px]" style={{ color: "var(--muted)" }}>
          <input type="checkbox" checked={partner} onChange={(e) => setPartner(e.target.checked)} className={cbClass} style={{ accentColor: brand }} />
          <span>{t.purpose.partners} <span style={{ opacity: 0.7 }}>{t.w.optional}</span>.</span>
        </label>
        {/* 0092 — marque en « suivi pour tous » : la case serait un faux choix (voir embed/[asset]/page.tsx). */}
        {!trackingForAll && (
          <label className="mt-2 flex items-start gap-2.5 text-[11.5px]" style={{ color: "var(--muted)" }}>
            <input type="checkbox" checked={tracking} onChange={(e) => setTracking(e.target.checked)} className={cbClass} style={{ accentColor: brand }} />
            <span>{t.w.tracking} <span style={{ opacity: 0.7 }}>{t.w.optional}</span>.</span>
          </label>
        )}
      </div>

      {/* Zone D — action */}
      {error && <p className="mb-3 text-[12.5px] font-medium" style={{ color: "#d33" }}>{error}</p>}

      <button type="submit" disabled={state === "sending"}
        className="w-full rounded-[10px] py-2.5 text-[14px] font-semibold text-white transition-opacity disabled:opacity-60"
        style={{ background: brand }}>
        {state === "sending" ? "…" : t.w.submit}
      </button>

      <p className="mt-3 text-center text-[10.5px]" style={{ color: "var(--muted)" }}>{t.w.note}</p>
    </form>
  );
}
