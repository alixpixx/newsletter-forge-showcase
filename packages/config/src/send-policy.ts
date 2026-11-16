/**
 * Moteur de politique d'envoi (chantier C4 du plan compliance).
 * Porte de dernier recours appliquée À CHAQUE destinataire au moment de l'envoi,
 * indépendamment de tout cache de segment (règle : le consentement est re-vérifié
 * au send-time). Le worker DOIT appeler `canSend` avant de mettre un email dans le
 * flux Mailgun ; toute décision `ok:false` bloque l'envoi et est journalisée.
 */
import type { ConsentPurpose, GrantedPurposes, LegalBasis } from "./consent";

export interface SendCandidate {
  /** newsletter.subscription.status */
  status: string;
  /** présent dans la liste de suppression (scope global ou de la marque envoyée). */
  suppressed: boolean;
  /** édition en pause / archivée → on n'envoie pas. */
  editionSendEnabled?: boolean;
  /** l'envoi utilise-t-il le pixel d'ouverture / le suivi des clics ? */
  usesTracking?: boolean;
  /** consentement séparé au suivi donné par l'abonné (C2). */
  trackingConsent?: boolean;
  /** finalité de la campagne. undefined = transactionnel → PAS de gate par finalité. */
  purpose?: ConsentPurpose;
  /** snapshot subscription.granted_purposes de l'abonné. */
  grantedPurposes?: GrantedPurposes;
  /** base légale (dérivée du régime de l'édition). */
  legalBasis?: LegalBasis;
  /**
   * Le statut qui donne titre à recevoir CET envoi. Défaut `active`, partout — sauf la ligne d'une
   * campagne qui a visé les contacts hors newsletter (0088), où c'est `contact`.
   * ⛔ UN statut, jamais une liste : « active OU contact » ferait passer un contact sur un envoi
   * d'abonnés, ou un abonné sur un envoi qui a sauté sa finalité.
   */
  requiredStatus?: string;
}

export type SendDecision = { ok: true } | { ok: false; reason: SendBlockReason };

export type SendBlockReason =
  | "suppressed"
  | "not_active"
  | "edition_paused"
  | "no_tracking_consent"
  | "purpose_not_granted";

/**
 * La finalité `p` est-elle autorisée pour cet abonné ?
 *  - `partners` : TOUJOURS un opt-in explicite (partage tiers), quel que soit le marché.
 *  - base `consent` (GDPR/LGPD) : la finalité doit être explicitement accordée (`true`).
 *  - base `opt_out`/`legitimate_interest` (US, B2B) : autorisé SAUF retrait explicite (`false`).
 */
export function purposeAllowed(
  p: ConsentPurpose,
  granted: GrantedPurposes = {},
  basis: LegalBasis = "consent",
): boolean {
  if (p === "partners") return granted.partners === true;
  if (basis === "consent") return granted[p] === true;
  return granted[p] !== false;
}

/**
 * Décide si un email peut partir vers ce destinataire.
 * Ordre : suppression (le plus fort) → statut → édition → finalité → suivi.
 */
export function canSend(c: SendCandidate): SendDecision {
  if (c.suppressed) return { ok: false, reason: "suppressed" };
  if (c.status !== (c.requiredStatus ?? "active")) return { ok: false, reason: "not_active" };
  if (c.editionSendEnabled === false) return { ok: false, reason: "edition_paused" };
  // Gate par finalité : uniquement pour les envois marketing (purpose défini). Les transactionnels
  // (confirmation/welcome/ack) passent purpose=undefined et ne sont jamais bloqués ici.
  if (c.purpose && !purposeAllowed(c.purpose, c.grantedPurposes, c.legalBasis)) {
    return { ok: false, reason: "purpose_not_granted" };
  }
  // Le suivi est facultatif : sans consentement au suivi, on envoie SANS pixel plutôt que
  // de bloquer. On ne bloque que si l'envoi impose le suivi (ex. A/B mesuré à l'ouverture).
  if (c.usesTracking === true && c.trackingConsent !== true) {
    return { ok: false, reason: "no_tracking_consent" };
  }
  return { ok: true };
}

/** Peut-on inclure le pixel/liens suivis pour ce destinataire ? (C2) */
export function canTrack(c: Pick<SendCandidate, "trackingConsent">): boolean {
  return c.trackingConsent === true;
}

/**
 * La PERSONNE peut-elle être suivie (ouverture/clic) ? Le type d'envoi se décide à part.
 * UNE seule vérité pour le worker (`gate.ts`) et l'écran de préférences, qui affiche cet état.
 *
 * ⭐ SUIVI « POUR TOUS » (0092, décision d'Alix du 07/10/2026) : une marque en mode `all` suit tous
 * ses destinataires SAUF ceux qui ont coupé le suivi dans le centre de préférences. En mode `consent`
 * (ou sur une base d'avant 0092, où ces clés manquent) : seulement `trackingConsent === true`.
 *
 * ⛔ LE REFUS EXPLICITE GAGNE TOUJOURS, même contre un consentement resté vrai.
 * ⛔ FAIL-CLOSED : le mode `all` n'ouvre le suivi que si le refus est lu `false` — une clé absente ou
 * nulle ne vaut jamais « pas de refus ».
 */
export function trackingAccepted(c: {
  trackingConsent?: boolean | null;
  trackingMode?: string | null;
  trackingRefused?: boolean | null;
}): boolean {
  if (c.trackingRefused === true) return false;
  if (c.trackingConsent === true) return true;
  return c.trackingMode === "all" && c.trackingRefused === false;
}

/**
 * Traduit `purposeAllowed()` (juste au-dessus) en filtre PostgREST.
 *
 * ⛔ CETTE FONCTION VIT ICI, COLLÉE À LA RÈGLE QU'ELLE TRADUIT, ET C'EST TOUT L'INTÉRêT.
 * Elle a d'abord été écrite dans `apps/admin` pour compter une audience ; le fan-out du worker a
 * besoin d'ÉNUMÉRER exactement la même. Deux copies de la même règle de consentement, c'est la
 * certitude qu'un jour l'écran promet des destinataires que le worker refuse — ou pire, que le
 * worker enfile des gens que l'écran n'avait pas comptés. Toute modification de `purposeAllowed`
 * doit être reportée ici, dans le même fichier, sous les yeux de celui qui édite.
 *
 * Pourquoi ne pas appeler `purposeAllowed` directement ? Parce qu'il faudrait rapatrier le
 * `granted_purposes` des 1 200+ abonnés pour les compter un à un. Le filtre reproduit la MÊME
 * règle, à l'identique :
 *  - `partners` : opt-in explicite, quel que soit le marché ;
 *  - base `consent` (GDPR/LGPD) : la finalité doit valoir `true` ;
 *  - base `opt_out` (CAN-SPAM) : autorisé SAUF retrait explicite (`false`).
 *
 * La base légale vient du régime de l'ÉDITION (`legalBasisForRegime`). Une souscription sans
 * édition retombe sur `consent`, la plus stricte : mieux vaut sous-estimer l'audience que
 * promettre des destinataires que le worker refusera.
 */
export function purposeGateFilter(purpose: ConsentPurpose, optOutEditionIds: string[]): string {
  const col = `granted_purposes->>${purpose}`;
  const granted = `${col}.eq.true`;
  if (purpose === "partners" || optOutEditionIds.length === 0) return granted;

  const list = optOutEditionIds.join(",");
  const notWithdrawn = `or(${col}.is.null,${col}.neq.false)`;
  // `not.in` seul exclurait les NULL (sémantique SQL) : le groupe « consentement » les récupère
  // explicitement via `edition_id.is.null`.
  return (
    `or(and(edition_id.in.(${list}),${notWithdrawn}),` +
    `and(or(edition_id.is.null,edition_id.not.in.(${list})),${granted}))`
  );
}
