/**
 * La logique pure des écrans Automations : liste système, variables signalées (étape 12), décision
 * d'armement (étape 13). Sans base, sans session.
 */
import { describe, expect, test } from "bun:test";
import { TRIGGERS, VARIABLES, validateAutomation, type VariableName } from "@nf/automations";
import {
  CREATABLE_TRIGGERS,
  LIFECYCLE_EDITABLE,
  NEEDS_REGISTRY_WHY,
  SYSTEM_ROWS,
  adresseSysteme,
  canTurnOff,
  decideTransition,
  declencheurInitial,
  isLifecycleEditable,
  rangerParDeclencheur,
  raisonDeclencheurFige,
  systemRowDoes,
  systemRowName,
  formatDelay,
  recordFromBody,
  simulationRan,
  unavailableVariables,
  variablesFor,
  type TransitionInput,
} from "./automations";

const ASSET = "22222222-2222-4222-8222-222222222222";
const TV = "33333333-3333-4333-8333-333333333333";

describe("la carte System — les 15 lignes du tableau d'Alix, dans son ordre", () => {
  test("⛔ exactement les lignes 1 à 15, dans l'ordre du tableau", () => {
    expect(SYSTEM_ROWS.map((s) => s.sheetRow)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  test("les trois sortes : e-mails 1, 3, 5 ; règles 10, 12, 13, 14 ; le reste est au moteur", () => {
    const de = (t: string) => SYSTEM_ROWS.filter((r) => r.type === t).map((r) => r.sheetRow);
    expect(de("lifecycle")).toEqual([1, 3, 5]);
    expect(de("rule")).toEqual([10, 12, 13, 14]);
    expect(de("engine")).toEqual([2, 4, 6, 7, 8, 9, 11, 15]);
  });

  test("⛔ chaque déclencheur créable a UNE ligne — un déclencheur ajouté au catalogue sans ligne rougit ici", () => {
    const moteur = SYSTEM_ROWS.flatMap((r) => (r.type === "engine" ? [r.trigger] : []));
    expect([...moteur].sort()).toEqual([...CREATABLE_TRIGGERS].sort());
    expect(new Set(moteur).size).toBe(moteur.length);
  });

  test("les e-mails de cycle de vie : confirmation, welcome, accusé ; seule la confirmation ne se coupe pas", () => {
    const kinds = SYSTEM_ROWS.flatMap((r) => (r.type === "lifecycle" ? [r.kind] : []));
    expect(kinds).toEqual([...LIFECYCLE_EDITABLE]);
    expect(kinds.map((k) => [k, canTurnOff(k)])).toEqual([
      ["confirmation", false],
      ["welcome", true],
      ["unsubscribe_ack", true],
    ]);
    expect(adresseSysteme("welcome")).toBe("/automations/system/welcome");
    expect(isLifecycleEditable("reengagement")).toBe(false);
  });

  test("chaque ligne a un nom distinct et dit ce qu'elle fait ; nom et description du moteur = le catalogue", () => {
    const noms = SYSTEM_ROWS.map(systemRowName);
    expect(new Set(noms).size).toBe(15);
    for (const r of SYSTEM_ROWS) expect([systemRowName(r), systemRowDoes(r).length > 20]).toEqual([systemRowName(r), true]);
    const r2 = SYSTEM_ROWS.find((r) => r.sheetRow === 2)!;
    expect([systemRowName(r2), systemRowDoes(r2)]).toEqual([TRIGGERS.confirmation_reminder.label, TRIGGERS.confirmation_reminder.description]);
  });

  test("le seuil des rebonds mous vient du catalogue, pas d'un chiffre recopié", () => {
    const mous = SYSTEM_ROWS.find((s) => s.sheetRow === 13)!;
    expect(systemRowDoes(mous)).toContain(`${TRIGGERS.soft_bounce_rule.settings.threshold?.default} temporary failures`);
  });
});

describe("declencheurInitial — « Set up » ouvre le formulaire sur SON déclencheur", () => {
  test("chaque déclencheur créable passe tel quel", () => {
    for (const t of CREATABLE_TRIGGERS) expect(declencheurInitial(t)).toBe(t);
  });

  test("⛔ inconnu, non créable, absent ou répété ⇒ le premier du catalogue (ou le premier donné)", () => {
    for (const v of ["soft_bounce_rule", "x", "", undefined, null, 3]) expect(declencheurInitial(v)).toBe(CREATABLE_TRIGGERS[0]!);
    expect(declencheurInitial(["reengagement", "sunset"])).toBe("reengagement");
  });
});

describe("raisonDeclencheurFige — le déclencheur ne change que si l'automation n'a jamais sélectionné personne", () => {
  test("0 sélection ⇒ il peut changer", () => {
    expect(raisonDeclencheurFige(0)).toBe(null);
  });

  test("⛔ une sélection, simulée ou réelle ⇒ figé, et l'écran dit quoi faire", () => {
    for (const n of [1, 42]) expect(raisonDeclencheurFige(n)).toContain("Create a new automation instead");
  });

  test("⛔ historique illisible ⇒ figé : « non lu » n'est jamais « zéro »", () => {
    expect(raisonDeclencheurFige(null)).toContain("could not be read");
  });
});

describe("rangerParDeclencheur", () => {
  test("chaque automation sous son déclencheur, dans l'ordre reçu", () => {
    const a = [
      { id: "1", trigger: "reengagement" },
      { id: "2", trigger: "welcome_back" },
      { id: "3", trigger: "reengagement" },
    ];
    const { parDeclencheur, autres } = rangerParDeclencheur(a);
    expect(parDeclencheur.get("reengagement")?.map((x) => x.id)).toEqual(["1", "3"]);
    expect(parDeclencheur.get("welcome_back")?.map((x) => x.id)).toEqual(["2"]);
    expect(autres).toEqual([]);
  });

  test("⛔ une automation sans ligne n'est jamais perdue : elle part dans « autres »", () => {
    const { parDeclencheur, autres } = rangerParDeclencheur([{ id: "x", trigger: "soft_bounce_rule" }, { id: "y", trigger: "inconnu" }]);
    expect(parDeclencheur.size).toBe(0);
    expect(autres.map((x) => x.id)).toEqual(["x", "y"]);
  });
});

describe("déclencheurs proposés à la création", () => {
  test("⛔ la règle système n'est pas proposée ; les huit que le moteur exécute le sont", () => {
    expect(CREATABLE_TRIGGERS.includes("soft_bounce_rule")).toBe(false);
    expect(CREATABLE_TRIGGERS).toHaveLength(8);
  });
});

describe("étape 12 — les variables sans donnée sont SIGNALÉES", () => {
  /** Toutes les variables du catalogue qui ne sont pas servies aujourd'hui. */
  const signalees = (Object.keys(VARIABLES) as VariableName[]).filter((n) => VARIABLES[n].status !== "ready");

  test("il y en a (sinon les tests par variable ci-dessous ne prouvent rien)", () => {
    expect(signalees.length).toBeGreaterThan(5);
  });

  // Un test PAR variable signalée : chacune, où qu'elle apparaisse, porte son drapeau et sa raison.
  for (const nom of signalees) {
    test(`${nom} est signalée, avec sa raison`, () => {
      const vues = [
        ...CREATABLE_TRIGGERS.flatMap((t) => variablesFor(t)),
        ...CREATABLE_TRIGGERS.flatMap((t) => unavailableVariables(t)),
      ].filter((v) => v.name === nom);
      expect(vues.length).toBeGreaterThan(0);
      for (const v of vues) {
        expect(v.flagged).toBe(true);
        expect(v.why === null).toBe(false);
        if (VARIABLES[nom].status === "needs_registry") expect(v.why).toBe(NEEDS_REGISTRY_WHY);
        else expect(String(v.why)).toContain("No data today.");
      }
    });
  }

  test("club_preference : absente de tout déclencheur, mais NOMMÉE comme indisponible", () => {
    const v = unavailableVariables("welcome_back").find((x) => x.name === "club_preference");
    expect(v?.flagged).toBe(true);
    expect(String(v?.why)).toContain("interests");
  });

  test("promo_content : fournie par la promo d'opt-in, et signalée sans donnée", () => {
    const v = variablesFor("optin_promo").find((x) => x.name === "promo_content");
    expect(v?.flagged).toBe(true);
    expect(String(v?.why)).toContain("No data today.");
  });

  test("renew_link : fournie par le renouvellement, et signalée sans route", () => {
    const v = variablesFor("consent_renewal").find((x) => x.name === "renew_link");
    expect(v?.flagged).toBe(true);
    expect(String(v?.why)).toContain("No signed renewal route");
  });

  test("une variable servie n'est PAS signalée et donne son jeton", () => {
    const v = variablesFor("welcome_back").find((x) => x.name === "first_name");
    expect(v?.flagged).toBe(false);
    expect(v?.token).toBe("first_name");
  });

  test("une variable fournie n'est pas répétée parmi les indisponibles", () => {
    expect(unavailableVariables("optin_promo").some((v) => v.name === "promo_content")).toBe(false);
  });
});

describe("corps de formulaire → ligne", () => {
  test("⛔ le statut vient de l'appelant, jamais du corps", () => {
    const r = recordFromBody({ name: "x", trigger: "anniversary", status: "live" }, ASSET, "draft");
    expect(r?.status).toBe("draft");
  });

  test("pas d'objet ⇒ null", () => {
    expect(recordFromBody("x", ASSET, "draft")).toBeNull();
    expect(recordFromBody(null, ASSET, "draft")).toBeNull();
  });
});

describe("étape 13 — la décision de transition", () => {
  const valide = validateAutomation({
    asset_id: ASSET,
    name: "A",
    trigger: "anniversary",
    filters: {},
    settings: {},
    steps: [{ delay_hours: 0, template_version_id: TV }],
    status: "live",
    purpose: "content",
    daily_cap: 10,
    window_start_hour: 8,
    window_end_hour: 20,
    timezone: "UTC",
  });
  const base: TransitionInput = {
    from: "simulation",
    to: "live",
    name: "A",
    isSuperAdmin: true,
    confirmName: "A",
    simulationRan: true,
    validation: valide,
  };
  const statut = (i: Partial<TransitionInput>) => {
    const d = decideTransition({ ...base, ...i });
    return d.ok ? 200 : d.status;
  };

  test("le chemin nominal passe", () => {
    expect(valide.ok).toBe(true);
    expect(statut({})).toBe(200);
  });

  test("⛔ membre qui arme ⇒ 403, AVANT toute autre raison", () => {
    expect(statut({ isSuperAdmin: false })).toBe(403);
    expect(statut({ isSuperAdmin: false, from: "draft", simulationRan: false, confirmName: null })).toBe(403);
    expect(statut({ isSuperAdmin: false, from: "paused" })).toBe(403);
  });

  test("⛔ transitions hors table ⇒ 409", () => {
    expect(statut({ from: "draft" })).toBe(409);
    expect(statut({ from: "live", to: "simulation" })).toBe(409);
    expect(statut({ from: "simulation", to: "paused" })).toBe(409);
    expect(statut({ from: "paused", to: "simulation" })).toBe(409);
    expect(statut({ from: "live", to: "live" })).toBe(409);
  });

  test("⛔ simulation jamais tournée ⇒ 409 ; reprendre depuis paused n'exige pas de simulation", () => {
    expect(statut({ simulationRan: false })).toBe(409);
    expect(statut({ from: "paused", simulationRan: false })).toBe(200);
  });

  test("⛔ nom de confirmation absent ou faux ⇒ 422 (espaces de bord tolérés)", () => {
    expect(statut({ confirmName: null })).toBe(422);
    expect(statut({ confirmName: "a" })).toBe(422);
    expect(statut({ confirmName: "  A " })).toBe(200);
  });

  test("⛔ invalide ⇒ 422 pour simuler ou armer ; pause et brouillon passent quand même", () => {
    const invalide = validateAutomation({
      asset_id: ASSET,
      name: "A",
      trigger: "anniversary",
      filters: {},
      settings: {},
      steps: [],
      status: "live",
      purpose: null,
      daily_cap: 10,
      window_start_hour: 8,
      window_end_hour: 20,
      timezone: "UTC",
    });
    expect(invalide.ok).toBe(false);
    expect(statut({ validation: invalide })).toBe(422);
    expect(statut({ from: "draft", to: "simulation", validation: invalide })).toBe(422);
    expect(statut({ from: "live", to: "paused", validation: invalide, isSuperAdmin: false })).toBe(200);
    expect(statut({ from: "live", to: "draft", validation: invalide, isSuperAdmin: false })).toBe(200);
  });
});

describe("la simulation a-t-elle tourné ?", () => {
  const a = { status: "simulation" as const, lastRunAt: null as string | null, statusChangedAt: "2026-09-24T08:00:00Z" };
  test("ni passe ni trace ⇒ non", () => expect(simulationRan(a, 0)).toBe(false));
  test("une passe APRÈS le lancement ⇒ oui", () => expect(simulationRan({ ...a, lastRunAt: "2026-09-24T08:10:00Z" }, 0)).toBe(true));
  test("⛔ une passe d'AVANT le lancement (simulation précédente) ⇒ non", () =>
    expect(simulationRan({ ...a, lastRunAt: "2026-09-23T20:00:00Z" }, 0)).toBe(false));
  test("une trace simulée depuis le lancement ⇒ oui", () => expect(simulationRan(a, 1)).toBe(true));
  test("⛔ hors simulation ⇒ non, quoi qu'il y ait", () =>
    expect(simulationRan({ ...a, status: "draft", lastRunAt: "2026-09-24T09:00:00Z" }, 3)).toBe(false));
});

describe("délais", () => {
  test("lisibles", () => {
    expect(formatDelay(0)).toBe("immediately");
    expect(formatDelay(24)).toBe("1 day");
    expect(formatDelay(1440)).toBe("60 days");
    expect(formatDelay(30)).toBe("30 h");
  });
});
