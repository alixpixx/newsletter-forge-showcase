/**
 * Numéro de la première édition d'une série (0067) — partagé par la route de cadence et l'écran.
 *
 * Module PUR (aucun import) : le sélecteur de cadence est un composant client, la route un module
 * serveur, et les deux doivent refuser exactement les mêmes valeurs.
 */

/** Même borne que la contrainte `campaign_edition_start_positive` (0067). */
export const MAX_EDITION_START = 1_000_000;

/**
 * `undefined` = champ absent (on ne touche pas la colonne), `null` = valeur refusée.
 * ⛔ Pas de clamp silencieux : « 0 » ou « 12.5 » saisis par erreur deviendraient un numéro que
 * personne n'a tapé, imprimé dans chaque e-mail de la série.
 */
export function parseEditionStart(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_EDITION_START ? n : null;
}
