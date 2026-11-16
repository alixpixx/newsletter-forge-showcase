/**
 * Banc de l'expéditeur réglable par édition (décision d'Alix du 22/09/2026, colonnes 0078).
 *
 * ⛔ CE QUI EST RÉGLABLE : le NOM affiché dans le From, et une adresse de RÉPONSE (`Reply-To`).
 * ⛔ CE QUI NE L'EST PAS : l'ADRESSE D'ENVOI. Son domaine est le sous-domaine vérifié de l'édition ;
 * un From sur un autre domaine casse l'alignement DMARC, et toute la liste de la marque part en spam.
 * Aucune valeur saisie — nom, adresse de réponse — ne doit pouvoir la déplacer.
 */
import { describe, expect, test } from "bun:test";
import type { OutboxContext } from "./db";
import type { WorkerConfig } from "./env";
import { adresseDeReponse, Mailgun, nomAffiche, resolveSender } from "./mailgun";

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

const ctx = (p: Partial<OutboxContext> = {}) =>
  ({ asset_name: "Quartz Tips", sending_subdomain: "news.quartz-tips.invalid", ...p }) as OutboxContext;

describe("le From : nom réglable, adresse verrouillée", () => {
  test("sans réglage (0078 non appliquée) : le From d'avant, sans Reply-To", () => {
    const s = resolveSender(cfg(), ctx());
    expect(s).toEqual({ domain: "news.quartz-tips.invalid", from: '"Quartz Tips" <news@news.quartz-tips.invalid>' });
  });

  test("le nom réglé de l'édition remplace le nom de marque dans le From", () => {
    const s = resolveSender(cfg(), ctx({ from_name: "La rédaction Quartz Tips" }));
    expect(s?.from).toBe('"La rédaction Quartz Tips" <news@news.quartz-tips.invalid>');
  });

  test("le Reply-To réglé est transmis tel quel", () => {
    const s = resolveSender(cfg(), ctx({ reply_to: "redacao@quartz-tips.example" }));
    expect(s?.replyTo).toBe("redacao@quartz-tips.example");
    // …et l'adresse d'ENVOI ne bouge pas pour autant.
    expect(s?.from).toBe('"Quartz Tips" <news@news.quartz-tips.invalid>');
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : prendre le domaine d'envoi dans une valeur saisie (le Reply-To, ou
   * un `@` du nom) au lieu du sous-domaine vérifié.
   */
  test("⛔ aucune valeur saisie ne déplace le DOMAINE d'envoi", () => {
    for (const p of [
      { from_name: "Evil <x@evil.invalid>", reply_to: "x@evil.invalid" },
      { from_name: 'a" <x@evil.invalid>', reply_to: null },
      { from_name: "x@evil.invalid", reply_to: "boss@evil.invalid" },
    ] as Partial<OutboxContext>[]) {
      const s = resolveSender(cfg(), ctx(p));
      expect(s?.domain).toBe("news.quartz-tips.invalid");
      // L'adresse entre chevrons est la SEULE du From, et elle est sur le domaine vérifié.
      expect(s?.from.match(/<[^>]*>/g)).toEqual(["<news@news.quartz-tips.invalid>"]);
      expect(s?.from.endsWith("<news@news.quartz-tips.invalid>")).toBe(true);
    }
  });

  test("⛔ un guillemet ou un retour à la ligne ne sort pas du nom affiché", () => {
    expect(nomAffiche('Marque"\r\nBcc: x@evil.invalid')).toBe("Marque Bcc: x@evil.invalid");
    const s = resolveSender(cfg(), ctx({ from_name: 'A"B\nC' }));
    expect(s?.from).toBe('"A B C" <news@news.quartz-tips.invalid>');
  });

  test("un nom réglé vide ou blanc retombe sur le nom de marque, jamais sur un From anonyme", () => {
    expect(resolveSender(cfg(), ctx({ from_name: "   " }))?.from).toBe('"Quartz Tips" <news@news.quartz-tips.invalid>');
    expect(resolveSender(cfg(), ctx({ from_name: null, asset_name: null }))?.from).toBe('"Newsletter" <news@news.quartz-tips.invalid>');
  });

  test("⛔ un Reply-To mal formé est IGNORÉ, jamais transmis", () => {
    for (const mauvais of ["pas-une-adresse", "a@b", "x@evil.invalid, y@evil.invalid", "x@evil.invalid\r\nBcc: z@evil.invalid", "<x@evil.invalid>"]) {
      expect(adresseDeReponse(mauvais)).toBeUndefined();
      expect(resolveSender(cfg(), ctx({ reply_to: mauvais }))?.replyTo).toBeUndefined();
    }
  });

  test("bac à sable : même règle, domaine du bac à sable", () => {
    const s = resolveSender(cfg({ sendingMode: "sandbox" }), ctx({ from_name: "N", reply_to: "r@x.invalid" }));
    expect(s).toEqual({ domain: "sandbox.mg.invalid", from: '"N" <postmaster@sandbox.mg.invalid>', replyTo: "r@x.invalid" });
  });
});

describe("la charge utile Mailgun", () => {
  async function charge(msg: Partial<Parameters<Mailgun["send"]>[0]>): Promise<FormData> {
    const original = globalThis.fetch;
    let corps: FormData | null = null;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      corps = init?.body as FormData;
      return new Response(JSON.stringify({ id: "<id@x>" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await new Mailgun(cfg()).send({
        domain: "news.quartz-tips.invalid",
        from: '"Quartz Tips" <news@news.quartz-tips.invalid>',
        to: "a@example.invalid",
        subject: "s",
        html: "<p>x</p>",
        text: "x",
        messageId: "o1",
        messageIdHost: "nf.invalid",
        track: false,
        ...msg,
      });
    } finally {
      globalThis.fetch = original;
    }
    if (!corps) throw new Error("aucun appel");
    return corps;
  }

  test("le Reply-To part en en-tête `h:Reply-To`, le From reste celui résolu", async () => {
    const f = await charge({ replyTo: "redacao@quartz-tips.example" });
    expect(f.get("h:Reply-To")).toBe("redacao@quartz-tips.example");
    expect(f.get("from")).toBe('"Quartz Tips" <news@news.quartz-tips.invalid>');
  });

  test("sans Reply-To, aucun en-tête n'est posé (le comportement d'avant)", async () => {
    const f = await charge({});
    expect(f.get("h:Reply-To")).toBeNull();
  });

  test("les en-têtes List-Unsubscribe restent posés, non réglables", async () => {
    const f = await charge({ listUnsub: "<https://nf.invalid/unsubscribe?token=t>", oneClick: true, replyTo: "r@x.invalid" });
    expect(f.get("h:List-Unsubscribe")).toBe("<https://nf.invalid/unsubscribe?token=t>");
    expect(f.get("h:List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
  });
});
