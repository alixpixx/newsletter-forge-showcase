/**
 * ARCHIVER UNE CAMPAGNE — le vocabulaire et les règles PURES, partagés par la route, la liste et la
 * page de campagne (0077).
 *
 * ⚠️ MODULE PUR, SANS `"use client"` ET SANS IMPORT SERVEUR, et c'est voulu : la route (serveur), la
 * liste (composant serveur) et les boutons (composants client) lisent les MÊMES règles. Trois écrans
 * qui décident chacun de leur côté si « Reactivate » redémarre quelque chose finissent par annoncer
 * trois choses différentes pour la même campagne.
 *
 * ⭐ CE QU'ARCHIVER VEUT DIRE (demande d'Alix du 22/09/2026, « quand on archive une campagne ça la
 * met en pause, pause qu'on peut réactiver dans la section archive ») : RANGER la campagne dans
 * l'onglet « Archived » ET la METTRE HORS D'ÉTAT D'ENVOYER. `archived_at` seul n'arrête rien côté
 * worker (voir 0077) : la route arrête la série et annule ses éditions à venir, ou retire du
 * calendrier un envoi unique — puis écrit dans `archived_resume` ce que la réactivation rétablira.
 */

/** Ce que « Reactivate » doit rétablir — la forme lue de `campaign.archived_resume`. */
export interface ArchivedResume {
  /** Le statut AVANT l'archivage (un envoi programmé est remis en `draft` par l'archivage). */
  previousStatus: string;
  /** La série tournait : l'archivage l'a arrêtée, la réactivation la redémarre (par `/arm`). */
  seriesRunning: boolean;
  /** La date d'envoi retirée du calendrier (envoi unique programmé), sinon `null`. */
  scheduledAt: string | null;
  /**
   * Éditions à venir annulées par l'archivage. `null` = l'annulation a échoué (ou n'a pas été
   * comptée) — jamais un zéro inventé : « aucune annulée » et « on ne sait pas » ne se disent pas pareil.
   */
  editionsCancelled: number | null;
}

/** La forme ÉCRITE en base — snake_case, versionnée pour qu'une évolution se reconnaisse. */
export function versLaBase(r: ArchivedResume): Record<string, unknown> {
  return {
    version: 1,
    previous_status: r.previousStatus,
    series_running: r.seriesRunning,
    scheduled_at: r.scheduledAt,
    editions_cancelled: r.editionsCancelled,
  };
}

/**
 * `archived_resume` → forme lue. `null` quand la colonne est vide ou illisible.
 *
 * ⛔ `=== true` pour la série, jamais `Boolean(...)` : une valeur douteuse promue en « elle tournait »
 * ferait REDÉMARRER une série à la réactivation — des e-mails réels — sur la foi d'un octet abîmé.
 */
export function lireResume(raw: unknown): ArchivedResume | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const n = r.editions_cancelled;
  return {
    previousStatus: typeof r.previous_status === "string" ? r.previous_status : "draft",
    seriesRunning: r.series_running === true,
    scheduledAt: typeof r.scheduled_at === "string" && r.scheduled_at !== "" ? r.scheduled_at : null,
    editionsCancelled: typeof n === "number" && Number.isFinite(n) ? n : null,
  };
}

/**
 * CE QUE LA RÉACTIVATION VA FAIRE — décidé ICI, une fois, pour la route ET pour les écrans.
 *
 *  - `serie`       : la série tournait ⇒ elle redémarre, par les MÊMES refus que « Start series » ;
 *  - `programmee`  : un envoi unique était programmé à une date ENCORE À VENIR ⇒ il est reprogrammé à
 *                    cette date, par les MÊMES refus que « Schedule » ;
 *  - `date-passee` : il était programmé, mais la date est passée ⇒ il revient en brouillon, et c'est
 *                    à l'humain de choisir une nouvelle date (un envoi en retard ne part JAMAIS tout seul) ;
 *  - `liste`       : rien ne tournait ⇒ la campagne revient simplement dans la liste, telle quelle.
 *
 * ⚠️ `serie` exige ENCORE une cadence : une cadence retirée pendant l'archivage n'a plus rien à
 * redémarrer, et la route `/arm` le refuserait de toute façon.
 */
export type PlanReactivation =
  | { quoi: "serie" }
  | { quoi: "programmee"; scheduledAt: string }
  | { quoi: "date-passee"; scheduledAt: string }
  | { quoi: "liste" };

export function planDeReactivation(
  c: { recurrenceDays: number[]; archivedResume: ArchivedResume | null },
  maintenantMs: number,
): PlanReactivation {
  const r = c.archivedResume;
  if (!r) return { quoi: "liste" };
  if (r.seriesRunning && c.recurrenceDays.length > 0) return { quoi: "serie" };
  if (r.previousStatus === "scheduled" && r.scheduledAt) {
    // ⛔ Des INSTANTS, jamais des chaînes : PostgREST rend `+00:00`, `toISOString()` rend `.000Z`.
    const t = Date.parse(r.scheduledAt);
    if (Number.isFinite(t) && t > maintenantMs) return { quoi: "programmee", scheduledAt: r.scheduledAt };
    return { quoi: "date-passee", scheduledAt: r.scheduledAt };
  }
  return { quoi: "liste" };
}

/**
 * Le libellé du bouton de l'onglet Archived. « Reactivate » quand quelque chose TOURNAIT (une série,
 * un envoi programmé) : le geste le relance, et le mot doit le dire. « Restore » sinon : on range
 * simplement la campagne dans la liste, rien ne part.
 */
export function libelleReactivation(plan: PlanReactivation): "Reactivate" | "Restore" {
  return plan.quoi === "liste" ? "Restore" : "Reactivate";
}

/**
 * Ce que la campagne faisait AVANT d'être archivée, en une phrase d'écran — la même dans la liste
 * et sur la page. `formatDate` est injecté : la liste et la page ont déjà leur format de date.
 */
export function avantArchivage(
  c: { recurrenceDays: number[]; archivedResume: ArchivedResume | null },
  formatDate: (iso: string) => string,
): string {
  const r = c.archivedResume;
  if (!r) return "Nothing was running.";
  if (r.seriesRunning) {
    const n = r.editionsCancelled;
    const annulees =
      n === null
        ? " Its planned editions could not all be cancelled."
        : n > 0
          ? ` ${n} planned edition${n > 1 ? "s were" : " was"} cancelled.`
          : "";
    return `The series was running — archiving stopped it.${annulees}`;
  }
  if (r.previousStatus === "scheduled" && r.scheduledAt) {
    return `It was scheduled for ${formatDate(r.scheduledAt)} — archiving took it off the schedule.`;
  }
  if (c.recurrenceDays.length > 0 && r.previousStatus === "draft") return "The series was stopped. Nothing was running.";
  return `It was ${r.previousStatus === "draft" ? "a draft" : r.previousStatus}. Nothing was running.`;
}
