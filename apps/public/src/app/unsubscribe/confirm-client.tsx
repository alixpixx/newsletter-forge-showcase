"use client";

import { useState } from "react";

/**
 * Le bouton qui désabonne — et la raison pour laquelle il existe.
 *
 * ⛔ C'EST LE CLIC QUI ÉCRIT, PAS LE RENDU. La page ne fait plus aucune écriture au GET : un
 * antivirus de messagerie ou un proxy qui pré-charge le lien voit maintenant cette question, et
 * repart sans avoir rien désabonné. Avant le 18/09/2026 il désabonnait pour de bon, en laissant une
 * trace qui affirmait que la personne l'avait demandé.
 *
 * ⛔ AUCUN DÉSABONNEMENT AUTOMATIQUE ICI NON PLUS. Pas d'`useEffect` qui appellerait la route au
 * montage : ce serait remettre le même défaut un étage plus bas, et il repasserait inaperçu parce
 * que l'écran afficherait exactement ce qu'on attend.
 */

type Textes = {
  confirmTitle: string;
  confirmBody: string;
  confirmCta: string;
  doneTitle: string;
  doneBody: string;
  managePrefs: string;
  failed: string;
};

function Shell({ ok, title, children }: { ok: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4" style={{ background: "#f7f7fb" }}>
      <div className="w-full max-w-[420px] rounded-2xl border bg-white p-7 text-center" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto mb-3.5 flex h-12 w-12 items-center justify-center rounded-full" style={{ background: "#f0f0f4" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={ok ? "#1f9d57" : "#999"} strokeWidth="2.3">
            {ok ? <path d="M20 6L9 17l-5-5" /> : <path d="M18 6L6 18M6 6l12 12" />}
          </svg>
        </div>
        <h1 className="text-[19px] font-bold tracking-tight">{title}</h1>
        <div className="mt-1.5 text-[13.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{children}</div>
      </div>
    </div>
  );
}

export function UnsubscribeConfirm({
  token,
  lang,
  prefsUrl,
  textes,
}: {
  token: string;
  lang: string;
  assetName: string;
  prefsUrl: string;
  textes: Textes;
}) {
  const [etat, setEtat] = useState<"question" | "envoi" | "fait" | "echec">("question");

  async function desabonner() {
    if (etat === "envoi") return;
    setEtat("envoi");
    try {
      const r = await fetch("/api/v1/unsubscribe/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, lang }),
      });
      /**
       * ⛔ ON NE DIT « fait » QUE SUR UN VRAI SUCCÈS. Afficher la confirmation quoi qu'il arrive
       * laisserait quelqu'un partir en croyant être désabonné, et recevoir la campagne suivante.
       */
      setEtat(r.ok ? "fait" : "echec");
    } catch {
      setEtat("echec");
    }
  }

  if (etat === "fait") {
    return (
      <Shell ok title={textes.doneTitle}>
        {textes.doneBody}
        <div className="mt-4">
          <a href={prefsUrl} className="text-[12.5px] font-medium underline" style={{ color: "var(--muted)" }}>
            {textes.managePrefs}
          </a>
        </div>
      </Shell>
    );
  }

  return (
    <Shell ok={false} title={textes.confirmTitle}>
      {textes.confirmBody}
      <div className="mt-4">
        <button
          type="button"
          onClick={desabonner}
          disabled={etat === "envoi"}
          className="w-full rounded-[10px] px-4 py-2.5 text-[13.5px] font-semibold text-white transition-opacity disabled:opacity-60"
          style={{ background: "#111" }}
        >
          {textes.confirmCta}
        </button>
      </div>
      {etat === "echec" && (
        <p className="mt-3 text-[12.5px]" style={{ color: "#b4341f" }}>
          {textes.failed}
        </p>
      )}
      <div className="mt-4">
        <a href={prefsUrl} className="text-[12.5px] font-medium underline" style={{ color: "var(--muted)" }}>
          {textes.managePrefs}
        </a>
      </div>
    </Shell>
  );
}
