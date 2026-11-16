import type { LiveSegmentSize } from "@/lib/data/segment-sizes";

/**
 * CE QUE LA COLONNE « Last measured size » AFFICHE — décidé ici, sans React, pour qu'un banc le mesure.
 *
 * ⛔ LE COMPTE MESURÉ AU CHARGEMENT PRIME TOUJOURS sur l'instantané enregistré (`cached_count`, écrit une
 * seule fois, à la création du segment : il ne suivait pas les inscriptions — bug du 25/09/2026).
 *
 * ⛔ SI LA MESURE ÉCHOUE, L'INSTANTANÉ REVIENT AVEC SA DATE ET LA RAISON. Jamais un zéro inventé, jamais
 * l'ancien chiffre présenté comme s'il était d'aujourd'hui : un nombre sans son âge laisserait croire
 * qu'il est frais.
 */

export type SavedSegmentSizeView =
  | { kind: "live"; count: number }
  | { kind: "stale"; count: number; at: string | null; why: string }
  | { kind: "none"; why: string };

const POURQUOI: Record<string, string> = {
  "no-db": "database unavailable",
  "unreadable-rule": "the rule can't be read",
  "lookup-failed": "the count query failed",
};

export function whyNotMeasured(live: LiveSegmentSize | null): string {
  if (!live || live.ok) return "Not re-measured";
  if (live.reason === "targeting-incomplete") {
    const u = live.unsupported ?? [];
    return `Not re-measured: targeting incomplete${u.length > 0 ? ` (${u.join(", ")})` : ""}`;
  }
  return `Not re-measured: ${POURQUOI[live.reason] ?? live.reason}`;
}

export function savedSegmentSize(
  stored: { count: number | null; at: string | null },
  live: LiveSegmentSize | null,
): SavedSegmentSizeView {
  if (live?.ok) return { kind: "live", count: live.count };
  const why = whyNotMeasured(live);
  if (stored.count === null) return { kind: "none", why };
  return { kind: "stale", count: stored.count, at: stored.at, why };
}
