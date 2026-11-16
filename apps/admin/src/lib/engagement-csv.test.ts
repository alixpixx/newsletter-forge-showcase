import { describe, expect, test } from "bun:test";
import { tableauCsv } from "./csv";
import type { EngagementCampagne } from "./engagement";
import {
  COLONNES_ENGAGEMENT_CSV,
  lignesEngagementCsv,
  regrouperPremieresActions,
  suiviCoupe,
  tauxClicSurOuverture,
} from "./engagement-csv";

const vide = { device: [], client: [], os: [], country: [], city: [] };

const engagement = (extra: Partial<EngagementCampagne> = {}): EngagementCampagne => ({
  sent: 100,
  tracked: 80,
  trackingUnknown: 0,
  opens: { unique: 40, total: 70, uniqueHuman: 30, bot: 12 },
  clicks: { unique: 15, total: 22 },
  links: [{ url: "https://exemple.invalid/a", unique: 10, total: 14 }],
  firstActionHours: [
    { hour: 0, opens: 9, clicks: 2 },
    { hour: 4, opens: 5, clicks: 3 },
    { hour: 72, opens: 1, clicks: 0 },
  ],
  dimensions: { ...vide, device: [{ value: "mobile", unique: 20, total: 31 }, { value: null, unique: 4, total: 4 }] },
  ...extra,
});

describe("tranches du délai jusqu'à la 1re action", () => {
  test("heures creuses regroupées, toutes les tranches présentes, bornes au bon endroit", () => {
    const t = regrouperPremieresActions([
      { hour: 0, opens: 2, clicks: 1 },
      { hour: 2, opens: 1, clicks: 0 },
      { hour: 3, opens: 4, clicks: 1 },
      { hour: 5, opens: 1, clicks: 1 },
      { hour: 6, opens: 7, clicks: 0 },
      { hour: 23, opens: 1, clicks: 0 },
      { hour: 24, opens: 2, clicks: 2 },
      { hour: 71, opens: 3, clicks: 0 },
      { hour: 72, opens: 5, clicks: 4 },
    ]);
    expect(t.map((x) => x.label)).toEqual(["0-1h", "1-2h", "2-3h", "3-6h", "6-12h", "12-24h", "24-48h", "48-72h", "72h+"]);
    expect(t.map((x) => x.opens)).toEqual([2, 0, 1, 5, 7, 1, 2, 3, 5]);
    expect(t.map((x) => x.clicks)).toEqual([1, 0, 0, 2, 0, 0, 2, 0, 4]);
  });

  test("rien ⇒ neuf tranches à zéro (l'écran dit « aucune action », pas une liste vide)", () => {
    expect(regrouperPremieresActions([])).toHaveLength(9);
  });
});

describe("suivi coupé et taux de clic sur ouverture", () => {
  test("coupé = des envois, aucun suivi, aucun inconnu", () => {
    expect(suiviCoupe({ sent: 10, tracked: 0, trackingUnknown: 0 })).toBe(true);
    expect(suiviCoupe({ sent: 10, tracked: 0, trackingUnknown: 3 })).toBe(false);
    expect(suiviCoupe({ sent: 10, tracked: 1, trackingUnknown: 0 })).toBe(false);
    expect(suiviCoupe({ sent: 0, tracked: 0, trackingUnknown: 0 })).toBe(false);
  });

  test("clics uniques ÷ ouvertures HUMAINES ; null sans ouverture humaine", () => {
    expect(tauxClicSurOuverture(engagement())).toBe(0.5);
    expect(tauxClicSurOuverture(engagement({ opens: { unique: 5, total: 5, uniqueHuman: 0, bot: 5 } }))).toBeNull();
  });
});

describe("lignes du CSV d'engagement", () => {
  test("en-tête, résumé, liens, tranches, dimensions (« Unknown » pour null)", () => {
    const csv = tableauCsv([...COLONNES_ENGAGEMENT_CSV], lignesEngagementCsv(engagement(), "All editions"));
    const l = csv.split("\r\n");
    expect(l[0]).toBe("Section,Value,Unique,Total");
    expect(l).toContain("Selection,All editions,,");
    expect(l).toContain("Summary,Opens,40,70");
    expect(l).toContain("Summary,Human opens,30,");
    expect(l).toContain("Summary,Machine opens,,12");
    expect(l).toContain("Summary,Clicks,15,22");
    expect(l).toContain("Summary,Click-to-open rate (%),50.0,");
    expect(l).toContain("Link,https://exemple.invalid/a,10,14");
    expect(l).toContain("First open,0-1h,9,");
    expect(l).toContain("First open,3-6h,5,");
    expect(l).toContain("First click,3-6h,3,");
    expect(l).toContain("First open,72h+,1,");
    expect(l).toContain("Device,mobile,20,31");
    expect(l).toContain("Device,Unknown,4,4");
    expect(l.filter((x) => x.startsWith("First open,"))).toHaveLength(9);
  });

  // ⛔ MUTATION QUI DOIT TUER CE TEST : écrire les zéros d'un envoi sans suivi.
  test("suivi coupé ⇒ cellules VIDES (jamais 0), la raison dite, aucune section de détail", () => {
    const e = engagement({
      tracked: 0,
      opens: { unique: 0, total: 0, uniqueHuman: 0, bot: 0 },
      clicks: { unique: 0, total: 0 },
      links: [],
      firstActionHours: [],
      dimensions: vide,
    });
    const l = lignesEngagementCsv(e, "Single send");
    const resume = (v: string) => l.find((x) => x[0] === "Summary" && x[1] === v)!;
    expect(resume("Opens")).toEqual(["Summary", "Opens", "", ""]);
    expect(resume("Clicks")).toEqual(["Summary", "Clicks", "", ""]);
    expect(resume("Machine opens")).toEqual(["Summary", "Machine opens", "", ""]);
    expect(resume("Click-to-open rate (%)")).toEqual(["Summary", "Click-to-open rate (%)", "", ""]);
    expect(resume("Sent")).toEqual(["Summary", "Sent", "100", ""]);
    expect(l.some((x) => x[1]!.includes("tracking was off"))).toBe(true);
    expect(l.some((x) => x[0] === "First open" || x[0] === "Link" || x[0] === "Device")).toBe(false);
  });

  test("pas d'ouverture humaine ⇒ taux de clic sur ouverture vide, pas 0", () => {
    const l = lignesEngagementCsv(engagement({ opens: { unique: 3, total: 3, uniqueHuman: 0, bot: 3 } }), "x");
    expect(l.find((x) => x[1] === "Click-to-open rate (%)")).toEqual(["Summary", "Click-to-open rate (%)", "", ""]);
  });
});
