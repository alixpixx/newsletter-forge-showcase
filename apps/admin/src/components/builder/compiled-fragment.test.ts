/**
 * Ce que le canvas dessine AUTOUR du HTML compilé — mesuré contre le compilateur, pas contre soi.
 *
 * Les cadres de row et de colonne ne sont pas des fragments compilés : le canvas les dessine pour
 * garder la sélection et le glisser-déposer. Ils sont donc la dernière place où un écart peut renaître
 * (c'était l'un des défauts inventoriés : une row sans style perdait `theme.rowPadding` à l'écran).
 * Chaque valeur est ici exigée DANS le HTML que `compileDoc` émet pour le même document.
 */
import { describe, expect, test } from "bun:test";
import { compileDoc } from "@nf/render/compile";
import { BLOCK_TYPES, EmailDoc, type Column, type Row, type Theme } from "@nf/render/schema";
import { newBlock } from "./factories";
import {
  LEGAL_FOOTER_TOKEN,
  NO_CTA_HINT,
  SHADOW_RESET_CSS,
  TEXT_PRESETS,
  chosenLegalTemplateId,
  columnFrameStyle,
  dangerousAttr,
  dangerousTag,
  editorFontHref,
  hasLegalFooter,
  fragmentKeys,
  fragmentMarkup,
  hintsFor,
  lightOnly,
  rawFrameDocument,
  rowFrameStyle,
  textEditStyle,
  withLegalFooter,
} from "./compiled-fragment";

const spacer = (id: string) => ({ id, type: "spacer", height: 11 });

function doc(rows: unknown[], theme: Record<string, unknown> = {}): EmailDoc {
  return EmailDoc.parse({ schema: 2, meta: { assetSlug: "x", locale: "es", subject: "S" }, theme, rows });
}

const px = (v: unknown) => `${Number(v ?? 0)}px`;
const pad = (s: Record<string, unknown>) =>
  `padding:${px(s.paddingTop)} ${px(s.paddingRight)} ${px(s.paddingBottom)} ${px(s.paddingLeft)}`;

describe("cadre de row = la section compilée", () => {
  const THEME = { rowPadding: { top: 10, right: 20, bottom: 30, left: 40 } };
  const cas: { nom: string; style?: Record<string, unknown> }[] = [
    { nom: "row sans style : le padding et le fond du thème" },
    // ⛔ Le cas qui mentait : le padding de la row COMPLÈTE celui du thème côté par côté.
    { nom: "padding partiel : fusion côté par côté", style: { padding: { top: 5 } } },
    { nom: "padding complet et fond propre", style: { padding: { top: 1, right: 2, bottom: 3, left: 4 }, backgroundColor: "#ABCDEF" } },
  ];
  for (const c of cas) {
    test(c.nom, async () => {
      const d = doc([{ id: "r1", layout: "1", style: c.style, columns: [{ id: "c1", blocks: [spacer("b1")] }] }], THEME);
      const { html } = await compileDoc(d);
      const s = rowFrameStyle(d.rows[0] as Row, d.theme);
      expect(html).toContain(`direction:ltr;font-size:0px;${pad(s as Record<string, unknown>)};text-align:left;`);
      // Une rangée sans texte à fond posé porte en plus l'épingle anti-thème-sombre (`nf-bg-…`, 23/09/2026) :
      // une classe, qui ne change rien au fond dessiné.
      // (`.test` et non `toMatch` : le tsconfig de l'admin ne connaît pas ce matcher de bun.)
      const section = new RegExp(`<div  (?:class="nf-bg-[0-9a-f]+" )?style="background:${s.backgroundColor};background-color:${s.backgroundColor};margin:0px auto;`);
      expect(section.test(html)).toBe(true);
      expect(s.borderWidth).toBeUndefined();
      expect(s.borderRadius).toBeUndefined();
    });
  }
});

describe("cadre de colonne = la cellule compilée", () => {
  test("fond, bordure au gris du thème, alignement hérité de la row, padding de la colonne seule", async () => {
    const d = doc(
      [
        {
          id: "r1",
          layout: "1-1",
          style: { verticalAlign: "middle", padding: { top: 9 } },
          columns: [
            { id: "c1", style: { padding: { left: 7 }, backgroundColor: "#123456", borderWidth: 3 }, blocks: [spacer("b1")] },
            { id: "c2", blocks: [spacer("b2")] },
          ],
        },
      ],
      { rowPadding: { top: 10, right: 20, bottom: 30, left: 40 } },
    );
    const { html } = await compileDoc(d);
    const row = d.rows[0] as Row;
    const [c1, c2] = row.columns as [Column, Column];
    const s1 = columnFrameStyle(c1, row, d.theme);
    const s2 = columnFrameStyle(c2, row, d.theme);
    expect(html).toContain(`<td  style="background-color:${s1.backgroundColor};border:${s1.border};vertical-align:middle;${pad(s1 as Record<string, unknown>)};">`);
    expect(html).toContain(`<td  style="vertical-align:middle;${pad(s2 as Record<string, unknown>)};">`);
    expect(s1.alignSelf).toBe("center");
    expect(s2.backgroundColor).toBeUndefined();
    expect(s2.border).toBeUndefined();
  });

  test("sans alignement nulle part : en haut, comme `vertical-align:top`", () => {
    const row = { id: "r", layout: "1", columns: [{ id: "c", blocks: [] }] } as unknown as Row;
    expect(columnFrameStyle(row.columns[0] as Column, row, doc([]).theme).alignSelf).toBe("flex-start");
  });
});

describe("éditeur en place du bloc texte = le bloc texte compilé", () => {
  for (const preset of Object.keys(TEXT_PRESETS) as (keyof typeof TEXT_PRESETS)[]) {
    test(`preset ${preset}`, async () => {
      const d = doc(
        [
          {
            id: "r1",
            layout: "1",
            style: { fontFamily: "Georgia, serif", textColor: "#224466" },
            columns: [
              {
                id: "c1",
                style: { align: "center" },
                blocks: [
                  {
                    id: "t1",
                    type: "text",
                    preset,
                    style: { padding: { left: 3 } },
                    paragraphs: [{ spans: [{ text: "Hola" }] }],
                  },
                ],
              },
            ],
          },
        ],
        { blockPadding: { top: 9, right: 22, bottom: 9, left: 22 }, fontSize: 17 },
      );
      const { html } = await compileDoc(d);
      const row = d.rows[0] as Row;
      const col = row.columns[0] as Column;
      const s = textEditStyle(col.blocks[0] as never, row, col, d.theme);
      // La cellule : padding fusionné, aligné comme la colonne le demande.
      expect(html).toContain(`align="${s.textAlign}" style="font-size:0px;${pad(s as Record<string, unknown>)};word-break:break-word;"`);
      // Le conteneur : police et couleur héritées de la row.
      expect(html).toContain(`font-family:${s.fontFamily};font-size:${s.fontSize}px;line-height:${s.lineHeight};text-align:${s.textAlign};color:${s.color};`);
      // Le paragraphe : graisse du preset.
      expect(html).toContain(`font-size:${s.fontSize}px;line-height:${s.lineHeight};font-weight:${s.fontWeight};color:${s.color};`);
    });
  }
});

describe("contexte du fragment", () => {
  test("le fragment est posé dans la table de colonne, jamais nu", () => {
    const m = fragmentMarkup("<tr><td>x</td></tr>");
    expect(m.startsWith('<div class="nfc-col" style="font-size:0px;')).toBe(true);
    expect(m).toContain("<tbody><tr><td>x</td></tr></tbody></table></div>");
  });

  test("la racine d'ombre n'hérite de rien et ne capte aucun clic", () => {
    expect(SHADOW_RESET_CSS).toContain(":host{all:initial;");
    expect(SHADOW_RESET_CSS).toContain("pointer-events:none");
  });

  test("le document d'un bloc html brut ne peut pas refermer sa feuille", () => {
    const d = rawFrameDocument("<b>x</b>", "p{color:red}</style><script>alert(1)</script>");
    expect(d).not.toContain("</style><script>");
    expect(d).toContain("<b>x</b>");
  });

  test("rien d'exécutable n'entre dans l'origine de l'admin", () => {
    for (const t of ["script", "SCRIPT", "iframe", "object", "embed", "base", "meta", "link", "form"]) expect(dangerousTag(t)).toBe(true);
    for (const t of ["table", "td", "img", "a", "p", "div", "span", "style"]) expect(dangerousTag(t)).toBe(false);
    for (const [n, v] of [
      ["onerror", "alert(1)"],
      ["ONLOAD", "x"],
      ["href", "javascript:alert(1)"],
      ["href", " \tJaVaScRiPt:alert(1)"],
      ["src", "data:text/html,<script>"],
      ["srcdoc", "<p>"],
    ] as const) {
      expect(dangerousAttr(n, v)).toBe(true);
    }
    for (const [n, v] of [
      ["href", "https://copper-kettle.example/nota"],
      ["href", "{{unsubscribe_url}}"],
      ["src", "data:image/png;base64,AAAA"],
      ["style", "color:#123456"],
      ["bgcolor", "#E11D48"],
    ] as const) {
      expect(dangerousAttr(n, v)).toBe(false);
    }
  });

  test("l'iframe d'un bloc html recharge les polices admises, attribut échappé", () => {
    const d = rawFrameDocument("<b>x</b>", "", ['https://fonts.googleapis.com/css?family=A"B']);
    expect(d).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=A&quot;B">');
  });

  test("le pied légal choisi se lit sur le bloc, comme à la publication", () => {
    const avec = doc([{ id: "r", layout: "1", columns: [{ id: "c", blocks: [{ id: "f", type: "footer_legal", legalTemplateId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }] }] }]);
    expect(chosenLegalTemplateId(avec)).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(hasLegalFooter(avec)).toBe(true);
    const sans = doc([{ id: "r", layout: "1", columns: [{ id: "c", blocks: [spacer("s")] }] }]);
    expect(chosenLegalTemplateId(sans)).toBeNull();
    expect(hasLegalFooter(sans)).toBe(false);
  });

  test("le vrai pied légal remplace CHAQUE jeton ; sans pied, le jeton reste visible", () => {
    const html = `<td>${LEGAL_FOOTER_TOKEN}</td><td>${LEGAL_FOOTER_TOKEN}</td>`;
    expect(withLegalFooter(html, "<div>PIED</div>")).toBe("<td><div>PIED</div></td><td><div>PIED</div></td>");
    expect(withLegalFooter(html, null)).toBe(html);
  });

  test("le thème sombre du système n'entre pas dans le canvas", () => {
    const css = ":root { color-scheme: light dark; supported-color-schemes: light dark; }\n@media (prefers-color-scheme: dark) { .a { color:#fff } }";
    const out = lightOnly(css);
    expect(out).not.toContain("prefers-color-scheme");
    expect(out).not.toContain("color-scheme");
    expect(out).toContain("@media not all");
  });
});

describe("fraîcheur : la clé suit tout ce dont le rendu dépend, et rien d'autre", () => {
  const base = () =>
    doc([
      { id: "r1", layout: "1-1", columns: [{ id: "c1", blocks: [spacer("a")] }, { id: "c2", blocks: [spacer("b")] }] },
      { id: "r2", layout: "1", columns: [{ id: "c3", blocks: [spacer("c")] }] },
    ]);

  test("changer un bloc ne périme que lui", () => {
    const d1 = base();
    const d2 = structuredClone(d1);
    (d2.rows[0]!.columns[0]!.blocks[0] as { height: number }).height = 40;
    const [k1, k2] = [fragmentKeys(d1), fragmentKeys(d2)];
    expect(k1.get("a")).not.toBe(k2.get("a"));
    expect(k1.get("b")).toBe(k2.get("b"));
    expect(k1.get("c")).toBe(k2.get("c"));
  });

  test("le style de row périme ses blocs, pas ceux des autres rows", () => {
    const d1 = base();
    const d2 = structuredClone(d1);
    d2.rows[0]!.style = { textColor: "#111111" };
    const [k1, k2] = [fragmentKeys(d1), fragmentKeys(d2)];
    expect(k1.get("a")).not.toBe(k2.get("a"));
    expect(k1.get("b")).not.toBe(k2.get("b"));
    expect(k1.get("c")).toBe(k2.get("c"));
  });

  test("le thème et la langue périment tout", () => {
    const d1 = base();
    const d2 = structuredClone(d1);
    d2.meta.locale = "pt-BR";
    const d3 = structuredClone(d1);
    d3.theme = { ...d3.theme, radius: 2 } as Theme;
    for (const autre of [d2, d3]) {
      const [k1, k2] = [fragmentKeys(d1), fragmentKeys(autre)];
      for (const id of ["a", "b", "c"]) expect(k1.get(id)).not.toBe(k2.get(id));
    }
  });
});

describe("repères d'édition", () => {
  test("chaque bloc métier né vide dit quoi remplir", () => {
    const attendus = ["pick", "odds_table", "standings", "scoreboard", "section_title", "callout", "promo", "article"];
    for (const type of BLOCK_TYPES) {
      const hints = hintsFor(newBlock(type), "es");
      if (attendus.includes(type)) expect(hints.some((h) => h.text.startsWith("To fill"))).toBe(true);
    }
  });

  test("article : lien mort ⇒ la CAUSE, jamais un champ à remplir", () => {
    const b = { ...newBlock("article"), title: "T", excerpt: "E", href: "#", ctaStyle: "link" } as never;
    expect(hintsFor(b, "es").map((h) => h.text)).toContain(NO_CTA_HINT);
  });

  test("image sans alt ⇒ témoin ; sentinelle `ai://` ⇒ illustration à générer", () => {
    const img = { ...newBlock("image"), src: "https://x.invalid/a.png", alt: "" } as never;
    expect(hintsFor(img, "es")).toEqual([{ text: "Missing alt text", tone: "warn" }]);
    const ai = { ...newBlock("image"), src: "ai://un-stade", alt: "" } as never;
    expect(hintsFor(ai, "es")[0]!.text.startsWith("Illustration to be generated")).toBe(true);
  });
});

describe("polices chargées dans l'éditeur", () => {
  test("seuls les services de polices, en https", () => {
    expect(editorFontHref("https://fonts.googleapis.com/css2?family=Inter:wght@400;700")).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;700",
    );
    expect(editorFontHref("https://fonts.bunny.net/css?family=inter")).not.toBeNull();
    for (const refuse of [
      "http://fonts.googleapis.com/css2?family=Inter",
      "https://evil.invalid/fonts.css",
      "https://fonts.googleapis.com.evil.invalid/x",
      "javascript:alert(1)",
      "pas une url",
    ]) {
      expect(editorFontHref(refuse)).toBeNull();
    }
  });
});
