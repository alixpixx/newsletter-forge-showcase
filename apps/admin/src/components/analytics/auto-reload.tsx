"use client";

/**
 * Recharge la page à intervalle régulier — posé par l'encart « Sending now » d'Analytics (0096), et
 * SEULEMENT tant qu'un envoi est en cours : sans envoi, rien n'est rendu, donc rien ne recharge.
 *
 * ⛔ UN VRAI RECHARGEMENT, PAS `router.refresh()` : mesuré le 07/10/2026 sur le build de production
 * (Next 16.2.4), le refresh part, le serveur répond… et l'écran ne change pas (voir
 * `visibility-button.tsx`). Des chiffres d'envoi figés qui se donnent pour « en direct » seraient pires
 * que pas de rafraîchissement du tout.
 *
 * Ne recharge pas un onglet caché (personne ne regarde), ni pendant une saisie (la recherche serait perdue).
 */

import { useEffect } from "react";

export function AutoReload({ seconds }: { seconds: number }) {
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const actif = document.activeElement;
      if (actif && (actif.tagName === "INPUT" || actif.tagName === "TEXTAREA" || actif.tagName === "SELECT")) return;
      window.location.reload();
    }, seconds * 1000);
    return () => window.clearInterval(id);
  }, [seconds]);
  return null;
}
