import { describe, expect, test } from "bun:test";
import { canonicalMessageId } from "./message-id";

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. Les deux bouts de la chaîne d'événements — le worker qui
 * STOCKE l'identifiant rendu par le fournisseur, le webhook qui le CHERCHE — doivent produire la
 * même chaîne à partir des mêmes octets. Quand ils divergent, l'événement s'écrit quand même, sans
 * destinataire ni marque, avec un 200 rendu au fournisseur : aucune erreur, aucun rejeu, et un
 * calcul d'engagement qui rendra zéro pour tout le monde.
 */
describe("canonicalMessageId", () => {
  test("la forme avec chevrons et la forme nue donnent la MÊME chaîne", () => {
    const nu = "20260908.abc123@mg.quartz-tips.example";
    expect(canonicalMessageId(`<${nu}>`)).toBe(nu);
    expect(canonicalMessageId(nu)).toBe(nu);
    // Le point du banc : l'égalité entre les deux bouts, pas la valeur elle-même.
    expect(canonicalMessageId(`<${nu}>`)).toBe(canonicalMessageId(nu));
  });

  test("la casse de l'hôte ne fabrique pas deux identifiants", () => {
    expect(canonicalMessageId("<ABC@MG.Quartz-Tips.EXAMPLE>")).toBe("abc@mg.quartz-tips.example");
  });

  test("espaces et chevrons répétés sont absorbés", () => {
    expect(canonicalMessageId("  <<a@b>>  ")).toBe("a@b");
  });

  test("une valeur absente rend une chaîne vide, jamais \"undefined\"", () => {
    // ⛔ L'appelant doit traiter "" comme « pas d'identifiant » : chercher `= ''` en base a l'air
    // d'une requête légitime et ramènerait la mauvaise ligne.
    expect(canonicalMessageId(undefined)).toBe("");
    expect(canonicalMessageId(null)).toBe("");
    expect(canonicalMessageId("   ")).toBe("");
    expect(canonicalMessageId("<>")).toBe("");
  });

  test("un identifiant déjà canonique n'est pas modifié", () => {
    const s = "a1b2c3@mg.example.com";
    expect(canonicalMessageId(canonicalMessageId(s))).toBe(s);
  });
});
