/**
 * Modification d'un compte — la décision de PATCH /api/users/:id, sans base.
 *
 * Ce qui est tenu, pour « All brands » et « All templates » (0075) :
 *  1. `allAssets` et `allTemplates` n'acceptent chacun qu'un VRAI booléen, et sont refusés
 *     SÉPARÉMENT, en se nommant. `"false"` est « truthy » : le convertir donnerait tout l'accès à
 *     qui a voulu le retirer.
 *  2. Drapeau de MARQUES final posé → le contrôle « la marque avant ses templates » ne s'applique
 *     plus : toutes les marques sont ouvertes, il n'y a pas d'octroi mort possible.
 *  3. ⛔ Drapeau de TEMPLATES posé → le contrôle RESTE ENTIER. « All templates » n'ouvre aucune
 *     marque ; un octroi hors marque y serait exactement aussi mort qu'avant. Confondre les deux
 *     ici désarmerait le contrôle pour de bon, et c'est le mutant le plus facile à écrire.
 *  4. Drapeau de marques retiré (dans cette requête ou jamais posé) → le contrôle revient, entier.
 *  5. `false` est une modification à ÉCRIRE, pas une absence — sur chacun des deux.
 */
import { describe, expect, test } from "bun:test";

// ⚠️ `handler.ts` tire `@/lib/data/templates` (pour `isUuid`) → `@/lib/session` → `auth.ts`, qui
// LÈVE à l'import si AUTH_SECRET manque. Même parade que les autres bancs de handler.
process.env.AUTH_SECRET = "secret-de-test-uniquement-22092026";
const { preparerModification } = await import("./handler");

const USER = "11111111-1111-4111-8111-111111111111";
const MARQUE_A = "aaaaaaaa-0000-4000-8000-000000000001";
const MARQUE_B = "bbbbbbbb-0000-4000-8000-000000000002";
const TPL_A = "dddddddd-0000-4000-8000-00000000000a";
const TPL_B = "dddddddd-0000-4000-8000-00000000000b";

type Requete = { table: string; filtres: Record<string, unknown> };

/** Le compte a reçu la marque A seule ; TPL_A est dans A, TPL_B dans B. */
function fauxDb() {
  const journal: Requete[] = [];
  const from = (table: string) => {
    const ctx: Requete = { table, filtres: {} };
    const q = {
      select: (_c?: string) => q,
      eq: (k: string, v: unknown) => {
        ctx.filtres[k] = v;
        return q;
      },
      in: (k: string, v: unknown[]) => {
        ctx.filtres[`${k}:in`] = v;
        return q;
      },
      then: (resoudre: (v: unknown) => unknown) => {
        journal.push(ctx);
        if (table === "app_user_asset") return Promise.resolve(resoudre({ data: [{ asset_id: MARQUE_A }], error: null }));
        if (table === "template") {
          const ids = (ctx.filtres["id:in"] as string[]) ?? [];
          const lignes = [
            { id: TPL_A, asset_id: MARQUE_A },
            { id: TPL_B, asset_id: MARQUE_B },
          ].filter((l) => ids.includes(l.id));
          return Promise.resolve(resoudre({ data: lignes, error: null }));
        }
        return Promise.resolve(resoudre({ data: null, error: { message: `table inattendue : ${table}` } }));
      },
    };
    return q;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from } as any, journal };
}

/** ⚠️ La cible ne porte que `all_assets` : c'est le seul drapeau dont ce contrôle dépend. */
const membre = (allAssets: boolean) => ({
  id: USER,
  role: "member" as const,
  status: "active" as const,
  password_hash: "pbkdf2$1$x$y",
  all_assets: allAssets,
});

describe("allAssets / allTemplates — validation, chacun pour soi", () => {
  test("tout ce qui n'est pas un booléen est refusé en 400, sans rien lire", async () => {
    // ⚠️ Pas de `test.each` dans apps/admin (TS2339) : boucles explicites.
    for (const champ of ["allAssets", "allTemplates"]) {
      for (const v of ["true", "false", 1, 0, null, {}] as unknown[]) {
        const { db, journal } = fauxDb();
        const d = await preparerModification({ [champ]: v }, membre(false), db);
        expect(d.ok).toBe(false);
        if (!d.ok) {
          expect(d.statut).toBe(400);
          // ⛔ Le message NOMME le champ fautif : sinon l'administrateur corrige l'autre.
          expect(d.erreur).toContain(champ);
        }
        expect(journal).toHaveLength(0);
      }
    }
  });

  test("absents : inchangés (undefined) ; false : des valeurs à écrire", async () => {
    const sans = await preparerModification({}, membre(true), fauxDb().db);
    expect(sans.ok && sans.modif.allAssets).toBeUndefined();
    expect(sans.ok && sans.modif.allTemplates).toBeUndefined();

    const faux = await preparerModification(
      { allAssets: false, allTemplates: false },
      membre(true),
      fauxDb().db,
    );
    expect(faux.ok).toBe(true);
    if (faux.ok) {
      expect(faux.modif.allAssets).toBe(false);
      expect(faux.modif.allTemplates).toBe(false);
    }
  });

  test("les deux drapeaux traversent SÉPARÉMENT — le cas d'Alix : une marque, tous les templates", async () => {
    const d = await preparerModification(
      { allAssets: false, allTemplates: true, assetIds: [MARQUE_A], templateIds: [TPL_A] },
      membre(false),
      fauxDb().db,
    );
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.modif.allAssets).toBe(false);
      expect(d.modif.allTemplates).toBe(true);
      expect(d.modif.assetIds).toEqual([MARQUE_A]);
    }
  });
});

describe("contrôle « la marque avant ses templates » — suit le drapeau de MARQUES, et lui seul", () => {
  test("membre sans le drapeau : un template d'une marque non octroyée est refusé", async () => {
    const { db } = fauxDb();
    const d = await preparerModification({ templateIds: [TPL_A, TPL_B] }, membre(false), db);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.statut).toBe(400);
      expect(d.extra).toEqual({ templateIds: [TPL_B] });
    }
  });

  test("membre sans le drapeau : un template de SA marque passe", async () => {
    const d = await preparerModification({ templateIds: [TPL_A] }, membre(false), fauxDb().db);
    expect(d.ok).toBe(true);
  });

  test("⛔ « All templates » coché NE DÉSARME PAS le contrôle — il n'ouvre aucune marque", async () => {
    // Le mutant « le contrôle lit allTemplates » meurt ici : TPL_B est dans la marque B, que ce
    // compte ne voit pas, et « tous les templates » ne l'y emmène pas.
    const { db } = fauxDb();
    const d = await preparerModification(
      { allTemplates: true, assetIds: [MARQUE_A], templateIds: [TPL_B] },
      membre(false),
      db,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.statut).toBe(400);
      expect(d.extra).toEqual({ templateIds: [TPL_B] });
    }
  });

  test("« All brands » coché dans CETTE requête : plus de contrôle, et aucune lecture", async () => {
    const { db, journal } = fauxDb();
    const d = await preparerModification(
      { allAssets: true, assetIds: [MARQUE_A], templateIds: [TPL_B] },
      membre(false),
      db,
    );
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.modif.allAssets).toBe(true);
      // La sélection explicite part telle quelle : elle est conservée pour le jour où l'on décoche.
      expect(d.modif.assetIds).toEqual([MARQUE_A]);
      expect(d.modif.templateIds).toEqual([TPL_B]);
    }
    expect(journal).toHaveLength(0);
  });

  test("« All brands » déjà posé en base et non renvoyé : toujours pas de contrôle", async () => {
    const { db, journal } = fauxDb();
    const d = await preparerModification({ templateIds: [TPL_B] }, membre(true), db);
    expect(d.ok).toBe(true);
    expect(journal).toHaveLength(0);
  });

  test("« All brands » DÉCOCHÉ dans cette requête : le contrôle revient, sur l'état final", async () => {
    const { db } = fauxDb();
    const d = await preparerModification(
      { allAssets: false, assetIds: [MARQUE_A], templateIds: [TPL_B] },
      membre(true),
      db,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.extra).toEqual({ templateIds: [TPL_B] });
  });

  test("⛔ « All brands » décoché ET « All templates » coché : le contrôle revient quand même", async () => {
    const { db } = fauxDb();
    const d = await preparerModification(
      { allAssets: false, allTemplates: true, assetIds: [MARQUE_A], templateIds: [TPL_B] },
      membre(true),
      db,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.extra).toEqual({ templateIds: [TPL_B] });
  });

  test("super_admin final : pas de contrôle (inchangé)", async () => {
    const { db, journal } = fauxDb();
    const d = await preparerModification({ role: "super_admin", templateIds: [TPL_B] }, membre(false), db);
    expect(d.ok).toBe(true);
    expect(journal).toHaveLength(0);
  });
});

describe("rôle et statut — inchangés par 0075", () => {
  test("rôle inconnu : 400", async () => {
    const d = await preparerModification({ role: "owner" }, membre(false), fauxDb().db);
    expect(!d.ok && d.statut).toBe(400);
  });

  test("statut « invited » posé à la main : 400 ; compte encore invité : 409", async () => {
    const a = await preparerModification({ status: "invited" }, membre(false), fauxDb().db);
    expect(!a.ok && a.statut).toBe(400);
    const b = await preparerModification({ status: "active" }, { ...membre(false), status: "invited" }, fauxDb().db);
    expect(!b.ok && b.statut).toBe(409);
  });
});
