/**
 * Analytics › Automations (0094) : les taux et l'entonnoir d'une automation, par étape et en cumul.
 *
 * ⛔ MODULE NEUTRE (ni `getDb`, ni session, ni "use client") : importé par la page serveur et par ses
 * composants, testé sans rendu.
 *
 * ⛔ UN TAUX NON MESURABLE EST `null`, JAMAIS 0 : un dénominateur nul s'écrit « — » à l'écran, avec la
 * raison. Les envois SIMULÉS n'entrent dans AUCUN taux : rien n'est parti, rien n'a pu être délivré.
 */
import type { EtapeAutomation } from "@/lib/engagement";

/** Les compteurs d'une étape, ou du cumul de toutes (`cumulAutomation`). */
export type CompteursAutomation = Omit<EtapeAutomation, "step" | "lastAt">;

/** `n / d` en fraction (0..1), ou `null` si `d` est nul — jamais 0, jamais NaN. */
export function rapport(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

/**
 * Pourquoi l'ouverture et le clic ne sont PAS mesurés sur ces compteurs — `null` s'ils le sont.
 *
 * ⚠️ `opened` et `clicked` comptent tout destinataire qui a un événement, `tracked` seulement les
 * délivrés dont le suivi était ACTIF à l'envoi. Plus d'ouvreurs que de suivis = des ouvertures venues
 * de destinataires au suivi non mémorisé : le quotient dépasserait 100 %, on ne l'affiche pas.
 */
export function raisonNonMesure(c: CompteursAutomation): string | null {
  if (c.real === 0) {
    return c.simulated > 0
      ? "Not measured — simulated sends only: nothing was actually sent."
      : "Not measured — nothing sent.";
  }
  if (c.delivered === 0) return "Not measured — nothing delivered yet.";
  if (c.tracked === 0) {
    return `Not measured — 0 of ${c.delivered.toLocaleString("en-US")} delivered recipients allow open and click tracking.`;
  }
  if (c.opened > c.tracked || c.clicked > c.tracked) {
    return "Not measured — some opens or clicks come from recipients whose tracking was not recorded.";
  }
  return null;
}

export interface TauxAutomation {
  /** Acceptés par le fournisseur / envois réels. */
  sentRate: number | null;
  /** Délivrés / acceptés. */
  deliveryRate: number | null;
  /** Rebonds / acceptés. */
  bounceRate: number | null;
  /** Ouvreurs / délivrés suivis. */
  openRate: number | null;
  /** Cliqueurs / délivrés suivis. */
  clickRate: number | null;
}

/** Les taux d'une étape ou d'un cumul. `null` = non mesurable (dénominateur nul, ou suivi absent). */
export function tauxAutomation(c: CompteursAutomation): TauxAutomation {
  const mesure = raisonNonMesure(c) === null;
  return {
    sentRate: rapport(c.sent, c.real),
    deliveryRate: rapport(c.delivered, c.sent),
    bounceRate: rapport(c.bounced, c.sent),
    openRate: mesure ? rapport(c.opened, c.tracked) : null,
    clickRate: mesure ? rapport(c.clicked, c.tracked) : null,
  };
}

/** Le dernier envoi (réel OU simulé) de toutes les étapes, ou `null` si aucune n'en a. */
export function dernierEnvoi(steps: Pick<EtapeAutomation, "lastAt">[]): string | null {
  let meilleur: string | null = null;
  let t = -Infinity;
  for (const s of steps) {
    const ts = s.lastAt === null ? NaN : Date.parse(s.lastAt);
    if (Number.isFinite(ts) && ts > t) {
      t = ts;
      meilleur = s.lastAt;
    }
  }
  return meilleur;
}
