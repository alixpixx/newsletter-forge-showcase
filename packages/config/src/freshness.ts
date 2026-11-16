/**
 * FRAÎCHEUR D'UN CONTENU IMPORTÉ — une seule arithmétique pour l'écran et pour le worker.
 *
 * LE PIÈGE QUE CE MODULE EXISTE POUR ÉVITER. La tentation est de mesurer `now − fetchedAt` : c'est
 * juste sur un envoi immédiat, et faux partout ailleurs. Une série hebdomadaire compose le lundi
 * pour un envoi le vendredi ; à la composition, `now − fetchedAt` vaut deux minutes et l'écran
 * affiche « frais » — alors que l'abonné recevra, quatre jours plus tard, des articles de six
 * jours. La question n'est jamais « quel âge a ce contenu maintenant ? » mais **« quel âge
 * aura-t-il au moment où il partira ? »**
 *
 * D'où la signature : la fraîcheur se calcule contre un INSTANT D'ENVOI, jamais contre l'horloge.
 *
 * ⛔ Ce module ne décide rien tout seul et n'écrit rien. Il rend un verdict que l'écran affiche et
 * que l'armement d'une occurrence consultera (lot S-4). Deux implémentations — une pour l'aperçu,
 * une pour le planificateur — finiraient par diverger, et la divergence serait invisible : les
 * deux afficheraient un nombre plausible.
 */

/** Heures au-delà desquelles on avertit sans bloquer. */
export const FRESHNESS_WARN_HOURS = 72;

/**
 * Heures au-delà desquelles l'armement d'une occurrence est RETENU.
 *
 * Une semaine : c'est la cadence la plus longue qu'une newsletter récurrente utilise en pratique.
 * Au-delà, le contenu date d'avant l'occurrence précédente — on renverrait donc, sous une date
 * nouvelle, ce qui a déjà été envoyé.
 */
export const FRESHNESS_BLOCK_HOURS = 168;

export type FreshnessLevel = "fresh" | "aging" | "stale";

export interface FreshnessVerdict {
  level: FreshnessLevel;
  /** Âge en heures À L'ENVOI, arrondi. Négatif si l'envoi précède la récupération (voir plus bas). */
  hours: number;
  /** Vrai quand l'occurrence ne doit pas s'armer sans un geste explicite. */
  blocking: boolean;
  /** Phrase prête à afficher, identique à l'écran et dans le journal du worker. */
  message: string;
}

/**
 * Âge d'un contenu au moment où il partira.
 *
 * `sendAt` omis = maintenant, ce qui est le cas de l'aperçu dans le builder — mais l'appelant qui
 * connaît l'instant d'envoi DOIT le passer, sans quoi la mesure ment dans le sens rassurant.
 *
 * Une date illisible rend `stale` et non `fresh` : un contenu dont on ne sait pas l'âge n'est pas
 * un contenu jeune, et le défaut de prudence doit tomber du côté qui retient l'envoi.
 */
export function freshnessOf(fetchedAt: string, sendAt?: string | Date): FreshnessVerdict {
  const from = new Date(fetchedAt).getTime();
  const to = sendAt === undefined ? Date.now() : new Date(sendAt).getTime();

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return {
      level: "stale",
      hours: 0,
      blocking: true,
      message: "the fetch date of this content is unreadable — treat it as out of date",
    };
  }

  const hours = Math.round((to - from) / 3_600_000);

  // Envoi ANTÉRIEUR à la récupération : le contenu sera récupéré après coup, ou les horloges ne
  // sont pas d'accord. Ce n'est pas « très frais », c'est une incohérence — on la nomme.
  if (hours < 0) {
    return {
      level: "fresh",
      hours,
      blocking: false,
      message: `this content was fetched after the send time (${Math.abs(hours)} h later) — check the schedule`,
    };
  }

  if (hours >= FRESHNESS_BLOCK_HOURS) {
    return {
      level: "stale",
      hours,
      blocking: true,
      message: `this content will be ${hours} h old when it goes out — older than a full week, so it likely repeats the previous edition`,
    };
  }

  if (hours >= FRESHNESS_WARN_HOURS) {
    return {
      level: "aging",
      hours,
      blocking: false,
      message: `this content will be ${hours} h old when it goes out`,
    };
  }

  return {
    level: "fresh",
    hours,
    blocking: false,
    message: `${hours} h old at send time`,
  };
}

/**
 * Verdict d'un LOT de contenus — celui d'une occurrence entière.
 *
 * ⚠️ LE PIRE, PAS LA MOYENNE. Un e-mail qui contient un article frais et quatre articles de dix
 * jours n'est pas « moyennement frais » : il republie quatre articles déjà envoyés. La moyenne
 * masquerait exactement le cas qu'on cherche à attraper.
 *
 * Un lot VIDE rend `fresh` non bloquant : il n'y a rien d'importé, donc rien à juger. C'est au
 * contrôle « le document a-t-il du contenu ? » de parler, pas à celui-ci.
 */
export function worstFreshness(fetchedAts: readonly string[], sendAt?: string | Date): FreshnessVerdict {
  if (fetchedAts.length === 0) {
    return { level: "fresh", hours: 0, blocking: false, message: "no imported content" };
  }
  let worst = freshnessOf(fetchedAts[0], sendAt);
  for (const at of fetchedAts.slice(1)) {
    const v = freshnessOf(at, sendAt);
    if (v.hours > worst.hours || (v.blocking && !worst.blocking)) worst = v;
  }
  return worst;
}
