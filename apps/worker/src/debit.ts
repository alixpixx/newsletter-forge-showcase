/**
 * CE QU'UN SEUL PASSAGE DU WORKER S'AUTORISE À SORTIR DE LA FILE.
 *
 * ⛔ POURQUOI CE PLAFOND EXISTE — décision d'Alix du 15/09/2026 : « jveux jamais de liste stocké
 * qui s'envoi apres c'est le milleur moyen d'avoir un probleme qui balance d'un coup 10000 maisl ».
 *
 * `BATCH_SIZE` ne bornait RIEN. La boucle de drain d'`index.ts` s'écrivait
 * `do { drainOnceLive() } while (n > 0)` : elle rappelait la réclamation jusqu'à épuisement de la
 * file. Dix lignes par lot, mille lots — dix mille envois dans le même tick de cron, sans qu'aucun
 * réglage ne le dise et sans que personne puisse s'interposer entre le premier et le dernier.
 * `BATCH_SIZE` dimensionne un lot, pas un passage ; il n'a jamais été une vanne.
 *
 * ⭐ CE QUI EST BORNÉ ICI, C'EST LA RÉCLAMATION, PAS L'ENVOI. Une ligne réclamée peut encore être
 * refusée (âge, jeton mort, pied de page, allow-list) : le nombre d'envois réels est donc TOUJOURS
 * inférieur ou égal au nombre réclamé. Borner en amont est la seule façon de borner sans compter
 * les envois un par un — et une borne qui se trompe se trompe du bon côté.
 *
 * ⚠️ CE QUE CE PLAFOND NE PROTÈGE PAS. Il borne UN PASSAGE. Le déploiement réel est un cron de
 * cinq minutes avec `RUN_ONCE=true` : un passage = un tick, donc 50 lignes toutes les 5 minutes, et
 * une file de dix mille prendrait plus de seize heures à sortir — largement le temps de voir les
 * journaux et de couper. Mais un processus RELANCÉ repart d'un compteur neuf : ce plafond ne
 * remplace ni la borne d'âge de `gate.ts`, qui périme le stock lui-même, ni la surveillance.
 */

/**
 * Plafond par défaut : volontairement BAS.
 *
 * Le défaut d'un réglage de sûreté doit être celui qui protège, pas celui qui convient à l'usage
 * de croisière — c'est la même doctrine que `WORKER_MODE=dry-run` par défaut. Remonter ce nombre
 * est un geste conscient, qu'on pose en sachant ce qu'il ouvre ; l'oublier ne peut pas nuire.
 */
export const MAX_PAR_PASSAGE_DEFAUT = 50;

/**
 * Combien de lignes le prochain lot a le droit de réclamer, ou 0 quand le passage est fini.
 *
 * ⛔ FAIL-CLOSED SUR L'ABSURDE : un plafond nul, négatif ou illisible rend 0 — on ne réclame rien
 * plutôt que de traiter une valeur inintelligible comme « pas de limite ». Le schéma d'`env.ts`
 * refuse déjà ces valeurs au boot ; cette borne-ci existe pour que la fonction soit sûre seule,
 * sans dépendre de ce que son appelant a validé.
 */
export function lignesAReclamer(dejaReclamees: number, batchSize: number, plafond: number): number {
  if (!Number.isFinite(plafond) || plafond <= 0) return 0;
  if (!Number.isFinite(batchSize) || batchSize <= 0) return 0;
  if (!Number.isFinite(dejaReclamees) || dejaReclamees < 0) return 0;
  const restant = plafond - dejaReclamees;
  if (restant <= 0) return 0;
  return Math.min(batchSize, restant);
}

/**
 * LE MÊME PLAFOND POUR UN SERVICE QUI NE S'ARRÊTE PAS — une fenêtre de temps tient lieu de tick.
 *
 * ⛔ POURQUOI (22/09/2026, « jveux que ce soit instant si besoin »). L'envoi immédiat exige un drain
 * RÉSIDENT : un cron, même à la minute, fait attendre. Or le service résident comptait son plafond
 * sur toute sa VIE : cinquante réclamations après son démarrage, il s'arrêtait jusqu'à la relance —
 * un service permanent qui cesse d'envoyer au 51e message de la journée.
 *
 * ⭐ LA FENÊTRE VAUT EXACTEMENT LE TICK QU'ELLE REMPLACE : le cron de drain passait toutes les cinq
 * minutes avec au plus `WORKER_MAX_PER_RUN` réclamations ; la fenêtre dure cinq minutes et autorise le
 * même nombre. Le débit maximal ne bouge pas d'une ligne — la décision d'Alix du 15/09 (jamais
 * « 10000 mails d'un coup ») tient à l'identique. Ce qui change, c'est QUAND partent les premiers.
 */
export const FENETRE_DEBIT_MS = 5 * 60_000;

/**
 * LE PLAFOND DES E-MAILS INTERACTIFS (confirmation, bienvenue, accusé de désinscription, test), par
 * fenêtre — SÉPARÉ de celui des newsletters.
 *
 * ⛔ POURQUOI UNE PASSE À PART (22/09/2026, Alix : « tout les mails de type welcome etc soit instant
 * les 5min d'attente ca doit etre que pour les newsletter »). Le plafond des newsletters compte tous
 * les kinds et se vérifie avant de réclamer : pendant une grosse campagne, une confirmation attendait
 * jusqu'à cinq minutes que la fenêtre se rouvre.
 *
 * ⛔ POURQUOI IL LUI FAUT QUAND MÊME UN PLAFOND. Le formulaire public n'a aucune limite de débit : un
 * robot qui soumet dix mille adresses ferait partir dix mille confirmations d'un coup — exactement
 * ce que la décision du 15/09 interdit. Deux cents par fenêtre, c'est quarante par minute : très
 * au-dessus de l'usage réel (sept confirmations du 18 au 22/09), très en dessous d'une rafale.
 */
export const MAX_INTERACTIFS_PAR_FENETRE_DEFAUT = 200;

export interface FenetreDebit {
  /** Instant d'ouverture de la fenêtre (ms epoch). */
  debut: number;
  /** Réclamations déjà faites dans cette fenêtre. */
  reclamees: number;
}

/**
 * La fenêtre en cours : la même tant qu'elle n'est pas écoulée, une neuve (compteur à zéro) sinon.
 *
 * ⛔ FAIL-CLOSED SUR L'HORLOGE. Une horloge qui RECULE ne rouvre pas la fenêtre — sinon un saut
 * d'horloge suffirait à remettre le compteur à zéro. Une durée absurde (nulle, négative, illisible)
 * ne la rouvre jamais non plus : on retombe sur le plafond « à vie », l'ancien comportement.
 */
export function fenetreCourante(fenetre: FenetreDebit | null, maintenant: number, dureeMs: number): FenetreDebit {
  if (fenetre === null) return { debut: maintenant, reclamees: 0 };
  if (!Number.isFinite(dureeMs) || dureeMs <= 0) return fenetre;
  if (maintenant - fenetre.debut >= dureeMs) return { debut: maintenant, reclamees: 0 };
  return fenetre;
}
