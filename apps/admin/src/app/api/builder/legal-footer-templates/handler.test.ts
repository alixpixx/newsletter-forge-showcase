/**
 * GET/POST /api/builder/legal-footer-templates — les routes mesurées sans session ni base.
 *
 * Les refus du modèle de données sont déjà couverts par `lib/data/legal-footer-templates.test.ts` ;
 * ici on mesure le CÂBLAGE : une lecture ratée ne se lit jamais « aucun pied », un refus n'écrit
 * rien, le détail utile (champ manquant, nom pris) arrive jusqu'à l'écran, et l'auteur est la session.
 */
import { describe, expect, test } from "bun:test";
import { ecrit, eqsDe, fauxDb, type AppelDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `legal-footer-templates.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import sans AUTH_SECRET.
process.env.AUTH_SECRET = "secret-de-test-uniquement-16092026";
const { createLegalFooter, listLegalFooters } = await import("./handler");

const ASSET = "22222222-2222-4222-8222-222222222222";
const AUTEUR = "auteur@staff.invalid";
const r = (data: unknown, error: unknown = null): ReponseDb => ({ data, error });
const edition = (regime: string, legal_footer: Record<string, unknown> = {}) => ({
  id: "e1",
  market: "CL",
  language: "es",
  compliance_regime: regime,
  is_primary: true,
  legal_footer,
});

function garde(...reponses: ReponseDb[]) {
  const f = fauxDb(...reponses);
  return {
    ...f,
    garde: async () => ({
      ok: true as const,
      ctx: { db: f.db as never, asset: { id: ASSET, name: "PF" } as never, user: { email: AUTEUR } as never },
    }),
  };
}

const lire = async (res: Response) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> });
const poster = (body: unknown) =>
  new Request("http://x/api", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const ecritures = (appels: AppelDb[]) => appels.filter(ecrit);

describe("GET", () => {
  test("un refus de session est rendu tel quel", async () => {
    const res = await listLegalFooters(async () => ({
      ok: false as const,
      res: Response.json({ error: "unauthenticated" }, { status: 401 }) as never,
    }));
    expect(res.status).toBe(401);
  });

  test("bibliothèque illisible ⇒ 503, jamais une liste vide", async () => {
    const g = garde(r(null, { message: "boom" }), r([edition("gdpr")]));
    const { status } = await lire(await listLegalFooters(g.garde));
    expect(status).toBe(503);
  });

  test("éditions illisibles ⇒ 503", async () => {
    const g = garde(r([]), r(null, { message: "boom" }));
    expect((await listLegalFooters(g.garde)).status).toBe(503);
  });

  test("les deux lectures sont scopées sur la marque ; le pied par défaut est celui de la primaire", async () => {
    const g = garde(r([]), r([edition("gdpr", { privacy_url: "https://pf.invalid/p" })]));
    const { status, json } = await lire(await listLegalFooters(g.garde));
    expect(status).toBe(200);
    expect(g.appels.map((a) => [a.table, eqsDe(a)])).toEqual([
      ["legal_footer_template", [["asset_id", ASSET]]],
      ["asset_edition", [["asset_id", ASSET]]],
    ]);
    expect(json).toEqual({
      legalFooters: [],
      editions: [{ market: "CL", language: "es", regime: "gdpr" }],
      defaultConfig: { privacy_url: "https://pf.invalid/p" },
    });
  });

  test("aucune édition ⇒ defaultConfig null", async () => {
    const g = garde(r([]), r([]));
    const { json } = await lire(await listLegalFooters(g.garde));
    expect(json.defaultConfig).toBeNull();
  });
});

describe("POST", () => {
  const complet = { privacy_url: "https://pf.invalid/p" };

  const refus: [string, unknown, number][] = [
    ["corps illisible", "{nope", 400],
    ["nom absent", { config: complet }, 400],
    ["config qui n'est pas un objet", { name: "Chile", config: "x" }, 422],
  ];
  for (const [nom, body, attendu] of refus) {
    test(`${nom} ⇒ ${attendu}, sans lecture ni écriture`, async () => {
      const g = garde();
      const res = await createLegalFooter(poster(body), g.garde);
      expect(res.status).toBe(attendu);
      expect(g.appels).toEqual([]);
    });
  }

  test("incomplet pour une édition ⇒ 422 qui nomme le champ, rien n'est écrit", async () => {
    const g = garde(r([edition("gdpr")]));
    const { status, json } = await lire(await createLegalFooter(poster({ name: "Chile", config: {} }), g.garde));
    expect(status).toBe(422);
    expect(json.missing).toEqual(["privacy_url (CL · es)"]);
    expect(ecritures(g.appels)).toEqual([]);
  });

  test("éditions illisibles ⇒ 503, rien n'est écrit", async () => {
    const g = garde(r(null, { message: "boom" }));
    const res = await createLegalFooter(poster({ name: "Chile", config: complet }), g.garde);
    expect(res.status).toBe(503);
    expect(ecritures(g.appels)).toEqual([]);
  });

  test("complet ⇒ 201, écrit pour la marque, auteur = la session", async () => {
    const g = garde(r([edition("gdpr")]), r({ id: "lf1" }));
    const { status, json } = await lire(await createLegalFooter(poster({ name: "  Chile  ", config: complet }), g.garde));
    expect(status).toBe(201);
    expect(json).toEqual({ id: "lf1" });
    const [w] = ecritures(g.appels);
    expect(w!.methodes.find((m) => m.m === "insert")!.args[0]).toEqual({
      asset_id: ASSET,
      name: "Chile",
      config: complet,
      updated_by: AUTEUR,
    });
  });

  test("nom déjà pris ⇒ 409 avec kind name_taken", async () => {
    const g = garde(r([edition("gdpr")]), r(null, { code: "23505", message: "dup" }));
    const { status, json } = await lire(await createLegalFooter(poster({ name: "Chile", config: complet }), g.garde));
    expect(status).toBe(409);
    expect(json.kind).toBe("name_taken");
  });
});
