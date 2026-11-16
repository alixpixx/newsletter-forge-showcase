/**
 * PATCH /api/brands/[id] — les réglages d'une marque, mesurés sans session ni base.
 *
 * ⛔ CE QUE CE BANC GARDE D'ABORD : un `member` ne touche à rien. Le proxy réserve `/settings` au
 * super_admin, mais cette route n'est pas sous `/settings` : si la garde du handler disparaissait,
 * n'importe quel membre pourrait renommer une marque ou basculer son régime légal par un appel direct.
 */
import { describe, expect, test } from "bun:test";
import { ecrit, eqsDe, fauxDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ La chaîne d'import tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import sans AUTH_SECRET.
process.env.AUTH_SECRET = "secret-de-test-uniquement-22092026";
const { modifierMarque } = await import("./handler");

const ASSET = "33333333-3333-4333-8333-333333333333";
const ED = "44444444-4444-4444-8444-444444444444";
const AUTRE_ED = "55555555-5555-4555-8555-555555555555";
const r = (data: unknown, error: unknown = null): ReponseDb => ({ data, error });

function garde(role: "super_admin" | "member", ...reponses: ReponseDb[]) {
  const f = fauxDb(...reponses);
  return {
    ...f,
    garde: async () => ({
      ok: true as const,
      ctx: {
        db: f.db as never,
        asset: { id: ASSET, name: "Quartz Tips" } as never,
        user: { id: "u1", email: "a@x.invalid", isSuperAdmin: role === "super_admin", seesAll: role === "super_admin" } as never,
      },
    }),
  };
}

const patch = (body: unknown) =>
  new Request("http://x/api/brands", { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) });
const lire = async (res: Response) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> });

/** Les réponses d'un enregistrement réussi d'UNE édition, relecture du pied comprise. */
const succesEdition = (edition: Record<string, unknown> = {}) => [
  r({ id: ASSET, name: "Quartz Tips" }), // la marque
  r([{ id: ED }]), // ses éditions
  r([{ id: ED }]), // l'update, avec son `.select`
  r([{ id: ED, market: "BR", language: "pt-BR", compliance_regime: "lgpd", is_primary: true, legal_footer: {}, ...edition }]),
];

describe("qui peut modifier une marque", () => {
  /** ⛔ MUTATION QUI DOIT LE TUER : retirer le contrôle `isSuperAdmin` du handler. */
  test("⛔ un member reçoit 403, et RIEN n'est lu ni écrit", async () => {
    const g = garde("member", ...succesEdition());
    const { status } = await lire(await modifierMarque(patch({ name: "Pirate" }), ASSET, g.garde));
    expect(status).toBe(403);
    expect(g.appels).toHaveLength(0);
  });

  test("un refus de session est rendu tel quel", async () => {
    const res = await modifierMarque(patch({ name: "X" }), ASSET, async () => ({
      ok: false as const,
      res: Response.json({ error: "unauthenticated" }, { status: 401 }) as never,
    }));
    expect(res.status).toBe(401);
  });

  test("un super_admin renomme la marque — l'écriture vise CETTE marque", async () => {
    const g = garde("super_admin", r({ id: ASSET, name: "Quartz Tips" }), r(null), r([]));
    const { status, json } = await lire(await modifierMarque(patch({ name: "  Super Dicas  " }), ASSET, g.garde));
    expect(status).toBe(200);
    const maj = g.appels.find((a) => a.table === "asset" && ecrit(a))!;
    expect(maj.methodes.find((m) => m.m === "update")!.args[0]).toEqual({ name: "Super Dicas" });
    expect(eqsDe(maj)).toEqual([["id", ASSET]]);
    expect(json.ok).toBe(true);
  });
});

describe("limitée à la marque du chemin", () => {
  test("⛔ une édition d'une AUTRE marque est refusée avant toute écriture", async () => {
    const g = garde("super_admin", r({ id: ASSET, name: "Quartz Tips" }), r([{ id: ED }]));
    const { status } = await lire(
      await modifierMarque(patch({ editions: [{ id: AUTRE_ED, from_name: "Pirate" }] }), ASSET, g.garde),
    );
    expect(status).toBe(404);
    expect(g.appels.filter(ecrit)).toHaveLength(0);
  });

  test("chaque écriture d'édition porte aussi `asset_id` dans son filtre", async () => {
    const g = garde("super_admin", ...succesEdition());
    const { status } = await lire(
      await modifierMarque(patch({ editions: [{ id: ED, from_name: "Redação", reply_to: "redacao@quartz-tips.example" }] }), ASSET, g.garde),
    );
    expect(status).toBe(200);
    const maj = g.appels.find((a) => a.table === "asset_edition" && ecrit(a))!;
    expect(maj.methodes.find((m) => m.m === "update")!.args[0]).toEqual({ from_name: "Redação", reply_to: "redacao@quartz-tips.example" });
    expect(eqsDe(maj)).toEqual([["id", ED], ["asset_id", ASSET]]);
  });

  test("marque inconnue ⇒ 404 ; identifiant non-uuid ⇒ 404 sans lecture", async () => {
    const g = garde("super_admin", r(null));
    expect((await modifierMarque(patch({ name: "X" }), ASSET, g.garde)).status).toBe(404);
    const g2 = garde("super_admin");
    expect((await modifierMarque(patch({ name: "X" }), "pas-un-uuid", g2.garde)).status).toBe(404);
    expect(g2.appels).toHaveLength(0);
  });
});

describe("validation — rien n'est écrit sur une saisie refusée", () => {
  const refuse = async (body: unknown, attendu = 422) => {
    const g = garde("super_admin", ...succesEdition());
    const { status } = await lire(await modifierMarque(patch(body), ASSET, g.garde));
    expect(status).toBe(attendu);
    expect(g.appels.filter(ecrit)).toHaveLength(0);
  };

  test("⛔ un Reply-To qui n'est pas UNE adresse est refusé", async () => {
    for (const mauvais of ["pas-une-adresse", "a@b.co, c@d.co", "Nom <a@b.co>", "a@b", "x@y.co\r\nBcc: z@evil.invalid"]) {
      await refuse({ editions: [{ id: ED, reply_to: mauvais }] });
    }
  });

  test("⛔ un nom de marque ou d'expéditeur qui sortirait de ses guillemets est refusé", async () => {
    await refuse({ name: 'Marque" <x@evil.invalid>' });
    await refuse({ name: "Marque\r\nBcc: x@evil.invalid" });
    await refuse({ name: "   " });
    await refuse({ name: "a".repeat(81) });
    await refuse({ editions: [{ id: ED, from_name: 'A"B' }] });
    await refuse({ editions: [{ id: ED, from_name: "a".repeat(65) }] });
  });

  test("langue hors des six, marché mal formé, régime inconnu : refusés", async () => {
    await refuse({ editions: [{ id: ED, language: "sv" }] });
    await refuse({ editions: [{ id: ED, market: "Brazil" }], confirmComplianceChange: true });
    await refuse({ editions: [{ id: ED, compliance_regime: "ccpa" }], confirmComplianceChange: true });
  });

  test("⛔ changer le régime ou le marché SANS confirmation ⇒ 409, rien d'écrit", async () => {
    await refuse({ editions: [{ id: ED, compliance_regime: "canspam" }] }, 409);
    await refuse({ editions: [{ id: ED, market: "US" }] }, 409);
  });

  test("corps vide ou sans changement ⇒ 400", async () => {
    await refuse("pas du json", 400);
    await refuse({}, 400);
  });
});

describe("ce que la réponse dit après l'écriture", () => {
  test("un régime confirmé est écrit, et ce qui MANQUE désormais revient (CAN-SPAM sans adresse)", async () => {
    const g = garde(
      "super_admin",
      ...succesEdition({ compliance_regime: "canspam", market: "US", legal_footer: { privacy_url: "https://x.invalid/p" } }),
    );
    const { status, json } = await lire(
      await modifierMarque(
        patch({ editions: [{ id: ED, compliance_regime: "canspam", market: "US" }], confirmComplianceChange: true }),
        ASSET,
        g.garde,
      ),
    );
    expect(status).toBe(200);
    expect(json.missing).toEqual([{ id: ED, missing: ["physical_address"] }]);
  });

  test("un Reply-To vidé est écrit `null` (retour au comportement d'avant)", async () => {
    const g = garde("super_admin", ...succesEdition());
    await modifierMarque(patch({ editions: [{ id: ED, reply_to: "  ", from_name: "" }] }), ASSET, g.garde);
    const maj = g.appels.find((a) => a.table === "asset_edition" && ecrit(a))!;
    expect(maj.methodes.find((m) => m.m === "update")!.args[0]).toEqual({ from_name: null, reply_to: null });
  });

  test("⛔ 0078 absente : un 409 qui NOMME la migration, pas un 500 opaque", async () => {
    const g = garde(
      "super_admin",
      r({ id: ASSET, name: "Quartz Tips" }),
      r([{ id: ED }]),
      r(null, { code: "PGRST204", message: "Could not find the 'from_name' column of 'asset_edition' in the schema cache" }),
    );
    const { status, json } = await lire(await modifierMarque(patch({ editions: [{ id: ED, from_name: "X" }] }), ASSET, g.garde));
    expect(status).toBe(409);
    expect(String(json.error)).toContain("0078");
  });

  test("⛔ sans `trackingMode` demandé, `tracking_mode` n'est PAS lu (le reste marche sans 0092)", async () => {
    const g = garde("super_admin", r({ id: ASSET, name: "Quartz Tips" }), r(null), r([]));
    await modifierMarque(patch({ name: "Super Dicas" }), ASSET, g.garde);
    const lecture = g.appels.find((a) => a.table === "asset" && !ecrit(a))!;
    expect(lecture.methodes.find((m) => m.m === "select")!.args[0]).toBe("id, name");
  });

  test("marché et langue déjà pris par une autre édition ⇒ 409 lisible", async () => {
    const g = garde(
      "super_admin",
      r({ id: ASSET, name: "Quartz Tips" }),
      r([{ id: ED }]),
      r(null, { code: "23505", message: "duplicate key value violates unique constraint" }),
    );
    const { status } = await lire(await modifierMarque(patch({ editions: [{ id: ED, language: "en" }] }), ASSET, g.garde));
    expect(status).toBe(409);
  });
});

describe("suivi des ouvertures et des clics (0092, `trackingMode`)", () => {
  /** La marque lue avec son mode courant. */
  const marque = (mode: string) => r({ id: ASSET, name: "Quartz Tips", tracking_mode: mode });
  const insertAudit = (g: ReturnType<typeof garde>) => g.appels.find((a) => a.table === "audit_log");

  /** ⛔ MUTATION QUI DOIT LE TUER : retirer l'insertion dans `audit_log`, ou en changer l'action. */
  test("all → consent : écrit sur CETTE marque, et TRACÉ avec from/to", async () => {
    const g = garde("super_admin", marque("all"), r([{ id: ASSET }]), r(null), r([]));
    const { status, json } = await lire(await modifierMarque(patch({ trackingMode: "consent" }), ASSET, g.garde));
    expect(status).toBe(200);
    const maj = g.appels.find((a) => a.table === "asset" && ecrit(a))!;
    expect(maj.methodes.find((m) => m.m === "update")!.args[0]).toEqual({ tracking_mode: "consent" });
    expect(eqsDe(maj)).toEqual([["id", ASSET]]);
    expect(insertAudit(g)!.methodes.find((m) => m.m === "insert")!.args[0]).toEqual({
      actor: "admin:a@x.invalid",
      action: "brand.tracking_mode",
      target_type: "asset",
      target_id: ASSET,
      asset_id: ASSET,
      meta: { from: "all", to: "consent" },
    });
    expect(json.trackingMode).toEqual({ from: "all", to: "consent", changed: true, audited: true });
  });

  /** ⛔ MUTATION QUI DOIT LE TUER : ne plus valider `trackingMode` avant la première lecture/écriture. */
  test("⛔ une valeur hors de all/consent ⇒ 400, rien lu ni écrit", async () => {
    for (const mauvais of ["none", "ALL", "", true, null, 1, ["all"]]) {
      const g = garde("super_admin", marque("all"), r([{ id: ASSET }]), r(null), r([]));
      const { status } = await lire(await modifierMarque(patch({ trackingMode: mauvais }), ASSET, g.garde));
      expect(status).toBe(400);
      expect(g.appels).toHaveLength(0);
    }
  });

  test("⛔ un member reçoit 403, et RIEN n'est lu ni écrit", async () => {
    const g = garde("member", marque("consent"), r([{ id: ASSET }]), r(null), r([]));
    const { status } = await lire(await modifierMarque(patch({ trackingMode: "all" }), ASSET, g.garde));
    expect(status).toBe(403);
    expect(g.appels).toHaveLength(0);
  });

  test("⛔ 0092 absente : 503 qui NOMME la migration, et rien d'écrit — le nom non plus", async () => {
    const g = garde("super_admin", r(null, { code: "42703", message: "column asset.tracking_mode does not exist" }));
    const { status, json } = await lire(await modifierMarque(patch({ name: "Autre", trackingMode: "consent" }), ASSET, g.garde));
    expect(status).toBe(503);
    expect(String(json.error)).toContain("0092");
    expect(json.kind).toBe("migration_0092");
    expect(g.appels.filter(ecrit)).toHaveLength(0);

    // Cache de schéma périmé : la lecture passe, l'écriture bute — même réponse lisible.
    const g2 = garde(
      "super_admin",
      marque("all"),
      r(null, { code: "PGRST204", message: "Could not find the 'tracking_mode' column of 'asset' in the schema cache" }),
    );
    const deux = await lire(await modifierMarque(patch({ trackingMode: "consent" }), ASSET, g2.garde));
    expect(deux.status).toBe(503);
    expect(String(deux.json.error)).toContain("0092");
    expect(insertAudit(g2)).toBeUndefined();
  });

  test("une autre panne de lecture n'est PAS prise pour 0092 absente", async () => {
    const g = garde("super_admin", r(null, { code: "57014", message: "canceling statement due to statement timeout" }));
    const { status, json } = await lire(await modifierMarque(patch({ trackingMode: "consent" }), ASSET, g.garde));
    expect(status).toBe(503);
    expect(String(json.error)).not.toContain("0092");
  });

  /** ⛔ MUTATION QUI DOIT LE TUER : écrire même quand le mode demandé est déjà le mode courant. */
  test("mode inchangé ⇒ ni écriture ni trace, `changed: false`", async () => {
    const g = garde("super_admin", marque("consent"), r([]));
    const { status, json } = await lire(await modifierMarque(patch({ trackingMode: "consent" }), ASSET, g.garde));
    expect(status).toBe(200);
    expect(g.appels.filter(ecrit)).toHaveLength(0);
    expect(insertAudit(g)).toBeUndefined();
    expect(json.trackingMode).toEqual({ from: "consent", to: "consent", changed: false });
  });

  test("⛔ trace ratée : le changement RESTE, la réponse dit `audited: false`", async () => {
    const g = garde(
      "super_admin",
      marque("consent"),
      r([{ id: ASSET }]),
      r(null, { message: "permission denied for table audit_log" }),
      r([]),
    );
    const { status, json } = await lire(await modifierMarque(patch({ trackingMode: "all" }), ASSET, g.garde));
    expect(status).toBe(200);
    const maj = g.appels.find((a) => a.table === "asset" && ecrit(a))!;
    expect(maj.methodes.find((m) => m.m === "update")!.args[0]).toEqual({ tracking_mode: "all" });
    // Aucune écriture de rattrapage : le geste n'est pas défait.
    expect(g.appels.filter((a) => a.table === "asset" && ecrit(a))).toHaveLength(1);
    expect(json.trackingMode).toEqual({ from: "consent", to: "all", changed: true, audited: false });
  });

  test("le mode s'enregistre avec un renommage dans le même appel", async () => {
    const g = garde("super_admin", marque("all"), r(null), r([{ id: ASSET }]), r(null), r([]));
    const { status, json } = await lire(
      await modifierMarque(patch({ name: "Super Dicas", trackingMode: "consent" }), ASSET, g.garde),
    );
    expect(status).toBe(200);
    const ecritures = g.appels.filter((a) => a.table === "asset" && ecrit(a)).map((a) => a.methodes.find((m) => m.m === "update")!.args[0]);
    expect(ecritures).toEqual([{ name: "Super Dicas" }, { tracking_mode: "consent" }]);
    expect((json.trackingMode as { changed: boolean }).changed).toBe(true);
  });
});
