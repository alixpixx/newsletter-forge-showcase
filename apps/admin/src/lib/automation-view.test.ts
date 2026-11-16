import { describe, expect, test } from "bun:test";
import { cumulAutomation, type EtapeAutomation } from "./engagement";
import { dernierEnvoi, rapport, raisonNonMesure, tauxAutomation, type CompteursAutomation } from "./automation-view";

const ZERO: CompteursAutomation = {
  real: 0, simulated: 0, sent: 0, failed: 0, skipped: 0, queued: 0,
  delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, tracked: 0,
};
const c = (p: Partial<CompteursAutomation>): CompteursAutomation => ({ ...ZERO, ...p });
const etape = (step: number, p: Partial<CompteursAutomation>, lastAt: string | null = null): EtapeAutomation => ({
  step, ...c(p), lastAt,
});

describe("rapport — jamais 0 ni NaN sur un dénominateur nul", () => {
  test("dénominateur nul ⇒ null, même avec un numérateur nul", () => {
    expect(rapport(0, 0)).toBeNull();
    expect(rapport(5, 0)).toBeNull();
  });
  test("sinon la fraction", () => {
    expect(rapport(1, 4)).toBe(0.25);
    expect(rapport(0, 7)).toBe(0);
  });
});

describe("taux d'une automation", () => {
  const mesuree = c({ real: 100, sent: 90, failed: 4, skipped: 6, delivered: 80, bounced: 9, tracked: 40, opened: 10, clicked: 2 });

  test("sent / réels, délivrés / acceptés, rebonds / acceptés, ouverture et clic / délivrés suivis", () => {
    const t = tauxAutomation(mesuree);
    expect(t.sentRate).toBe(90 / 100);
    expect(t.deliveryRate).toBe(80 / 90);
    expect(t.bounceRate).toBe(9 / 90);
    expect(t.openRate).toBe(10 / 40);
    expect(t.clickRate).toBe(2 / 40);
    expect(raisonNonMesure(mesuree)).toBeNull();
  });

  test("⛔ simulation seule : AUCUN taux, et la raison le dit (rien n'est parti)", () => {
    const sim = c({ simulated: 50 });
    expect(tauxAutomation(sim)).toEqual({ sentRate: null, deliveryRate: null, bounceRate: null, openRate: null, clickRate: null });
    expect(raisonNonMesure(sim)).toContain("simulated sends only");
  });

  test("⛔ aucun destinataire suivi : ouverture et clic null (jamais 0 %), la livraison reste mesurée", () => {
    const nonSuivie = c({ real: 10, sent: 10, delivered: 8, tracked: 0 });
    const t = tauxAutomation(nonSuivie);
    expect(t.openRate).toBeNull();
    expect(t.clickRate).toBeNull();
    expect(t.deliveryRate).toBe(8 / 10);
    expect(raisonNonMesure(nonSuivie)).toBe("Not measured — 0 of 8 delivered recipients allow open and click tracking.");
  });

  test("rien de délivré ⇒ ouverture non mesurée ; rien d'accepté ⇒ livraison et rebond null", () => {
    const enFile = c({ real: 3, queued: 3 });
    expect(raisonNonMesure(enFile)).toBe("Not measured — nothing delivered yet.");
    expect(tauxAutomation(enFile).deliveryRate).toBeNull();
    expect(tauxAutomation(enFile).bounceRate).toBeNull();
  });

  test("plus d'ouvreurs que de suivis : pas de taux au-delà de 100 %", () => {
    const incoherent = c({ real: 5, sent: 5, delivered: 5, tracked: 2, opened: 3 });
    expect(tauxAutomation(incoherent).openRate).toBeNull();
    expect(raisonNonMesure(incoherent)).toContain("tracking was not recorded");
  });

  test("le cumul MÉLANGE une étape suivie, une non suivie et une simulée", () => {
    const total = cumulAutomation([
      etape(1, { real: 10, sent: 10, delivered: 10, tracked: 10, opened: 4, clicked: 1 }),
      etape(2, { real: 10, sent: 10, delivered: 9, tracked: 0 }),
      etape(3, { simulated: 30 }),
    ]);
    const t = tauxAutomation(total);
    expect(t.openRate).toBe(4 / 10);
    expect(t.clickRate).toBe(1 / 10);
    expect(t.deliveryRate).toBe(19 / 20);
    // Les simulés ne gonflent aucun dénominateur.
    expect(t.sentRate).toBe(20 / 20);
  });
});

describe("dernier envoi", () => {
  test("le plus récent des étapes, les étapes sans date ignorées", () => {
    expect(
      dernierEnvoi([
        { lastAt: "2026-10-01T08:00:00+00:00" },
        { lastAt: null },
        { lastAt: "2026-10-05T09:30:00+00:00" },
        { lastAt: "2026-09-30T23:00:00+00:00" },
      ]),
    ).toBe("2026-10-05T09:30:00+00:00");
  });
  test("aucune date ⇒ null", () => {
    expect(dernierEnvoi([])).toBeNull();
    expect(dernierEnvoi([{ lastAt: null }])).toBeNull();
  });
});
