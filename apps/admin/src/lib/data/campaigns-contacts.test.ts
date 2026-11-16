/**
 * L'ESTIMATION D'AUDIENCE DEVANT LES CONTACTS HORS NEWSLETTER (0088, décision d'Alix du 25/09/2026).
 *
 * ⛔ CE QUE CE BANC TIENT — le reflet exact du fan-out (`apps/worker/src/fanout-contacts.test.ts`) :
 *  - la vue vient de la RÈGLE : « Newsletter: No » compte `contact_subscription`, tout le reste
 *    `sendable_subscription` ;
 *  - la barrière de finalité ne saute QUE pour des contacts ET avec la case de la campagne ;
 *  - la case est un booléen STRICT, lu `=== true`.
 *
 * ⚠️ Aucun accès réseau : le client est un double qui répond par table et enregistre les appels.
 */
import { describe, expect, test } from "bun:test";

process.env.AUTH_SECRET = "secret-de-test-uniquement-25092026";
const { estimateAudience, buildCampaignPatch, mapCampaign, CAMPAIGN_SELECT } = await import("./campaigns");

const ASSET = "asset_1";
const SEGMENT = "11111111-1111-4111-8111-111111111111";

const regle = (...children: unknown[]) => ({ id: "root", type: "group", op: "AND", children });
const NEWSLETTER_NON = { id: "n1", type: "predicate", field: "newsletter", op: "eq", value: "no" };
const PAYS_BR = { id: "n2", type: "predicate", field: "country", op: "eq", value: "BR" };

type Reponse = { data?: unknown; count?: number; error?: unknown };

function fauxDb(rule: unknown) {
  const tables: string[] = [];
  const compteur: Record<string, number> = {};
  const repondre = (table: string, n: number): Reponse => {
    if (table === "segment") return { data: { id: SEGMENT, name: "Contoso", rule_json: rule } };
    // 1er appel = envoyables, 2e = ceux qui ont accordé la finalité.
    if (table === "contact_subscription") return { count: n === 1 ? 9 : 2 };
    if (table === "sendable_subscription") return { count: n === 1 ? 500 : 300 };
    if (table === "excluded_demo_subscription") return { count: 4 };
    if (table === "sunsetted_subscription") return { count: 7 };
    if (table === "asset_edition") return { data: [{ id: "ed_1", compliance_regime: "lgpd" }] };
    return { data: [] };
  };
  const db = {
    from(table: string) {
      tables.push(table);
      compteur[table] = (compteur[table] ?? 0) + 1;
      const rep = repondre(table, compteur[table]);
      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (ok: (v: unknown) => void) => ok({ data: rep.data ?? null, error: rep.error ?? null, count: rep.count ?? null });
            }
            return () => chaine;
          },
        },
      );
      return chaine;
    },
  };
  return { db: db as unknown as Parameters<typeof estimateAudience>[0], tables };
}

const combien = (tables: string[], t: string) => tables.filter((x) => x === t).length;

describe("estimateAudience — « Newsletter: No » compte les contacts", () => {
  test("sans la case : vue des contacts, finalité exigée, compléments sans objet", async () => {
    // MUTATION QUI DOIT TUER CE TEST : remettre `db.from("sendable_subscription")` dans `query()`.
    const { db, tables } = fauxDb(regle(NEWSLETTER_NON, PAYS_BR));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content");
    expect(r.population).toBe("contacts");
    expect(r.sendable).toBe(9);
    expect(r.eligible).toBe(2);
    expect(r.purposeIgnored).toBe(false);
    expect(r.demoExcluded).toBeNull();
    expect(r.sunsetExcluded).toBeNull();
    expect(combien(tables, "contact_subscription")).toBe(2);
    expect(combien(tables, "sendable_subscription")).toBe(0);
    expect(combien(tables, "excluded_demo_subscription")).toBe(0);
  });

  test("avec la case : tous les contacts comptés, sans lire la finalité", async () => {
    const { db, tables } = fauxDb(regle(NEWSLETTER_NON));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content", { contactsIgnorePurpose: true });
    expect(r.eligible).toBe(9);
    expect(r.sendable).toBe(9);
    expect(r.purposeIgnored).toBe(true);
    expect(r.reason).toBeNull();
    expect(combien(tables, "contact_subscription")).toBe(1);
    expect(combien(tables, "asset_edition")).toBe(0);
  });

  test("⛔ la finalité reste exigée sur la campagne, même case cochée", async () => {
    const { db } = fauxDb(regle(NEWSLETTER_NON));
    const r = await estimateAudience(db, ASSET, SEGMENT, null, { contactsIgnorePurpose: true });
    expect(r.eligible).toBeNull();
    expect(r.reason).toBe("campaign has no purpose");
  });
});

describe("estimateAudience — ⛔ la case ne touche JAMAIS aux abonnés", () => {
  test("règle d'abonnés + case cochée : barrière de finalité intacte", async () => {
    // MUTATION QUI DOIT TUER CE TEST : `purposeIgnored = contactsIgnorePurpose` (sans la population).
    const { db, tables } = fauxDb(regle(PAYS_BR));
    const r = await estimateAudience(db, ASSET, SEGMENT, "content", { contactsIgnorePurpose: true });
    expect(r.population).toBe("subscribers");
    expect(r.eligible).toBe(300);
    expect(r.purposeIgnored).toBe(false);
    expect(combien(tables, "sendable_subscription")).toBe(2);
    expect(combien(tables, "contact_subscription")).toBe(0);
  });

  test("sans segment + case cochée : toute la marque, c'est-à-dire les abonnés", async () => {
    const { db, tables } = fauxDb(null);
    const r = await estimateAudience(db, ASSET, null, "content", { contactsIgnorePurpose: true });
    expect(r.population).toBe("subscribers");
    expect(r.eligible).toBe(300);
    expect(r.demoExcluded).toBe(4);
    expect(combien(tables, "contact_subscription")).toBe(0);
  });

  test("un sélecteur imbriqué refuse de compter", async () => {
    const imbrique = regle(PAYS_BR, { id: "g1", type: "group", op: "OR", children: [NEWSLETTER_NON, PAYS_BR] });
    const { db, tables } = fauxDb(imbrique);
    const r = await estimateAudience(db, ASSET, SEGMENT, "content", { contactsIgnorePurpose: true });
    expect(r.eligible).toBeNull();
    expect(r.unsupported).toContain("newsletter:nested");
    expect(combien(tables, "contact_subscription") + combien(tables, "sendable_subscription")).toBe(0);
  });
});

describe("la case sur la campagne — lue et écrite strictement", () => {
  test("le corps n'accepte qu'un booléen", async () => {
    const { db } = fauxDb(null);
    // MUTATION QUI DOIT TUER : `patch.contacts_ignore_purpose = Boolean(body.contactsIgnorePurpose)` sans le refus.
    const chaine = await buildCampaignPatch(db, ASSET, { contactsIgnorePurpose: "true" });
    expect(chaine.ok).toBe(false);
    const oui = await buildCampaignPatch(db, ASSET, { contactsIgnorePurpose: true });
    expect(oui.ok && oui.patch.contacts_ignore_purpose).toBe(true);
    expect(oui.ok && oui.touched.includes("contactsIgnorePurpose")).toBe(true);
    const non = await buildCampaignPatch(db, ASSET, { contactsIgnorePurpose: false });
    expect(non.ok && non.patch.contacts_ignore_purpose).toBe(false);
  });

  test("la lecture : seule la valeur `true` coche la case", () => {
    expect(CAMPAIGN_SELECT).toContain("contacts_ignore_purpose");
    expect(mapCampaign({ id: "c" }).contactsIgnorePurpose).toBe(false);
    expect(mapCampaign({ id: "c", contacts_ignore_purpose: "true" }).contactsIgnorePurpose).toBe(false);
    expect(mapCampaign({ id: "c", contacts_ignore_purpose: true }).contactsIgnorePurpose).toBe(true);
  });
});
