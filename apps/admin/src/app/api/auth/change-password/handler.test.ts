/**
 * Changement de SON mot de passe — la décision de POST /api/auth/change-password, sans base.
 *
 * Ce qui est tenu :
 *  1. ⛔ Le mot de passe ACTUEL est exigé et vérifié AVANT toute écriture. Une session ouverte ne
 *     suffit pas : c'est ce qui empêche un poste resté connecté de devenir un compte perdu.
 *  2. Seul un mauvais mot de passe actuel est signalé au ralentisseur (`motDePasseFaux`).
 *  3. L'écriture vise le compte ACTIF lu ; aucune ligne touchée = 409, pas un faux succès.
 *  4. ⛔ Ni l'ancien ni le nouveau mot de passe n'apparaissent dans ce qui part vers la base en
 *     dehors de l'empreinte — journal d'audit compris.
 */
import { describe, expect, test } from "bun:test";

// ⚠️ `auth.ts` LÈVE à l'import si AUTH_SECRET manque : même parade que les autres bancs.
process.env.AUTH_SECRET = "secret-de-test-uniquement-01102026";
const { changerSonMotDePasse } = await import("./handler");
const { hashPassword, verifyPassword } = await import("@/lib/auth");

const USER = "11111111-1111-4111-8111-111111111111";
const ACTUEL = "ancien-mot-de-passe-42";
const NOUVEAU = "nouveau-mot-de-passe-43";

type Requete = { table: string; op: string; charge?: unknown; filtres: Record<string, unknown> };

/** Double du client : journalise ce qui part ; `app_user` rend `ligne`, le reste rien. */
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

const compte = async () => ({ id: USER, email: "moi@example.com", password_hash: await hashPassword(ACTUEL) });
const LIGNE_ECRITE = { id: USER, email: "moi@example.com", role: "member", status: "active" };

describe("changerSonMotDePasse", () => {
  test("⛔ mot de passe actuel faux : refusé, compté, et RIEN n'est écrit", async () => {
    const { db, journal } = fauxDb(LIGNE_ECRITE);
    const r = await changerSonMotDePasse({ currentPassword: "pas-le-bon-du-tout", newPassword: NOUVEAU }, await compte(), db);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.statut).toBe(400);
    expect(r.motDePasseFaux).toBe(true);
    expect(journal.length).toBe(0);
  });

  test("mot de passe actuel absent : refusé sans compter d'échec", async () => {
    const { db, journal } = fauxDb(LIGNE_ECRITE);
    const r = await changerSonMotDePasse({ newPassword: NOUVEAU }, await compte(), db);
    expect(r.ok === false && r.motDePasseFaux === false && r.statut === 400).toBe(true);
    expect(journal.length).toBe(0);
  });

  test("nouveau trop court : refusé avant toute écriture", async () => {
    const { db, journal } = fauxDb(LIGNE_ECRITE);
    const r = await changerSonMotDePasse({ currentPassword: ACTUEL, newPassword: "court" }, await compte(), db);
    expect(r.ok === false && r.erreur.includes("at least 12")).toBe(true);
    expect(journal.length).toBe(0);
  });

  test("nouveau identique à l'actuel : refusé, sans compter d'échec", async () => {
    const { db, journal } = fauxDb(LIGNE_ECRITE);
    const r = await changerSonMotDePasse({ currentPassword: ACTUEL, newPassword: ACTUEL }, await compte(), db);
    expect(r.ok === false && r.motDePasseFaux === false).toBe(true);
    expect(journal.length).toBe(0);
  });

  test("succès : la nouvelle empreinte se vérifie, l'écriture vise le compte ACTIF, l'audit suit", async () => {
    const { db, journal } = fauxDb(LIGNE_ECRITE);
    const r = await changerSonMotDePasse({ currentPassword: ACTUEL, newPassword: NOUVEAU }, await compte(), db);
    expect(r.ok).toBe(true);

    const maj = journal.find((q) => q.table === "app_user" && q.op === "update");
    expect(maj?.filtres).toEqual({ id: USER, status: "active" });
    const hash = (maj?.charge as { password_hash: string }).password_hash;
    expect(await verifyPassword(NOUVEAU, hash)).toBe(true);
    expect(await verifyPassword(ACTUEL, hash)).toBe(false);

    const audit = journal.find((q) => q.table === "audit_log");
    expect(audit?.op).toBe("insert");
    expect((audit?.charge as { action: string }).action).toBe("user-password-changed");

    // ⛔ Aucun des deux mots de passe en clair, nulle part dans ce qui part vers la base.
    const tout = JSON.stringify(journal);
    expect(tout.includes(NOUVEAU)).toBe(false);
    expect(tout.includes(ACTUEL)).toBe(false);
  });

  test("aucune ligne touchée (compte désactivé entre-temps) : 409, pas de faux succès ni d'audit", async () => {
    const { db, journal } = fauxDb(null);
    const r = await changerSonMotDePasse({ currentPassword: ACTUEL, newPassword: NOUVEAU }, await compte(), db);
    expect(r.ok === false && r.statut === 409).toBe(true);
    expect(journal.some((q) => q.table === "audit_log")).toBe(false);
  });
});
