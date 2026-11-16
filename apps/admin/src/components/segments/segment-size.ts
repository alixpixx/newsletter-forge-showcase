/**
 * CE QUE LA CASE « Segment size » AFFICHE — décidé ici, sans React, pour qu'un banc le mesure.
 *
 * ⛔ AUCUN CHIFFRE QUI NE VIENT PAS D'UNE LECTURE (24/09/2026). Quand la base ne répondait pas, ou
 * refusait la règle, l'écran affichait `estimate()` de `@nf/segments` : 128 450 abonnés FICTIFS
 * multipliés par une sélectivité inventée, sous l'intitulé « Estimated size ». Un nombre à côté d'un
 * bouton « Save segment » se lit comme un compte, quel que soit le petit badge qui l'accompagne — et
 * ce nombre ne décrivait personne. Désormais : « Size unavailable », avec la raison (base injoignable,
 * ou règle refusée), et rien d'autre. `estimate()` a été retirée du paquet.
 *
 * ⛔ Même règle pour le pourcentage : sans total actif LU (`baseTotal` à 0 = non lu ou marque vide),
 * pas de « % of active » calculé sur un dénominateur de repli.
 */

export interface LiveCount {
  count: number | null;
  widened: boolean;
  /** Motif nommé par `/api/segments/count` : `"query-failed"` = la base a répondu et REFUSÉ la règle. */
  reason: string | null;
}

export type SegmentSize =
  | { kind: "loading" }
  | { kind: "count"; size: number; pct: number | null }
  | { kind: "widened" }
  | { kind: "unavailable"; cause: "rejected" | "database"; message: string };

export const SIZE_UNAVAILABLE = "Size unavailable";

export function segmentSize(live: LiveCount | null, baseTotal: number, loading: boolean): SegmentSize {
  // Le ciblage s'est ÉLARGI : aucun compte, même lu, n'est montré (voir le bandeau rouge du constructeur).
  if (live?.widened) return { kind: "widened" };
  if (live && live.count !== null) {
    return { kind: "count", size: live.count, pct: baseTotal > 0 ? (live.count / baseTotal) * 100 : null };
  }
  // Première lecture en cours : on attend, on n'invente rien pour meubler.
  if (loading && live === null) return { kind: "loading" };
  // ⛔ Comparaison FERMÉE sur le motif nommé : tout autre échec (`no-db`, réseau, `live` à null) est
  // « base injoignable », jamais « règle refusée » — ce sont deux gestes opposés.
  if (live?.reason === "query-failed") {
    return {
      kind: "unavailable",
      cause: "rejected",
      message: "The database refused this rule: adjust the rule, then retry.",
    };
  }
  return { kind: "unavailable", cause: "database", message: "The database could not be reached." };
}
