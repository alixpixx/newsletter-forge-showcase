/**
 * PANNEAU « EMAIL STYLES » (24/09/2026, feature 5, étape 4).
 *
 * Ce qui est tenu :
 *  - chacun des 13 réglages écrit SA clé du thème, et elle seule, et l'e-mail compilé change (un
 *    réglage sans effet sur l'e-mail est un mensonge d'interface) ;
 *  - « Reset » d'un réglage posé rend l'absence (le rendu d'avant) ;
 *  - rien de sélectionné ⇒ l'inspecteur montre ce panneau (onglet Content) ; la portée « Email » de
 *    l'onglet Style aussi, avec le thème complet replié dessous (« Advanced »).
 */
import { describe, expect, test } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compileDoc } from "@nf/render/compile";
import { EmailDoc, Theme } from "@nf/render/schema";
import { FontInput } from "./article-look-fields";
import { Group } from "./inspector-ui";
import { EmailStylesPanel, Inspector } from "./inspector";

/** Composants sans hook, dépliés ; tout le reste est une feuille (`ThemePanel` compris : il est « Advanced »). */
const EXPAND = new Set<unknown>([FontInput, Group]);
interface Leaf {
  name: string;
  props: Record<string, unknown>;
}
function leaves(node: ReactNode, out: Leaf[] = []): Leaf[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) leaves(n as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const type = node.type as unknown;
  const props = node.props as Record<string, unknown>;
  if (typeof type === "function") {
    if (EXPAND.has(type)) leaves((type as (p: unknown) => ReactNode)(props), out);
    else out.push({ name: (type as { name: string }).name, props });
    return out;
  }
  return leaves(props.children as ReactNode, out);
}

const doc = (theme: Record<string, unknown> = {}) =>
  EmailDoc.parse({
    schema: 2,
    meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "banc", locale: "en" },
    theme,
    rows: [
      {
        id: "r",
        layout: "1",
        columns: [
          {
            id: "c",
            blocks: [
              { id: "b_h1", type: "text", preset: "h1", paragraphs: [{ spans: [{ text: "Titre" }] }] },
              { id: "b_p", type: "text", preset: "body", paragraphs: [{ spans: [{ text: "Lien", href: "https://example.com" }] }] },
              { id: "b_btn", type: "button", label: "Go", href: "https://example.com/go" },
            ],
          },
        ],
      },
    ],
  });

/** Monte le panneau sur un thème, rend le contrôle `label`, et ce que son `onChange` écrirait. */
function panneau(theme: Theme) {
  let ecrit: Theme | undefined;
  const tree = EmailStylesPanel({ theme, usedIn: "", onChange: (t) => (ecrit = t) });
  const all = leaves(tree);
  return {
    all,
    control(label: string): Leaf {
      const found = all.filter((l) => l.props.label === label);
      if (found.length !== 1) throw new Error(`« ${label} » : ${found.length} contrôle(s)`);
      return found[0] as Leaf;
    },
    get ecrit() {
      return ecrit;
    },
  };
}

const CAS: [string, keyof Theme, unknown, unknown?][] = [
  ["Title colour", "headingColor", "#0B6E4F"],
  ["Title font", "headingFont", "Georgia, serif"],
  ["Text colour", "textColor", "#222230"],
  ["Text font", "fontFamily", "Georgia, serif"],
  ["Text size", "fontSize", 19],
  // ⛔ L'interligne des paragraphes est celui du preset « body », pas `theme.lineHeight` (sans effet sur un
  // bloc texte : c'est ce que ce banc a attrapé le 24/09).
  ["Line height", "textPresets", 1.8, { body: { lineHeight: 1.8 } }],
  ["Link colour", "linkColor", "#0033AA"],
  // Case cochée = garder le soulignement = `resetLinkDecoration: false`.
  ["Link underline", "resetLinkDecoration", true, false],
  ["Button background", "brandColor", "#0033AA"],
  ["Button text", "buttonTextColor", "#111118"],
  ["Corner radius", "radius", 14],
  ["Page background", "bodyBackground", "#E0E0E8"],
  ["Content background", "contentBackground", "#F7F7FA"],
];

describe("chaque réglage écrit SA clé, et l'e-mail change", () => {
  for (const [label, cle, saisie, attendu] of CAS) {
    test(`${label} → theme.${String(cle)}`, async () => {
      const base = doc();
      const p = panneau(base.theme);
      (p.control(label).props.onChange as (v: unknown) => void)(saisie);
      const apres = p.ecrit as Theme;
      expect(apres[cle]).toEqual((attendu ?? saisie) as never);
      // Rien d'autre ne bouge dans le thème.
      const autres = Object.keys({ ...base.theme, ...apres }).filter((k) => k !== cle);
      for (const k of autres) expect([k, apres[k as keyof Theme]]).toEqual([k, base.theme[k as keyof Theme]]);
      const [avant, maintenant] = await Promise.all([compileDoc(base), compileDoc({ ...base, theme: apres })]);
      expect(maintenant.html).not.toBe(avant.html);
    });
  }

  test("les 13 réglages sont là, une fois chacun", () => {
    const p = panneau(doc().theme);
    // `control` lève si le libellé manque ou se répète (le shim de types admin n'a pas `toThrow`).
    for (const [label] of CAS) expect(p.control(label).props.label).toBe(label);
  });

  test("Reset d'une couleur de titre posée : la clé redevient ABSENTE (le rendu d'avant)", () => {
    const p = panneau(doc({ headingColor: "#0B6E4F" }).theme);
    (p.control("Title colour").props.onReset as () => void)();
    expect("headingColor" in (p.ecrit as Theme) && (p.ecrit as Theme).headingColor !== undefined).toBe(false);
  });
});

describe("où le panneau s'affiche", () => {
  const rendu = (selection: unknown) =>
    renderToStaticMarkup(createElement(Inspector, { doc: doc(), selection: selection as never, dispatch: () => {} }));

  test("rien de sélectionné : les styles de l'e-mail, et le thème complet replié dessous", () => {
    const html = rendu(null);
    expect(html).toContain("Title colour");
    expect(html).toContain("Page background");
    expect(html).toContain("Advanced — every email setting");
  });

  test("un bloc sélectionné : son contenu, pas les styles de l'e-mail", () => {
    const html = rendu({ kind: "block", id: "b_h1" });
    expect(html).not.toContain("Title colour");
  });
});
