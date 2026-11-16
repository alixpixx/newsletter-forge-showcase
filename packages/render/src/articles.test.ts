/**
 * Banc des deux fonctions qui décident de l'introduction écrite par le modèle :
 * `usesAiTokens` (faut-il appeler ?) et `articlesOf` (avec quoi ?).
 *
 * Elles sont mesurées ensemble parce qu'elles servent le même mécanisme et se trompent de la même
 * manière : en silence. Une détection ratée ne produit aucune erreur — juste un blanc dans l'email.
 */
import { describe, expect, test } from "bun:test";
import { articlesOf } from "./articles";
import { usesAiTokens } from "./hydrate";

function doc(blocks: Record<string, unknown>[]) {
  return { rows: [{ columns: [{ blocks }] }] };
}

describe("usesAiTokens", () => {
  test("reconnaît les deux jetons, où qu'ils soient", () => {
    expect(usesAiTokens("<p>{{ai_intro}}</p>")).toBe(true);
    expect(usesAiTokens(null, "{{ai_preheader}}")).toBe(true);
    expect(usesAiTokens(null, null, "{{ai_preheader}} — la suite")).toBe(true);
  });

  test("⛔ un repli inline est le MÊME jeton", () => {
    // C'est le faux négatif qu'une recherche de chaîne littérale produirait : l'auteur voit son
    // jeton, rien ne se génère, et aucune erreur ne le dit.
    expect(usesAiTokens("{{ai_intro|Le résumé du jour}}")).toBe(true);
    expect(usesAiTokens("{{ ai_preheader }}")).toBe(true);
  });

  test("ne se déclenche pas sur autre chose", () => {
    expect(usesAiTokens("<p>{{first_article}} et {{article_count}}</p>")).toBe(false);
    expect(usesAiTokens("le mot ai_intro écrit en clair, sans accolades")).toBe(false);
    // Un jeton voisin ne doit pas mordre : `ai_introduction` n'est pas `ai_intro`.
    expect(usesAiTokens("{{ai_introduction}}")).toBe(false);
    expect(usesAiTokens(null, undefined, "")).toBe(false);
    expect(usesAiTokens()).toBe(false);
  });
});

describe("articlesOf", () => {
  test("rend titre et chapô, dans l'ordre, à n'importe quelle profondeur", () => {
    const d = doc([
      { type: "article", title: "  Premier  ", excerpt: " Son chapô " },
      { type: "text", value: "rien" },
      { type: "article", title: "Second", excerpt: "" },
    ]);
    expect(articlesOf(d)).toEqual([
      { title: "Premier", excerpt: "Son chapô" },
      { title: "Second", excerpt: "" },
    ]);
  });

  test("⛔ un article sans titre est écarté", () => {
    // Le compter gonflerait le nombre annoncé au modèle, qui promettrait un article de plus que
    // l'édition n'en contient.
    const d = doc([{ type: "article", title: "   " }, { type: "article", title: "Vrai" }]);
    expect(articlesOf(d)).toHaveLength(1);
    expect(articlesOf(d)[0]!.title).toBe("Vrai");
  });

  test("un document sans article, ou vide, rend une liste vide", () => {
    expect(articlesOf(doc([{ type: "text", value: "rien" }]))).toEqual([]);
    expect(articlesOf(null)).toEqual([]);
    expect(articlesOf({})).toEqual([]);
  });

  test("le plafond borne la liste — une édition à 60 articles ne fait pas exploser le prompt", () => {
    const d = doc(Array.from({ length: 40 }, (_, i) => ({ type: "article", title: `T${i}` })));
    expect(articlesOf(d)).toHaveLength(20);
    expect(articlesOf(d, 3)).toHaveLength(3);
  });
});
