/**
 * Un administrateur pose le mot de passe d'un autre compte — la décision de
 * POST /api/users/:id/password, sans base.
 *
 * Ce qui est tenu :
 *  1. Le seuil de longueur est celui de la personne elle-même (`refusMotDePasse`).
 *  2. L'écriture est filtrée sur le statut LU : un compte qui a changé d'état entre-temps n'est pas
 *     touché (409).
 *  3. ⛔ Un compte invité est ACTIVÉ (décision d'Alix, 01/10/2026) ; un compte désactivé RESTE
 *     désactivé — réactiver est un autre geste.
 *  4. ⛔ Le mot de passe n'apparaît nulle part dans ce qui part vers la base, audit compris.
 */
import { describe, expect, test } from "bun:test";

process.env.AUTH_SECRET = "secret-de-test-uniquement-01102026";
const { definirMotDePasse } = await import("./handler");
const { verifyPassword } = await import("@/lib/auth");

const CIBLE = "22222222-2222-4222-8222-222222222222";
const MDP = "Kp7wQ-x9mRt-4HnzA-cE3vB";

type Requete = { table: string; op: string; charge?: unknown; filtres: Record<string, unknown> };

function fauxDb(ligne: unknown) {
  const journal: Requete[] = [];
  const from = (table: string) => {
    const ctx: Requete = { table, op: "select", filtres: {} };
    const fin = () => {
      journal.push(ctx);
      return { data: table === "app_user" ? ligne : null, error: null };
    };
    const q = {
      update: (p: unknown) => ((ctx.op = "update"), (ctx.charge = p), q),
      insert: (p: unknown) => ((ctx.op = "insert"), (ctx.charge = p), q),
      eq: (k: string, v: unknown) => ((ctx.filtres[k] = v), q),
      select: (_c?: string) => q,
      maybeSingle: async () => fin(),
      then: (resoudre: (v: unknown) => unknown) => Promise.resolve(resoudre(fin())),
    };
    return q;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from } as any, journal };
}

const cible = (status: "invited" | "active" | "disabled") => ({ id: CIBLE, email: "autre@example.com", status });
const ligne = (status: string) => ({ id: CIBLE, email: "autre@example.com", role: "member", status });
const ACTEUR = "admin:demo-admin@example.com";

describe("definirMotDePasse", () => {
  test("trop court : refusé, rien n'est écrit", async () => {
    const { db, journal } = fauxDb(ligne("active"));
    const r = await definirMotDePasse({ password: "court" }, cible("active"), db, ACTEUR);
    expect(r.ok === false && r.statut === 400).toBe(true);
    expect(journal.length).toBe(0);
  });

  test("compte actif : empreinte vérifiable, filtrée sur 'active', pas d'activation", async () => {
    const { db, journal } = fauxDb(ligne("active"));
    const r = await definirMotDePasse({ password: MDP }, cible("active"), db, ACTEUR);
    expect(r).toEqual({ ok: true, activated: false, status: "active" });

    const maj = journal.find((q) => q.table === "app_user");
    expect(maj?.filtres).toEqual({ id: CIBLE, status: "active" });
    expect(await verifyPassword(MDP, (maj?.charge as { password_hash: string }).password_hash)).toBe(true);
  });

  test("⛔ compte invité : écriture filtrée sur 'invited', et le compte est ACTIVÉ", async () => {
    const { db, journal } = fauxDb(ligne("active"));
    const r = await definirMotDePasse({ password: MDP }, cible("invited"), db, ACTEUR);
    expect(r).toEqual({ ok: true, activated: true, status: "active" });
    const maj = journal.find((q) => q.table === "app_user");
    expect(maj?.filtres).toEqual({ id: CIBLE, status: "invited" });
    expect((maj?.charge as { status?: string }).status).toBe("active");
  });

  test("⛔ compte désactivé : le mot de passe change, le compte RESTE désactivé", async () => {
    const { db, journal } = fauxDb(ligne("disabled"));
    const r = await definirMotDePasse({ password: MDP }, cible("disabled"), db, ACTEUR);
    expect(r).toEqual({ ok: true, activated: false, status: "disabled" });
    const maj = journal.find((q) => q.table === "app_user");
    expect("status" in (maj?.charge as object)).toBe(false);
  });

  test("le compte a changé d'état entre-temps : 409, et aucun audit d'un geste qui n'a pas eu lieu", async () => {
    const { db, journal } = fauxDb(null);
    const r = await definirMotDePasse({ password: MDP }, cible("invited"), db, ACTEUR);
    expect(r.ok === false && r.statut === 409).toBe(true);
    expect(journal.some((q) => q.table === "audit_log")).toBe(false);
  });

  test("⛔ l'audit nomme l'auteur et la cible — jamais le mot de passe", async () => {
    const { db, journal } = fauxDb(ligne("active"));
    await definirMotDePasse({ password: MDP }, cible("invited"), db, ACTEUR);
    const audit = journal.find((q) => q.table === "audit_log")?.charge as Record<string, unknown>;
    expect(audit.actor).toBe(ACTEUR);
    expect(audit.action).toBe("user-password-set");
    expect(audit.target_id).toBe(CIBLE);
    expect(JSON.stringify(journal).includes(MDP)).toBe(false);
  });
});
