/**
 * Engagement d'une campagne (0094) — ce que l'écran ET l'export CSV en tirent : tranches de délai
 * jusqu'à la première action, suivi coupé, taux de clic sur ouverture, lignes du CSV.
 *
 * ⛔ MODULE NEUTRE (comme `campaign-stats.ts`) : ni `getDb`, ni session, ni "use client" — importé par
 * la page serveur, ses sections et la route d'export, pour qu'elles disent la MÊME chose.
 *
 * ⛔ Ce qui n'est pas mesuré n'est jamais 0 : à l'écran « — » ou la raison, dans le CSV une cellule
 * VIDE (un tableur additionnerait le zéro).
 */
import { DIMENSIONS, valeurDimension, type EngagementCampagne, type NomDimension } from "@/lib/engagement";

/** Les tranches lisibles du délai jusqu'à la 1re action ; `hour` vaut floor(heures), 72 = « 72 h et plus ». */
export const TRANCHES_HEURES = [
  { label: "0-1h", de: 0, a: 1 },
  { label: "1-2h", de: 1, a: 2 },
  { label: "2-3h", de: 2, a: 3 },
  { label: "3-6h", de: 3, a: 6 },
  { label: "6-12h", de: 6, a: 12 },
  { label: "12-24h", de: 12, a: 24 },
  { label: "24-48h", de: 24, a: 48 },
  { label: "48-72h", de: 48, a: 72 },
  { label: "72h+", de: 72, a: Number.POSITIVE_INFINITY },
] as const;

export interface Tranche {
  label: string;
  opens: number;
  clicks: number;
}

/** Les heures (creuses : une heure absente vaut 0) regroupées en tranches, toutes présentes, dans l'ordre. */
export function regrouperPremieresActions(heures: EngagementCampagne["firstActionHours"]): Tranche[] {
  return TRANCHES_HEURES.map((t) => {
    let opens = 0;
    let clicks = 0;
    for (const h of heures) {
      if (h.hour >= t.de && h.hour < t.a) {
        opens += h.opens;
        clicks += h.clicks;
      }
    }
    return { label: t.label, opens, clicks };
  });
}

/**
 * ⛔ SUIVI COUPÉ POUR TOUS LES ENVOIS : ouvertures et clics NON MESURÉS. Afficher leurs zéros se lirait
 * « personne n'a rien ouvert ». (Un envoi d'avant 0085 — `trackingUnknown` — n'est pas « coupé » : on
 * ne sait pas, et ses événements éventuels comptent.)
 */
export function suiviCoupe(e: Pick<EngagementCampagne, "sent" | "tracked" | "trackingUnknown">): boolean {
  return e.sent > 0 && e.tracked === 0 && e.trackingUnknown === 0;
}

/** Clics uniques ÷ ouvertures uniques HUMAINES ; `null` (« — ») sans ouverture humaine. */
export function tauxClicSurOuverture(e: Pick<EngagementCampagne, "opens" | "clicks">): number | null {
  return e.opens.uniqueHuman > 0 ? e.clicks.unique / e.opens.uniqueHuman : null;
}

/** Titre de la section à l'écran, et nom de la section dans le CSV. */
export const LIBELLES_DIMENSIONS: Record<NomDimension, { titre: string; section: string }> = {
  device: { titre: "Devices", section: "Device" },
  client: { titre: "Email clients", section: "Email client" },
  os: { titre: "Operating systems", section: "Operating system" },
  country: { titre: "Countries", section: "Country" },
  city: { titre: "Cities", section: "City" },
};

export const COLONNES_ENGAGEMENT_CSV = ["Section", "Value", "Unique", "Total"] as const;

/**
 * Les lignes du CSV d'engagement (`?part=engagement`). `selection` dit ce que couvre le fichier
 * (« All editions », « #3 · Sep 23, 2026 », « Single send »).
 * Unique = destinataires distincts ; Total = événements.
 */
export function lignesEngagementCsv(e: EngagementCampagne, selection: string): string[][] {
  const mesure = !suiviCoupe(e);
  const n = (v: number) => String(v);
  const m = (v: number) => (mesure ? String(v) : "");
  const ctor = tauxClicSurOuverture(e);

  const lignes: string[][] = [
    ["Selection", selection, "", ""],
    ["Summary", "Sent", n(e.sent), ""],
    ["Summary", "Tracked recipients", n(e.tracked), ""],
    ["Summary", "Tracking unknown (sent before tracking was recorded)", n(e.trackingUnknown), ""],
    ["Summary", "Opens", m(e.opens.unique), m(e.opens.total)],
    ["Summary", "Human opens", m(e.opens.uniqueHuman), ""],
    ["Summary", "Machine opens", "", m(e.opens.bot)],
    ["Summary", "Clicks", m(e.clicks.unique), m(e.clicks.total)],
    ["Summary", "Click-to-open rate (%)", mesure && ctor !== null ? (ctor * 100).toFixed(1) : "", ""],
  ];
  if (!mesure) {
    lignes.push(["Summary", "Opens and clicks not measured: tracking was off for these sends", "", ""]);
    return lignes;
  }

  for (const l of e.links) lignes.push(["Link", l.url, n(l.unique), n(l.total)]);
  const tranches = regrouperPremieresActions(e.firstActionHours);
  for (const t of tranches) lignes.push(["First open", t.label, n(t.opens), ""]);
  for (const t of tranches) lignes.push(["First click", t.label, n(t.clicks), ""]);
  for (const d of DIMENSIONS) {
    for (const r of e.dimensions[d]) {
      lignes.push([LIBELLES_DIMENSIONS[d].section, valeurDimension(r.value), n(r.unique), n(r.total)]);
    }
  }
  return lignes;
}
