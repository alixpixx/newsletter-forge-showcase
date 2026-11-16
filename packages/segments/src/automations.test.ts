/**
 * LA FAMILLE « AUTOMATIONS » DES SEGMENTS (24/09/2026) : ce que le système a déjà envoyé à la
 * personne, et ses retours. Quatre champs, trois colonnes de la migration 0087 et `consent_at`.
 *
 * ⚠️ CE QUI N'EST PAS TESTÉ ICI : que les colonnes existent dans les trois vues d'audience et que les
 * déclencheurs de 0087 les remplissent. Mesuré en base le 24/09 (40 colonnes par vue, 110 paires
 * rattrapées dans `lifecycle_sent`), pas par ce fichier.
 */
import { describe, expect, test } from "bun:test";
import { compileRule, type RuleContext } from "./compile";
import {
  FIELDS, SYSTEM_EMAIL_KEYS, getField, summarize,
  type Group, type Operator, type PredValue,
} from "./fields";

const BIENVENUE_RETOUR = "5b1e0c44-1111-4222-8333-444444444444";
const RELANCE = "6c2f1d55-1111-4222-8333-444444444444";
const AUTOMATION_AUTRE_MARQUE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const CTX: RuleContext = {
  tagIdBySlug: {},
  optinIdBySlug: {},
  captureCampaignIds: [],
  captureOptinIds: [],
  interestIds: [],
  automationIds: [BIENVENUE_RETOUR, RELANCE],
};

function regle(field: string, op: Operator, value: PredValue): Group {
  return { id: "root", type: "group", op: "AND", children: [{ id: "n1", type: "predicate", field, op, value }] };
}

const compile = (node: Group, ctx: RuleContext = CTX) => compileRule(node, ctx);

describe("le registre", () => {
  test("les quatre champs sont dans la catégorie Automations", () => {
    for (const key of ["lifecycle_email", "automation_email", "resubscribed", "confirmed"]) {
      expect(getField(key)?.category).toBe("Automations");
    }
  });

  test("les e-mails système ciblables sont les trois de la carte System, SANS `reengagement`", () => {
    // `reengagement` ne part plus jamais : le proposer ferait cocher une option qui rend toujours zéro.
    expect([...SYSTEM_EMAIL_KEYS]).toEqual(["confirmation", "welcome", "unsubscribe_ack"]);
  });

  test("aucune automation en dur : ce sont des uuid scopés marque", () => {
    expect(getField("automation_email")?.options).toBeUndefined();
    expect(getField("automation_email")?.ops).toEqual(["any_of", "none_of"]);
  });

  test("seul `resubscribed` déclare « ever »", () => {
    expect(FIELDS.filter((f) => f.ops.includes("ever")).map((f) => f.key)).toEqual(["resubscribed"]);
  });
});

describe("Got a system email — `lifecycle_sent`", () => {
  test("« any of » compile en `ov`, « none of » en `not.ov`", () => {
    expect(compile(regle("lifecycle_email", "any_of", ["welcome", "confirmation"])).expr)
      .toBe("lifecycle_sent.ov.{welcome,confirmation}");
    expect(compile(regle("lifecycle_email", "none_of", ["welcome"])).expr)
      .toBe("lifecycle_sent.not.ov.{welcome}");
  });

  test("⛔ un kind hors registre est DÉNONCÉ, jamais filtré en silence", () => {
    // MUTATION QUI DOIT TUER CE TEST : ouvrir la liste blanche à tout kind qui a l'air d'un mot.
    for (const kind of ["reengagement", "Welcome", "welcome}", "automation"]) {
      const r = compile(regle("lifecycle_email", "any_of", ["confirmation", kind]));
      expect(r.expr).toBeNull();
      expect(r.widened).toBe(true);
      expect(r.unsupported).toEqual([`lifecycle_email:${kind}`]);
    }
  });

  test("une liste vide ne compile pas", () => {
    const r = compile(regle("lifecycle_email", "any_of", []));
    expect(r.expr).toBeNull();
    expect(r.widened).toBe(true);
  });
});

describe("Got an email from automation — `automations_sent`", () => {
  test("une automation de la marque compile", () => {
    expect(compile(regle("automation_email", "any_of", [BIENVENUE_RETOUR, RELANCE])).expr)
      .toBe(`automations_sent.ov.{${BIENVENUE_RETOUR},${RELANCE}}`);
    expect(compile(regle("automation_email", "none_of", [RELANCE])).expr)
      .toBe(`automations_sent.not.ov.{${RELANCE}}`);
  });

  test("⛔ l'automation d'une AUTRE marque est dénoncée : `none_of` matcherait tout le monde", () => {
    // MUTATION QUI DOIT TUER CE TEST : `allowed: () => undefined` retiré au profit d'un simple test UUID.
    const r = compile(regle("automation_email", "none_of", [AUTOMATION_AUTRE_MARQUE]));
    expect(r.expr).toBeNull();
    expect(r.widened).toBe(true);
    expect(r.unsupported).toEqual([`automation_email:${AUTOMATION_AUTRE_MARQUE}`]);
  });

  test("⛔ sans liste blanche (appelant pas à jour), le prédicat est dénoncé — repli FERMÉ", () => {
    const { automationIds: _retire, ...sansListe } = CTX;
    const r = compile(regle("automation_email", "any_of", [RELANCE]), sansListe);
    expect(r.expr).toBeNull();
    expect(r.widened).toBe(true);
  });

  test("un élément qui n'est pas un uuid est refusé avant même la liste blanche", () => {
    const r = compile(regle("automation_email", "any_of", ["x},and(country.eq.XX"]), {
      ...CTX, automationIds: [...(CTX.automationIds ?? []), "x},and(country.eq.XX"],
    });
    expect(r.expr).toBeNull();
  });
});

describe("Re-subscribed — `resubscribed_at`", () => {
  test("« ever » : la date existe, quelle que soit la valeur restée dans le prédicat", () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer la branche `ever` du compilateur.
    expect(compile(regle("resubscribed", "ever", { days: 30 })).expr).toBe("resubscribed_at.not.is.null");
    expect(compile(regle("resubscribed", "ever", "")).expr).toBe("resubscribed_at.not.is.null");
  });

  test("« in the last N days » borne la date", () => {
    const expr = compile(regle("resubscribed", "within_days", { days: 7 })).expr ?? "";
    expect(expr.startsWith('resubscribed_at.gte."')).toBe(true);
    const iso = expr.slice('resubscribed_at.gte."'.length, -1);
    const ecartJours = (Date.now() - Date.parse(iso)) / 86_400_000;
    expect(ecartJours).toBeGreaterThan(6.99);
    expect(ecartJours).toBeLessThan(7.01);
  });
});

describe("Confirmed — `consent_at`", () => {
  test("« in the last N days » lit la date de confirmation", () => {
    expect(compile(regle("confirmed", "within_days", { days: 30 })).expr?.startsWith('consent_at.gte."')).toBe(true);
  });

  test("« ever » n'est pas déclaré ici : refusé, pas compilé en `not.is.null`", () => {
    // La quatrième barrière : un opérateur que le champ ne déclare pas vient d'une règle forgée.
    const r = compile(regle("confirmed", "ever", { days: 30 }));
    expect(r.expr).toBeNull();
    expect(r.widened).toBe(true);
    expect(compile(regle("last_open", "ever", { days: 30 })).expr).toBeNull();
  });
});

describe("le résumé en clair", () => {
  const pred = (field: string, op: Operator, value: PredValue) =>
    ({ id: "n1", type: "predicate" as const, field, op, value });

  test("un champ `days` quelconque ne rend jamais « [object Object] »", () => {
    // MUTATION QUI DOIT TUER CE TEST : ramener la branche des jours à `last_open` seul.
    expect(summarize(pred("confirmed", "within_days", { days: 30 }))).toBe("confirmed in the last 30 days");
    expect(summarize(pred("resubscribed", "within_days", { days: 7 }))).toBe("re-subscribed in the last 7 days");
    expect(summarize(pred("last_open", "within_days", { days: 30 }))).toBe("last open in the last 30 days");
    expect(summarize(pred("last_open", "older_than_days", { days: 90 }))).toBe("last open more than 90 days");
  });

  test("« ever » ne montre pas les jours restés dans la valeur", () => {
    expect(summarize(pred("resubscribed", "ever", { days: 30 }))).toBe("re-subscribed ever");
  });

  test("les e-mails système se nomment par le registre, les automations par le carnet", () => {
    expect(summarize(pred("lifecycle_email", "any_of", ["welcome", "unsubscribe_ack"])))
      .toBe("Got a system email is any of Welcome, Unsubscribe receipt");
    expect(summarize(pred("automation_email", "none_of", [RELANCE]), { [RELANCE]: "Re-engagement" }))
      .toBe("Got an email from automation is none of Re-engagement");
  });
});
