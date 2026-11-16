/**
 * GET /api/builder/legal-footer-preview — mesuré sans session ni base.
 *
 * Ce qui se mesure : la portée (marque de la session, 404 et jamais 403 pour une autre), l'absence de
 * toute donnée d'abonné, les liens personnels neutralisés, et le pied rendu avec les MÊMES entrées que
 * le worker (config choisie > config d'édition ; régime, langue et marché de l'édition).
 */
import { describe, expect, test } from "bun:test";
import { buildFooter, normalizeLocale } from "@nf/email";
import { ecrit, eqsDe, fauxDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `_shared.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import sans AUTH_SECRET.
process.env.AUTH_SECRET = "secret-de-test-uniquement-22092026";
const { legalFooterPreview } = await import("./handler");

const ASSET = "22222222-2222-4222-8222-222222222222";
const AUTRE = "33333333-3333-4333-8333-333333333333";
const ED_ES = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ED_PT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ED_ETRANGERE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TPL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const r = (data: unknown, error: unknown = null): ReponseDb => ({ data, error });
const edition = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  asset_id: ASSET,
  market: "CL",
  language: "es",
  compliance_regime: "gdpr",
  is_primary: false,
  legal_footer: { privacy_url: "https://pf.invalid/privacidad", controller: "PF Media" },
  ...o,
});
const EDITIONS = [edition(ED_PT, { is_primary: true, market: "BR", language: "pt-BR", compliance_regime: "lgpd" }), edition(ED_ES)];

function garde(...reponses: ReponseDb[]) {
  const f = fauxDb(...reponses);
  return {
    ...f,
    garde: async () => ({
      ok: true as const,
      ctx: { db: f.db as never, asset: { id: ASSET, name: "Copper Kettle" } as never, user: { email: "a@staff.invalid" } as never },
    }),
  };
}

const url = (q: string) => new URL(`http://x/api/builder/legal-footer-preview${q}`);
const lire = async (res: Response) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> });

describe("portée", () => {
  test("un refus de session est rendu tel quel", async () => {
    const res = await legalFooterPreview(url(""), async () => ({
      ok: false as const,
      res: Response.json({ error: "unauthenticated" }, { status: 401 }) as never,
    }));
    expect(res.status).toBe(401);
  });

  test("les éditions sont lues SUR LA MARQUE de la session, et rien n'est écrit", async () => {
    const g = garde(r(EDITIONS));
    const { status } = await lire(await legalFooterPreview(url(""), g.garde));
    expect(status).toBe(200);
    expect(g.appels.map((a) => [a.table, eqsDe(a)])).toEqual([["asset_edition", [["asset_id", ASSET]]]]);
    expect(g.appels.some(ecrit)).toBe(false);
  });

  test("l'édition d'une AUTRE marque ⇒ 404, jamais 403 ni son pied", async () => {
    // Même si la base la rendait (requête élargie un jour), la seconde barrière la refuse.
    const g = garde(r([...EDITIONS, edition(ED_ETRANGERE, { asset_id: AUTRE, legal_footer: { controller: "SECRET AUTRE" } })]));
    const { status, json } = await lire(await legalFooterPreview(url(`?edition=${ED_ETRANGERE}`), g.garde));
    expect(status).toBe(404);
    expect(JSON.stringify(json)).not.toContain("SECRET AUTRE");
  });

  test("identifiant malformé ⇒ 404 sans lire la base", async () => {
    const g = garde();
    expect((await legalFooterPreview(url("?edition=1%20or%201=1"), g.garde)).status).toBe(404);
    expect(g.appels).toHaveLength(0);
  });

  test("le pied choisi est lu sur la marque ; celui d'une autre marque ⇒ 404", async () => {
    const g = garde(r(EDITIONS), r(null));
    const { status } = await lire(await legalFooterPreview(url(`?template=${TPL}`), g.garde));
    expect(status).toBe(404);
    expect(g.appels.map((a) => [a.table, eqsDe(a)])).toEqual([
      ["asset_edition", [["asset_id", ASSET]]],
      ["legal_footer_template", [["id", TPL], ["asset_id", ASSET]]],
    ]);
  });

  test("lectures ratées ⇒ 503, jamais un pied vide", async () => {
    expect((await legalFooterPreview(url(""), garde(r(null, { message: "boom" })).garde)).status).toBe(503);
    expect((await legalFooterPreview(url(`?template=${TPL}`), garde(r(EDITIONS), r(null, { message: "boom" })).garde)).status).toBe(503);
  });

  test("marque sans édition ⇒ 404 qui le dit", async () => {
    const { status, json } = await lire(await legalFooterPreview(url(""), garde(r([])).garde));
    expect(status).toBe(404);
    expect(String(json.error)).toContain("no edition");
  });
});

describe("le pied rendu", () => {
  test("aucune donnée d'abonné ; désinscription et préférences pointent sur `#`", async () => {
    const { json } = await lire(await legalFooterPreview(url(""), garde(r(EDITIONS)).garde));
    const html = String(json.html);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    // Désinscription, préférences, confidentialité — dans cet ordre, comme `buildFooter` les pose.
    expect(hrefs).toEqual(["#", "#", "https://pf.invalid/privacidad"]);
    const tout = JSON.stringify(json);
    for (const interdit of ["token=", "@", "subscriber", "unsubscribe?", "preferences?"]) expect(tout).not.toContain(interdit);
    expect(Object.keys(json).sort()).toEqual(["editionId", "editions", "html", "missing", "text"]);
  });

  test("défaut : l'édition de la langue du document, sinon la primaire", async () => {
    const es = await lire(await legalFooterPreview(url("?locale=es"), garde(r(EDITIONS)).garde));
    expect(es.json.editionId).toBe(ED_ES);
    const aucune = await lire(await legalFooterPreview(url("?locale=de"), garde(r(EDITIONS)).garde));
    expect(aucune.json.editionId).toBe(ED_PT);
  });

  test("mêmes entrées que le worker : régime, langue et marché de l'édition", async () => {
    const { json } = await lire(await legalFooterPreview(url(`?edition=${ED_PT}`), garde(r(EDITIONS)).garde));
    const attendu = buildFooter({
      assetName: "Copper Kettle",
      regime: "lgpd",
      cfg: EDITIONS[0]!.legal_footer,
      unsubUrl: "#",
      prefsUrl: "#",
      locale: normalizeLocale("pt-BR"),
      market: "BR",
    });
    expect(json.html).toBe(attendu.html);
    expect(json.text).toBe(attendu.text);
  });

  test("le pied CHOISI remplace la config de l'édition, pas son régime", async () => {
    const choisi = { id: TPL, name: "Legal", config: { controller: "Choisi SA", privacy_url: "https://pf.invalid/p2" }, archived_at: null, updated_by: null, updated_at: "", created_at: "" };
    const { status, json } = await lire(await legalFooterPreview(url(`?edition=${ED_ES}&template=${TPL}`), garde(r(EDITIONS), r(choisi)).garde));
    expect(status).toBe(200);
    expect(String(json.html)).toContain("Choisi SA");
    expect(String(json.html)).not.toContain("PF Media");
    expect(String(json.html)).toContain("https://pf.invalid/p2");
  });

  test("un pied incomplet le dit (`missing`), il ne se tait pas", async () => {
    const g = garde(r([edition(ED_ES, { legal_footer: {} })]));
    const { json } = await lire(await legalFooterPreview(url(""), g.garde));
    expect(json.missing).toEqual(["privacy_url"]);
  });
});
