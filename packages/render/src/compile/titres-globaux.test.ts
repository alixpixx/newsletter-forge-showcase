/**
 * STYLES GLOBAUX DES TITRES (24/09/2026, feature 5) — `theme.headingColor` / `theme.headingFont`.
 *
 * Ce qui est tenu :
 *  - absents, le rendu est EXACTEMENT celui d'avant (même octets qu'avec la couleur/police du texte) ;
 *  - posés, ils atteignent CHAQUE titre (h1-h3, titre de section, article, encart classique et mis
 *    en page) et AUCUN texte courant ;
 *  - une couleur ou une police posée sur la rangée, la colonne ou le bloc l'emporte toujours (un
 *    bandeau sombre garde son titre clair), et la couleur de titre propre au bloc aussi ;
 *  - le bouton d'un encart ne suit PAS la police des titres.
 */
import { describe, expect, test } from "bun:test";
import { compileDoc } from "./index";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const TITRE = "#0B6E4F";
const CLAIR = "#FEFEFE";
const p = (text: string): Json => ({ spans: [{ text }] });
const row = (id: string, blocks: Json[], extra: Json = {}): Json => ({ id, layout: "1", columns: [{ id: `${id}_c`, blocks }], ...extra });

function doc(theme: Json = {}, rows?: Json[]): Json {
  return {
    schema: 2,
    meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "banc", locale: "en" },
    theme: { fontFamily: "Arial, sans-serif", textColor: "#1A1A20", ...theme },
    rows: rows ?? [
      row("r_txt", [
        { id: "t_h1", type: "text", preset: "h1", paragraphs: [p("Titre un")] },
        { id: "t_h2", type: "text", preset: "h2", paragraphs: [p("Titre deux")] },
        { id: "t_h3", type: "text", preset: "h3", paragraphs: [p("Titre trois")] },
        { id: "t_body", type: "text", preset: "body", paragraphs: [p("Texte courant")] },
        { id: "t_small", type: "text", preset: "small", paragraphs: [p("Petit texte")] },
        { id: "t_sec", type: "section_title", label: "Rubrique", rule: "none" },
        {
          id: "t_art",
          type: "article",
          title: "Titre article",
          excerpt: "Chapeau article.",
          imageAlt: "",
          href: "https://news.example.com/a",
        },
        {
          id: "t_call",
          type: "callout",
          kicker: "",
          title: "Titre encart",
          body: "Corps encart.",
          href: "https://example.com/c",
          ctaLabel: "Bouton encart",
        },
        {
          id: "t_lay",
          type: "callout",
          layout: "strip",
          kicker: "",
          title: "Titre mis en page",
          body: "Corps mis en page.",
          href: "https://example.com/l",
          ctaLabel: "Bouton mis en page",
        },
      ]),
    ],
  };
}

/** Les `n` derniers attributs `style` ouverts avant le texte : ceux de l'élément qui le porte et de ses parents. */
function stylesAvant(html: string, texte: string, n = 1): string {
  const i = html.indexOf(`>${texte}<`);
  if (i < 0) throw new Error(`texte introuvable : ${texte}`);
  const styles = [...html.slice(0, i + 1).matchAll(/style="([^"]*)"/g)].map((m) => m[1] as string);
  return styles.slice(-n).join(" | ");
}

const TITRES = ["Titre un", "Titre deux", "Titre trois", "Rubrique", "Titre article", "Titre encart", "Titre mis en page"];
/** Texte courant, avec le nombre de styles à lire : 2 pour un bloc texte (le `<p>` et le `mj-text` qui le porte), 1 ailleurs (le style de l'élément lui-même, pas celui du titre voisin). */
const COURANTS: [string, number][] = [["Texte courant", 2], ["Petit texte", 2], ["Chapeau article.", 1], ["Corps encart.", 1], ["Corps mis en page.", 1]];

describe("absents : le rendu d'avant, à l'octet", () => {
  test("sans les clés = avec la couleur et la police du texte recopiées dedans", async () => {
    const [sans, egal] = await Promise.all([
      compileDoc(doc() as never),
      compileDoc(doc({ headingColor: "#1A1A20", headingFont: "Arial, sans-serif" }) as never),
    ]);
    expect(egal.html).toBe(sans.html);
    expect(egal.text).toBe(sans.text);
  });
});

describe("posés : chaque titre, aucun texte courant", () => {
  test("headingColor atteint les 7 titres", async () => {
    const { html } = await compileDoc(doc({ headingColor: TITRE }) as never);
    for (const t of TITRES) expect(`${t} → ${stylesAvant(html, t)}`).toContain(`color:${TITRE}`);
  });

  test("headingColor n'atteint aucun texte courant", async () => {
    const { html } = await compileDoc(doc({ headingColor: TITRE }) as never);
    for (const [t, n] of COURANTS) expect(`${t} → ${stylesAvant(html, t, n)}`).not.toContain(TITRE);
  });

  test("headingFont atteint les titres (h1 par son mj-text), pas le texte courant", async () => {
    const { html } = await compileDoc(doc({ headingFont: "Georgia, serif" }) as never);
    for (const t of TITRES) expect(`${t} → ${stylesAvant(html, t, 2)}`).toContain("Georgia");
    for (const [t, n] of COURANTS) expect(`${t} → ${stylesAvant(html, t, n)}`).not.toContain("Georgia");
  });

  test("⛔ le bouton d'un encart ne suit PAS la police des titres", async () => {
    const { html } = await compileDoc(doc({ headingFont: "Georgia, serif" }) as never);
    for (const b of ["Bouton encart", "Bouton mis en page"]) {
      expect(`${b} → ${stylesAvant(html, b)}`).toContain("font-family:Arial");
    }
  });
});

describe("⛔ la cascade l'emporte sur le style global", () => {
  test("bandeau sombre : la couleur de texte de la RANGÉE garde le titre clair", async () => {
    const d = doc({ headingColor: TITRE }, [
      row("r_band", [{ id: "b_h2", type: "text", preset: "h2", paragraphs: [p("Titre bandeau")] }], {
        style: { backgroundColor: "#0D0D12", textColor: CLAIR },
      }),
    ]);
    const { html } = await compileDoc(d as never);
    expect(stylesAvant(html, "Titre bandeau")).toContain(`color:${CLAIR}`);
    expect(html).not.toContain(TITRE);
  });

  test("la couleur de texte de la COLONNE et celle du BLOC l'emportent aussi", async () => {
    const d = doc({ headingColor: TITRE }, [
      {
        id: "r_cols",
        layout: "1",
        columns: [
          {
            id: "c1",
            style: { textColor: CLAIR },
            blocks: [
              { id: "b_col", type: "section_title", label: "Rubrique colonne", rule: "none" },
            ],
          },
        ],
      },
      row("r_bloc", [{ id: "b_own", type: "text", preset: "h1", style: { textColor: "#AA0000" }, paragraphs: [p("Titre propre")] }]),
    ]);
    const { html } = await compileDoc(d as never);
    expect(stylesAvant(html, "Rubrique colonne")).toContain(`color:${CLAIR}`);
    expect(stylesAvant(html, "Titre propre")).toContain("color:#AA0000");
  });

  test("la couleur et la police de titre PROPRES au bloc l'emportent", async () => {
    const d = doc({ headingColor: TITRE, headingFont: "Georgia, serif" }, [
      row("r", [
        { id: "a", type: "article", title: "Article propre", excerpt: "E.", imageAlt: "", href: "https://news.example.com/b", titleColor: "#AA0000", titleFont: "Verdana, sans-serif" },
        { id: "c", type: "callout", kicker: "", body: "", title: "Encart propre", titleColor: "#AA0000", titleFont: "Verdana, sans-serif" },
      ]),
    ]);
    const { html } = await compileDoc(d as never);
    for (const t of ["Article propre", "Encart propre"]) {
      const s = stylesAvant(html, t);
      expect(s).toContain("color:#AA0000");
      expect(s).toContain("Verdana");
    }
  });
});
