/**
 * LES ABONNÉS D'UN SEGMENT — la liste que l'écran déplie, mesurée sans base ni session.
 *
 * Ce que ces tests tiennent en place, dans l'ordre de ce qui coûterait le plus cher :
 *  1. la liste ne sort JAMAIS de la marque (`eq("asset_id")` sur chaque lecture de la vue) ;
 *  2. un ciblage élargi ne liste PERSONNE — pas toute la marque ;
 *  3. une lecture ratée est un échec nommé, jamais « ce segment est vide » ;
 *  4. la recherche garde les caractères d'une adresse et passe par `.in("subscriber_id")` ;
 *  5. la pagination tombe sur les bonnes lignes.
 *
 * ⚠️ Le double de base répond PAR TABLE et selon les méthodes chaînées (tête de comptage, `.in`,
 * `.ilike`) : ce qui est mesuré, c'est la requête construite, pas ce que PostgREST en ferait. La
 * forme réelle a été vérifiée à part, en SQL, sur la base de production (lecture seule).
 */
import { describe, expect, test } from "bun:test";

// ⚠️ `segment-members.ts` tire `campaigns.ts` → `@/lib/session` → `auth.ts`, qui LÈVE à l'import si
// AUTH_SECRET manque. Poser la variable, puis charger dynamiquement (un import statique serait hissé).
process.env.AUTH_SECRET = "secret-de-test-uniquement-22092026";
const { listSegmentMembers, sanitizeEmailSearch, MEMBERS_SEARCH_CAP } = await import("@/lib/data/segment-members");
const { postSegmentMembers, parseMembersInput } = await import("./handler");

const ASSET = "22222222-2222-4222-8222-222222222222";
const SEG = "11111111-1111-4111-8111-111111111111";

const REGLE_PAYS = {
  id: "root",
  type: "group",
  op: "AND",
  children: [{ id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" }],
};
const REGLE_VIDE = { id: "root", type: "group", op: "AND", children: [] };
/** Un ET dont un terme ne se résout pas (tag inconnu de la marque) : la population S'ÉLARGIT. */
const REGLE_ELARGIE = {
  id: "root",
  type: "group",
  op: "AND",
  children: [
    { id: "n1", type: "predicate", field: "country", op: "eq", value: "BR" },
    { id: "n2", type: "predicate", field: "tag", op: "has", value: "absent" },
  ],
};
const REGLE_TAG = {
  id: "root",
  type: "group",
  op: "AND",
  children: [{ id: "n1", type: "predicate", field: "tag", op: "has", value: "vip" }],
};

type Methode = { m: string; args: unknown[] };
type Appel = { table: string; methodes: Methode[] };
type Rep = { data?: unknown; error?: unknown; count?: number | null };

/** Double chaînable : la réponse est choisie AU MOMENT DE L'`await`, d'après la requête construite. */
function fauxDb(repondre: (a: Appel) => Rep) {
  const appels: Appel[] = [];
  const db = {
    from(table: string) {
      const appel: Appel = { table, methodes: [] };
      appels.push(appel);
      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              const r = repondre(appel);
              return (resoudre: (v: unknown) => void) =>
                resoudre({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
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
  return { db: db as unknown as Parameters<typeof listSegmentMembers>[0], appels };
}

const methodes = (a: Appel, m: string) => a.methodes.filter((x) => x.m === m);
const estComptage = (a: Appel) =>
  a.methodes.some((x) => x.m === "select" && (x.args[1] as { head?: boolean } | undefined)?.head === true);
const vue = (appels: Appel[]) => appels.filter((a) => a.table === "sendable_subscription");
const listeVue = (appels: Appel[]) => vue(appels).filter((a) => !estComptage(a));

type Ligne = { id: string; subscriber_id: string; created_at: string; engagement_level: string };
interface Scenario {
  regle?: unknown;
  segmentAbsent?: boolean;
  total?: number;
  filtre?: number;
  trouves?: string[];
  lignes?: Ligne[];
  emails?: { id: string; email: string }[];
  panne?: "total" | "compte-nul" | "recherche" | "filtre" | "liste" | "emails" | "tags";
}

function scenario(s: Scenario = {}) {
  const boom = { message: "boom" };
  return fauxDb((appel) => {
    switch (appel.table) {
      case "segment":
        return {
          data: s.segmentAbsent
            ? null
            : {
                id: SEG,
                name: "BR",
                kind: "dynamic",
                rule_json: s.regle === undefined ? REGLE_PAYS : s.regle,
                cached_count: 3,
                cached_at: null,
                used_by_automation: false,
                updated_at: "2026-09-01T00:00:00Z",
              },
        };
      case "tag":
        return s.panne === "tags" ? { error: boom } : { data: [{ id: 1, slug: "vip", kind: null }] };
      case "optin":
      case "capture_campaign":
        return { data: [] };
      case "subscriber":
        if (methodes(appel, "ilike").length > 0) {
          return s.panne === "recherche" ? { error: boom } : { data: (s.trouves ?? []).map((id) => ({ id })) };
        }
        return s.panne === "emails" ? { error: boom } : { data: s.emails ?? [] };
      case "sendable_subscription":
        if (estComptage(appel)) {
          if (methodes(appel, "in").length > 0) return s.panne === "filtre" ? { error: boom } : { count: s.filtre ?? 0 };
          if (s.panne === "total") return { error: boom };
          if (s.panne === "compte-nul") return { count: null };
          return { count: s.total ?? 0 };
        }
        return s.panne === "liste" ? { error: boom } : { data: s.lignes ?? [] };
    }
    return { data: null };
  });
}

const ligne = (n: number): Ligne => ({
  id: `sub-${n}`,
  subscriber_id: `p-${n}`,
  created_at: `2026-09-${String(10 + n).padStart(2, "0")}T00:00:00Z`,
  engagement_level: "active",
});

describe("listSegmentMembers — la marque, et rien qu'elle", () => {
  test("⛔ un segment d'une AUTRE marque est introuvable, et la lecture est scopée", async () => {
    const { db, appels } = scenario({ segmentAbsent: true, total: 5 });
    const r = await listSegmentMembers(db, ASSET, SEG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
    const seg = appels.find((a) => a.table === "segment")!;
    expect(methodes(seg, "eq").map((m) => m.args)).toContainEqual(["asset_id", ASSET]);
    expect(vue(appels)).toHaveLength(0);
  });

  test("un identifiant qui n'est pas un uuid ne touche même pas la base", async () => {
    const { db, appels } = scenario();
    const r = await listSegmentMembers(db, ASSET, "pas-un-uuid");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
    expect(appels).toHaveLength(0);
  });

  test("⛔ `eq(asset_id)` est posé sur CHAQUE lecture de la vue — avec et sans recherche", async () => {
    for (const q of ["", "gmail"]) {
      const { db, appels } = scenario({ total: 3, filtre: 2, trouves: ["p-1", "p-2"], lignes: [ligne(1)], emails: [{ id: "p-1", email: "a@x.io" }] });
      const r = await listSegmentMembers(db, ASSET, SEG, { q });
      expect(r.ok).toBe(true);
      const lectures = vue(appels);
      // Sans recherche : compte + liste. Avec : compte du segment + compte filtré + liste.
      expect(lectures.length).toBe(q ? 3 : 2);
      for (const a of lectures) {
        expect(methodes(a, "eq").map((m) => m.args)).toContainEqual(["asset_id", ASSET]);
        // La règle compilée est bien appliquée — la même expression que le fan-out.
        const ors = methodes(a, "or").map((m) => String(m.args[0]));
        expect(ors).toHaveLength(1);
        expect(ors[0]).toContain("country");
      }
    }
  });

  test("règle VIDE : toute la marque — mais toujours la marque, et aucun `.or()`", async () => {
    const { db, appels } = scenario({ regle: REGLE_VIDE, total: 4, lignes: [ligne(1)], emails: [{ id: "p-1", email: "a@x.io" }] });
    const r = await listSegmentMembers(db, ASSET, SEG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.segmentTotal).toBe(4);
    for (const a of vue(appels)) {
      expect(methodes(a, "eq").map((m) => m.args)).toContainEqual(["asset_id", ASSET]);
      expect(methodes(a, "or")).toHaveLength(0);
    }
  });
});

describe("listSegmentMembers — ce qui ne se liste PAS", () => {
  test("⛔⛔ ciblage élargi : refus nommé, et AUCUNE lecture de la vue ni des adresses", async () => {
    const { db, appels } = scenario({ regle: REGLE_ELARGIE, total: 999 });
    const r = await listSegmentMembers(db, ASSET, SEG, { q: "a" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("targeting-incomplete");
      expect(r.unsupported).toContain("tag:absent");
    }
    expect(vue(appels)).toHaveLength(0);
    expect(appels.filter((a) => a.table === "subscriber")).toHaveLength(0);
  });

  test("⛔ la lecture des tags RATÉE ne liste pas toute la marque", async () => {
    // Le tag `vip` existe, mais sa table n'a pas pu être lue : le prédicat tombe, et sous un ET il
    // élargirait. C'est le chemin « table de correspondance ratée ⇒ refus ».
    const { db, appels } = scenario({ regle: REGLE_TAG, panne: "tags", total: 999 });
    const r = await listSegmentMembers(db, ASSET, SEG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("targeting-incomplete");
    expect(vue(appels)).toHaveLength(0);
  });

  test("témoin : la MÊME règle de tag, table lue, se liste", async () => {
    const { db } = scenario({ regle: REGLE_TAG, total: 1, lignes: [ligne(1)], emails: [{ id: "p-1", email: "a@x.io" }] });
    const r = await listSegmentMembers(db, ASSET, SEG);
    expect(r.ok).toBe(true);
  });

  test("règle illisible : refus, pas « tout le monde »", async () => {
    for (const regle of [{}, { type: "group" }, { type: "group", op: "XOR", children: [] }, null]) {
      const { db, appels } = scenario({ regle, total: 999 });
      const r = await listSegmentMembers(db, ASSET, SEG);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("unreadable-rule");
      expect(vue(appels)).toHaveLength(0);
    }
  });

  test("⛔ chaque lecture ratée est un ÉCHEC, jamais une liste vide", async () => {
    const pannes: Scenario["panne"][] = ["total", "compte-nul", "recherche", "filtre", "liste", "emails"];
    for (const panne of pannes) {
      const { db } = scenario({ panne, total: 3, filtre: 1, trouves: ["p-1"], lignes: [ligne(1)], emails: [{ id: "p-1", email: "a@x.io" }] });
      const r = await listSegmentMembers(db, ASSET, SEG, { q: "a" });
      expect({ panne, ok: r.ok }).toEqual({ panne, ok: false });
      if (!r.ok) expect(r.reason).toBe("lookup-failed");
    }
  });
});

describe("listSegmentMembers — la recherche", () => {
  test("⛔ le nettoyage garde `_ . + @` et retire `% * , ( ) \" ' \\`", () => {
    const cas: [string, string][] = [
      ["jean_dupont+promo@exa.mple", "jean_dupont+promo@exa.mple"],
      ["  a.b@c.io  ", "a.b@c.io"],
      ["50%off,(x)@y.z", "50offx@y.z"],
      ["a*b\"c'd\\e", "abcde"],
      ["%%%", ""],
    ];
    for (const [entree, attendu] of cas) expect(sanitizeEmailSearch(entree)).toBe(attendu);
  });

  test("⛔ la recherche passe par `subscriber` puis `.in(\"subscriber_id\")`, jamais par `.or()`", async () => {
    const { db, appels } = scenario({
      total: 10,
      filtre: 1,
      trouves: ["p-7", "p-8"],
      lignes: [ligne(7)],
      emails: [{ id: "p-7", email: "jean_dupont+promo@exa.mple" }],
    });
    const r = await listSegmentMembers(db, ASSET, SEG, { q: " jean_dupont+promo@exa.mple%,() " });
    expect(r.ok).toBe(true);

    const recherche = appels.find((a) => a.table === "subscriber" && methodes(a, "ilike").length > 0)!;
    expect(methodes(recherche, "ilike")[0]!.args).toEqual(["email", "%jean_dupont+promo@exa.mple%"]);
    // Les contacts fictifs sont hors de la vue : ils ne doivent pas consommer le plafond.
    expect(methodes(recherche, "eq").map((m) => m.args)).toContainEqual(["is_demo", false]);

    // Compte filtré ET liste : tous deux restreints aux personnes trouvées, et à UN seul `.or()` (la règle).
    const filtrees = vue(appels).filter((a) => methodes(a, "in").length > 0);
    expect(filtrees).toHaveLength(2);
    for (const a of filtrees) {
      expect(methodes(a, "in")[0]!.args).toEqual(["subscriber_id", ["p-7", "p-8"]]);
      expect(methodes(a, "or")).toHaveLength(1);
    }
    if (r.ok) {
      expect(r.query).toBe("jean_dupont+promo@exa.mple");
      expect(r.total).toBe(1);
      expect(r.segmentTotal).toBe(10);
      expect(r.rows.map((x) => x.email)).toEqual(["jean_dupont+promo@exa.mple"]);
    }
  });

  test("aucune adresse trouvée : zéro, sans `.in([])` ni lecture de liste", async () => {
    const { db, appels } = scenario({ total: 6, trouves: [] });
    const r = await listSegmentMembers(db, ASSET, SEG, { q: "personne" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.total).toBe(0);
      expect(r.segmentTotal).toBe(6);
      expect(r.rows).toEqual([]);
    }
    expect(vue(appels).filter((a) => methodes(a, "in").length > 0)).toHaveLength(0);
    expect(listeVue(appels)).toHaveLength(0);
  });

  test("⛔ plafond ATTEINT : `truncated`, et seuls CAP identifiants partent dans l'URL", async () => {
    const trop = Array.from({ length: MEMBERS_SEARCH_CAP + 1 }, (_, i) => `p-${i}`);
    const { db, appels } = scenario({ total: 500, filtre: 0, trouves: trop });
    const r = await listSegmentMembers(db, ASSET, SEG, { q: "gmail" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.truncated).toBe(true);
    const recherche = appels.find((a) => a.table === "subscriber")!;
    expect(methodes(recherche, "limit")[0]!.args[0]).toBe(MEMBERS_SEARCH_CAP + 1);
    const filtre = vue(appels).find((a) => methodes(a, "in").length > 0)!;
    expect((methodes(filtre, "in")[0]!.args[1] as string[]).length).toBe(MEMBERS_SEARCH_CAP);
  });

  test("témoin : EXACTEMENT CAP correspondances n'est pas un dépassement", async () => {
    const pile = Array.from({ length: MEMBERS_SEARCH_CAP }, (_, i) => `p-${i}`);
    const { db } = scenario({ total: 500, filtre: 0, trouves: pile });
    const r = await listSegmentMembers(db, ASSET, SEG, { q: "gmail" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.truncated).toBe(false);
  });
});

describe("listSegmentMembers — la page", () => {
  const plage = (appels: Appel[]) => methodes(listeVue(appels)[0]!, "range")[0]!.args;

  test("page 2 de 50 ⇒ lignes 50 à 99", async () => {
    const { db, appels } = scenario({ total: 120, lignes: [ligne(1)], emails: [{ id: "p-1", email: "a@x.io" }] });
    const r = await listSegmentMembers(db, ASSET, SEG, { page: 2 });
    expect(plage(appels)).toEqual([50, 99]);
    if (r.ok) expect(r.page).toBe(2);
  });

  test("page 1 ⇒ lignes 0 à 49, triées par date puis par id", async () => {
    const { db, appels } = scenario({ total: 120, lignes: [ligne(1)], emails: [{ id: "p-1", email: "a@x.io" }] });
    await listSegmentMembers(db, ASSET, SEG);
    expect(plage(appels)).toEqual([0, 49]);
    expect(methodes(listeVue(appels)[0]!, "order").map((m) => m.args)).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: true }],
    ]);
  });

  test("une page au-delà du segment est ramenée à la dernière", async () => {
    const { db, appels } = scenario({ total: 120, lignes: [ligne(1)], emails: [{ id: "p-1", email: "a@x.io" }] });
    const r = await listSegmentMembers(db, ASSET, SEG, { page: 9 });
    expect(plage(appels)).toEqual([100, 149]);
    if (r.ok) expect(r.page).toBe(3);
  });

  test("les adresses viennent de `subscriber`, lues pour la page seulement", async () => {
    const { db, appels } = scenario({
      total: 2,
      lignes: [ligne(1), ligne(2)],
      emails: [{ id: "p-2", email: "b@x.io" }, { id: "p-1", email: "a@x.io" }],
    });
    const r = await listSegmentMembers(db, ASSET, SEG);
    const lecture = appels.find((a) => a.table === "subscriber")!;
    expect(methodes(lecture, "in")[0]!.args).toEqual(["id", ["p-1", "p-2"]]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toEqual([
        { subscriptionId: "sub-1", email: "a@x.io", joinedAt: "2026-09-11T00:00:00Z", engagementLevel: "active" },
        { subscriptionId: "sub-2", email: "b@x.io", joinedAt: "2026-09-12T00:00:00Z", engagementLevel: "active" },
      ]);
    }
  });
});

describe("POST /api/segments/[id]/members — entrée et codes", () => {
  const ctxOk = (db: unknown) => async () => ({
    ok: true as const,
    ctx: { db: db as never, asset: { id: ASSET, name: "PF" } as never, user: { email: "a@staff.invalid" } as never },
  });
  const appeler = async (body: unknown, s: Scenario = {}) => {
    const { db, appels } = scenario(s);
    const res = await postSegmentMembers(
      new Request("http://x/api", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
      { params: Promise.resolve({ id: SEG }) },
      { requireContext: ctxOk(db) },
    );
    return { res, json: (await res.json()) as Record<string, unknown>, appels };
  };

  test("un refus de session est rendu tel quel, sans lecture", async () => {
    const res = await postSegmentMembers(
      new Request("http://x/api", { method: "POST", body: "{}" }),
      { params: Promise.resolve({ id: SEG }) },
      { requireContext: async () => ({ ok: false as const, res: Response.json({ error: "unauthenticated" }, { status: 401 }) as never }) },
    );
    expect(res.status).toBe(401);
  });

  test("⛔ entrée invalide ⇒ 400, et la base n'est pas touchée", async () => {
    const invalides: unknown[] = [
      { q: 5 },
      { q: "x".repeat(101) },
      { page: 0 },
      { page: -1 },
      { page: 1.5 },
      { page: "2" },
      "pas du json",
      [],
    ];
    for (const body of invalides) {
      const { res, appels } = await appeler(body, { total: 3 });
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(appels).toHaveLength(0);
    }
  });

  test("témoin : les bornes exactes sont acceptées", async () => {
    expect(parseMembersInput({ q: "x".repeat(100), page: 3 })).toEqual({ ok: true, q: "x".repeat(100), page: 3 });
    expect(parseMembersInput({})).toEqual({ ok: true, q: "", page: 1 });
  });

  test("200 : la page, le total vivant et le total du segment", async () => {
    const { res, json } = await appeler({ page: 1 }, { total: 1, lignes: [ligne(1)], emails: [{ id: "p-1", email: "a@x.io" }] });
    expect(res.status).toBe(200);
    expect(json.segmentTotal).toBe(1);
    expect((json.rows as unknown[]).length).toBe(1);
  });

  test("segment introuvable ⇒ 404", async () => {
    const { res } = await appeler({}, { segmentAbsent: true });
    expect(res.status).toBe(404);
  });

  test("⛔ ciblage élargi ⇒ 409, les conditions tombées sont nommées", async () => {
    const { res, json } = await appeler({}, { regle: REGLE_ELARGIE });
    expect(res.status).toBe(409);
    expect(json.reason).toBe("targeting-incomplete");
    expect(json.unsupported).toEqual(["tag:absent"]);
    expect(json.rows).toBeUndefined();
  });

  test("lecture ratée ⇒ 503, pas 200 vide", async () => {
    const { res, json } = await appeler({}, { panne: "liste", total: 3 });
    expect(res.status).toBe(503);
    expect(json.rows).toBeUndefined();
  });
});
