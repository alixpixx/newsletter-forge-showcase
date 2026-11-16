/**
 * POST /api/campaigns/[id]/arm — « Start series », mesuré de bout en bout, sans session ni base.
 *
 * Premier banc de cette route (22/09/2026). Elle fait partir de vrais e-mails — le worker de
 * production planifie toutes les 10 minutes — et rien ne la mesurait : ni ses refus, ni ce qu'elle
 * écrit, ni ce qu'elle ANNONCE. Ce dernier point était faux : après un arrêt puis une reprise, elle
 * promettait des dates annulées que le matérialiseur ne recrée jamais.
 *
 * Même montage que `recurrence/handler.test.ts` : la session est injectée, le client Supabase est
 * le double `fauxDb`, ce sont les VRAIES `findCampaign`/`updateCampaign` qui tournent.
 */
import { describe, expect, test } from "bun:test";
import { eqsDe, fauxDb, type AppelDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `campaigns.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import si AUTH_SECRET manque.
process.env.AUTH_SECRET = "secret-de-test-uniquement-22092026";
const { postArm, apercuHonnete } = await import("./handler");

const CAMP = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const VER = "33333333-3333-4333-8333-333333333333";
const MAINTENANT = new Date("2026-09-22T12:00:00Z");

const campagne = (extra: Record<string, unknown> = {}): ReponseDb => ({
  data: {
    id: CAMP,
    name: "Série",
    status: "draft",
    subject: "Edição {{edition_number}}",
    locked_at: null,
    purpose: "newsletter",
    template_version_id: VER,
    recurrence_days: [2, 4],
    ...extra,
  },
  error: null,
});
const cadence = (extra: Record<string, unknown> = {}): ReponseDb => ({
  data: {
    recurrence_days: [2, 4],
    recurrence_time: "10:00:00",
    recurrence_every_weeks: 1,
    recurrence_anchor: "2026-09-16",
    recurrence_until: null,
    recurrence_active: false,
    timezone: "America/Santiago",
    freeze_lead_minutes: 90,
    ...extra,
  },
  error: null,
});
const ok: ReponseDb = { data: null, error: null };
const relu = (actif: boolean): ReponseDb => ({ data: { recurrence_active: actif }, error: null });
/** Trois échéances calculées par la fonction SQL : mardi, jeudi, mardi suivant. */
const CALCULEES: ReponseDb = {
  data: [
    { local_date: "2026-09-24", fires_at: "2026-09-24T13:00:00+00:00", local_text: "2026-09-24 10:00 -03:00" },
    { local_date: "2026-09-29", fires_at: "2026-09-29T13:00:00+00:00", local_text: "2026-09-29 10:00 -03:00" },
    { local_date: "2026-10-01", fires_at: "2026-10-01T13:00:00+00:00", local_text: "2026-10-01 10:00 -03:00" },
  ],
  error: null,
};
const aucuneConnue: ReponseDb = { data: [], error: null };

async function appeler(opts: { versionPubliee?: boolean } = {}, ...reponses: ReponseDb[]) {
  const { db, appels, restantes } = fauxDb(...reponses);
  const res = await postArm(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ id: CAMP }) }, {
    requireContext: async () => ({
      ok: true as const,
      ctx: { db: db as never, asset: { id: ASSET, name: "PF" } as never, user: { email: "a@staff.invalid" } as never },
    }),
    versionPubliee: async () => (opts.versionPubliee === false ? null : { id: VER, templateId: "t", version: 3 }),
    maintenant: () => MAINTENANT,
  });
  return { res, json: (await res.json()) as Record<string, unknown>, appels, restantes };
}

const ecriture = (appels: AppelDb[]) => {
  const u = appels.find((a) => a.methodes.some((m) => m.m === "update"));
  return u ? (u.methodes.find((m) => m.m === "update")!.args[0] as Record<string, unknown>) : null;
};

describe("garde d'accès", () => {
  test("un refus de session est rendu tel quel, sans lecture", async () => {
    const res = await postArm(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ id: CAMP }) }, {
      requireContext: async () => ({ ok: false as const, res: Response.json({ error: "unauthenticated" }, { status: 401 }) as never }),
      versionPubliee: async () => null,
      maintenant: () => MAINTENANT,
    });
    expect(res.status).toBe(401);
  });

  test("campagne d'une autre marque ⇒ 404, lecture scopée sur la marque, rien d'écrit", async () => {
    const { res, appels } = await appeler({}, { data: null, error: null });
    expect(res.status).toBe(404);
    expect(eqsDe(appels[0]!)).toEqual([["id", CAMP], ["asset_id", ASSET]]);
    expect(ecriture(appels)).toBeNull();
  });
});

describe("refus — 409, et RIEN n'est écrit", () => {
  // MUTATION QUI DOIT TUER CE TEST : retirer le refus `lockedAt`. Une campagne figée pour UNE date
  // serait répétée : le même contenu figé partirait à chaque édition.
  test("campagne verrouillée ⇒ 409 qui dit de déverrouiller", async () => {
    const { res, json, appels } = await appeler({}, campagne({ locked_at: "2026-09-20T10:00:00Z" }), cadence());
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("unlock it first");
    expect(ecriture(appels)).toBeNull();
  });

  // MUTATION QUI DOIT TUER CE TEST : retirer le refus de finalité. Le gate d'envoi rejetterait alors
  // chaque destinataire de chaque édition, en silence, semaine après semaine.
  test("⛔ campagne SANS finalité ⇒ 409 qui nomme la finalité", async () => {
    const { res, json, appels } = await appeler({}, campagne({ purpose: null }), cadence());
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("no purpose");
    expect(ecriture(appels)).toBeNull();
  });

  const refus: [string, ReponseDb[], string][] = [
    ["annulée", [campagne({ status: "cancelled" }), cadence()], "cancelled"],
    ["sans cadence", [campagne(), cadence({ recurrence_days: [] })], "no cadence saved yet"],
    ["sans fuseau", [campagne(), cadence({ timezone: null })], "no time zone"],
    ["sans sujet", [campagne({ subject: "  " }), cadence()], "no subject"],
    ["sans version", [campagne({ template_version_id: null }), cadence()], "no template version"],
  ];
  for (const [nom, reponses, attendu] of refus) {
    test(`${nom} ⇒ 409`, async () => {
      const { res, json, appels } = await appeler({}, ...reponses);
      expect(res.status).toBe(409);
      expect(String(json.error)).toContain(attendu);
      expect(ecriture(appels)).toBeNull();
    });
  }

  test("version non publiée pour cette marque ⇒ 409", async () => {
    const { res, appels } = await appeler({ versionPubliee: false }, campagne(), cadence());
    expect(res.status).toBe(409);
    expect(ecriture(appels)).toBeNull();
  });

  test("⛔ aucun message ne parle plus d'« arm » à l'écran", async () => {
    for (const reponses of [
      [campagne({ locked_at: "2026-09-20T10:00:00Z" }), cadence()],
      [campagne(), cadence({ recurrence_days: [] })],
      [campagne({ purpose: null }), cadence()],
    ]) {
      const { json } = await appeler({}, ...reponses);
      expect(String(json.error)).not.toMatch(/\barm(ed|ing)?\b/i);
    }
  });
});

describe("démarrer — l'écriture", () => {
  const HEUREUX = [campagne(), cadence(), ok, relu(true), CALCULEES, aucuneConnue];

  test("écrit recurrence_active=true, et RIEN d'autre, scopé campagne ET marque", async () => {
    const { res, json, appels } = await appeler({}, ...HEUREUX);
    expect(res.status).toBe(200);
    const e = ecriture(appels)!;
    expect(Object.keys(e).sort()).toEqual(["recurrence_active", "updated_at"]);
    expect(e.recurrence_active).toBe(true);
    const u = appels.find((a) => a.methodes.some((m) => m.m === "update"))!;
    expect(eqsDe(u)).toEqual([["id", CAMP], ["asset_id", ASSET]]);
    expect(json).toMatchObject({ ok: true, active: true, horizonDays: 21 });
  });

  test("⛔ jamais de verrou : démarrer ne touche ni locked_at ni le statut", async () => {
    const { appels } = await appeler({}, ...HEUREUX);
    const e = ecriture(appels)!;
    expect(e).not.toHaveProperty("locked_at");
    expect(e).not.toHaveProperty("status");
  });

  test("la relecture dit « pas actif » ⇒ 500, jamais un écran vert par défaut", async () => {
    const { res, json } = await appeler({}, campagne(), cadence(), ok, relu(false));
    expect(res.status).toBe(500);
    expect(String(json.error)).toContain("could not be started");
  });
});

describe("⛔ l'aperçu annonce ce qui PARTIRA, pas la cadence brute", () => {
  test("aucune date connue ⇒ les trois échéances, la première en tête", async () => {
    const { json } = await appeler({}, campagne(), cadence(), ok, relu(true), CALCULEES, aucuneConnue);
    expect(json.upcoming).toEqual({
      count: 3,
      first: "2026-09-24T13:00:00+00:00",
      last: "2026-10-01T13:00:00+00:00",
      excluded: 0,
    });
  });

  // MUTATION QUI DOIT TUER CE TEST : ne plus retirer les dates connues (`partira.get(date) === false`).
  // C'est le défaut d'origine : après Stop puis Resume, « first on Thu 24 » — et jeudi rien ne part,
  // parce que le matérialiseur ne recrée jamais une date annulée.
  test("après Stop puis Resume : la date annulée n'est PLUS annoncée", async () => {
    const annulee: ReponseDb = { data: [{ local_date: "2026-09-24", status: "cancelled" }], error: null };
    const { json } = await appeler({}, campagne(), cadence(), ok, relu(true), CALCULEES, annulee);
    expect(json.upcoming).toMatchObject({ count: 2, first: "2026-09-29T13:00:00+00:00", excluded: 1 });
  });

  test("la lecture des dates connues est scopée campagne ET marque", async () => {
    const { appels } = await appeler({}, campagne(), cadence(), ok, relu(true), CALCULEES, aucuneConnue);
    const lecture = appels.find((a) => a.table === "campaign_occurrence")!;
    expect(eqsDe(lecture)).toEqual([["campaign_id", CAMP], ["asset_id", ASSET]]);
  });

  test("la fin de série borne la fenêtre, comme le matérialiseur (+1 jour)", async () => {
    const { appels } = await appeler(
      {},
      campagne(),
      cadence({ recurrence_until: "2026-09-30" }),
      ok,
      relu(true),
      CALCULEES,
      aucuneConnue,
    );
    const rpc = appels.find((a) => a.table === "rpc:campaign_occurrences")!;
    expect((rpc.methodes[0]!.args[0] as Record<string, unknown>).p_to).toBe("2026-10-01T00:00:00.000Z");
  });

  // MUTATION QUI DOIT TUER CE TEST : rendre `{ count: 0 }` quand le calcul échoue. L'écran lirait
  // « aucune édition dans les 21 jours — vérifiez la cadence » et enverrait chercher une faute de saisie.
  test("calcul en échec ⇒ upcoming null (« on ne sait pas »), et la série reste démarrée", async () => {
    const { res, json } = await appeler(
      {},
      campagne(),
      cadence(),
      ok,
      relu(true),
      { data: null, error: { message: "boom" } },
    );
    expect(res.status).toBe(200);
    expect(json.active).toBe(true);
    expect(json.upcoming).toBeNull();
  });
});

describe("apercuHonnete — la règle date par date", () => {
  const calc = [
    { local_date: "2026-09-24", fires_at: "2026-09-24T13:00:00Z" },
    { local_date: "2026-09-29", fires_at: "2026-09-29T13:00:00Z" },
  ];

  test("déjà planifiée ou figée ⇒ elle part toujours", () => {
    expect(apercuHonnete(calc, [{ local_date: "2026-09-24", status: "frozen" }]).count).toBe(2);
  });

  test("retenue ⇒ elle ne part pas, et elle est comptée à part", () => {
    expect(apercuHonnete(calc, [{ local_date: "2026-09-24", status: "held" }])).toMatchObject({
      count: 1,
      excluded: 1,
    });
  });

  /** La clé d'unicité autorise une date annulée PUIS re-planifiée à la main : les deux lignes coexistent. */
  test("annulée puis re-planifiée à la main ⇒ elle part", () => {
    const connues = [
      { local_date: "2026-09-24", status: "cancelled" },
      { local_date: "2026-09-24", status: "planned" },
    ];
    expect(apercuHonnete(calc, connues)).toMatchObject({ count: 2, excluded: 0 });
  });

  // 12:00+02:00 = 10:00 UTC, AVANT 11:00 UTC — un tri de chaînes dirait l'inverse.
  test("tri sur des instants, pas sur des chaînes", () => {
    const r = apercuHonnete(
      [
        { local_date: "b", fires_at: "2026-09-24T11:00:00.000Z" },
        { local_date: "a", fires_at: "2026-09-24T12:00:00+02:00" },
      ],
      [],
    );
    expect(r.first).toBe("2026-09-24T12:00:00+02:00");
  });
});
