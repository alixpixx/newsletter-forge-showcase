/**
 * LE FILET DES ÉCRITURES MUETTES — ce que la route d'inscription fait d'un refus de la base.
 *
 * ⛔ CE QUE CES TESTS TIENNENT EN PLACE, en une phrase chacun :
 *  · une vérification de SUPPRESSION qui échoue FERME. Se tromper de sens réabonne, sur un chemin
 *    public non authentifié, une personne effacée au titre du droit à l'oubli.
 *  · un `doi_token` non écrit ne laisse PAS partir l'e-mail. `confirmUrl` est bâti hors de toute
 *    garde : continuer envoie un lien MORT à une vraie personne, et le seul témoin est son silence.
 *  · un `consent_event` non écrit ne laisse PAS émettre le jeton. Continuer fabriquerait un abonné
 *    confirmable dont la preuve légale n'existe pas.
 *  · un prénom non rafraîchi ne coûte PAS l'inscription. La politique est cas par cas ; une règle
 *    unique se trompe forcément d'un côté.
 *
 * ⚠️ Aucun accès base, aucun réseau : `suiteEchec` est pure, et c'est précisément pour ça qu'elle
 * a été extraite de la route avant que sa politique ne soit touchée.
 */
import { describe, expect, test } from "bun:test";
import { FAITS_SIGNUP, suiteEchec, type OperationSignup } from "./write-policy";

/**
 * La SORTIE PRODUITE, aplatie pour être lisible d'un coup d'œil. `status` et `code` à `null`
 * quand on continue : ils ne sont pas « zéro », ils n'existent pas dans cette branche.
 */
function sortie(op: OperationSignup): {
  refuse: boolean;
  status: number | null;
  code: string | null;
  event: string;
} {
  const s = suiteEchec(op);
  return {
    refuse: s.refuse,
    status: s.refuse ? s.status : null,
    code: s.refuse ? s.code : null,
    event: s.event,
  };
}

const TOUTES = Object.keys(FAITS_SIGNUP) as OperationSignup[];

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 1. Les refus qu'on ne peut pas se permettre de perdre
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("suiteEchec — l'ignorance FERME, elle n'ouvre pas", () => {
  /**
   * ⛔ LE TEST LE PLUS GRAVE DU LOT. MUTATION QUI DOIT LE TUER :
   * `"suppression-check": { lecture: false, … }`. Symptôme : la RPC `is_suppressed` tombe,
   * `supp.data` vaut `undefined`, le test `=== true` est faux, et la route réabonne en silence une
   * personne qui avait demandé son effacement — sur un chemin public, sans une ligne de journal.
   */
  test("vérification de suppression en panne ⇒ 503, jamais une inscription", () => {
    expect(sortie("suppression-check")).toEqual({
      refuse: true,
      status: 503,
      code: "service-indisponible",
      event: "signup-suppression-check-failed",
    });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : `"subscriber-read": { lecture: false, … }`. Symptôme : une
   * lecture ratée se lit « cet e-mail n'existe pas », la route part en branche CRÉATION, et
   * l'INSERT bute sur l'unique `(email)` — un 500 illisible pour quelqu'un qui existait déjà.
   */
  test("lecture de l'abonné en panne ⇒ 503, pas une création qui violera l'unique", () => {
    expect(sortie("subscriber-read")).toEqual({
      refuse: true,
      status: 503,
      code: "service-indisponible",
      event: "signup-subscriber-read-failed",
    });
  });

  /** Même piège, une clé unique plus loin : `(subscriber_id, asset_id, edition_id)`. */
  test("lecture de la souscription en panne ⇒ 503", () => {
    expect(sortie("subscription-read")).toEqual({
      refuse: true,
      status: 503,
      code: "service-indisponible",
      event: "signup-subscription-read-failed",
    });
  });
});

describe("suiteEchec — aucun e-mail ne part sur une écriture ratée", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : `"doi-token-insert": { irreversibleEnAval: false, … }`.
   * Symptôme : le jeton n'est pas en base, `confirmUrl` est pourtant bâti avec le `raw` en
   * mémoire, l'e-mail part, et la personne clique un lien MORT. Irréversible et public.
   */
  test("jeton de confirmation non écrit ⇒ 500 AVANT l'envoi", () => {
    expect(sortie("doi-token-insert")).toEqual({
      refuse: true,
      status: 500,
      code: "db",
      event: "signup-doi-token-insert-failed",
    });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : `"consent-event-insert": { irreversibleEnAval: false, … }`.
   * Symptôme : un abonné devient confirmable alors que la preuve de sa demande d'opt-in n'existe
   * nulle part. Le défaut ne se voit pas le jour où il arrive, mais le jour d'un contrôle.
   */
  test("preuve de consentement non écrite ⇒ 500 AVANT d'émettre le jeton", () => {
    expect(sortie("consent-event-insert")).toEqual({
      refuse: true,
      status: 500,
      code: "db",
      event: "signup-consent-event-insert-failed",
    });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : `"confirmation-email": { perteSiOnContinue: null, … }`.
   * Symptôme : `email_outbox` refuse l'insert, la route rend `200 {ok:true}`, le worker n'a rien à
   * drainer, et la souscription reste `pending` pour toujours — un abonné perdu, déclaré acquis.
   */
  test("mise en file de l'e-mail ratée ⇒ 500, pas un 200 qui ment", () => {
    expect(sortie("confirmation-email")).toEqual({
      refuse: true,
      status: 500,
      code: "db",
      event: "signup-confirmation-email-failed",
    });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : `"subscription-update": { perteSiOnContinue: null, … }`.
   * Symptôme : la DEUXIÈME inscription d'une personne — sa créative, ses intérêts, ses finalités —
   * est perdue sans une trace, sur un `200 {ok:true}`.
   */
  test("mise à jour de la souscription ratée ⇒ 500, l'émetteur rejouera", () => {
    expect(sortie("subscription-update")).toEqual({
      refuse: true,
      status: 500,
      code: "db",
      event: "signup-subscription-update-failed",
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 2. Le côté qu'une règle unique casserait
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("suiteEchec — un accessoire ne coûte jamais une inscription", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : donner une `perteSiOnContinue` non nulle à
   * `"subscriber-first-name"` (ou `irreversibleEnAval: true`). Symptôme : une inscription
   * parfaitement valide est refusée en 500 parce qu'un prénom n'a pas pu être rafraîchi sur un
   * abonné qui existait déjà. C'est l'erreur symétrique, et elle est tout aussi réelle.
   */
  test("prénom non rafraîchi ⇒ on continue, et on le journalise", () => {
    expect(sortie("subscriber-first-name")).toEqual({
      refuse: false,
      status: null,
      code: null,
      event: "signup-subscriber-first-name-failed",
    });
  });

  /**
   * ⛔ CE QUI NE DOIT JAMAIS DEVENIR UN SILENCE. Continuer est une décision, pas un oubli : chaque
   * opération porte un nom d'événement journalisable, y compris celles qu'on laisse passer.
   */
  test("toute opération porte un événement à journaliser, refus ou pas", () => {
    for (const op of TOUTES) {
      expect(suiteEchec(op).event).toBe(`signup-${op}-failed`);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 3. Les invariants de la dérivation — ce que la table ne peut PAS dire
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe("suiteEchec — la décision se DÉDUIT des faits", () => {
  /**
   * ⛔ LE JOUR OÙ UNE OPÉRATION EST AJOUTÉE. Ces trois invariants ne remplacent pas les tests
   * nommés ci-dessus (une mutation de la table déplace les deux côtés à la fois) : ils tiennent la
   * ligne NEUVE, celle qu'aucun test nommé ne couvre encore.
   */
  test("aucune LECTURE ne continue — une ignorance ne se rend pas en « rien trouvé »", () => {
    for (const op of TOUTES) {
      if (!FAITS_SIGNUP[op].lecture) continue;
      const s = suiteEchec(op);
      expect(s.refuse).toBe(true);
      expect(s.refuse ? s.status : null).toBe(503);
    }
  });

  test("aucun geste irréversible en aval ne se laisse précéder d'un échec avalé", () => {
    for (const op of TOUTES) {
      if (!FAITS_SIGNUP[op].irreversibleEnAval) continue;
      expect(suiteEchec(op).refuse).toBe(true);
    }
  });

  test("toute perte déclarée refuse — une perte nommée qui continue serait une perte acceptée", () => {
    for (const op of TOUTES) {
      if (FAITS_SIGNUP[op].perteSiOnContinue === null) continue;
      expect(suiteEchec(op).refuse).toBe(true);
    }
  });

  /**
   * ⛔ EXACTEMENT UN FAIT MOTEUR PAR LIGNE. Deux faits qui commandent le même refus se couvrent
   * mutuellement : on pourrait en effacer un sans que la sortie bouge, donc sans qu'aucun test ne
   * tombe — un garde dont le mutant survit n'est pas un garde. Ce test interdit la table qui
   * rendrait les autres inoffensifs.
   */
  test("un refus n'est commandé que par UN seul fait", () => {
    for (const op of TOUTES) {
      const f = FAITS_SIGNUP[op];
      const moteurs = [f.lecture, f.irreversibleEnAval, f.perteSiOnContinue !== null].filter(Boolean);
      expect(moteurs.length).toBe(suiteEchec(op).refuse ? 1 : 0);
    }
  });
});
