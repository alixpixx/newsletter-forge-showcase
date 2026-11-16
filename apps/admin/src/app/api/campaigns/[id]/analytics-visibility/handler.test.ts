/**
 * MASQUER / RÉAFFICHER une campagne dans les analytics (0093) — mesuré de bout en bout, sans session
 * ni base. Même montage que `archive/handler.test.ts` : session injectée, client Supabase = `fauxDb`
 * (réponses consommées DANS L'ORDRE), et c'est la VRAIE `findCampaign` qui tourne.
 *
 * Ordre des requêtes d'un geste : 1. `findCampaign` · 2. lecture de `analytics_hidden_at` ·
 * 3. l'écriture (relue) · 4. la trace `audit_log`.
 */
import { describe, expect, test } from "bun:test";
import { eqsDe, fauxDb, type AppelDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `campaigns.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import si AUTH_SECRET manque.
process.env.AUTH_SECRET = "secret-de-test-uniquement-07102026";
const { postVisibilite, migrationMasquage } = await import("./handler");

const CAMP = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const MAINTENANT = new Date("2026-10-07T12:00:00Z");
const MASQUEE_LE = "2026-10-01T08:00:00+00:00";

const campagne: ReponseDb = {
  data: { id: CAMP, name: "Resumo da rodada", status: "sent", archived_at: null, archived_resume: null },
  error: null,
};
const etat = (hiddenAt: string | null): ReponseDb => ({ data: { analytics_hidden_at: hiddenAt }, error: null });
const ok: ReponseDb = { data: null, error: null };
const touche: ReponseDb = { data: [{ id: CAMP }], error: null };
const rien: ReponseDb = { data: [], error: null };

const ctx = (db: unknown) => ({
  ok: true as const,
  ctx: { db: db as never, asset: { id: ASSET, name: "PF" } as never, user: { email: "editor@staff.invalid" } as never },
});

async function basculer(corps: unknown, ...reponses: ReponseDb[]) {
  const { db, appels, restantes } = fauxDb(...reponses);
  const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" } };
  if (corps !== undefined) init.body = typeof corps === "string" ? corps : JSON.stringify(corps);
  const res = await postVisibilite(new Request("http://x/api", init), { params: Promise.resolve({ id: CAMP }) }, {
    requireContext: async () => ctx(db),
    maintenant: () => MAINTENANT,
  });
  return { res, json: (await res.json()) as Record<string, unknown>, appels, restantes };
}

const ecritures = (appels: AppelDb[]) =>
  appels.filter((a) => a.methodes.some((m) => m.m === "update" || m.m === "insert"));
const ecritureCampagne = (appels: AppelDb[]) =>
  appels.find((a) => a.table === "campaign" && a.methodes.some((m) => m.m === "update")) ?? null;
const corpsDe = (a: AppelDb, m: "update" | "insert") =>
  a.methodes.find((x) => x.m === m)!.args[0] as Record<string, unknown>;
const audit = (appels: AppelDb[]) => {
  const a = appels.find((x) => x.table === "audit_log");
  return a ? corpsDe(a, "insert") : null;
};

describe("masquer", () => {
  // MUTATIONS QUI DOIVENT TUER CE TEST : écrire `null` (ou rien) en masquant ; retirer le filtre de
  // marque de l'écriture ; ne plus écrire la trace.
  test("200 : horodatage écrit, écriture scopée marque et relue, trace `campaign.analytics_hidden`", async () => {
    const { res, json, appels, restantes } = await basculer({ hidden: true }, campagne, etat(null), touche, ok);
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, hidden: true, changed: true, audited: true });
    expect(restantes()).toBe(0);

    const w = ecritureCampagne(appels)!;
    expect(corpsDe(w, "update")).toEqual({ analytics_hidden_at: MAINTENANT.toISOString() });
    expect(eqsDe(w)).toEqual([["id", CAMP], ["asset_id", ASSET]]);
    expect(w.methodes.some((m) => m.m === "select")).toBe(true);

    const a = audit(appels)!;
    expect(a.action).toBe("campaign.analytics_hidden");
    expect(a.target_type).toBe("campaign");
    expect(a.target_id).toBe(CAMP);
    expect(a.asset_id).toBe(ASSET);
    expect(a.actor).toBe("admin:editor@staff.invalid");
    expect(a.meta).toEqual({ hidden_at: MAINTENANT.toISOString(), previous_hidden_at: null, campaign_name: "Resumo da rodada" });
    // ⛔ Aucune adresse dans `meta`.
    expect(JSON.stringify(a.meta)).not.toContain("@");
  });

  test("la lecture de l'état est scopée marque", async () => {
    const { appels } = await basculer({ hidden: true }, campagne, etat(null), touche, ok);
    expect(eqsDe(appels[0]!)).toEqual([["id", CAMP], ["asset_id", ASSET]]);
    expect(appels[1]!.table).toBe("campaign");
    expect(eqsDe(appels[1]!)).toEqual([["id", CAMP], ["asset_id", ASSET]]);
  });

  test("déjà masquée ⇒ 200 `changed: false`, RIEN d'écrit, rien de tracé", async () => {
    const { res, json, appels } = await basculer({ hidden: true }, campagne, etat(MASQUEE_LE));
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, hidden: true, changed: false });
    expect(ecritures(appels)).toEqual([]);
  });
});

describe("réafficher", () => {
  test("200 : colonne remise à null, trace `campaign.analytics_shown` avec l'ancienne date", async () => {
    const { res, json, appels } = await basculer({ hidden: false }, campagne, etat(MASQUEE_LE), touche, ok);
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, hidden: false, changed: true, audited: true });
    const w = ecritureCampagne(appels)!;
    expect(corpsDe(w, "update")).toEqual({ analytics_hidden_at: null });
    expect(eqsDe(w)).toEqual([["id", CAMP], ["asset_id", ASSET]]);
    const a = audit(appels)!;
    expect(a.action).toBe("campaign.analytics_shown");
    expect((a.meta as Record<string, unknown>).previous_hidden_at).toBe(MASQUEE_LE);
    expect((a.meta as Record<string, unknown>).hidden_at).toBeNull();
  });

  test("déjà visible ⇒ 200 `changed: false`, RIEN d'écrit", async () => {
    const { res, json, appels } = await basculer({ hidden: false }, campagne, etat(null));
    expect(res.status).toBe(200);
    expect(json.changed).toBe(false);
    expect(ecritures(appels)).toEqual([]);
  });
});

describe("refus", () => {
  test("campagne d'une autre marque ⇒ 404, lecture scopée, rien d'écrit", async () => {
    const { res, appels } = await basculer({ hidden: true }, { data: null, error: null });
    expect(res.status).toBe(404);
    expect(eqsDe(appels[0]!)).toEqual([["id", CAMP], ["asset_id", ASSET]]);
    expect(ecritures(appels)).toEqual([]);
  });

  // ⛔ `"false"` ou `0` ne doivent jamais se lire « masquer » (ni « réafficher »).
  for (const [nom, corps] of [
    ["sans corps", undefined],
    ["JSON illisible", "{hidden:"],
    ["chaîne", { hidden: "true" }],
    ["nombre", { hidden: 1 }],
    ["champ absent", { hide: true }],
    ["tableau", [true]],
    ["null", null],
  ] as [string, unknown][]) {
    test(`corps invalide (${nom}) ⇒ 400, AUCUNE requête`, async () => {
      const { res, json, appels } = await basculer(corps === null ? "null" : corps);
      expect(res.status).toBe(400);
      expect(String(json.error)).toContain("hidden");
      expect(appels).toEqual([]);
    });
  }

  test("0 ligne touchée par l'écriture ⇒ 404, rien de tracé", async () => {
    const { res, appels } = await basculer({ hidden: true }, campagne, etat(null), rien);
    expect(res.status).toBe(404);
    expect(audit(appels)).toBeNull();
  });

  test("autre erreur d'écriture ⇒ 500 qui la nomme, rien de tracé", async () => {
    const { res, json, appels } = await basculer({ hidden: true }, campagne, etat(null), {
      data: null,
      error: { message: "permission denied for table campaign" },
    });
    expect(res.status).toBe(500);
    expect(String(json.error)).toContain("permission denied");
    expect(audit(appels)).toBeNull();
  });
});

describe("0093 absente ⇒ 503 qui nomme la migration, pas un 500 opaque", () => {
  test("à la lecture de l'état (colonne inconnue)", async () => {
    const { res, json, appels } = await basculer({ hidden: true }, campagne, {
      data: null,
      error: { message: "column campaign.analytics_hidden_at does not exist" },
    });
    expect(res.status).toBe(503);
    expect(String(json.error)).toContain("0093");
    expect(ecritures(appels)).toEqual([]);
  });

  test("à l'écriture (cache de schéma de PostgREST)", async () => {
    const { res, json } = await basculer({ hidden: false }, campagne, etat(MASQUEE_LE), {
      data: null,
      error: { message: "Could not find the 'analytics_hidden_at' column of 'campaign' in the schema cache" },
    });
    expect(res.status).toBe(503);
    expect(String(json.error)).toContain("0093");
  });

  test("le motif exige la colonne ET la cause : une autre absence n'est pas 0093", () => {
    expect(migrationMasquage("column campaign.analytics_hidden_at does not exist")).not.toBeNull();
    expect(migrationMasquage("Could not find the function newsletter.x in the schema cache")).toBeNull();
    expect(migrationMasquage("permission denied for column analytics_hidden_at")).toBeNull();
  });
});

describe("la trace d'audit", () => {
  // ⚠️ Un audit raté ne défait pas le geste : la campagne EST masquée.
  test("audit raté ⇒ 200, `audited: false`, l'écriture est faite", async () => {
    const { res, json, appels } = await basculer({ hidden: true }, campagne, etat(null), touche, {
      data: null,
      error: { message: "rls" },
    });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, hidden: true, changed: true, audited: false });
    expect(corpsDe(ecritureCampagne(appels)!, "update").analytics_hidden_at).toBe(MAINTENANT.toISOString());
  });
});
