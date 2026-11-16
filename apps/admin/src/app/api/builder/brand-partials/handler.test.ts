/**
 * GET/POST /api/builder/brand-partials — les routes mesurées sans session ni base.
 *
 * Les refus du modèle de données sont couverts par `lib/data/brand-partials*.test.ts` ; ici on mesure
 * le CÂBLAGE de la troisième fente (0080) : la route accepte `block` et l'écrit tel quel, refuse une
 * fente inconnue AVANT toute écriture, et un bloc passe les mêmes gardes que l'en-tête (1 à 20 rows,
 * pas de pied légal).
 */
import { describe, expect, test } from "bun:test";
import { ecrit, fauxDb, type AppelDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `brand-partials.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import sans AUTH_SECRET.
process.env.AUTH_SECRET = "secret-de-test-uniquement-23092026";
const { createPartial, listPartials } = await import("./handler");

const ASSET = "22222222-2222-4222-8222-222222222222";
const AUTEUR = "auteur@staff.invalid";
const r = (data: unknown, error: unknown = null): ReponseDb => ({ data, error });

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
const poster = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
const ecritures = (appels: AppelDb[]) => appels.filter(ecrit);

const rowTexte = (id: string): unknown => ({
  id,
  layout: "1",
  columns: [{ id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: "T" }] }] }] }],
});
const rowLegale = (): unknown => ({
  id: "legal",
  layout: "1",
  columns: [{ id: "legal_c", blocks: [{ id: "legal_b", type: "footer_legal" }] }],
});

describe("POST — la fente `block`", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer `"block"` de `BRAND_PARTIAL_SLOTS`.
   * Symptôme : « New block » et « Save this row » répondent 400, la bibliothèque de blocs n'existe pas.
   */
  test("un bloc de 2 rows est créé (201), écrit avec SA fente, sa marque et l'auteur de la session", async () => {
    const g = garde(r({ id: "nouveau" }));
    const { status, json } = await lire(
      await createPartial(poster({ slot: "block", name: "  Podcast · Duo  ", rows: [rowTexte("a"), rowTexte("b")] }), g.garde),
    );
    expect(status).toBe(201);
    expect(json).toEqual({ id: "nouveau" });

    const [ecriture] = ecritures(g.appels);
    expect(ecriture!.table).toBe("brand_partial");
    const ligne = ecriture!.methodes.find((m) => m.m === "insert")!.args[0] as Record<string, unknown>;
    expect(ligne.slot).toBe("block");
    expect(ligne.asset_id).toBe(ASSET);
    expect(ligne.name).toBe("Podcast · Duo");
    expect(ligne.updated_by).toBe(AUTEUR);
    expect((ligne.rows as unknown[]).length).toBe(2);
  });

  test("témoin : un en-tête passe toujours par la même route", async () => {
    const g = garde(r({ id: "h" }));
    expect((await createPartial(poster({ slot: "header", name: "H", rows: [rowTexte("h")] }), g.garde)).status).toBe(201);
  });

  test("une fente inconnue ⇒ 400, et RIEN n'atteint la base", async () => {
    const g = garde(r({ id: "jamais" }));
    const { status, json } = await lire(
      await createPartial(poster({ slot: "sidebar", name: "X", rows: [rowTexte("a")] }), g.garde),
    );
    expect(status).toBe(400);
    expect(String(json.error).includes("block")).toBe(true);
    expect(g.appels).toHaveLength(0);
  });

  test("un bloc de 21 rows ⇒ 422, rien n'est écrit", async () => {
    const g = garde(r({ id: "jamais" }));
    const rows = Array.from({ length: 21 }, (_, i) => rowTexte(`r${i}`));
    expect((await createPartial(poster({ slot: "block", name: "Trop", rows }), g.garde)).status).toBe(422);
    expect(ecritures(g.appels)).toHaveLength(0);
  });

  test("un bloc qui embarque le pied légal ⇒ 422, rien n'est écrit", async () => {
    const g = garde(r({ id: "jamais" }));
    const res = await createPartial(poster({ slot: "block", name: "Légal", rows: [rowTexte("a"), rowLegale()] }), g.garde);
    expect(res.status).toBe(422);
    expect(ecritures(g.appels)).toHaveLength(0);
  });

  test("un nom déjà pris par un bloc VIVANT ⇒ 409 qui nomme le bloc", async () => {
    const g = garde(r(null, { code: "23505", message: "duplicate" }));
    const { status, json } = await lire(await createPartial(poster({ slot: "block", name: "Pris", rows: [rowTexte("a")] }), g.garde));
    expect(status).toBe(409);
    expect(String(json.error).startsWith("a block named")).toBe(true);
  });
});

describe("GET", () => {
  test("bibliothèque illisible ⇒ 503, jamais une liste vide", async () => {
    const g = garde(r(null, { message: "boom" }));
    expect((await listPartials(g.garde)).status).toBe(503);
  });

  test("les blocs sont servis avec leur fente, à côté des en-têtes", async () => {
    const ligne = (id: string, slot: string) => ({
      id,
      slot,
      name: slot,
      rows: [rowTexte(`${slot}_1`)],
      archived_at: null,
      updated_by: null,
      updated_at: "2026-09-23T00:00:00Z",
      created_at: "2026-09-23T00:00:00Z",
    });
    const g = garde(r([ligne("b1", "block"), ligne("h1", "header")]));
    const { status, json } = await lire(await listPartials(g.garde));
    expect(status).toBe(200);
    expect((json.brandPartials as { slot: string }[]).map((p) => p.slot)).toEqual(["block", "header"]);
  });
});
