/**
 * POST /api/builder/canvas-render — le câblage, mesuré sans session ni base.
 * La fidélité des fragments elle-même est mesurée par `lib/canvas-render.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { ecrit, eqsDe, fauxDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `_shared.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import sans AUTH_SECRET.
process.env.AUTH_SECRET = "secret-de-test-uniquement-22092026";
const { canvasRenderHandler } = await import("./handler");

const ASSET = "22222222-2222-4222-8222-222222222222";
const HEADER = "44444444-4444-4444-8444-444444444444";
const r = (data: unknown, error: unknown = null): ReponseDb => ({ data, error });

function garde(...reponses: ReponseDb[]) {
  const f = fauxDb(...reponses);
  return {
    ...f,
    garde: async () => ({
      ok: true as const,
      ctx: { db: f.db as never, asset: { id: ASSET, name: "PF" } as never, user: { email: "a@staff.invalid" } as never },
    }),
  };
}

const texte = (id: string, t: string) => ({ id, type: "text", preset: "body", paragraphs: [{ spans: [{ text: t }] }] });
const doc = (meta: Record<string, unknown> = {}) => ({
  schema: 2,
  meta: { assetSlug: "pf", locale: "es", subject: "S", ...meta },
  theme: {},
  rows: [{ id: "r1", layout: "1", columns: [{ id: "c1", blocks: [texte("t1", "CORPS")] }] }],
});
const poster = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
const lire = async (res: Response) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> });

describe("canvas-render", () => {
  test("sans session, rien ne se compile", async () => {
    const res = await canvasRenderHandler(poster({ doc: doc() }), async () => ({
      ok: false as const,
      res: Response.json({ error: "unauthenticated" }, { status: 401 }) as never,
    }));
    expect(res.status).toBe(401);
  });

  test("sans pointeur de marque : aucune lecture en base, un fragment par bloc", async () => {
    const g = garde();
    const { status, json } = await lire(await canvasRenderHandler(poster({ doc: doc() }), g.garde));
    expect(status).toBe(200);
    expect(g.appels).toHaveLength(0);
    expect(String((json.blocks as Record<string, { html: string }>).t1!.html)).toContain("CORPS");
  });

  test("l'en-tête de marque est lu SUR LA MARQUE, jamais écrit, et rendu à part", async () => {
    const partial = {
      id: HEADER,
      slot: "header",
      name: "Logo",
      rows: [{ id: "h1", layout: "1", columns: [{ id: "hc", blocks: [texte("hb", "EN-TETE")] }] }],
      archived_at: null,
      updated_by: null,
      updated_at: "",
      created_at: "",
    };
    const g = garde(r([partial]));
    const { status, json } = await lire(await canvasRenderHandler(poster({ doc: doc({ headerPartialId: HEADER }) }), g.garde));
    expect(status).toBe(200);
    expect(g.appels.map((a) => [a.table, eqsDe(a)])).toEqual([["brand_partial", [["asset_id", ASSET]]]]);
    expect(g.appels.some(ecrit)).toBe(false);
    const header = json.header as { columns: { blocks: { id: string }[] }[] }[];
    expect(header).toHaveLength(1);
    const id = header[0]!.columns[0]!.blocks[0]!.id;
    expect((json.blocks as Record<string, { html: string }>)[id]!.html).toContain("EN-TETE");
  });

  test("lecture de marque ratée : le rendu se fait quand même, et l'avertissement le dit", async () => {
    const g = garde(r(null, { message: "boom" }));
    const { status, json } = await lire(await canvasRenderHandler(poster({ doc: doc({ headerPartialId: HEADER }) }), g.garde));
    expect(status).toBe(200);
    expect((json.warnings as string[]).join(" ")).toContain("brand header");
  });

  test("thème invalide ⇒ 400 avec les motifs ; corps absent ⇒ 400", async () => {
    const mauvais = { ...doc(), theme: { brandColor: "rouge" } };
    const { status, json } = await lire(await canvasRenderHandler(poster({ doc: mauvais }), garde().garde));
    expect(status).toBe(400);
    expect((json.issues as string[]).length).toBeGreaterThan(0);
    expect((await canvasRenderHandler(poster({}), garde().garde)).status).toBe(400);
  });
});
