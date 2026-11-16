/**
 * Banc du HTML de secours des e-mails de cycle de vie, et de l'alerte quand un modèle rattaché y
 * retombe (inventaire du 22/09/2026, éléments 110 à 114 ; décision d'Alix n° 2).
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER :
 *  - un e-mail de confirmation signé « newsletter·forge » en rose vif, alors que l'abonné s'est
 *    inscrit chez une marque dont il n'a jamais vu ce nom ;
 *  - un modèle rattaché qui retombe EN SILENCE sur ce secours : la marque croit envoyer son e-mail,
 *    et ne l'apprend que d'un abonné.
 */
import { describe, expect, test } from "bun:test";
import type { Db, OutboxContext } from "./db";
import type { WorkerConfig } from "./env";
import type { Mailgun, SendMessage } from "./mailgun";

const { render } = await import("./render");
const { processRow } = await import("./process");

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
    next_attempt_at: "2026-09-22T11:00:00Z",
    created_at: "2026-09-22T11:00:00Z",
    asset_id: "asset-repli",
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

const KINDS: [string, Partial<OutboxContext>][] = [
  ["confirmation", { kind: "confirmation", action_url: "https://nf.invalid/confirm?t=x&l=fr", sub_status: "pending" }],
  ["welcome", { kind: "welcome" }],
  ["unsubscribe_ack", { kind: "unsubscribe_ack" }],
  ["reengagement", { kind: "reengagement" }],
];

describe("le HTML de secours porte la MARQUE, plus le nom de l'outil", () => {
  for (const [nom, patch] of KINDS) {
    test(`${nom} : pas de « newsletter·forge », pas de rose, le nom de la marque en tête`, () => {
      const r = render(ctx(patch), "https://nf.invalid");
      if (!r.ok) throw new Error(`attendu : rendu. Obtenu : ${r.reason}`);
      // « newsletter » seul reste légitime (« inscrit(e) à la newsletter de … » du pied légal) :
      // c'est le NOM DE L'OUTIL qui ne doit plus signer l'e-mail d'une marque.
      expect(r.email.html).not.toContain("forge");
      expect(r.email.html.toLowerCase()).not.toContain("#ff368d");
      expect(r.email.html).toContain('font-family:Arial,sans-serif">Quartz Tips</b>');
      // Et le secours n'est PAS un repli d'un modèle rattaché : aucun à signaler.
      expect(r.email.lifecycleFallback).toBeUndefined();
    });
  }

  test("le nom de la marque est échappé dans le bandeau", () => {
    const r = render(ctx({ asset_name: "<script>x</script>" }), "https://nf.invalid");
    if (!r.ok) throw new Error("attendu : rendu");
    expect(r.email.html).not.toContain("<script>");
  });

  test("le lien de confirmation garde son `&` échappé dans le `href`", () => {
    const r = render(ctx(KINDS[0]![1]), "https://nf.invalid");
    if (!r.ok) throw new Error("attendu : rendu");
    expect(r.email.html).toContain('href="https://nf.invalid/confirm?t=x&amp;l=fr"');
  });
});

describe("un modèle rattaché qui retombe sur le secours le DIT", () => {
  test("la raison du repli remonte avec l'e-mail rendu", () => {
    const r = render(ctx({ lifecycle_html_shell: "<html>sans pied</html>", lifecycle_subject: "x" }), "https://nf.invalid");
    if (!r.ok) throw new Error("attendu : rendu");
    expect(r.email.lifecycleFallback).toBe("no_legal_footer_slot");
    expect(r.email.html).toContain("Quartz Tips</b>");
  });

  test("un modèle qui sert ne signale rien", () => {
    const r = render(
      ctx({ lifecycle_html_shell: "<p>MODELE {{legal_footer_html}}</p>", lifecycle_subject: "Salut" }),
      "https://nf.invalid",
    );
    if (!r.ok) throw new Error("attendu : rendu");
    expect(r.email.html).toContain("MODELE");
    expect(r.email.lifecycleFallback).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * L'alerte, au niveau de `processRow`
 * ------------------------------------------------------------------ */

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
    slackWebhookUrl: "https://hooks.invalid/slack",
    ...p,
  };
}

function banc() {
  const envois: SendMessage[] = [];
  const noter = async () => {};
  const db = {
    markSent: noter,
    markFailed: noter,
    markSkipped: noter,
    release: noter,
    etatLienConfirmation: async () => "valide",
  } as unknown as Db;
  const mailgun = {
    send: async (m: SendMessage) => {
      envois.push(m);
      return { ok: true, id: "<id@x>" };
    },
  } as unknown as Mailgun;
  return { db, mailgun, envois };
}

/** Lance des lignes et rend les messages Slack postés (fetch intercepté, console muette). */
async function lancer(lignes: { c: OutboxContext; now: Date }[], conf = cfg()) {
  const slack: string[] = [];
  const b = banc();
  const fetchOriginal = globalThis.fetch;
  const logOriginal = console.log;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url) === "https://hooks.invalid/slack") slack.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
    return new Response("ok");
  }) as unknown as typeof fetch;
  console.log = () => {};
  try {
    for (const l of lignes) await processRow(l.c, conf, b.db, b.mailgun, l.now);
  } finally {
    globalThis.fetch = fetchOriginal;
    console.log = logOriginal;
  }
  return { slack, envois: b.envois };
}

const CASSE = { lifecycle_html_shell: "<html>sans pied</html>", lifecycle_subject: "x" };

describe("l'alerte Slack d'un repli : une par modèle et par fenêtre", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer l'appel `alerterRepliCycleDeVie` de `processRow`.
   * Symptôme : le repli n'existe plus que dans un journal que personne ne lit.
   */
  test("un modèle rattaché cassé ⇒ l'e-mail part (secours) ET une alerte nomme la marque, le kind et la raison", async () => {
    const { slack, envois } = await lancer([{ c: ctx({ ...CASSE, asset_id: "a-1", asset_slug: "northwind-sports" }), now: new Date("2026-09-22T12:00:00Z") }]);
    expect(envois).toHaveLength(1);
    expect(envois[0]!.html).toContain("Quartz Tips</b>");
    expect(slack).toHaveLength(1);
    expect(slack[0]).toContain("welcome");
    expect(slack[0]).toContain("northwind-sports");
    expect(slack[0]).toContain("no_legal_footer_slot");
  });

  test("dix e-mails dans la même fenêtre ⇒ UNE alerte ; la fenêtre suivante ⇒ une de plus", async () => {
    const t0 = new Date("2026-09-22T13:00:00Z").getTime();
    const lignes = Array.from({ length: 10 }, (_, i) => ({
      c: ctx({ ...CASSE, id: `o${i}`, asset_id: "a-2" }),
      now: new Date(t0 + i * 1000),
    }));
    lignes.push({ c: ctx({ ...CASSE, id: "o-suivant", asset_id: "a-2" }), now: new Date(t0 + 6 * 60_000) });
    const { slack, envois } = await lancer(lignes);
    expect(envois).toHaveLength(11);
    expect(slack).toHaveLength(2);
  });

  test("deux modèles cassés (deux kinds) dans la même fenêtre ⇒ deux alertes", async () => {
    const now = new Date("2026-09-22T14:00:00Z");
    const { slack } = await lancer([
      { c: ctx({ ...CASSE, asset_id: "a-3", kind: "welcome" }), now },
      // L'accusé ne part qu'à une souscription `unsubscribed` sans suppression dure (voir `gate.ts`).
      { c: ctx({ ...CASSE, asset_id: "a-3", kind: "unsubscribe_ack", sub_status: "unsubscribed", hard_suppressed: false }), now },
    ]);
    expect(slack).toHaveLength(2);
  });

  test("sans modèle rattaché (le secours est le cas normal) ⇒ aucune alerte", async () => {
    const { slack, envois } = await lancer([{ c: ctx({ asset_id: "a-4" }), now: new Date("2026-09-22T15:00:00Z") }]);
    expect(envois).toHaveLength(1);
    expect(slack).toEqual([]);
  });

  test("le Reply-To de l'édition arrive jusqu'à l'envoi", async () => {
    const { envois } = await lancer([{ c: ctx({ asset_id: "a-5", reply_to: "redacao@quartz-tips.example", from_name: "Redação" }), now: new Date("2026-09-22T16:00:00Z") }]);
    expect(envois[0]!.replyTo).toBe("redacao@quartz-tips.example");
    expect(envois[0]!.from).toBe('"Redação" <news@news.quartz-tips.invalid>');
  });
});
