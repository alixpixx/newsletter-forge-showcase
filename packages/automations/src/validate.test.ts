/**
 * LA VALIDATION DES RÉGLAGES — chaque refus a son test, et chaque test a son témoin.
 *
 * ⚠️ Le témoin d'abord : une validation qui refuserait TOUT passerait chacun des tests de refus
 * ci-dessous. C'est le premier test qui interdit cette lecture.
 */
import { describe, expect, test } from "bun:test";
import { TRIGGERS, TRIGGER_IDS, type TriggerId } from "./catalog";
import {
  canTransition,
  inSendWindow,
  isValidTimeZone,
  validateAutomation,
  type AutomationRecord,
} from "./validate";

const ASSET = "44444444-4444-4444-8444-444444444444";
const OPT = "22222222-2222-4222-8222-222222222222";
const TV = "33333333-3333-4333-8333-333333333333";

/** Une automation valide construite depuis les défauts du catalogue. */
function defaut(trigger: TriggerId, over: Partial<AutomationRecord> = {}): AutomationRecord {
  const spec = TRIGGERS[trigger];
  return {
    asset_id: ASSET,
    name: spec.label,
    trigger,
    filters: spec.requiredFilter ? { [spec.requiredFilter[0] as string]: [OPT] } : {},
    settings: {},
    steps: spec.steps.defaultDelaysHours.map((h) =>
      spec.steps.requiresTemplate ? { delay_hours: h, template_version_id: TV } : { delay_hours: h },
    ),
    status: "draft",
    purpose: spec.defaultPurpose,
    daily_cap: 50,
    window_start_hour: 8,
    window_end_hour: 20,
    timezone: "America/Sao_Paulo",
    ...over,
  };
}

function erreurs(rec: AutomationRecord): string[] {
  const v = validateAutomation(rec);
  return v.ok ? [] : v.errors;
}

describe("TÉMOINS — les réglages par défaut de chaque déclencheur sont valides", () => {
  for (const t of TRIGGER_IDS) {
    test(t, () => {
      expect(erreurs(defaut(t))).toEqual([]);
    });
  }

  test("armable en simulation (sauf la règle système)", () => {
    for (const t of TRIGGER_IDS.filter((x) => TRIGGERS[x].engine)) {
      expect(`${t}:${erreurs(defaut(t, { status: "simulation" })).join("|")}`).toBe(`${t}:`);
    }
  });

  test("les réglages absents prennent la valeur par défaut du catalogue", () => {
    const v = validateAutomation(defaut("sunset"));
    expect(v.ok && v.automation.settings).toEqual({ include_untracked: false, require_reengagement: true, grace_days: 14 });
  });
});

describe("refus — un par règle", () => {
  test("déclencheur inconnu", () => {
    expect(erreurs({ ...defaut("anniversary"), trigger: "birthday" })).toEqual(["unknown trigger: birthday"]);
  });

  test("⛔ un filtre inconnu est REFUSÉ, pas ignoré (sinon l'automation viserait toute la marque)", () => {
    expect(erreurs(defaut("optin_promo", { filters: { optin_id: [OPT] } }))).toContain("filters.optin_id is not a known filter");
  });

  test("la promo exige au moins un opt-in OU un label (0095)", () => {
    expect(erreurs(defaut("optin_promo", { filters: {} }))).toContain(
      "filters.optin_ids or filters.labels is required for Opt-in promotion",
    );
    // Un label seul suffit ; une liste de labels vide ne compte pas.
    expect(erreurs(defaut("optin_promo", { filters: { labels: ["libertadores-2026"] } }))).toEqual([]);
    expect(erreurs(defaut("optin_promo", { filters: { labels: [] } }))).toHaveLength(1);
  });

  test("labels : des slugs, normalisés comme en SQL, 20 au plus", () => {
    const v = validateAutomation(defaut("optin_promo", { filters: { labels: [" Libertadores-2026 "] } }));
    expect(v.ok && v.automation.filters).toEqual({ labels: ["libertadores-2026"] });
    expect(erreurs(defaut("anniversary", { filters: { labels: ["Libertadores 2026"] } }))).toEqual([
      "filters.labels must be a list of automation label slugs (at most 20)",
    ]);
    expect(erreurs(defaut("anniversary", { filters: { labels: [42] } }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { filters: { labels: "libertadores-2026" } }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { filters: { labels: Array.from({ length: 21 }, (_, i) => `l-${i}`) } }))).toHaveLength(1);
  });

  test("filtres mal formés", () => {
    expect(erreurs(defaut("anniversary", { filters: { optin_ids: ["pas-un-id"] } }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { filters: { languages: ["portugais du brésil"] } }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { filters: { interest_ids: [0] } }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { filters: [] as unknown }))).toEqual(["filters must be an object"]);
  });

  test("⛔ un marketing sans finalité est refusé", () => {
    expect(erreurs(defaut("reengagement", { purpose: null }))).toHaveLength(1);
    expect(erreurs(defaut("reengagement", { purpose: "spam" }))).toHaveLength(1);
  });

  test("⛔ un transactionnel AVEC finalité est refusé (ce serait un marketing qui s'ignore)", () => {
    expect(erreurs(defaut("confirmation_reminder", { purpose: "content" }))).toEqual([
      "Confirmation reminder is not marketing: it carries no purpose",
    ]);
  });

  test("nombre d'étapes hors bornes", () => {
    const trois = [24, 48, 72].map((h) => ({ delay_hours: h, template_version_id: TV }));
    expect(erreurs(defaut("confirmation_reminder", { steps: trois }))).toEqual(["Confirmation reminder takes 1 to 2 steps"]);
    expect(erreurs(defaut("anniversary", { steps: [] }))).toEqual(["Signup anniversary takes exactly 1 step(s)"]);
  });

  test("délai hors bornes (une relance de confirmation ne peut pas attendre 7 jours)", () => {
    expect(erreurs(defaut("confirmation_reminder", { steps: [{ delay_hours: 168, template_version_id: TV }] }))).toHaveLength(1);
  });

  test("délais non croissants", () => {
    const steps = [{ delay_hours: 72, template_version_id: TV }, { delay_hours: 24, template_version_id: TV }];
    expect(erreurs(defaut("confirmation_reminder", { steps }))).toEqual(["step 2: delay must be longer than step 1's"]);
  });

  test("étape sans modèle publié", () => {
    expect(erreurs(defaut("anniversary", { steps: [{ delay_hours: 0 }] }))).toEqual([
      "step 1: a published template version is required",
    ]);
  });

  test("⛔ un déclencheur silencieux n'accepte pas de modèle (il n'envoie rien)", () => {
    expect(erreurs(defaut("sunset", { steps: [{ delay_hours: 180 * 24, template_version_id: TV }] }))).toEqual([
      "step 1: Sunset (silent) sends nothing, it takes no template",
    ]);
  });

  test("champ d'étape inconnu", () => {
    expect(erreurs(defaut("anniversary", { steps: [{ delay_hours: 0, template_version_id: TV, subject: "x" }] }))).toEqual([
      "step 1: subject is not a step field",
    ]);
  });

  test("réglage inconnu, de mauvais type, hors bornes", () => {
    expect(erreurs(defaut("anniversary", { settings: { catchup: 3 } }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { settings: { catchup_days: "3" } }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { settings: { catchup_days: 30 } }))).toHaveLength(1);
    expect(erreurs(defaut("reengagement", { settings: { include_untracked: "yes" } }))).toHaveLength(1);
  });

  test("⛔ un réglage en lecture seule ne se modifie pas (il laisserait croire qu'il agit)", () => {
    expect(erreurs(defaut("soft_bounce_rule", { settings: { threshold: 3 } }))).toEqual([
      "settings.threshold is read-only (enforced elsewhere)",
    ]);
  });

  test("plafond, fenêtre, fuseau", () => {
    expect(erreurs(defaut("anniversary", { daily_cap: 0 }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { daily_cap: 2001 }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { window_start_hour: 20, window_end_hour: 8 }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { window_start_hour: 8, window_end_hour: 8 }))).toHaveLength(1);
    expect(erreurs(defaut("anniversary", { timezone: "Mars/Olympus" }))).toEqual(["unknown time zone: Mars/Olympus"]);
  });

  test("⛔ la règle système ne s'arme pas", () => {
    expect(erreurs(defaut("soft_bounce_rule", { status: "simulation" }))).toEqual([
      "Soft bounce rule is a system rule: it cannot be simulated or switched on",
    ]);
  });

  test("⛔ le renouvellement ne passe pas `live` tant que la route n'existe pas (simulation permise)", () => {
    expect(erreurs(defaut("consent_renewal", { status: "simulation" }))).toEqual([]);
    expect(erreurs(defaut("consent_renewal", { status: "live" }))).toHaveLength(1);
  });

  test("statut inconnu", () => {
    expect(erreurs(defaut("anniversary", { status: "armed" }))).toEqual(["unknown status: armed"]);
  });
});

describe("états — le premier état armé est TOUJOURS la simulation", () => {
  test("⛔ draft → live n'existe pas", () => {
    expect(canTransition("draft", "live")).toBe(false);
  });

  test("le chemin nominal : draft → simulation → live ⇄ paused", () => {
    expect(canTransition("draft", "simulation")).toBe(true);
    expect(canTransition("simulation", "live")).toBe(true);
    expect(canTransition("live", "paused")).toBe(true);
    expect(canTransition("paused", "live")).toBe(true);
  });

  test("⛔ on n'ajuste pas une automation en marche : elle revient au brouillon (qui l'ARRÊTE), jamais en simulation", () => {
    expect(canTransition("live", "simulation")).toBe(false);
    expect(canTransition("live", "draft")).toBe(true);
  });

  test("tout statut revient au brouillon pour être modifié", () => {
    for (const s of ["simulation", "live", "paused"] as const) expect(canTransition(s, "draft")).toBe(true);
  });

  test("⛔ `paused` ne vient que de `live` : sinon « Resume » armerait une simulation jamais tournée", () => {
    expect(canTransition("simulation", "paused")).toBe(false);
    expect(canTransition("paused", "simulation")).toBe(false);
    expect(canTransition("draft", "paused")).toBe(false);
  });
});

describe("fenêtre d'envoi — heure LOCALE de l'automation", () => {
  test("12:00 UTC = 09:00 à São Paulo : dans 08-20", () => {
    expect(inSendWindow(new Date("2026-09-24T12:00:00Z"), "America/Sao_Paulo", 8, 20)).toBe(true);
  });

  test("02:00 UTC = 23:00 la veille à São Paulo : hors 08-20", () => {
    expect(inSendWindow(new Date("2026-09-24T02:00:00Z"), "America/Sao_Paulo", 8, 20)).toBe(false);
  });

  test("la borne de fin est exclue", () => {
    expect(inSendWindow(new Date("2026-09-24T20:00:00Z"), "UTC", 8, 20)).toBe(false);
    expect(inSendWindow(new Date("2026-09-24T19:59:00Z"), "UTC", 8, 20)).toBe(true);
  });

  test("fuseaux", () => {
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
