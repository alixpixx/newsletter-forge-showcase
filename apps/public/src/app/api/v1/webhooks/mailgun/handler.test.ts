/**
 * Webhook Mailgun — la route mesurée sans réseau, sans variable d'environnement.
 *
 * Clé, base et horloge sont injectées ; la base est un double qui sert des réponses DANS L'ORDRE et
 * enregistre chaque appel. Ce qui compte : rien ne touche la base avant la signature, un rebond
 * temporaire ne supprime personne, et — le défaut corrigé le 16/09/2026 — un événement REJOUÉ
 * relance la suppression au lieu d'être acquitté avant elle.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { boitePleine, detailEvenement, handleMailgunWebhook } from "./handler";

const CLE = "cle-de-test-uniquement";
const NOW = 1_789_560_000;
const OUTBOX = "66666666-6666-4666-8666-666666666666";
const ASSET = "ed806139-74f6-46e9-9769-7c0bc005789a";
const ADRESSE = "lecteur@example.invalid";

type Reponse = { data?: unknown; error?: { code?: string; message: string } | null };
type Appel = { cible: string; methodes: { m: string; args: unknown[] }[] };

function fauxDb(...reponses: Reponse[]) {
  const appels: Appel[] = [];
  let i = 0;
  const ouvrir = (cible: string, premiere?: { m: string; args: unknown[] }) => {
    const appel: Appel = { cible, methodes: premiere ? [premiere] : [] };
    appels.push(appel);
    const chaine: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const r = reponses[i++] ?? {};
            return (resoudre: (v: unknown) => void) => resoudre({ data: r.data ?? null, error: r.error ?? null });
          }
          return (...args: unknown[]) => {
            appel.methodes.push({ m: prop, args });
            return chaine;
          };
        },
      },
    );
    return chaine;
  };
  const db = { from: (t: string) => ouvrir(t), rpc: (n: string, a: unknown) => ouvrir(`rpc:${n}`, { m: "rpc", args: [a] }) };
  return { db, appels };
}

function signe(ts = NOW, token = "tok-1", cle = CLE) {
  return { timestamp: String(ts), token, signature: createHmac("sha256", cle).update(`${ts}${token}`).digest("hex") };
}

const ligne = { id: OUTBOX, asset_id: ASSET, subscription_id: "s1", campaign_id: null, occurrence_id: null, to_email: ADRESSE };

function evenement(extra: Record<string, unknown>) {
  return {
    id: "evt-1",
    timestamp: NOW - 5,
    "user-variables": { outbox_id: OUTBOX },
    message: { headers: { "message-id": "<abc@mg.example>" } },
    ...extra,
  };
}

async function appeler(body: unknown, reponses: Reponse[], opts: { cle?: string } = {}) {
  const f = fauxDb(...reponses);
  let dbDemandee = false;
  const res = await handleMailgunWebhook(
    new Request("http://x/webhook", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
    {
      signingKey: "cle" in opts ? opts.cle : CLE,
      getDb: () => {
        dbDemandee = true;
        return f.db as never;
      },
      now: () => NOW,
    },
  );
  const rpc = f.appels.filter((a) => a.cible === "rpc:suppress").map((a) => a.methodes[0]!.args[0] as Record<string, unknown>);
  const insert = f.appels.find((a) => a.cible === "email_event")?.methodes.find((m) => m.m === "insert")?.args[0] as
    | Record<string, unknown>
    | undefined;
  return { status: res.status, appels: f.appels, rpc, insert, dbDemandee: () => dbDemandee };
}

describe("avant la signature, rien ne touche la base", () => {
  const cas: [string, unknown, number, { cle?: string }?][] = [
    ["clé absente", { signature: signe(), "event-data": evenement({ event: "delivered" }) }, 503, { cle: undefined }],
    ["clé vide", { signature: signe(), "event-data": evenement({ event: "delivered" }) }, 503, { cle: "  " }],
    ["corps illisible", "{nope", 400],
    ["bloc de signature absent", { "event-data": evenement({ event: "delivered" }) }, 406],
    ["horodatage trop vieux", { signature: signe(NOW - 16 * 60), "event-data": evenement({ event: "delivered" }) }, 406],
    ["signature d'une autre clé", { signature: signe(NOW, "tok-1", "autre"), "event-data": evenement({ event: "delivered" }) }, 406],
  ];
  for (const [nom, body, attendu, opts] of cas) {
    test(`${nom} ⇒ ${attendu}`, async () => {
      const r = await appeler(body, [], opts);
      expect(r.status).toBe(attendu);
      expect(r.dbDemandee()).toBe(false);
    });
  }

  test("événement inconnu ⇒ acquitté sans rien écrire", async () => {
    const r = await appeler({ signature: signe(), "event-data": evenement({ event: "stored" }) }, []);
    expect(r.status).toBe(200);
    expect(r.appels).toEqual([]);
  });
});

describe("écriture de l'événement", () => {
  test("livraison : rattachée par la variable utilisateur, aucune suppression", async () => {
    const r = await appeler({ signature: signe(), "event-data": evenement({ event: "delivered" }) }, [{ data: [ligne] }, {}]);
    expect(r.status).toBe(200);
    expect(r.appels[0]!.methodes.find((m) => m.m === "eq")!.args).toEqual(["id", OUTBOX]);
    expect(r.insert).toMatchObject({
      outbox_id: OUTBOX,
      asset_id: ASSET,
      type: "delivered",
      severity: null,
      provider_event_id: "evt-1",
      provider_message_id: "abc@mg.example",
    });
    expect(r.insert).not.toHaveProperty("to_email");
    expect(r.rpc).toEqual([]);
  });

  test("échec temporaire : type failed, sévérité temporary, personne n'est supprimé", async () => {
    const r = await appeler(
      { signature: signe(), "event-data": evenement({ event: "failed", severity: "temporary", reason: "mailbox full" }) },
      [{ data: [ligne] }, {}],
    );
    expect(r.insert).toMatchObject({ type: "failed", severity: "temporary" });
    expect(r.rpc).toEqual([]);
  });

  test("rebond dur : supprimé pour CETTE marque, raison bornée", async () => {
    const r = await appeler(
      { signature: signe(), "event-data": evenement({ event: "failed", severity: "permanent", reason: "x".repeat(300) }) },
      [{ data: [ligne] }, {}, {}],
    );
    expect(r.status).toBe(200);
    expect(r.insert).toMatchObject({ type: "bounced", severity: "permanent" });
    expect(r.rpc).toHaveLength(1);
    expect(r.rpc[0]).toMatchObject({ p_email: ADRESSE, p_asset_id: ASSET, p_scope: "asset" });
    expect(String(r.rpc[0]!.p_reason)).toHaveLength(200);
    expect(String(r.rpc[0]!.p_reason).startsWith("hard_bounce:")).toBe(true);
  });

  test("plainte : supprimée pour TOUTES les marques", async () => {
    const r = await appeler({ signature: signe(), "event-data": evenement({ event: "complained" }) }, [{ data: [ligne] }, {}, {}]);
    expect(r.rpc).toEqual([{ p_email: ADRESSE, p_asset_id: ASSET, p_reason: "spam_complaint", p_scope: "global" }]);
  });

  test("aucune ligne d'origine : événement écrit sans rattachement, personne n'est supprimé", async () => {
    const r = await appeler({ signature: signe(), "event-data": evenement({ event: "complained" }) }, [{ data: [] }, {}]);
    expect(r.status).toBe(200);
    expect(r.insert).toMatchObject({ outbox_id: null, asset_id: null, type: "complained" });
    expect(r.rpc).toEqual([]);
  });

  test("erreur d'écriture (hors doublon) ⇒ 500, et pas de suppression sur un événement perdu", async () => {
    const r = await appeler(
      { signature: signe(), "event-data": evenement({ event: "failed", severity: "permanent" }) },
      [{ data: [ligne] }, { error: { code: "57014", message: "timeout" } }],
    );
    expect(r.status).toBe(500);
    expect(r.rpc).toEqual([]);
  });
});

describe("rejeu d'un événement déjà enregistré", () => {
  const doublon = { error: { code: "23505", message: "duplicate key" } };

  test("rebond dur rejoué ⇒ la suppression est RELANCÉE, puis 200", async () => {
    const r = await appeler(
      { signature: signe(), "event-data": evenement({ event: "failed", severity: "permanent", reason: "no such user" }) },
      [{ data: [ligne] }, doublon, {}],
    );
    expect(r.status).toBe(200);
    expect(r.rpc).toEqual([{ p_email: ADRESSE, p_asset_id: ASSET, p_reason: "hard_bounce:no such user", p_scope: "asset" }]);
  });

  test("rejeu dont la suppression échoue encore ⇒ 500, pour que Mailgun réessaie", async () => {
    const r = await appeler(
      { signature: signe(), "event-data": evenement({ event: "complained" }) },
      [{ data: [ligne] }, doublon, { error: { message: "connection reset" } }],
    );
    expect(r.status).toBe(500);
  });

  test("livraison rejouée ⇒ 200 sans suppression", async () => {
    const r = await appeler({ signature: signe(), "event-data": evenement({ event: "delivered" }) }, [{ data: [ligne] }, doublon]);
    expect(r.status).toBe(200);
    expect(r.rpc).toEqual([]);
  });
});

/**
 * ⭐ DÉCISION D'ALIX DU 22/09/2026 : une boîte PLEINE est un rebond TEMPORAIRE, même annoncée
 * `permanent` par Mailgun. Cas réel : une adresse hotmail supprimée de Northwind Sports pour `overquota` le
 * 22/09 à 14:29 UTC — elle ne recevait plus rien ET ne pouvait plus se réinscrire elle-même.
 *
 * ⛔ LE BANC TIENT LES DEUX BORDS : la saturation ne supprime plus, et tout le reste supprime
 * toujours. Un filtre trop large garderait des adresses MORTES en liste, ce qui détruit la
 * réputation d'envoi — le motif même de cette route.
 */
describe("boîte pleine : rebond temporaire, jamais une suppression", () => {
  const saturations: [string, Record<string, unknown>][] = [
    ["mot de Mailgun", { reason: "overquota" }],
    ["phrase du serveur distant", { reason: "552 5.2.2 The email account that you tried to reach is over quota" }],
    ["boîte pleine en toutes lettres", { reason: "mailbox full" }],
    ["stockage insuffisant", { reason: "Insufficient storage" }],
    ["motif seulement dans delivery-status", { "delivery-status": { message: "Requested mail action aborted: exceeded storage allocation", code: 452 } }],
  ];

  for (const [nom, extra] of saturations) {
    test(`${nom} ⇒ écrit en temporaire, personne n'est supprimé`, async () => {
      const r = await appeler(
        { signature: signe(), "event-data": evenement({ event: "failed", severity: "permanent", ...extra }) },
        [{ data: [ligne] }, {}],
      );
      expect(r.status).toBe(200);
      expect(r.insert).toMatchObject({ type: "failed", severity: "temporary" });
      expect(r.rpc).toEqual([]);
    });
  }

  const vraisRebonds: [string, Record<string, unknown>][] = [
    ["adresse inexistante", { reason: "550 5.1.1 no such user" }],
    ["domaine mort", { reason: "domain not found" }],
    ["message trop gros", { reason: "552 5.3.4 message too big", "delivery-status": { code: 552 } }],
    ["motif inconnu", {}],
  ];

  for (const [nom, extra] of vraisRebonds) {
    test(`${nom} ⇒ reste un rebond dur et supprime`, async () => {
      const r = await appeler(
        { signature: signe(), "event-data": evenement({ event: "failed", severity: "permanent", ...extra }) },
        [{ data: [ligne] }, {}, {}],
      );
      expect(r.insert).toMatchObject({ type: "bounced", severity: "permanent" });
      expect(r.rpc).toHaveLength(1);
    });
  }

  test("un échec déjà temporaire ne change pas de nature", async () => {
    const r = await appeler(
      { signature: signe(), "event-data": evenement({ event: "failed", severity: "temporary", reason: "overquota" }) },
      [{ data: [ligne] }, {}],
    );
    expect(r.insert).toMatchObject({ type: "failed", severity: "temporary" });
    expect(r.rpc).toEqual([]);
  });

  test("la décision elle-même, hors route", () => {
    expect(boitePleine("overquota")).toBe(true);
    expect(boitePleine("4.2.2 mailbox is full")).toBe(true);
    expect(boitePleine(null, 452)).toBe(false); // ⛔ le code SMTP nu ne dit pas le motif
    expect(boitePleine("552 5.3.4 message too big", 552)).toBe(false);
    expect(boitePleine("mailbox unavailable")).toBe(false); // ⛔ ne veut PAS dire « pleine »
    expect(boitePleine(null)).toBe(false);
  });
});

describe("le détail d'une ouverture ou d'un clic (0092)", () => {
  const IP = "203.0.113.9";
  const UA = "Mozilla/5.0 (Linux; Android 14) Chrome/129";
  const clic = evenement({
    event: "clicked",
    url: "https://www.example.invalid/article?id=42",
    ip: IP,
    "client-info": { "client-type": "browser", "client-name": "Chrome", "client-os": "Android", "device-type": "Mobile", "user-agent": UA, bot: "" },
    geolocation: { country: "gb", region: "England", city: "Liverpool" },
  });
  const inserts = (r: Awaited<ReturnType<typeof appeler>>) =>
    r.appels.filter((a) => a.cible === "email_event").map((a) => a.methodes.find((m) => m.m === "insert")?.args[0] as Record<string, unknown>);

  test("clic : lien, appareil, client, système, pays, région, ville — jamais l'IP ni l'user-agent", async () => {
    const r = await appeler({ signature: signe(), "event-data": clic }, [{ data: [ligne] }, {}]);
    expect(r.status).toBe(200);
    expect(r.insert).toMatchObject({
      type: "clicked",
      outbox_id: OUTBOX,
      url: "https://www.example.invalid/article?id=42",
      device_type: "mobile",
      client_type: "browser",
      client_name: "Chrome",
      client_os: "Android",
      bot: null,
      country: "GB",
      region: "England",
      city: "Liverpool",
    });
    expect(JSON.stringify(r.insert)).not.toContain(IP);
    expect(JSON.stringify(r.insert)).not.toContain("Mozilla");
    expect(r.rpc).toEqual([]);
  });

  test("« Unknown » de Mailgun n'est pas une valeur, et un lien non http(s) n'est pas gardé", () => {
    expect(
      detailEvenement({
        url: "javascript:alert(1)",
        geolocation: { country: "Unknown", region: "unknown", city: " " },
        "client-info": { "device-type": "unknown", "client-name": 42 },
      }),
    ).toEqual({
      url: null, device_type: null, client_type: null, client_name: null, client_os: null,
      bot: null, country: null, region: null, city: null,
    });
  });

  test("ouverture automatique : le marqueur de robot est gardé tel quel", () => {
    expect(detailEvenement({ event: "opened", "client-info": { bot: "apple" } }).bot).toBe("apple");
  });

  test("base d'avant 0092 : l'événement s'écrit SANS son détail au lieu d'être perdu", async () => {
    const absente = { code: "PGRST204", message: "Could not find the 'bot' column of 'email_event' in the schema cache" };
    const r = await appeler({ signature: signe(), "event-data": clic }, [{ data: [ligne] }, { error: absente }, {}]);
    expect(r.status).toBe(200);
    const [premier, second] = inserts(r);
    expect(premier).toHaveProperty("url");
    expect(second).toMatchObject({ type: "clicked", outbox_id: OUTBOX });
    expect(second).not.toHaveProperty("url");
    expect(second).not.toHaveProperty("city");
  });

  test("⛔ toute AUTRE erreur d'écriture reste un 500 : Mailgun rejoue, rien n'est écrit en double", async () => {
    const r = await appeler({ signature: signe(), "event-data": clic }, [{ data: [ligne] }, { error: { code: "XX000", message: "boom" } }]);
    expect(r.status).toBe(500);
    expect(inserts(r)).toHaveLength(1);
  });
});
