/**
 * Banc du moteur d'automations — AUCUNE base.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER : qu'une automation `draft`, `paused` ou `simulation` mette
 * un e-mail en file ; qu'une automation `live` enfile depuis un worker qui ne peut pas envoyer ; que
 * deux passes écrivent deux fois ; que le plafond du jour soit dépassé.
 *
 * ⚠️ LE DOUBLE EST LA FONCTION SQL AMPUTÉE DE SA PROPRE SERRURE. `automation_due` refuse d'enfiler
 * pour une automation qui n'est pas `live` ; le double, lui, enfile dès que le moteur lui passe
 * `liveAllowed = true`. C'est voulu : le banc mesure la serrure du MOTEUR seule. S'il faisait lui
 * aussi le contrôle, un moteur qui passerait `liveAllowed = true` à tort resterait vert.
 * Il reproduit en revanche le reste du contrat SQL : unicité du créneau, plafond compté sur la trace
 * du même mode, étape N après l'étape N-1 du même mode, sonde qui n'écrit rien.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AutomationRecord } from "@nf/automations";
import { runAutomations, type AutomationRunOptions } from "./engine";
import { AutomationDb, AutomationsNotInstalled, type AutomationDbLike, type DueOptions, type DueResult } from "./db";

const TV = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
/** 12:00 UTC = 09:00 à São Paulo : dans la fenêtre 08-20 des fixtures. */
const MIDI = new Date("2026-09-24T12:00:00Z");

let n = 0;
function automation(p: Partial<AutomationRecord> = {}): AutomationRecord {
  n += 1;
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
    asset_id: ASSET,
    name: `Anniversaire ${n}`,
    trigger: "anniversary",
    filters: {},
    settings: {},
    steps: [{ delay_hours: 0, template_version_id: TV }],
    status: "simulation",
    purpose: "content",
    daily_cap: 50,
    window_start_hour: 8,
    window_end_hour: 20,
    timezone: "America/Sao_Paulo",
    event_cursor: null,
    ...p,
  };
}

interface Trace {
  automationId: string;
  sub: string;
  step: number;
  simulated: boolean;
}

/** Le double de `automation_due` (voir l'en-tête) et de la lecture des automations. */
class FausseBase implements AutomationDbLike {
  lignes: AutomationRecord[] = [];
  candidats = new Map<string, string[]>();
  traces: Trace[] = [];
  file: Trace[] = [];
  appels: { id: string; step: number; opts: DueOptions }[] = [];
  /** Retient `armed()` jusqu'à `relacher()` (passes concurrentes). */
  private retenue: Promise<void> | null = null;
  relacher: () => void = () => {};
  absente = false;

  retenir(): void {
    this.retenue = new Promise((r) => {
      this.relacher = r;
    });
  }

  async armed(): Promise<AutomationRecord[]> {
    if (this.absente) throw new AutomationsNotInstalled("PGRST205 automation");
    if (this.retenue) await this.retenue;
    // ⚠️ Rend TOUT, y compris `draft` et `paused` : c'est au moteur de les écarter lui-même.
    return this.lignes;
  }

  async due(id: string, step: number, opts: DueOptions): Promise<DueResult> {
    this.appels.push({ id, step, opts });
    const a = this.lignes.find((l) => l.id === id);
    if (!a) return { eligible: 0, allowed: 0, written: 0, simulated: true, daily_used: 0, reason: "not_found" };
    const simulated = !opts.liveAllowed;
    const pris = (sub: string, s: number) =>
      this.traces.some((t) => t.automationId === id && t.sub === sub && t.step === s);
    const eligibles = (this.candidats.get(id) ?? []).filter(
      (sub) =>
        !pris(sub, step) &&
        (step === 1 ||
          this.traces.some((t) => t.automationId === id && t.sub === sub && t.step === step - 1 && t.simulated === simulated)),
    );
    const used = this.traces.filter((t) => t.automationId === id && t.simulated === simulated).length;
    const allowed = Math.max(0, Math.min(opts.batch, 500, a.daily_cap - used));
    const base = { eligible: eligibles.length, allowed, simulated, daily_used: used };
    if (opts.probe) return { ...base, written: 0, reason: "probe" };
    if (eligibles.length === 0) return { ...base, written: 0, reason: "nobody" };
    if (allowed <= 0) return { ...base, written: 0, reason: "daily_cap_reached" };
    const lot = eligibles.slice(0, allowed);
    for (const sub of lot) {
      const t = { automationId: id, sub, step, simulated };
      this.traces.push(t);
      if (opts.liveAllowed) this.file.push(t);
    }
    return { ...base, written: lot.length, reason: simulated ? "simulated" : "written" };
  }
}

function opts(p: Partial<AutomationRunOptions> = {}): AutomationRunOptions {
  return { workerLive: true, allowlist: ["*"], confirmBaseUrl: "https://nf.invalid", probe: false, now: MIDI, ...p };
}

function base(lignes: AutomationRecord[], subs = ["s1", "s2", "s3"]): FausseBase {
  const db = new FausseBase();
  db.lignes = lignes;
  for (const l of lignes) db.candidats.set(String(l.id), subs);
  return db;
}

afterEach(() => {
  n = 0;
});

describe("témoin — une automation live, sur un worker live, enfile", () => {
  test("live + WORKER_MODE=live ⇒ 3 lignes en file, `p_live_allowed` vrai", async () => {
    const db = base([automation({ status: "live" })]);
    const r = await runAutomations(db, opts());
    expect(db.file).toHaveLength(3);
    expect(r.liveWritten).toBe(3);
    expect(db.appels.map((c) => c.opts.liveAllowed)).toEqual([true]);
  });
});

describe("⛔ rien d'autre que `live` n'écrit dans email_outbox", () => {
  test("simulation ⇒ traces simulées, AUCUNE ligne en file, `p_live_allowed` faux", async () => {
    const db = base([automation({ status: "simulation" })]);
    const r = await runAutomations(db, opts());
    expect(db.file).toEqual([]);
    expect(db.traces.map((t) => t.simulated)).toEqual([true, true, true]);
    expect(r.simulatedWritten).toBe(3);
    expect(db.appels.map((c) => c.opts.liveAllowed)).toEqual([false]);
  });

  test("draft ⇒ la fonction n'est même pas appelée", async () => {
    const db = base([automation({ status: "draft" })]);
    const r = await runAutomations(db, opts());
    expect(db.appels).toEqual([]);
    expect(db.file).toEqual([]);
    expect(r.automations[0]!.skipped).toBe("not_armed");
  });

  test("paused ⇒ rien, même si la lecture le renvoie", async () => {
    const db = base([automation({ status: "paused" })]);
    await runAutomations(db, opts());
    expect(db.appels).toEqual([]);
    expect(db.traces).toEqual([]);
  });

  test("live sur un worker en dry-run ⇒ NON appelée (sa simulation occuperait les créneaux réels)", async () => {
    const db = base([automation({ status: "live" })]);
    const r = await runAutomations(db, opts({ workerLive: false }));
    expect(db.appels).toEqual([]);
    expect(db.file).toEqual([]);
    expect(r.automations[0]!.skipped).toBe("drain_cannot_send");
  });

  test("sonde (PLANNER_SIMULATE) ⇒ `p_probe`, rien d'écrit, même pour une live", async () => {
    const db = base([automation({ status: "live" })]);
    const r = await runAutomations(db, opts({ probe: true }));
    expect(db.appels.map((c) => c.opts.probe)).toEqual([true]);
    expect(db.traces).toEqual([]);
    expect(r.liveWritten).toBe(0);
  });
});

describe("idempotence et concurrence", () => {
  test("deux passes successives ⇒ une seule ligne par personne", async () => {
    const db = base([automation({ status: "live" })], ["s1"]);
    await runAutomations(db, opts());
    await runAutomations(db, opts());
    expect(db.file).toHaveLength(1);
  });

  test("armer après une simulation ne rejoue pas le stock simulé", async () => {
    const a = automation({ status: "simulation" });
    const db = base([a], ["s1"]);
    await runAutomations(db, opts());
    a.status = "live";
    // Le double compte le créneau quel que soit le mode, comme l'index unique de 0082.
    await runAutomations(db, opts());
    expect(db.file).toEqual([]);
  });

  test("⛔ deux passes simultanées ⇒ la seconde rend la main sans rien lire", async () => {
    // ⚠️ Les deux passes sont lancées PUIS relâchées ensemble : sans le verrou, le banc rougit au
    // lieu de rester suspendu (la seconde attendrait une lecture que personne ne relâche).
    const db = base([automation({ status: "live" })]);
    db.retenir();
    const premiere = runAutomations(db, opts());
    const seconde = runAutomations(db, opts());
    db.relacher();
    const [r1, r2] = await Promise.all([premiere, seconde]);
    expect([r1.busy, r2.busy]).toEqual([false, true]);
    expect(db.appels).toHaveLength(1);
    expect(db.file).toHaveLength(3);
  });
});

describe("plafond", () => {
  test("⛔ le lot ne dépasse jamais le plafond du jour", async () => {
    const db = base([automation({ status: "live", daily_cap: 2 })]);
    await runAutomations(db, opts({ batch: 100 }));
    expect(db.appels.map((c) => c.opts.batch)).toEqual([2]);
  });

  test("trois passes le même jour, plafond 2, 5 candidats ⇒ 2 lignes", async () => {
    const db = base([automation({ status: "live", daily_cap: 2 })], ["s1", "s2", "s3", "s4", "s5"]);
    for (let i = 0; i < 3; i += 1) await runAutomations(db, opts());
    expect(db.file).toHaveLength(2);
  });

  test("plafond atteint à l'étape 1 ⇒ l'étape 2 n'est pas appelée", async () => {
    const steps = [
      { delay_hours: 1, template_version_id: TV },
      { delay_hours: 48, template_version_id: TV },
    ];
    // Passe 1 : l'étape 1 prend 2 places sur 2, l'étape 2 trouve le plafond atteint.
    // Passe 2 : l'étape 1 trouve le plafond atteint ⇒ l'étape 2 n'est plus appelée.
    const db = base([automation({ status: "live", trigger: "welcome_back", daily_cap: 2, steps })]);
    await runAutomations(db, opts());
    await runAutomations(db, opts());
    expect(db.appels.map((c) => c.step)).toEqual([1, 2, 1]);
  });
});

describe("ce que le moteur écarte avant tout appel", () => {
  test("une automation invalide ⇒ écartée, signalée, jamais appelée", async () => {
    const db = base([automation({ status: "live", filters: { optin_id: ["x"] } })]);
    const r = await runAutomations(db, opts());
    expect(db.appels).toEqual([]);
    expect(r.invalid).toHaveLength(1);
  });

  test("hors fenêtre horaire (02:00 UTC = 23:00 à São Paulo) ⇒ pas d'appel", async () => {
    const db = base([automation({ status: "live" })]);
    const r = await runAutomations(db, opts({ now: new Date("2026-09-24T02:00:00Z") }));
    expect(db.appels).toEqual([]);
    expect(r.automations[0]!.skipped).toBe("outside_window");
  });

  test("le sunset (silencieux) ignore la fenêtre : il n'envoie rien", async () => {
    const sunset = automation({
      status: "simulation",
      trigger: "sunset",
      purpose: null,
      steps: [{ delay_hours: 4320 }],
    });
    const db = base([sunset]);
    await runAutomations(db, opts({ now: new Date("2026-09-24T02:00:00Z") }));
    expect(db.appels).toHaveLength(1);
  });

  test("la règle système n'est jamais exécutée", async () => {
    const db = base([automation({ status: "simulation", trigger: "soft_bounce_rule", purpose: null, steps: [] })]);
    await runAutomations(db, opts());
    expect(db.appels).toEqual([]);
  });

  test("0082 absente ⇒ `notInstalled`, aucune erreur levée", async () => {
    const db = base([automation({ status: "live" })]);
    db.absente = true;
    const r = await runAutomations(db, opts());
    expect(r.notInstalled).toBe(true);
    expect(r.failures).toEqual([]);
  });

  test("une automation en erreur n'arrête pas les suivantes", async () => {
    const a = automation({ status: "live" });
    const b = automation({ status: "live" });
    const db = base([a, b]);
    const original = db.due.bind(db);
    db.due = async (id, step, o) => {
      if (id === a.id) throw new Error("boom");
      return original(id, step, o);
    };
    const r = await runAutomations(db, opts());
    expect(r.failures).toHaveLength(1);
    expect(db.file).toHaveLength(3);
  });
});

describe("AutomationDb — la requête et l'appel portent bien les filtres", () => {
  function client(reponse: { data?: unknown; error?: unknown }) {
    const appels: { methode: string; args: unknown[] }[] = [];
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resoudre: (v: unknown) => void) => resoudre({ data: reponse.data ?? null, error: reponse.error ?? null });
          }
          return (...args: unknown[]) => {
            appels.push({ methode: prop, args });
            return proxy;
          };
        },
      },
    );
    const db = Object.create(AutomationDb.prototype) as AutomationDb;
    (db as unknown as { sb: unknown }).sb = proxy;
    return { db, appels };
  }

  test("⛔ seules `simulation` et `live` sont lues", async () => {
    const { db, appels } = client({ data: [] });
    await db.armed();
    expect(appels.find((a) => a.methode === "in")?.args).toEqual(["status", ["simulation", "live"]]);
  });

  test("l'appel transmet `p_live_allowed` et `p_probe` tels quels", async () => {
    const { db, appels } = client({ data: [{ eligible: 1, allowed: 1, written: 1, simulated: false, daily_used: 0, reason: "written" }] });
    const r = await db.due("id-1", 2, { batch: 5, allowlist: ["*"], liveAllowed: false, confirmBaseUrl: null, probe: true });
    const rpc = appels.find((a) => a.methode === "rpc");
    expect(rpc?.args[0]).toBe("automation_due");
    expect(rpc?.args[1]).toEqual({
      p_automation_id: "id-1",
      p_step: 2,
      p_batch: 5,
      p_allowlist: ["*"],
      p_live_allowed: false,
      p_confirm_base_url: null,
      p_probe: true,
    });
    expect(r.written).toBe(1);
  });

  test("table absente ⇒ `AutomationsNotInstalled` ; autre erreur ⇒ erreur ordinaire", async () => {
    const absente = client({ error: { code: "PGRST205", message: "not found" } });
    await expect(absente.db.armed()).rejects.toBeInstanceOf(AutomationsNotInstalled);
    const cassee = client({ error: { code: "42501", message: "denied" } });
    let e: unknown = null;
    try {
      await cassee.db.armed();
    } catch (x) {
      e = x;
    }
    expect(e instanceof Error && !(e instanceof AutomationsNotInstalled)).toBe(true);
  });

  test("une réponse sans `simulated` vaut simulée (jamais « réel » par défaut)", async () => {
    const { db } = client({ data: [{ written: 2 }] });
    const r = await db.due("id-1", 1, { batch: 5, allowlist: [], liveAllowed: false, confirmBaseUrl: null, probe: false });
    expect(r.simulated).toBe(true);
  });
});
