/**
 * Les en-têtes de désinscription, PAR KIND, tels que Mailgun les reçoit (24/09/2026).
 *
 * ⛔ CE QUE CE BANC EMPÊCHE. Le `reengagement` partait SANS `List-Unsubscribe` : l'e-mail envoyé aux
 * gens qui ne lisent plus était le seul e-mail marketing sans bouton de désinscription dans la
 * messagerie — donc le plus exposé à un « signaler comme spam », et hors des exigences Gmail/Yahoo
 * pour les expéditeurs en volume.
 *
 * On passe par `processRow` ET par la vraie charge utile Mailgun (seul `fetch` est doublé) : ce qui
 * est vérifié, ce sont les champs `h:List-Unsubscribe` / `h:List-Unsubscribe-Post` du formulaire
 * envoyé, pas une variable intermédiaire.
 * MUTATIONS QUI DOIVENT LE TUER : retirer un kind de `KINDS_DESINSCRIPTIBLES` ; déclarer un kind
 * `marketing: true` dans `gate.ts` sans l'y ajouter.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db, OutboxContext } from "./db";
import type { WorkerConfig } from "./env";
import { Mailgun } from "./mailgun";

const { processRow, KINDS_DESINSCRIPTIBLES } = await import("./process");

const NOW = new Date("2026-09-24T12:00:00Z");

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

const COQUILLE = "<p>Bonjour</p>{{legal_footer_html}}";

/** Une ligne ENVOYABLE de chaque kind : la porte et le rendu la laissent passer. */
const LIGNES: Record<string, Partial<OutboxContext>> = {
  welcome: {},
  campaign: { purpose: "content", granted_purposes: { content: true }, campaign_html_shell: COQUILLE, campaign_text_shell: "Bonjour" },
  test: { template_html_shell: COQUILLE, template_text_shell: "Bonjour" },
  reengagement: { purpose: "content", granted_purposes: { content: true } },
  confirmation: { sub_status: "pending", action_url: "https://nf.invalid/confirm?token=t" },
  unsubscribe_ack: { sub_status: "unsubscribed", hard_suppressed: false },
} as Record<string, Partial<OutboxContext>>;

function ctx(kind: string): OutboxContext {
  return {
    id: "o1",
    kind,
    subject: "Objet",
    action_url: null,
    payload: {},
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
    purpose: null,
    market: null,
    consent_mode: null,
    granted_purposes: null,
    campaign_id: null,
    template_version_id: null,
    ...LIGNES[kind],
  } as OutboxContext;
}

/** Fait passer une ligne par `processRow` et rend le formulaire que Mailgun aurait reçu. */
async function formulaire(kind: string, oneClick: boolean): Promise<FormData> {
  const conf = cfg({ oneClick });
  const ecritures: string[] = [];
  const db = {
    markSent: async () => void ecritures.push("markSent"),
    markFailed: async () => void ecritures.push("markFailed"),
    markSkipped: async (_id: string, raison: string) => void ecritures.push(`markSkipped:${raison}`),
    release: async () => void ecritures.push("release"),
    etatLienConfirmation: async () => "valide",
  } as unknown as Db;

  let corps: FormData | null = null;
  const fetchOriginal = globalThis.fetch;
  const logOriginal = console.log;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    corps = init?.body as FormData;
    return new Response(JSON.stringify({ id: "<20260924.x@news.quartz-tips.invalid>" }), { status: 200 });
  }) as unknown as typeof fetch;
  console.log = () => {};
  try {
    await processRow(ctx(kind), conf, db, new Mailgun(conf), NOW);
  } finally {
    globalThis.fetch = fetchOriginal;
    console.log = logOriginal;
  }
  // Contre-épreuve : la ligne est bien PARTIE. Un kind refusé par la porte ou le rendu n'aurait
  // produit aucun formulaire, et « pas d'en-tête » y serait vrai pour une mauvaise raison.
  expect(ecritures).toEqual(["markSent"]);
  if (!corps) throw new Error(`aucun envoi pour ${kind}`);
  return corps;
}

// ⛔ Le lien HTTPS SEUL (D7, 24/09/2026) : un `mailto:` que personne ne lit ferait rougir ce banc.
const LIEN = /^<https:\/\/nf\.invalid\/unsubscribe\?token=[^>]+>$/;

describe("List-Unsubscribe par kind", () => {
  for (const kind of ["welcome", "campaign", "test", "reengagement"]) {
    test(`${kind} ⇒ List-Unsubscribe ET List-Unsubscribe-Post: List-Unsubscribe=One-Click`, async () => {
      const f = await formulaire(kind, true);
      expect(String(f.get("h:List-Unsubscribe"))).toMatch(LIEN);
      expect(f.get("h:List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
    });
  }

  for (const kind of ["confirmation", "unsubscribe_ack"]) {
    test(`${kind} (transactionnel) ⇒ aucun en-tête de désinscription`, async () => {
      const f = await formulaire(kind, true);
      expect(f.get("h:List-Unsubscribe")).toBeNull();
      expect(f.get("h:List-Unsubscribe-Post")).toBeNull();
    });
  }

  test("réengagement sans `WORKER_ONE_CLICK` ⇒ List-Unsubscribe seul, comme une campagne", async () => {
    const r = await formulaire("reengagement", false);
    const c = await formulaire("campaign", false);
    expect(String(r.get("h:List-Unsubscribe"))).toMatch(LIEN);
    expect(r.get("h:List-Unsubscribe-Post")).toBeNull();
    expect(c.get("h:List-Unsubscribe-Post")).toBeNull();
  });
});

describe("⛔ tout kind marketing de la porte porte l'en-tête", () => {
  /*
   * La table des politiques de `gate.ts` n'est pas exportée : on lit son CODE, commentaires retirés,
   * et on y relève chaque entrée `marketing: true`. Un kind marketing ajouté à la porte sans être
   * ajouté à `KINDS_DESINSCRIPTIBLES` partirait sans bouton de désinscription — ce banc rougit.
   */
  const source = readFileSync(new URL("./gate.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const marketing = [...source.matchAll(/^\s*([a-z_]+):\s*\{[^}]*\bmarketing:\s*true\b[^}]*\}/gm)].map((m) => m[1]!).sort();

  test("le relevé voit bien les kinds marketing connus", () => {
    expect(marketing).toContain("campaign");
    expect(marketing).toContain("reengagement");
    expect(marketing).not.toContain("confirmation");
  });

  test("chacun est dans KINDS_DESINSCRIPTIBLES", () => {
    expect(marketing.filter((k) => !KINDS_DESINSCRIPTIBLES.has(k))).toEqual([]);
  });
});
