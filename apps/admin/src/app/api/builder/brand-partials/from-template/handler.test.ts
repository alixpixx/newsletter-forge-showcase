/**
 * POST /api/builder/brand-partials/from-template — ce que la troisième fente (0080) ne doit PAS ouvrir.
 *
 * ⛔ Un bloc n'a pas de place fixe dans un modèle : « lever » un bloc prendrait la première row (un
 * en-tête) ou celle d'avant le pied légal (un pied) en croyant prendre un contenu. La route refuse
 * `block` en 400 AVANT de lire quoi que ce soit.
 */
import { describe, expect, test } from "bun:test";
import { fauxDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ La chaîne d'imports tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import sans AUTH_SECRET.
process.env.AUTH_SECRET = "secret-de-test-uniquement-23092026";
const { liftFromTemplate } = await import("./handler");

const ASSET = "22222222-2222-4222-8222-222222222222";
const MODELE = "44444444-4444-4444-8444-444444444444";

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

const poster = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });

describe("from-template — pas de bloc", () => {
  test("`slot: block` ⇒ 400 qui dit où créer un bloc, et AUCUNE lecture du modèle", async () => {
    const g = garde();
    const res = await liftFromTemplate(poster({ templateId: MODELE, slot: "block", name: "B" }), g.garde);
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error.includes("Save this row")).toBe(true);
    expect(g.appels).toHaveLength(0);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : laisser passer toute fente chaîne (`isPositionedSlot` retiré).
   * Symptôme : une fente inconnue lit le modèle, puis la base refuse l'écriture en 500.
   */
  test("une fente inconnue ⇒ 400, sans lecture", async () => {
    const g = garde();
    expect((await liftFromTemplate(poster({ templateId: MODELE, slot: "sidebar", name: "S" }), g.garde)).status).toBe(400);
    expect(g.appels).toHaveLength(0);
  });

  test("témoin : `slot: header` va jusqu'au modèle (introuvable ici ⇒ 404)", async () => {
    const g = garde({ data: null, error: null });
    const res = await liftFromTemplate(poster({ templateId: MODELE, slot: "header", name: "H" }), g.garde);
    expect(res.status).toBe(404);
    expect(g.appels.map((a) => a.table)).toEqual(["template"]);
  });
});
