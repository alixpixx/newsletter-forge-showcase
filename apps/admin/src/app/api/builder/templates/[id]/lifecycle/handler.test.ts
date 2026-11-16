/**
 * PUT /api/builder/templates/[id]/lifecycle — la route mesurée sans session ni base.
 *
 * Session et octroi injectés, client Supabase = `fauxDb` : les vraies fonctions de lecture et
 * d'écriture tournent, et le banc lit ce qui serait parti. Ce qui compte : on juge la version
 * PUBLIÉE, un verdict illisible n'écrit rien, un refus d'octroi ne lit rien de plus, et un
 * détachement ne touche jamais la fente d'un autre modèle.
 */
import { describe, expect, test } from "bun:test";
import { ecrit, eqsDe, fauxDb, type AppelDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `templates.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import si AUTH_SECRET manque.
process.env.AUTH_SECRET = "secret-de-test-uniquement-16092026";
const { putLifecycle } = await import("./handler");

const TPL = "33333333-3333-4333-8333-333333333333";
const AUTRE = "44444444-4444-4444-8444-444444444444";
const VER = "55555555-5555-4555-8555-555555555555";
const ASSET = "22222222-2222-4222-8222-222222222222";
const AUTEUR = "auteur@staff.invalid";

const r = (data: unknown, error: unknown = null): ReponseDb => ({ data, error });
const modele = r({ id: TPL, name: "PF", slug: "pf", category: "newsletter", updated_at: "x" });
const ok = r(null);
const publiee = (html: string): ReponseDb[] => [
  r({ current_version_id: VER }),
  r({ html_shell: html, text_shell: "", subject: "Sujet", status: "published" }),
];

async function appeler(body: unknown, reponses: ReponseDb[], octroi = true) {
  const { db, appels, restantes } = fauxDb(...reponses);
  let octroiDemande = false;
  const res = await putLifecycle(
    new Request("http://x/api", { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: TPL }) },
    {
      requireContext: async () => ({
        ok: true as const,
        ctx: { db: db as never, asset: { id: ASSET, name: "PF" } as never, user: { email: AUTEUR } as never },
      }),
      requireTemplateAccess: async () => {
        octroiDemande = true;
        return octroi ? null : (Response.json({ error: "not found" }, { status: 404 }) as never);
      },
    },
  );
  return { res, json: (await res.json()) as Record<string, unknown>, appels, restantes, octroiDemande: () => octroiDemande };
}

const ecritures = (appels: AppelDb[]) => appels.filter(ecrit);
const methode = (a: AppelDb, m: string) => a.methodes.find((x) => x.m === m);

describe("accès", () => {
  test("modèle absent de la marque ⇒ 404, lecture scopée, octroi pas même demandé", async () => {
    const { res, appels, octroiDemande } = await appeler({ kind: "welcome" }, [r(null)]);
    expect(res.status).toBe(404);
    expect(eqsDe(appels[0]!)).toEqual([
      ["id", TPL],
      ["asset_id", ASSET],
    ]);
    expect(octroiDemande()).toBe(false);
  });

  test("octroi refusé ⇒ 404 et plus aucune lecture", async () => {
    const { res, appels } = await appeler({ kind: "welcome" }, [modele], false);
    expect(res.status).toBe(404);
    expect(appels).toHaveLength(1);
  });

  test("kind inconnu ⇒ 400 sans écriture", async () => {
    const { res, appels } = await appeler({ kind: "promo" }, [modele]);
    expect(res.status).toBe(400);
    expect(ecritures(appels)).toEqual([]);
  });
});

describe("attacher : on juge la version PUBLIÉE", () => {
  test("confirmation publiée SANS lien ⇒ 422, rien n'est écrit", async () => {
    const { res, json, appels } = await appeler({ kind: "confirmation" }, [modele, ...publiee("<p>Hola</p>")]);
    expect(res.status).toBe(422);
    expect(String(json.error)).toContain("confirm_url");
    expect(String(json.error)).toContain("Fix it in the builder and publish");
    expect(ecritures(appels)).toEqual([]);
  });

  test("le jeton lu est celui de la version pointée par le modèle", async () => {
    const { appels } = await appeler({ kind: "confirmation" }, [modele, ...publiee("<a href='{{confirm_url}}'>ok</a>"), ok]);
    expect(eqsDe(appels[1]!)).toEqual([["id", TPL]]);
    expect(eqsDe(appels[2]!)).toEqual([
      ["id", VER],
      ["template_id", TPL],
    ]);
  });

  test("confirmation publiée AVEC lien ⇒ rattachée, auteur = la session", async () => {
    const { res, json, appels } = await appeler({ kind: "confirmation" }, [
      modele,
      ...publiee("<a href='{{confirm_url}}'>ok</a>"),
      ok,
    ]);
    expect(res.status).toBe(200);
    expect(json.kind).toBe("confirmation");
    const [w] = ecritures(appels);
    expect(methode(w!, "upsert")!.args[0]).toMatchObject({
      asset_id: ASSET,
      kind: "confirmation",
      template_id: TPL,
      updated_by: AUTEUR,
    });
  });

  test("jamais publié ⇒ rattachable (le worker sert le texte livré)", async () => {
    const { res, appels } = await appeler({ kind: "confirmation" }, [modele, r({ current_version_id: null }), ok]);
    expect(res.status).toBe(200);
    expect(ecritures(appels)).toHaveLength(1);
  });

  const illisibles: [string, ReponseDb[]][] = [
    ["modèle illisible", [r(null, { message: "boom" })]],
    ["version illisible", [r({ current_version_id: VER }), r(null, { message: "boom" })]],
    ["version pointée non publiée", [r({ current_version_id: VER }), r({ html_shell: "{{confirm_url}}", status: "draft" })]],
  ];
  for (const [nom, lecture] of illisibles) {
    test(`${nom} ⇒ 503, rien n'est écrit`, async () => {
      const { res, appels } = await appeler({ kind: "confirmation" }, [modele, ...lecture]);
      expect(res.status).toBe(503);
      expect(ecritures(appels)).toEqual([]);
    });
  }

  test("un `detach` non booléen ne détache pas", async () => {
    const { json, appels } = await appeler({ kind: "welcome", detach: "true" }, [modele, r({ current_version_id: null }), ok]);
    expect(json.kind).toBe("welcome");
    expect(methode(ecritures(appels)[0]!, "upsert")).toBeDefined();
  });

  test("modèle d'une autre marque (23503) ⇒ 409", async () => {
    const { res } = await appeler({ kind: "welcome" }, [modele, r({ current_version_id: null }), r(null, { code: "23503", message: "fk" })]);
    expect(res.status).toBe(409);
  });
});

describe("détacher", () => {
  test("la fente est servie par un AUTRE modèle ⇒ 200 sans suppression", async () => {
    const { res, appels } = await appeler({ kind: "welcome", detach: true }, [modele, r({ template_id: AUTRE })]);
    expect(res.status).toBe(200);
    expect(ecritures(appels)).toEqual([]);
  });

  test("ce modèle sert la fente ⇒ suppression conditionnée à CE modèle", async () => {
    const { appels } = await appeler({ kind: "welcome", detach: true }, [modele, r({ template_id: TPL }), ok]);
    const [d] = ecritures(appels);
    expect(methode(d!, "delete")).toBeDefined();
    expect(eqsDe(d!)).toEqual([
      ["asset_id", ASSET],
      ["kind", "welcome"],
      ["template_id", TPL],
    ]);
  });

  test("porteur illisible ⇒ 503", async () => {
    const { res, appels } = await appeler({ kind: "welcome", detach: true }, [modele, r(null, { message: "boom" })]);
    expect(res.status).toBe(503);
    expect(ecritures(appels)).toEqual([]);
  });

  test("tout détacher : une suppression conditionnée par kind servi", async () => {
    const { json, appels } = await appeler({ kind: null }, [modele, r([{ kind: "welcome" }, { kind: "confirmation" }]), ok, ok]);
    expect(json.kind).toBeNull();
    const suppr = ecritures(appels);
    expect(suppr.map((a) => eqsDe(a))).toEqual([
      [["asset_id", ASSET], ["kind", "confirmation"], ["template_id", TPL]],
      [["asset_id", ASSET], ["kind", "welcome"], ["template_id", TPL]],
    ]);
  });

  test("tout détacher avec un état illisible ⇒ 503, pas un faux « c'est fait »", async () => {
    const { res, appels } = await appeler({ kind: null }, [modele, r(null, { message: "boom" })]);
    expect(res.status).toBe(503);
    expect(ecritures(appels)).toEqual([]);
  });
});
