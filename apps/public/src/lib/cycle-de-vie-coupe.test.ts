/**
 * L'INTERRUPTEUR des e-mails de cycle de vie (0086, feature 3 du 24/09/2026).
 *
 * Ce qui est tenu :
 *  - Welcome coupé ⇒ la confirmation a lieu (souscription active, preuves écrites), AUCUN bienvenue ;
 *  - accusé coupé ⇒ la désinscription a lieu, AUCUN accusé ;
 *  - coupé = une ligne LUE `enabled = false` de CETTE marque ; ligne absente, `enabled = true`, autre
 *    marque, lecture en panne ⇒ l'e-mail part (état d'avant) ;
 *  - ⛔ la confirmation ne lit JAMAIS ce réglage : aucun chemin d'inscription ne l'importe.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sha256 } from "@nf/tokens";
import { fausseBasePostgrest, type Appel, type Ligne, type Panne } from "@/lib/faux-postgrest";
import { handleConfirmation } from "@/app/api/v1/confirm/handler";
import { handleDesinscriptionHumaine } from "@/app/api/v1/unsubscribe/confirm/handler";
import { emailCoupe } from "./cycle-de-vie-coupe";

const SUB = "11111111-1111-4111-8111-111111111111";
const ASSET = "ed806139-74f6-46e9-9769-7c0bc005789a";
const AUTRE = "0b5ad0f5-0000-4000-8000-000000000000";
const ADRESSE = "lecteur@example.invalid";
const JETON = "jeton-brut-de-test";

let espions: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const e of espions) e.mockRestore();
  espions = [];
});
function silence() {
  espions.push(spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "info").mockImplementation(() => {}));
}

const reglage = (kind: string, enabled: boolean, asset_id = ASSET): Ligne => ({ asset_id, kind, enabled });

function confirmer(reglages: Ligne[], panne?: (a: Appel) => Panne) {
  const f = fausseBasePostgrest(
    {
      subscription: [
        {
          id: SUB, status: "pending", asset_id: ASSET, consent_version_id: "cv-1",
          granted_purposes: { content: true }, language: "es", source_detail: {},
          subscriber: { email: ADRESSE }, asset: { name: "Copper Kettle" },
        },
      ],
      doi_token: [{ id: "tok-1", subscription_id: SUB, token_hash: sha256(JETON), expires_at: "2099-01-01T00:00:00Z", confirmed_at: null }],
      asset_edition: [{ asset_id: ASSET, market: "CL", compliance_regime: "gdpr", language: "es" }],
      lifecycle_setting: reglages,
    },
    { panne },
  );
  const res = handleConfirmation(
    new Request("http://x/api/v1/confirm", { method: "POST", body: JSON.stringify({ token: JETON }) }),
    { getDb: () => f.db as never, signUnsub: (id) => `signe:${id}`, apres: () => {}, env: {} },
  );
  return { f, res };
}

function desinscrire(reglages: Ligne[]) {
  const f = fausseBasePostgrest({
    subscription: [
      {
        id: SUB, status: "active", language: "es", asset_id: ASSET, subscriber_id: "subr-1",
        subscriber: { email: ADRESSE }, asset: { name: "Copper Kettle" },
      },
    ],
    lifecycle_setting: reglages,
  });
  const res = handleDesinscriptionHumaine(
    new Request("http://x/api/v1/unsubscribe/confirm", { method: "POST", body: JSON.stringify({ token: "t" }) }),
    { getDb: () => f.db as never, verifyUnsub: (t) => (t === "t" ? SUB : null) },
  );
  return { f, res };
}

describe("Welcome coupé", () => {
  test("⛔ la confirmation a lieu, ses preuves sont écrites, AUCUN bienvenue", async () => {
    silence();
    const { f, res } = confirmer([reglage("welcome", false)]);
    expect((await res).status).toBe(200);
    expect(f.tables.subscription[0]!.status).toBe("active");
    expect((f.tables.consent_event ?? []).map((e) => e.event_type)).toEqual(["optin_confirm", "granted"]);
    expect(f.outbox()).toHaveLength(0);
  });

  test("activé, absent, ou coupé sur une AUTRE marque ⇒ le bienvenue part", async () => {
    for (const reglages of [[reglage("welcome", true)], [], [reglage("welcome", false, AUTRE)], [reglage("unsubscribe_ack", false)]]) {
      const { f, res } = confirmer(reglages);
      await res;
      expect([JSON.stringify(reglages), f.outbox().map((o) => o.kind)]).toEqual([JSON.stringify(reglages), ["welcome"]]);
    }
  });

  test("lecture du réglage en panne ⇒ le bienvenue part, et la panne est journalisée", async () => {
    const erreurs: string[] = [];
    espions.push(spyOn(console, "error").mockImplementation((m: unknown) => void erreurs.push(String(m))));
    const { f, res } = confirmer([reglage("welcome", false)], (a) => (a.cible === "lifecycle_setting" ? { message: "boom" } : null));
    await res;
    expect(f.outbox().map((o) => o.kind)).toEqual(["welcome"]);
    expect(erreurs.some((e) => e.includes("lifecycle-setting-read-failed"))).toBe(true);
  });
});

describe("Unsubscribe receipt coupé", () => {
  test("⛔ la désinscription a lieu, AUCUN accusé", async () => {
    silence();
    const { f, res } = desinscrire([reglage("unsubscribe_ack", false)]);
    expect((await res).status).toBe(200);
    expect(f.tables.subscription[0]!.status).toBe("unsubscribed");
    expect(f.outbox()).toHaveLength(0);
  });

  test("coupé sur le bienvenue seulement ⇒ l'accusé part", async () => {
    const { f, res } = desinscrire([reglage("welcome", false)]);
    await res;
    expect(f.outbox().map((o) => o.kind)).toEqual(["unsubscribe_ack"]);
  });
});

describe("emailCoupe", () => {
  test("sans marque ⇒ jamais coupé, et rien n'est lu", async () => {
    const f = fausseBasePostgrest({ lifecycle_setting: [reglage("welcome", false)] });
    expect(await emailCoupe(f.db as never, null, "welcome")).toBe(false);
    expect(f.appels).toHaveLength(0);
  });

  test("une panne qui LÈVE ne lève pas plus loin", async () => {
    silence();
    const f = fausseBasePostgrest({}, { panne: () => "lever" });
    expect(await emailCoupe(f.db as never, ASSET, "welcome")).toBe(false);
  });
});

describe("⛔ la confirmation ne se coupe pas", () => {
  test("aucun chemin d'inscription ne lit l'interrupteur", () => {
    for (const f of ["../app/api/v1/signup/route.ts", "./mailer.ts", "./confirmation.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect([f, src.includes("lifecycle_setting") || src.includes("emailCoupe")]).toEqual([f, false]);
    }
  });

  test("le module ne connaît que welcome et unsubscribe_ack", () => {
    const src = readFileSync(new URL("./cycle-de-vie-coupe.ts", import.meta.url), "utf8");
    expect(src).toContain('export type EmailCoupable = "welcome" | "unsubscribe_ack";');
  });
});
