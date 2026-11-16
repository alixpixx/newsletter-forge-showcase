/**
 * LES LISTES ET LEUR DOMAINE D'ENVOI — route entière sur une base en mémoire.
 *
 * Ce qui se tient, en une phrase chacun :
 *  · sans le secret d'ingest (absent, faux, ou absent de l'environnement), c'est un 401 et rien n'est lu ;
 *  · avec le secret, chaque marque sort avec son slug et son domaine d'envoi, et rien d'autre.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { fausseBasePostgrest } from "@/lib/faux-postgrest";

let base: ReturnType<typeof fausseBasePostgrest> | null = null;
mock.module("@/lib/supabase", () => ({ getDb: () => base?.db ?? null }));
const { GET } = await import("./route");

const SECRET = "secret-de-banc-0123456789";
const envAvant = process.env.NF_INGEST_SECRET;
beforeAll(() => {
  process.env.NF_INGEST_SECRET = SECRET;
});
afterAll(() => {
  process.env.NF_INGEST_SECRET = envAvant;
});

function monter() {
  base = fausseBasePostgrest({
    asset: [
      { id: "asset-tw", slug: "harbor-tech", name: "Harbor Tech", sending_subdomain: "news.harbor-tech.example" },
      { id: "asset-ff", slug: "goalpost-weekly", name: "Goalpost Weekly", sending_subdomain: "news.goalpost-weekly.example" },
      { id: "asset-sans", slug: "sans-domaine", name: "Sans domaine", sending_subdomain: null },
    ],
  });
  return base;
}

async function lire(secret: string | null = SECRET) {
  const res = await GET(
    new Request("https://nf.example.org/api/v1/assets", {
      headers: secret === null ? {} : { "x-nf-ingest-secret": secret },
    }),
  );
  return { status: res.status, corps: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/v1/assets", () => {
  test("sans secret, avec un faux, ou sans secret configuré : 401, aucune marque ne sort", async () => {
    monter();
    for (const secret of [null, "faux"]) {
      const r = await lire(secret);
      expect(r.status).toBe(401);
      expect(r.corps.assets).toBeUndefined();
    }
    process.env.NF_INGEST_SECRET = "";
    expect((await lire("")).status).toBe(401);
    process.env.NF_INGEST_SECRET = SECRET;
  });

  test("avec le secret : slug et domaine d'envoi de chaque marque, triés, sans autre colonne", async () => {
    monter();
    const r = await lire();
    expect(r.status).toBe(200);
    expect(r.corps).toEqual({
      ok: true,
      assets: [
        { slug: "goalpost-weekly", sending_subdomain: "news.goalpost-weekly.example" },
        { slug: "harbor-tech", sending_subdomain: "news.harbor-tech.example" },
        { slug: "sans-domaine", sending_subdomain: null },
      ],
    });
  });

  test("base absente : 503, jamais une liste vide qui passerait pour « aucune marque »", async () => {
    base = null;
    expect((await lire()).status).toBe(503);
  });
});
