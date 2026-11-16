import { describe, expect, test } from "bun:test";
import { gate as gateBrut, OUTBOX_AGE_MAX_JOURS } from "./gate";
import type { OutboxContext } from "./db";

/**
 * ⛔ L'HORLOGE DU BANC EST FIGÉE, et ce n'est pas une coquetterie. `gate()` refuse désormais une
 * ligne trop vieille, donc son verdict dépend de la date du jour : avec `new Date()`, ce fichier
 * aurait viré au rouge tout seul, un matin, sans qu'une ligne de code ait bougé — et le premier
 * réflexe aurait été de chercher la régression dans le code de production.
 */
const MAINTENANT = new Date("2026-09-15T12:00:00Z");
const gate = (c: OutboxContext, now: Date = MAINTENANT) => gateBrut(c, now);

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. `gate()` est la DERNIÈRE porte avant qu'un e-mail parte :
 * c'est elle qui décide si on écrit à quelqu'un et si on le piste. Elle n'avait aucun banc.
 *
 * Il ne rejoue pas la logique de consentement — elle vit dans `@nf/config` (`canSend`, `canTrack`)
 * et y est testée. Ce qu'il fixe est ce que `gate` décide TOUTE SEULE : la table des politiques par
 * `kind`, et le comportement devant un kind qu'elle ne connaît pas.
 */

/** Un contexte complet et envoyable. Chaque test ne change QUE ce qu'il veut mesurer. */
function ctx(p: Partial<OutboxContext> = {}): OutboxContext {
  return {
    id: "o1",
    kind: "welcome",
    subject: "s",
    action_url: null,
    payload: null,
    to_email: "a@example.invalid",
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: "2026-09-08T00:00:00Z",
    // ⚠️ Mis en file la VEILLE de `MAINTENANT` : le défaut du fixture doit être une ligne
    // ordinaire, donc fraîche. Le laisser au 08/09 aurait fait échouer chaque test du fichier sur
    // `stale_outbox`, c'est-à-dire mesurer l'âge partout au lieu de ce que chaque test vise.
    created_at: "2026-09-14T12:00:00Z",
    asset_id: "asset-1",
    subscription_id: "sub-1",
    asset_name: "Titre",
    asset_slug: "titre",
    sending_subdomain: "mg",
    compliance_regime: "gdpr",
    legal_footer: { company: "X" },
    language: "fr",
    sub_status: "active",
    subscriber_id: "subr-1",
    tracking_consent: false,
    suppressed: false,
    purpose: null,
    market: null,
    consent_mode: null,
    granted_purposes: null,
    ...p,
  } as OutboxContext;
}

describe("gate — les kinds inconnus", () => {
  test("un kind absent de la table NE PART PAS", () => {
    // ⛔ Fail-closed. Le défaut inverse ferait partir un message dont personne n'a décidé s'il
    // respecte le statut, la suppression ou le suivi — c'est-à-dire un envoi sans politique.
    const d = gate(ctx({ kind: "inconnu" }));
    expect(d.send).toBe(false);
    expect(d.send === false && d.reason).toBe("unknown_kind:inconnu");
  });

});

describe("gate — le réengagement (lot 5)", () => {
  /** Un dormant à qui on a le droit d'écrire : actif, non supprimé, finalité accordée. */
  const dormant = { kind: "reengagement", purpose: "content", granted_purposes: { content: true } };

  test("part à un abonné actif dont la finalité est accordée", () => {
    expect(gate(ctx(dormant)).send).toBe(true);
  });

  test("ne part PAS à quelqu'un qui s'est désinscrit", () => {
    /*
     * ⛔ LE CŒUR DE CE LOT. Un réengagement s'adresse à des gens qui ne réagissent plus — et
     * l'erreur naturelle serait de bypasser le statut pour « rattraper » les inactifs. Ne pas
     * réagir n'est pas un consentement : le seul titre à recevoir de ces abonnés-là est celui
     * qu'ils ont donné, et il exige `active`.
     */
    // ⚠️ On asserte la RAISON, pas seulement le refus : un refus pour un autre motif
    // (suppression, finalité) passerait pour une preuve que le statut est vérifié.
    for (const sub_status of ["unsubscribed", "pending", "deleted"]) {
      const d = gate(ctx({ ...dormant, sub_status }));
      expect(d.send === false && d.reason).toBe("not_active");
    }
  });

  test("ne part PAS à une adresse supprimée", () => {
    // Une adresse sur la do-not-send y est pour un rebond dur ou une plainte. Lui écrire
    // « on ne vous a pas vu » transforme une plainte en signalement de domaine.
    const d = gate(ctx({ ...dormant, suppressed: true }));
    expect(d.send === false && d.reason).toBe("suppressed");
  });

  test("ne part PAS si la finalité n'est pas accordée", () => {
    // `marketing: true` fait passer la finalité par `canSend`. 0057 rend `purpose` obligatoire en
    // base ; ici on vérifie que le consentement correspondant est bien exigé — et que c'est bien
    // POUR CE MOTIF que l'envoi est refusé.
    const d = gate(ctx({ ...dormant, granted_purposes: { content: false } }));
    expect(d.send === false && d.reason).toBe("purpose_not_granted");
  });
});

describe("gate — ce que chaque politique bypasse", () => {
  test("une confirmation part à un abonné `pending` — sinon le double opt-in est mort", () => {
    // Le message qui SERT à devenir actif ne peut pas exiger d'être actif.
    expect(gate(ctx({ kind: "confirmation", sub_status: "pending" })).send).toBe(true);
  });

  test("une confirmation ne part PAS à une adresse supprimée", () => {
    // Le statut est bypassé, la suppression ne l'est pas : quelqu'un sur la do-not-send ne reçoit
    // rien, pas même une confirmation qu'il n'a pas demandée.
    const d = gate(ctx({ kind: "confirmation", sub_status: "pending", suppressed: true }));
    expect(d.send === false && d.reason).toBe("suppressed");
  });

  test("un accusé de désinscription part MÊME à quelqu'un qui vient d'être supprimé", () => {
    // ⛔ Il ferme la boucle d'un geste que la personne vient de faire : « Unsubscribe from all
    // brands » pose `global_optout` juste avant de le mettre en file. Suppression SOUPLE, donc
    // `suppressed` vrai et `hard_suppressed` faux (22/09/2026 : la colonne est désormais exigée,
    // voir « gate — l'accusé de désinscription » plus bas).
    expect(
      gate(ctx({ kind: "unsubscribe_ack", sub_status: "unsubscribed", suppressed: true, hard_suppressed: false })).send,
    ).toBe(true);
  });

  test("un `welcome` exige un abonné actif", () => {
    expect(gate(ctx({ kind: "welcome", sub_status: "pending" })).send).toBe(false);
  });
});

/**
 * ⭐ LA RÉINSCRIPTION VOLONTAIRE (0073, 22/09/2026 — Alix : « si la personne se reinscrit on l'a reme
 * dans le systeme »). Une personne effacée ou désinscrite de tout qui se réinscrit doit recevoir SA
 * confirmation : c'est son clic qui lève l'ancienne suppression. `suppressed` vrai + `hard_suppressed`
 * faux = exactement ce cas.
 */
describe("gate — la confirmation d'une réinscription", () => {
  const reinscrit = { kind: "confirmation", sub_status: "pending", suppressed: true, hard_suppressed: false };

  /** MUTATION QUI DOIT LE TUER : retirer `suppressionDureSeule` de la politique `confirmation`. */
  test("part à une adresse effacée ou désinscrite de tout (suppression NON dure)", () => {
    expect(gate(ctx(reinscrit)).send).toBe(true);
  });

  test("ne part PAS sur un rebond dur ou une plainte (suppression dure)", () => {
    const d = gate(ctx({ ...reinscrit, hard_suppressed: true }));
    expect(d.send === false && d.reason).toBe("suppressed");
  });

  /**
   * ⛔ L'EXCEPTION EST POUR QUI REVIENT, PAS POUR QUI PART. Une confirmation encore en file quand la
   * personne est effacée (`deleted`) ou se désinscrit de tout (`unsubscribed`) ne part pas.
   * MUTATION QUI DOIT LE TUER : retirer la condition `sub_status === "pending"`.
   */
  test("une confirmation restée en file après un effacement ou une désinscription ne part pas", () => {
    for (const sub_status of ["deleted", "unsubscribed"]) {
      const d = gate(ctx({ ...reinscrit, sub_status }));
      expect(d.send === false && d.reason).toBe("suppressed");
    }
  });

  /**
   * ⛔ Colonne absente (0073 pas appliquée) ou nulle : ce n'est pas « pas dure », c'est « je ne sais
   * pas ». On retombe sur `suppressed` — le comportement d'avant, qui bloque.
   * MUTATION QUI DOIT LE TUER : `ctx.hard_suppressed ?? false` à la place du repli.
   */
  test("sans la colonne `hard_suppressed`, la suppression complète s'applique", () => {
    for (const hard_suppressed of [undefined, null]) {
      const d = gate(ctx({ ...reinscrit, hard_suppressed }));
      expect(d.send === false && d.reason).toBe("suppressed");
    }
  });

  /**
   * ⛔ LA CONFIRMATION ET RIEN D'AUTRE. Le bienvenue ne part qu'APRÈS le clic, donc après la levée ;
   * une campagne, un test ou un réengagement vers une adresse encore supprimée ne partent jamais.
   * MUTATION QUI DOIT LE TUER : lire `hard_suppressed` pour tous les kinds.
   */
  test("les autres kinds restent arrêtés par la suppression complète", () => {
    const autres = [
      { kind: "welcome", sub_status: "active" },
      { kind: "campaign", sub_status: "active", purpose: "content", granted_purposes: { content: true } },
      // `pending` : le seul statut où l'exception de la confirmation s'applique — il faut l'y mettre
      // pour prouver qu'elle ne déborde pas sur un autre kind.
      { kind: "test", sub_status: "pending" },
      { kind: "reengagement", sub_status: "active", purpose: "content", granted_purposes: { content: true } },
    ];
    for (const a of autres) {
      const d = gate(ctx({ ...a, suppressed: true, hard_suppressed: false }));
      expect(d.send === false && d.reason).toBe("suppressed");
    }
  });
});

/**
 * ⭐ L'ACCUSÉ DE DÉSINSCRIPTION (22/09/2026 — le jour où `apps/public` le met enfin en file). Il
 * bypassait TOUT : statut et suppression. Il part désormais seulement à une souscription
 * `unsubscribed` dont la suppression DURE est lue à `false`.
 */
describe("gate — l'accusé de désinscription", () => {
  const accuse = { kind: "unsubscribe_ack", sub_status: "unsubscribed", suppressed: false, hard_suppressed: false };

  test("part après une désinscription d'une marque (aucune suppression)", () => {
    expect(gate(ctx(accuse)).send).toBe(true);
  });

  /** MUTATION QUI DOIT LE TUER : ignorer `hard_suppressed` pour l'accusé (retour au bypass total). */
  test("part après « Unsubscribe from all brands » (suppression SOUPLE `global_optout`)", () => {
    expect(gate(ctx({ ...accuse, suppressed: true, hard_suppressed: false })).send).toBe(true);
  });

  /**
   * ⛔ Rebond dur ou plainte : la boîte n'existe pas, ou la personne nous a signalés comme spam. Un
   * accusé de plus, c'est ce que les fournisseurs retiennent.
   * MUTATION QUI DOIT LE TUER : `bypassSuppression: true` / ignorer `hard_suppressed`.
   */
  test("ne part PAS sur un rebond dur ou une plainte", () => {
    const d = gate(ctx({ ...accuse, suppressed: true, hard_suppressed: true }));
    expect(d.send === false && d.reason).toBe("suppressed");
  });

  /**
   * ⛔ Colonne absente (0073 pas appliquée) ou nulle : on ne sait pas distinguer une désinscription
   * de tout d'une plainte. L'accusé est une politesse, une plainte ne se reprend pas : il ne part pas.
   * MUTATION QUI DOIT LE TUER : `ctx.hard_suppressed === true` à la place de `!== false`.
   */
  test("sans la colonne `hard_suppressed` lue à faux, il ne part pas — même sans aucune suppression", () => {
    for (const hard_suppressed of [undefined, null]) {
      for (const suppressed of [false, true]) {
        const d = gate(ctx({ ...accuse, suppressed, hard_suppressed }));
        expect(d.send === false && d.reason).toBe("suppressed");
      }
    }
  });

  /**
   * ⛔ Effacée entre la mise en file et l'envoi : `erase_subscriber` ne touche pas
   * `email_outbox.to_email`, l'accusé partirait à la VRAIE adresse de quelqu'un qui vient de
   * demander l'oubli — et l'effacement pose `erasure`, suppression SOUPLE, qui ne l'arrête pas.
   * MUTATION QUI DOIT LE TUER : retirer l'exigence `sub_status === "unsubscribed"`.
   */
  test("ne part PAS à une souscription effacée entre-temps", () => {
    const d = gate(ctx({ ...accuse, sub_status: "deleted", suppressed: true, hard_suppressed: false }));
    expect(d.send === false && d.reason).toBe("not_unsubscribed");
  });

  test("ne part PAS à une souscription redevenue active ou en attente", () => {
    for (const sub_status of ["active", "pending", null]) {
      const d = gate(ctx({ ...accuse, sub_status }));
      expect(d.send === false && d.reason).toBe("not_unsubscribed");
    }
  });

  test("la confirmation d'une réinscription n'est pas touchée par la règle de l'accusé", () => {
    // Deux règles voisines, deux statuts : `pending` pour qui revient, `unsubscribed` pour qui part.
    const d = gate(ctx({ kind: "confirmation", sub_status: "pending", suppressed: true, hard_suppressed: false }));
    expect(d.send).toBe(true);
  });
});

describe("gate — le suivi", () => {
  /*
   * ⚠️ ON ASSERTE `send` D'ABORD, TOUJOURS. Écrire `expect(d.send === true && d.track).toBe(false)`
   * passerait aussi quand l'e-mail NE PART PAS — l'expression vaut `false` dans les deux cas, et le
   * banc afficherait vert sur une porte qui refuse tout. Un test dont on ne peut pas distinguer le
   * succès de la panne ne teste rien.
   */
  function decisionEnvoyee(c: OutboxContext): { track: boolean } {
    const d = gate(c);
    if (d.send !== true) throw new Error(`attendu : envoyé. Obtenu : refusé (${d.reason})`);
    return { track: d.track };
  }

  test("aucun transactionnel n'est pisté, même si l'abonné a consenti au suivi", () => {
    // Un pixel dans une confirmation mesurerait un geste qui n'a rien de marketing, et polluerait
    // les statistiques d'engagement avec des ouvertures qui ne disent rien de l'intérêt du lecteur.
    for (const kind of ["confirmation", "welcome", "test"]) {
      expect(decisionEnvoyee(ctx({ kind, sub_status: "active", tracking_consent: true })).track).toBe(false);
    }
    // ⚠️ L'accusé ne part qu'à une souscription `unsubscribed` dont la suppression dure est lue à
    // faux : on le met dans CE contexte-là, sinon `decisionEnvoyee` lèverait sur un refus.
    expect(
      decisionEnvoyee(
        ctx({ kind: "unsubscribe_ack", sub_status: "unsubscribed", hard_suppressed: false, tracking_consent: true }),
      ).track,
    ).toBe(false);
  });

  test("une campagne n'est pistée QUE si le suivi est consenti (marque en mode consent, ou base d'avant 0092)", () => {
    const base = { kind: "campaign", purpose: "content", granted_purposes: { content: true } };
    expect(decisionEnvoyee(ctx({ ...base, tracking_consent: false })).track).toBe(false);
    expect(decisionEnvoyee(ctx({ ...base, tracking_consent: true })).track).toBe(true);
    expect(decisionEnvoyee(ctx({ ...base, tracking_mode: "consent", tracking_refused: false })).track).toBe(false);
  });

  describe("mode « pour tous » (0092, décision d'Alix du 07/10)", () => {
    const base = { kind: "campaign", purpose: "content", granted_purposes: { content: true }, tracking_consent: false };

    test("une marque en mode all piste une campagne SANS consentement préalable", () => {
      expect(decisionEnvoyee(ctx({ ...base, tracking_mode: "all", tracking_refused: false })).track).toBe(true);
    });

    test("un refus explicite n'est JAMAIS pisté, même en mode all, même avec un consentement resté vrai", () => {
      expect(decisionEnvoyee(ctx({ ...base, tracking_mode: "all", tracking_refused: true })).track).toBe(false);
      expect(
        decisionEnvoyee(ctx({ ...base, tracking_consent: true, tracking_mode: "all", tracking_refused: true })).track,
      ).toBe(false);
    });

    test("fail-closed : un refus ABSENT ou nul ne vaut pas « pas de refus »", () => {
      expect(decisionEnvoyee(ctx({ ...base, tracking_mode: "all" })).track).toBe(false);
      expect(decisionEnvoyee(ctx({ ...base, tracking_mode: "all", tracking_refused: null })).track).toBe(false);
    });

    test("le mode all n'ouvre AUCUN transactionnel au suivi", () => {
      const tous = { tracking_mode: "all" as const, tracking_refused: false };
      for (const kind of ["confirmation", "welcome", "test"]) {
        expect(decisionEnvoyee(ctx({ kind, sub_status: "active", ...tous })).track).toBe(false);
      }
      expect(
        decisionEnvoyee(ctx({ kind: "unsubscribe_ack", sub_status: "unsubscribed", hard_suppressed: false, ...tous })).track,
      ).toBe(false);
    });
  });
});

describe("gate — le contexte manquant", () => {
  test("sans régime de conformité ou sans pied de page légal, rien ne part", () => {
    // Un e-mail sans mentions légales est une infraction, pas un e-mail dégradé.
    for (const manque of [{ compliance_regime: null }, { legal_footer: null }, { asset_id: null }]) {
      const d = gate(ctx({ kind: "welcome", ...manque } as Partial<OutboxContext>));
      expect(d.send === false && d.reason).toBe("missing_context");
    }
  });
});

describe("gate — l'âge de la ligne", () => {
  /**
   * ⛔ CE QUE CES TESTS EXISTENT POUR EMPÊCHER. `claim_outbox` n'a aucune borne d'âge — `index.ts`
   * le dit : « elle partirait au premier ». Mesuré le 15/09/2026 : huit lignes `pending`, toutes à
   * `attempts = 0`, jamais tentées parce que le worker n'a jamais quitté le `dry-run` — quatre du
   * 20/08 (2 `confirmation` + 2 `welcome`, toutes `@example.com`) et quatre `confirmation` du 13/09
   * (3 `gmail.com`, 1 `example.com`). La bascule les aurait toutes envoyées d'un coup, dont un
   * « Bienvenue » vieux de vingt-six jours.
   *
   * ⚠️ CE QUE CES TESTS NE COUVRENT PAS : seul le premier groupe est périmé. Les quatre du 13/09
   * passent la borne, et c'est le geste 0 bis de `docs/WORKER.md` — compter avant d'armer — qui les
   * retient, pas ce fichier.
   */

  test("une ligne fraîche part normalement", () => {
    expect(gate(ctx({ kind: "welcome", created_at: "2026-09-15T08:00:00Z" })).send).toBe(true);
  });

  test("une ligne de 26 jours ne part pas, et la raison porte son âge", () => {
    const d = gate(ctx({ kind: "welcome", created_at: "2026-08-20T18:04:57Z" }));
    expect(d.send).toBe(false);
    expect(d.send === false && d.reason).toBe("stale_outbox:25d");
  });

  test("le plafond est une BORNE STRICTE : pile dessus, ça passe encore", () => {
    // 7 jours pile n'est pas « plus de 7 jours ». Une borne inclusive écarterait une ligne mise en
    // file le jour même de la limite, ce que personne n'appellerait « périmé ».
    const pile = new Date(MAINTENANT.getTime() - OUTBOX_AGE_MAX_JOURS * 86_400_000).toISOString();
    expect(gate(ctx({ kind: "welcome", created_at: pile })).send).toBe(true);
    const unPeuPlus = new Date(MAINTENANT.getTime() - (OUTBOX_AGE_MAX_JOURS * 86_400_000 + 1000)).toISOString();
    expect(gate(ctx({ kind: "welcome", created_at: unPeuPlus })).send).toBe(false);
  });

  test("⛔ une CONFIRMATION ne fait plus exception : le plafond vaut pour TOUS les kinds", () => {
    /**
     * ⛔ DÉCISION D'ALIX DU 15/09/2026 AU SOIR, QUI RENVERSE CELLE DU MATIN. Verbatim : « jveux
     * jamais de liste stocké qui s'envoi apres c'est le milleur moyen d'avoir un probleme qui
     * balance d'un coup 10000 maisl ».
     *
     * Ce test affirmait exactement le contraire : une confirmation échappait au plafond, au motif
     * que son horloge était son `doi_token`. Mais ce jeton avait été PROLONGÉ à la main au 29/09,
     * seize jours après la mise en file — et une horloge qu'on repousse ne borne plus rien.
     * L'exemption couvrait donc précisément le kind qui part à de VRAIES personnes — mesuré le
     * 15/09 : les six `confirmation` de la file visent trois `gmail.com`, un `example.com` et deux
     * `@example.com`, là où aucun autre kind n'a d'adresse réelle. Sur une file de dix mille, elle
     * en aurait laissé partir dix mille.
     *
     * Le jeton reste une borne — relue dans `process.ts` via `doi-link.ts` — mais une borne EN PLUS
     * de l'âge, jamais une licence qui le prolonge. Deux bornes en ET : la plus courte gagne.
     */
    const vieille = gate(ctx({ kind: "confirmation", created_at: "2026-08-20T18:04:57Z" }));
    expect(vieille.send).toBe(false);
    expect(vieille.send === false && vieille.reason).toBe("stale_outbox:25d");

    // Huit mois et demi : le cas que l'ancienne exemption laissait passer sans broncher.
    expect(gate(ctx({ kind: "confirmation", created_at: "2026-01-01T00:00:00Z" })).send).toBe(false);

    // ⛔ ET LE DOUBLE OPT-IN N'EST PAS CASSÉ POUR AUTANT, il est borné : une confirmation FRAÎCHE
    // part toujours vers un abonné `pending`, qui est tout l'objet de ce message.
    const fraiche = gate(ctx({ kind: "confirmation", created_at: "2026-09-15T08:00:00Z", sub_status: "pending" }));
    expect(fraiche.send).toBe(true);
  });

  test("une date de mise en file illisible ne vaut pas « fraîche »", () => {
    // On ne peut pas affirmer qu'une ligne est récente si on ne sait pas quand elle a été écrite.
    const d = gate(ctx({ kind: "welcome", created_at: "pas-une-date" }));
    expect(d.send === false && d.reason).toBe("stale_outbox:unknown_date");
  });

  test("le plafond d'âge passe AVANT le consentement, et les deux raisons restent distinctes", () => {
    // Deux refus différents ne doivent pas se confondre : « trop vieux » se répare en reprenant la
    // file, « pas actif » ne se répare pas du tout.
    const vieuxEtInactif = gate(ctx({ kind: "welcome", created_at: "2026-08-01T00:00:00Z", sub_status: "pending" }));
    expect(vieuxEtInactif.send === false && vieuxEtInactif.reason.startsWith("stale_outbox:")).toBe(true);
    const fraisEtInactif = gate(ctx({ kind: "welcome", created_at: "2026-09-15T08:00:00Z", sub_status: "pending" }));
    expect(fraisEtInactif.send === false && fraisEtInactif.reason.startsWith("stale_outbox:")).toBe(false);
  });
});
