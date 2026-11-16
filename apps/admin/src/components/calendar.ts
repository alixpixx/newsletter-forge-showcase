/**
 * Arithmétique de dates CIVILES pour le sélecteur de date — « 18 septembre 2026 », pas un instant.
 *
 * ⛔ Tout se calcule en UTC (`Date.UTC`, `getUTC*`) alors qu'on manipule des dates sans fuseau :
 * c'est VOLONTAIRE. Avec un `new Date(2026, 8, 6)` local, un jour ajouté dans un fuseau qui change
 * d'heure cette nuit-là peut rendre le MÊME jour (ou en sauter un) — le bug classique des
 * calendriers maison. Une date civile n'a pas de fuseau : on la traite comme un compteur de jours.
 *
 * La conversion « date civile + heure + fuseau → instant UTC » n'est PAS ici : elle est déjà écrite
 * et éprouvée dans `campaigns/shared.ts` (`zonedToIso`, `isoToZonedFields`).
 */

/** "YYYY-MM-DD" → [année, mois 1-12, jour], ou `null` si la chaîne n'est pas une date valide. */
export function parseYmd(ymd: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Le 31 février se parse sans broncher dans un `Date` : on vérifie que la date existe vraiment.
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return [y, mo, d];
}

/** [année, mois 1-12, jour] → "YYYY-MM-DD". */
export function toYmd(year: number, month: number, day: number): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(year, 4)}-${p(month)}-${p(day)}`;
}

/** Décale une date civile de `delta` jours (négatif accepté). Rend la chaîne inchangée si elle est illisible. */
export function addDaysYmd(ymd: string, delta: number): string {
  const parts = parseYmd(ymd);
  if (!parts) return ymd;
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + delta));
  return toYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Décale de `delta` MOIS en gardant le dernier jour du mois quand le jour n'existe pas (31 janv. + 1 mois = 28/29 févr.). */
export function addMonthsYmd(ymd: string, delta: number): string {
  const parts = parseYmd(ymd);
  if (!parts) return ymd;
  const [y, mo, d] = parts;
  const cible = new Date(Date.UTC(y, mo - 1 + delta, 1));
  const annee = cible.getUTCFullYear();
  const mois = cible.getUTCMonth() + 1;
  return toYmd(annee, mois, Math.min(d, joursDansLeMois(annee, mois)));
}

/** Nombre de jours du mois (1-12), années bissextiles comprises. */
export function joursDansLeMois(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Jour de la semaine, 0 = lundi … 6 = dimanche (l'admin affiche des semaines qui commencent le lundi). */
export function jourDeSemaine(ymd: string): number {
  const parts = parseYmd(ymd);
  if (!parts) return 0;
  return (new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay() + 6) % 7;
}

/**
 * La grille d'un mois : 6 × 7 = 42 dates civiles consécutives, commençant un lundi.
 * Hauteur FIXE — une grille qui change de hauteur d'un mois à l'autre fait sauter le panneau
 * sous le curseur, et l'utilisateur clique sur la mauvaise date.
 */
export function grilleDuMois(year: number, month: number): string[] {
  const premier = toYmd(year, month, 1);
  const depart = addDaysYmd(premier, -jourDeSemaine(premier));
  return Array.from({ length: 42 }, (_, i) => addDaysYmd(depart, i));
}

/** Comparaison de dates civiles : `a` est-elle strictement avant `b` ? (l'ordre lexicographique suffit sur "YYYY-MM-DD"). */
export const avant = (a: string, b: string): boolean => a < b;

/** Le mois d'une date civile, sous la forme [année, mois 1-12]. Par défaut le mois de `repli`. */
export function moisDe(ymd: string, repli: string): [number, number] {
  const parts = parseYmd(ymd) ?? parseYmd(repli);
  return parts ? [parts[0], parts[1]] : [1970, 1];
}
