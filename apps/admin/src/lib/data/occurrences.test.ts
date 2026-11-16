import { describe, expect, test } from "bun:test";

// ⚠️ Ces deux modules tirent `@/lib/session` → `auth.ts`, qui LÈVE à l'import si AUTH_SECRET manque.
// Même parade que `campaigns.test.ts` : poser la variable, puis charger dynamiquement — un import
// statique serait hissé avant l'affectation et le fichier échouerait au chargement.
process.env.AUTH_SECRET = "secret-de-test-uniquement-08092026";
const { ECHEANCES_A_VENIR, ECHEANCES_LUES, classerEcheances } = await import("./occurrences");
const { OCCURRENCES_ARRETABLES } = await import("./campaigns");

const MAINTENANT = "2026-09-18T20:00:00.000Z";

/**
 * CE QUE LA LISTE DES CAMPAGNES DIT D'UNE SÉRIE.
 *
 * ⛔ Jusqu'au 18/09/2026, une seule phrase — « Nothing planned » — répondait à cinq états : série
 * éteinte, série allumée mais pas encore matérialisée, éditions RETENUES, éditions EN RETARD,
 * cadence terminée. Quatre d'entre eux sont des pannes. Ce banc surveille les quatre choses qui
 * peuvent se tromper ici sans lever la moindre erreur :
 *
 *  1. GARDER LA PLUS PROCHE et non la plus lointaine — et sans dépendre de l'ordre des lignes, qui
 *     vient d'un `order by` écrit ailleurs.
 *  2. COMPARER DES INSTANTS, pas des chaînes : PostgREST rend `+00:00` là où `toISOString()` rend
 *     `.000Z`, et un `>=` lexicographique répond juste tant que les deux côtés viennent de la même
 *     source — donc en test, et pas en production.
 *  3. COMPTER les éditions retenues sans jamais les annoncer comme une date.
 *  4. NE PAS CONFONDRE « ce qui va partir » AVEC « ce qu'on peut encore arrêter ».
 */
/** Une ligne d'occurrence, telle que PostgREST la rend. */
function l(campaign_id: string, scheduled_at: string | null, status = "planned") {
  return { campaign_id, scheduled_at, status };
}

describe("classerEcheances — la plus proche, et rien d'inventé", () => {
  test("garde la plus proche, pas la plus lointaine", () => {
    const m = classerEcheances(
      [
        l("a", "2026-09-20T07:00:00Z"),
        l("a", "2026-09-27T07:00:00Z"),
        l("a", "2026-10-04T07:00:00Z"),
      ],
      MAINTENANT,
    );
    expect(m.get("a")?.prochaine).toBe("2026-09-20T07:00:00Z");
    expect(m.size).toBe(1);
  });

  test("⛔ MUTATION QUI DOIT LE TUER : se fier à l'ordre des lignes reçues", () => {
    // Les mêmes dates, servies à L'ENVERS. « Garder la première vue » rendrait la plus lointaine :
    // un écran qui annonce un envoi dans trois semaines quand il part dans deux jours.
    const m = classerEcheances(
      [
        l("a", "2026-10-04T07:00:00Z"),
        l("a", "2026-09-27T07:00:00Z"),
        l("a", "2026-09-20T07:00:00Z"),
      ],
      MAINTENANT,
    );
    expect(m.get("a")?.prochaine).toBe("2026-09-20T07:00:00Z");
  });

  test("une entrée par campagne, chacune avec SA plus proche", () => {
    const m = classerEcheances(
      [
        l("a", "2026-09-20T07:00:00Z"),
        l("b", "2026-09-21T07:00:00Z"),
        l("a", "2026-09-27T07:00:00Z"),
        l("b", "2026-09-28T07:00:00Z"),
      ],
      MAINTENANT,
    );
    expect(m.get("a")?.prochaine).toBe("2026-09-20T07:00:00Z");
    expect(m.get("b")?.prochaine).toBe("2026-09-21T07:00:00Z");
    expect(m.size).toBe(2);
  });

  test("une ligne sans date ne masque pas la vraie prochaine", () => {
    const m = classerEcheances([l("a", null), l("a", "2026-09-20T07:00:00Z")], MAINTENANT);
    expect(m.get("a")?.prochaine).toBe("2026-09-20T07:00:00Z");
  });

  test("une ligne sans campagne est ignorée", () => {
    const m = classerEcheances([l("", "2026-09-20T07:00:00Z")], MAINTENANT);
    expect(m.size).toBe(0);
  });

  test("aucune ligne — une carte vide, pas une exception", () => {
    expect(classerEcheances([], MAINTENANT).size).toBe(0);
  });

  test("un instant de référence illisible rend une carte vide, sans lever", () => {
    expect(classerEcheances([l("a", "2026-09-20T07:00:00Z")], "pas une date").size).toBe(0);
  });
});

describe("classerEcheances — deux notations du MÊME instant", () => {
  test("⛔⛔ `+00:00` et `.000Z` désignent le même instant : la comparaison est sur des INSTANTS", () => {
    // Le cas qui tue un `>=` lexicographique, et LUI SEUL : à préfixe égal, '+' (0x2B) est
    // inférieur à '.' (0x2E), donc une échéance EXACTEMENT à l'heure serait classée EN RETARD —
    // l'écran afficherait « Overdue » sur un envoi parfaitement à l'heure.
    const m = classerEcheances([l("a", "2026-09-18T20:00:00+00:00")], MAINTENANT);
    expect(m.get("a")?.prochaine).toBe("2026-09-18T20:00:00+00:00");
    expect(m.get("a")?.enRetard).toBeNull();
  });

  test("et une date réellement passée reste passée, même notation", () => {
    const m = classerEcheances([l("a", "2026-09-18T19:59:59+00:00")], MAINTENANT);
    expect(m.get("a")?.prochaine).toBeNull();
    expect(m.get("a")?.enRetard).toBe("2026-09-18T19:59:59+00:00");
  });
});

describe("classerEcheances — les pannes muettes remontent enfin", () => {
  test("⛔ une édition RETENUE n'est jamais annoncée comme une date", () => {
    const m = classerEcheances([l("a", "2026-09-20T07:00:00Z", "held")], MAINTENANT);
    expect(m.get("a")?.prochaine).toBeNull();
    expect(m.get("a")?.retenues).toBe(1);
  });

  test("⛔ mais elle se COMPTE — c'était le trou : créée, bloquée, et invisible", () => {
    const m = classerEcheances(
      [l("a", "2026-09-20T07:00:00Z", "held"), l("a", "2026-09-27T07:00:00Z", "held")],
      MAINTENANT,
    );
    expect(m.get("a")?.retenues).toBe(2);
  });

  test("une retenue SANS date se compte quand même : c'est l'incident qui compte", () => {
    const m = classerEcheances([{ campaign_id: "a", scheduled_at: null, status: "held" }], MAINTENANT);
    expect(m.get("a")?.retenues).toBe(1);
  });

  test("⛔ une prochaine date ET des retenues : les DEUX faits remontent", () => {
    // Sinon la colonne dirait la date et tairait l'incident — exactement ce qu'elle faisait.
    const m = classerEcheances(
      [l("a", "2026-09-20T07:00:00Z", "held"), l("a", "2026-09-27T07:00:00Z", "planned")],
      MAINTENANT,
    );
    expect(m.get("a")?.prochaine).toBe("2026-09-27T07:00:00Z");
    expect(m.get("a")?.retenues).toBe(1);
  });

  test("⛔ EN RETARD : la PLUS ANCIENNE des dates passées non parties", () => {
    // « Overdue since » doit nommer le début de la panne, pas son dernier symptome.
    const m = classerEcheances(
      [l("a", "2026-09-17T07:00:00Z"), l("a", "2026-09-12T07:00:00Z")],
      MAINTENANT,
    );
    expect(m.get("a")?.enRetard).toBe("2026-09-12T07:00:00Z");
    expect(m.get("a")?.prochaine).toBeNull();
  });

  test("une date à venir efface le retard de l'affichage, mais pas du calcul", () => {
    const m = classerEcheances(
      [l("a", "2026-09-12T07:00:00Z"), l("a", "2026-09-20T07:00:00Z")],
      MAINTENANT,
    );
    expect(m.get("a")?.prochaine).toBe("2026-09-20T07:00:00Z");
    expect(m.get("a")?.enRetard).toBe("2026-09-12T07:00:00Z");
  });
});

describe("ECHEANCES_LUES — lire `held` sans jamais l'annoncer", () => {
  test("`held` est LU", () => {
    expect([...ECHEANCES_LUES]).toContain("held");
  });

  test("mais il n'entre pas dans ce qui va partir", () => {
    expect([...ECHEANCES_A_VENIR]).not.toContain("held");
  });

  test("aucun statut terminal n'est lu : le volume reste borné par l'horizon", () => {
    for (const fini of ["sent", "sending", "cancelled", "failed"]) {
      expect([...ECHEANCES_LUES]).not.toContain(fini);
    }
  });
});

describe("ECHEANCES_A_VENIR — ce qui va partir n'est pas ce qu'on peut arrêter", () => {
  test("`held` est EXCLU : une échéance retenue ne partira pas à sa date", () => {
    // ⛔ C'est toute la différence avec `OCCURRENCES_ARRETABLES`. Annoncer une occurrence `held`
    // comme prochaine date promettrait un envoi que le matérialiseur a justement retenu — et
    // l'écran de détail, lui, dirait l'inverse.
    expect([...ECHEANCES_A_VENIR]).not.toContain("held");
    expect([...OCCURRENCES_ARRETABLES]).toContain("held");
  });

  test("les deux listes ne diffèrent QUE par `held`", () => {
    // Si elles se mettent à diverger ailleurs, l'une des deux a bougé sans l'autre : ce banc le dit
    // ici plutôt que de laisser un écran annuler ce qu'un autre déclare intouchable.
    const arretables = [...OCCURRENCES_ARRETABLES].filter((s) => s !== "held").sort();
    expect([...ECHEANCES_A_VENIR].sort()).toEqual(arretables);
  });

  test("aucun statut terminal ne s'y glisse", () => {
    for (const fini of ["sent", "sending", "cancelled", "failed"]) {
      expect([...ECHEANCES_A_VENIR]).not.toContain(fini);
    }
  });
});
