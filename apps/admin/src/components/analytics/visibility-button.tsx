"use client";

/**
 * « Hide from analytics » / « Show in analytics » — la bascule de la fiche d'analytics d'une campagne
 * (0093, route `api/campaigns/[id]/analytics-visibility`).
 *
 * Pas de confirmation : le geste ne touche ni l'envoi, ni les chiffres, et se défait d'un clic. La
 * page se RECHARGE ensuite pour que badge et bouton disent l'état RELU, pas l'état supposé.
 * ⛔ Un refus (0093 absente, campagne introuvable…) s'affiche tel quel sous le bouton.
 *
 * ⛔ UN VRAI RECHARGEMENT, PAS `router.refresh()`. Mesuré le 07/10/2026 sur le build de production
 * (Next 16.2.4) : sur une route `[id]` chargée directement, le refresh part, le serveur renvoie le
 * nouvel état… et l'écran ne change pas (vercel/next.js#99028, ouvert). Le bouton disait encore
 * « Hide » sur une campagne déjà masquée — et un 2e clic l'aurait réaffichée.
 */

import { useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { readError } from "@/components/campaigns/shared";

export function VisibilityButton({ campaignId, hidden }: { campaignId: string; hidden: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function basculer(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/analytics-visibility`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: !hidden }),
      });
      if (!res.ok) {
        setError(await readError(res));
        setBusy(false);
        return;
      }
      // `busy` reste allumé : le bouton reste désarmé jusqu'à ce que la page rechargée le remplace.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  const Icone = hidden ? Eye : EyeOff;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={basculer}
        disabled={busy}
        title={
          hidden
            ? "Put this campaign back in the analytics lists."
            : "Leave this campaign out of the analytics lists (e.g. a test send). Nothing is deleted: its figures stay on this page and in exports."
        }
        className="inline-flex items-center gap-2 rounded-[9px] border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? (
          <Loader2 className="h-[14px] w-[14px] animate-spin" aria-hidden="true" />
        ) : (
          <Icone className="h-[14px] w-[14px]" strokeWidth={2} aria-hidden="true" />
        )}
        {hidden ? "Show in analytics" : "Hide from analytics"}
      </button>
      {error && (
        <span role="alert" className="max-w-[320px] text-right text-[12px] text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}
