/**
 * Banc de la barre latérale — le groupe « Automations » (24/09/2026).
 *
 * Ce qui est tenu : le groupe existe ENTRE Content et System avec ses trois entrées ; Segments a
 * quitté Monitoring (il vit sous Targeting) et n'est plus nulle part à son ancienne adresse ; aucune
 * entrée de la section n'exige un rôle (les écrans déplacés étaient ouverts à tous) ; un seul lien
 * est actif à la fois, le plus précis.
 */
import { describe, expect, test } from "bun:test";
import { NAV, lienActif } from "./sidebar";

const groupe = (nom: string) => NAV.find((s) => s.group === nom);
const HREFS = NAV.flatMap((s) => s.items.map((i) => i.href));

describe("barre latérale — groupe Automations", () => {
  test("ordre des groupes : Automations entre Content et System", () => {
    expect(NAV.map((s) => s.group)).toEqual(["Monitoring", "Content", "Automations", "System", "Help"]);
  });

  // « Lifecycle emails » a fondu dans la carte System de /automations (24/09/2026, feature 3).
  test("les deux entrées, dans cet ordre", () => {
    expect(groupe("Automations")?.items.map((i) => [i.label, i.href])).toEqual([
      ["Automations", "/automations"],
      ["Targeting", "/automations/targeting"],
    ]);
  });

  test("aucune entrée de la section n'exige un rôle (droits inchangés)", () => {
    expect(groupe("Automations")?.items.filter((i) => i.requires !== undefined)).toEqual([]);
  });

  test("⛔ Segments n'est plus sous Monitoring, ni nulle part à /segments", () => {
    expect(groupe("Monitoring")?.items.map((i) => i.href)).toEqual(["/", "/subscribers"]);
    expect(HREFS.includes("/segments")).toBe(false);
  });

  test("les réservations super_admin de System n'ont pas bougé", () => {
    expect(
      groupe("System")?.items.filter((i) => i.requires === "super_admin").map((i) => i.href),
    ).toEqual(["/deliverability", "/users", "/settings"]);
  });
});

describe("barre latérale — Analytics (feature 7, 24/09/2026)", () => {
  test("Analytics suit Campaigns dans Content, sans rôle exigé (tous ceux qui ont accès à la marque)", () => {
    const items = groupe("Content")?.items ?? [];
    const i = items.findIndex((x) => x.href === "/campaigns");
    expect(items[i + 1]?.label).toBe("Analytics");
    expect(items[i + 1]?.href).toBe("/analytics");
    expect(items[i + 1]?.requires).toBeUndefined();
  });

  test("les sous-pages d'une campagne allument Analytics, pas Campaigns", () => {
    expect(lienActif("/analytics/campaigns/abc", HREFS)).toBe("/analytics");
  });
});

describe("lien actif — un seul, le plus précis", () => {
  test("sur /automations/targeting, seule « Targeting » est active (pas « Automations »)", () => {
    expect(lienActif("/automations/targeting", HREFS)).toBe("/automations/targeting");
  });

  test("sur la page d'un e-mail (/automations/system/welcome), c'est « Automations »", () => {
    expect(lienActif("/automations/system/welcome", HREFS)).toBe("/automations");
  });

  test("sur /automations, c'est l'accueil de la section", () => {
    expect(lienActif("/automations", HREFS)).toBe("/automations");
  });

  test("les sous-pages restent rattachées à leur entrée", () => {
    expect(lienActif("/subscribers/capture", HREFS)).toBe("/subscribers");
    expect(lienActif("/builder/123", HREFS)).toBe("/builder");
  });

  test("« / » n'est actif que sur l'accueil, et `/formsX` n'allume pas « Forms »", () => {
    expect(lienActif("/", HREFS)).toBe("/");
    expect(lienActif("/formsX", HREFS)).toBeNull();
  });
});
