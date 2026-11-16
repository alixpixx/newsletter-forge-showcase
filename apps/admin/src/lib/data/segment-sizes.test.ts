/**
 * LA TAILLE ACTUELLE DES SEGMENTS ENREGISTRÉS — mesurée sans base ni session.
 *
 * Bug du 25/09/2026 (Alix) : la colonne « Last measured size » montrait `cached_count`, écrit une
 * seule fois à l'enregistrement — « Newsletter » (Northwind Sports) affichait 10 pour 31 abonnés réels.
 *
 * Ce que ces tests tiennent en place :
 *  1. le nombre rendu est CELUI QUE LA BASE COMPTE MAINTENANT, segment par segment ;
 *  2. le compte ne sort jamais de la marque, et suit la vue que la règle désigne ;
 *  3. un ciblage élargi ou une règle illisible ne se comptent pas ;
 *  4. une panne de comptage est un échec NOMMÉ et journalisé — jamais un zéro, jamais une exception.
 *
 * ⚠️ Le double de base répond selon la requête construite (table, `.or()`) : ce qui est mesuré, c'est
 * la requête, pas ce que PostgREST en ferait. La forme réelle a été vérifiée en SQL sur la base de
 * production, en lecture seule, le 25/09/2026.
 */
import { describe, expect, test } from "bun:test";

// ⚠️ `segment-sizes.ts` tire `campaigns.ts` → `@/lib/session` → `auth.ts`, qui LÈVE à l'import si
// AUTH_SECRET manque. Poser la variable, puis charger dynamiquement.
process.env.AUTH_SECRET = "secret-de-test-uniquement-25092026";
const { measureSegmentSizes } = await import("@/lib/data/segment-sizes");

const ASSET = "22222222-2222-4222-8222-222222222222";

const regle = (children: unknown[], op = "AND") => ({ id: "root", type: "group", op, children });
const PAYS_BR = regle([{ id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" }]);
const PAYS_CL = regle([{ id: "n1", type: "predicate", field: "country", op: "eq", value: "CL" }]);
/** Un ET dont un terme ne se résout pas (tag inconnu de la marque) : la population S'ÉLARGIT. */
const ELARGIE = regle([
  { id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" },
  { id: "n2", type: "predicate", field: "tag", op: "has", value: "absent" },
]);
/** « Newsletter: No » : la règle vise les contacts hors newsletter (0088), une AUTRE vue. */
const CONTACTS = regle([{ id: "n1", type: "predicate", field: "newsletter", op: "eq", value: "no" }]);

type Methode = { m: string; args: unknown[] };
type Appel = { table: string; methodes: Methode[] };
type Rep = { data?: unknown; error?: unknown; count?: number | null };

function fauxDb(repondre: (a: Appel) => Rep, leverSur?: string) {
  const appels: Appel[] = [];
  const db = {
    from(table: string) {
      if (table === leverSur) throw new Error("socket hang up");
      const appel: Appel = { table, methodes: [] };
      appels.push(appel);
      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              const r = repondre(appel);
              return (resoudre: (v: unknown) => void) =>
                resoudre({ data: r.data ?? null, error: r.error ?? null, count: r.count === undefined ? null : r.count });
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
  return { db: db as unknown as NonNullable<Parameters<typeof measureSegmentSizes>[0]>, appels };
}

const args = (a: Appel, m: string) => a.methodes.filter((x) => x.m === m).map((x) => x.args);
const VUES = ["sendable_subscription", "contact_subscription"];
const comptages = (appels: Appel[]) => appels.filter((a) => VUES.includes(a.table));

/** Base de référence : la table des tags, et un compte PAR PAYS lu dans le `.or()` de la requête. */
function base(parPays: Record<string, number | null>, panne?: { error?: unknown }) {
  return fauxDb((appel) => {
    if (appel.table === "tag") return { data: [{ id: 1, slug: "vip", kind: null }] };
    if (VUES.includes(appel.table)) {
      if (panne) return panne;
      const expr = String(args(appel, "or")[0]?.[0] ?? "");
      const pays = /country\.eq\."(\w+)"/.exec(expr)?.[1] ?? "*";
      return { count: pays in parPays ? parPays[pays] : 999 };
    }
    return { data: [] };
  });
}

/** Capte le journal d'erreurs le temps d'un appel (le harnais typé n'a pas `spyOn`). */
async function avecJournal<T>(fn: () => Promise<T>): Promise<{ r: T; journal: string }> {
  const origine = console.error;
  const lignes: string[] = [];
  console.error = (...a: unknown[]) => {
    lignes.push(a.map(String).join(" "));
  };
  try {
    return { r: await fn(), journal: lignes.join("\n") };
  } finally {
    console.error = origine;
  }
}

describe("measureSegmentSizes — le nombre suit la réalité", () => {
  test("chaque segment reçoit le compte ACTUEL de SA règle", async () => {
    const { db } = base({ BR: 31, CL: 6 });
    const tailles = await measureSegmentSizes(db, ASSET, [
      { id: "s-br", rule: PAYS_BR as never },
      { id: "s-cl", rule: PAYS_CL as never },
    ]);
    expect(tailles.get("s-br")).toEqual({ ok: true, count: 31 });
    expect(tailles.get("s-cl")).toEqual({ ok: true, count: 6 });
  });

  test("la base change, le nombre change : rien n'est figé d'un affichage à l'autre", async () => {
    const segs = [{ id: "s-br", rule: PAYS_BR as never }];
    expect((await measureSegmentSizes(base({ BR: 10 }).db, ASSET, segs)).get("s-br")).toEqual({ ok: true, count: 10 });
    expect((await measureSegmentSizes(base({ BR: 31 }).db, ASSET, segs)).get("s-br")).toEqual({ ok: true, count: 31 });
  });

  test("un vrai zéro est un compte, pas un échec", async () => {
    const tailles = await measureSegmentSizes(base({ BR: 0 }).db, ASSET, [{ id: "s", rule: PAYS_BR as never }]);
    expect(tailles.get("s")).toEqual({ ok: true, count: 0 });
  });

  test("⛔ compte en tête seule, scopé MARQUE, avec le filtre de la règle", async () => {
    const { db, appels } = base({ BR: 3 });
    await measureSegmentSizes(db, ASSET, [{ id: "s", rule: PAYS_BR as never }]);
    const [c] = comptages(appels);
    expect(c.table).toBe("sendable_subscription");
    expect(args(c, "select")[0]).toEqual(["id", { count: "exact", head: true }]);
    expect(args(c, "eq")).toEqual([["asset_id", ASSET]]);
    expect(args(c, "or")).toEqual([['country.eq."BR"']]);
    // Le scope est posé AVANT le `.or()` : sinon il serait absorbé dans la disjonction.
    expect(c.methodes.map((x) => x.m)).toEqual(["select", "eq", "or"]);
  });

  test("« Newsletter: No » se compte sur la vue des CONTACTS, comme le fan-out", async () => {
    const { db, appels } = base({});
    const tailles = await measureSegmentSizes(db, ASSET, [{ id: "s", rule: CONTACTS as never }]);
    expect(comptages(appels).map((a) => a.table)).toEqual(["contact_subscription"]);
    expect(tailles.get("s")).toEqual({ ok: true, count: 999 });
  });

  test("les tables de correspondance sont lues UNE fois pour toute la liste", async () => {
    const { db, appels } = base({ BR: 1, CL: 2 });
    await measureSegmentSizes(db, ASSET, [
      { id: "a", rule: PAYS_BR as never },
      { id: "b", rule: PAYS_CL as never },
      { id: "c", rule: PAYS_BR as never },
    ]);
    expect(appels.filter((a) => a.table === "tag")).toHaveLength(1);
  });

  test("liste vide : aucune requête", async () => {
    const { db, appels } = base({});
    expect((await measureSegmentSizes(db, ASSET, [])).size).toBe(0);
    expect(appels).toHaveLength(0);
  });
});

describe("measureSegmentSizes — ce qui ne se compte pas", () => {
  test("⛔ ciblage élargi : refus nommé avec les conditions tombées, et AUCUN compte lancé", async () => {
    const { db, appels } = base({ BR: 5 });
    const tailles = await measureSegmentSizes(db, ASSET, [{ id: "s", rule: ELARGIE as never }]);
    expect(tailles.get("s")).toEqual({ ok: false, reason: "targeting-incomplete", unsupported: ["tag:absent"] });
    expect(comptages(appels)).toHaveLength(0);
  });

  test("⛔ règle illisible (opérateur inconnu) : refus, jamais « toute la marque »", async () => {
    const { db, appels } = base({});
    const tailles = await measureSegmentSizes(db, ASSET, [
      { id: "nulle", rule: null },
      { id: "xor", rule: regle([], "XOR") as never },
    ]);
    expect(tailles.get("nulle")).toEqual({ ok: false, reason: "unreadable-rule" });
    expect(tailles.get("xor")).toEqual({ ok: false, reason: "unreadable-rule" });
    expect(comptages(appels)).toHaveLength(0);
  });

  test("sans base ou sans marque : rien n'est compté (un compte non scopé additionnerait les marques)", async () => {
    const segs = [{ id: "s", rule: PAYS_BR as never }];
    const { db, appels } = base({ BR: 5 });
    expect((await measureSegmentSizes(null, ASSET, segs)).get("s")).toEqual({ ok: false, reason: "no-db" });
    expect((await measureSegmentSizes(db, null, segs)).get("s")).toEqual({ ok: false, reason: "no-db" });
    expect(appels).toHaveLength(0);
  });
});

describe("measureSegmentSizes — une panne de comptage ne casse rien et se voit", () => {
  test("erreur de la base : échec nommé, journalisé, jamais zéro", async () => {
    const { db } = base({}, { error: { message: "statement timeout" } });
    const { r: tailles, journal } = await avecJournal(() =>
      measureSegmentSizes(db, ASSET, [{ id: "s", rule: PAYS_BR as never }]),
    );
    expect(tailles.get("s")).toEqual({ ok: false, reason: "lookup-failed" });
    expect(journal).toContain("segment-size-lecture-ratee");
    expect(journal).toContain("statement timeout");
  });

  test("`count` absent : échec, pas un zéro", async () => {
    const { r: tailles, journal } = await avecJournal(() =>
      measureSegmentSizes(base({ BR: null }).db, ASSET, [{ id: "s", rule: PAYS_BR as never }]),
    );
    expect(tailles.get("s")).toEqual({ ok: false, reason: "lookup-failed" });
    expect(journal).toContain("count absent");
  });

  test("une requête qui LÈVE ne fait pas lever la page, et se journalise", async () => {
    const { db } = fauxDb(() => ({ data: [] }), "sendable_subscription");
    const { r: tailles, journal } = await avecJournal(() =>
      measureSegmentSizes(db, ASSET, [{ id: "s", rule: PAYS_BR as never }]),
    );
    expect(tailles.get("s")).toEqual({ ok: false, reason: "lookup-failed" });
    expect(journal).toContain("socket hang up");
  });

  test("les tables de correspondance qui LÈVENT : tous les segments en échec nommé, rien ne lève", async () => {
    const { db } = fauxDb(() => ({ data: [] }), "tag");
    const { r: tailles, journal } = await avecJournal(() =>
      measureSegmentSizes(db, ASSET, [
        { id: "a", rule: PAYS_BR as never },
        { id: "b", rule: PAYS_CL as never },
      ]),
    );
    expect(tailles.get("a")).toEqual({ ok: false, reason: "lookup-failed" });
    expect(tailles.get("b")).toEqual({ ok: false, reason: "lookup-failed" });
    expect(journal).toContain("socket hang up");
  });

  test("un segment en panne n'emporte pas les autres", async () => {
    const { r: tailles } = await avecJournal(() =>
      measureSegmentSizes(base({ BR: null, CL: 6 }).db, ASSET, [
        { id: "br", rule: PAYS_BR as never },
        { id: "cl", rule: PAYS_CL as never },
      ]),
    );
    expect(tailles.get("br")).toEqual({ ok: false, reason: "lookup-failed" });
    expect(tailles.get("cl")).toEqual({ ok: true, count: 6 });
  });
});
