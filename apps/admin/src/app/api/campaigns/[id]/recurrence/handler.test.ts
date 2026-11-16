/**
 * PATCH /api/campaigns/[id]/recurrence — la route mesurée de bout en bout, sans session ni base.
 *
 * La session est injectée (`requireContext`), le client Supabase est le double `fauxDb` : ce sont les
 * VRAIES fonctions `findCampaign`/`updateCampaign` qui tournent, et le banc lit l'écriture partie.
 * Ce qui compte : une valeur refusée n'écrit RIEN, un départ absent ne touche pas la colonne, et
 * enregistrer une cadence ne l'arme jamais.
 */
import { describe, expect, test } from "bun:test";
import { eqsDe, fauxDb, type AppelDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `campaigns.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import si AUTH_SECRET manque.
process.env.AUTH_SECRET = "secret-de-test-uniquement-16092026";
const { patchRecurrence } = await import("./handler");

const CAMP = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const TODAY = "2026-09-16";

const campagne = (extra: Record<string, unknown> = {}): ReponseDb => ({
  data: { id: CAMP, name: "Série", status: "draft", subject: "S", locked_at: null, ...extra },
  error: null,
});
const ok: ReponseDb = { data: null, error: null };

async function appeler(body: unknown, ...reponses: ReponseDb[]) {
  const { db, appels, restantes } = fauxDb(...reponses);
  const res = await patchRecurrence(
    new Request("http://x/api", { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ id: CAMP }) },
    {
      requireContext: async () => ({
        ok: true as const,
        ctx: { db: db as never, asset: { id: ASSET, name: "PF" } as never, user: { email: "a@staff.invalid" } as never },
      }),
      today: () => TODAY,
    },
  );
  return { res, json: (await res.json()) as Record<string, unknown>, appels, restantes };
}

const ecriture = (appels: AppelDb[]) => {
  const u = appels.find((a) => a.methodes.some((m) => m.m === "update"));
  return u ? (u.methodes.find((m) => m.m === "update")!.args[0] as Record<string, unknown>) : null;
};

const valide = { days: [2, 4], time: "09:30", timezone: "America/Santiago" };

describe("garde d'accès", () => {
  test("un refus de session est rendu tel quel, sans lecture", async () => {
    const res = await patchRecurrence(
      new Request("http://x/api", { method: "PATCH", body: "{}" }),
      { params: Promise.resolve({ id: CAMP }) },
      {
        requireContext: async () => ({ ok: false as const, res: Response.json({ error: "unauthenticated" }, { status: 401 }) as never }),
        today: () => TODAY,
      },
    );
    expect(res.status).toBe(401);
  });

  test("campagne d'une autre marque ⇒ 404, lecture scopée sur la marque", async () => {
    const { res, appels } = await appeler(valide, { data: null, error: null });
    expect(res.status).toBe(404);
    expect(eqsDe(appels[0]!)).toEqual([
      ["id", CAMP],
      ["asset_id", ASSET],
    ]);
    expect(ecriture(appels)).toBeNull();
  });
});

describe("numéro de première édition", () => {
  for (const v of [0, -1, 1.5, 1_000_001, "abc", "", null]) {
    test(`${JSON.stringify(v)} ⇒ 400, rien n'est écrit`, async () => {
      const { res, json, appels } = await appeler({ ...valide, editionStart: v }, campagne());
      expect(res.status).toBe(400);
      expect(String(json.error)).toContain("first edition number");
      expect(ecriture(appels)).toBeNull();
    });
  }

  test("absent ⇒ la colonne n'est pas touchée", async () => {
    const { res, json, appels } = await appeler(valide, campagne(), ok);
    expect(res.status).toBe(200);
    expect(ecriture(appels)).not.toHaveProperty("edition_start");
    expect(json.editionStart).toBeNull();
  });

  test("« 12 » ⇒ écrit 12 et le rend", async () => {
    const { json, appels } = await appeler({ ...valide, editionStart: "12" }, campagne(), ok);
    expect(ecriture(appels)).toMatchObject({ edition_start: 12 });
    expect(json.editionStart).toBe(12);
  });

  test("colonne absente en base ⇒ 503 qui nomme la migration 0067", async () => {
    const { res, json } = await appeler(
      { ...valide, editionStart: 3 },
      campagne(),
      { data: null, error: { message: 'column "edition_start" of relation "campaign" does not exist' } },
    );
    expect(res.status).toBe(503);
    expect(json.migrationMissing).toBe(true);
    expect(String(json.error)).toContain("0067");
  });
});

describe("enregistrer n'est pas armer", () => {
  test("l'écriture ne porte jamais recurrence_active, la réponse dit active:false", async () => {
    const { json, appels } = await appeler(valide, campagne(), ok);
    const e = ecriture(appels)!;
    expect(e).not.toHaveProperty("recurrence_active");
    expect(e).toMatchObject({ recurrence_days: [2, 4], recurrence_time: "09:30", recurrence_anchor: TODAY });
    expect(json.active).toBe(false);
  });

  test("écriture scopée sur la campagne ET la marque", async () => {
    const { appels } = await appeler(valide, campagne(), ok);
    const u = appels.find((a) => a.methodes.some((m) => m.m === "update"))!;
    expect(eqsDe(u)).toEqual([
      ["id", CAMP],
      ["asset_id", ASSET],
    ]);
  });

  test("retirer la cadence ⇒ désarme", async () => {
    const { json, appels } = await appeler({ clear: true }, campagne(), ok);
    expect(ecriture(appels)).toMatchObject({ recurrence_days: null, recurrence_active: false });
    expect(json.recurring).toBe(false);
  });

  /*
   * RETIRER LA CADENCE ANNULE AUSSI LES ÉDITIONS PRÉVUES — décision d'Alix, 18/09/2026.
   * ⚠️ Le test ci-dessus passait AVANT ET APRÈS le changement : il ne regardait que la première
   * écriture. Un banc qui ne compte pas les appels ne voit pas qu'un second est apparu — ou a
   * disparu. C'est pour ça que ceux qui suivent comptent, ordonnent et lisent les filtres.
   */
  const RETRAIT = [campagne(), ok, { data: [{ id: "o1" }, { id: "o2" }], error: null }];
  const annulation = (appels: AppelDb[]) => appels.find((a) => a.table === "campaign_occurrence");

  test("⛔ retirer la cadence annule les éditions déjà planifiées", async () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer l'appel à `cancelUpcomingOccurrences` de la branche
    // `clear`. Le geste le plus définitif redeviendrait le moins définitif, et les éditions déjà
    // gelées partiraient après que l'écran a annoncé que la campagne « ne s'envoie plus qu'une fois ».
    const { json, appels } = await appeler({ clear: true }, ...RETRAIT);
    const a = annulation(appels);
    expect(a).toBeDefined();
    expect(a!.methodes.find((m) => m.m === "update")!.args[0]).toMatchObject({ status: "cancelled" });
    expect(json.cancelled).toBe(2);
  });

  test("⛔ l'annulation est scopée marque + campagne, et ne touche QUE le futur arrêtable", async () => {
    // MUTATION QUI DOIT TUER CE TEST : laisser tomber le `.eq("asset_id")` (on annulerait les
    // éditions d'une AUTRE marque), le `.gte("scheduled_at")` (on réécrirait une ligne que le
    // worker est peut-être en train de lire) ou le `.in("status", …)` (on « annulerait » du `sent`).
    const { appels } = await appeler({ clear: true }, ...RETRAIT);
    const a = annulation(appels)!;
    expect(eqsDe(a)).toEqual([["campaign_id", CAMP], ["asset_id", ASSET]]);
    expect(a.methodes.find((m) => m.m === "in")!.args).toEqual(["status", ["planned", "frozen", "held"]]);
    expect(a.methodes.some((m) => m.m === "gte" && m.args[0] === "scheduled_at")).toBe(true);
  });

  test("⛔ ORDRE — on désarme AVANT d'annuler, jamais l'inverse", async () => {
    // Dans l'autre ordre, le matérialiseur recréerait aussitôt ce qu'on vient d'annuler : le geste
    // produirait l'inverse de ce qu'il annonce.
    const { appels } = await appeler({ clear: true }, ...RETRAIT);
    expect(appels.findIndex((a) => a.table === "campaign")).toBeLessThan(
      appels.findIndex((a) => a.table === "campaign_occurrence"),
    );
  });

  test("⛔ annulation en échec ⇒ 207, et la réponse ne prétend PAS que rien n'a marché", async () => {
    // MUTATION QUI DOIT TUER CE TEST : rendre 500. La cadence EST retirée à ce stade ; annoncer un
    // échec ferait recommencer un geste déjà à moitié fait, sur un écran qui dit le contraire.
    const { res, json } = await appeler(
      { clear: true }, campagne(), ok, { data: null, error: { message: "boom" } },
    );
    expect(res.status).toBe(207);
    expect(json).toMatchObject({ ok: true, recurring: false, cancelled: 0, cancelError: "boom" });
  });

  test("⛔ le témoin : ENREGISTRER une cadence n'annule rien", async () => {
    // Sans lui, « annuler à chaque passage dans cette route » passerait tout ce qui précède — et
    // sauvegarder une cadence détruirait les éditions prévues.
    const { appels } = await appeler(valide, campagne(), ok, ok);
    expect(annulation(appels)).toBeUndefined();
  });
});

describe("refus sans écriture", () => {
  test("campagne verrouillée ⇒ 409", async () => {
    const { res, appels } = await appeler(valide, campagne({ locked_at: "2026-09-10T10:00:00Z" }));
    expect(res.status).toBe(409);
    expect(ecriture(appels)).toBeNull();
  });

  const refus: [string, unknown][] = [
    ["aucun jour", { ...valide, days: [0, 8] }],
    ["heure invalide", { ...valide, time: "24:00" }],
    ["fuseau vide", { ...valide, timezone: " " }],
    ["fuseau inconnu", { ...valide, timezone: "Mars/Olympus" }],
    ["fin aujourd'hui", { ...valide, until: TODAY }],
  ];
  for (const [nom, body] of refus) {
    test(`${nom} ⇒ 400`, async () => {
      const { res, appels } = await appeler(body, campagne());
      expect(res.status).toBe(400);
      expect(ecriture(appels)).toBeNull();
    });
  }

  test("corps illisible ⇒ 400", async () => {
    const { res } = await appeler("{pas du json", campagne());
    expect(res.status).toBe(400);
  });

  test("fin demain ⇒ acceptée", async () => {
    const { res, appels } = await appeler({ ...valide, until: "2026-09-17" }, campagne(), ok);
    expect(res.status).toBe(200);
    expect(ecriture(appels)).toMatchObject({ recurrence_until: "2026-09-17" });
  });
});
