import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

/**
 * L'Overview ne compte pas les contacts hors newsletter (0088, lot E).
 *
 * ⚠️ CE BANC LIT LA SOURCE : `getDashboardStats` prend sa base par `getDb()`, sans point d'injection,
 * et ce qui se tient ici est une seule chose — que le compteur COMMUN à tous les chiffres porte
 * l'exclusion. Posée sur une seule des requêtes, elle laisserait « total » et les semaines compter
 * des gens qui n'ont rien demandé.
 * MUTATION QUI DOIT LE TUER : retirer `.neq("status", "contact")` du compteur `cnt`.
 */
function codeSeul(chemin: string): string {
  return readFileSync(new URL(chemin, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\s+/g, " ");
}

describe("Overview — les contacts ne sont pas des abonnés", () => {
  const source = codeSeul("./dashboard.ts");

  test("le compteur commun exclut le statut contact", () => {
    expect(source).toContain(
      'const cnt = () => db.from("subscription").select("*", { count: "exact", head: true }).eq("asset_id", assetId) .neq("status", "contact");',
    );
  });

  test("tous les chiffres passent par ce compteur, aucun ne lit la table à part", () => {
    expect(source.split('db.from("subscription")').length - 1).toBe(1);
  });
});
