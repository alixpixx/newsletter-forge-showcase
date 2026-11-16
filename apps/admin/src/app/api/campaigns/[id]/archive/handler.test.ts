/**
 * ARCHIVER / RÉACTIVER une campagne (0077) — mesuré de bout en bout, sans session ni base.
 *
 * Même montage que `arm/handler.test.ts` : la session est injectée, le client Supabase est le double
 * `fauxDb` (réponses consommées DANS L'ORDRE des requêtes), et ce sont les VRAIES `findCampaign`,
 * `updateCampaign`, `cancelUpcomingOccurrences`, `postArm` et `postSchedule` qui tournent. C'est ce
 * dernier point qui compte : la réactivation doit passer par les refus des boutons, pas par une copie.
 */
import { describe, expect, test } from "bun:test";
import { eqsDe, fauxDb, type AppelDb, type ReponseDb } from "@/lib/testing/faux-db";
import type { AudienceEstimate } from "@/lib/data/campaigns";

// ⚠️ `campaigns.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import si AUTH_SECRET manque.
process.env.AUTH_SECRET = "secret-de-test-uniquement-22092026";
const { postArchive, postReactivate, getReactivate, phraseDeReactivation } = await import("./handler");
const { postArm } = await import("../arm/handler");
const { postSchedule } = await import("../schedule/handler");

const CAMP = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const VER = "33333333-3333-4333-8333-333333333333";
const MAINTENANT = new Date("2026-09-22T12:00:00Z");
const ARCHIVEE_LE = "2026-09-20T08:00:00+00:00";
const DATE_FUTURE = "2026-09-30T10:00:00+00:00";
const DATE_PASSEE = "2026-09-21T10:00:00+00:00";

const campagne = (extra: Record<string, unknown> = {}): ReponseDb => ({
  data: {
    id: CAMP,
    name: "Resumo da rodada",
    status: "draft",
    subject: "Edição da semana",
    locked_at: null,
    purpose: "content",
    template_version_id: VER,
    segment_id: null,
    recurrence_days: null,
    recurrence_active: false,
    timezone: "America/Santiago",
    archived_at: null,
    archived_resume: null,
    updated_at: "2026-09-20T08:00:00+00:00",
    ...extra,
  },
  error: null,
});
const serieEnMarche = (extra: Record<string, unknown> = {}) =>
  campagne({ recurrence_days: [2, 4], recurrence_active: true, ...extra });
const programmee = (extra: Record<string, unknown> = {}) =>
  campagne({
    status: "scheduled",
    scheduled_at: DATE_FUTURE,
    locked_at: "2026-09-19T10:00:00+00:00",
    recipients_planned: 1200,
    ...extra,
  });
const archivee = (resume: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  campagne({ archived_at: ARCHIVEE_LE, archived_resume: { version: 1, ...resume }, ...extra });

const ok: ReponseDb = { data: null, error: null };
const lignes = (n: number): ReponseDb => ({ data: Array.from({ length: n }, (_, i) => ({ id: `o${i}` })), error: null });
const touche = lignes(1);
const rien = lignes(0);
const cadence: ReponseDb = {
  data: {
    recurrence_days: [2, 4],
    recurrence_time: "10:00:00",
    recurrence_every_weeks: 1,
    recurrence_anchor: "2026-09-16",
    recurrence_until: null,
    recurrence_active: false,
    timezone: "America/Santiago",
    freeze_lead_minutes: 90,
  },
  error: null,
};
const CALCULEES: ReponseDb = {
  data: [
    { local_date: "2026-09-24", fires_at: "2026-09-24T13:00:00+00:00" },
    { local_date: "2026-09-29", fires_at: "2026-09-29T13:00:00+00:00" },
  ],
  error: null,
};

const ctx = (db: unknown) => ({
  ok: true as const,
  ctx: { db: db as never, asset: { id: ASSET, name: "PF" } as never, user: { email: "editor@staff.invalid" } as never },
});
const audience = (eligible: number | null): AudienceEstimate => ({
  segmentId: null,
  purpose: "content",
  sendable: eligible,
  eligible,
  demoExcluded: 0,
  sunsetExcluded: 0,
  unsupported: [],
  reason: eligible === null ? "segment unreadable" : null,
  population: "subscribers",
  purposeIgnored: false,
});

async function archiver(...reponses: ReponseDb[]) {
  const { db, appels, restantes } = fauxDb(...reponses);
  const res = await postArchive(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ id: CAMP }) }, {
    requireContext: async () => ctx(db),
    maintenant: () => MAINTENANT,
  });
  return { res, json: (await res.json()) as Record<string, unknown>, appels, restantes };
}

async function reactiver(opts: { eligible?: number | null; versionPubliee?: boolean } = {}, ...reponses: ReponseDb[]) {
  const { db, appels, restantes } = fauxDb(...reponses);
  const res = await postReactivate(
    new Request("http://x/api/campaigns/x/reactivate", { method: "POST" }),
    { params: Promise.resolve({ id: CAMP }) },
    {
      requireContext: async () => ctx(db),
      maintenant: () => MAINTENANT,
      versionPubliee: async () => (opts.versionPubliee === false ? null : { id: VER, templateId: "t", version: 3 }),
      estimerAudience: async () => audience(opts.eligible === undefined ? 1150 : opts.eligible),
    },
  );
  return { res, json: (await res.json()) as Record<string, unknown>, appels, restantes };
}

/** Toutes les écritures, dans l'ordre : `[table, corps]`. */
const ecritures = (appels: AppelDb[]): [string, Record<string, unknown>][] =>
  appels.flatMap((a) =>
    a.methodes
      .filter((m) => m.m === "update" || m.m === "insert")
      .map((m) => [a.table, m.args[0] as Record<string, unknown>] as [string, Record<string, unknown>]),
  );
const ecrituresCampagne = (appels: AppelDb[]) => ecritures(appels).filter(([t]) => t === "campaign").map(([, b]) => b);
const audit = (appels: AppelDb[]) => ecritures(appels).find(([t]) => t === "audit_log")?.[1] ?? null;
const aLeFiltre = (a: AppelDb, m: string, col: string, val: unknown) =>
  a.methodes.some((x) => x.m === m && x.args[0] === col && (x.args.length < 3 ? x.args[1] === val : x.args[2] === val));

/* ------------------------------------------------------------------ */

describe("archiver — refus, et RIEN n'est écrit", () => {
  test("campagne d'une autre marque ⇒ 404, lecture scopée", async () => {
    const { res, appels } = await archiver({ data: null, error: null });
    expect(res.status).toBe(404);
    expect(eqsDe(appels[0]!)).toEqual([["id", CAMP], ["asset_id", ASSET]]);
    expect(ecritures(appels)).toEqual([]);
  });

  // MUTATION QUI DOIT TUER CE TEST : retirer le refus `sending`. La file est écrite, les messages
  // partent : ranger la campagne ferait croire qu'on l'a arrêtée.
  test("⛔ en cours d'envoi ⇒ 409, rien d'écrit", async () => {
    const { res, json, appels } = await archiver(campagne({ status: "sending" }));
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("sending right now");
    expect(ecritures(appels)).toEqual([]);
  });

  test("déjà archivée ⇒ 409, rien d'écrit", async () => {
    const { res, appels } = await archiver(archivee({ previous_status: "draft", series_running: false }));
    expect(res.status).toBe(409);
    expect(ecritures(appels)).toEqual([]);
  });
});

describe("⛔ archiver une SÉRIE EN MARCHE : arrêt, PUIS annulation, PUIS rangement", () => {
  // MUTATIONS QUI DOIVENT TUER CE TEST : archiver sans arrêter la série (le planificateur est
  // ceinturé, mais « Reactivate » ne saurait plus qu'elle tournait) ; arrêter sans annuler (une
  // édition gelée partirait série arrêtée) ; annuler AVANT d'arrêter (le planificateur recrée).
  test("trois écritures, dans cet ordre, et le nombre annulé est dit", async () => {
    const { res, json, appels, restantes } = await archiver(serieEnMarche(), ok, lignes(3), touche, ok);
    expect(res.status).toBe(200);
    expect(restantes()).toBe(0);
    const w = ecritures(appels);
    expect(w.map(([t]) => t)).toEqual(["campaign", "campaign_occurrence", "campaign", "audit_log"]);
    expect(w[0]![1].recurrence_active).toBe(false);
    expect(w[0]![1]).not.toHaveProperty("archived_at");
    expect(w[1]![1].status).toBe("cancelled");
    expect(typeof w[2]![1].archived_at).toBe("string");
    expect(w[2]![1].archived_resume).toEqual({
      version: 1,
      previous_status: "draft",
      series_running: true,
      scheduled_at: null,
      editions_cancelled: 3,
    });
    expect(json.cancelled).toBe(3);
  });

  test("l'annulation échoue ⇒ 207 : la série EST arrêtée ET archivée, les deux moitiés dites", async () => {
    const { res, json, appels } = await archiver(serieEnMarche(), ok, { data: null, error: { message: "timeout" } }, touche, ok);
    expect(res.status).toBe(207);
    expect(json.cancelError).toBe("timeout");
    const archive = ecrituresCampagne(appels).find((b) => "archived_at" in b)!;
    // ⛔ `null`, pas 0 : « aucune annulée » et « on ne sait pas » ne se disent pas pareil.
    expect((archive.archived_resume as Record<string, unknown>).editions_cancelled).toBeNull();
  });

  test("l'arrêt échoue ⇒ 500, RIEN n'est annulé ni archivé", async () => {
    const { res, appels } = await archiver(serieEnMarche(), { data: null, error: { message: "boom" } });
    expect(res.status).toBe(500);
    expect(ecritures(appels).map(([t]) => t)).toEqual(["campaign"]);
    expect(ecrituresCampagne(appels).some((b) => "archived_at" in b)).toBe(false);
  });
});

describe("⛔ archiver un ENVOI UNIQUE PROGRAMMÉ : retiré du calendrier, JAMAIS annulé", () => {
  // MUTATION QUI DOIT TUER CE TEST : écrire `status: "cancelled"` (le geste de `/cancel`, TERMINAL)
  // au lieu de la sémantique de `/unschedule`. Archiver promet une pause, pas une fin.
  test("UNE écriture : brouillon + date retirée + archivée ; le verrou survit ; la date est gardée pour revenir", async () => {
    const { res, appels } = await archiver(programmee(), touche, ok);
    expect(res.status).toBe(200);
    const w = ecrituresCampagne(appels);
    expect(w).toHaveLength(1);
    expect(w[0]!.status).toBe("draft");
    expect(w[0]!.scheduled_at).toBeNull();
    expect(w[0]!.recipients_planned).toBeNull();
    expect(w[0]!).not.toHaveProperty("locked_at");
    expect(w[0]!).not.toHaveProperty("rendered_html");
    expect(Object.values(w[0]!)).not.toContain("cancelled");
    expect(w[0]!.archived_resume).toEqual({
      version: 1,
      previous_status: "scheduled",
      series_running: false,
      scheduled_at: DATE_FUTURE,
      editions_cancelled: 0,
    });
    // Aucune occurrence touchée : un envoi unique n'en a pas.
    expect(ecritures(appels).some(([t]) => t === "campaign_occurrence")).toBe(false);
  });

  // ⚠️ Entre la lecture et l'écriture, le fan-out a pu prendre l'envoi (`scheduled` → `sending`).
  test("écriture gardée par le statut lu ET `archived_at is null`, relue ; 0 ligne ⇒ 409", async () => {
    const { res, json, appels } = await archiver(programmee(), rien);
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("changed while it was being archived");
    const ecr = appels.find((a) => a.table === "campaign" && a.methodes.some((m) => m.m === "update"))!;
    expect(eqsDe(ecr)).toContainEqual(["status", "scheduled"]);
    expect(eqsDe(ecr)).toContainEqual(["asset_id", ASSET]);
    expect(aLeFiltre(ecr, "is", "archived_at", null)).toBe(true);
    expect(ecr.methodes.some((m) => m.m === "select")).toBe(true);
    expect(audit(appels)).toBeNull();
  });
});

describe("archiver ce qui ne tourne pas : rangement SEUL", () => {
  const cas: [string, ReponseDb][] = [
    ["brouillon", campagne()],
    ["série arrêtée", campagne({ recurrence_days: [1], recurrence_active: false })],
    ["envoyée", campagne({ status: "sent" })],
    ["annulée", campagne({ status: "cancelled" })],
    ["en pause", campagne({ status: "paused" })],
  ];
  for (const [nom, ligne] of cas) {
    test(`${nom} ⇒ une écriture, statut inchangé, rien d'annulé`, async () => {
      const { res, appels } = await archiver(ligne, touche, ok);
      expect(res.status).toBe(200);
      const w = ecrituresCampagne(appels);
      expect(w).toHaveLength(1);
      expect(w[0]!).not.toHaveProperty("status");
      expect(w[0]!).not.toHaveProperty("recurrence_active");
      expect((w[0]!.archived_resume as Record<string, unknown>).series_running).toBe(false);
      expect(ecritures(appels).some(([t]) => t === "campaign_occurrence")).toBe(false);
    });
  }

  test("0077 absente ⇒ 503 qui nomme la migration, pas un 500 opaque", async () => {
    const { res, json } = await archiver(campagne(), {
      data: null,
      error: { message: "column campaign.archived_at does not exist" },
    });
    expect(res.status).toBe(503);
    expect(String(json.error)).toContain("0077");
  });
});

describe("la trace d'audit", () => {
  // ⛔ AUCUNE donnée d'abonné dans `meta` : l'état de la campagne, des dates, des compteurs.
  test("archiver ⇒ `campaign-archived`, scopée marque, sans aucune adresse dans meta", async () => {
    const { appels } = await archiver(serieEnMarche(), ok, lignes(2), touche, ok);
    const a = audit(appels)!;
    expect(a.action).toBe("campaign-archived");
    expect(a.target_type).toBe("campaign");
    expect(a.target_id).toBe(CAMP);
    expect(a.asset_id).toBe(ASSET);
    expect(a.actor).toBe("admin:editor@staff.invalid");
    expect(JSON.stringify(a.meta)).not.toContain("@");
    expect((a.meta as Record<string, unknown>).editions_cancelled).toBe(2);
  });

  test("un audit raté ne défait pas le geste : 200, `audited: false`", async () => {
    const { res, json } = await archiver(campagne(), touche, { data: null, error: { message: "rls" } });
    expect(res.status).toBe(200);
    expect(json.audited).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("⛔ findCampaign — le garde 404 commun NE FILTRE JAMAIS `archived_at`", () => {
  // MUTATION QUI DOIT TUER CE TEST : ajouter `.is("archived_at", null)` à `findCampaign`. La route
  // qui réactive répondrait « campaign not found » à toute campagne archivée : rangée = perdue.
  test("la lecture de la campagne à réactiver porte l'id et la marque, et AUCUN filtre d'archivage", async () => {
    const { appels } = await reactiver({}, archivee({ previous_status: "draft", series_running: false }), touche, ok);
    const lecture = appels[0]!;
    expect(lecture.table).toBe("campaign");
    expect(eqsDe(lecture)).toEqual([["id", CAMP], ["asset_id", ASSET]]);
    expect(lecture.methodes.some((m) => m.args[0] === "archived_at")).toBe(false);
  });
});

describe("réactiver — refus", () => {
  test("pas archivée ⇒ 409, rien d'écrit", async () => {
    const { res, appels } = await reactiver({}, campagne());
    expect(res.status).toBe(409);
    expect(ecritures(appels)).toEqual([]);
  });

  test("deux clics : la sortie ne touche aucune ligne ⇒ 409, rien redémarré", async () => {
    const { res, appels } = await reactiver(
      {},
      archivee({ previous_status: "draft", series_running: true }, { recurrence_days: [2, 4] }),
      rien,
    );
    expect(res.status).toBe(409);
    const sortie = appels.find((a) => a.table === "campaign" && a.methodes.some((m) => m.m === "update"))!;
    expect(sortie.methodes.some((m) => m.m === "not" && m.args[0] === "archived_at")).toBe(true);
    expect(ecrituresCampagne(appels).some((b) => b.recurrence_active === true)).toBe(false);
  });
});

describe("⛔ réactiver une série : redémarrée PAR `/arm`, avec tous ses refus", () => {
  test("sortie des archives D'ABORD, puis `recurrence_active: true` par postArm, et la 1re édition annoncée", async () => {
    const { res, json, appels, restantes } = await reactiver(
      {},
      archivee({ previous_status: "draft", series_running: true, editions_cancelled: 3 }, { recurrence_days: [2, 4] }),
      touche,
      // ↓ postArm, tel quel
      campagne({ recurrence_days: [2, 4] }),
      cadence,
      ok,
      { data: { recurrence_active: true }, error: null },
      CALCULEES,
      { data: [], error: null },
      // ↓ audit
      ok,
    );
    expect(res.status).toBe(200);
    expect(restantes()).toBe(0);
    const w = ecrituresCampagne(appels);
    expect(w[0]).toMatchObject({ archived_at: null, archived_resume: null });
    expect(w[1]!.recurrence_active).toBe(true);
    expect((json.restored as Record<string, unknown>).running).toBe(true);
    expect(String(json.message)).toContain("First edition on");
    expect(String(json.message)).not.toMatch(/\b(arm|armed|arming|disarm)\b/i);
  });

  // MUTATION QUI DOIT TUER CE TEST : réécrire `recurrence_active: true` ici au lieu d'appeler
  // postArm. Une série sans finalité redémarrerait et chaque édition partirait à zéro destinataire.
  test("⛔ finalité retirée pendant l'archivage ⇒ 207, revenue dans la liste, PAS redémarrée, le refus de /arm dit", async () => {
    const { res, json, appels } = await reactiver(
      {},
      archivee({ previous_status: "draft", series_running: true }, { recurrence_days: [2, 4], purpose: null }),
      touche,
      campagne({ recurrence_days: [2, 4], purpose: null }),
      cadence,
      ok,
    );
    expect(res.status).toBe(207);
    expect(ecrituresCampagne(appels).some((b) => b.recurrence_active === true)).toBe(false);
    const r = json.restored as Record<string, unknown>;
    expect(r.running).toBe(false);
    expect(String(r.refusal)).toContain("no purpose");
    expect(String(json.message)).toContain("did not start again");
    const a = audit(appels)!;
    expect(a.action).toBe("campaign-reactivated");
    expect((a.meta as Record<string, unknown>).restored).toBe("series-stopped");
  });

  test("version dépubliée depuis ⇒ 207, pas redémarrée", async () => {
    const { res, appels } = await reactiver(
      { versionPubliee: false },
      archivee({ previous_status: "draft", series_running: true }, { recurrence_days: [2, 4] }),
      touche,
      campagne({ recurrence_days: [2, 4] }),
      cadence,
      ok,
    );
    expect(res.status).toBe(207);
    expect(ecrituresCampagne(appels).some((b) => b.recurrence_active === true)).toBe(false);
  });
});

describe("réactiver un envoi unique", () => {
  test("date encore à venir ⇒ reprogrammé à CETTE date par postSchedule, compte figé relu", async () => {
    const { res, json, appels } = await reactiver(
      { eligible: 1150 },
      archivee(
        { previous_status: "scheduled", series_running: false, scheduled_at: DATE_FUTURE },
        { locked_at: "2026-09-19T10:00:00+00:00" },
      ),
      touche,
      // ↓ postSchedule, tel quel
      campagne({ locked_at: "2026-09-19T10:00:00+00:00" }),
      ok,
      programmee(),
      ok,
    );
    expect(res.status).toBe(200);
    const w = ecrituresCampagne(appels);
    expect(w[1]).toMatchObject({ status: "scheduled", recipients_planned: 1150 });
    expect(Date.parse(String(w[1]!.scheduled_at))).toBe(Date.parse(DATE_FUTURE));
    expect(json.restored).toMatchObject({ what: "scheduled", recipientsPlanned: 1150 });
  });

  test("audience illisible ⇒ 207, brouillon, le refus de /schedule dit", async () => {
    const { res, json, appels } = await reactiver(
      { eligible: null },
      archivee(
        { previous_status: "scheduled", series_running: false, scheduled_at: DATE_FUTURE },
        { locked_at: "2026-09-19T10:00:00+00:00" },
      ),
      touche,
      campagne({ locked_at: "2026-09-19T10:00:00+00:00" }),
    );
    expect(res.status).toBe(207);
    expect(ecrituresCampagne(appels).some((b) => b.status === "scheduled")).toBe(false);
    expect(String((json.restored as Record<string, unknown>).refusal)).toContain("audience could not be counted");
  });

  // ⛔ UN ENVOI EN RETARD NE PART JAMAIS TOUT SEUL.
  test("date PASSÉE ⇒ brouillon, rien reprogrammé, l'écran demande une nouvelle date", async () => {
    const { res, json, appels } = await reactiver(
      {},
      archivee({ previous_status: "scheduled", series_running: false, scheduled_at: DATE_PASSEE }),
      touche,
      ok,
    );
    expect(res.status).toBe(200);
    expect(ecrituresCampagne(appels)).toHaveLength(1);
    expect(json.restored).toMatchObject({ what: "draft", pastDate: true });
    expect(String(json.message)).toContain("pick a new date");
  });
});

describe("réactiver ce qui ne tournait pas ⇒ retour dans la liste, rien ne part", () => {
  for (const statut of ["draft", "sent", "cancelled", "paused"]) {
    test(statut, async () => {
      const { res, json, appels } = await reactiver(
        {},
        archivee({ previous_status: statut, series_running: false }, { status: statut }),
        touche,
        ok,
      );
      expect(res.status).toBe(200);
      const w = ecrituresCampagne(appels);
      expect(w).toHaveLength(1);
      expect(w[0]).toMatchObject({ archived_at: null, archived_resume: null });
      expect(w[0]).not.toHaveProperty("status");
      expect(json.restored).toEqual({ what: "list", status: statut });
    });
  }
});

describe("GET /reactivate — ce qui repartira, AVANT le clic", () => {
  test("série : première édition (calcul de /arm) et destinataires (calcul de /schedule)", async () => {
    const { db } = fauxDb(
      archivee({ previous_status: "draft", series_running: true }, { recurrence_days: [2, 4] }),
      cadence,
      CALCULEES,
      { data: [], error: null },
    );
    const res = await getReactivate(new Request("http://x"), { params: Promise.resolve({ id: CAMP }) }, {
      requireContext: async () => ctx(db),
      maintenant: () => MAINTENANT,
      versionPubliee: async () => null,
      estimerAudience: async () => audience(830),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.plan).toEqual({ quoi: "serie" });
    expect((json.upcoming as Record<string, unknown>).first).toBe("2026-09-24T13:00:00+00:00");
    expect(json.recipients).toBe(830);
  });
});

describe("⛔ les portes d'envoi refusent une campagne archivée (le raccourci est fermé)", () => {
  test("postArm ⇒ 409 et RIEN d'écrit", async () => {
    const { db, appels } = fauxDb(
      archivee({ previous_status: "draft", series_running: true }, { recurrence_days: [2, 4] }),
      cadence,
    );
    const res = await postArm(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: CAMP }) }, {
      requireContext: async () => ctx(db),
      versionPubliee: async () => ({ id: VER, templateId: "t", version: 3 }),
      maintenant: () => MAINTENANT,
    });
    expect(res.status).toBe(409);
    expect(String(((await res.json()) as Record<string, unknown>).error)).toContain("archived");
    expect(ecritures(appels)).toEqual([]);
  });

  test("postSchedule ⇒ 409 et RIEN d'écrit", async () => {
    const { db, appels } = fauxDb(archivee({ previous_status: "scheduled", scheduled_at: DATE_FUTURE }));
    const res = await postSchedule(
      new Request("http://x", { method: "POST", body: JSON.stringify({ scheduledAt: DATE_FUTURE }) }),
      { params: Promise.resolve({ id: CAMP }) },
      { requireContext: async () => ctx(db), estimerAudience: async () => audience(10), maintenant: () => MAINTENANT.getTime() },
    );
    expect(res.status).toBe(409);
    expect(ecritures(appels)).toEqual([]);
  });
});

describe("phraseDeReactivation — aucune phrase ne parle d'« arm »", () => {
  test("toutes les formes", () => {
    const formes = [
      phraseDeReactivation({ what: "series", running: true, upcoming: { count: 2, first: "2026-09-24T13:00:00Z", last: null, excluded: 0 } }, "UTC"),
      phraseDeReactivation({ what: "series", running: true, upcoming: null }, "UTC"),
      phraseDeReactivation({ what: "series", running: false, refusal: "x" }, "UTC"),
      phraseDeReactivation({ what: "scheduled", scheduledAt: DATE_FUTURE, recipientsPlanned: 3 }, "UTC"),
      phraseDeReactivation({ what: "draft", previousDate: DATE_PASSEE, pastDate: true, refusal: null }, "UTC"),
      phraseDeReactivation({ what: "list", status: "sent" }, "UTC"),
    ];
    for (const f of formes) expect(f).not.toMatch(/\b(arm|armed|arming|disarm)\b/i);
  });
});
