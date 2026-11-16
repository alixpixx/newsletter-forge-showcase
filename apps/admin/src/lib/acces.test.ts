/**
 * « Tout voir » (0075) — les DEUX décisions pures, et leur INDÉPENDANCE.
 *
 * Trois fautes coûteraient cher, dans les deux sens : un membre coché qui ne verrait que ses
 * octrois (la demande d'Alix non tenue, et en silence : l'écran dirait « All »), un membre NON
 * coché qui verrait tout (une fuite entre marques), et la chaîne `"false"` venue d'un corps JSON,
 * « truthy », qui ouvrirait tout à qui voulait le retirer.
 *
 * ⛔ ET UNE QUATRIÈME, PROPRE À 0075 : les deux drapeaux REFONDUS EN UN. C'est précisément ce que
 * 0074 faisait et ce qu'Alix a demandé de séparer — « je veux qu'un user ait accès qu'à un domaine
 * mais à tous les templates automatiquement ». Les quatre combinaisons sont donc mesurées une par
 * une : ni l'un ni l'autre, marques seules, templates seuls, les deux.
 */
import { describe, expect, test } from "bun:test";
import { lireBooleenOptionnel, voitToutesLesMarques, voitTousLesTemplates } from "./acces";

describe("voitToutesLesMarques / voitTousLesTemplates — les quatre combinaisons d'un membre", () => {
  // ⚠️ Pas de `test.each` dans apps/admin (TS2339) : boucle explicite.
  const cas: { nom: string; assets: boolean; templates: boolean }[] = [
    { nom: "ni l'un ni l'autre : ses octrois, et rien de plus", assets: false, templates: false },
    { nom: "marques seules : toutes les marques, mais pas tous les templates", assets: true, templates: false },
    { nom: "templates seuls : tous les templates de SES marques (le cas d'Alix)", assets: false, templates: true },
    { nom: "les deux : tout", assets: true, templates: true },
  ];

  for (const c of cas) {
    test(c.nom, () => {
      // Chaque décision ne lit QUE son drapeau : c'est toute la séparation demandée.
      expect(voitToutesLesMarques("member", c.assets)).toBe(c.assets);
      expect(voitTousLesTemplates("member", c.templates)).toBe(c.templates);
    });
  }

  test("aucune des deux ne lit le drapeau de l'autre", () => {
    // ⛔ Le mutant « les deux drapeaux refondus en un » meurt ici : avec `all_templates` seul, les
    // marques restent fermées, et réciproquement.
    expect(voitToutesLesMarques("member", false)).toBe(false); // alors que allTemplates serait vrai
    expect(voitTousLesTemplates("member", false)).toBe(false); // alors que allAssets serait vrai
  });
});

describe("super_admin — inchangé par 0075", () => {
  test("voit tout, avec ou sans les drapeaux", () => {
    for (const v of [false, true]) {
      expect(voitToutesLesMarques("super_admin", v)).toBe(true);
      expect(voitTousLesTemplates("super_admin", v)).toBe(true);
    }
  });
});

describe("une valeur qui n'est pas le booléen true n'ouvre rien", () => {
  test("ni pour les marques, ni pour les templates", () => {
    // Forcé : la base rend un booléen, mais une ligne mal typée ne doit pas ouvrir le périmètre.
    for (const v of ["true", "false", 1, {}] as unknown[]) {
      expect(voitToutesLesMarques("member", v as boolean)).toBe(false);
      expect(voitTousLesTemplates("member", v as boolean)).toBe(false);
    }
  });
});

describe("lireBooleenOptionnel — les champs allAssets / allTemplates d'un corps JSON", () => {
  test("absent : on ne change rien", () => {
    expect(lireBooleenOptionnel(undefined)).toEqual({ ok: true, valeur: undefined });
  });

  test("true et false passent tels quels — false est une valeur, pas une absence", () => {
    expect(lireBooleenOptionnel(true)).toEqual({ ok: true, valeur: true });
    expect(lireBooleenOptionnel(false)).toEqual({ ok: true, valeur: false });
  });

  test("tout le reste est REFUSÉ, jamais converti", () => {
    for (const v of ["false", "true", "", 0, 1, null, {}, []] as unknown[]) {
      expect(lireBooleenOptionnel(v)).toEqual({ ok: false });
    }
  });
});
