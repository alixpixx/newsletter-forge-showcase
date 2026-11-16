/**
 * COMPTER UNE AUDIENCE SANS CIBLAGE.
 *
 * Jusqu'au 08/09/2026, `estimateAudience` refusait de compter dès que la campagne n'avait pas de
 * segment (`eligible: null`). Ce refus ne restait pas dans son coin : la route `/schedule` exige un
 * compte pour figer `recipients_planned`, donc une campagne sans segment ne pouvait pas être
 * planifiée du tout. Le segment étant devenu facultatif, « pas de ciblage » doit se compter comme
 * ce qu'il est — toute la marque — et non se refuser.
 *
 * ⛔ CE QUE CES TESTS TIENNENT EN PLACE. Le ciblage n'a jamais été la barrière de consentement ;
 * l'ouvrir ne doit donc rien retirer aux vraies barrières, qui sont deux : la vue
 * `sendable_subscription` (toujours interrogée) et le gate de FINALITÉ (toujours exigé). Et la
 * distinction qui garde le tout honnête : un segment ABSENT se compte, un segment DÉSIGNÉ mais
 * illisible se refuse — sinon une donnée corrompue deviendrait un envoi de masse.
 *
 * ⚠️ Aucun accès réseau : le client Supabase est un double qui répond par table et enregistre les
 * filtres reçus. Ce qui est mesuré, c'est la REQUÊTE construite, pas ce que PostgREST en ferait.
 */
import { describe, expect, test } from "bun:test";

// ⚠️ `campaigns.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import si AUTH_SECRET manque.
// Même parade que `auth.test.ts` : poser la variable, puis charger le module dynamiquement — un
// import statique serait hissé avant l'affectation et le fichier échouerait au chargement.
process.env.AUTH_SECRET = "secret-de-test-uniquement-08092026";
const { estimateAudience, CAMPAIGN_SELECT, mapCampaign, lireCampagnes, compterCampagnesParOnglet } = await import(
  "./campaigns"
);

const ASSET = "asset_1";
const SEGMENT = "11111111-1111-4111-8111-111111111111";

/** Provenance de la marque courante — les seules valeurs que la liste blanche doit autoriser. */
const CAMPAGNE_DE_LA_MARQUE = "aaaaaaaa-1111-4111-8111-111111111111";
const CREATIVE_DE_LA_MARQUE = "cccccccc-3333-4333-8333-333333333333";
const INTERET_DE_LA_MARQUE = 7;
/** Une campagne d'acquisition d'une AUTRE marque : un uuid parfaitement valide, et interdit. */
const CAMPAGNE_ETRANGERE = "bbbbbbbb-2222-4222-8222-222222222222";
const AUTOMATION_DE_LA_MARQUE = "dddddddd-4444-4444-8444-444444444444";
/** Un tag de la marque qui n'est PAS un intérêt (`kind` nul) : valide comme tag, interdit ici. */
const TAG_NON_INTERET = 1;

type Reponse = { data?: unknown; count?: number; error?: unknown };
type Appel = { table: string; methodes: { m: string; args: unknown[] }[] };

/**
 * Double chaînable, routé par table. `reponses(table, n)` reçoit le rang de l'appel pour cette
 * table : `sendable_subscription` est interrogée deux fois — une fois pour le total envoyable, une
 * fois pour le sous-ensemble ayant accordé la finalité.
 */
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

  return { db: db as unknown as Parameters<typeof estimateAudience>[0], appels };
}

/**
 * Base « nominale » : 500 envoyables, 300 ayant accordé la finalité, 4 contacts de démonstration,
 * 7 abonnés réels écartés par le sunset.
 */
const BASE = (table: string, n: number): Reponse => {
  if (table === "sendable_subscription") return { count: n === 1 ? 500 : 300 };
  if (table === "excluded_demo_subscription") return { count: 4 };
  if (table === "sunsetted_subscription") return { count: 7 };
  if (table === "asset_edition") return { data: [{ id: "ed_1", compliance_regime: "gdpr" }] };
  // ⚠️ `kind` EST DANS LE DOUBLE parce qu'il est dans la vraie lecture : c'est lui qui sépare un
  // intérêt du pont d'un tag posé à la main. Un double qui l'ignorerait rendrait le test aveugle à
  // la seule barrière qui protège le niveau 3.
  if (table === "tag") {
    return { data: [
      { id: TAG_NON_INTERET, slug: "vip", kind: null },
      { id: INTERET_DE_LA_MARQUE, slug: "futebol", kind: "interest" },
    ] };
  }
  if (table === "optin") return { data: [{ id: CREATIVE_DE_LA_MARQUE, slug: "guia" }] };
  if (table === "capture_campaign") return { data: [{ id: CAMPAGNE_DE_LA_MARQUE }] };
  if (table === "automation") return { data: [{ id: AUTOMATION_DE_LA_MARQUE }] };
  return { data: null };
};

const tables = (appels: Appel[]) => appels.map((a) => a.table);

describe("estimateAudience — sans segment, le compte porte sur toute la marque", () => {
  /**
   * ⛔ LE TEST CENTRAL. MUTATION QUI DOIT LE TUER : rétablir
   * `if (!segmentId) return { ...base, reason: "campaign has no segment" }`.
   * Symptôme en production : la planification refuse la campagne, sans que rien n'indique que le
   * blocage vient du compteur et non de l'audience.
   */
  test("le compte existe, et il n'y a pas de motif de refus", async () => {
    const { db } = fauxDb(BASE);
    const r = await estimateAudience(db, ASSET, null, "content");

    expect(r.eligible).toBe(300);
    expect(r.sendable).toBe(500);
    expect(r.reason).toBeNull();
    // La réponse porte l'absence de ciblage : c'est ce que l'écran lit pour dire « in this brand ».
    expect(r.segmentId).toBeNull();
  });

  /**
   * Sans segment, ni la table `segment` ni la table `tag` n'ont de raison d'être interrogées.
   * MUTATION QUI DOIT TUER : chercher quand même le segment — `findSegment(null)` rendrait `null`
   * et le compteur répondrait « segment not found » sur une campagne parfaitement valide.
   */
  test("aucune règle de segment n'est cherchée", async () => {
    const { db, appels } = fauxDb(BASE);
    await estimateAudience(db, ASSET, null, "content");

    expect(tables(appels)).not.toContain("segment");
    expect(tables(appels)).not.toContain("tag");
    expect(tables(appels)).toContain("sendable_subscription");
  });

  /**
   * ⛔ LE GATE DE FINALITÉ RESTE POSÉ — c'est lui la barrière, pas le ciblage. Le second appel à la
   * vue porte un `.or()` de plus que le premier : celui du consentement.
   * MUTATION QUI DOIT TUER : compter l'éligible sans le gate.
   */
  test("le second comptage ajoute le filtre de consentement", async () => {
    const { db, appels } = fauxDb(BASE);
    await estimateAudience(db, ASSET, null, "content");

    const vues = appels.filter((a) => a.table === "sendable_subscription");
    expect(vues).toHaveLength(2);
    const ors = (a: Appel) => a.methodes.filter((m) => m.m === "or").length;
    // Sans ciblage, le premier comptage n'a AUCUN `or` ; le second en a exactement un, le gate.
    expect(ors(vues[0]!)).toBe(0);
    expect(ors(vues[1]!)).toBe(1);
  });

  /** Sans finalité, le total reste comptable mais l'éligible n'a aucun sens : il reste nul. */
  /**
   * ⛔ LES DEUX COMPLÉMENTS SONT COMPTÉS, PAS UN SEUL. 0057 a ajouté `sunset_at is null` à la
   * barrière d'envoi sans compensation : un abonné marqué a cessé d'apparaître dans le compte
   * envoyable ET dans le compte démonstration, alors que l'écran présente le second comme
   * « le complément exact » du premier. L'opérateur lisait « 0 destinataire, 0 écarté » sans
   * explication, et soupçonnait la règle qu'il venait d'écrire.
   * MUTATION QUI DOIT TUER : retirer l'interrogation de `sunsetted_subscription`.
   */
  test("les deux comptes d'explication sont interrogés et remontés", async () => {
    const { db, appels } = fauxDb(BASE);
    const r = await estimateAudience(db, ASSET, null, "content");

    expect(r.demoExcluded).toBe(4);
    expect(r.sunsetExcluded).toBe(7);
    expect(tables(appels)).toContain("excluded_demo_subscription");
    expect(tables(appels)).toContain("sunsetted_subscription");
  });

  /**
   * Un complément qu'on ne sait pas compter vaut `null`, jamais 0 : « personne n'est écarté » et
   * « je n'ai pas pu compter » ne se disent pas avec le même chiffre.
   */
  test("un complément non comptable rend null, pas zéro", async () => {
    const { db } = fauxDb((table, n) =>
      table === "sunsetted_subscription" ? { error: { message: "vue absente" } } : BASE(table, n),
    );
    const r = await estimateAudience(db, ASSET, null, "content");

    expect(r.sunsetExcluded).toBeNull();
    // ⛔ Et l'estimation, elle, aboutit : expliquer un chiffre est utile, pas vital.
    expect(r.sendable).toBe(500);
    expect(r.reason).toBeNull();
  });

  test("sans finalité, l'éligible reste nul et le motif le nomme", async () => {
    const { db } = fauxDb(BASE);
    const r = await estimateAudience(db, ASSET, null, null);

    expect(r.sendable).toBe(500);
    expect(r.eligible).toBeNull();
    expect(r.reason).toBe("campaign has no purpose");
  });
});

describe("estimateAudience — ce que l'ouverture ne doit PAS emporter", () => {
  /**
   * ⛔ ABSENT ≠ ILLISIBLE. Un segment désigné dont la règle ne se lit pas reste un refus de compter.
   * MUTATION QUI DOIT TUER : traiter la règle illisible comme « pas de ciblage ».
   */
  test("un segment désigné à la règle illisible refuse toujours de compter", async () => {
    const { db } = fauxDb((t, n) =>
      t === "segment" ? { data: { id: SEGMENT, name: "VIP", rule_json: null } } : BASE(t, n),
    );
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.eligible).toBeNull();
    expect(r.reason).toBe("segment rule is empty or unreadable");
  });

  test("un segment désigné mais introuvable reste un refus distinct", async () => {
    const { db } = fauxDb((t, n) => (t === "segment" ? { data: null } : BASE(t, n)));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.eligible).toBeNull();
    expect(r.reason).toBe("segment not found");
  });

  /** Le chemin avec segment lisible n'a pas bougé : la règle est compilée et le ciblage appliqué. */
  test("avec un segment lisible, le ciblage s'ajoute au comptage", async () => {
    const regle = {
      id: "root",
      type: "group",
      op: "AND",
      children: [{ id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" }],
    };
    const { db, appels } = fauxDb((t, n) =>
      t === "segment" ? { data: { id: SEGMENT, name: "VIP", rule_json: regle } } : BASE(t, n),
    );
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.eligible).toBe(300);
    expect(tables(appels)).toContain("tag");
    const vues = appels.filter((a) => a.table === "sendable_subscription");
    // Ciblage sur le premier comptage, ciblage + gate sur le second.
    expect(vues[0]!.methodes.filter((m) => m.m === "or")).toHaveLength(1);
    expect(vues[1]!.methodes.filter((m) => m.m === "or")).toHaveLength(2);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * LA PROVENANCE — mesurée le 13/09/2026 INERTE : elle compilait sans erreur et ne filtrait rien
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Un segment fait d'un seul prédicat de provenance.
 * `valeurs` est toujours un TABLEAU : `any_of`/`none_of` sont les seuls opérateurs du niveau.
 */
function regleDeProvenance(field: string, op: string, valeurs: string[]) {
  return {
    id: "root",
    type: "group",
    op: "AND",
    children: [{ id: "n1", type: "predicate", field, op, value: valeurs }],
  };
}

function dbAvecRegle(regle: unknown) {
  return fauxDb((t, n) =>
    t === "segment" ? { data: { id: SEGMENT, name: "Provenance", rule_json: regle } } : BASE(t, n),
  );
}

/** L'expression de ciblage réellement remise à PostgREST pour le PREMIER comptage. */
function ciblageRemis(appels: Appel[]): string | undefined {
  const vue = appels.filter((a) => a.table === "sendable_subscription")[0];
  const or = vue?.methodes.find((m) => m.m === "or");
  return or?.args[0] as string | undefined;
}

/**
 * ⛔ ON ÉVALUE LA SORTIE PRODUITE, PAS L'ARITHMÉTIQUE DU COMPILATEUR.
 *
 * Vérifier que l'expression « contient ov » prouve qu'une chaîne a été écrite, pas qu'elle FILTRE —
 * et c'est très exactement le défaut réparé ici : le prédicat de provenance compilait sans une
 * seule erreur et ne retirait personne de l'audience. On applique donc l'expression produite à des
 * abonnés fictifs, et on regarde qui reste.
 *
 * ⚠️ Une forme que ce banc ne sait pas lire LÈVE. Rendre `false` par défaut ferait « passer » un
 * test sur une expression jamais évaluée — un vert qui ne prouve rien, c'est-à-dire le pire des
 * résultats possibles ici.
 */
function matche(expr: string | undefined, abonne: Record<string, string[]>): boolean {
  const m = /^([a-z_]+)\.(not\.)?ov\.\{(.*)\}$/.exec(expr ?? "");
  if (!m) throw new Error(`expression non évaluable par ce banc : ${String(expr)}`);
  const [, colonne, negation, liste] = m;
  const attendues = liste ? liste.split(",") : [];
  const chevauche = (abonne[colonne!] ?? []).some((v) => attendues.includes(v));
  return negation ? !chevauche : chevauche;
}

describe("estimateAudience — les segments de provenance FILTRENT", () => {
  /**
   * ⛔⛔ LE TEST CENTRAL DE CE LOT. Un ciblage « venu de telle campagne d'acquisition » doit
   * produire un filtre qui EXCLUT quelqu'un — pas une règle affichée à l'écran que la requête
   * n'applique pas.
   *
   * MUTATION QUI DOIT LE TUER : retirer `captureCampaignIds` de `ruleContextForAsset` (ou
   * revenir à `compileRule(rule, { tagIdBySlug, optinIdBySlug })`). La liste blanche absente fait
   * `denonce()` puis rend `null` : le prédicat est dénoncé, la règle est jugée ÉLARGIE, et
   * `estimateAudience` refuse de compter. `r.reason` cesse d'être nul et `matche` lève.
   */
  test("un ciblage par campagne d'acquisition produit un filtre, et ce filtre exclut", async () => {
    const { db, appels } = dbAvecRegle(regleDeProvenance("capture_campaign", "any_of", [CAMPAGNE_DE_LA_MARQUE]));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.reason).toBeNull();
    expect(r.unsupported).toEqual([]);
    const expr = ciblageRemis(appels);
    expect(expr).toBe(`capture_campaign_ids.ov.{${CAMPAGNE_DE_LA_MARQUE}}`);

    // Celui qui vient de la campagne reste ; les DEUX autres sont EXCLUS.
    expect(matche(expr, { capture_campaign_ids: [CAMPAGNE_DE_LA_MARQUE] })).toBe(true);
    expect(matche(expr, { capture_campaign_ids: [CAMPAGNE_ETRANGERE] })).toBe(false);
    expect(matche(expr, { capture_campaign_ids: [] })).toBe(false);
  });

  /**
   * ⛔ « NONE OF » DOIT EXCLURE CEUX QU'IL NOMME, ET GARDER LES AUTRES. Compilé en `cs`
   * (« contient TOUTES ») au lieu de `ov`, il répondrait à l'inverse de la question et échouerait en
   * RÉTRÉCISSANT — aucun e-mail parti, rien à l'écran pour le dire.
   */
  test("une exclusion par campagne retire les bons abonnés et garde les autres", async () => {
    const { db, appels } = dbAvecRegle(regleDeProvenance("capture_campaign", "none_of", [CAMPAGNE_DE_LA_MARQUE]));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.reason).toBeNull();
    const expr = ciblageRemis(appels);
    expect(matche(expr, { capture_campaign_ids: [CAMPAGNE_DE_LA_MARQUE] })).toBe(false);
    expect(matche(expr, { capture_campaign_ids: [] })).toBe(true);
  });

  /**
   * MUTATION QUI DOIT TUER : retirer `captureOptinIds` du contexte. Le niveau 2 lit
   * `capture_optin_ids` (TOUTES les créatives touchées), à ne pas confondre avec le champ scalaire
   * `optin` qui ne porte que la première.
   */
  test("un ciblage par créative produit un filtre, et ce filtre exclut", async () => {
    const { db, appels } = dbAvecRegle(regleDeProvenance("capture_creative", "any_of", [CREATIVE_DE_LA_MARQUE]));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.reason).toBeNull();
    const expr = ciblageRemis(appels);
    expect(expr).toBe(`capture_optin_ids.ov.{${CREATIVE_DE_LA_MARQUE}}`);
    expect(matche(expr, { capture_optin_ids: [CREATIVE_DE_LA_MARQUE] })).toBe(true);
    expect(matche(expr, { capture_optin_ids: [CAMPAGNE_ETRANGERE] })).toBe(false);
  });

  /**
   * MUTATION QUI DOIT TUER : retirer `interestIds` du contexte.
   */
  test("un ciblage par intérêt produit un filtre, et ce filtre exclut", async () => {
    const { db, appels } = dbAvecRegle(
      regleDeProvenance("interest", "any_of", [String(INTERET_DE_LA_MARQUE)]),
    );
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.reason).toBeNull();
    const expr = ciblageRemis(appels);
    expect(expr).toBe(`interest_ids.ov.{${INTERET_DE_LA_MARQUE}}`);
    expect(matche(expr, { interest_ids: [String(INTERET_DE_LA_MARQUE)] })).toBe(true);
    expect(matche(expr, { interest_ids: ["9"] })).toBe(false);
  });

  /**
   * La famille « Automations » (24/09/2026). MUTATION QUI DOIT TUER : retirer `automationIds` de
   * `ruleContextForAsset` — le repli fermé dénonce alors le prédicat et le compte refuse.
   */
  test("un ciblage « a reçu un e-mail de cette automation » produit un filtre, et ce filtre exclut", async () => {
    const { db, appels } = dbAvecRegle(regleDeProvenance("automation_email", "any_of", [AUTOMATION_DE_LA_MARQUE]));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.reason).toBeNull();
    const expr = ciblageRemis(appels);
    expect(expr).toBe(`automations_sent.ov.{${AUTOMATION_DE_LA_MARQUE}}`);
    expect(matche(expr, { automations_sent: [AUTOMATION_DE_LA_MARQUE] })).toBe(true);
    expect(matche(expr, { automations_sent: [] })).toBe(false);
  });

  test("les e-mails système n'ont besoin d'aucune lecture : leur liste blanche est le registre", async () => {
    const { db, appels } = dbAvecRegle(regleDeProvenance("lifecycle_email", "none_of", ["welcome"]));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.reason).toBeNull();
    const expr = ciblageRemis(appels);
    expect(expr).toBe("lifecycle_sent.not.ov.{welcome}");
    expect(matche(expr, { lifecycle_sent: ["confirmation", "welcome"] })).toBe(false);
    expect(matche(expr, { lifecycle_sent: ["confirmation"] })).toBe(true);
  });
});

describe("estimateAudience — ce que la liste blanche de provenance interdit", () => {
  /**
   * ⛔ UN IDENTIFIANT D'UNE AUTRE MARQUE EST UN UUID PARFAITEMENT VALIDE. Sans liste blanche il
   * compilerait en un filtre irréprochable, qui ne matche personne en `any_of` et TOUT LE MONDE en
   * `none_of` — et rien n'apparaîtrait dans `unsupported`, puisqu'un id faux reste un id.
   *
   * MUTATION QUI DOIT TUER : retirer `.eq("asset_id", assetId)` de la lecture de
   * `capture_campaign` dans `ruleContextForAsset` — le test ci-dessous, qui vérifie le scope de la
   * requête, tombe le premier ; celui-ci tombe dès que le double sert la campagne étrangère.
   */
  test("une campagne d'une autre marque est dénoncée, et le compte REFUSE", async () => {
    const { db } = dbAvecRegle(regleDeProvenance("capture_campaign", "any_of", [CAMPAGNE_ETRANGERE]));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.eligible).toBeNull();
    expect(r.sendable).toBeNull();
    expect(r.reason).toContain("targeting is incomplete");
    // Le motif NOMME le coupable : « capture_campaign » seul ne dirait pas lequel des trois.
    expect(r.unsupported.join("|")).toContain(CAMPAGNE_ETRANGERE);
  });

  /** La lecture de la liste blanche est SCOPÉE MARQUE — c'est tout ce qui la rend blanche. */
  test("la liste blanche des campagnes est lue scopée à la marque", async () => {
    const { db, appels } = dbAvecRegle(regleDeProvenance("capture_campaign", "any_of", [CAMPAGNE_DE_LA_MARQUE]));
    await estimateAudience(db, ASSET, SEGMENT, "content");

    const lecture = appels.find((a) => a.table === "capture_campaign");
    expect(lecture).toBeDefined();
    expect(
      lecture!.methodes.some((m) => m.m === "eq" && m.args[0] === "asset_id" && m.args[1] === ASSET),
    ).toBe(true);
  });

  /** MUTATION QUI DOIT TUER : retirer `.eq("asset_id", assetId)` de la lecture de `automation`. */
  test("la liste blanche des automations est lue scopée à la marque, et en refuse une autre", async () => {
    const { db, appels } = dbAvecRegle(regleDeProvenance("automation_email", "none_of", [CAMPAGNE_ETRANGERE]));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    // `none_of` sur l'automation d'une autre marque matcherait TOUT LE MONDE : refusé, et nommé.
    expect(r.eligible).toBeNull();
    expect(r.reason).toContain("targeting is incomplete");
    expect(r.unsupported.join("|")).toContain(CAMPAGNE_ETRANGERE);
    const lecture = appels.find((a) => a.table === "automation");
    expect(lecture?.table).toBe("automation");
    expect(
      lecture!.methodes.some((m) => m.m === "eq" && m.args[0] === "asset_id" && m.args[1] === ASSET),
    ).toBe(true);
  });

  /**
   * ⛔ `kind`, JAMAIS UN LIKE SUR LE SLUG. « vip » est un vrai tag de la marque, donc un identifiant
   * que la marque possède — mais ce n'est pas un intérêt déclaré au formulaire. L'autoriser comme
   * intérêt ferait compiler `interest_ids.ov.{1}`, un filtre valide qui ne retient personne en
   * `any_of` et TOUT LE MONDE en `none_of`.
   *
   * MUTATION QUI DOIT TUER : remplacer `if (t.kind === "interest")` par un `push` inconditionnel
   * dans `ruleContextForAsset`.
   */
  test("un tag de la marque qui n'est pas un intérêt ne peut pas servir de critère d'intérêt", async () => {
    const { db } = dbAvecRegle(regleDeProvenance("interest", "any_of", [String(TAG_NON_INTERET)]));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.eligible).toBeNull();
    expect(r.reason).toContain("targeting is incomplete");
  });

  /**
   * ⛔ UNE LECTURE RATÉE NE S'ÉCRIT PAS « AUCUNE VALEUR AUTORISÉE » SANS CONSÉQUENCE : elle doit
   * faire REFUSER le compte, jamais l'élargir. `undefined` et `[]` mènent tous deux au refus
   * aujourd'hui ; ce test tient la porte fermée le jour où l'un des deux changerait de sens.
   */
  test("une liste blanche illisible fait refuser le compte, jamais élargir", async () => {
    const { db } = fauxDb((t, n) => {
      if (t === "segment") {
        return {
          data: {
            id: SEGMENT, name: "Provenance",
            rule_json: regleDeProvenance("capture_campaign", "any_of", [CAMPAGNE_DE_LA_MARQUE]),
          },
        };
      }
      if (t === "capture_campaign") return { error: { message: "relation absente" } };
      return BASE(t, n);
    });
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");

    expect(r.eligible).toBeNull();
    expect(r.reason).toContain("targeting is incomplete");
  });
});

/**
 * RELIRE LA CADENCE — le banc du défaut « rien ne se sauvegarde » (18/09/2026).
 *
 * Les colonnes `recurrence_*` étaient écrites par `/api/campaigns/[id]/recurrence` depuis les
 * migrations 0027/0067, et relues par PERSONNE : ni le `SELECT` de cette couche, ni un écran. Vu
 * d'Alix, une série enregistrée avec succès n'existait nulle part.
 *
 * ⛔ MUTATION QUI DOIT TUER CE BANC : retirer une colonne `recurrence_*` du `SELECT`. C'est
 * exactement la forme qu'avait le défaut — une écriture sans relecture ne lève aucune erreur, ne
 * casse aucun type, et n'est visible que par l'écran vide qu'elle produit.
 */
describe("CAMPAIGN_SELECT — ce que la liste lit doit contenir ce que les routes écrivent", () => {
  test("les 8 colonnes de cadence sont demandées", () => {
    for (const colonne of [
      "recurrence_days",
      "recurrence_time",
      "recurrence_every_weeks",
      "recurrence_until",
      "recurrence_active",
      "timezone",
      "freeze_lead_minutes",
      "edition_start",
    ]) {
      expect(CAMPAIGN_SELECT).toContain(colonne);
    }
  });

  /**
   * Le snapshot pèse jusqu'à 100 Ko et n'a aucun usage à l'écran. `toContain` viserait aussi
   * « html_shell_size » : on cible la colonne entière, entourée de ses séparateurs.
   */
  test("le rendu figé n'est JAMAIS chargé pour une liste", () => {
    const colonnes = CAMPAIGN_SELECT.split(",").map((c) => c.trim());
    expect(colonnes).not.toContain("html_shell");
    expect(colonnes).not.toContain("text_shell");
  });
});

describe("mapCampaign — de la base à l'écran", () => {
  /** `time without time zone` revient en "10:00:00" ; l'écran et le formulaire parlent en "HH:MM". */
  test("l'heure perd ses secondes", () => {
    expect(mapCampaign({ recurrence_time: "10:00:00" }).recurrenceTime).toBe("10:00");
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : rendre `null` quand la colonne est absente. Chaque écran devrait
   * alors se souvenir de distinguer « pas de jours » de « colonne pas encore en cache PostgREST »,
   * alors que les deux se lisent « campagne ponctuelle ».
   */
  test("sans jours, la cadence est un tableau vide — jamais null", () => {
    expect(mapCampaign({}).recurrenceDays).toEqual([]);
    expect(mapCampaign({ recurrence_days: null }).recurrenceDays).toEqual([]);
    expect(mapCampaign({}).recurrenceTime).toBeNull();
    expect(mapCampaign({}).timezone).toBeNull();
    expect(mapCampaign({}).editionStart).toBeNull();
  });

  /** ISO 8601 : 1 = lundi … 7 = dimanche. Une valeur hors bornes est une donnée abîmée, pas un jour. */
  test("les jours hors bornes sont écartés, les jours valides gardés", () => {
    expect(mapCampaign({ recurrence_days: [1, 7, 0, 8, 3.5, "2"] }).recurrenceDays).toEqual([1, 7, 2]);
  });

  /**
   * ⛔ LA DISTINCTION QUE L'ÉCRAN DOIT POUVOIR DIRE : une cadence ENREGISTRÉE ne crée aucune
   * occurrence tant que `/arm` ne l'a pas ARMÉE. Confondre les deux, c'est promettre des envois
   * qui ne partiront pas.
   */
  test("une cadence enregistrée n'est pas une cadence armée", () => {
    expect(mapCampaign({ recurrence_days: [1] }).recurrenceActive).toBe(false);
    expect(mapCampaign({ recurrence_days: [1], recurrence_active: true }).recurrenceActive).toBe(true);
  });

  test("une série complète traverse la couche sans rien perdre", () => {
    const r = mapCampaign({
      id: "c1",
      name: "Boletín semanal",
      recurrence_days: [1, 4],
      recurrence_time: "07:30:00",
      recurrence_every_weeks: 2,
      recurrence_until: "2026-12-31",
      recurrence_active: true,
      timezone: "America/Santiago",
      freeze_lead_minutes: 90,
      edition_start: 12,
    });
    expect(r).toMatchObject({
      recurrenceDays: [1, 4],
      recurrenceTime: "07:30",
      recurrenceEveryWeeks: 2,
      recurrenceUntil: "2026-12-31",
      recurrenceActive: true,
      timezone: "America/Santiago",
      freezeLeadMinutes: 90,
      editionStart: 12,
    });
  });
});

/**
 * L'ARCHIVAGE (0077) — la lecture, la forme, et les DEUX ONGLETS.
 *
 * ⛔ MUTATION QUI DOIT TUER CE BANC : retirer le filtre `archived_at is null` de l'onglet actif. Une
 * campagne archivée y reviendrait, se lirait « elle tourne encore », et l'écran proposerait de
 * l'archiver une seconde fois.
 */
describe("archivage — ce que la liste lit et ce que chaque onglet montre", () => {
  test("CAMPAIGN_SELECT demande les deux colonnes de 0077", () => {
    const colonnes = CAMPAIGN_SELECT.split(",").map((c) => c.trim());
    expect(colonnes).toContain("archived_at");
    expect(colonnes).toContain("archived_resume");
  });

  test("mapCampaign : archivée ⇒ date et résumé lus ; active ⇒ null et null", () => {
    const a = mapCampaign({
      archived_at: "2026-09-20T08:00:00+00:00",
      archived_resume: { version: 1, previous_status: "scheduled", series_running: false, scheduled_at: "2026-09-30T10:00:00Z", editions_cancelled: 0 },
    });
    expect(a.archivedAt).toBe("2026-09-20T08:00:00+00:00");
    expect(a.archivedResume).toEqual({ previousStatus: "scheduled", seriesRunning: false, scheduledAt: "2026-09-30T10:00:00Z", editionsCancelled: 0 });
    const b = mapCampaign({});
    expect(b.archivedAt).toBeNull();
    expect(b.archivedResume).toBeNull();
  });

  // ⛔ `=== true` : une valeur douteuse ne doit JAMAIS faire redémarrer une série à la réactivation.
  test("un résumé abîmé ne se lit pas « la série tournait »", () => {
    const r = mapCampaign({ archived_at: "2026-09-20T08:00:00Z", archived_resume: { series_running: "yes" } });
    expect(r.archivedResume?.seriesRunning).toBe(false);
  });

  /** Un double qui APPLIQUE les filtres `eq`, `is(col, null)` et `not(col, "is", null)` à des lignes. */
  function clientFiltrant(lignes: Record<string, unknown>[]) {
    const appels: { m: string; args: unknown[] }[] = [];
    const construire = (courantes: Record<string, unknown>[]): unknown => {
      const chaine: Record<string, unknown> = {
        select: (...args: unknown[]) => (appels.push({ m: "select", args }), construire(courantes)),
        eq: (col: string, v: unknown) => (appels.push({ m: "eq", args: [col, v] }), construire(courantes.filter((l) => l[col] === v))),
        is: (col: string, v: unknown) => (appels.push({ m: "is", args: [col, v] }), construire(courantes.filter((l) => (l[col] ?? null) === v))),
        not: (col: string, op: string, v: unknown) => {
          appels.push({ m: "not", args: [col, op, v] });
          return construire(op === "is" ? courantes.filter((l) => (l[col] ?? null) !== v) : courantes);
        },
        order: (...args: unknown[]) => (appels.push({ m: "order", args }), construire(courantes)),
        then: (resoudre: (v: unknown) => void) => resoudre({ data: courantes, error: null, count: courantes.length }),
      };
      return chaine;
    };
    return { db: { from: () => construire(lignes) } as never, appels };
  }

  const LIGNES = [
    { id: "a1", asset_id: "A", name: "Active", archived_at: null },
    { id: "a2", asset_id: "A", name: "Archivée", archived_at: "2026-09-20T08:00:00Z", archived_resume: { previous_status: "draft" } },
    { id: "b1", asset_id: "B", name: "Autre marque archivée", archived_at: "2026-09-20T08:00:00Z" },
  ];

  test("onglet actif : AUCUNE archivée, et seulement la marque demandée", async () => {
    const { db } = clientFiltrant(LIGNES);
    const rows = await lireCampagnes(db, "A");
    expect(rows.map((r) => r.id)).toEqual(["a1"]);
  });

  test("onglet Archived : SEULEMENT les archivées de la marque", async () => {
    const { db } = clientFiltrant(LIGNES);
    const rows = await lireCampagnes(db, "A", { archived: true });
    expect(rows.map((r) => r.id)).toEqual(["a2"]);
    expect(rows[0]!.archivedAt).toBe("2026-09-20T08:00:00Z");
  });

  test("le compteur de chaque onglet compte CET onglet", async () => {
    const { db } = clientFiltrant(LIGNES);
    expect(await compterCampagnesParOnglet(db, "A")).toEqual({ active: 1, archived: 1 });
  });
});
