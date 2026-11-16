/**
 * L'interrupteur d'un e-mail de cycle de vie (0086, feature 3 du 24/09/2026) — mesuré sans session ni base.
 *
 * Ce qui est tenu :
 *  - ⛔ la confirmation ⇒ 422, RIEN lu ni écrit ;
 *  - kind inconnu (dont `reengagement`) ⇒ 404, rien d'écrit ;
 *  - `enabled` non booléen ⇒ 400, rien d'écrit ;
 *  - welcome / accusé ⇒ upsert (asset_id, kind) de la marque de SESSION, puis audit ;
 *  - écriture refusée ⇒ 500, et pas d'audit d'un réglage qui n'a pas eu lieu.
 */
import { describe, expect, test } from "bun:test";
import { fauxDb, type ReponseDb } from "@/lib/testing/faux-db";

// Import différé : `_shared` charge la session, qui exige AUTH_SECRET au chargement.
const { putSystemSwitch } = await import("./handler");

const ASSET = "22222222-2222-4222-8222-222222222222";
const ok: ReponseDb = { data: null, error: null };

function deps(db: unknown) {
  return {
    requireContext: async () => ({
      ok: true as const,
      ctx: { db: db as never, asset: { id: ASSET, name: "PF" } as never, user: { email: "editor@staff.invalid", isSuperAdmin: false } as never },
    }),
  };
}
const requete = (body: unknown) =>
  new Request("http://x/api/automations/system/k", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const appeler = (kind: string, body: unknown, db: unknown) =>
  putSystemSwitch(requete(body), { params: Promise.resolve({ kind }) }, deps(db));

describe("PUT /api/automations/system/[kind]", () => {
  test("⛔ la confirmation ne se coupe pas : 422, rien lu ni écrit", async () => {
    for (const enabled of [false, true]) {
      const f = fauxDb();
      const res = await appeler("confirmation", { enabled }, f.db);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toContain("cannot be switched off");
      expect(f.appels).toHaveLength(0);
    }
  });

  test("kind inconnu ⇒ 404 ; la relance n'a pas d'interrupteur ici (elle vit dans le moteur)", async () => {
    for (const kind of ["reengagement", "campaign", "x"]) {
      const f = fauxDb();
      expect([kind, (await appeler(kind, { enabled: false }, f.db)).status]).toEqual([kind, 404]);
      expect(f.appels).toHaveLength(0);
    }
  });

  test("`enabled` absent ou non booléen ⇒ 400, rien d'écrit", async () => {
    for (const body of [{}, { enabled: "false" }, { enabled: 0 }, null]) {
      const f = fauxDb();
      expect((await appeler("welcome", body, f.db)).status).toBe(400);
      expect(f.appels).toHaveLength(0);
    }
  });

  test("couper le Welcome ⇒ upsert sur la marque de SESSION, puis audit", async () => {
    const f = fauxDb(ok, ok);
    const res = await appeler("welcome", { enabled: false, asset_id: "autre-marque" }, f.db);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: "welcome", enabled: false });
    expect(f.appels.map((a) => a.table)).toEqual(["lifecycle_setting", "audit_log"]);
    const upsert = f.appels[0]!.methodes.find((m) => m.m === "upsert")!;
    const pose = upsert.args[0] as Record<string, unknown>;
    expect([pose.asset_id, pose.kind, pose.enabled, pose.updated_by]).toEqual([ASSET, "welcome", false, "editor@staff.invalid"]);
    expect(upsert.args[1]).toEqual({ onConflict: "asset_id,kind" });
    const audit = f.appels[1]!.methodes.find((m) => m.m === "insert")!.args[0] as Record<string, unknown>;
    expect([audit.action, audit.target_id, audit.asset_id]).toEqual(["lifecycle-email-off", "welcome", ASSET]);
  });

  test("rallumer l'accusé ⇒ enabled true, audit « on »", async () => {
    const f = fauxDb(ok, ok);
    expect((await appeler("unsubscribe_ack", { enabled: true }, f.db)).status).toBe(200);
    const audit = f.appels[1]!.methodes.find((m) => m.m === "insert")!.args[0] as Record<string, unknown>;
    expect(audit.action).toBe("lifecycle-email-on");
  });

  test("écriture refusée ⇒ 500, et AUCUN audit d'un réglage qui n'a pas eu lieu", async () => {
    const f = fauxDb({ data: null, error: { message: "permission denied" } });
    const res = await appeler("welcome", { enabled: false }, f.db);
    expect(res.status).toBe(500);
    expect(f.appels.map((a) => a.table)).toEqual(["lifecycle_setting"]);
  });

  test("audit raté ⇒ le réglage reste posé (200), la panne est journalisée", async () => {
    const journal: string[] = [];
    const avant = console.error;
    console.error = (m: unknown) => void journal.push(String(m));
    try {
      const f = fauxDb(ok, { data: null, error: { message: "audit down" } });
      expect((await appeler("welcome", { enabled: false }, f.db)).status).toBe(200);
      expect(journal.some((l) => l.includes("lifecycle-switch-audit-failed"))).toBe(true);
    } finally {
      console.error = avant;
    }
  });
});
