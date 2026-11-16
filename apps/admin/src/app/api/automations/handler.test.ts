/**
 * AUTOMATIONS SUR MESURE — créer, modifier, armer (plan, étapes 10 et 13), mesuré sans session ni base.
 *
 * Même montage que `campaigns/[id]/archive/handler.test.ts` : la session est injectée, le client
 * Supabase est le double `fauxDb` (réponses consommées DANS L'ORDRE des requêtes), et ce sont les
 * VRAIES `findAutomation`, `countSends`, `validateAutomation` et `decideTransition` qui tournent.
 *
 * ⛔ Ce que ce banc garde, et le mutant qui le prouve (lancé à la main, voir le rendu de la vague 3) :
 *  - un membre qui arme ⇒ 403, et AUCUNE lecture ni écriture (retirer la garde ⇒ rouge) ;
 *  - une transition hors table ⇒ 409, rien d'écrit (retirer `canTransition` ⇒ rouge) ;
 *  - armer écrit `audit_log` AVANT le statut, et sans audit rien n'est armé (retirer l'audit ⇒ rouge).
 * Plan AUTO-EDIT (25/09), 17 mutants tués (rendu du lot API) — entre autres :
 *  - supprimer : garde de statut, garde d'envois, « historique illisible = 0 », scope marque en lecture
 *    (`findAutomation`) et en écriture, audit d'abord, UNE ligne supprimée (chacun retiré ⇒ rouge) ;
 *  - dupliquer : insertion hors du chemin du POST, contrôle des modèles, `draft`, `created_by` de la
 *    session, curseur recopié par `columnsOf` (chacun ⇒ rouge).
 */
import { describe, expect, test } from "bun:test";
import { fauxDb, type AppelDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `lib/data/automations.ts` tire `lib/data/templates` → `@/lib/session` → `auth.ts`, qui LÈVE à
// l'import si AUTH_SECRET manque.
process.env.AUTH_SECRET = "secret-de-test-uniquement-24092026";
const { postCreate, putUpdate, postStatus, postDuplicate, deleteAutomation } = await import("./handler");
const { NOT_INSTALLED } = await import("@/lib/data/automations");

const ASSET = "22222222-2222-4222-8222-222222222222";
const ID = "44444444-4444-4444-8444-444444444444";
const TV = "33333333-3333-4333-8333-333333333333";
const MAINTENANT = new Date("2026-09-24T12:00:00Z");
const LANCEE = "2026-09-24T08:00:00+00:00";
const PASSEE = "2026-09-24T08:10:00+00:00";
const NOM = "Welcome back — PF";

/** Une ligne `automation` telle que PostgREST la rend. */
const ligne = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  asset_id: ASSET,
  name: NOM,
  trigger: "welcome_back",
  filters: {},
  settings: {},
  steps: [{ delay_hours: 1, template_version_id: TV }],
  status: "draft",
  purpose: "content",
  daily_cap: 50,
  window_start_hour: 8,
  window_end_hour: 20,
  timezone: "America/Santiago",
  event_cursor: null,
  last_run_at: null,
  status_changed_at: LANCEE,
  armed_by: null,
  armed_at: null,
  created_by: "editor@staff.invalid",
  updated_by: "editor@staff.invalid",
  created_at: "2026-09-23T08:00:00+00:00",
  updated_at: LANCEE,
  ...extra,
});
const lue = (extra: Record<string, unknown> = {}): ReponseDb => ({ data: ligne(extra), error: null });
const ok: ReponseDb = { data: null, error: null };
const touche: ReponseDb = { data: [{ id: ID }], error: null };
const rien: ReponseDb = { data: [], error: null };
/** Réponse d'un compte d'en-tête (`head: true`) : le compte voyage hors de `data`. */
const compte = (n: number) => ({ data: null, error: null, count: n }) as unknown as ReponseDb;

/** Le corps d'un formulaire valide. */
const corps = (extra: Record<string, unknown> = {}) => ({
  name: NOM,
  trigger: "welcome_back",
  purpose: "content",
  filters: {},
  settings: {},
  steps: [{ delay_hours: 1, template_version_id: TV }],
  daily_cap: 50,
  window_start_hour: 8,
  window_end_hour: 20,
  timezone: "America/Santiago",
  ...extra,
});

const ctx = (db: unknown, isSuperAdmin: boolean) => ({
  ok: true as const,
  ctx: {
    db: db as never,
    asset: { id: ASSET, name: "PF" } as never,
    user: { email: isSuperAdmin ? "admin@staff.invalid" : "editor@staff.invalid", isSuperAdmin } as never,
  },
});

function deps(db: unknown, opts: { superAdmin?: boolean; versionOk?: boolean } = {}) {
  return {
    requireContext: async () => ctx(db, opts.superAdmin === true),
    versionPubliee: async () => (opts.versionOk === false ? null : { id: TV, templateId: "t", version: 2 }),
    maintenant: () => MAINTENANT,
  };
}

const requete = (body: unknown, method = "POST") =>
  new Request("http://x/api/automations", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function creer(body: unknown, opts: { versionOk?: boolean } = {}, ...reponses: ReponseDb[]) {
  const { db, appels } = fauxDb(...reponses);
  const res = await postCreate(requete(body), deps(db, opts));
  return { res, json: (await res.json()) as Record<string, unknown>, appels };
}

async function modifier(body: unknown, ...reponses: ReponseDb[]) {
  const { db, appels } = fauxDb(...reponses);
  const res = await putUpdate(requete(body, "PUT"), { params: Promise.resolve({ id: ID }) }, deps(db));
  return { res, json: (await res.json()) as Record<string, unknown>, appels };
}

async function changer(body: unknown, opts: { superAdmin?: boolean; versionOk?: boolean }, ...reponses: ReponseDb[]) {
  const { db, appels, restantes } = fauxDb(...reponses);
  const res = await postStatus(requete(body), { params: Promise.resolve({ id: ID }) }, deps(db, opts));
  return { res, json: (await res.json()) as Record<string, unknown>, appels, restantes };
}

async function dupliquer(opts: { superAdmin?: boolean; versionOk?: boolean }, ...reponses: ReponseDb[]) {
  const { db, appels } = fauxDb(...reponses);
  const res = await postDuplicate(requete(null), { params: Promise.resolve({ id: ID }) }, deps(db, opts));
  return { res, json: (await res.json()) as Record<string, unknown>, appels };
}

async function supprimer(...reponses: ReponseDb[]) {
  const { db, appels } = fauxDb(...reponses);
  const res = await deleteAutomation(requete(null, "DELETE"), { params: Promise.resolve({ id: ID }) }, deps(db));
  return { res, json: (await res.json()) as Record<string, unknown>, appels };
}

/** Chaque appel, réduit à `table:verbe` (le verbe d'écriture s'il y en a un, sinon `read`). */
const verbes = (appels: AppelDb[]) =>
  appels.map((a) => `${a.table}:${a.methodes.find((m) => ["insert", "update", "delete"].includes(m.m))?.m ?? "read"}`);

/** Toutes les écritures, dans l'ordre : `[table, corps]`. */
const ecritures = (appels: AppelDb[]): [string, Record<string, unknown>][] =>
  appels.flatMap((a) =>
    a.methodes
      .filter((m) => m.m === "update" || m.m === "insert")
      .map((m) => [a.table, m.args[0] as Record<string, unknown>] as [string, Record<string, unknown>]),
  );
const tables = (appels: AppelDb[]) => ecritures(appels).map(([t]) => t);
const aLeFiltre = (a: AppelDb, col: string, val: unknown) =>
  a.methodes.some((x) => x.m === "eq" && x.args[0] === col && x.args[1] === val);

/* ------------------------------------------------------------------ */

describe("POST /api/automations — une automation naît draft", () => {
  test("valide ⇒ 201, insérée `draft`, auteur posé, colonnes normalisées", async () => {
    const r = await creer(corps(), {}, { data: { id: ID }, error: null });
    expect(r.res.status).toBe(201);
    expect(r.json.id).toBe(ID);
    const w = ecritures(r.appels);
    expect(w.map(([t]) => t)).toEqual(["automation"]);
    const b = w[0]?.[1] ?? {};
    expect(b.status).toBe("draft");
    expect(b.asset_id).toBe(ASSET);
    expect(b.created_by).toBe("editor@staff.invalid");
    expect(b.purpose).toBe("content");
    expect(b.steps).toEqual([{ delay_hours: 1, template_version_id: TV }]);
  });

  test("⛔ un corps qui dit `live` crée quand même un brouillon", async () => {
    const r = await creer(corps({ status: "live", armed_by: "x" }), {}, { data: { id: ID }, error: null });
    expect(r.res.status).toBe(201);
    const b = ecritures(r.appels)[0]?.[1] ?? {};
    expect(b.status).toBe("draft");
    expect(b.armed_by).toBeUndefined();
  });

  test("invalide (validation du catalogue) ⇒ 422 avec les messages, rien d'écrit", async () => {
    const r = await creer(corps({ purpose: null, daily_cap: 0 }));
    expect(r.res.status).toBe(422);
    expect(r.json.errors).toEqual([
      "a marketing automation needs a purpose (content, offers, events or partners)",
      "daily cap must be between 1 and 2000",
    ]);
    expect(r.appels).toHaveLength(0);
  });

  test("⛔ la règle système (rebonds mous) ne se crée pas", async () => {
    const r = await creer(corps({ trigger: "soft_bounce_rule", purpose: null, steps: [] }));
    expect(r.res.status).toBe(422);
    expect(String(r.json.error)).toContain("system rule");
    expect(r.appels).toHaveLength(0);
  });

  test("⛔ une version de modèle hors marque, non publiée ou non octroyée ⇒ 422", async () => {
    const r = await creer(corps(), { versionOk: false });
    expect(r.res.status).toBe(422);
    expect(String((r.json.errors as string[])[0])).toContain("step 1");
    expect(r.appels).toHaveLength(0);
  });

  test("0082 non appliquée ⇒ 503 qui le DIT", async () => {
    const r = await creer(corps(), {}, { data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    expect(r.res.status).toBe(503);
    expect(r.json.error).toBe(NOT_INSTALLED);
  });
});

describe("PUT /api/automations/[id] — on ne modifie qu'un brouillon", () => {
  test("brouillon ⇒ 200, écriture gardée par `status = draft` et la marque", async () => {
    const r = await modifier(corps({ name: "Renamed" }), lue(), touche);
    expect(r.res.status).toBe(200);
    const maj = r.appels[1] as AppelDb;
    expect(aLeFiltre(maj, "status", "draft")).toBe(true);
    expect(aLeFiltre(maj, "asset_id", ASSET)).toBe(true);
    expect(ecritures(r.appels)[0]?.[1].name).toBe("Renamed");
  });

  test("⛔ en simulation ⇒ 409, rien d'écrit", async () => {
    const r = await modifier(corps(), lue({ status: "simulation" }));
    expect(r.res.status).toBe(409);
    expect(tables(r.appels)).toEqual([]);
  });

  test("⛔ déclencheur changé après des sélections (simulées ou réelles) ⇒ 409, rien d'écrit", async () => {
    const r = await modifier(corps({ trigger: "preferences_updated" }), lue(), compte(3));
    expect(r.res.status).toBe(409);
    expect(r.json.sends).toBe(3);
    expect(tables(r.appels)).toEqual([]);
    // Le compte porte sur TOUTE l'histoire : ni filtre `simulated`, ni date.
    const lecture = r.appels[1] as AppelDb;
    expect(lecture.table).toBe("automation_send");
    expect(lecture.methodes.filter((m) => m.m === "eq").map((m) => m.args[0])).toEqual(["automation_id", "asset_id"]);
    expect(lecture.methodes.some((m) => m.m === "gte")).toBe(false);
  });

  test("⛔ historique illisible ⇒ 503, rien d'écrit (« non lu » n'est pas « vide »)", async () => {
    const r = await modifier(corps({ trigger: "preferences_updated" }), lue(), { data: null, error: { message: "boom" } });
    expect(r.res.status).toBe(503);
    expect(tables(r.appels)).toEqual([]);
  });

  test("déclencheur changé sur un brouillon JAMAIS sélectionné ⇒ 200, curseur et dernier passage remis à zéro", async () => {
    const r = await modifier(corps({ trigger: "preferences_updated" }), lue(), compte(0), touche);
    expect(r.res.status).toBe(200);
    const b = ecritures(r.appels)[0]?.[1] ?? {};
    expect([b.trigger, b.event_cursor, b.last_run_at]).toEqual(["preferences_updated", null, null]);
    expect(aLeFiltre(r.appels[2] as AppelDb, "status", "draft")).toBe(true);
  });

  test("même déclencheur ⇒ ni lecture de l'historique, ni remise à zéro du curseur", async () => {
    const r = await modifier(corps({ name: "Renamed" }), lue(), touche);
    expect(r.appels.map((a) => a.table)).toEqual(["automation", "automation"]);
    const b = ecritures(r.appels)[0]?.[1] ?? {};
    expect("event_cursor" in b || "last_run_at" in b).toBe(false);
  });

  test("⛔ vers la règle système ou un déclencheur inconnu ⇒ 422, rien lu ni écrit au-delà de la ligne", async () => {
    for (const trigger of ["soft_bounce_rule", "x"]) {
      const r = await modifier(corps({ trigger }), lue());
      expect([trigger, r.res.status]).toEqual([trigger, 422]);
      expect(r.appels.map((a) => a.table)).toEqual(["automation"]);
    }
  });

  test("changée entre la lecture et l'écriture ⇒ 409", async () => {
    const r = await modifier(corps(), lue(), rien);
    expect(r.res.status).toBe(409);
  });

  test("d'une autre marque ⇒ 404 (indiscernable d'une automation inexistante)", async () => {
    const r = await modifier(corps(), ok);
    expect(r.res.status).toBe(404);
  });
});

describe("POST /api/automations/[id]/status — droits et transitions", () => {
  test("⛔ un MEMBRE qui arme ⇒ 403, et rien n'est lu ni écrit", async () => {
    const r = await changer({ to: "live", confirmName: NOM }, { superAdmin: false }, lue({ status: "simulation" }));
    expect(r.res.status).toBe(403);
    expect(r.appels).toHaveLength(0);
  });

  test("⛔ un MEMBRE qui reprend (paused → live) ⇒ 403 aussi : reprendre, c'est renvoyer", async () => {
    const r = await changer({ to: "live", confirmName: NOM }, { superAdmin: false }, lue({ status: "paused" }));
    expect(r.res.status).toBe(403);
    expect(r.appels).toHaveLength(0);
  });

  test("⛔ transition interdite (draft → live) ⇒ 409, même pour un super_admin, rien d'écrit", async () => {
    const r = await changer({ to: "live", confirmName: NOM }, { superAdmin: true }, lue());
    expect(r.res.status).toBe(409);
    expect(tables(r.appels)).toEqual([]);
  });

  test("⛔ transition interdite (live → simulation) ⇒ 409", async () => {
    const r = await changer({ to: "simulation" }, { superAdmin: true }, lue({ status: "live" }));
    expect(r.res.status).toBe(409);
    expect(tables(r.appels)).toEqual([]);
  });

  test("⛔ armer avant que la simulation ait tourné ⇒ 409, rien d'écrit", async () => {
    const r = await changer({ to: "live", confirmName: NOM }, { superAdmin: true }, lue({ status: "simulation" }), compte(0));
    expect(r.res.status).toBe(409);
    expect(String(r.json.error)).toContain("simulation has not run");
    expect(tables(r.appels)).toEqual([]);
  });

  test("⛔ une trace simulée d'AVANT le dernier lancement ne compte pas : le compte est pris depuis `status_changed_at`", async () => {
    const r = await changer({ to: "live", confirmName: NOM }, { superAdmin: true }, lue({ status: "simulation" }), compte(0));
    const compteur = r.appels[1] as AppelDb;
    expect(compteur.table).toBe("automation_send");
    expect(compteur.methodes.some((m) => m.m === "gte" && m.args[0] === "created_at" && m.args[1] === LANCEE)).toBe(true);
    expect(aLeFiltre(compteur, "simulated", true)).toBe(true);
  });

  test("⛔ nom mal tapé ⇒ 422, rien d'écrit", async () => {
    const r = await changer(
      { to: "live", confirmName: "Welcome back" },
      { superAdmin: true },
      lue({ status: "simulation", last_run_at: PASSEE }),
      compte(0),
    );
    expect(r.res.status).toBe(422);
    expect(tables(r.appels)).toEqual([]);
  });

  test("⛔ ARMER : `audit_log` D'ABORD, puis le statut gardé par l'état lu, `armed_by` posé", async () => {
    const r = await changer(
      { to: "live", confirmName: NOM },
      { superAdmin: true },
      lue({ status: "simulation", last_run_at: PASSEE }),
      compte(0),
      ok,
      touche,
    );
    expect(r.res.status).toBe(200);
    expect(tables(r.appels)).toEqual(["audit_log", "automation"]);
    const w = ecritures(r.appels);
    const audit = w[0]?.[1] ?? {};
    const maj = w[1]?.[1] ?? {};
    expect(audit.action).toBe("automation-armed");
    expect(audit.target_id).toBe(ID);
    expect(audit.actor).toBe("admin:admin@staff.invalid");
    expect((audit.meta as Record<string, unknown>).from).toBe("simulation");
    expect(maj.status).toBe("live");
    expect(maj.armed_by).toBe("admin@staff.invalid");
    expect(maj.status_changed_at).toBe(MAINTENANT.toISOString());
    expect(aLeFiltre(r.appels[3] as AppelDb, "status", "simulation")).toBe(true);
    expect(r.json.audited).toBe(true);
  });

  test("une trace simulée depuis le lancement suffit, même sans `last_run_at`", async () => {
    const r = await changer({ to: "live", confirmName: NOM }, { superAdmin: true }, lue({ status: "simulation" }), compte(2), ok, touche);
    expect(r.res.status).toBe(200);
  });

  test("⛔ sans ligne d'audit, RIEN n'est armé ⇒ 500", async () => {
    const r = await changer(
      { to: "live", confirmName: NOM },
      { superAdmin: true },
      lue({ status: "simulation", last_run_at: PASSEE }),
      compte(0),
      { data: null, error: { message: "permission denied" } },
    );
    expect(r.res.status).toBe(500);
    expect(String(r.json.error)).toContain("not switched to live");
    expect(tables(r.appels)).toEqual(["audit_log"]);
  });

  test("armement doublé par un autre onglet ⇒ 409 et une ligne d'audit qui dit l'échec", async () => {
    const r = await changer(
      { to: "live", confirmName: NOM },
      { superAdmin: true },
      lue({ status: "simulation", last_run_at: PASSEE }),
      compte(0),
      ok,
      rien,
      ok,
    );
    expect(r.res.status).toBe(409);
    expect(tables(r.appels)).toEqual(["audit_log", "automation", "audit_log"]);
    expect(ecritures(r.appels)[2]?.[1].action).toBe("automation-arm-failed");
  });

  test("reprendre (paused → live) : super_admin, nom tapé, audit `automation-resumed` d'abord", async () => {
    const r = await changer({ to: "live", confirmName: NOM }, { superAdmin: true }, lue({ status: "paused" }), ok, touche);
    expect(r.res.status).toBe(200);
    expect(tables(r.appels)).toEqual(["audit_log", "automation"]);
    expect(ecritures(r.appels)[0]?.[1].action).toBe("automation-resumed");
  });

  test("⛔ un déclencheur bloqué pour le réel (renouvellement, sans route) ne passe pas live ⇒ 422", async () => {
    const r = await changer(
      { to: "live", confirmName: NOM },
      { superAdmin: true },
      lue({ status: "simulation", last_run_at: PASSEE, trigger: "consent_renewal", purpose: null, steps: [{ delay_hours: 0, template_version_id: TV }] }),
      compte(0),
    );
    expect(r.res.status).toBe(422);
    expect(String((r.json.errors as string[])[0])).toContain("cannot go live");
    expect(tables(r.appels)).toEqual([]);
  });

  test("simuler (draft → simulation) : ouvert aux membres, statut puis audit", async () => {
    const r = await changer({ to: "simulation" }, { superAdmin: false }, lue(), touche, ok);
    expect(r.res.status).toBe(200);
    expect(tables(r.appels)).toEqual(["automation", "audit_log"]);
    expect(ecritures(r.appels)[1]?.[1].action).toBe("automation-simulation-started");
    expect(ecritures(r.appels)[0]?.[1].armed_by).toBeUndefined();
  });

  test("⛔ simuler une automation invalide ⇒ 422, rien d'écrit", async () => {
    const r = await changer({ to: "simulation" }, { superAdmin: false }, lue({ purpose: null }));
    expect(r.res.status).toBe(422);
    expect(tables(r.appels)).toEqual([]);
  });

  test("⛔ simuler avec un modèle dépublié depuis ⇒ 422", async () => {
    const r = await changer({ to: "simulation" }, { superAdmin: false, versionOk: false }, lue());
    expect(r.res.status).toBe(422);
    expect(tables(r.appels)).toEqual([]);
  });

  test("mettre en pause : ouvert aux membres, et un audit raté ne l'empêche pas", async () => {
    const r = await changer({ to: "paused" }, { superAdmin: false }, lue({ status: "live" }), touche, {
      data: null,
      error: { message: "audit down" },
    });
    expect(r.res.status).toBe(200);
    expect(r.json.audited).toBe(false);
    expect(ecritures(r.appels)[0]?.[1].status).toBe("paused");
  });

  test("revenir au brouillon depuis live : ouvert aux membres (cela ARRÊTE l'automation)", async () => {
    const r = await changer({ to: "draft" }, { superAdmin: false }, lue({ status: "live" }), touche, ok);
    expect(r.res.status).toBe(200);
    expect(ecritures(r.appels)[1]?.[1].action).toBe("automation-back-to-draft");
  });

  test("statut inconnu ⇒ 400", async () => {
    const r = await changer({ to: "armed" }, { superAdmin: true });
    expect(r.res.status).toBe(400);
    expect(r.appels).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Plan AUTO-EDIT (25/09) — dupliquer, supprimer
 * ------------------------------------------------------------------ */

const COPIE = "55555555-5555-4555-8555-555555555555";
const creee: ReponseDb = { data: { id: COPIE }, error: null };
/** Une automation qui a TOURNÉ : curseur, dernier passage, armement, autre auteur. */
const aTourne = (extra: Record<string, unknown> = {}) =>
  lue({
    status: "paused",
    filters: { languages: ["es"], interest_ids: [7] },
    event_cursor: 123,
    last_run_at: PASSEE,
    armed_by: "admin@staff.invalid",
    armed_at: PASSEE,
    created_by: "author@staff.invalid",
    updated_by: "author@staff.invalid",
    ...extra,
  });

describe("POST /api/automations/[id]/duplicate — la copie repart de zéro, en brouillon", () => {
  test("⛔ copie d'une automation qui a tourné : 201, draft, « Copy of », mêmes réglages, AUCUNE colonne d'historique", async () => {
    const r = await dupliquer({}, aTourne(), creee);
    expect(r.res.status).toBe(201);
    expect(r.json.id).toBe(COPIE);
    expect(verbes(r.appels)).toEqual(["automation:read", "automation:insert"]);
    const b = ecritures(r.appels)[0]?.[1] ?? {};
    // Les colonnes du formulaire + statut, marque, signatures, dates : ni curseur, ni dernier passage, ni armement.
    expect(Object.keys(b).sort()).toEqual(
      [
        "asset_id", "name", "trigger", "filters", "settings", "steps", "purpose", "daily_cap", "window_start_hour",
        "window_end_hour", "timezone", "status", "created_by", "updated_by", "status_changed_at", "updated_at",
      ].sort(),
    );
    expect(b.status).toBe("draft");
    expect(b.name).toBe(`Copy of ${NOM}`);
    expect(b.asset_id).toBe(ASSET);
    expect([b.trigger, b.purpose, b.daily_cap, b.window_start_hour, b.window_end_hour, b.timezone]).toEqual([
      "welcome_back", "content", 50, 8, 20, "America/Santiago",
    ]);
    expect(b.filters).toEqual({ languages: ["es"], interest_ids: [7] });
    expect(b.steps).toEqual([{ delay_hours: 1, template_version_id: TV }]);
  });

  test("⛔ created_by / updated_by = la personne connectée, pas l'auteur de la source", async () => {
    const r = await dupliquer({ superAdmin: false }, aTourne(), creee);
    const b = ecritures(r.appels)[0]?.[1] ?? {};
    expect([b.created_by, b.updated_by]).toEqual(["editor@staff.invalid", "editor@staff.invalid"]);
  });

  test("⛔ d'une autre marque ⇒ 404 : la lecture est scopée sur la marque, et rien n'est écrit", async () => {
    const r = await dupliquer({}, ok);
    expect(r.res.status).toBe(404);
    expect(verbes(r.appels)).toEqual(["automation:read"]);
    expect(aLeFiltre(r.appels[0] as AppelDb, "asset_id", ASSET)).toBe(true);
  });

  test("⛔ copie invalide (marketing sans finalité, écrite par un autre chemin) ⇒ 422, rien d'écrit", async () => {
    const r = await dupliquer({}, lue({ purpose: null }));
    expect(r.res.status).toBe(422);
    expect(r.json.errors).toEqual(["a marketing automation needs a purpose (content, offers, events or partners)"]);
    expect(tables(r.appels)).toEqual([]);
  });

  test("⛔ une version de modèle que la personne ne peut plus utiliser ⇒ 422, rien d'écrit", async () => {
    const r = await dupliquer({ versionOk: false }, lue());
    expect(r.res.status).toBe(422);
    expect(String((r.json.errors as string[])[0])).toContain("step 1");
    expect(tables(r.appels)).toEqual([]);
  });

  test("nom long : « Copy of … » coupé à 120 caractères, la copie passe", async () => {
    const r = await dupliquer({}, lue({ name: "N".repeat(118) }), creee);
    expect(r.res.status).toBe(201);
    const nom = String(ecritures(r.appels)[0]?.[1].name);
    expect(nom.length).toBe(120);
    expect(nom.startsWith("Copy of NNN")).toBe(true);
  });

  test("lecture de la source en panne ⇒ 503, rien d'écrit", async () => {
    const r = await dupliquer({}, { data: null, error: { message: "boom" } });
    expect(r.res.status).toBe(503);
    expect(tables(r.appels)).toEqual([]);
  });
});

describe("DELETE /api/automations/[id] — seulement ce qui ne tourne pas et n'a jamais sélectionné personne", () => {
  test("⛔ brouillon sans envoi ⇒ 200 : audit D'ABORD, puis suppression gardée par id, marque et statut lu", async () => {
    const r = await supprimer(lue(), compte(0), ok, touche);
    expect(r.res.status).toBe(200);
    expect(r.json.deleted).toBe(true);
    expect(verbes(r.appels)).toEqual(["automation:read", "automation_send:read", "audit_log:insert", "automation:delete"]);
    expect(aLeFiltre(r.appels[0] as AppelDb, "asset_id", ASSET)).toBe(true);
    const suppression = r.appels[3] as AppelDb;
    expect([aLeFiltre(suppression, "id", ID), aLeFiltre(suppression, "asset_id", ASSET), aLeFiltre(suppression, "status", "draft")]).toEqual([
      true,
      true,
      true,
    ]);
    const audit = ecritures(r.appels)[0]?.[1] ?? {};
    expect([audit.action, audit.target_id, audit.asset_id, audit.actor]).toEqual([
      "automation-deleted",
      ID,
      ASSET,
      "admin:editor@staff.invalid",
    ]);
    expect((audit.meta as Record<string, unknown>).automation_name).toBe(NOM);
  });

  test("⛔ en pause sans envoi ⇒ 200, suppression gardée par `status = paused`", async () => {
    const r = await supprimer(lue({ status: "paused" }), compte(0), ok, touche);
    expect(r.res.status).toBe(200);
    expect(r.json.deleted).toBe(true);
    expect(aLeFiltre(r.appels[3] as AppelDb, "status", "paused")).toBe(true);
  });

  test("⛔ live ou simulation ⇒ 409 « stop it first », ni historique lu, ni rien d'écrit", async () => {
    for (const status of ["live", "simulation"]) {
      const r = await supprimer(lue({ status }), compte(0), ok, touche);
      expect([status, r.res.status]).toEqual([status, 409]);
      expect(String(r.json.error)).toContain("stop it first");
      expect(verbes(r.appels)).toEqual(["automation:read"]);
    }
  });

  test("⛔ au moins un envoi (simulé ou réel, depuis toujours) ⇒ 409, rien d'écrit", async () => {
    const r = await supprimer(lue({ status: "paused" }), compte(2), ok, touche);
    expect(r.res.status).toBe(409);
    expect(String(r.json.error)).toContain("already selected people");
    expect(r.json.sends).toBe(2);
    expect(verbes(r.appels)).toEqual(["automation:read", "automation_send:read"]);
    const lecture = r.appels[1] as AppelDb;
    expect(lecture.methodes.filter((m) => m.m === "eq").map((m) => m.args[0])).toEqual(["automation_id", "asset_id"]);
    expect(lecture.methodes.some((m) => m.m === "gte")).toBe(false);
  });

  test("⛔ historique illisible ⇒ 503, rien d'écrit (« non lu » n'est pas « zéro »)", async () => {
    const r = await supprimer(lue(), { data: null, error: { message: "boom" } }, ok, touche);
    expect(r.res.status).toBe(503);
    expect(verbes(r.appels)).toEqual(["automation:read", "automation_send:read"]);
  });

  test("⛔ d'une autre marque ⇒ 404 : lecture scopée sur la marque, rien d'écrit", async () => {
    const r = await supprimer(ok, compte(0), ok, touche);
    expect(r.res.status).toBe(404);
    expect(verbes(r.appels)).toEqual(["automation:read"]);
    expect(aLeFiltre(r.appels[0] as AppelDb, "asset_id", ASSET)).toBe(true);
  });

  test("lecture de l'automation en panne ⇒ 503, rien d'écrit", async () => {
    const r = await supprimer({ data: null, error: { message: "boom" } }, compte(0), ok, touche);
    expect(r.res.status).toBe(503);
    expect(verbes(r.appels)).toEqual(["automation:read"]);
  });

  test("⛔ audit impossible ⇒ 500, RIEN n'est supprimé", async () => {
    const r = await supprimer(lue(), compte(0), { data: null, error: { message: "permission denied" } }, touche);
    expect(r.res.status).toBe(500);
    expect(String(r.json.error)).toContain("not deleted");
    expect(verbes(r.appels)).toEqual(["automation:read", "automation_send:read", "audit_log:insert"]);
  });

  test("supprimée par personne (changée entre-temps) ⇒ 409, et une ligne d'audit dit l'échec", async () => {
    const r = await supprimer(lue(), compte(0), ok, rien, ok);
    expect(r.res.status).toBe(409);
    expect(String(r.json.error)).toContain("changed meanwhile");
    expect(verbes(r.appels)).toEqual(["automation:read", "automation_send:read", "audit_log:insert", "automation:delete", "audit_log:insert"]);
    expect(ecritures(r.appels)[1]?.[1].action).toBe("automation-delete-failed");
  });

  test("⛔ la clé étrangère refuse (une trace écrite entre le compte et la suppression) ⇒ 409 « already selected people »", async () => {
    const r = await supprimer(lue(), compte(0), ok, { data: null, error: { code: "23503", message: "violates foreign key" } }, ok);
    expect(r.res.status).toBe(409);
    expect(String(r.json.error)).toContain("already selected people");
  });
});
