import { describe, expect, test } from "bun:test";
import {
  DEBUT_TOUT,
  bornesSemaines,
  debutAudience,
  grilleCarte,
  intensite,
  jourLocal,
  libelleCreneau,
  libelleSource,
  lignesNiveaux,
  lundi,
  meilleursCreneaux,
  partEngagee,
  pivotSemaines,
} from "./audience-view";

describe("période de l'audience", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  test("30 et 90 jours : comme la liste des campagnes", () => {
    expect(debutAudience("30", now).toISOString()).toBe("2026-09-07T12:00:00.000Z");
    expect(debutAudience("90", now).toISOString()).toBe("2026-07-09T12:00:00.000Z");
  });
  test("⛔ « All time » envoie une date lointaine, jamais rien (le SQL lirait 26 semaines)", () => {
    expect(debutAudience("all", now).toISOString()).toBe(DEBUT_TOUT);
  });
});

describe("carte jour × heure", () => {
  const cases = [
    { dow: 1, hour: 9, opens: 12, clicks: 3 },
    { dow: 7, hour: 23, opens: 2, clicks: 0 },
    { dow: 3, hour: 0, opens: 5, clicks: 1 },
  ];

  test("lignes lundi → dimanche, colonnes 0 → 23 ; une case absente vaut 0", () => {
    const g = grilleCarte(cases, "opens");
    expect(g.valeurs).toHaveLength(7);
    expect(g.valeurs.every((l) => l.length === 24)).toBe(true);
    expect(g.valeurs[0][9]).toBe(12);
    expect(g.valeurs[6][23]).toBe(2);
    expect(g.valeurs[2][0]).toBe(5);
    expect(g.valeurs[0][10]).toBe(0);
    expect(g.max).toBe(12);
    expect(g.total).toBe(19);
  });

  test("les clics se lisent sur leur propre colonne", () => {
    const g = grilleCarte(cases, "clicks");
    expect(g.valeurs[0][9]).toBe(3);
    expect(g.valeurs[2][0]).toBe(1);
    expect(g.max).toBe(3);
    expect(g.total).toBe(4);
  });

  test("carte vide : max 0, total 0", () => {
    const g = grilleCarte([], "opens");
    expect(g.max).toBe(0);
    expect(g.total).toBe(0);
  });

  test("intensité : 0 pour une case vide, ≥ 0,15 dès 1, 1 au maximum", () => {
    expect(intensite(0, 12)).toBe(0);
    expect(intensite(5, 0)).toBe(0);
    expect(intensite(12, 12)).toBe(1);
    expect(intensite(1, 1000)).toBeGreaterThanOrEqual(0.15);
    expect(intensite(6, 12)).toBeLessThan(intensite(12, 12));
  });

  test("meilleurs créneaux : du plus fort au plus faible, cases vides exclues, égalité → lundi puis l'heure", () => {
    const g = grilleCarte([...cases, { dow: 2, hour: 8, opens: 5, clicks: 0 }], "opens");
    expect(meilleursCreneaux(g, 3)).toEqual([
      { dow: 1, hour: 9, value: 12 },
      { dow: 2, hour: 8, value: 5 },
      { dow: 3, hour: 0, value: 5 },
    ]);
    expect(meilleursCreneaux(grilleCarte([], "opens"), 3)).toEqual([]);
  });

  test("libellé d'un créneau", () => {
    expect(libelleCreneau(2, 9)).toBe("Tue 09:00–09:59");
    expect(libelleCreneau(7, 23)).toBe("Sun 23:00–23:59");
  });
});

describe("niveaux d'engagement", () => {
  test("ordre active → dormant → churned → autres → unknown, avec leur part", () => {
    const l = lignesNiveaux({ unknown: 1, churned: 2, zeta: 1, active: 4, dormant: 2 });
    expect(l.map((x) => x.level)).toEqual(["active", "dormant", "churned", "zeta", "unknown"]);
    expect(l[0]).toEqual({ level: "active", label: "Active", count: 4, share: 0.4 });
  });
  test("aucun actif : part null, jamais 0 %", () => {
    expect(lignesNiveaux({ active: 0 })[0].share).toBeNull();
    expect(lignesNiveaux({})).toEqual([]);
  });
});

describe("sources", () => {
  test("part engagée = engagés / actifs ; aucun actif ⇒ null", () => {
    expect(partEngagee({ engaged: 3, active: 12 })).toBe(0.25);
    expect(partEngagee({ engaged: 0, active: 0 })).toBeNull();
  });
  test("libellés connus, valeur brute sinon", () => {
    expect(libelleSource("crm_sync")).toBe("CRM sync");
    expect(libelleSource("unknown")).toBe("Unknown");
    expect(libelleSource("partner_x")).toBe("partner_x");
  });
});

describe("semaine par semaine", () => {
  test("jour local et lundi de la semaine", () => {
    // 01:30 UTC un lundi = encore dimanche à São Paulo (UTC−3).
    const t = new Date("2026-10-05T01:30:00Z");
    expect(jourLocal(t, "America/Sao_Paulo")).toBe("2026-10-04");
    expect(jourLocal(t, "UTC")).toBe("2026-10-05");
    expect(jourLocal(t, "Not/AZone")).toBe("2026-10-05");
    expect(lundi("2026-10-04")).toBe("2026-09-28");
    expect(lundi("2026-10-05")).toBe("2026-10-05");
    expect(lundi("2026-10-11")).toBe("2026-10-05");
  });

  test("bornes : lundi du début de période → lundi de la semaine en cours ; « All time » sans début", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    expect(bornesSemaines("2026-09-07T12:00:00+00:00", "30", now, "UTC")).toEqual({ debut: "2026-09-07", fin: "2026-10-05" });
    expect(bornesSemaines("2000-01-01T00:00:00+00:00", "all", now, "UTC")).toEqual({ debut: null, fin: "2026-10-05" });
    expect(bornesSemaines("n'importe quoi", "90", now, "UTC").debut).toBeNull();
  });

  test("pivot : une ligne par semaine, la plus récente en haut, métrique absente = 0", () => {
    const l = pivotSemaines([
      { week: "2026-09-21", metric: "signups", count: 4 },
      { week: "2026-09-21", metric: "readers", count: 9 },
      { week: "2026-09-28", metric: "unsubscribes", count: 1 },
    ]);
    expect(l.map((x) => x.week)).toEqual(["2026-09-28", "2026-09-21"]);
    expect(l[1].counts).toEqual({ signups: 4, imported: 0, confirmations: 0, unsubscribes: 0, readers: 9 });
    expect(l[0].counts.unsubscribes).toBe(1);
  });

  test("les semaines sans aucun événement sont des lignes à 0, entre les bornes de la période", () => {
    const l = pivotSemaines(
      [
        { week: "2026-09-14", metric: "signups", count: 2 },
        { week: "2026-09-28", metric: "signups", count: 1 },
      ],
      { debut: "2026-09-07", fin: "2026-10-05" },
    );
    expect(l.map((x) => x.week)).toEqual(["2026-10-05", "2026-09-28", "2026-09-21", "2026-09-14", "2026-09-07"]);
    expect(l[2].counts.signups).toBe(0);
  });

  test("« All time » (debut null) part de la première semaine lue ; aucune donnée ⇒ aucune ligne", () => {
    const l = pivotSemaines([{ week: "2026-09-28", metric: "readers", count: 3 }], { debut: null, fin: "2026-10-05" });
    expect(l.map((x) => x.week)).toEqual(["2026-10-05", "2026-09-28"]);
    expect(pivotSemaines([], { debut: "2026-09-07", fin: "2026-10-05" })).toEqual([]);
  });
});
