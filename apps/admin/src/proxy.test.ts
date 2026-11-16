/**
 * Banc du proxy — les redirections des écrans déplacés sous « Automations » (24/09/2026), mesurées
 * sur le VRAI `proxy()` : une table juste qui ne serait pas appelée, ou appelée avec le mauvais
 * statut, ne redirigerait personne.
 *
 * ⚠️ `auth.ts` lève à l'import si AUTH_SECRET manque : le proxy est donc chargé DYNAMIQUEMENT, après
 * avoir posé la variable (même motif que `lib/auth.test.ts`).
 *
 * ⛔ LA MÊME VALEUR QUE `lib/auth.test.ts`, À L'OCTET. `bun test` charge `auth.ts` UNE fois pour tous
 * les fichiers, et le secret y est lu à l'import : si ce banc passe le premier avec une autre valeur,
 * le module la garde, et `auth.test.ts` — qui signe avec `process.env.AUTH_SECRET` lu à la main —
 * voit sa session témoin refusée (mesuré : 1 échec dans la suite complète, 0 fichier par fichier).
 */
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

process.env.AUTH_SECRET = "secret-de-test-uniquement-31082026";
const { proxy } = await import("./proxy");
const { signSession, SESSION_COOKIE } = await import("./lib/auth");

const MEMBRE = await signSession({
  uid: "11111111-2222-3333-4444-555555555555",
  email: "membre@example.test",
  role: "member",
});

async function appeler(adresse: string, session: string | null = MEMBRE) {
  const req = new NextRequest(new URL(adresse, "http://admin.local"), {
    headers: session ? { cookie: `${SESSION_COOKIE}=${session}` } : {},
  });
  const res = await proxy(req);
  const location = res.headers.get("location");
  return {
    status: res.status,
    // Chemin + requête seulement : l'hôte est celui de la requête, il ne se juge pas ici.
    vers: location ? new URL(location).pathname + new URL(location).search : null,
  };
}

describe("proxy — anciennes adresses : 308 vers la nouvelle", () => {
  test("/segments → 308 /automations/targeting", async () => {
    expect(await appeler("/segments")).toEqual({ status: 308, vers: "/automations/targeting" });
  });

  test("/segments/x?y=1 → 308, sous-chemin et requête conservés", async () => {
    expect(await appeler("/segments/x?y=1")).toEqual({ status: 308, vers: "/automations/targeting/x?y=1" });
  });

  test("/templates?lifecycle=1 → 308 /automations, sans la requête de la liste", async () => {
    expect(await appeler("/templates?lifecycle=1")).toEqual({ status: 308, vers: "/automations" });
  });

  test("/automations/lifecycle → 308 /automations (la page a fondu dans la carte System)", async () => {
    expect(await appeler("/automations/lifecycle")).toEqual({ status: 308, vers: "/automations" });
  });
});

describe("proxy — ce qui ne redirige pas", () => {
  test("/templates?lifecycle=0 passe (comparaison fermée)", async () => {
    const r = await appeler("/templates?lifecycle=0");
    expect(r.status).toBe(200);
    expect(r.vers).toBeNull();
  });

  test("les trois écrans de la section passent, pour un MEMBRE (aucun droit ajouté)", async () => {
    for (const a of ["/automations", "/automations/system/welcome", "/automations/targeting"]) {
      const r = await appeler(a);
      expect(r.status).toBe(200);
      expect(r.vers).toBeNull();
    }
  });

  test("⛔ sans session, /segments mène à /login d'abord (la session reste le premier contrôle)", async () => {
    const r = await appeler("/segments", null);
    expect(r.status === 308).toBe(false);
    expect(r.vers).toBe("/login");
  });

  test("les routes réservées le restent : un membre sur /users repart à l'accueil", async () => {
    expect((await appeler("/users")).vers).toBe("/");
  });
});
