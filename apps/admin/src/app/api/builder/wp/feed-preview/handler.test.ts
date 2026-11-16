/**
 * POST /api/builder/wp/feed-preview — l'avertissement « le plus récent a plus de 24 h », mesuré sans
 * session, sans base et sans réseau.
 *
 * ⛔ POURQUOI. Le 25/09/2026, un bloc Northwind Sports trié par date filtrait sur deux catégories que le site
 * n'emploie plus : l'aperçu montrait sept articles vieux de 12 à 15 h, sans un mot. La route rend
 * désormais `stale` — ce banc prouve qu'elle le rend, et qu'elle se tait sur un flux frais.
 *
 * ⚠️ Les lecteurs WordPress sont INJECTÉS (`Recolteurs`), pas doublés sur `globalThis.fetch` : le
 * `mock.module("./guard")` de `packages/wp/src/client.test.ts` fuit vers toute la suite et rendait ce
 * banc vert seul, rouge à la racine.
 */
import { describe, expect, test } from "bun:test";
import { toCandidates } from "@nf/wp";
import { fauxDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `_shared.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import sans AUTH_SECRET.
process.env.AUTH_SECRET = "secret-de-test-uniquement-25092026";
const { feedPreview } = await import("./handler");
type Recolteurs = NonNullable<Parameters<typeof feedPreview>[2]>;

const ASSET = "22222222-2222-4222-8222-222222222222";
const SOURCE = "44444444-4444-4444-8444-444444444444";
const HOUR = 3_600_000;

const r = (data: unknown, error: unknown = null): ReponseDb => ({ data, error });
const ligneSource = {
  id: SOURCE,
  edition_id: "55555555-5555-4555-8555-555555555555",
  asset_id: ASSET,
  label: "Northwind Sports",
  rest_root: "https://northwind-sports.invalid/wp-json",
  kind: "wp-rest",
  default_categories: [],
  auth_kind: "none",
  auth_user: null,
  capabilities: null,
  status: "ok",
  status_detail: null,
  last_probed_at: null,
  created_at: "2026-09-01T00:00:00Z",
};

function garde() {
  const f = fauxDb(r(ligneSource));
  return async () => ({
    ok: true as const,
    ctx: { db: f.db as never, asset: { id: ASSET, name: "Northwind Sports" } as never, user: { email: "a@staff.invalid" } as never },
  });
}

/** `date_gmt` WordPress (sans fuseau) d'un article publié il y a `ms` millisecondes. */
const ilYa = (ms: number) => new Date(Date.now() - ms).toISOString().slice(0, 19);

/** Un site qui rend des articles publiés aux dates GMT données — sans réseau. */
function site(datesGmt: string[]): Recolteurs {
  const candidates = toCandidates(
    datesGmt.map((d, i) => ({
      id: i + 1,
      link: `https://northwind-sports.invalid/artigo-${i + 1}/`,
      date_gmt: d,
      title: { rendered: `Artigo ${i + 1}` },
      excerpt: { rendered: `Resumo ${i + 1}` },
    })),
  );
  const refus = async (): Promise<never> => {
    throw new Error("ce lecteur ne doit pas servir en mode `date` sur une source REST");
  };
  return {
    fetchPosts: async () => ({ candidates, total: candidates.length, truncated: false }),
    fetchPostsByIds: refus,
    fetchFeedPosts: refus,
  };
}

async function apercu(datesGmt: string[]) {
  const req = new Request("http://x/api/builder/wp/feed-preview", {
    method: "POST",
    body: JSON.stringify({ sourceId: SOURCE, categories: [7101, 12087], count: 3, minCount: 1, orderby: "date" }),
  });
  const res = await feedPreview(req, garde(), site(datesGmt));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("feed-preview — `stale`", () => {
  test("⛔ le plus récent a 30 h ⇒ la route rend l'avertissement, avec l'âge et la date", async () => {
    const recent = ilYa(30 * HOUR);
    const { status, json } = await apercu([recent, ilYa(40 * HOUR)]);
    expect(status).toBe(200);
    expect((json.items as unknown[]).length).toBe(2);
    const stale = json.stale as { message: string; ageHours: number; newestPublishedAt: string };
    expect(stale).not.toBeNull();
    expect(stale).not.toBeUndefined();
    expect(stale.ageHours).toBe(30);
    expect(stale.message).toBe(
      "The newest article is 30 h old — this feed may be filtered on categories the site no longer uses.",
    );
    expect(Date.parse(stale.newestPublishedAt)).toBe(Date.parse(`${recent}Z`));
  });

  test("TÉMOIN — le plus récent a 1 h ⇒ `stale` vaut null (présent, pas absent)", async () => {
    const { status, json } = await apercu([ilYa(1 * HOUR), ilYa(40 * HOUR)]);
    expect(status).toBe(200);
    expect((json.items as unknown[]).length).toBe(2);
    expect("stale" in json).toBe(true);
    expect(json.stale).toBeNull();
  });
});
