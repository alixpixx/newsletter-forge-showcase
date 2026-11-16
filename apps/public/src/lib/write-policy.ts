/**
 * CE QU'UN ÉCHEC DE BASE COÛTE SUR LA ROUTE D'INSCRIPTION — décidé ici, hors de la route.
 *
 * ⛔ POURQUOI CE MODULE EXISTE. `api/v1/signup/route.ts` fait 860 lignes et n'a aucun banc. Six de
 * ses accès base étaient en `await db.from(…)` SANS jamais lire `error` : sur un refus Postgres, la
 * route poursuivait comme si la ligne était écrite et rendait 200. Cinq écritures et — la plus
 * grave — UNE lecture, celle de la liste de suppression, dont l'échec réabonnait en silence une
 * personne effacée au titre du droit à l'oubli. Une politique d'erreur qu'aucun test ne tient en
 * place n'est pas une politique : elle dure jusqu'à la prochaine relecture distraite.
 *
 * ⛔ IL N'Y A PAS DE RÈGLE UNIQUE, ET C'EST LE CŒUR DU SUJET. « Toujours refuser » bloquerait une
 * inscription parfaitement valide pour un prénom non rafraîchi ; « toujours continuer » envoie un
 * lien de confirmation MORT à une vraie personne. Ce qui décide, c'est ce qui est DÉJÀ ÉCRIT au
 * moment de l'échec et ce qui vient APRÈS lui dans la route.
 *
 * ⛔ LA DÉCISION EST DÉRIVÉE, PAS RECOPIÉE. La table ne porte que des FAITS — « est-ce une
 * lecture ? », « un geste public irréversible en dépend-il ? », « que perdrait-on à continuer ? » —
 * et `suiteEchec` en déduit la réponse. Une table qui porterait directement `refuse: true` se
 * relirait comme une liste de préférences, et plus personne ne saurait dire POURQUOI une ligne y
 * vaut ce qu'elle vaut.
 *
 * ⛔ « JE NE SAIS PAS » NE S'ÉCRIT JAMAIS COMME « RIEN ». Une lecture ratée ne se rend ni en `null`
 * (« pas trouvé »), ni en `[]`, ni en `false` : elle FERME. C'est particulièrement vrai de la
 * vérification de suppression — sur un chemin public non authentifié, l'ignorance qui ouvre est
 * une réinscription d'office.
 */

/** Les accès dont l'échec se décide ici. Un nom = un point précis de la route. */
export type OperationSignup =
  | "suppression-check"
  | "subscriber-read"
  | "subscriber-first-name"
  | "subscription-read"
  | "subscription-update"
  | "consent-event-insert"
  | "doi-token-insert"
  | "confirmation-email";

export interface FaitsEchec {
  /**
   * Une LECTURE. Son échec est une IGNORANCE, pas un « rien trouvé » : continuer reviendrait à
   * faire passer une panne pour une mesure — un abonné absent qu'on recrée, une suppression qu'on
   * n'a pas su voir.
   */
  lecture: boolean;
  /**
   * Un geste PUBLIC ET IRRÉVERSIBLE dépend de cette opération, plus bas dans la même requête.
   * Un e-mail parti ne se rattrape pas ; un abonné confirmable sans preuve légale non plus.
   */
  irreversibleEnAval: boolean;
  /**
   * Ce que CONTINUER perdrait, en une phrase, parmi ce qui est déjà acquis à cet instant.
   * `null` = rien de neuf n'est perdu, et bloquer serait disproportionné.
   */
  perteSiOnContinue: string | null;
}

/**
 * Les faits, opération par opération. Chaque ligne est motivée par ce qui l'ENTOURE dans la route :
 * ce qui est déjà écrit au-dessus, ce qui s'exécute en dessous.
 *
 * ⚠️ EXACTEMENT UN fait moteur par ligne, volontairement. Deux faits qui commandent le même refus
 * rendraient chacun inoffensif : on pourrait en effacer un sans que la sortie bouge, donc sans
 * qu'aucun test ne tombe.
 */
export const FAITS_SIGNUP: Record<OperationSignup, FaitsEchec> = {
  /**
   * C5, droit à l'oubli. Ne pas savoir si cette adresse est supprimée n'autorise PAS à la traiter
   * comme non supprimée : sur une vérification de suppression, l'ignorance doit FERMER.
   */
  "suppression-check": { lecture: true, irreversibleEnAval: false, perteSiOnContinue: null },

  /**
   * `subscriber` par e-mail. Un `null` qui se fait passer pour « pas trouvé » envoie la route dans
   * la branche CRÉATION, où l'INSERT butera sur l'unique `(email)` — un 500 illisible sur une
   * personne qui existait déjà.
   */
  "subscriber-read": { lecture: true, irreversibleEnAval: false, perteSiOnContinue: null },

  /**
   * Rafraîchissement du prénom d'un abonné PRÉEXISTANT. Rien de neuf n'est écrit, rien en aval n'en
   * dépend : refuser l'inscription entière pour un prénom non rafraîchi serait disproportionné.
   * Mais l'échec se journalise — un prénom qui cesse d'être mis à jour ne doit pas être un silence.
   */
  "subscriber-first-name": { lecture: false, irreversibleEnAval: false, perteSiOnContinue: null },

  /** `subscription` existante. Même piège que `subscriber-read`, une clé unique plus loin. */
  "subscription-read": { lecture: true, irreversibleEnAval: false, perteSiOnContinue: null },

  /**
   * Mise à jour d'une souscription existante (réinscription). Rien n'est à moitié écrit et rien en
   * aval n'a encore tourné : l'émetteur peut rejouer, le chemin est idempotent.
   */
  "subscription-update": {
    lecture: false,
    irreversibleEnAval: false,
    perteSiOnContinue: "la DEUXIÈME inscription de cette personne — sa créative, ses intérêts, ses finalités",
  },

  /**
   * `consent_event` type `optin_request`. Le jeton et l'e-mail de confirmation suivent
   * IMMÉDIATEMENT : continuer fabriquerait un abonné confirmable dont la preuve légale n'existe
   * pas — un consentement sans trace, découvert le jour d'un contrôle, sur des mois de leads.
   */
  "consent-event-insert": { lecture: false, irreversibleEnAval: true, perteSiOnContinue: null },

  /**
   * `doi_token`. LE CAS LE PLUS GRAVE DES CINQ ÉCRITURES : `confirmUrl` est bâti avec le `raw`
   * rendu par `newDoiToken()`, hors de toute garde. Sans la ligne en base, le lien envoyé à une
   * VRAIE PERSONNE est mort à la seconde où il part. Irréversible, invisible, et le seul témoin
   * serait son silence.
   */
  "doi-token-insert": { lecture: false, irreversibleEnAval: true, perteSiOnContinue: null },

  /**
   * `email_outbox`, l'e-mail de confirmation. Rien ne suit, mais sans cette ligne le worker n'a
   * rien à drainer : la personne ne reçoit jamais son lien et sa souscription reste `pending` pour
   * toujours — un abonné perdu que la réponse 200 déclarait acquis.
   */
  "confirmation-email": {
    lecture: false,
    irreversibleEnAval: false,
    perteSiOnContinue: "le seul moyen qu'a cette personne de confirmer : la souscription reste pending pour toujours",
  },
};

export type SuiteEchec =
  /** On poursuit — mais l'échec est journalisé, jamais avalé. */
  | { refuse: false; event: string }
  /** On s'arrête : continuer coûterait plus cher que refuser. */
  | { refuse: true; status: number; code: string; event: string };

/**
 * Ce qu'on fait d'un échec, DÉDUIT de ses faits.
 *
 * ⛔ 503 POUR UNE LECTURE, 500 POUR UNE ÉCRITURE, et la distinction n'est pas cosmétique : une
 * lecture ratée dit « je ne sais pas », ce qui est un service momentanément indisponible et invite
 * l'émetteur à REJOUER. Une écriture refusée dit « je sais, et ça n'est pas passé ». Les deux
 * répondues pareil, l'émetteur ne saurait pas laquelle réessayer.
 *
 * ⚠️ Le message Postgres brut ne sort JAMAIS d'ici : ce module ne le voit même pas. Il nomme des
 * tables et des contraintes, et ce chemin est public.
 */
export function suiteEchec(op: OperationSignup): SuiteEchec {
  const faits = FAITS_SIGNUP[op];
  const event = `signup-${op}-failed`;

  if (!faits.lecture && !faits.irreversibleEnAval && faits.perteSiOnContinue === null) {
    return { refuse: false, event };
  }

  return faits.lecture
    ? { refuse: true, status: 503, code: "service-indisponible", event }
    : { refuse: true, status: 500, code: "db", event };
}
