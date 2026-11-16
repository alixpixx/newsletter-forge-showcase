/**
 * Recherche + filtre par catégorie de la bibliothèque de modèles (Chloé, 26/09/2026).
 *
 * Ce qui est tenu :
 *  - casse ET accents ignorés, dans les deux sens (« boletin » ↔ « Boletín ») ;
 *  - la recherche porte sur le nom ET le sous-titre (slug) ; plusieurs mots = tous requis, dans tout ordre ;
 *  - recherche × catégorie se combinent ; une recherche blanche n'est pas un filtre ;
 *  - les pastilles : catégories PRÉSENTES dans le périmètre (stables pendant la frappe), comptées sur la
 *    recherche, dans l'ordre de la contrainte CHECK, une catégorie inconnue à la fin, une catégorie
 *    demandée mais absente toujours visible (à 0) ;
 *  - l'URL : `?q=&type=` posés/retirés sans toucher aux autres paramètres (onglet…) ;
 *  - le compteur « N of M templates » et le message de l'état vide.
 */
import { describe, expect, test } from "bun:test";
import {
  FILTRE_VIDE,
  compteur,
  filtrerModeles,
  lireFiltre,
  messageAucun,
  normaliser,
  urlFiltre,
} from "./template-filter";

const L = (id: string, name: string, slug: string, category: string) => ({ id, name, slug, category });
const ROWS = [
  L("a", "Boletín Diario", "boletin-diario", "newsletter"),
  L("b", "Welcome series — step 1", "welcome-1", "welcome"),
  L("c", "Password reset", "password-reset", "transactional"),
  L("d", "Prévia do jogo", "previa-jogo", "preview"),
  L("e", "Weekly roundup", "weekly-roundup", "newsletter"),
  L("f", "Legacy promo", "legacy-promo", "promo_legacy"), // catégorie inconnue de l'UI (base plus récente)
];
const ids = (recherche: string, type = "") => filtrerModeles(ROWS, { recherche, type }).visibles.map((t) => t.id);

describe("recherche", () => {
  test("⛔ accents ignorés dans les deux sens : « boletin » trouve « Boletín », « prévia » trouve « previa »", () => {
    expect(normaliser("Boletín Ñandú")).toBe("boletin nandu");
    expect(ids("boletin")).toEqual(["a"]);
    expect(ids("BOLETÍN")).toEqual(["a"]);
    expect(ids("previa")).toEqual(["d"]);
  });

  test("casse ignorée : « WEEKLY » trouve « Weekly roundup »", () => {
    expect(ids("WEEKLY")).toEqual(["e"]);
  });

  test("le sous-titre (slug) est cherché, pas seulement le nom", () => {
    expect(ids("welcome-1")).toEqual(["b"]);
  });

  test("plusieurs mots : TOUS requis, dans n'importe quel ordre", () => {
    expect(ids("diario boletin")).toEqual(["a"]);
    expect(ids("boletin weekly")).toEqual([]);
  });

  test("une recherche blanche n'est pas un filtre", () => {
    const r = filtrerModeles(ROWS, { recherche: "   ", type: "" });
    expect(r.visibles).toHaveLength(6);
    expect(r.actif).toBe(false);
  });
});

describe("catégorie", () => {
  test("⛔ recherche × catégorie se combinent", () => {
    expect(ids("", "newsletter")).toEqual(["a", "e"]);
    expect(ids("weekly", "newsletter")).toEqual(["e"]);
    expect(ids("reset", "newsletter")).toEqual([]);
    expect(filtrerModeles(ROWS, { recherche: "", type: "newsletter" }).actif).toBe(true);
  });

  test("les pastilles : présentes dans le PÉRIMÈTRE, comptées sur la RECHERCHE", () => {
    const r = filtrerModeles(ROWS, { recherche: "week", type: "" });
    expect(r.total).toBe(6);
    expect(r.nRecherche).toBe(1);
    expect(r.categories.map((c) => [c.categorie, c.n])).toEqual([
      ["newsletter", 1],
      ["preview", 0],
      ["welcome", 0],
      ["transactional", 0],
      ["promo_legacy", 0],
    ]);
  });

  test("ordre de la contrainte CHECK, une catégorie inconnue en dernier, libellés de l'UI", () => {
    const r = filtrerModeles([...ROWS].reverse(), FILTRE_VIDE);
    expect(r.categories.map((c) => c.label)).toEqual(["Newsletter", "Preview", "Welcome", "Transactional", "promo_legacy"]);
  });

  test("une catégorie demandée mais absente reste une pastille, active et à 0 (jamais un filtre invisible)", () => {
    const r = filtrerModeles(ROWS, { recherche: "", type: "daily_pick" });
    expect(r.visibles).toEqual([]);
    expect(r.categories.find((c) => c.categorie === "daily_pick")).toEqual({ categorie: "daily_pick", label: "Daily pick", n: 0 });
  });
});

describe("adresse", () => {
  test("lireFiltre : `?q=&type=` lus, absents = aucun filtre, recherche bornée à 200", () => {
    const p = new URLSearchParams("q=Bolet%C3%ADn&type=welcome&tab=x");
    expect(lireFiltre((k) => p.get(k))).toEqual({ recherche: "Boletín", type: "welcome" });
    expect(lireFiltre(() => null)).toEqual(FILTRE_VIDE);
    expect(lireFiltre((k) => (k === "q" ? "x".repeat(500) : null)).recherche).toHaveLength(200);
  });

  test("⛔ urlFiltre garde les AUTRES paramètres et retire un filtre vide", () => {
    expect(urlFiltre("/templates", "?tab=brand&x=1", { recherche: "  boletin  ", type: "welcome" })).toBe(
      "/templates?tab=brand&x=1&q=boletin&type=welcome",
    );
    expect(urlFiltre("/templates", "?q=a&type=b&tab=legal", FILTRE_VIDE)).toBe("/templates?tab=legal");
    expect(urlFiltre("/templates", "?q=a", { recherche: "   ", type: "" })).toBe("/templates");
  });
});

describe("compteur et état vide", () => {
  test("« N of M templates » seulement quand un filtre est posé ; le pluriel suit M", () => {
    expect(compteur(filtrerModeles(ROWS, FILTRE_VIDE))).toBe("");
    expect(compteur(filtrerModeles(ROWS, { recherche: "boletin", type: "" }))).toBe("1 of 6 templates");
    expect(compteur(filtrerModeles(ROWS.slice(0, 1), { recherche: "boletin", type: "" }))).toBe("1 of 1 template");
  });

  test("l'état vide nomme ce qui a été cherché", () => {
    expect(messageAucun({ recherche: " xyz ", type: "" })).toBe("No template matches “xyz”");
    expect(messageAucun({ recherche: "xyz", type: "welcome" })).toBe("No Welcome template matches “xyz”");
    expect(messageAucun({ recherche: "", type: "daily_pick" })).toBe("No Daily pick template");
  });
});
