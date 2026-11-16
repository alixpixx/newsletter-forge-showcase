/**
 * LA POPULATION D'UNE RÈGLE — abonnés newsletter ou contacts hors newsletter (0088, 25/09/2026).
 *
 * ⛔ L'INVARIANT QUE CE BANC TIENT : un contact n'est atteint QUE par une règle qui porte
 * « Newsletter: No » au premier niveau d'un ET. Toute autre forme est soit les abonnés (aucun
 * sélecteur), soit un REFUS (`widened`) — jamais un repli silencieux sur l'une ou l'autre vue.
 */
import { describe, expect, test } from "bun:test";
import { compileRule, type RuleContext } from "./compile";
import { summarize, type Group, type Predicate, type RuleNode } from "./fields";

const CTX: RuleContext = { tagIdBySlug: {}, optinIdBySlug: {} };

const p = (id: string, field: string, value: Predicate["value"], op: Predicate["op"] = "eq"): Predicate =>
  ({ id, type: "predicate", field, op, value });
const et = (...children: RuleNode[]): Group => ({ id: "root", type: "group", op: "AND", children });
const ou = (id: string, ...children: RuleNode[]): Group => ({ id, type: "group", op: "OR", children });

describe("le sélecteur au premier niveau d'un ET choisit la vue", () => {
  test("sans sélecteur : les abonnés, exactement comme avant", () => {
    // MUTATION QUI DOIT TUER CE TEST : faire valoir `contacts` par défaut.
    const r = compileRule(et(p("n1", "country", "BR")), CTX);
    expect(r.population).toBe("subscribers");
    expect(r.expr).toBe('country.eq."BR"');
    expect(r.widened).toBe(false);
  });

  test("« Newsletter: No » seul vise TOUS les contacts de la marque, sans filtre ni refus", () => {
    const r = compileRule(et(p("n1", "newsletter", "no")), CTX);
    expect(r.population).toBe("contacts");
    expect(r.expr).toBeNull();
    expect(r.widened).toBe(false);
    expect(r.unsupported).toEqual([]);
  });

  test("« Newsletter: No » ET un autre critère : contacts, filtrés par ce critère seul", () => {
    // MUTATION QUI DOIT TUER CE TEST : laisser le sélecteur dans l'arbre (il serait dénoncé → refus).
    const r = compileRule(et(p("n1", "newsletter", "no"), p("n2", "country", "BR")), CTX);
    expect(r.population).toBe("contacts");
    expect(r.expr).toBe('country.eq."BR"');
    expect(r.widened).toBe(false);
  });

  test("« Newsletter: Yes » : les abonnés, et le sélecteur ne filtre rien de plus", () => {
    const r = compileRule(et(p("n1", "newsletter", "yes"), p("n2", "country", "BR")), CTX);
    expect(r.population).toBe("subscribers");
    expect(r.expr).toBe('country.eq."BR"');
    expect(r.widened).toBe(false);
  });

  test("une règle réduite au prédicat seul (sans groupe) est lue de même", () => {
    const r = compileRule(p("n1", "newsletter", "no"), CTX);
    expect(r.population).toBe("contacts");
    expect(r.widened).toBe(false);
  });
});

describe("⛔ toute autre forme est REFUSÉE, jamais repliée", () => {
  test("sous un OU imbriqué : refus, même si l'OU aurait seulement rétréci", () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer `acc.widened = true` de la branche « nested ».
    const r = compileRule(et(p("n1", "country", "BR"), ou("g1", p("n2", "newsletter", "no"), p("n3", "language", "en"))), CTX);
    expect(r.widened).toBe(true);
    expect(r.unsupported).toContain("newsletter:nested");
    expect(r.population).toBe("subscribers");
  });

  test("une racine OU n'est pas un premier niveau d'ET : refus", () => {
    const r = compileRule(ou("root", p("n1", "newsletter", "no"), p("n2", "country", "BR")), CTX);
    expect(r.widened).toBe(true);
    expect(r.unsupported).toContain("newsletter:nested");
  });

  test("« Yes » ET « No » ensemble : refus", () => {
    const r = compileRule(et(p("n1", "newsletter", "yes"), p("n2", "newsletter", "no")), CTX);
    expect(r.widened).toBe(true);
    expect(r.unsupported).toContain("newsletter:conflict");
  });

  test("une valeur ou un opérateur inconnus : refus nommé", () => {
    // MUTATION QUI DOIT TUER CE TEST : accepter toute valeur autre que « no » comme les abonnés.
    const inconnue = compileRule(et(p("n1", "newsletter", "maybe")), CTX);
    expect(inconnue.widened).toBe(true);
    expect(inconnue.unsupported).toEqual(["newsletter:eq:maybe"]);
    const neq = compileRule(et(p("n1", "newsletter", "no", "neq")), CTX);
    expect(neq.widened).toBe(true);
    expect(neq.population).toBe("subscribers");
  });
});

test("le résumé nomme la population", () => {
  expect(summarize(et(p("n1", "newsletter", "no"), p("n2", "country", "BR"))))
    .toBe("Newsletter is Not subscribed (contacts) and Country is Brazil");
});
