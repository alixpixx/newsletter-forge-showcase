import { describe, expect, test } from "bun:test";
import { debutPeriode, lireMasquees, lirePage, lirePeriode, lireRecherche, urlListe } from "./analytics-params";

describe("paramètres de la liste Analytics", () => {
  test("période : 30, 90, all ; tout le reste retombe sur 90 (jamais sur « tout »)", () => {
    expect(lirePeriode("30")).toBe("30");
    expect(lirePeriode("all")).toBe("all");
    expect(lirePeriode(undefined)).toBe("90");
    expect(lirePeriode("365")).toBe("90");
    expect(lirePeriode(["all", "30"])).toBe("all");
  });

  test("page : entier ≥ 1, sinon 1", () => {
    expect(lirePage("3")).toBe(3);
    expect(lirePage("0")).toBe(1);
    expect(lirePage("-2")).toBe(1);
    expect(lirePage("abc")).toBe(1);
    expect(lirePage(undefined)).toBe(1);
  });

  test("recherche : rognée et bornée à 200 caractères", () => {
    expect(lireRecherche("  friday ")).toBe("friday");
    expect(lireRecherche("x".repeat(300))).toHaveLength(200);
  });

  test("début de période : N jours avant maintenant, rien pour « All time »", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    expect(debutPeriode("30", now)?.toISOString()).toBe("2026-08-25T12:00:00.000Z");
    expect(debutPeriode("all", now)).toBeUndefined();
  });

  test("URL : garde les filtres, omet les défauts", () => {
    expect(urlListe({ periode: "90", recherche: "", page: 1 })).toBe("/analytics");
    expect(urlListe({ periode: "30", recherche: "a&b", page: 2 })).toBe("/analytics?period=30&q=a%26b&page=2");
  });

  test("masquées : seul « 1 » les montre, tout le reste les cache", () => {
    expect(lireMasquees("1")).toBe(true);
    expect(lireMasquees(["1", "0"])).toBe(true);
    expect(lireMasquees(undefined)).toBe(false);
    expect(lireMasquees("0")).toBe(false);
    expect(lireMasquees("true")).toBe(false);
    expect(lireMasquees("")).toBe(false);
  });

  test("URL : `hidden=1` gardé avec les autres filtres, omis quand faux", () => {
    expect(urlListe({ periode: "90", recherche: "", page: 1, masquees: true })).toBe("/analytics?hidden=1");
    expect(urlListe({ periode: "all", recherche: "x", page: 3, masquees: true })).toBe("/analytics?period=all&q=x&hidden=1&page=3");
    expect(urlListe({ periode: "30", recherche: "", page: 1, masquees: false })).toBe("/analytics?period=30");
  });
});
