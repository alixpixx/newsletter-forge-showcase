/**
 * Analytics › Audience (0094) : mise en forme de la réponse de `audience_engagement` — carte des
 * moments, niveaux, sources, semaines.
 *
 * ⛔ MODULE NEUTRE (ni `getDb`, ni session, ni "use client") : importé par la page serveur et par ses
 * composants, testé sans rendu.
 */
import { debutPeriode, type Periode } from "@/lib/analytics-params";
import { rapport } from "@/lib/automation-view";
import {
  JOURS_ISO,
  METRIQUES_SEMAINE,
  type CaseCarte,
  type MetriqueSemaine,
  type SourceAudience,
} from "@/lib/engagement";

const JOUR_MS = 86_400_000;

/**
 * « All time » côté audience. ⛔ `audience_engagement` lit un `p_since` NUL comme « 26 dernières
 * semaines » : passer `undefined` pour « tout » afficherait six mois sous l'étiquette « All time ».
 */
export const DEBUT_TOUT = "2000-01-01T00:00:00.000Z";

export function debutAudience(p: Periode, maintenant: Date): Date {
  return debutPeriode(p, maintenant) ?? new Date(DEBUT_TOUT);
}

// ---------------------------------------------------------------------------------------------
// Carte des moments (jour × heure)
// ---------------------------------------------------------------------------------------------
export interface Grille {
  /** `valeurs[dow - 1][hour]` : lignes lundi → dimanche, colonnes 0 h → 23 h. */
  valeurs: number[][];
  max: number;
  total: number;
}

/** La grille 7 × 24 d'une mesure ; une case absente de la réponse (creuse) vaut 0 — rien n'y a eu lieu. */
export function grilleCarte(cases: CaseCarte[], mesure: "opens" | "clicks"): Grille {
  const valeurs = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let total = 0;
  for (const c of cases) {
    // Déjà borné par `lireAudience` ; une case hors grille est ignorée plutôt que d'agrandir le tableau.
    if (c.dow < 1 || c.dow > 7 || c.hour < 0 || c.hour > 23) continue;
    valeurs[c.dow - 1][c.hour] += c[mesure];
    total += c[mesure];
  }
  const max = Math.max(0, ...valeurs.map((ligne) => Math.max(...ligne)));
  return { valeurs, max, total };
}

/**
 * L'opacité du fond d'une case (0..1) : 0 pour une case vide, au moins 0,15 pour une case non vide
 * (qu'une seule ouverture se voie encore), 1 pour le maximum.
 */
export function intensite(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  return 0.15 + 0.85 * Math.min(1, v / max);
}

/** Les `n` meilleures cases non vides, de la plus forte à la plus faible (à égalité : lundi d'abord, puis l'heure). */
export function meilleursCreneaux(g: Grille, n: number): { dow: number; hour: number; value: number }[] {
  const r: { dow: number; hour: number; value: number }[] = [];
  g.valeurs.forEach((ligne, i) => ligne.forEach((value, hour) => value > 0 && r.push({ dow: i + 1, hour, value })));
  return r.sort((a, b) => b.value - a.value || a.dow - b.dow || a.hour - b.hour).slice(0, n);
}

const deuxChiffres = (h: number) => String(h).padStart(2, "0");

/** « Tue 09:00–09:59 ». */
export function libelleCreneau(dow: number, hour: number): string {
  return `${JOURS_ISO[dow - 1] ?? "?"} ${deuxChiffres(hour)}:00–${deuxChiffres(hour)}:59`;
}

// ---------------------------------------------------------------------------------------------
// Niveaux d'engagement des abonnés actifs
// ---------------------------------------------------------------------------------------------
const ORDRE_NIVEAUX = ["active", "dormant", "churned"];
const LIBELLE_NIVEAU: Record<string, string> = { active: "Active", dormant: "Dormant", churned: "Churned", unknown: "Unknown" };

export interface LigneNiveau {
  level: string;
  label: string;
  count: number;
  /** Part des abonnés actifs ; `null` s'il n'y en a aucun. */
  share: number | null;
}

/** Les niveaux dans l'ordre active → dormant → churned, puis les autres (alphabétique), « unknown » en dernier. */
export function lignesNiveaux(levels: Record<string, number>): LigneNiveau[] {
  const total = Object.values(levels).reduce((a, b) => a + b, 0);
  const rang = (k: string) => {
    const i = ORDRE_NIVEAUX.indexOf(k);
    return i >= 0 ? i : k === "unknown" ? Number.MAX_SAFE_INTEGER : ORDRE_NIVEAUX.length;
  };
  return Object.keys(levels)
    .sort((a, b) => rang(a) - rang(b) || a.localeCompare(b))
    .map((level) => ({
      level,
      label: LIBELLE_NIVEAU[level] ?? level,
      count: levels[level],
      share: rapport(levels[level], total),
    }));
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------
/** Les libellés du tiroir abonné (`subscriber-drawer.tsx`) ; `unknown` = source jamais renseignée. */
const LIBELLE_SOURCE: Record<string, string> = {
  organic: "Organic",
  social: "Social media",
  crm_sync: "CRM sync",
  import: "Import",
  content_upgrade: "Content upgrade",
  unknown: "Unknown",
};

export function libelleSource(s: string): string {
  return LIBELLE_SOURCE[s] ?? s;
}

/** Part des actifs qui ont déjà ouvert ou cliqué ; `null` sans aucun actif — jamais 0 %. */
export function partEngagee(s: Pick<SourceAudience, "engaged" | "active">): number | null {
  return rapport(s.engaged, s.active);
}

// ---------------------------------------------------------------------------------------------
// Semaine par semaine
// ---------------------------------------------------------------------------------------------
export interface LigneSemaine {
  /** Le lundi de la semaine, `YYYY-MM-DD`, dans le fuseau de la marque. */
  week: string;
  counts: Record<MetriqueSemaine, number>;
}

const zeros = () => Object.fromEntries(METRIQUES_SEMAINE.map((m) => [m, 0])) as Record<MetriqueSemaine, number>;
const jourUtc = (t: number) => new Date(t).toISOString().slice(0, 10);
const instantDuJour = (j: string) => Date.parse(`${j}T00:00:00Z`);

/** Le jour calendaire d'un instant dans le fuseau `tz` (`YYYY-MM-DD`) ; fuseau illisible ⇒ UTC. */
export function jourLocal(instant: Date, tz: string): string {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(instant);
    const v = (t: string) => p.find((x) => x.type === t)?.value;
    const j = `${v("year")}-${v("month")}-${v("day")}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(j)) return j;
  } catch {
    // Fuseau inconnu de l'environnement : repli UTC (la semaine peut alors glisser d'un jour).
  }
  return instant.toISOString().slice(0, 10);
}

/** Le lundi de la semaine d'un jour `YYYY-MM-DD` (semaine ISO, comme `date_trunc('week', …)`). */
export function lundi(jour: string): string {
  const t = instantDuJour(jour);
  if (!Number.isFinite(t)) return jour;
  const depuisLundi = (new Date(t).getUTCDay() + 6) % 7;
  return jourUtc(t - depuisLundi * JOUR_MS);
}

/**
 * Les bornes du tableau des semaines, en lundis du fuseau de la marque : du début de la période
 * (`since` rendu par la base) à la semaine en cours. « All time » n'a pas de début : on ne remplit pas
 * depuis l'an 2000. Un `since` illisible ne borne rien (jamais une exception au rendu).
 */
export function bornesSemaines(
  since: string,
  periode: Periode,
  maintenant: Date,
  tz: string,
): { debut: string | null; fin: string } {
  const t = Date.parse(since);
  return {
    debut: periode === "all" || !Number.isFinite(t) ? null : lundi(jourLocal(new Date(t), tz)),
    fin: lundi(jourLocal(maintenant, tz)),
  };
}

/**
 * Le pivot de `weekly` (creux) : une ligne par semaine, une colonne par métrique, la plus récente en
 * haut. Les semaines SANS AUCUN événement entre `debut` (ou la première semaine lue) et `fin` (ou la
 * dernière lue) sont ajoutées à 0 : ici, 0 est un vrai compte — rien n'a eu lieu cette semaine-là.
 *
 * ⚠️ `debut` est `null` pour « All time » : on ne remplit pas depuis l'an 2000, on part de la première
 * semaine qui a quelque chose.
 */
export function pivotSemaines(
  weekly: { week: string; metric: MetriqueSemaine; count: number }[],
  bornes: { debut: string | null; fin: string | null } = { debut: null, fin: null },
): LigneSemaine[] {
  const par = new Map<string, Record<MetriqueSemaine, number>>();
  for (const w of weekly) {
    const r = par.get(w.week) ?? zeros();
    r[w.metric] += w.count;
    par.set(w.week, r);
  }
  if (par.size === 0) return [];
  const lues = [...par.keys()].sort();
  const premier = bornes.debut !== null && bornes.debut < lues[0] ? bornes.debut : lues[0];
  const dernier = bornes.fin !== null && bornes.fin > lues[lues.length - 1] ? bornes.fin : lues[lues.length - 1];
  const t0 = instantDuJour(premier);
  const t1 = instantDuJour(dernier);
  // Borne de sûreté : 40 ans de semaines, jamais une boucle sans fin sur une date folle.
  if (Number.isFinite(t0) && Number.isFinite(t1) && (t1 - t0) / (7 * JOUR_MS) <= 2_100) {
    for (let t = t0; t <= t1; t += 7 * JOUR_MS) {
      const k = jourUtc(t);
      if (!par.has(k)) par.set(k, zeros());
    }
  }
  return [...par.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([week, counts]) => ({ week, counts }));
}
