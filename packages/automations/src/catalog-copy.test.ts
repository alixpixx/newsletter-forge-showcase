import { describe, expect, test } from "bun:test";
import { TRIGGERS, VARIABLES } from "./catalog";

/**
 * ⛔ LES TEXTES DU CATALOGUE SONT AFFICHÉS DANS L'ADMIN : pas de renvoi au plan interne. « (decision
 * D3) » parlait à celui qui a écrit le plan, pas à la personne qui crée l'automation (vu sur la
 * page d'une automation le 24/09/2026). Le numéro de ligne du tableau des besoins (« Row 6 of the
 * automation sheet ») RESTE : c'est le document de l'équipe qui utilise l'écran.
 */
describe("textes affichés du catalogue", () => {
  test("aucun renvoi aux décisions du plan interne", () => {
    const textes = JSON.stringify({ TRIGGERS, VARIABLES });
    expect(/decision D\d/i.test(textes)).toBe(false);
  });

  test("contre-épreuve : le banc lit bien les descriptions affichées", () => {
    const textes = JSON.stringify({ TRIGGERS, VARIABLES });
    expect(textes.includes("Greets a returning subscriber AFTER the new confirmation")).toBe(true);
  });
});
