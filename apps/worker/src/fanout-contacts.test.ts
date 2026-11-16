/**
 * LES CONTACTS HORS NEWSLETTER AU FAN-OUT (0088, décision d'Alix du 25/09/2026).
 *
 * ⛔ CE QUE CE BANC TIENT : la population vient de la RÈGLE et de rien d'autre. Sans « Newsletter: No »,
 * le fan-out lit `sendable_subscription` et appelle 0038 — exactement comme avant ; avec, il lit
 * `contact_subscription` et appelle la fonction des contacts. Et la barrière de finalité ne saute QUE
 * pour des contacts d'une campagne qui porte la case.
 *
 * ⚠️ AUCUNE ÉCRITURE : le `FanoutDb` est un double qui enregistre ce qu'on lui demande.
 */
import { describe, expect, test } from "bun:test";
import type { Population, RuleContext } from "@nf/segments";
import { runFanout } from "./fanout";
import { FanoutDb, type FanoutTarget } from "./fanout-db";

const MAINTENANT = new Date("2026-09-25T10:00:00Z");
const CONTEXTE: RuleContext = { tagIdBySlug: {}, optinIdBySlug: {}, interestIds: [], captureOptinIds: [], captureCampaignIds: [], automationIds: [] };

const regle = (...children: unknown[]) => ({ id: "root", type: "group", op: "AND", children });
const NEWSLETTER_NON = { id: "n1", type: "predicate", field: "newsletter", op: "eq", value: "no" };
const PAYS_BR = { id: "n2", type: "predicate", field: "country", op: "eq", value: "BR" };

function cible(over: Partial<FanoutTarget> = {}): FanoutTarget {
  return {
    occurrenceId: null,
    campaignId: "camp_1",
    assetId: "asset_1",
    campaignName: "Contoso",
    segmentId: "seg_1",
    purpose: "content",
    scheduledAt: MAINTENANT.toISOString(),
    recipientsPlanned: 9,
    ...over,
  };
}

type Page = { population: Population; segmentExpr: string | null; gateExpr: string | null };

function fauxDb(t: FanoutTarget, rule: unknown) {
  const pages: Page[] = [];
  const lots: Population[] = [];
  let lu = false;
  const db = {
    listDueOccurrences: async () => [],
    listDueCampaigns: async () => [t],
    getSegmentRule: async (id: string) => ({ id, rule }),
    ruleContext: async () => CONTEXTE,
    optOutEditionIds: async () => [],
    claim: async () => true,
    pageAudience: async (p: Page) => {
      pages.push(p);
      if (lu) return [];
      lu = true;
      return ["sub_1", "sub_2"];
    },
    enqueueBatch: async (_c: string, _o: string | null, ids: string[], population: Population) => {
      lots.push(population);
      return ids.length;
    },
    countQueued: async () => 2,
    markEnqueued: async () => {},
    holdOccurrence: async () => {},
    holdCampaign: async () => {},
    releaseClaim: async () => {},
    auditFanoutError: async () => {},
  };
  return { db: db as unknown as FanoutDb, pages, lots };
}

describe("fan-out — la population vient de la règle", () => {
  test("« Newsletter: No » : vue des contacts, fonction des contacts, barrière de finalité GARDÉE sans la case", async () => {
    // MUTATION QUI DOIT TUER CE TEST : `const gateExpr = null` sans condition.
    const { db, pages, lots } = fauxDb(cible(), regle(NEWSLETTER_NON, PAYS_BR));
    const rapport = await runFanout(db, { now: MAINTENANT });
    expect(rapport.errors).toEqual([]);
    expect(pages[0]?.population).toBe("contacts");
    expect(pages[0]?.segmentExpr).toBe('country.eq."BR"');
    expect(pages[0]?.gateExpr).toBe("granted_purposes->>content.eq.true");
    // MUTATION QUI DOIT TUER : `enqueueBatch(..., ids)` sans la population (défaut abonnés).
    expect(lots).toEqual(["contacts"]);
  });

  test("« Newsletter: No » + case cochée : la barrière de finalité saute", async () => {
    const { db, pages, lots } = fauxDb(cible({ contactsIgnorePurpose: true }), regle(NEWSLETTER_NON));
    const rapport = await runFanout(db, { now: MAINTENANT });
    expect(rapport.errors).toEqual([]);
    expect(pages[0]?.population).toBe("contacts");
    expect(pages[0]?.gateExpr).toBeNull();
    expect(lots).toEqual(["contacts"]);
  });

  test("⛔ la case ne lève RIEN pour des abonnés : vue et barrière intactes", async () => {
    // MUTATION QUI DOIT TUER CE TEST : `purposeIgnored = t.contactsIgnorePurpose === true` (sans la population).
    const { db, pages, lots } = fauxDb(cible({ contactsIgnorePurpose: true }), regle(PAYS_BR));
    const rapport = await runFanout(db, { now: MAINTENANT });
    expect(rapport.errors).toEqual([]);
    expect(pages[0]?.population).toBe("subscribers");
    expect(pages[0]?.gateExpr).toBe("granted_purposes->>content.eq.true");
    expect(lots).toEqual(["subscribers"]);
  });

  test("sans segment : les abonnés, case cochée ou non", async () => {
    const { db, pages, lots } = fauxDb(cible({ segmentId: null, contactsIgnorePurpose: true }), undefined);
    const rapport = await runFanout(db, { now: MAINTENANT });
    expect(rapport.errors).toEqual([]);
    expect(pages[0]?.population).toBe("subscribers");
    expect(pages[0]?.gateExpr).toBe("granted_purposes->>content.eq.true");
    expect(lots).toEqual(["subscribers"]);
  });

  test("un sélecteur imbriqué est RETENU, jamais replié sur une vue", async () => {
    const imbrique = regle(PAYS_BR, { id: "g1", type: "group", op: "OR", children: [NEWSLETTER_NON, PAYS_BR] });
    const { db, pages } = fauxDb(cible(), imbrique);
    const rapport = await runFanout(db, { now: MAINTENANT });
    expect(pages).toEqual([]);
    expect(rapport.held[0]?.reason).toContain("newsletter:nested");
  });
});

/** `FanoutDb` LUI-MÊME, sur un client simulé : la vue lue et la fonction appelée. */
describe("FanoutDb — la vue et la fonction suivent la population", () => {
  function dbSur() {
    const vues: string[] = [];
    const rpcs: string[] = [];
    const chaine: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "gt", "order"]) chaine[m] = () => chaine;
    chaine.limit = async () => ({ data: [], error: null });
    const sb = {
      from: (table: string) => {
        vues.push(table);
        return chaine;
      },
      rpc: async (nom: string) => {
        rpcs.push(nom);
        return { data: 0, error: null };
      },
    };
    const db = Object.create(FanoutDb.prototype) as FanoutDb;
    (db as unknown as { sb: unknown }).sb = sb;
    return { db, vues, rpcs };
  }

  test("pageAudience lit la vue de la population", async () => {
    const { db, vues } = dbSur();
    const p = { assetId: "a", segmentExpr: null, gateExpr: null, afterId: null, limit: 10 };
    await db.pageAudience({ ...p, population: "subscribers" });
    await db.pageAudience({ ...p, population: "contacts" });
    expect(vues).toEqual(["sendable_subscription", "contact_subscription"]);
  });

  test("enqueueBatch appelle 0038 pour les abonnés, 0088 pour les contacts", async () => {
    // MUTATION QUI DOIT TUER : inverser le ternaire du nom de fonction.
    const { db, rpcs } = dbSur();
    await db.enqueueBatch("c", null, ["s"], "subscribers");
    await db.enqueueBatch("c", null, ["s"], "contacts");
    expect(rpcs).toEqual(["enqueue_campaign_batch", "enqueue_campaign_batch_contacts"]);
  });
});
