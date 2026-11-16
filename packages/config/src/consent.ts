/**
 * Finalités de consentement — SOURCE UNIQUE partagée par la route signup, le gate d'envoi et le
 * widget (pas de DB enum → cette constante évite toute dérive de clés jsonb `granted_purposes`).
 *
 * Modèle : le kit de conformité Example Media énumère les communications par catégorie. Le consentement
 * générique est invalide en marché strict → on trace la finalité accordée par abonné.
 *  - content  : newsletter & contenus (finalité cœur, requise pour s'abonner)
 *  - offers   : offres & promotions
 *  - events   : événements & invitations
 *  - partners : offres de partenaires (partage tiers) — TOUJOURS un opt-in séparé et explicite
 */
export type ConsentPurpose = "content" | "offers" | "events" | "partners";

/** Finalités cœur (celles proposées dans la Zone B du widget). `partners` est traité à part. */
export const CORE_PURPOSES = ["content", "offers", "events"] as const;
export const ALL_PURPOSES: ConsentPurpose[] = ["content", "offers", "events", "partners"];

/** Snapshot d'état stocké sur subscription.granted_purposes. */
export type GrantedPurposes = Partial<Record<ConsentPurpose, boolean>>;

/** Base légale du traitement, dérivée du régime de l'édition. */
export type LegalBasis = "consent" | "legitimate_interest" | "opt_out";

/** GDPR/LGPD = consentement ; CAN-SPAM (US) = opt-out. B2B (PECR corporate…) = legitimate_interest au cas par cas. */
export function legalBasisForRegime(regime: "gdpr" | "lgpd" | "canspam" | string | null | undefined): LegalBasis {
  return regime === "canspam" ? "opt_out" : "consent";
}
