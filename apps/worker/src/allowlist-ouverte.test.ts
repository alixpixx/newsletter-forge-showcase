/**
 * Banc de `WORKER_ALLOWLIST=*` — la mise en production du worker.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER (21/09/2026) :
 *  - que la liste blanche redevienne un filet SANS SORTIE : aucune configuration ne permettait
 *    d'écrire à un vrai abonné, pas même la confirmation de son inscription ;
 *  - que `*` ouvre l'envoi depuis le bac à sable, où chaque vrai abonné partirait en échec ;
 *  - que l'ouverture affaiblisse le refus historique d'une liste VIDE.
 *
 * Chaque garde est prouvée par SON message : un refus qui passerait grâce au message d'une garde
 * voisine ne prouverait rien.
 */
import { describe, expect, test } from "bun:test";
import type { Db, OutboxContext } from "./db";
import type { WorkerConfig } from "./env";
import type { Mailgun, SendMessage } from "./mailgun";

const { parseWorkerEnv, ALLOWLIST_OUVERTE } = await import("./env");
const { processRow } = await import("./process");

const NOW = new Date("2026-09-21T12:00:00Z");

// ---------------------------------------------------------------------------------------------
// parseWorkerEnv : les gardes de boot
// ---------------------------------------------------------------------------------------------

const ENV_LIVE = {
  SUPABASE_URL: "https://db.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "x",
  PUBLIC_BASE_URL: "https://nf.invalid",
  TOKEN_SECRET: "secret-de-banc-qui-n-est-pas-celui-de-dev",
  MAILGUN_API_KEY: "k",
  MAILGUN_SANDBOX_DOMAIN: "sandbox.mg.invalid",
  WORKER_MODE: "live",
} as NodeJS.ProcessEnv;

/** `parseWorkerEnv` imprime l'empreinte du secret au boot : on la tait le temps d'un appel. */
function parser(env: NodeJS.ProcessEnv): WorkerConfig {
  const info = console.info;
  const warn = console.warn;
  console.info = () => {};
  console.warn = () => {};
  try {
    return parseWorkerEnv(env);
  } finally {
    console.info = info;
    console.warn = warn;
  }
}

describe("boot : WORKER_ALLOWLIST=*", () => {
  test("`*` en live avec des domaines vérifiés (asset) : le worker démarre, liste ouverte", () => {
    const cfg = parser({ ...ENV_LIVE, WORKER_SENDING_MODE: "asset", WORKER_ALLOWLIST: "*" });
    expect(cfg.allowlist.has(ALLOWLIST_OUVERTE)).toBe(true);
  });

  test("les espaces autour de `*` ne changent rien", () => {
    const cfg = parser({ ...ENV_LIVE, WORKER_SENDING_MODE: "asset", WORKER_ALLOWLIST: "  *  " });
    expect(cfg.allowlist.has(ALLOWLIST_OUVERTE)).toBe(true);
  });

  test("⛔ `*` en live depuis le bac à sable : refus de démarrer, par SON message", () => {
    let message = "";
    try {
      parser({ ...ENV_LIVE, WORKER_SENDING_MODE: "sandbox", WORKER_ALLOWLIST: "*" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("WORKER_ALLOWLIST=*");
    expect(message).toContain("sandbox");
    // Pas le refus d'une garde voisine.
    expect(message).not.toContain("VIDE");
    expect(message).not.toContain("MAILGUN_API_KEY");
  });

  test("`*` en dry-run depuis le bac à sable : aucun refus (la garde ne vaut qu'en live)", () => {
    const cfg = parser({ ...ENV_LIVE, WORKER_MODE: "dry-run", WORKER_SENDING_MODE: "sandbox", WORKER_ALLOWLIST: "*" });
    expect(cfg.allowlist.has(ALLOWLIST_OUVERTE)).toBe(true);
  });

  test("une liste restreinte depuis le bac à sable démarre toujours (rien n'a changé pour elle)", () => {
    const cfg = parser({ ...ENV_LIVE, WORKER_SENDING_MODE: "sandbox", WORKER_ALLOWLIST: "staff.invalid" });
    expect(cfg.allowlist.has(ALLOWLIST_OUVERTE)).toBe(false);
  });

  test("⛔ la liste VIDE reste refusée en live — l'ouverture n'est pas l'absence de liste", () => {
    expect(() => parser({ ...ENV_LIVE, WORKER_SENDING_MODE: "asset", WORKER_ALLOWLIST: "" })).toThrow(/VIDE/);
    expect(() => parser({ ...ENV_LIVE, WORKER_SENDING_MODE: "asset" })).toThrow(/VIDE/);
  });
});

// ---------------------------------------------------------------------------------------------
// processRow : ce que la liste ouverte laisse passer
// ---------------------------------------------------------------------------------------------

function cfg(allowlist: string[], p: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: "https://db.invalid",
    serviceRoleKey: "x",
    tokenSecret: undefined,
    mailgun: { apiKey: "k", region: "eu", sandboxDomain: "sandbox.mg.invalid", fromLocalpart: "news", timeoutMs: 1000 },
    mode: "live",
    sendingMode: "asset",
    allowlist: new Set(allowlist),
    oneClick: true,
    workerId: "w-test",
    publicBaseUrl: "https://nf.invalid",
    messageIdHost: "nf.invalid",
    runOnce: true,
    pollIntervalMs: 1000,
    batchSize: 10,
    maxPerRun: 10,
    maxInteractivePerWindow: 200,
    staleLockSeconds: 600,
    slackWebhookUrl: undefined,
    ...p,
  };
}

function ctx(p: Partial<OutboxContext> = {}): OutboxContext {
  return {
    id: "o1",
    kind: "welcome",
    subject: "Bienvenue",
    action_url: null,
    payload: { first_name: "Ana" },
    to_email: "bob@mailbox.invalid",
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: "2026-09-20T12:00:00Z",
    created_at: "2026-09-20T12:00:00Z",
    asset_id: "asset-1",
    subscription_id: "sub-1",
    asset_name: "Quartz Tips",
    asset_slug: "quartz-tips",
    sending_subdomain: "news.quartz-tips.invalid",
    compliance_regime: "gdpr",
    legal_footer: { physical_address: "1 rue X", privacy_url: "https://x.invalid/privacy", controller: "X" },
    language: "fr",
    sub_status: "active",
    subscriber_id: "subr-1",
    tracking_consent: false,
    suppressed: false,
    purpose: null,
    market: null,
    consent_mode: null,
    granted_purposes: null,
    campaign_id: null,
    template_version_id: null,
    ...p,
  } as OutboxContext;
}

async function lancer(c: OutboxContext, conf: WorkerConfig) {
  const ecritures: { m: string; args: unknown[] }[] = [];
  const envois: SendMessage[] = [];
  const noter = (m: string) => async (...args: unknown[]) => {
    ecritures.push({ m, args });
  };
  const db = {
    markSent: noter("markSent"),
    markFailed: noter("markFailed"),
    markSkipped: noter("markSkipped"),
    release: noter("release"),
    etatLienConfirmation: async () => "valide" as const,
  } as unknown as Db;
  const mailgun = {
    send: async (m: SendMessage) => {
      envois.push(m);
      return { ok: true, id: "<20260921.abc@news.quartz-tips.invalid>" };
    },
  } as unknown as Mailgun;

  const lignes: Record<string, unknown>[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => {
    try {
      const l = JSON.parse(String(a[0])) as Record<string, unknown>;
      if (l.event === "row") lignes.push(l);
    } catch {
      /* ignoré */
    }
  };
  try {
    await processRow(c, conf, db, mailgun, NOW);
  } finally {
    console.log = original;
  }
  return { ecritures, envois, lignes };
}

const CONFIRMATION: Partial<OutboxContext> = {
  kind: "confirmation",
  action_url: "https://nf.invalid/confirm?t=x",
  sub_status: "pending",
};

describe("live : la liste ouverte laisse passer un vrai abonné", () => {
  test("contrôle : liste restreinte à l'équipe ⇒ l'abonné est écarté en terminal", async () => {
    const r = await lancer(ctx(), cfg(["staff.invalid"]));
    expect(r.envois).toEqual([]);
    expect(r.ecritures).toEqual([{ m: "markSkipped", args: ["o1", "not_allowlisted"] }]);
  });

  test("`*` ⇒ le même abonné reçoit son e-mail", async () => {
    const r = await lancer(ctx(), cfg([ALLOWLIST_OUVERTE]));
    expect(r.envois).toHaveLength(1);
    expect(r.envois[0]!.to).toBe("bob@mailbox.invalid");
    expect(r.lignes.map((l) => l.decision)).toEqual(["sent"]);
  });

  test("⛔ contrôle : sans `*`, la CONFIRMATION d'une vraie inscription est écartée elle aussi", async () => {
    const r = await lancer(ctx(CONFIRMATION), cfg(["staff.invalid"]));
    expect(r.envois).toEqual([]);
    expect(r.ecritures).toEqual([{ m: "markSkipped", args: ["o1", "not_allowlisted"] }]);
  });

  test("`*` ⇒ la confirmation d'une vraie inscription part", async () => {
    const r = await lancer(ctx(CONFIRMATION), cfg([ALLOWLIST_OUVERTE]));
    expect(r.envois).toHaveLength(1);
    expect(r.lignes.map((l) => l.decision)).toEqual(["sent"]);
  });

  test("dry-run avec `*` : journalisé `allowlisted:true`, rien envoyé ni écrit", async () => {
    const r = await lancer(ctx(), cfg([ALLOWLIST_OUVERTE], { mode: "dry-run" }));
    expect(r.lignes[0]!.allowlisted).toBe(true);
    expect(r.envois).toEqual([]);
    expect(r.ecritures).toEqual([]);
  });

  test("un `*` au milieu d'une entrée n'ouvre rien : seul le `*` entier ouvre", async () => {
    const r = await lancer(ctx(), cfg(["*@mailbox.invalid", "mailbox.*"]));
    expect(r.envois).toEqual([]);
    expect(r.ecritures).toEqual([{ m: "markSkipped", args: ["o1", "not_allowlisted"] }]);
  });
});
