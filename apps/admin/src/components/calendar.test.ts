/**
 * ARITHMÉTIQUE DU CALENDRIER — les cas qui cassent les calendriers écrits à la main.
 *
 * Chaque banc vise une mutation précise : repasser en `new Date(y, m, d)` local (le jour qui se
 * dédouble un soir de changement d'heure), oublier la validation du 31 février, laisser la grille
 * changer de hauteur selon le mois.
 */
import { describe, expect, test } from "bun:test";
import { addDaysYmd, addMonthsYmd, avant, grilleDuMois, jourDeSemaine, joursDansLeMois, parseYmd, toYmd } from "./calendar";

describe("parseYmd", () => {
  test("lit une date valide", () => {
    expect(parseYmd("2026-09-18")).toEqual([2026, 9, 18]);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : renvoyer les nombres sans revérifier que la date existe.
   * `new Date(Date.UTC(2026, 1, 31))` glisse au 3 mars sans lever : le formulaire accepterait un
   * 31 février et programmerait un envoi trois jours plus tard que ce qui est affiché.
   */
  test("refuse une date qui n'existe pas", () => {
    expect(parseYmd("2026-02-31")).toBeNull();
    expect(parseYmd("2026-13-01")).toBeNull();
    expect(parseYmd("2026-00-10")).toBeNull();
    expect(parseYmd("18/09/2026")).toBeNull();
    expect(parseYmd("")).toBeNull();
  });

  test("accepte le 29 février d'une année bissextile, refuse celui d'une autre", () => {
    expect(parseYmd("2024-02-29")).toEqual([2024, 2, 29]);
    expect(parseYmd("2026-02-29")).toBeNull();
  });
});

describe("addDaysYmd", () => {
  test("franchit les fins de mois et d'année", () => {
    expect(addDaysYmd("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysYmd("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysYmd("2024-02-28", 1)).toBe("2024-02-29");
  });

  /**
   * ⛔ LE BANC CENTRAL. MUTATION QUI DOIT LE TUER : calculer en heure LOCALE
   * (`new Date(y, m, d + delta)`). Le 6 septembre 2026, le Chili — fuseau de Copper Kettle — avance
   * d'une heure à minuit : en local, « +1 jour » depuis le 5 peut retomber sur le 5, et le
   * calendrier affiche deux fois la même date. En UTC, une date civile reste un compteur de jours.
   */
  test("n'est pas troublé par un changement d'heure", () => {
    expect(addDaysYmd("2026-09-05", 1)).toBe("2026-09-06");
    expect(addDaysYmd("2026-09-06", 1)).toBe("2026-09-07");
    // Un aller-retour de 365 jours retombe sur la même date (année non bissextile).
    expect(addDaysYmd(addDaysYmd("2026-03-15", 365), -365)).toBe("2026-03-15");
  });
});

describe("addMonthsYmd", () => {
  test("garde le dernier jour du mois quand le jour n'existe pas", () => {
    expect(addMonthsYmd("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsYmd("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonthsYmd("2026-03-31", -1)).toBe("2026-02-28");
  });

  test("franchit l'année", () => {
    expect(addMonthsYmd("2026-12-10", 1)).toBe("2027-01-10");
    expect(addMonthsYmd("2026-01-10", -1)).toBe("2025-12-10");
  });
});

describe("grilleDuMois", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : produire un nombre variable de semaines (5 ou 6 selon le mois).
   * Le panneau changerait de hauteur d'un mois à l'autre et la date sous le curseur se déplacerait.
   */
  test("rend toujours 42 jours, du lundi au dimanche", () => {
    for (const [y, m] of [[2026, 2], [2026, 9], [2024, 2], [2027, 8]] as const) {
      const g = grilleDuMois(y, m);
      expect(g).toHaveLength(42);
      expect(jourDeSemaine(g[0]!)).toBe(0); // lundi
      expect(jourDeSemaine(g[41]!)).toBe(6); // dimanche
      expect(g.every((d, i) => i === 0 || d === addDaysYmd(g[i - 1]!, 1))).toBe(true);
    }
  });

  test("contient tout le mois demandé, et déborde des deux côtés", () => {
    const g = grilleDuMois(2026, 9); // septembre 2026 commence un mardi
    expect(g[0]).toBe("2026-08-31");
    expect(g).toContain("2026-09-01");
    expect(g).toContain("2026-09-30");
    expect(g.filter((d) => d.startsWith("2026-09-"))).toHaveLength(30);
  });

  test("un mois qui commence un lundi ne décale pas la grille", () => {
    expect(grilleDuMois(2026, 6)[0]).toBe("2026-06-01"); // 1er juin 2026 = lundi
  });
});

describe("joursDansLeMois / jourDeSemaine / avant / toYmd", () => {
  test("compte les jours, février compris", () => {
    expect(joursDansLeMois(2026, 2)).toBe(28);
    expect(joursDansLeMois(2024, 2)).toBe(29);
    expect(joursDansLeMois(2026, 9)).toBe(30);
    expect(joursDansLeMois(2026, 12)).toBe(31);
  });

  test("lundi = 0, dimanche = 6", () => {
    expect(jourDeSemaine("2026-09-14")).toBe(0); // lundi
    expect(jourDeSemaine("2026-09-18")).toBe(4); // vendredi
    expect(jourDeSemaine("2026-09-20")).toBe(6); // dimanche
  });

  test("compare et met en forme", () => {
    expect(avant("2026-09-17", "2026-09-18")).toBe(true);
    expect(avant("2026-09-18", "2026-09-18")).toBe(false);
    expect(toYmd(2026, 9, 1)).toBe("2026-09-01");
    expect(toYmd(864, 1, 2)).toBe("0864-01-02");
  });
});
