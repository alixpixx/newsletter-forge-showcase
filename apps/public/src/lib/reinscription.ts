/**
 * QUELLE SUPPRESSION BLOQUE CETTE INSCRIPTION — décidé ici, hors de la route (qui n'a pas de banc).
 *
 * ⭐ DEPUIS 0073 (22/09/2026, Alix : « si la personne se reinscrit on l'a reme dans le systeme »), une
 * personne effacée ou désinscrite de toutes les marques peut revenir : elle repart `pending`, reçoit
 * son lien, et c'est SON CLIC qui lève l'ancienne suppression (`confirm/page.tsx`).
 *
 * ⛔ MAIS SEULEMENT SI C'EST ELLE QUI S'INSCRIT. L'import CSV et l'ajout manuel de l'admin passent par
 * la même route (`source_detail.origin = "admin"`, `apps/admin/src/lib/ingestion.ts`), et l'admin
 * promet : « the address can never be re-added by an import ». Un import rouvrirait la porte à une
 * personne qui a demandé l'oubli sans qu'elle ait rien fait — et recréerait son adresse en clair.
 *
 * ⚠️ LE SENS DU DÉFAUT EST DÉLIBÉRÉ : on nomme les gestes de la personne (le formulaire public, le
 * popup de capture), tout le reste garde la suppression COMPLÈTE — admin, synchro CRM, appelant
 * serveur qui ne dit pas d'où il vient.
 */
export type VerificationSuppression = "is_hard_suppressed" | "is_suppressed";

/** Les appelants serveur dont chaque contact est une personne qui a rempli un formulaire. */
export const ORIGINES_GESTE_PERSONNEL = ["optinforge"] as const;

/**
 * ⛔ UN CONTACT HORS NEWSLETTER (0088) PASSE TOUJOURS LA SUPPRESSION COMPLÈTE, même venu du popup.
 * La levée d'une suppression tient au CLIC de confirmation ; un contact n'en reçoit jamais. La
 * suppression douce ne serait donc plus levée par personne : elle serait simplement ignorée, et une
 * personne désinscrite redeviendrait atteignable par une campagne sans avoir rien confirmé.
 */
export function verificationSuppression(
  serverIngest: boolean,
  origine: unknown,
  mode: "subscribe" | "contact" = "subscribe",
): VerificationSuppression {
  if (mode === "contact") return "is_suppressed";
  if (!serverIngest) return "is_hard_suppressed"; // le formulaire public : la personne elle-même
  return (ORIGINES_GESTE_PERSONNEL as readonly unknown[]).includes(origine) ? "is_hard_suppressed" : "is_suppressed";
}
