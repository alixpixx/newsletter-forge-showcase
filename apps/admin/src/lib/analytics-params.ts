/**
 * Paramètres d'URL de la page Analytics › Campaigns (feature 7). Module neutre et pur, pour être testé
 * sans rendu : une valeur illisible retombe sur le défaut, jamais sur « tout ».
 */

export const PERIODES = ["30", "90", "all"] as const;
export type Periode = (typeof PERIODES)[number];
export const PAR_PAGE = 25;

const premier = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function lirePeriode(v: string | string[] | undefined): Periode {
  const p = premier(v);
  return (PERIODES as readonly string[]).includes(p ?? "") ? (p as Periode) : "90";
}

export function lirePage(v: string | string[] | undefined): number {
  const n = Number.parseInt(premier(v) ?? "", 10);
  return Number.isFinite(n) && n >= 1 && n <= 10_000 ? n : 1;
}

/** La recherche, bornée : un nom de campagne ne dépasse pas 200 caractères. */
export function lireRecherche(v: string | string[] | undefined): string {
  return (premier(v) ?? "").trim().slice(0, 200);
}

/**
 * `?hidden=1` : montrer AUSSI les campagnes masquées des analytics (0093). Seul « 1 » l'active — tout
 * le reste retombe sur le défaut, qui les cache.
 */
export function lireMasquees(v: string | string[] | undefined): boolean {
  return premier(v) === "1";
}

/** Début de la période, ou `undefined` pour « All time ». */
export function debutPeriode(p: Periode, maintenant: Date): Date | undefined {
  if (p === "all") return undefined;
  return new Date(maintenant.getTime() - Number(p) * 86_400_000);
}

export function libellePeriode(p: Periode): string {
  return p === "all" ? "All time" : `${p} days`;
}

/** L'URL d'une page de la liste, en gardant les filtres posés. */
export function urlListe(p: { periode: Periode; recherche: string; page: number; masquees?: boolean }): string {
  const q = new URLSearchParams();
  if (p.periode !== "90") q.set("period", p.periode);
  if (p.recherche) q.set("q", p.recherche);
  if (p.masquees) q.set("hidden", "1");
  if (p.page > 1) q.set("page", String(p.page));
  const s = q.toString();
  return s ? `/analytics?${s}` : "/analytics";
}
