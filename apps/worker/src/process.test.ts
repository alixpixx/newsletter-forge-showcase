/**
 * Banc de `processRow` — la dernière fonction avant qu'un e-mail parte.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER (il n'existait pas au 16/09) :
 *  - un dry-run qui écrit en base ou appelle Mailgun (la bascule dry-run → live doit être le SEUL
 *    geste qui envoie) ;
 *  - une adresse hors liste blanche qui part en live ;
 *  - un envoi réussi stocké sous une forme d'identifiant que le webhook ne retrouvera pas ;
 *  - un échec d'envoi marqué « envoyé », ou une lecture de jeton en erreur transformée en skip.
 *
 * Aucun `mock.module` : la base et Mailgun sont PASSÉS à la fonction (doubles ci-dessous), l'horloge
 * aussi. Les lignes de journal sont lues en remplaçant `console.log` le temps d'un appel.
 */
import { describe, expect, test } from "bun:test";
import type { Db, OutboxContext } from "./db";
import type { WorkerConfig } from "./env";
import type { Mailgun, SendMessage, SendResult } from "./mailgun";

const { processRow } = await import("./process");

const NOW = new Date("2026-09-16T12:00:00Z");

function cfg(p: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: "https://db.invalid",
    serviceRoleKey: "x",
    tokenSecret: undefined,
    mailgun: { apiKey: "k", region: "eu", sandboxDomain: "sandbox.mg.invalid", fromLocalpart: "news", timeoutMs: 1000 },
    mode: "live",
    sendingMode: "asset",
    allowlist: new Set(["staff.invalid", "alice@example.invalid"]),
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

/** Une ligne `welcome` envoyable, mise en file la veille de NOW. */
function ctx(p: Partial<OutboxContext> = {}): OutboxContext {
  return {
    id: "o1",
    kind: "welcome",
    subject: "Bienvenue",
    action_url: null,
    payload: { first_name: "Ana" },
    to_email: "alice@example.invalid",
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: "2026-09-15T12:00:00Z",
    created_at: "2026-09-15T12:00:00Z",
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

interface Banc {
  db: Db;
  mailgun: Mailgun;
  ecritures: { m: string; args: unknown[] }[];
  envois: SendMessage[];
}

function banc(opts: { envoi?: SendResult; jeton?: Awaited<ReturnType<Db["etatLienConfirmation"]>> | Error } = {}): Banc {
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
    etatLienConfirmation: async () => {
      if (opts.jeton instanceof Error) throw opts.jeton;
      return opts.jeton ?? "valide";
    },
  } as unknown as Db;
  const mailgun = {
    send: async (m: SendMessage) => {
      envois.push(m);
      return opts.envoi ?? { ok: true, id: "<20260916.abc@news.quartz-tips.invalid>" };
    },
  } as unknown as Mailgun;
  return { db, mailgun, ecritures, envois };
}

/** Lance `processRow` et rend les lignes de journal `row` qu'il a écrites. */
async function lancer(c: OutboxContext, conf: WorkerConfig, b: Banc, now = NOW) {
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
    await processRow(c, conf, b.db, b.mailgun, now);
  } finally {
    console.log = original;
  }
  return lignes;
}

const decisions = (lignes: Record<string, unknown>[]) => lignes.map((l) => `${l.decision}${l.reason ? `:${l.reason}` : ""}`);

describe("dry-run : jamais d'écriture, jamais d'envoi", () => {
  test("contrôle positif : une ligne envoyable est journalisée `would_send`, allowlistée", async () => {
    const b = banc();
    const lignes = await lancer(ctx(), cfg({ mode: "dry-run" }), b);
    expect(decisions(lignes)).toEqual(["would_send"]);
    expect(lignes[0]!.allowlisted).toBe(true);
    expect(lignes[0]!.domain).toBe("news.quartz-tips.invalid");
    expect(b.envois).toEqual([]);
    expect(b.ecritures).toEqual([]);
  });

  test("porte refusée ⇒ `would_skip`, aucune écriture", async () => {
    const b = banc();
    const lignes = await lancer(ctx({ suppressed: true }), cfg({ mode: "dry-run" }), b);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.decision).toBe("would_skip");
    expect(b.ecritures).toEqual([]);
    expect(b.envois).toEqual([]);
  });

  test("hors liste blanche en dry-run : journalisé `allowlisted:false`, rien d'autre", async () => {
    const b = banc();
    const lignes = await lancer(ctx({ to_email: "bob@mailbox.invalid" }), cfg({ mode: "dry-run" }), b);
    expect(decisions(lignes)).toEqual(["would_send"]);
    expect(lignes[0]!.allowlisted).toBe(false);
    expect(b.ecritures).toEqual([]);
  });

  test("confirmation au jeton expiré ⇒ `would_skip doi_token_expire`, sans écriture", async () => {
    const b = banc({ jeton: "expire" });
    const c = ctx({ kind: "confirmation", action_url: "https://nf.invalid/confirm?t=x", sub_status: "pending" });
    expect(decisions(await lancer(c, cfg({ mode: "dry-run" }), b))).toEqual(["would_skip:doi_token_expire"]);
    expect(b.ecritures).toEqual([]);
  });
});

describe("live : la liste blanche est fermée par défaut", () => {
  for (const [adresse, attendu] of [
    ["alice@example.invalid", true],
    ["ALICE@Example.Invalid", true],
    ["someone@staff.invalid", true],
    ["bob@example.invalid", false],
    ["x@sub.staff.invalid", false],
    ["staff.invalid@evil.invalid", false],
  ] as [string, boolean][]) {
    test(`${adresse} ⇒ ${attendu ? "envoyé" : "skipped not_allowlisted"}`, async () => {
      const b = banc();
      const lignes = await lancer(ctx({ to_email: adresse }), cfg(), b);
      if (attendu) {
        expect(b.envois).toHaveLength(1);
        expect(decisions(lignes)).toEqual(["sent"]);
      } else {
        expect(b.envois).toEqual([]);
        expect(b.ecritures).toEqual([{ m: "markSkipped", args: ["o1", "not_allowlisted"] }]);
      }
    });
  }
});

describe("live : l'envoi", () => {
  test("⛔ l'identifiant est stocké SANS chevrons, et le message porte ce que le webhook relira", async () => {
    const b = banc();
    await lancer(ctx({ campaign_id: "camp-1" } as Partial<OutboxContext>), cfg(), b);
    expect(b.envois).toHaveLength(1);
    const m = b.envois[0]!;
    expect(m.messageId).toBe("o1");
    expect(m.domain).toBe("news.quartz-tips.invalid");
    expect(m.from).toBe('"Quartz Tips" <news@news.quartz-tips.invalid>');
    expect(m.track).toBe(false);
    expect(m.vars).toEqual({ outbox_id: "o1", kind: "welcome", campaign_id: "camp-1" });
    expect(b.ecritures).toEqual([{ m: "markSent", args: ["o1", "20260916.abc@news.quartz-tips.invalid", false] }]);
  });

  test("welcome avec abonnement ⇒ List-Unsubscribe + one-click transmis", async () => {
    const b = banc();
    await lancer(ctx(), cfg({ oneClick: true }), b);
    expect(b.envois[0]!.listUnsub).toMatch(/^<https:\/\/nf\.invalid\/unsubscribe\?token=[^>]+>$/);
    expect(b.envois[0]!.oneClick).toBe(true);
  });

  test("confirmation ⇒ pas de List-Unsubscribe (rien à désinscrire)", async () => {
    const b = banc();
    const c = ctx({ kind: "confirmation", action_url: "https://nf.invalid/confirm?t=x", sub_status: "pending" });
    await lancer(c, cfg(), b);
    expect(b.envois).toHaveLength(1);
    expect(b.envois[0]!.listUnsub).toBeUndefined();
  });

  for (const retryable of [true, false]) {
    test(`échec d'envoi (retryable=${retryable}) ⇒ markFailed, jamais markSent`, async () => {
      const b = banc({ envoi: { ok: false, retryable, error: "HTTP 500" } });
      const lignes = await lancer(ctx(), cfg(), b);
      expect(b.ecritures).toEqual([{ m: "markFailed", args: ["o1", "HTTP 500", retryable] }]);
      expect(decisions(lignes)).toEqual(["failed:HTTP 500"]);
    });
  }

  test("ligne vieille de 8 jours ⇒ skipped stale_outbox, aucun envoi", async () => {
    const b = banc();
    await lancer(ctx({ created_at: "2026-09-08T11:00:00Z" }), cfg(), b);
    expect(b.envois).toEqual([]);
    expect(b.ecritures).toHaveLength(1);
    expect(b.ecritures[0]!.m).toBe("markSkipped");
    expect(String(b.ecritures[0]!.args[1])).toMatch(/^stale_outbox:/);
  });
});

describe("live : les refus avant l'envoi", () => {
  test("mode sandbox sans domaine sandbox ⇒ no_sending_domain", async () => {
    const b = banc();
    const conf = cfg({ sendingMode: "sandbox" });
    conf.mailgun = { ...conf.mailgun, sandboxDomain: undefined };
    await lancer(ctx(), conf, b);
    expect(b.ecritures).toEqual([{ m: "markSkipped", args: ["o1", "no_sending_domain"] }]);
    expect(b.envois).toEqual([]);
  });

  test("mode asset sans sous-domaine d'envoi ⇒ no_sending_domain", async () => {
    const b = banc();
    await lancer(ctx({ sending_subdomain: null }), cfg(), b);
    expect(b.ecritures).toEqual([{ m: "markSkipped", args: ["o1", "no_sending_domain"] }]);
  });

  for (const etat of ["absent", "expire", "deja_confirme"] as const) {
    test(`confirmation, jeton ${etat} ⇒ doi_token_${etat}`, async () => {
      const b = banc({ jeton: etat });
      const c = ctx({ kind: "confirmation", action_url: "https://nf.invalid/confirm?t=x", sub_status: "pending" });
      await lancer(c, cfg(), b);
      expect(b.ecritures).toEqual([{ m: "markSkipped", args: ["o1", `doi_token_${etat}`] }]);
      expect(b.envois).toEqual([]);
    });
  }

  test("⛔ une lecture de jeton en ERREUR remonte, elle ne devient pas un skip", async () => {
    const b = banc({ jeton: new Error("doi_token: timeout") });
    const c = ctx({ kind: "confirmation", action_url: "https://nf.invalid/confirm?t=x", sub_status: "pending" });
    await expect(lancer(c, cfg(), b)).rejects.toThrow("doi_token: timeout");
    expect(b.ecritures).toEqual([]);
    expect(b.envois).toEqual([]);
  });

  test("confirmation sans lien ⇒ missing_action_url (rendu refusé)", async () => {
    const b = banc();
    await lancer(ctx({ kind: "confirmation", action_url: null, sub_status: "pending" }), cfg(), b);
    expect(b.ecritures).toEqual([{ m: "markSkipped", args: ["o1", "missing_action_url"] }]);
  });

  test("pied légal sans lien de confidentialité ⇒ footer_incomplete:privacy_url, aucun envoi", async () => {
    const b = banc();
    await lancer(ctx({ legal_footer: { physical_address: "1 rue X", controller: "X" } } as Partial<OutboxContext>), cfg(), b);
    expect(b.envois).toEqual([]);
    expect(b.ecritures).toEqual([{ m: "markSkipped", args: ["o1", "footer_incomplete:privacy_url"] }]);
  });
});
