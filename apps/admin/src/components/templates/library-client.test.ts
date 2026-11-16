/**
 * `fetchPartials` — la fente d'une entrée de bibliothèque est LUE, jamais déduite.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. Avant 0080, le client rangeait « tout ce qui n'est pas un
 * footer » en header. Un bloc serait donc apparu sous l'onglet Header de la modale « Import template »
 * et dans le sélecteur d'en-tête de l'inspecteur — l'importer le posait en tête de l'e-mail.
 *
 * ⚠️ `fetch` est remplacé le temps d'un appel, puis rendu dans un `finally` : aucun `mock.module`,
 * aucune fuite vers les autres fichiers de la suite. (Pas d'`afterEach` : le shim de types des tests
 * admin ne l'exporte pas, et `tsc -p apps/admin` compterait une erreur de plus.)
 */
import { describe, expect, test } from "bun:test";
import { fetchPartials } from "./library-client";

/** `fetchPartials` contre un serveur qui répond `corps` ; rend le résultat, ou le message levé. */
async function lireAvec(corps: unknown, status = 200): Promise<{ lu?: Awaited<ReturnType<typeof fetchPartials>>; message: string | null }> {
  const vrai = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(corps), { status })) as unknown as typeof fetch;
  try {
    return { lu: await fetchPartials(), message: null };
  } catch (e) {
    return { message: (e as Error).message };
  } finally {
    globalThis.fetch = vrai;
  }
}

const entree = (id: string, slot: unknown) => ({ id, slot, name: `n-${id}`, rows: [{ id: `${id}_r` }] });

describe("fetchPartials — la fente", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : revenir à `slot: r.slot === "footer" ? "footer" : "header"`.
   */
  test("une ligne `block` reste un bloc : elle n'apparaît JAMAIS sous l'onglet Header", async () => {
    const { lu = [] } = await lireAvec({ brandPartials: [entree("h", "header"), entree("b", "block"), entree("f", "footer")] });
    expect(lu.map((p) => p.slot)).toEqual(["header", "block", "footer"]);
    // Ce que filtre l'onglet Header de la modale, et le sélecteur d'en-tête de l'inspecteur.
    expect(lu.filter((p) => p.slot === "header").map((p) => p.id)).toEqual(["h"]);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : ranger une fente inconnue dans une fente connue au lieu de lever.
   * Symptôme : un admin plus ancien que la bibliothèque afficherait un objet qu'il ne sait pas placer.
   */
  test("une fente inconnue est une LECTURE RATÉE (l'appelant affiche le message), pas un header", async () => {
    const { message } = await lireAvec({ brandPartials: [entree("h", "header"), entree("x", "sidebar")] });
    expect(message === null).toBe(false);
    expect(String(message).includes("unknown kind")).toBe(true);
  });

  test("témoin : une réponse en erreur lève avec le message du serveur", async () => {
    const { message } = await lireAvec({ error: "could not read this brand's headers, footers and blocks" }, 503);
    expect(message).toBe("could not read this brand's headers, footers and blocks");
  });
});
