/**
 * CE QUE CES TESTS TIENNENT EN PLACE.
 *
 * Au 10/09/2026 la base porte 0 campagne d'acquisition, 0 créative rattachée, 0 intérêt et
 * 1 202 contacts de démonstration sur 1 203. **Tous les écrans de ce lot affichent zéro en ayant
 * raison** — et c'est exactement la situation où un écran juste et un écran cassé sont
 * indiscernables à l'œil. Ce qui est vérifié ici ne peut donc pas l'être à l'écran :
 *
 *  1. les CINQ états d'un intérêt, dont quatre absences qu'un tableau vide confond ;
 *  2. la garde de vacuité, parce que `cs.{}` matche TOUT LE MONDE et `ov.{}` PERSONNE (mesuré en
 *     production le 09/09/2026) : un tableau vide envoyé à PostgREST est soit une fuite totale,
 *     soit un zéro muet, et jamais une erreur.
 *
 * ⚠️ Aucun accès réseau : le client Supabase est un double qui enregistre les méthodes appelées et
 * leurs arguments. Ce qui est mesuré, c'est la REQUÊTE construite.
 */
import { describe, expect, test } from "bun:test";

import {
  countCaptureEvents,
  etatInterets,
  etatVideNiveau,
  listCaptureEvents,
  listCaptureInterests,
  listCaptureCampaigns,
  listVariantsPremiereTouche,
  variantDePremiereTouche,
} from "./capture";

const ASSET = "asset_1";

type Reponse = { data?: unknown; count?: number; error?: unknown };
type Appel = { table: string; methodes: { m: string; args: unknown[] }[] };

/** Double chaînable routé par table — même forme que `campaigns.test.ts`. */
function fauxDb(reponses: (table: string, n: number) => Reponse) {
  const appels: Appel[] = [];
  const compteur: Record<string, number> = {};

  const db = {
    from(table: string) {
      compteur[table] = (compteur[table] ?? 0) + 1;
      const rep = reponses(table, compteur[table]);
      const appel: Appel = { table, methodes: [] };
      appels.push(appel);

      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (resoudre: (v: unknown) => void) =>
                resoudre({ data: rep.data ?? null, error: rep.error ?? null, count: rep.count ?? null });
            }
            return (...args: unknown[]) => {
              appel.methodes.push({ m: prop, args });
              return chaine;
            };
          },
        },
      );
      return chaine;
    },
  };

  return { db: db as unknown as Parameters<typeof listCaptureInterests>[0], appels };
}

const tables = (appels: Appel[]) => appels.map((a) => a.table);
/** Tous les arguments de tous les appels d'une méthode donnée, toutes tables confondues. */
const argsDe = (appels: Appel[], m: string) =>
  appels.flatMap((a) => a.methodes.filter((x) => x.m === m).map((x) => x.args));

/* ══════════════════════════════════════════════════════════════════════════════
 * 1. Les cinq états — quatre absences, un cas normal
 * ════════════════════════════════════════════════════════════════════════════ */

describe("etatInterets — quatre absences qui ne veulent pas dire la même chose", () => {
  /**
   * ⛔ LE TEST CENTRAL. MUTATION QUI DOIT LE TUER : remplacer la fin de la fonction par
   * `return interestIds.length === 0 ? "not-asked" : "chosen"`.
   * Symptôme en production : un formulaire qui A POSÉ la question et n'a rien reçu affiche
   * « This form did not ask for interests ». L'écran affirme alors qu'on n'a rien demandé à
   * quelqu'un à qui on a demandé — et un ciblage « n'aime pas X » écrirait à cette personne.
   */
  test("les cinq entrées rendent cinq valeurs DISTINCTES", () => {
    const rendus = [
      etatInterets(null),
      etatInterets({ optinConnu: false, asksInterests: null, interestIds: [], interestsOffered: null }),
      etatInterets({ optinConnu: true, asksInterests: false, interestIds: [], interestsOffered: null }),
      etatInterets({ optinConnu: true, asksInterests: true, interestIds: [], interestsOffered: [1, 2] }),
      etatInterets({ optinConnu: true, asksInterests: true, interestIds: [7], interestsOffered: [1, 7] }),
    ];
    expect(rendus).toEqual(["no-form", "form-unknown", "not-asked", "asked-empty", "chosen"]);
    expect(new Set(rendus).size).toBe(5);
  });

  /** L'affirmation interdite, isolée : demandé + rien coché n'est JAMAIS « pas demandé ». */
  test("« demandé, rien coché » ne rend jamais not-asked", () => {
    expect(etatInterets({ optinConnu: true, asksInterests: true, interestIds: [], interestsOffered: null }))
      .toBe("asked-empty");
  });

  /**
   * MUTATION QUI DOIT TUER : faire retomber un événement sans créative sur `not-asked`.
   * Symptôme : l'écran décrit le comportement d'un formulaire qu'on n'a même pas retrouvé.
   */
  test("une créative non résolue ne se lit pas comme un formulaire sans question", () => {
    expect(etatInterets({ optinConnu: false, asksInterests: null, interestIds: [], interestsOffered: null }))
      .toBe("form-unknown");
  });

  /**
   * ⚠️ `interests_offered` NULL ≠ `'{}'` (commentaire de colonne, migration 0063).
   * Une offre explicitement NON VIDE prouve que la question a été posée, même si le drapeau
   * `asks_interests` de la créative est retombé à false depuis. Il décrit l'état COURANT du
   * formulaire, pas celui du jour de la capture.
   */
  test("une offre non vide vaut question posée, même si le drapeau courant dit non", () => {
    expect(etatInterets({ optinConnu: true, asksInterests: false, interestIds: [], interestsOffered: [3] }))
      .toBe("asked-empty");
    // `'{}'` = il proposait explicitement rien : là, « pas demandé » est la lecture juste.
    expect(etatInterets({ optinConnu: true, asksInterests: false, interestIds: [], interestsOffered: [] }))
      .toBe("not-asked");
  });

  /** Un intérêt coché prouve à lui seul que la question a été posée. */
  test("un intérêt coché l'emporte sur un drapeau retombé à false", () => {
    expect(etatInterets({ optinConnu: true, asksInterests: false, interestIds: [9], interestsOffered: null }))
      .toBe("chosen");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 2. La garde de vacuité — jamais `cs.{}`, jamais `ov.{}`
 * ════════════════════════════════════════════════════════════════════════════ */

describe("garde de vacuité — aucun tableau vide n'atteint PostgREST", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer le `if (valeurs.length === 0) return 0` de
   * `compteChevauchant`. Symptôme : un intérêt que plus aucune créative ne propose émet
   * `capture_optin_ids=ov.{}` — qui ne matche personne aujourd'hui, mais dont le jumeau `cs.{}`
   * matche 1 203 personnes sur 1 203. La garde ne dépend pas de l'opérateur choisi.
   */
  test("un intérêt proposé par AUCUNE créative n'émet aucun overlaps", async () => {
    const { db, appels } = fauxDb((table) => {
      if (table === "tag") return { data: [{ id: 5, slug: "interest:tag:x", label: "X", taxonomy: "tag" }] };
      if (table === "optin") return { data: [{ id: "o1", offered_interest_ids: [] }] };
      if (table === "capture_event") return { count: 0 };
      return { count: 0 };
    });

    const r = await listCaptureInterests(db, ASSET);

    expect(r.rows[0]?.asked).toBe(0);
    expect(r.rows[0]?.offeredBy).toBe(0);
    expect(argsDe(appels, "overlaps")).toHaveLength(0);
  });

  /**
   * Quand une créative propose l'intérêt, l'overlaps est bien émis — sinon le test précédent
   * passerait aussi sur une fonction qui n'interroge jamais rien.
   *
   * ⛔ MUTATION QUI DOIT LE TUER : calculer le taux « Of those asked » en divisant `contacts`
   * (toute la marque) par `asked` (les seuls sollicités). Symptôme : dès qu'une créative retire un
   * intérêt de son offre, ceux qui l'ont coché hier restent au numérateur et disparaissent du
   * dénominateur — l'écran affiche un taux au-dessus de 100 %, qui se lit comme un bug de calcul
   * alors que c'est la question qui est mal posée. Le numérateur porte donc la MÊME restriction de
   * population que le dénominateur, plus l'intérêt lui-même.
   */
  test("le numérateur du taux porte la même restriction de population que le dénominateur", async () => {
    const { db, appels } = fauxDb((table) => {
      if (table === "tag") return { data: [{ id: 5, slug: "interest:tag:x", label: "X", taxonomy: "tag" }] };
      if (table === "optin") return { data: [{ id: "o1", offered_interest_ids: [5] }] };
      return { count: 3 };
    });

    const r = await listCaptureInterests(db, ASSET);

    expect(r.rows[0]?.asked).toBe(3);
    expect(r.rows[0]?.chosenAmongAsked).toBe(3);
    // Deux overlaps : le dénominateur, puis le numérateur — jamais avec un tableau vide.
    const ov = argsDe(appels, "overlaps");
    expect(ov).toHaveLength(2);
    for (const [colonne, valeurs] of ov) {
      expect(colonne).toBe("capture_optin_ids");
      expect(valeurs).toEqual(["o1"]);
    }
    // Et le numérateur seul ajoute l'intérêt : c'est ce qui le garde ≤ dénominateur.
    expect(argsDe(appels, "contains")).toContainEqual(["interest_ids", [5]]);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : sommer les créatives d'une campagne au lieu du head-count.
   * Symptôme : quelqu'un entré par deux créatives d'une même campagne compte deux fois, et le
   * total d'une campagne peut dépasser le nombre de personnes qu'elle a fait entrer.
   */
  test("une campagne se compte par contains sur la projection, jamais par somme", async () => {
    const { db, appels } = fauxDb((table) => {
      if (table === "capture_campaign") return { data: [{ id: "c1", external_id: "e1", name: "Promo" }] };
      if (table === "optin") return { data: [{ id: "o1", capture_campaign_id: "c1" }, { id: "o2", capture_campaign_id: "c1" }] };
      return { count: 12 };
    });

    const r = await listCaptureCampaigns(db, ASSET);

    expect(r.rows[0]?.creatives).toBe(2);
    // 12 et 12, pas 24 : le compte ne dépend pas du nombre de créatives.
    expect(r.rows[0]?.contacts).toBe(12);
    expect(r.rows[0]?.sendable).toBe(12);
    expect(tables(appels)).toContain("sendable_subscription");
    const cs = argsDe(appels, "contains");
    expect(cs).toHaveLength(2);
    for (const [colonne, valeurs] of cs) {
      expect(colonne).toBe("capture_campaign_ids");
      expect(valeurs).toEqual(["c1"]);
    }
  });

  /** Sans campagne, aucun head-count : la marque du jour 1 ne paie pas de requêtes pour zéro. */
  test("aucune campagne ⇒ aucun compteur émis", async () => {
    const { db, appels } = fauxDb((table) => {
      if (table === "capture_campaign") return { data: [] };
      if (table === "optin") return { data: [] };
      return { count: 0 };
    });

    const r = await listCaptureCampaigns(db, ASSET);

    expect(r.rows).toEqual([]);
    expect(tables(appels)).not.toContain("subscription");
    expect(tables(appels)).not.toContain("sendable_subscription");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 2 bis. Une panne PARTIELLE ne se rend pas en zéro
 * ════════════════════════════════════════════════════════════════════════════ */

describe("panne partielle — la lecture ratée est nommée, jamais servie comme un zéro", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : remettre `reason: null` en dur au retour.
   * Symptôme : la lecture des créatives échoue, `offrantes` reste vide, et CHAQUE intérêt rend
   * « no one asked ». L'écran affirme alors que la question n'a jamais été posée à personne,
   * alors qu'on n'a simplement pas pu lire les formulaires — et ce jour-là, un zéro juste et un
   * zéro fabriqué sont le même pixel.
   */
  test("intérêts : une lecture des créatives en panne remonte son motif", async () => {
    const { db } = fauxDb((table) => {
      if (table === "tag") return { data: [{ id: 5, slug: "interest:tag:x", label: "X", taxonomy: "tag" }] };
      if (table === "optin") return { error: { message: "boom-optin" } };
      return { count: 0 };
    });

    const r = await listCaptureInterests(db, ASSET);

    expect(r.rows[0]?.asked).toBe(0);
    expect(r.reason).toBe("boom-optin");
  });

  /** Même panne, autre onglet : « 0 creatives » sur toutes les campagnes se lit comme une mesure. */
  test("campagnes : une lecture des créatives en panne remonte son motif", async () => {
    const { db } = fauxDb((table) => {
      if (table === "capture_campaign") return { data: [{ id: "c1", external_id: "e1", name: "Promo" }] };
      if (table === "optin") return { error: { message: "boom-optin" } };
      return { count: 0 };
    });

    const r = await listCaptureCampaigns(db, ASSET);

    expect(r.rows[0]?.creatives).toBe(0);
    expect(r.reason).toBe("boom-optin");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 3. P9 — l'origine des marques non autorisées n'atteint jamais le rendu
 * ════════════════════════════════════════════════════════════════════════════ */

describe("listCaptureEvents — le masquage d'origine est dans la REQUÊTE", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer le `.in("asset_id", allowedAssetIds)`, ou filtrer au
   * rendu plutôt qu'à la lecture. Symptôme : le drawer, VOLONTAIREMENT non scopé marque pour
   * montrer tous les consentements (obligation RGPD), servirait aussi le plan d'acquisition des
   * marques que la personne connectée n'a pas le droit de voir.
   */
  test("la requête est bornée aux marques autorisées", async () => {
    const { db, appels } = fauxDb(() => ({ data: [] }));

    await listCaptureEvents(db, ["s1"], [ASSET]);

    const ins = argsDe(appels, "in");
    expect(ins).toContainEqual(["asset_id", [ASSET]]);
    expect(ins).toContainEqual(["subscription_id", ["s1"]]);
  });

  /** Fail closed : aucune marque autorisée ⇒ aucune requête, donc rien à masquer au rendu. */
  test("aucune marque autorisée ⇒ aucune requête", async () => {
    const { db, appels } = fauxDb(() => ({ data: [] }));

    const r = await listCaptureEvents(db, ["s1"], []);

    expect(r).toEqual([]);
    expect(appels).toHaveLength(0);
  });

  /**
   * MUTATION QUI DOIT TUER : rapatrier les libellés d'intérêts par événement.
   * Sans identifiant à résoudre, la table `tag` ne doit pas être touchée du tout.
   */
  test("aucun intérêt sur la page ⇒ aucune lecture de tag", async () => {
    const { db, appels } = fauxDb((table) => {
      if (table === "capture_event") {
        return { data: [{ id: "e1", subscription_id: "s1", asset_id: ASSET, occurred_at: "2026-09-10T10:00:00Z", optin_id: "o1", interest_ids: [] }] };
      }
      return { data: [] };
    });

    const r = await listCaptureEvents(db, ["s1"], [ASSET]);

    expect(r).toHaveLength(1);
    expect(r[0]?.optinKnown).toBe(true);
    expect(tables(appels)).not.toContain("tag");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 5. L'état vide d'un niveau — « rien reçu » ≠ « rien à CE niveau »
 * ════════════════════════════════════════════════════════════════════════════ */

describe("etatVideNiveau — l'écran affirmait que le pont n'avait rien livré, sur une marque qui venait de recevoir", () => {
  /**
   * LE CAS RÉEL, 13/09/2026 : copper-kettle porte 4 inscriptions et 0 intérêt, parce que la créative
   * ne pose pas la question. L'onglet Interests annonçait « No lead has reached Copper Kettle yet »
   * et listait trois interrupteurs déjà fermés.
   */
  test("des inscriptions existent mais rien à ce niveau ⇒ on ne parle PAS du pont", () => {
    expect(etatVideNiveau({ known: true, value: 4 })).toBe("recu-sans-ce-niveau");
  });

  test("aucune inscription ⇒ le message des trois interrupteurs", () => {
    expect(etatVideNiveau({ known: true, value: 0 })).toBe("rien-recu");
  });

  /**
   * ⛔ LA MUTATION QUI DOIT TUER : replier une lecture ratée sur « rien reçu ». Un `known:false`
   * traité comme un zéro ramène exactement le défaut corrigé — l'écran accuserait le pont d'un
   * silence qu'il n'a pas mesuré.
   */
  test("lecture ratée ⇒ indéterminé, jamais « rien reçu »", () => {
    expect(etatVideNiveau({ known: false, value: 0 })).toBe("indetermine");
    // Même une valeur non nulle ne rachète pas une lecture ratée : elle n'est pas fiable.
    expect(etatVideNiveau({ known: false, value: 7 })).toBe("indetermine");
  });
});

describe("countCaptureEvents — un compteur absent n'est pas un zéro", () => {
  test("count null SANS erreur ⇒ known:false", async () => {
    // PostgREST ne renvoie pas toujours l'en-tête de comptage : `count` vaut alors `null` sans que
    // rien n'ait échoué. Le lire comme 0 ferait dire à l'écran « aucune inscription ».
    const { db } = fauxDb(() => ({ data: null }));
    expect(await countCaptureEvents(db, ASSET)).toEqual({ known: false, value: 0 });
  });

  test("erreur ⇒ known:false", async () => {
    const { db } = fauxDb(() => ({ error: { message: "boom" }, count: 12 }));
    expect(await countCaptureEvents(db, ASSET)).toEqual({ known: false, value: 0 });
  });

  test("comptage réussi ⇒ known:true et la valeur", async () => {
    const { db } = fauxDb(() => ({ count: 4 }));
    expect(await countCaptureEvents(db, ASSET)).toEqual({ known: true, value: 4 });
  });

  test("sans marque ⇒ aucune requête, et surtout aucune affirmation", async () => {
    const { db, appels } = fauxDb(() => ({ count: 99 }));
    expect(await countCaptureEvents(db, null)).toEqual({ known: false, value: 0 });
    expect(appels).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 6. Le bras A/B — information, et rattachée à la BONNE inscription
 * ════════════════════════════════════════════════════════════════════════════ */

describe("variantDePremiereTouche — le bras vient de la capture la PLUS ANCIENNE, d'aucune autre", () => {
  /**
   * ⛔ LA MUTATION QUI DOIT TUER : retenir « le premier bras non nul rencontré ». Afficher le bras
   * d'une inscription ultérieure sous le nom du formulaire d'une autre rapproche deux valeurs
   * vraies pour en faire une phrase fausse, et rien ne le signale.
   */
  test("première capture sans bras, une plus récente en a un ⇒ RIEN n'est affiché", () => {
    const out = variantDePremiereTouche([
      { subscriptionId: "s1", occurredAt: "2026-09-11T10:00:00Z", variantExternalId: "B pelota" },
      { subscriptionId: "s1", occurredAt: "2026-09-10T22:05:00Z", variantExternalId: null },
    ]);
    expect(out.s1).toBeUndefined();
  });

  test("la plus ancienne porte le bras ⇒ c'est celui-là, pas le plus récent", () => {
    const out = variantDePremiereTouche([
      { subscriptionId: "s1", occurredAt: "2026-09-11T10:00:00Z", variantExternalId: "E radio" },
      { subscriptionId: "s1", occurredAt: "2026-09-10T22:05:00Z", variantExternalId: "B pelota" },
    ]);
    expect(out.s1).toBe("B pelota");
  });

  test("plusieurs souscriptions ⇒ chacune la sienne", () => {
    const out = variantDePremiereTouche([
      { subscriptionId: "s1", occurredAt: "2026-09-10T22:05:00Z", variantExternalId: "B pelota" },
      { subscriptionId: "s2", occurredAt: "2026-09-11T10:54:00Z", variantExternalId: "E radio" },
      { subscriptionId: "s3", occurredAt: "2026-09-11T01:43:00Z", variantExternalId: null },
    ]);
    expect(out).toEqual({ s1: "B pelota", s2: "E radio" });
  });

  /** Deux écritures du même instant : la comparaison doit être temporelle, pas lexicographique. */
  test("décalages horaires différents ⇒ c'est bien l'instant qui ordonne", () => {
    const out = variantDePremiereTouche([
      // 2026-09-10T23:00:00Z
      { subscriptionId: "s1", occurredAt: "2026-09-10T20:00:00-03:00", variantExternalId: "ancien" },
      // 2026-09-11T00:00:00Z — plus tard, alors que la chaîne « 2026-09-11T00… » est plus PETITE
      // que « 2026-09-10T20… » ne l'est pas : c'est l'inverse qui piège, d'où ce test.
      { subscriptionId: "s1", occurredAt: "2026-09-11T00:00:00Z", variantExternalId: "recent" },
    ]);
    expect(out.s1).toBe("ancien");
  });

  test("horodatage illisible ⇒ l'événement est ignoré, jamais retenu comme le plus ancien", () => {
    const out = variantDePremiereTouche([
      { subscriptionId: "s1", occurredAt: "pas une date", variantExternalId: "faux" },
      { subscriptionId: "s1", occurredAt: "2026-09-11T10:00:00Z", variantExternalId: "vrai" },
    ]);
    expect(out.s1).toBe("vrai");
  });
});

describe("listVariantsPremiereTouche — garde de vacuité et tri", () => {
  test("aucune souscription ⇒ aucune requête", async () => {
    const { db, appels } = fauxDb(() => ({ data: [] }));
    expect(await listVariantsPremiereTouche(db, [])).toEqual({});
    expect(appels).toHaveLength(0);
  });

  /**
   * Le tri ASC n'est pas cosmétique : c'est lui qui rend la troncature SÛRE. Si un événement d'une
   * souscription est dans le préfixe, tous ses aînés y sont aussi — donc le premier y est.
   */
  test("tri occurred_at ASCENDANT, et une limite", async () => {
    const { db, appels } = fauxDb(() => ({ data: [] }));
    await listVariantsPremiereTouche(db, ["s1"]);
    expect(argsDe(appels, "order")).toContainEqual(["occurred_at", { ascending: true }]);
    expect(argsDe(appels, "limit")).toHaveLength(1);
    // ⛔ Les trois colonnes sont nommées ici : en retirer une ne casserait rien d'autre, et le
    // bras disparaîtrait de la liste sans erreur ni case vide — indiscernable du cas « pas de
    // bras transmis », puisque l'écran se tait dans les deux cas.
    expect(argsDe(appels, "select")).toContainEqual(["subscription_id, occurred_at, variant_external_id"]);
  });

  /**
   * ⛔ Les trois tests ci-dessus sortent AVANT la conversion des lignes : `data` vide ou en erreur.
   * Sans ce test-ci, toute mutation du passage `snake_case` → `camelCase` survivrait — et la panne
   * serait muette, puisque l'absence de bras ne s'affiche pas.
   */
  test("une ligne brute ⇒ les clés lues sont bien celles du select", async () => {
    const { db } = fauxDb(() => ({
      data: [{
        subscription_id: "s1",
        occurred_at: "2026-09-10T22:05:46Z",
        variant_external_id: "B pelota sobre rojo",
      }],
    }));
    expect(await listVariantsPremiereTouche(db, ["s1"])).toEqual({ s1: "B pelota sobre rojo" });
  });

  test("lecture en erreur ⇒ aucun bras inventé", async () => {
    const { db } = fauxDb(() => ({ error: { message: "boom" } }));
    expect(await listVariantsPremiereTouche(db, ["s1"])).toEqual({});
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 7. « Last signup » — l'inscription, jamais l'ingestion
 * ════════════════════════════════════════════════════════════════════════════ */

describe("listCaptureCampaigns — la date affichée est celle du signup", () => {
  const campagne = {
    id: "c1", external_id: "x1", name: "Historical",
    first_seen_at: "2026-08-21T00:00:00Z",
    // L'ingestion : le jour du rejeu. C'est CE qui s'affichait sous « Last signup ».
    last_seen_at: "2026-09-13T13:38:44Z",
    archived_at: null,
  };

  test("lastSignupAt vient de capture_source_stats, pas de last_seen_at", async () => {
    const { db } = fauxDb((table) => {
      if (table === "capture_campaign") return { data: [campagne] };
      if (table === "capture_source_stats") {
        return {
          data: [
            { capture_campaign_id: "c1", last_signup_at: "2026-09-10T22:05:46Z" },
            { capture_campaign_id: "c1", last_signup_at: "2026-09-11T10:54:03Z" },
            // Une créative d'une AUTRE campagne ne doit pas déteindre.
            { capture_campaign_id: "c2", last_signup_at: "2026-09-12T00:00:00Z" },
            // Une créative jamais utilisée : `null` ne doit pas écraser une vraie date.
            { capture_campaign_id: "c1", last_signup_at: null },
          ],
        };
      }
      return { data: [] };
    });

    const r = await listCaptureCampaigns(db, ASSET);

    expect(r.rows[0]?.lastSignupAt).toBe("2026-09-11T10:54:03Z");
    expect(r.rows[0]?.lastSeenAt).toBe("2026-09-13T13:38:44Z");
    expect(r.lastSignupKnown).toBe(true);
  });

  /**
   * ⛔ Sans la vue, toutes les dates sont nulles — et « Never » sur chaque ligne se lirait comme une
   * mesure. L'écran doit pouvoir se taire, donc il doit SAVOIR que la lecture a échoué.
   */
  test("vue illisible ⇒ lastSignupKnown:false, et les campagnes restent affichées", async () => {
    const { db } = fauxDb((table) => {
      if (table === "capture_campaign") return { data: [campagne] };
      if (table === "capture_source_stats") return { error: { message: "boom" } };
      return { data: [] };
    });

    const r = await listCaptureCampaigns(db, ASSET);

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.lastSignupAt).toBeNull();
    expect(r.lastSignupKnown).toBe(false);
  });

  /**
   * ⛔ `lastSignupAt: null` ne veut PAS dire « Never » à lui seul : la date vient des créatives
   * rattachées AUJOURD'HUI, les contacts du rattachement figé à l'inscription. Une campagne dont la
   * créative a été déplacée chez l'émetteur rend `null` ici tout en gardant ses contacts — c'est la
   * cellule qui tranche (`page.tsx`, « Not on current creatives »). Ici, la fixture est vide de part
   * en part : aucune créative, aucun contact, donc « Never » est bien la lecture juste.
   */
  test("ni créative rattachée ni contact ⇒ lastSignupAt null et known:true", async () => {
    const { db } = fauxDb((table) => {
      if (table === "capture_campaign") return { data: [campagne] };
      return { data: [] };
    });

    const r = await listCaptureCampaigns(db, ASSET);

    expect(r.rows[0]?.lastSignupAt).toBeNull();
    expect(r.lastSignupKnown).toBe(true);
  });
});
