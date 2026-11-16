/**
 * La liste filtrable de /templates, rendue avec des exemples, sans base ni navigateur.
 *
 * Ce qui est tenu : l'état initial vient de l'ADRESSE (`?q=&type=`) — c'est ce qui rend le lien
 * partageable et le retour arrière fidèle ; un filtre sans résultat montre le message et « Clear
 * filters », jamais un tableau vide.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// ⚠️ Les gestes d'une ligne (Duplicate, Rename, Archive) appellent `useRouter`, et la liste lit
// `useSearchParams` : hors de l'app Next, le banc fournit un routeur inerte et l'adresse.
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { TemplateLibrary } from "./template-library";
import type { TemplateListRow } from "./template-table";

const rien = () => undefined;
const ROUTEUR = { back: rien, forward: rien, refresh: rien, push: rien, replace: rien, prefetch: rien };

const L = (id: string, name: string, slug: string, category: string): TemplateListRow => ({
  id,
  name,
  slug,
  category,
  updatedAt: "2026-09-20T10:00:00Z",
  publishedVersion: 1,
});
const ROWS = [
  L("a", "Boletín Diario", "boletin-diario", "newsletter"),
  L("b", "Welcome series", "welcome-1", "welcome"),
  L("e", "Weekly roundup", "weekly-roundup", "newsletter"),
];

function rendre(requete: string) {
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: ROUTEUR as never },
      createElement(
        SearchParamsContext.Provider,
        { value: new URLSearchParams(requete) },
        createElement(TemplateLibrary, { rows: ROWS }),
      ),
    ),
  );
}
/** Le libellé de la (des) pastille(s) enfoncée(s). */
const enfoncees = (html: string) =>
  [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([^<]*)</g)].map((m) => m[1]);
const lignes = (html: string) => (html.split("<tbody>")[1] ?? "").split("</tbody>")[0]!.split("<tr").slice(1);

describe("la liste filtrable de /templates", () => {
  test("sans filtre : toutes les lignes, « All » actif, pas de compteur « N of M »", () => {
    const html = rendre("");
    expect(lignes(html)).toHaveLength(3);
    expect(enfoncees(html)).toEqual(["All"]);
    expect(html).not.toContain(" of 3 templates");
  });

  test("⛔ l'état initial vient de l'adresse : `?q=boletin&type=newsletter`", () => {
    const html = rendre("q=boletin&type=newsletter&tab=templates");
    const ls = lignes(html);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toContain("Boletín Diario");
    expect(html).toContain('value="boletin"');
    expect(enfoncees(html)).toEqual(["Newsletter"]);
    expect(html).toContain("1 of 3 templates");
  });

  test("⛔ aucun résultat : le message et « Clear filters », pas de tableau vide", () => {
    const html = rendre("q=zzz");
    expect(html).not.toContain("<table");
    expect(html).toContain("No template matches “zzz”");
    expect(html).toContain("Clear filters");
    expect(html).toContain("0 of 3 templates");
  });
});
