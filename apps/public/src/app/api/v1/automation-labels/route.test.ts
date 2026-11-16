/**
 * L'ENREGISTREMENT D'UN LABEL D'AUTOMATION (0095), route entière sur une base en mémoire.
 *
 * Ce qui se tient, en une phrase chacun :
 *  · sans le secret d'ingest (absent, faux, ou absent de l'environnement), c'est un 401 et RIEN n'est écrit ;
 *  · un nom inutilisable est un 422 lisible, une marque inconnue un 404 ;
 *  · le même nom rejoué rend le même slug et n'écrit pas une seconde ligne ;
 *  · une autre graphie du même slug renomme la ligne, sans changer le slug.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { fausseBasePostgrest } from "@/lib/faux-postgrest";

let base: ReturnType<typeof fausseBasePostgrest> | null = null;
mock.module("@/lib/supabase", () => ({ getDb: () => base?.db ?? null }));
const { POST } = await import("./route");

const SECRET = "secret-de-banc-0123456789";
const envAvant = process.env.NF_INGEST_SECRET;
beforeAll(() => {
  process.env.NF_INGEST_SECRET = SECRET;
});
afterAll(() => {
  process.env.NF_INGEST_SECRET = envAvant;
});

function monter() {
  base = fausseBasePostgrest({ asset: [{ id: "asset-northwind-sports", slug: "northwind-sports" }], automation_label: [] });
  return base;
}

async function envoyer(corps: unknown, secret: string | null = SECRET) {
  const res = await POST(
    new Request("https://nf.example.org/api/v1/automation-labels", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-nf-ingest-secret": secret }) },
      body: typeof corps === "string" ? corps : JSON.stringify(corps),
    }),
  );
  return { status: res.status, corps: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/v1/automation-labels", () => {
  test("sans secret, avec un faux, ou sans secret configuré : 401, rien d'écrit", async () => {
    const b = monter();
    expect((await envoyer({ asset: "northwind-sports", name: "Libertadores 2026" }, null)).status).toBe(401);
    expect((await envoyer({ asset: "northwind-sports", name: "Libertadores 2026" }, "faux")).status).toBe(401);
    process.env.NF_INGEST_SECRET = "";
    expect((await envoyer({ asset: "northwind-sports", name: "Libertadores 2026" }, "")).status).toBe(401);
    process.env.NF_INGEST_SECRET = SECRET;
    expect(b.tables.automation_label).toHaveLength(0);
  });

  test("nom inutilisable : 422 lisible ; marque absente : 422 ; marque inconnue : 404", async () => {
    monter();
    const r = await envoyer({ asset: "northwind-sports", name: "⚽" });
    expect(r.status).toBe(422);
    expect(r.corps.error).toBe("label-invalide");
    expect((await envoyer({ name: "Libertadores 2026" })).status).toBe(422);
    expect((await envoyer({ asset: "inconnue", name: "Libertadores 2026" })).status).toBe(404);
    expect((await envoyer("pas du json")).status).toBe(400);
    expect(base?.tables.automation_label).toHaveLength(0);
  });

  test("créé une fois, rejoué sans doublon, le slug ne bouge pas", async () => {
    const b = monter();
    const r1 = await envoyer({ asset: "northwind-sports", name: "Libertadores 2026" });
    expect(r1).toEqual({ status: 200, corps: { ok: true, slug: "libertadores-2026", name: "Libertadores 2026", created: true } });
    expect(b.tables.automation_label).toHaveLength(1);
    expect(b.tables.automation_label?.[0]).toMatchObject({
      asset_id: "asset-northwind-sports",
      slug: "libertadores-2026",
      name: "Libertadores 2026",
      source: "optinforge",
    });

    const r2 = await envoyer({ asset: "northwind-sports", name: "Libertadores 2026" });
    expect(r2.corps.created).toBe(false);
    expect(b.tables.automation_label).toHaveLength(1);
  });

  test("autre graphie du même slug : la ligne est renommée, le slug reste", async () => {
    const b = monter();
    await envoyer({ asset: "northwind-sports", name: "Libertadores 2026" });
    const r = await envoyer({ asset: "northwind-sports", name: "LIBERTADORES   2026" });
    expect(r.corps).toMatchObject({ slug: "libertadores-2026", name: "LIBERTADORES 2026", created: false });
    expect(b.tables.automation_label).toHaveLength(1);
    expect(b.tables.automation_label?.[0]?.name).toBe("LIBERTADORES 2026");
    expect(b.tables.automation_label?.[0]?.slug).toBe("libertadores-2026");
  });
});
