import { describe, expect, test } from "bun:test";

// ⚠️ `subscribers.ts` importe `auth.ts`, qui lève à l'import sans AUTH_SECRET : chargement DYNAMIQUE,
// avec la MÊME valeur que `auth.test.ts` et `proxy.test.ts` (le module la garde pour toute la suite).
process.env.AUTH_SECRET ??= "secret-de-test-uniquement-31082026";
const { getActiveTotal } = await import("./subscribers");

/**
 * ⛔ LE TOTAL D'ABONNÉS ACTIFS DIT QUAND IL N'A PAS ÉTÉ LU : `null`, jamais 0. L'écran
 * Automations › Targeting affichait « 0 active subscribers in scope » base coupée (24/09/2026) — un
 * chiffre que rien n'avait lu. Un VRAI zéro, lui, reste 0.
 *
 * ⚠️ L'environnement et `fetch` sont remplacés le temps d'un appel, puis rendus dans un `finally` :
 * le shim de types des tests admin n'a pas d'`afterEach`.
 */
const ENV = { SUPABASE_URL: "https://nf.invalid", SUPABASE_SERVICE_ROLE_KEY: "cle-factice-de-test" };

async function avec<T>(
  env: Record<string, string | undefined>,
  reponse: (() => Response) | null,
  f: () => Promise<T>,
): Promise<T> {
  const cles = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const avant = cles.map((k) => process.env[k]);
  const fetchAvant = globalThis.fetch;
  try {
    for (const k of cles) {
      const v = env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (reponse) globalThis.fetch = (async () => reponse()) as unknown as typeof fetch;
    return await f();
  } finally {
    cles.forEach((k, i) => {
      const v = avant[i];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    globalThis.fetch = fetchAvant;
  }
}

describe("getActiveTotal", () => {
  test("pas de base ⇒ null, pas 0", async () => {
    expect(await avec({}, null, () => getActiveTotal("a1"))).toBe(null);
  });

  test("la base répond une erreur ⇒ null, pas 0", async () => {
    const erreur = () =>
      new Response(JSON.stringify({ message: "boom", code: "XX000" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    expect(await avec(ENV, erreur, () => getActiveTotal("a1"))).toBe(null);
  });

  test("la base compte ⇒ le compte lu", async () => {
    const compte = () => new Response(null, { status: 200, headers: { "content-range": "*/1056" } });
    expect(await avec(ENV, compte, () => getActiveTotal("a1"))).toBe(1056);
  });

  test("un VRAI zéro lu reste 0", async () => {
    const zero = () => new Response(null, { status: 200, headers: { "content-range": "*/0" } });
    expect(await avec(ENV, zero, () => getActiveTotal("a1"))).toBe(0);
  });
});
