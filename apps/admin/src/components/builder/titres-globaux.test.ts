/**
 * STYLES GLOBAUX DES TITRES (24/09/2026, feature 5) — les COPIES de la cascade côté admin.
 *
 * Le compilateur décide (`resolve()` de `packages/render/src/compile/mjml.ts`, banc
 * `titres-globaux.test.ts` du même nom) : cascade row → colonne → bloc, sinon `theme.headingColor` /
 * `headingFont`, sinon le texte. Quatre endroits de l'admin RECOPIENT cette règle ; chacun est tenu ici :
 *   1. `resolveLookBase` — les valeurs héritées des champs « Title font / Title colour » ;
 *   2. `StylePanel` — la couleur et la police héritées affichées pour un bloc TITRE ;
 *   3. `textEditStyle` — l'éditeur en place d'un h1-h3, qui ne doit pas changer de couleur à la fermeture ;
 *   4. le pré-vol — un titre se juge sur la couleur qui PART, pas sur celle du texte.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compileDoc } from "@nf/render/compile";
import { EmailDoc, Theme } from "@nf/render/schema";
import { resolveLookBase } from "./article-look-fields";
import { textEditStyle } from "./compiled-fragment";
import { estBlocTitre, StylePanel } from "./inspector";
import { runPreflight } from "@/lib/preflight";

const TITRE = "#0B6E4F";
const theme = (extra: Partial<Theme> = {}): Theme => Theme.parse({ textColor: "#1A1A20", fontFamily: "Arial, sans-serif", ...extra });

describe("1. resolveLookBase", () => {
  test("rien dans la cascade : la couleur et la police des titres viennent de l'e-mail", () => {
    const b = resolveLookBase(theme({ headingColor: TITRE, headingFont: "Georgia, serif" }), [undefined]);
    expect(b.headingColor).toBe(TITRE);
    expect(b.headingFont).toBe("Georgia, serif");
    expect(b.headingColorIsEmail).toBe(true);
    expect(b.headingFontIsEmail).toBe(true);
    expect(b.textColor).toBe("#1A1A20");
  });

  test("⛔ une couleur ou une police de la cascade l'emporte (bandeau sombre)", () => {
    const b = resolveLookBase(theme({ headingColor: TITRE, headingFont: "Georgia, serif" }), [{ textColor: "#FEFEFE", fontFamily: "Verdana" }, undefined]);
    expect(b.headingColor).toBe("#FEFEFE");
    expect(b.headingFont).toBe("Verdana");
    expect(b.headingColorIsEmail).toBe(false);
  });

  test("sans style global : exactement le texte", () => {
    const b = resolveLookBase(theme(), []);
    expect(b.headingColor).toBe(b.textColor);
    expect(b.headingFont).toBe(b.fontFamily);
    expect(b.headingColorIsEmail).toBe(false);
  });
});

describe("2. StylePanel d'un bloc titre", () => {
  const rendu = (titre: boolean, t: Theme) =>
    renderToStaticMarkup(
      createElement(StylePanel, { scope: "block", style: undefined, onChange: () => {}, theme: t, parents: [], defaultPadding: t.blockPadding, titre }),
    );

  test("un titre montre la couleur de titre de l'e-mail, et d'où elle vient", () => {
    const html = rendu(true, theme({ headingColor: TITRE }));
    expect(html).toContain("Email title style");
    expect(html.toLowerCase()).toContain(TITRE.toLowerCase());
  });

  test("un texte courant, ou un titre sans style global, montre le thème", () => {
    expect(rendu(false, theme({ headingColor: TITRE }))).not.toContain("Email title style");
    expect(rendu(true, theme())).not.toContain("Email title style");
  });

  test("estBlocTitre : h1-h3 et titre de section, rien d'autre", () => {
    const texte = (preset: string) => ({ id: "t", type: "text", preset, paragraphs: [] }) as never;
    expect(["h1", "h2", "h3"].map((p) => estBlocTitre(texte(p)))).toEqual([true, true, true]);
    expect(["body", "small"].map((p) => estBlocTitre(texte(p)))).toEqual([false, false]);
    expect(estBlocTitre({ id: "s", type: "section_title", label: "L" } as never)).toBe(true);
    expect(estBlocTitre(null)).toBe(false);
  });
});

describe("3. textEditStyle (éditeur en place)", () => {
  const row = { id: "r", layout: "1", columns: [] } as never;
  const col = { id: "c", blocks: [] } as never;
  const bloc = (preset: string, style?: object) => ({ id: "t", type: "text", preset, paragraphs: [], style }) as never;
  const t = theme({ headingColor: TITRE, headingFont: "Georgia, serif" });

  test("un h1 prend la couleur et la police des titres", () => {
    const s = textEditStyle(bloc("h1"), row, col, t);
    expect(s.color).toBe(TITRE);
    expect(s.fontFamily).toBe("Georgia, serif");
  });

  test("un body garde le texte ; une couleur posée sur le bloc l'emporte sur le titre", () => {
    expect(textEditStyle(bloc("body"), row, col, t).color).toBe("#1A1A20");
    expect(textEditStyle(bloc("h2", { textColor: "#AA0000" }), row, col, t).color).toBe("#AA0000");
  });
});

describe("4. pré-vol : le titre se juge sur la couleur qui part", () => {
  const doc = (extra: Partial<Theme>) =>
    EmailDoc.parse({
      schema: 2,
      meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "banc", locale: "en" },
      theme: { contentBackground: "#FEFEFE", textColor: "#1A1A20", ...extra },
      rows: [
        {
          id: "r",
          layout: "1",
          columns: [
            {
              id: "c",
              blocks: [
                { id: "b_h1", type: "text", preset: "h1", paragraphs: [{ spans: [{ text: "Titre" }] }] },
                { id: "b_sec", type: "section_title", label: "Rubrique" },
                { id: "b_body", type: "text", preset: "body", paragraphs: [{ spans: [{ text: "Texte" }] }] },
              ],
            },
          ],
        },
        { id: "r_f", layout: "1", columns: [{ id: "c_f", blocks: [{ id: "b_footer", type: "footer_legal" }] }] },
      ],
    });
  const contraste = async (d: EmailDoc, id: string) => {
    const c = await compileDoc(d);
    return runPreflight(d, { sizeBytes: c.sizeBytes, warnings: c.warnings }).findings.filter(
      (f) => f.group === "contrast" && f.target?.blockId === id && !f.message.startsWith("In dark mode"),
    );
  };

  test("une couleur de titre trop claire est signalée sur les TITRES, et seulement sur eux", async () => {
    const d = doc({ headingColor: "#F2F2F2" });
    expect((await contraste(d, "b_h1")).length).toBeGreaterThan(0);
    expect((await contraste(d, "b_sec")).length).toBeGreaterThan(0);
    expect(await contraste(d, "b_body")).toHaveLength(0);
  });

  test("sans style global, rien n'est signalé", async () => {
    const d = doc({});
    expect(await contraste(d, "b_h1")).toHaveLength(0);
    expect(await contraste(d, "b_sec")).toHaveLength(0);
  });
});
