/**
 * Le masque d'adresse des écrans d'automation : `abc…@domaine`.
 *
 * ⛔ LA MÊME RÈGLE QUE LA SONDE DE 0082 (`automation_due`, colonne `sample`) :
 * `left(split_part(email, '@', 1), 3) || '…@' || split_part(email, '@', 2)`. L'aperçu d'audience
 * reçoit ses adresses DÉJÀ masquées par la base ; les journaux (simulation, envois réels) les
 * masquent ici, avant tout rendu. Deux écrans voisins qui masqueraient différemment laisseraient
 * recouper une adresse entière. `migration-sync.test.ts` rougit si les deux divergent.
 *
 * ⚠️ Trois caractères de la PARTIE LOCALE, jamais de l'adresse entière : `ab@x.io` donnerait sinon
 * `ab@…@x.io`, qui montre toute la partie locale.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  const local = at >= 0 ? email.slice(0, at) : email;
  const rest = at >= 0 ? email.slice(at + 1) : "";
  // `split_part(email, '@', 2)` : ce qui suit le PREMIER `@`, jusqu'au suivant.
  const domaine = rest.split("@")[0] ?? "";
  return `${local.slice(0, 3)}…@${domaine}`;
}
