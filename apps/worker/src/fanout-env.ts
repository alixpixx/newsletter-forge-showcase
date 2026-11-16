/**
 * Les réglages du fan-out lus dans l'environnement — pour la tâche `enqueue` ET pour le drain
 * résident, qui doivent lire les MÊMES valeurs de la même façon.
 *
 * ⛔ `Number(x) || undefined` AVALAIT LE ZÉRO. `FANOUT_LEAD_MINUTES=0` devenait `undefined`, donc le
 * défaut : on ne pouvait pas demander « aucune avance » — précisément le réglage qui empêche une
 * campagne de partir avant son heure (voir `DEFAULT_LEAD_MINUTES`). Pour l'avance, 0 est une valeur,
 * pas une absence.
 */
import type { FanoutOptions } from "./fanout";

type Env = Record<string, string | undefined>;

const VRAI = ["1", "true", "yes"];
const FAUX = ["0", "false", "no"];

/** Un entier positif ou nul lu tel quel ; `undefined` si absent, vide, illisible ou négatif. */
function entierPositifOuNul(brut: string | undefined): number | undefined {
  if (brut === undefined || brut.trim() === "") return undefined;
  const n = Number(brut);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Un entier STRICTEMENT positif ; `undefined` sinon. Pour le plafond par cible et la borne de
 * retard, zéro n'a pas de sens (tout retenir, tout déclarer en retard) : il retombe sur le défaut.
 */
function entierStrictementPositif(brut: string | undefined): number | undefined {
  const n = entierPositifOuNul(brut);
  return n === undefined || n === 0 ? undefined : n;
}

export function fanoutSimule(env: Env): boolean {
  return VRAI.includes((env.FANOUT_SIMULATE ?? "").toLowerCase());
}

/** Les options de la tâche `enqueue` (cron). */
export function optionsFanoutDepuisEnv(env: Env): Pick<FanoutOptions, "leadMinutes" | "maxPerTarget" | "maxLateMinutes"> {
  return {
    leadMinutes: entierPositifOuNul(env.FANOUT_LEAD_MINUTES),
    maxPerTarget: entierStrictementPositif(env.FANOUT_MAX_PER_TARGET),
    maxLateMinutes: entierStrictementPositif(env.FANOUT_MAX_LATE_MINUTES),
  };
}

/**
 * Les options du fan-out IMMÉDIAT du drain résident — ou `null` quand il ne doit pas tourner.
 *
 * ⛔ L'AVANCE EST FORCÉE À ZÉRO, QUOI QUE DISE `FANOUT_LEAD_MINUTES`. Ce chemin tourne toutes les
 * quelques secondes : avec une avance, il enfilerait — donc enverrait — les campagnes AVANT leur
 * heure, à chaque passage. Il ne prend que ce qui est dû maintenant.
 *
 * Il ne tourne pas en simulation (`FANOUT_SIMULATE`, qui ne doit rien écrire — et répéter une passe à
 * blanc toutes les cinq secondes ne montrerait rien de plus), ni si `INSTANT_FANOUT` vaut 0/false/no,
 * l'interrupteur qui rend au drain résident son seul rôle de vider la file.
 */
export function optionsFanoutInstantane(
  env: Env,
): (Pick<FanoutOptions, "leadMinutes" | "maxPerTarget" | "maxLateMinutes"> & { leadMinutes: 0 }) | null {
  if (fanoutSimule(env)) return null;
  if (FAUX.includes((env.INSTANT_FANOUT ?? "").toLowerCase())) return null;
  const { maxPerTarget, maxLateMinutes } = optionsFanoutDepuisEnv(env);
  return { leadMinutes: 0, maxPerTarget, maxLateMinutes };
}
