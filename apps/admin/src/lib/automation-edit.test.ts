/**
 * Les décisions pures de l'édition des automations (plan AUTO-EDIT, 25/09/2026) : gestes par statut,
 * version d'une étape, étapes rangées par délai, fuseaux proposés. Sans base, sans session.
 */
import { describe, expect, test } from "bun:test";
import { validateAutomation } from "@nf/automations";
import {
  VERSION_DEPUBLIEE_NOTE,
  VERSION_INTROUVABLE_NOTE,
  actionsFor,
  erreursEtapes,
  etatVersionEtape,
  optionsFuseau,
  trierEtapes,
  type VersionEpinglee,
  type VersionPubliee,
} from "./automation-edit";

describe("actionsFor — quels gestes pour quel statut", () => {
  test("brouillon : Edit ouvre le formulaire, Duplicate, Delete ; la fiche EST le formulaire", () => {
    expect(actionsFor("draft", "reengagement")).toEqual({ edit: "form", duplicate: true, delete: true, page: "form" });
  });

  test("⛔ simulation et live : Edit passe par « Stop and edit », JAMAIS de Delete, fiche en lecture", () => {
    for (const s of ["simulation", "live"] as const) {
      expect([s, actionsFor(s, "reengagement")]).toEqual([
        s,
        { edit: "stop-and-edit", duplicate: true, delete: false, page: "view" },
      ]);
    }
  });

  test("en pause : « Stop and edit », Duplicate, Delete permis (la route refuse encore s'il y a eu un envoi)", () => {
    expect(actionsFor("paused", "reengagement")).toEqual({ edit: "stop-and-edit", duplicate: true, delete: true, page: "view" });
  });

  test("⛔ déclencheur non créable (règle système) : ni Edit ni Duplicate, fiche en lecture même en brouillon", () => {
    expect(actionsFor("draft", "soft_bounce_rule")).toEqual({ edit: null, duplicate: false, delete: true, page: "view" });
    expect(actionsFor("live", "inconnu")).toEqual({ edit: null, duplicate: false, delete: false, page: "view" });
  });
});

const W3 = "aaaaaaaa-0000-4000-8000-000000000003";
const W5 = "aaaaaaaa-0000-4000-8000-000000000005";
const R1 = "bbbbbbbb-0000-4000-8000-000000000001";
const DERNIERES: VersionPubliee[] = [
  { versionId: W5, templateId: "t-welcome", templateName: "Welcome", version: 5, subject: "Bienvenue !" },
  { versionId: R1, templateId: "t-remind", templateName: "Reminder", version: 1, subject: null },
];
const epingle = (p: Partial<VersionEpinglee>): VersionEpinglee => ({
  templateId: "t-welcome",
  templateName: "Welcome",
  version: 3,
  subject: "Bienvenue (ancien)",
  published: true,
  ...p,
});

describe("etatVersionEtape — ce qu'une étape dit de sa version", () => {
  test("aucune version choisie ⇒ none", () => {
    expect(etatVersionEtape(null, {}, DERNIERES).kind).toBe("none");
    expect(etatVersionEtape("", {}, DERNIERES).kind).toBe("none");
  });

  test("la dernière publiée ⇒ latest, avec son sujet et son numéro, sans action", () => {
    const e = etatVersionEtape(W5, {}, DERNIERES);
    expect(e).toEqual({
      kind: "latest",
      optionLabel: null,
      templateId: "t-welcome",
      subject: "Bienvenue !",
      version: 5,
      newer: null,
      note: null,
    });
  });

  test("⭐ une version dépassée ⇒ « v5 available — Use v5 » qui pointe la v5, jamais « not in your published templates »", () => {
    const e = etatVersionEtape(W3, { [W3]: epingle({}) }, DERNIERES);
    expect(e.kind).toBe("outdated");
    expect(e.newer).toEqual({ versionId: W5, version: 5, action: "v5 available — Use v5" });
    expect(e.optionLabel).toBe("Welcome · v3 — Bienvenue (ancien)");
    expect(e.subject).toBe("Bienvenue (ancien)");
    expect(e.templateId).toBe("t-welcome");
    expect(JSON.stringify(e)).not.toContain("not in your published templates");
  });

  test("épinglée sans plus récente d'un AUTRE modèle ⇒ pinned (la v5 de Welcome n'est pas proposée à Reminder)", () => {
    const e = etatVersionEtape(W3, { [W3]: epingle({ templateId: "t-remind", templateName: "Reminder", version: 0 }) }, [DERNIERES[0]!]);
    expect(e.kind).toBe("pinned");
    expect(e.newer).toBeNull();
  });

  test("⛔ introuvable ⇒ unknown, dit comme tel", () => {
    const e = etatVersionEtape(W3, {}, DERNIERES);
    expect(e).toEqual({
      kind: "unknown",
      optionLabel: "Template version not found",
      templateId: null,
      subject: null,
      version: null,
      newer: null,
      note: VERSION_INTROUVABLE_NOTE,
    });
  });

  test("⛔ modèle non ouvrable : ni nom, ni sujet, ni lien", () => {
    const e = etatVersionEtape(W3, { [W3]: epingle({ templateId: null, templateName: null }) }, DERNIERES);
    expect(e).toEqual({
      kind: "pinned",
      optionLabel: "A template you cannot open · v3",
      templateId: null,
      subject: null,
      version: 3,
      newer: null,
      note: null,
    });
  });

  test("version dépubliée ⇒ la note le dit", () => {
    expect(etatVersionEtape(W3, { [W3]: epingle({ published: false }) }, DERNIERES).note).toBe(VERSION_DEPUBLIEE_NOTE);
  });
});

describe("trierEtapes — les étapes rangées par délai", () => {
  test("range par délai croissant, sans toucher l'entrée", () => {
    const delais = [72, 0, 24];
    expect(trierEtapes(delais)).toEqual({ ordre: [1, 2, 0], erreurs: [] });
    expect(delais).toEqual([72, 0, 24]);
  });

  test("⛔ deux délais égaux ⇒ une erreur NOMMÉE (numéros affichés et délai)", () => {
    expect(trierEtapes([72, 24, 72]).erreurs).toEqual([
      "Steps 1 and 3 have the same delay (3 days): give each step a different delay.",
    ]);
  });

  test("stable : deux délais égaux gardent leur ordre d'origine", () => {
    expect(trierEtapes([48, 0, 48, 48]).ordre).toEqual([1, 0, 2, 3]);
  });

  test("un délai illisible part en dernier, sans erreur d'égalité", () => {
    expect(trierEtapes([Number.NaN, 24, Number.NaN])).toEqual({ ordre: [1, 0, 2], erreurs: [] });
  });

  test("⛔ avec la VRAIE validation : l'erreur nommée remplace « must be longer than », et seulement alors", () => {
    const rec = (delais: number[]) =>
      validateAutomation({
        asset_id: "22222222-2222-4222-8222-222222222222",
        name: "x",
        trigger: "welcome_back",
        filters: {},
        settings: {},
        steps: delais.map((d) => ({ delay_hours: d, template_version_id: "33333333-3333-4333-8333-333333333333" })),
        status: "draft",
        purpose: "content",
        daily_cap: 50,
        window_start_hour: 8,
        window_end_hour: 20,
        timezone: "UTC",
      });
    const v = rec([0, 0]);
    const brutes = v.ok ? [] : v.errors;
    // Le catalogue parle bien de « longer than » : sinon ce test ne prouverait rien.
    expect(brutes.some((e) => e.includes("must be longer than"))).toBe(true);
    const affichees = erreursEtapes(brutes, trierEtapes([0, 0]).erreurs);
    expect(affichees.some((e) => e.includes("must be longer than"))).toBe(false);
    expect(affichees).toContain("Steps 1 and 2 have the same delay (immediately): give each step a different delay.");
    // Sans égalité détectée, rien n'est avalé.
    expect(erreursEtapes(["step 2: delay must be longer than step 1's"], [])).toEqual(["step 2: delay must be longer than step 1's"]);
  });
});

describe("optionsFuseau — les fuseaux proposés", () => {
  test("⛔ la valeur courante inconnue est CONSERVÉE", () => {
    expect(optionsFuseau(["America/Santiago"], "Europe/Paris")).toContain("Europe/Paris");
  });

  test("sans doublon, UTC en tête, le reste trié ; une valeur vide n'ajoute rien", () => {
    expect(optionsFuseau(["America/Sao_Paulo", "America/Santiago", null, " ", "America/Santiago"], "")).toEqual([
      "UTC",
      "America/Santiago",
      "America/Sao_Paulo",
    ]);
    expect(optionsFuseau(["UTC", "America/Santiago"], "America/Santiago")).toEqual(["UTC", "America/Santiago"]);
  });
});
