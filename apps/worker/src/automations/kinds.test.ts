/**
 * Les deux kinds d'automation (0082) à la porte, au rendu et à l'envoi.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER :
 *  - un `automation` (marketing) qui part sans finalité, ou vers un abonnement non `active` ;
 *  - un `automation_tx` qui passe la porte `not_active` pour un autre déclencheur que les deux
 *    prévus, ou vers une souscription au mauvais statut ;
 *  - une relance de confirmation sans lien, ou avec un lien mort ;
 *  - un e-mail d'automation marketing sans `List-Unsubscribe`.
 * Chaque refus a son témoin (la même ligne, corrigée, part).
 */
import { describe, expect, test } from "bun:test";
import type { Db, OutboxContext } from "../db";
import type { WorkerConfig } from "../env";
import type { Mailgun, SendMessage } from "../mailgun";
import { gate } from "../gate";
import { render } from "../render";
import { processRow } from "../process";

const NOW = new Date("2026-09-24T12:00:00Z");
const SHELL = '<p>Hi {{first_name}}</p><a href="{{confirm_url}}">Confirm</a>{{legal_footer_html}}';
const SHELL_SANS_LIEN = "<p>Hi {{first_name}}</p>{{legal_footer_html}}";

function cfg(p: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: "https://db.invalid",
    serviceRoleKey: "x",
    tokenSecret: undefined,
    mailgun: { apiKey: "k", region: "eu", sandboxDomain: "sandbox.mg.invalid", fromLocalpart: "news", timeoutMs: 1000 },
    mode: "live",
    sendingMode: "asset",
    allowlist: new Set(["*"]),
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

/** Une automation marketing envoyable, mise en file une heure avant NOW. */
function marketing(p: Partial<OutboxContext> = {}): OutboxContext {
  return {
    id: "o1",
    kind: "automation",
    subject: "Happy anniversary",
    action_url: null,
    payload: { automation_id: "a1", automation_trigger: "anniversary", automation_step: 1, first_name: "Ana" },
    to_email: "alice@example.invalid",
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: "2026-09-24T11:00:00Z",
    created_at: "2026-09-24T11:00:00Z",
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
    hard_suppressed: false,
    purpose: "content",
    market: null,
    consent_mode: null,
    granted_purposes: { content: true },
    campaign_id: null,
    template_version_id: "tv-1",
    template_html_shell: SHELL,
    template_text_shell: null,
    ...p,
  } as OutboxContext;
}

/** Une relance de confirmation envoyable. */
function relance(p: Partial<OutboxContext> = {}): OutboxContext {
  return marketing({
    kind: "automation_tx",
    subject: "Confirm your subscription",
    purpose: null,
    granted_purposes: null,
    sub_status: "pending",
    action_url: "https://nf.invalid/confirm?token=abc&lang=fr",
    payload: { automation_id: "a2", automation_trigger: "confirmation_reminder", automation_step: 1 },
    ...p,
  });
}

describe("porte — automation (marketing)", () => {
  test("témoin : active + finalité accordée ⇒ part", () => {
    expect(gate(marketing(), NOW)).toEqual({ send: true, track: false });
  });

  test("⛔ sans finalité ⇒ missing_purpose (canSend ne relirait aucun consentement)", () => {
    expect(gate(marketing({ purpose: null }), NOW)).toEqual({ send: false, reason: "missing_purpose" });
  });

  test("finalité non accordée ⇒ refus", () => {
    expect(gate(marketing({ granted_purposes: { content: false } }), NOW).send).toBe(false);
  });

  test("abonnement non actif ⇒ refus", () => {
    expect(gate(marketing({ sub_status: "pending" }), NOW).send).toBe(false);
  });

  test("supprimé ⇒ refus", () => {
    expect(gate(marketing({ suppressed: true }), NOW)).toEqual({ send: false, reason: "suppressed" });
  });

  test("suivi seulement avec le consentement de suivi", () => {
    expect(gate(marketing({ tracking_consent: true }), NOW)).toEqual({ send: true, track: true });
  });
});

describe("porte — automation_tx (transactionnel strict, borné au déclencheur)", () => {
  test("témoin : relance vers une souscription `pending` ⇒ part, sans suivi", () => {
    expect(gate(relance({ tracking_consent: true }), NOW)).toEqual({ send: true, track: false });
  });

  test("⛔ relance vers une souscription confirmée entre-temps ⇒ not_pending", () => {
    expect(gate(relance({ sub_status: "active" }), NOW)).toEqual({ send: false, reason: "not_pending" });
  });

  test("témoin : renouvellement vers une souscription `active` ⇒ part", () => {
    const c = relance({ sub_status: "active", payload: { automation_id: "a3", automation_trigger: "consent_renewal" } });
    expect(gate(c, NOW).send).toBe(true);
  });

  test("⛔ renouvellement vers une souscription désinscrite ⇒ not_active", () => {
    const c = relance({ sub_status: "unsubscribed", payload: { automation_id: "a3", automation_trigger: "consent_renewal" } });
    expect(gate(c, NOW)).toEqual({ send: false, reason: "not_active" });
  });

  for (const declencheur of ["anniversary", "reengagement", "", undefined, "__proto__", "toString"]) {
    test(`⛔ déclencheur ${JSON.stringify(declencheur)} ⇒ tx_trigger_not_allowed`, () => {
      const c = relance({ payload: { automation_id: "a4", automation_trigger: declencheur } });
      expect(gate(c, NOW)).toEqual({ send: false, reason: "tx_trigger_not_allowed" });
    });
  }

  test("⛔ payload absent ⇒ tx_trigger_not_allowed", () => {
    expect(gate(relance({ payload: null }), NOW)).toEqual({ send: false, reason: "tx_trigger_not_allowed" });
  });

  test("⛔ TOUTE suppression arrête, même souple (pas d'exception « dure seule » ici)", () => {
    expect(gate(relance({ suppressed: true, hard_suppressed: false }), NOW)).toEqual({ send: false, reason: "suppressed" });
  });
});

describe("rendu", () => {
  test("témoin : le modèle de l'étape est hydraté, lien de confirmation compris", () => {
    const r = render(relance(), "https://nf.invalid");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email.html).toContain("https://nf.invalid/confirm?token=abc&amp;lang=fr");
  });

  test("⛔ relance sans `action_url` ⇒ missing_action_url", () => {
    expect(render(relance({ action_url: null }), "https://nf.invalid")).toEqual({ ok: false, reason: "missing_action_url" });
  });

  test("⛔ relance dont le modèle n'imprime pas le lien ⇒ missing_confirm_link", () => {
    expect(render(relance({ template_html_shell: SHELL_SANS_LIEN }), "https://nf.invalid")).toEqual({
      ok: false,
      reason: "missing_confirm_link",
    });
  });

  test("une automation marketing n'exige pas de lien de confirmation", () => {
    expect(render(marketing({ template_html_shell: SHELL_SANS_LIEN }), "https://nf.invalid").ok).toBe(true);
  });

  test("⛔ modèle absent ⇒ no_compiled_shell (aucun repli en dur)", () => {
    expect(render(marketing({ template_html_shell: null }), "https://nf.invalid")).toEqual({
      ok: false,
      reason: "no_compiled_shell",
    });
  });

  test("modèle sans bloc de footer ⇒ footer incomplet signalé", () => {
    const r = render(marketing({ template_html_shell: "<p>x</p>" }), "https://nf.invalid");
    expect(r.ok && r.email.footerMissing).toContain("legal_footer_block");
  });
});

describe("envoi", () => {
  function banc(jeton: "valide" | "expire" = "valide") {
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
      etatLienConfirmation: async () => jeton,
    } as unknown as Db;
    const mailgun = {
      send: async (m: SendMessage) => {
        envois.push(m);
        return { ok: true, id: "<x@news.quartz-tips.invalid>" };
      },
    } as unknown as Mailgun;
    return { db, mailgun, ecritures, envois };
  }

  async function lancer(c: OutboxContext, b: ReturnType<typeof banc>) {
    const original = console.log;
    console.log = () => {};
    try {
      await processRow(c, cfg(), b.db, b.mailgun, NOW);
    } finally {
      console.log = original;
    }
  }

  test("⛔ automation marketing ⇒ List-Unsubscribe + one-click", async () => {
    const b = banc();
    await lancer(marketing(), b);
    expect(b.envois).toHaveLength(1);
    expect(b.envois[0]!.listUnsub).toMatch(/^<https:\/\/nf\.invalid\/unsubscribe\?token=[^>]+>$/);
    expect(b.envois[0]!.oneClick).toBe(true);
  });

  /*
   * 0085 — le suivi MÉMORISÉ est celui qui a été DEMANDÉ à Mailgun, jamais recalculé ailleurs : c'est
   * le dénominateur des taux d'ouverture et de clic de l'écran Analytics.
   */
  test.each([true, false])("le suivi mémorisé par markSent est celui transmis à Mailgun (consentement %p)", async (consent) => {
    const b = banc();
    await lancer(marketing({ tracking_consent: consent }), b);
    expect(b.envois).toHaveLength(1);
    expect(b.envois[0]!.track).toBe(consent);
    expect(b.ecritures).toEqual([{ m: "markSent", args: ["o1", "x@news.quartz-tips.invalid", consent] }]);
  });

  test("relance ⇒ pas de List-Unsubscribe (rien à désinscrire)", async () => {
    const b = banc();
    await lancer(relance(), b);
    expect(b.envois).toHaveLength(1);
    expect(b.envois[0]!.listUnsub).toBeUndefined();
  });

  test("⛔ relance dont le dernier jeton a expiré ⇒ skipped doi_token_expire, aucun envoi", async () => {
    const b = banc("expire");
    await lancer(relance(), b);
    expect(b.envois).toEqual([]);
    expect(b.ecritures).toEqual([{ m: "markSkipped", args: ["o1", "doi_token_expire"] }]);
  });

  test("le jeton n'est pas relu pour un renouvellement", async () => {
    const b = banc("expire");
    await lancer(relance({ sub_status: "active", payload: { automation_id: "a3", automation_trigger: "consent_renewal" } }), b);
    expect(b.envois).toHaveLength(1);
  });
});
