/**
 * LE CIBLAGE EST FACULTATIF, LE CONSENTEMENT NE L'EST PAS.
 *
 * Ce banc existe pour une raison précise : jusqu'au 08/09/2026, une campagne sans segment était
 * ÉCARTÉE par le pré-vol du fan-out (`no_segment`). Elle restait `scheduled`, était re-sautée à
 * chaque passe, et rien hors des journaux du worker ne le disait — un non-envoi silencieux. Or la
 * base fabrique ces `segment_id` nuls toute seule : la clé étrangère est `on delete set null`, donc
 * supprimer un segment suffisait à condamner les campagnes qui s'en servaient.
 *
 * ⛔ CE QUE CES TESTS PROTÈGENT, ET QUI EST PLUS IMPORTANT QUE LA FONCTIONNALITÉ : en levant ce
 * refus, on a ouvert un chemin où l'audience n'est plus restreinte par un ciblage. Ce qui reste
 * entre une campagne et « tous les abonnés de la base » tient en trois choses — la finalité
 * obligatoire, la vue `sendable_subscription`, et le refus d'une règle de segment illisible. Les
 * trois sont testées ici. Une seule qui tombe, et une campagne part à des gens qui ne l'ont jamais
 * demandée.
 *
 * ⚠️ AUCUNE ÉCRITURE : le `FanoutDb` est un double qui enregistre ce qu'on lui demande. Ce qui est
 * mesuré, ce sont les DÉCISIONS du fan-out, pas ce que PostgREST en ferait.
 */
import { describe, expect, test } from "bun:test";
import { compileRule, type RuleContext, type RuleNode } from "@nf/segments";
import { compterCiblesDues, runFanout } from "./fanout";
import { FanoutDb, type FanoutTarget } from "./fanout-db";

const MAINTENANT = new Date("2026-09-08T10:00:00Z");

/** Une campagne d'acquisition de CETTE marque, connue de la liste blanche du double. */
const CAMPAGNE_DE_LA_MARQUE = "aaaaaaaa-1111-4111-8111-111111111111";
const AUTOMATION_DE_LA_MARQUE = "bbbbbbbb-1111-4111-8111-111111111111";

/**
 * Le contexte de compilation servi par le double : ce que `FanoutDb.ruleContext` lirait pour la
 * marque. Des uuid RÉELS de forme, pas des chaînes quelconques : le compilateur refuse ce qui n'en
 * est pas un, et un double plus permissif que la base ferait passer un test que la production tuerait.
 */
const CONTEXTE: RuleContext = {
  tagIdBySlug: { vip: 1, "interest:colo-colo": 12 },
  optinIdBySlug: { guia: "11111111-2222-4333-8444-555555555555" },
  interestIds: [12],
  captureOptinIds: ["11111111-2222-4333-8444-555555555555"],
  captureCampaignIds: [CAMPAGNE_DE_LA_MARQUE],
};

/** Une règle lisible et non vide : elle doit produire une vraie expression de ciblage. */
const REGLE_LISIBLE = {
  id: "root",
  type: "group",
  op: "AND",
  children: [{ id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" }],
};

function cible(over: Partial<FanoutTarget> = {}): FanoutTarget {
  return {
    occurrenceId: null,
    campaignId: "camp_1",
    assetId: "asset_1",
    campaignName: "Weekly roundup",
    segmentId: null,
    purpose: "content",
    // Dans 5 minutes : dans la fenêtre d'avance, et très loin de la borne de retard.
    scheduledAt: new Date(MAINTENANT.getTime() + 5 * 60_000).toISOString(),
    recipientsPlanned: 100,
    ...over,
  };
}

/**
 * Double de `FanoutDb`. `regle` vaut `undefined` pour « le segment n'a pas de règle lisible »,
 * ce qui est le cas d'un segment supprimé ou corrompu.
 */
function fauxDb(
  opts: {
    cibles?: FanoutTarget[];
    regle?: unknown;
    /** L'audience rendue par la PREMIÈRE page. `[]` = personne ne correspond au ciblage. */
    audience?: string[];
    /** Ce que `countQueued` relit en base — la mesure qui fait foi, pas ce qu'on croit avoir écrit. */
    enFile?: number;
    /** Fait échouer une étape, pour éprouver le chemin d'erreur. */
    planteEn?: "pageAudience" | "enqueueBatch" | "ruleContext";
    /** Remplace des champs du contexte de compilation servi par le double. */
    contexte?: Partial<RuleContext>;
  } = {},
) {
  const journal: string[] = [];
  let dernierePage: { segmentExpr: string | null; gateExpr: string } | null = null;
  let premiere = true;

  const db = {
    listDueOccurrences: async () => [],
    listDueCampaigns: async () => opts.cibles ?? [cible()],
    getSegmentRule: async (id: string, assetId: string) => {
      journal.push(`getSegmentRule:${id}:${assetId}`);
      return opts.regle === undefined ? null : { id, rule: opts.regle };
    },
    ruleContext: async (assetId: string): Promise<RuleContext> => {
      journal.push(`ruleContext:${assetId}`);
      if (opts.planteEn === "ruleContext") throw new Error("ruleContext(tag): connexion refusee");
      return { ...CONTEXTE, ...opts.contexte };
    },
    optOutEditionIds: async () => [],
    claim: async () => {
      journal.push("claim");
      return true;
    },
    pageAudience: async (p: { segmentExpr: string | null; gateExpr: string }) => {
      journal.push("pageAudience");
      dernierePage = p;
      if (opts.planteEn === "pageAudience") throw new Error("pageAudience: connexion refusee");
      // Une seule page : la boucle s'arrête dès qu'un lot est plus court que `batchSize`.
      if (!premiere) return [];
      premiere = false;
      return opts.audience ?? ["sub_1", "sub_2"];
    },
    enqueueBatch: async (_c: string, _o: string | null, ids: string[]) => {
      journal.push(`enqueueBatch:${ids.length}`);
      if (opts.planteEn === "enqueueBatch") throw new Error("enqueueBatch: RPC absente");
      return ids.length;
    },
    countQueued: async () => opts.enFile ?? 2,
    markEnqueued: async () => {
      journal.push("markEnqueued");
    },
    holdOccurrence: async (id: string, raison: string) => {
      journal.push(`holdOccurrence:${raison}`);
    },
    // ⛔ CE DOUBLE MANQUAIT, ET SON ABSENCE NE SE VOYAIT PAS. `runFanout` attrape toute exception
    // d'une cible et la range dans `report.errors` : un `db.holdCampaign is not a function` passait
    // donc pour une suite verte. C'est pourquoi les tests ci-dessous exigent TOUS `errors` vide.
    holdCampaign: async (t: FanoutTarget, raison: string) => {
      journal.push(`holdCampaign:${t.campaignId}:${raison}`);
    },
    releaseClaim: async () => {
      journal.push("releaseClaim");
    },
    // ⛔ MÊME PIÈGE QUE `holdCampaign` CI-DESSUS, ET IL MORD AU MÊME ENDROIT. Ce double est appelé
    // depuis le `catch` du fan-out : s'il manque, l'erreur devient
    // `db.auditFanoutError is not a function`, elle remplace la vraie dans `report.errors`, et le
    // test « l'erreur est bien celle de pageAudience » passerait sur la mauvaise cause.
    auditFanoutError: async (t: FanoutTarget, message: string) => {
      journal.push(`auditFanoutError:${t.campaignId}:${message}`);
    },
  };

  return { db: db as unknown as FanoutDb, journal, page: () => dernierePage };
}

describe("fan-out — une campagne sans segment vise toute la marque", () => {
  /**
   * ⛔ LE TEST CENTRAL. MUTATION QUI DOIT LE TUER : remettre `if (!t.segmentId) return "no_segment"`
   * en tête de `preflight`. Le symptôme serait invisible en production — la campagne ne part pas et
   * personne n'est prévenu.
   */
  test("elle n'est pas écartée, et ses lignes entrent en file", async () => {
    const { db, journal } = fauxDb({ cibles: [cible({ segmentId: null })] });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.targets[0]?.skipped).toBeUndefined();
    expect(rapport.held).toEqual([]);
    expect(rapport.targetsEnqueued).toBe(1);
    expect(journal).toContain("enqueueBatch:2");
  });

  /**
   * ⛔ « Pas de ciblage » doit se traduire par l'ABSENCE de prédicat, et surtout pas par un
   * prédicat qui ne matche rien. MUTATION QUI DOIT TUER : passer une chaîne vide, ou compiler la
   * règle d'un segment nul — les deux rendraient zéro destinataire, silencieusement.
   */
  test("le ciblage transmis est nul, et le gate de finalité reste posé", async () => {
    const { db, page } = fauxDb({ cibles: [cible({ segmentId: null, purpose: "offers" })] });
    await runFanout(db, { now: MAINTENANT });

    const p = page();
    expect(p?.segmentExpr).toBeNull();
    // Le gate est ce qui remplace le ciblage comme garde-fou : il ne peut pas être vide.
    expect(typeof p?.gateExpr).toBe("string");
    expect(p?.gateExpr.length).toBeGreaterThan(0);
  });

  /**
   * Sans segment, la règle ne doit même pas être CHERCHÉE : `getSegmentRule(null)` interroge
   * `.eq("id", null)`, qui ne rend aucune ligne — et le fan-out conclurait « règle illisible ».
   * Le refus aurait juste changé de nom.
   */
  test("aucune règle de segment n'est demandée à la base", async () => {
    const { db, journal } = fauxDb({ cibles: [cible({ segmentId: null })] });
    await runFanout(db, { now: MAINTENANT });
    expect(journal.some((l) => l.startsWith("getSegmentRule"))).toBe(false);
  });
});

describe("fan-out — ce que l'ouverture du ciblage ne doit PAS emporter", () => {
  /**
   * ⛔ LA FINALITÉ RESTE OBLIGATOIRE. C'est elle, et non le segment, qui porte le consentement.
   * MUTATION QUI DOIT TUER : retirer `if (!t.purpose) return "no_purpose"` en même temps que
   * `no_segment` — une campagne partirait alors à des gens qui n'ont rien accordé.
   */
  test("sans finalité, la cible est écartée — et le motif le nomme", async () => {
    const { db } = fauxDb({ cibles: [cible({ segmentId: null, purpose: null })] });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.targets[0]?.skipped).toBe("no_purpose");
    expect(rapport.targetsEnqueued).toBe(0);
    expect(rapport.rowsQueued).toBe(0);
  });

  /**
   * ⛔ ABSENT ≠ ILLISIBLE. Un segment DÉSIGNÉ dont la règle ne se lit pas reste un refus : deviner
   * « tout le monde » sur une donnée corrompue transformerait un bug en envoi de masse.
   * MUTATION QUI DOIT TUER : rendre `segmentExpr = null` au lieu de refuser quand la règle manque.
   */
  test("un segment désigné mais illisible reste refusé", async () => {
    const { db } = fauxDb({ cibles: [cible({ segmentId: "seg_1" })], regle: undefined });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.targets[0]?.skipped).toBe("unreadable_segment_rule");
    expect(rapport.targetsEnqueued).toBe(0);
  });

  test("une occurrence à la règle illisible est RETENUE avec sa raison, pas retentée en boucle", async () => {
    const { db, journal } = fauxDb({
      cibles: [cible({ occurrenceId: "occ_1", segmentId: "seg_1" })],
      regle: undefined,
    });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(journal).toContain("holdOccurrence:fanout:unreadable_segment_rule");
    expect(rapport.held[0]?.reason).toBe("unreadable_segment_rule");
  });

  /** Le chemin avec segment n'a pas bougé : la règle est lue, compilée, et le ciblage est posé. */
  test("avec un segment lisible, le ciblage est bien compilé et transmis", async () => {
    const { db, journal, page } = fauxDb({ cibles: [cible({ segmentId: "seg_1" })], regle: REGLE_LISIBLE });
    await runFanout(db, { now: MAINTENANT });

    expect(journal).toContain("getSegmentRule:seg_1:asset_1");
    expect(page()?.segmentExpr).toBeTruthy();
  });

  /**
   * ⛔ LE REFUS LE PLUS RÉCENT, ET LE PLUS CONTRE-INTUITIF.
   *
   * Une règle PARFAITEMENT LISIBLE dont un terme d'un ET ne se compile pas — le tag a été renommé
   * ou supprimé depuis l'enregistrement du segment — produisait un filtre PLUS LARGE que la règle.
   * Le worker le comptait dans son journal et enfilait quand même. Le seul filet était le plafond
   * de volume, qui attrape la catastrophe, pas l'erreur de quelques milliers d'adresses.
   *
   * MUTATION QUI DOIT TUER CE TEST : supprimer le `if (compiled.widened)` de `fanout.ts`. Le
   * fan-out enfilerait alors « tous les Brésiliens » pour une règle qui dit « Brésiliens ET vip ».
   */
  test("un terme d'un ET qui ne compile pas RETIENT l'occurrence au lieu d'élargir l'envoi", async () => {
    const regleElargie = {
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" },
        // Le double ne connaît que le tag « vip » : celui-ci a disparu de la marque.
        { id: "n2", type: "predicate", field: "tag", op: "has", value: "tag-supprime" },
      ],
    };
    const { db, journal } = fauxDb({
      cibles: [cible({ occurrenceId: "occ_1", segmentId: "seg_1" })],
      regle: regleElargie,
    });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.targets[0]?.skipped).toBe("widened_segment_rule");
    expect(rapport.targetsEnqueued).toBe(0);
    expect(rapport.rowsQueued).toBe(0);
    // La raison NOMME le coupable : « tag » seul ne dirait pas lequel des tags a disparu.
    expect(rapport.held[0]?.reason).toContain("tag:tag-supprime");
    expect(journal.some((l) => l.startsWith("holdOccurrence:fanout:widened_segment_rule"))).toBe(true);
    // ⛔ Et rien n'a été enfilé : la garde tombe AVANT la prise de la cible et l'écriture.
    expect(journal).not.toContain("pageAudience");
  });

  /**
   * ⛔⛔ UNE PROVENANCE QUE LA MARQUE NE CONNAÎT PAS RETIENT LA CIBLE — LE REPLI RESTE FERMÉ.
   *
   * Jusqu'au 22/09/2026, ce test verrouillait un worker SANS listes blanches : toute provenance
   * était retenue. Il est retourné, pas supprimé : les listes sont servies, mais un identifiant
   * absent de celle de la marque (celui d'une AUTRE marque, ou d'une campagne supprimée) doit
   * toujours être dénoncé, jamais compilé.
   *
   * MUTATION QUI DOIT LE TUER : retirer le `if (compiled.widened)` de `fanout.ts` — le fan-out
   * enfilerait alors toute la marque pour une règle qui nomme une seule campagne d'acquisition.
   */
  test("un segment de PROVENANCE inconnue de la marque retient la cible au lieu d'envoyer à toute la marque", async () => {
    const regleDeProvenance = {
      id: "root",
      type: "group",
      op: "AND",
      children: [
        {
          id: "n1",
          type: "predicate",
          field: "capture_campaign",
          op: "any_of",
          // Un uuid parfaitement formé : ce n'est PAS la forme qui le fait refuser, c'est son
          // absence de la liste blanche de CETTE marque.
          value: ["bbbbbbbb-2222-4222-8222-222222222222"],
        },
      ],
    };
    const { db, journal } = fauxDb({
      cibles: [cible({ occurrenceId: "occ_1", segmentId: "seg_1" })],
      regle: regleDeProvenance,
    });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(rapport.targets[0]?.skipped).toBe("widened_segment_rule");
    expect(rapport.targetsEnqueued).toBe(0);
    expect(rapport.rowsQueued).toBe(0);
    // La raison NOMME le niveau de provenance en cause, pas seulement « la règle est élargie ».
    expect(rapport.held[0]?.reason).toContain("capture_campaign");
    // ⛔ Et surtout : AUCUNE audience n'a été énumérée. Sans cette ligne, un repli ouvert
    // (liste blanche absente = « tout est autorisé ») passerait inaperçu.
    expect(journal).not.toContain("pageAudience");
  });
});

/**
 * ⭐ LE BANC DU DÉFAUT DU 22/09/2026 — « les campagnes ne partent toujours pas ».
 *
 * « Test », « Test 2 » et « Test 3 » visaient des segments sur l'intérêt 12. L'admin les avait
 * comptées (1 destinataire) et laissées planifier ; le worker, sans liste blanche des intérêts, a
 * dénoncé le prédicat et les a mises en pause à 11:30 UTC (`widened_segment_rule:interest`). Aucun
 * envoi à côté, mais aucun envoi du tout.
 */
describe("fan-out — les segments de provenance partent, avec le filtre de l'admin", () => {
  /** La règle exacte du segment « Colo-colo test », relue en base le 22/09. */
  const REGLE_INTERET: RuleNode = {
    id: "root",
    type: "group",
    op: "AND",
    children: [{ id: "n1", type: "predicate", field: "interest", op: "any_of", value: ["12"] }],
  } as RuleNode;

  /**
   * ⛔ LE TEST CENTRAL. MUTATION QUI DOIT LE TUER : rendre au compilateur un contexte sans
   * `interestIds` (l'ancien `{ tagIdBySlug, optinIdBySlug }`) — la cible retombe en pause.
   */
  test("un segment sur un intérêt de la marque est enfilé, pas mis en pause", async () => {
    const { db, journal, page } = fauxDb({
      cibles: [cible({ occurrenceId: null, segmentId: "seg_1" })],
      regle: REGLE_INTERET,
    });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(rapport.held).toEqual([]);
    expect(rapport.targets[0]?.skipped).toBeUndefined();
    expect(journal.some((l) => l.startsWith("holdCampaign"))).toBe(false);
    expect(rapport.targetsEnqueued).toBe(1);
    expect(journal).toContain("enqueueBatch:2");
    expect(page()?.segmentExpr).toContain("interest_ids.ov.{12}");
  });

  /**
   * ⛔ LE FILTRE TRANSMIS EST CELUI QUE COMPTE L'ADMIN, À L'IDENTIQUE. Pas « un filtre qui contient
   * l'intérêt » : la même chaîne que `compileRule` rend sur le même contexte. Un worker qui
   * recompilerait autrement ferait diverger le nombre annoncé et le nombre envoyé.
   */
  test("le filtre est exactement celui de compileRule sur le contexte de la marque", async () => {
    const { db, page } = fauxDb({ cibles: [cible({ segmentId: "seg_1" })], regle: REGLE_INTERET });
    await runFanout(db, { now: MAINTENANT });

    const attendu = compileRule(REGLE_INTERET, CONTEXTE);
    expect(attendu.widened).toBe(false);
    expect(page()?.segmentExpr).toBe(attendu.expr);
  });

  /** Même chemin pour une campagne d'acquisition connue de la marque. */
  test("un segment sur une campagne d'acquisition de la marque est enfilé", async () => {
    const regle = {
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "n1", type: "predicate", field: "capture_campaign", op: "any_of", value: [CAMPAGNE_DE_LA_MARQUE] },
      ],
    };
    const { db, page } = fauxDb({ cibles: [cible({ segmentId: "seg_1" })], regle });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(rapport.targetsEnqueued).toBe(1);
    expect(page()?.segmentExpr).toContain(`capture_campaign_ids.ov.{${CAMPAGNE_DE_LA_MARQUE}}`);
  });

  /**
   * ⛔ UN INTÉRÊT QUI N'EST PAS DANS LA LISTE DE LA MARQUE RESTE DÉNONCÉ. Le tag 12 d'une autre
   * marque, ou un tag manuel qui n'est pas de `kind = 'interest'`, ne se cible pas.
   */
  test("un intérêt absent de la liste blanche retient toujours la cible", async () => {
    const { db, journal } = fauxDb({
      cibles: [cible({ occurrenceId: null, segmentId: "seg_1" })],
      regle: REGLE_INTERET,
      contexte: { interestIds: [7] },
    });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(rapport.held[0]?.reason).toBe("widened_segment_rule:interest:12");
    expect(journal).not.toContain("pageAudience");
  });

  /**
   * ⛔ UNE LECTURE RATÉE DU CONTEXTE N'EST NI UN ENVOI NI UNE PAUSE. La cible reste `scheduled` et
   * la passe suivante réessaie. MUTATION QUI DOIT LE TUER : attraper l'erreur dans `ruleContext`
   * et rendre des listes absentes — la campagne serait mise en pause sur une panne passagère.
   */
  test("une lecture ratée du contexte lève, sans pause et sans audience", async () => {
    const { db, journal } = fauxDb({
      cibles: [cible({ occurrenceId: null, segmentId: "seg_1" })],
      regle: REGLE_INTERET,
      planteEn: "ruleContext",
    });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors.length).toBe(1);
    expect(JSON.stringify(rapport.errors[0])).toContain("ruleContext");
    expect(journal.some((l) => l.startsWith("holdCampaign"))).toBe(false);
    expect(journal).not.toContain("pageAudience");
    expect(rapport.targetsEnqueued).toBe(0);
  });

  /** Sans segment, le contexte n'est même pas lu : rien à compiler. */
  test("une campagne sans segment ne lit pas le contexte", async () => {
    const { db, journal } = fauxDb({ cibles: [cible({ segmentId: null })] });
    await runFanout(db, { now: MAINTENANT });
    expect(journal.some((l) => l.startsWith("ruleContext"))).toBe(false);
  });
});

/**
 * `FanoutDb.ruleContext` LUI-MÊME, sur un client PostgREST simulé : c'est ici que se jouent la
 * portée par marque et le tri des intérêts, que les doubles ci-dessus supposent acquis.
 */
describe("FanoutDb.ruleContext — le reflet de ruleContextForAsset", () => {
  type Lignes = Record<string, { data?: unknown[]; error?: { message: string } }>;

  function dbSur(lignes: Lignes) {
    const filtres: string[] = [];
    const sb = {
      from: (table: string) => ({
        select: (cols: string) => ({
          eq: async (col: string, val: string) => {
            filtres.push(`${table}(${cols}).${col}=${val}`);
            const r = lignes[table] ?? {};
            return { data: r.error ? null : (r.data ?? []), error: r.error ?? null };
          },
        }),
      }),
    };
    const db = Object.create(FanoutDb.prototype) as FanoutDb;
    (db as unknown as { sb: unknown }).sb = sb;
    return { db, filtres };
  }

  const LIGNES: Lignes = {
    tag: {
      data: [
        { id: 1, slug: "vip", kind: "manual" },
        { id: 12, slug: "interest:colo-colo", kind: "interest" },
        // ⛔ Un tag MANUEL nommé comme un intérêt : il ne doit pas devenir ciblable comme tel.
        { id: 40, slug: "interest:faux", kind: null },
      ],
    },
    optin: { data: [{ id: "11111111-2222-4333-8444-555555555555", slug: "guia" }] },
    capture_campaign: { data: [{ id: CAMPAGNE_DE_LA_MARQUE }] },
    automation: { data: [{ id: AUTOMATION_DE_LA_MARQUE }] },
  };

  test("les quatre tables sont lues SCOPÉES MARQUE", async () => {
    const { db, filtres } = dbSur(LIGNES);
    await db.ruleContext("asset_1");
    expect(filtres.sort()).toEqual([
      "automation(id).asset_id=asset_1",
      "capture_campaign(id).asset_id=asset_1",
      "optin(id, slug).asset_id=asset_1",
      "tag(id, slug, kind).asset_id=asset_1",
    ]);
  });

  /** MUTATION QUI DOIT LE TUER : ne pas rendre `automationIds` (repli fermé : le prédicat serait dénoncé). */
  test("les automations de la marque sont rendues, et une table vide rend `[]`", async () => {
    expect((await dbSur(LIGNES).db.ruleContext("asset_1")).automationIds).toEqual([AUTOMATION_DE_LA_MARQUE]);
    const vide = await dbSur({ ...LIGNES, automation: { data: [] } }).db.ruleContext("asset_1");
    expect(vide.automationIds).toEqual([]);
  });

  /** MUTATION QUI DOIT LE TUER : remplacer `t.kind === "interest"` par un test sur le slug. */
  test("seuls les tags de kind 'interest' sont des intérêts ; tous restent ciblables par slug", async () => {
    const { db } = dbSur(LIGNES);
    const ctx = await db.ruleContext("asset_1");
    expect(ctx.interestIds).toEqual([12]);
    expect(ctx.tagIdBySlug).toEqual({ vip: 1, "interest:colo-colo": 12, "interest:faux": 40 });
  });

  test("les créatives sont les optins, et les campagnes d'acquisition sont rendues", async () => {
    const { db } = dbSur(LIGNES);
    const ctx = await db.ruleContext("asset_1");
    expect(ctx.optinIdBySlug).toEqual({ guia: "11111111-2222-4333-8444-555555555555" });
    expect(ctx.captureOptinIds).toEqual(["11111111-2222-4333-8444-555555555555"]);
    expect(ctx.captureCampaignIds).toEqual([CAMPAGNE_DE_LA_MARQUE]);
  });

  /**
   * ⛔ UNE MARQUE SANS CAMPAGNE D'ACQUISITION REND `[]`, PAS `undefined` : « rien n'est autorisé »
   * est une réponse lue, pas une lecture manquée.
   */
  test("une table vide rend une liste vide, pas une liste absente", async () => {
    const { db } = dbSur({ ...LIGNES, capture_campaign: { data: [] } });
    const ctx = await db.ruleContext("asset_1");
    expect(ctx.captureCampaignIds).toEqual([]);
  });

  test.each(["tag", "optin", "capture_campaign", "automation"])("une erreur sur %s lève, sans rendre de contexte partiel", async (table) => {
    const { db } = dbSur({ ...LIGNES, [table]: { error: { message: "permission denied" } } });
    await expect(db.ruleContext("asset_1")).rejects.toThrow(`ruleContext(${table})`);
  });
});

/**
 * ⭐ LA SYMÉTRIE ENTRE UNE SÉRIE ET UN ONE SEND — le banc du défaut du 18/09/2026.
 *
 * Les trois refus du fan-out n'écrivaient leur trace que `if (t.occurrenceId …)`. Une campagne
 * PONCTUELLE écartée ne laissait donc rien : ni statut, ni raison, ni rapport. Elle restait
 * `scheduled`, était re-écartée à chaque passe, et l'admin affichait « Scheduled » indéfiniment —
 * « quand je schedule one send ça ne s'envoie pas » (Alix, campagne « Test 3 »).
 */
describe("fan-out — une campagne ponctuelle écartée laisse la MÊME trace qu'une occurrence", () => {
  /**
   * ⛔ LE TEST CENTRAL. MUTATION QUI DOIT LE TUER : remettre `if (t.occurrenceId)` devant l'écriture
   * du refus. Le symptôme ne serait visible NULLE PART — c'est tout le problème de ce défaut.
   *
   * ⚠️ `errors` DOIT ÊTRE VIDE : `runFanout` range toute exception d'une cible dans `report.errors`
   * au lieu de la laisser remonter. Un `holdCampaign` absent du double rendait donc la suite verte
   * tout en n'appelant jamais le correctif.
   */
  test("un one send écarté passe en pause avec sa raison", async () => {
    const { db, journal } = fauxDb({ cibles: [cible({ occurrenceId: null, purpose: null })] });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(journal).toContain("holdCampaign:camp_1:no_purpose");
    expect(rapport.held).toEqual([{ campaignName: "Weekly roundup", occurrenceId: null, reason: "no_purpose" }]);
  });

  /** Une cible trop en retard ne se rattrape jamais : elle doit sortir du scan, pas y tourner. */
  test("une campagne trop en retard est retenue, pas laissée en scheduled", async () => {
    const enRetard = cible({
      occurrenceId: null,
      scheduledAt: new Date(MAINTENANT.getTime() - 4 * 60 * 60_000).toISOString(),
    });
    const { db, journal } = fauxDb({ cibles: [enRetard] });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(rapport.targets[0]?.skipped).toContain("too_late");
    expect(journal.some((l) => l.startsWith("holdCampaign:camp_1:too_late"))).toBe(true);
    expect(journal).not.toContain("pageAudience");
  });

  /**
   * ⛔ LA SIMULATION N'ÉCRIT RIEN, Y COMPRIS UN REFUS. Une passe en `dry-run` qui mettrait de
   * vraies campagnes en pause serait une écriture de production déguisée en essai.
   */
  test("en simulation, aucune pause n'est écrite — mais le refus est rapporté", async () => {
    const { db, journal } = fauxDb({ cibles: [cible({ occurrenceId: null, purpose: null })] });
    const rapport = await runFanout(db, { now: MAINTENANT, simulate: true });

    expect(journal.some((l) => l.startsWith("holdCampaign"))).toBe(false);
    expect(rapport.held[0]?.reason).toBe("no_purpose");
  });

  /** Une occurrence garde EXACTEMENT le comportement d'avant : c'est une symétrie, pas un échange. */
  test("une occurrence continue d'être retenue par holdOccurrence", async () => {
    const { db, journal } = fauxDb({ cibles: [cible({ occurrenceId: "occ_1", purpose: null })] });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(journal).toContain("holdOccurrence:fanout:no_purpose");
    expect(journal.some((l) => l.startsWith("holdCampaign"))).toBe(false);
  });
});

/**
 * ------------------------------------------------------------------------------------------------
 * LES TROIS REFUS QUI NE LAISSAIENT AUCUNE TRACE (18/09/2026).
 * ------------------------------------------------------------------------------------------------
 *
 * Contexte : « j'ai fait une campagne one shot et rien ne s'est envoyé ». La campagne affichait
 * « Scheduled », un cadenas, 1 destinataire prévu, une heure passée. Tous les refus BRUYANTS du
 * fan-out (`no_purpose`, `too_late`, `unreadable_segment_rule`…) l'auraient mise en `paused` : ils
 * sont donc écartés par l'observation. Restaient trois chemins qui la laissaient EXACTEMENT dans
 * l'état observé, sans une ligne en base :
 *
 *  1. l'audience vide, qui tombait dans `markEnqueued(t, 0)` et ÉCRASAIT `recipients_planned` ;
 *  2. le plafond d'audience, qui rendait la campagne à `scheduled` — une boucle sans fin ;
 *  3. l'erreur de mise en file, qui la rendait aussi à `scheduled`, sans rien écrire.
 *
 * ⛔ Aucun banc ne couvrait ces trois-là avant ce lot.
 */
describe("fan-out — une audience VIDE est un incident, pas un envoi de zéro message", () => {
  test("⛔ la campagne est RETENUE avec sa raison, au lieu d'être marquée « enfilée à 0 »", async () => {
    const { db, journal } = fauxDb({ audience: [], enFile: 0 });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(rapport.targets[0]?.skipped).toBe("empty_audience");
    expect(journal).toContain("holdCampaign:camp_1:empty_audience");
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : laisser le chemin retomber dans `markEnqueued`. C'était le
   * comportement réel, et il est pire que muet — il DÉTRUIT la preuve. `markEnqueued` écrit
   * `recipients_planned = <ce qui est en file>`, donc 0 : la seule trace qu'un destinataire était
   * attendu disparaît, et l'écran affiche « 0 prévu, 0 envoyé » sur une campagne qui en visait 1.
   */
  test("⛔ `markEnqueued` n'est PAS appelé : `recipients_planned` n'est pas écrasé à 0", async () => {
    const { db, journal } = fauxDb({ audience: [], enFile: 0 });
    await runFanout(db, { now: MAINTENANT });
    expect(journal).not.toContain("markEnqueued");
  });

  test("le rapport la compte comme retenue, donc elle remonte en alerte", async () => {
    const { db } = fauxDb({ audience: [], enFile: 0 });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.held).toHaveLength(1);
    expect(rapport.held[0]?.reason).toBe("empty_audience");
    expect(rapport.targetsEnqueued).toBe(0);
  });

  /**
   * ⛔⛔ LA GARDE QUI ÉVITE DE COUPER UN ENVOI EN COURS. Si une passe précédente a déjà rempli la
   * file et que l'audience n'est vide QUE maintenant (tout le monde s'est désabonné depuis), des
   * lignes sont EN VOL. Mettre la campagne en pause ici les condamnerait.
   *
   * MUTATION QUI DOIT TUER : tester `seen === 0` seul, sans `line.inQueue === 0`.
   */
  test("⛔ mais PAS si des lignes sont déjà en file : on ne coupe pas un envoi en vol", async () => {
    const { db, journal } = fauxDb({ audience: [], enFile: 1500 });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.targets[0]?.skipped).toBeUndefined();
    expect(journal.some((l) => l.startsWith("holdCampaign"))).toBe(false);
    expect(journal).toContain("markEnqueued");
  });

  /** Une occurrence de série suit le même chemin — par `holdOccurrence`, sa forme à elle. */
  test("une occurrence vide est retenue elle aussi, avec la même raison", async () => {
    const { db, journal } = fauxDb({ cibles: [cible({ occurrenceId: "occ_1" })], audience: [], enFile: 0 });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(journal).toContain("holdOccurrence:fanout:empty_audience");
  });

  /** En simulation, rien ne s'écrit — mais le rapport dit quand même ce qui SERAIT retenu. */
  test("la simulation n'écrit aucune pause, et le dit quand même", async () => {
    const { db, journal } = fauxDb({ audience: [], enFile: 0 });
    const rapport = await runFanout(db, { now: MAINTENANT, simulate: true });

    expect(journal.some((l) => l.startsWith("holdCampaign"))).toBe(false);
    expect(rapport.held[0]?.reason).toBe("empty_audience");
  });
});

describe("fan-out — le plafond d'audience arrête les DEUX formes de cible", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : remettre `releaseClaim` sur la branche de la campagne. Elle
   * repasserait `scheduled`, serait re-scannée à la passe suivante, redépasserait le plafond, serait
   * re-relâchée… une boucle sans fin, sans une ligne en base, pendant que l'écran dit « Scheduled ».
   */
  test("⛔ une campagne ponctuelle est MISE EN PAUSE, pas rendue à `scheduled`", async () => {
    const { db, journal } = fauxDb({ audience: ["s1", "s2", "s3"] });
    const rapport = await runFanout(db, { now: MAINTENANT, maxPerTarget: 2 });

    expect(rapport.errors).toEqual([]);
    expect(journal.some((l) => l.startsWith("holdCampaign:camp_1:audience_over_cap"))).toBe(true);
    expect(journal).not.toContain("releaseClaim");
  });

  test("le plafond nomme sa valeur — un humain doit savoir laquelle il a franchie", async () => {
    const { db } = fauxDb({ audience: ["s1", "s2", "s3"] });
    const rapport = await runFanout(db, { now: MAINTENANT, maxPerTarget: 2 });
    expect(rapport.held[0]?.reason).toBe("audience_over_cap:2");
  });

  /** Symétrie : l'occurrence avait déjà le bon comportement, il ne doit pas changer. */
  test("une occurrence reste retenue par holdOccurrence", async () => {
    const { db, journal } = fauxDb({
      cibles: [cible({ occurrenceId: "occ_1" })],
      audience: ["s1", "s2", "s3"],
    });
    await runFanout(db, { now: MAINTENANT, maxPerTarget: 2 });

    expect(journal.some((l) => l.startsWith("holdOccurrence:fanout:audience_over_cap"))).toBe(true);
    expect(journal.some((l) => l.startsWith("holdCampaign"))).toBe(false);
  });
});

describe("fan-out — une erreur de mise en file laisse une trace, sans changer le statut", () => {
  /**
   * ⛔ LES DEUX MOITIÉS COMPTENT, ET ELLES TIRENT EN SENS INVERSE.
   *  — `releaseClaim` DOIT avoir lieu : une coupure réseau de trois secondes ne doit pas annuler un
   *    envoi, la campagne repasse `scheduled` et sera reprise à la passe suivante.
   *  — mais l'audit DOIT être écrit : sans lui, la campagne rebondit entre `scheduled` et `sending`
   *    indéfiniment et rien nulle part ne le dit.
   *
   * MUTATION QUI DOIT TUER LA PREMIÈRE MOITIÉ : remplacer `releaseClaim` par `holdCampaign` — une
   * panne passagère deviendrait un envoi mort.
   * MUTATION QUI DOIT TUER LA SECONDE : retirer l'appel à `auditFanoutError`.
   */
  test("⛔ l'audit est écrit ET la cible est rendue à `scheduled`", async () => {
    const { db, journal } = fauxDb({ planteEn: "pageAudience" });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(journal).toContain("releaseClaim");
    expect(journal.some((l) => l.startsWith("auditFanoutError:camp_1:pageAudience:"))).toBe(true);
    expect(journal.some((l) => l.startsWith("holdCampaign"))).toBe(false);
    expect(rapport.targets[0]?.skipped).toBe("error");
  });

  /**
   * ⛔ L'ERREUR REMONTÉE EST LA VRAIE. Si `auditFanoutError` manquait au double, l'exception
   * « db.auditFanoutError is not a function » remplacerait la cause réelle dans `report.errors` — et
   * l'alerte Slack désignerait le worker au lieu de la base.
   */
  test("⛔ `report.errors` porte la cause d'origine, pas celle du chemin de secours", async () => {
    const { db } = fauxDb({ planteEn: "enqueueBatch" });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toHaveLength(1);
    expect(rapport.errors[0]).toContain("enqueueBatch: RPC absente");
    expect(rapport.errors[0]).not.toContain("is not a function");
  });

  /** En simulation on n'écrit rien du tout — pas même un audit. */
  test("la simulation n'écrit ni pause, ni audit", async () => {
    const { db, journal } = fauxDb({ planteEn: "pageAudience" });
    await runFanout(db, { now: MAINTENANT, simulate: true });

    expect(journal.some((l) => l.startsWith("auditFanoutError"))).toBe(false);
    expect(journal).not.toContain("releaseClaim");
  });
});

describe("compterCiblesDues — dire ce qu'un refus coûte, sans rien prendre", () => {
  /**
   * ⛔ POURQUOI CE COMPTAGE EXISTE. Quand le worker n'est pas en `live`, le fan-out refuse de
   * démarrer et rend la main : un refus PARFAITEMENT silencieux, dans un service dont personne ne lit
   * les journaux. Le refus est bon — il empêche de remplir une file que personne ne peut vider — mais
   * « le worker n'envoie pas » est une information tiède, là où « 3 cibles étaient dues et aucune ne
   * partira » est une alerte.
   */
  test("il compte les deux formes de cible", async () => {
    const { db } = fauxDb({ cibles: [cible(), cible({ campaignId: "camp_2" })] });
    expect(await compterCiblesDues(db, 20, MAINTENANT)).toBe(2);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : compter en appelant `claim()` ou `fanoutOne`. Ce comptage tourne
   * DANS la garde qui refuse d'écrire : s'il prenait la moindre cible, il la passerait `sending`
   * alors que rien ne va l'enfiler — la campagne serait figée dans un état dont rien ne la sort.
   */
  test("⛔ il ne PREND rien : aucune écriture, aucun claim", async () => {
    const { db, journal } = fauxDb();
    await compterCiblesDues(db, 20, MAINTENANT);

    expect(journal).toEqual([]);
  });

  test("aucune cible due — zéro, et pas d'alerte à fabriquer", async () => {
    const { db } = fauxDb({ cibles: [] });
    expect(await compterCiblesDues(db, 20, MAINTENANT)).toBe(0);
  });
});

describe("⛔ relecture d'édition (0079) — jamais d'envoi PÉRIMÉ", () => {
  const occurrence = (over: Partial<FanoutTarget> = {}) =>
    cible({ occurrenceId: "occ_1", campaignId: "camp_1", reviewRev: 2, reviewPending: true, ...over });

  /**
   * Une relecture est enregistrée, le worker ne l'a pas encore reconstruite : le shell en base est
   * celui d'AVANT. MUTATION QUI DOIT TUER CE TEST : retirer le saut `review_pending` de `fanoutOne`.
   */
  test("⛔ une édition relue et pas encore reconstruite n'est ni prise, ni enfilée, ni retenue", async () => {
    const { db, journal } = fauxDb({ cibles: [occurrence()] });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(rapport.targets[0]?.skipped).toBe("review_pending");
    expect(journal).not.toContain("claim");
    expect(journal.some((l) => l.startsWith("enqueueBatch"))).toBe(false);
    // Un SAUT, pas une rétention : une édition `held` ne se relâche plus, celle-ci doit partir à la
    // passe suivante, une fois reconstruite.
    expect(journal.some((l) => l.startsWith("hold"))).toBe(false);
    expect(rapport.held).toEqual([]);
  });

  test("TÉMOIN — reconstruite (révision appliquée), elle part", async () => {
    const { db, journal } = fauxDb({ cibles: [occurrence({ reviewPending: false })] });
    const rapport = await runFanout(db, { now: MAINTENANT });

    expect(rapport.errors).toEqual([]);
    expect(rapport.targets[0]?.skipped).toBeUndefined();
    expect(journal).toContain("claim");
    expect(journal).toContain("enqueueBatch:2");
  });

  /** Le double du client Supabase : enregistre la chaîne, rend `lignes`. */
  function avecClient(lignes: Record<string, unknown>[]) {
    const appels: { methode: string; args: unknown[] }[] = [];
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resoudre: (v: unknown) => void) => resoudre({ data: lignes, error: null });
          return (...args: unknown[]) => {
            appels.push({ methode: prop, args });
            return proxy;
          };
        },
      },
    ) as Record<string, unknown>;
    const db = Object.create(FanoutDb.prototype) as FanoutDb;
    (db as unknown as { sb: unknown }).sb = proxy;
    return { db, appels };
  }

  test("listDueOccurrences lit les deux révisions et dit « en attente » exactement quand rev > appliquée", async () => {
    const ligne = (id: string, rev: number | null, appliquee: number | null) => ({
      id,
      campaign_id: "camp_1",
      asset_id: "asset_1",
      segment_id: null,
      scheduled_at: "2026-09-08T10:05:00Z",
      recipients_planned: 10,
      review_rev: rev,
      review_applied_rev: appliquee,
      campaign: { name: "C", purpose: "content", status: "scheduled", archived_at: null },
    });
    const { db, appels } = avecClient([ligne("relue", 3, 2), ligne("appliquee", 3, 3), ligne("jamais", 0, 0), ligne("avant-0079", null, null)]);
    const cibles = await db.listDueOccurrences(MAINTENANT, 20);

    const select = String(appels.find((a) => a.methode === "select")?.args[0] ?? "");
    expect(select).toContain("review_rev");
    expect(select).toContain("review_applied_rev");
    expect(cibles.map((c) => `${c.occurrenceId}:${c.reviewPending}:${c.reviewRev}`)).toEqual([
      "relue:true:3",
      "appliquee:false:3",
      "jamais:false:0",
      "avant-0079:false:0",
    ]);
  });

  /**
   * ⛔ LA PRISE EST GARDÉE PAR LA RÉVISION LUE. Une relecture enregistrée entre la lecture et la prise
   * fait bouger `review_rev` : la prise ne touche rien, l'édition attend sa reconstruction.
   * MUTATION QUI DOIT TUER CE TEST : retirer `.eq("review_rev", …)` de `claim`.
   */
  test("⛔ claim d'une occurrence : `frozen` ET la révision lue ; une campagne simple n'a pas de révision", async () => {
    const occ = avecClient([{ id: "occ_1" }]);
    expect(await occ.db.claim(occurrence({ reviewPending: false, reviewRev: 5 }))).toBe(true);
    const eqs = occ.appels.filter((a) => a.methode === "eq").map((a) => `${a.args[0]}=${a.args[1]}`);
    expect(eqs).toContain("status=frozen");
    expect(eqs).toContain("review_rev=5");

    const camp = avecClient([{ id: "camp_1" }]);
    await camp.db.claim(cible());
    expect(camp.appels.some((a) => a.methode === "eq" && a.args[0] === "review_rev")).toBe(false);
  });
});
