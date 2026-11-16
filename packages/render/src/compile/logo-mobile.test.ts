/**
 * LE LOGO SUR MOBILE — « sur le responsive c'est top sauf le logo qui reste géant, tu peux lui garder
 * une taille normale et centrer » (Alix, 24/09/2026).
 *
 * Jusqu'à 1.6.3, toute image portait `fluid-on-mobile` : sous le seuil d'empilement (479 px), MJML pose
 * `table.mj-full-width-mobile { width:100% !important }`, et l'`<img>` est déjà à `width:100%` — le
 * logo remplissait sa colonne. Mesuré dans Chromium et WebKit à 375 px sur les documents réels :
 * Copper Kettle 198 → 375 px, Harbor Tech 198 → 311, Northwind Sports 129 → 327, Giro do Tricolor 131 → 343.
 *
 * ⚠️ `bun test` n'a pas de navigateur (Playwright ne démarre pas sous bun, Windows). Ce banc lit donc
 * ce qu'un navigateur appliquerait à 375 px : les classes posées sur la table, la cellule et l'image
 * du logo, et les règles des `<style>` actives à cette largeur (media `max-width` ≥ 375, ou aucune).
 * Les largeurs en pixels ont été MESURÉES hors banc, sur les 127 documents réels (cf. le commit).
 *
 * Les documents reprennent la forme des en-têtes et pieds de marque réels (`brand_partial`) et du
 * bandeau « Giro do Tricolor » (logo aligné à gauche dans un 1-1, marges 32 / 0).
 */
import { describe, expect, test } from "bun:test";
import { compileDoc } from "./index";

const LOGO = "https://cdn.example.com/logo.png";

const img = (widthPct: number, align: "left" | "center" | "right", padding?: object) => ({
  id: "logo",
  type: "image",
  src: LOGO,
  alt: "Logo",
  widthPct,
  align,
  ...(padding ? { style: { padding } } : {}),
});

function doc(layout: "1" | "1-1", blocks: unknown[], theme: Record<string, unknown> = {}) {
  const columns = layout === "1" ? [{ id: "c1", blocks }] : [{ id: "c1", blocks }, { id: "c2", blocks: [] }];
  return {
    schema: 2,
    meta: { subject: "Sujet", preheader: "", assetSlug: "northwind-sports", locale: "pt-BR" },
    theme: { contentWidth: 600, rowPadding: { top: 0, right: 0, bottom: 0, left: 0 }, ...theme },
    rows: [{ id: "r1", layout, columns }],
  };
}

/* ------------------------------------------------------------------ *
 * Lecture du HTML compilé
 * ------------------------------------------------------------------ */

interface Regle {
  /** `max-width` de la media query qui la porte ; `Infinity` hors media query. */
  max: number;
  selecteur: string;
  decl: string;
}

/** Toutes les règles des `<style>`, avec la largeur jusqu'à laquelle elles s'appliquent. */
function regles(html: string): Regle[] {
  const out: Regle[] = [];
  for (const [, css] of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    let i = 0;
    const src = css as string;
    while (i < src.length) {
      const ouvre = src.indexOf("{", i);
      if (ouvre === -1) break;
      const tete = src.slice(i, ouvre).trim();
      if (tete.startsWith("@media")) {
        // Bloc imbriqué : on lit ses règles jusqu'à l'accolade qui le ferme.
        const m = /max-width:\s*(\d+)px/.exec(tete);
        // Une media query sans `max-width` (min-width, prefers-color-scheme) ne compte pas ici :
        // elle ne s'applique pas à un écran étroit en thème clair.
        const max = m ? Number(m[1]) : -1;
        let j = ouvre + 1;
        for (;;) {
          const o = src.indexOf("{", j);
          const f = src.indexOf("}", j);
          if (f === -1) throw new Error("CSS mal formé");
          if (o === -1 || f < o) {
            i = f + 1;
            break;
          }
          const fin = src.indexOf("}", o);
          if (max >= 0) out.push({ max, selecteur: src.slice(j, o).trim(), decl: src.slice(o + 1, fin) });
          j = fin + 1;
        }
      } else {
        const fin = src.indexOf("}", ouvre);
        out.push({ max: Infinity, selecteur: tete, decl: src.slice(ouvre + 1, fin) });
        i = fin + 1;
      }
    }
  }
  return out;
}

interface Logo {
  align: string;
  celluleClasses: string[];
  cellulePadding: [number, number, number, number];
  tableClasses: string[];
  tdStyle: string;
  tdClasses: string[];
  imgWidth: number;
}

/** La structure MJML d'un `mj-image` : cellule alignée → table → td à largeur → img. */
function logo(html: string): Logo {
  const re =
    /<td\s+align="(left|center|right)"(?: class="([^"]*)")? style="([^"]*)"\s*>\s*<table\s+border="0" cellpadding="0" cellspacing="0" role="presentation" style="[^"]*"(?: class="([^"]*)")?\s*>\s*<tbody>\s*<tr>\s*<td\s+style="([^"]*)"(?: class="([^"]*)")?>\s*<img\s([^>]*)\/>/g;
  const trouves = [...html.matchAll(re)].filter((m) => (m[7] ?? "").includes(`src="${LOGO}"`));
  expect(trouves).toHaveLength(1);
  const m = trouves[0]!;
  const pad = /padding:(\d+)px (\d+)px (\d+)px (\d+)px/.exec(m[3]!);
  expect(pad).not.toBeNull();
  return {
    align: m[1]!,
    celluleClasses: (m[2] ?? "").split(/\s+/).filter(Boolean),
    cellulePadding: [Number(pad![1]), Number(pad![2]), Number(pad![3]), Number(pad![4])],
    tableClasses: (m[4] ?? "").split(/\s+/).filter(Boolean),
    tdStyle: m[5]!,
    tdClasses: (m[6] ?? "").split(/\s+/).filter(Boolean),
    imgWidth: Number(/\swidth="(\d+)"/.exec(` ${m[7]}`)?.[1]),
  };
}

const actives = (rs: Regle[], largeur: number) => rs.filter((r) => r.max >= largeur);
const composes = (selecteur: string) =>
  selecteur
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s*>\s*|\s+/));
const classesDe = (compose: string) => [...compose.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
const baliseDe = (compose: string) => /^[a-z]+/.exec(compose)?.[0];

/**
 * Une règle active à `largeur` qui donne une LARGEUR à la table, au td ou à l'image du logo — soit par
 * leurs propres classes, soit par une classe de la cellule suivie d'un descendant de ce type.
 */
function reglesQuiElargissent(html: string, l: Logo, largeur: number): string[] {
  const cibles = [
    { balise: "table", classes: l.tableClasses },
    { balise: "td", classes: l.tdClasses },
    { balise: "img", classes: [] as string[] },
  ];
  const out: string[] = [];
  for (const r of actives(regles(html), largeur)) {
    if (!/(^|;|\s)(min-)?width\s*:/.test(r.decl)) continue;
    for (const parts of composes(r.selecteur)) {
      const dernier = parts[parts.length - 1]!;
      for (const c of cibles) {
        const balise = baliseDe(dernier);
        if (balise !== undefined && balise !== c.balise) continue;
        const seul = parts.length === 1 && classesDe(dernier).length > 0 && classesDe(dernier).every((k) => c.classes.includes(k));
        const parLaCellule = parts.length > 1 && classesDe(parts[0]!).some((k) => l.celluleClasses.includes(k)) && balise === c.balise;
        if (seul || parLaCellule) out.push(`${r.selecteur} { ${r.decl.trim()} } (max-width ${r.max})`);
      }
    }
  }
  return out;
}

/** Marges gauche et droite de la cellule à `largeur` : l'inline, sauf règle active qui les remplace. */
function margesA(html: string, l: Logo, largeur: number): { gauche: number; droite: number } {
  let gauche = l.cellulePadding[3];
  let droite = l.cellulePadding[1];
  for (const r of actives(regles(html), largeur)) {
    const touche = composes(r.selecteur).some((p) => p.length === 1 && classesDe(p[0]!).some((k) => l.celluleClasses.includes(k)));
    if (!touche) continue;
    const g = /padding-left:\s*(\d+)px/.exec(r.decl);
    const d = /padding-right:\s*(\d+)px/.exec(r.decl);
    if (g) gauche = Number(g[1]);
    if (d) droite = Number(d[1]);
  }
  return { gauche, droite };
}

/** La table du logo est-elle centrée par des marges auto, par une règle active à `largeur` ? */
function tableCentreeA(html: string, l: Logo, largeur: number): boolean {
  return actives(regles(html), largeur).some(
    (r) =>
      composes(r.selecteur).some((p) => p.length === 2 && p[1] === "table" && classesDe(p[0]!).some((k) => l.celluleClasses.includes(k))) &&
      /margin-left:\s*auto/.test(r.decl) &&
      /margin-right:\s*auto/.test(r.decl),
  );
}

/** Les règles actives à `largeur` qui touchent la cellule du logo (marges, alignement, largeur). */
function reglesMiseEnPageDeLaCellule(html: string, l: Logo, largeur: number): Regle[] {
  return actives(regles(html), largeur).filter(
    (r) =>
      /padding|margin|width|text-align/.test(r.decl) &&
      composes(r.selecteur).some((p) => classesDe(p[0]!).some((k) => l.celluleClasses.includes(k))),
  );
}

async function compile(d: unknown) {
  return (await compileDoc(d as never)).html;
}

/* ------------------------------------------------------------------ *
 * Les formes réelles
 * ------------------------------------------------------------------ */

const CAS = [
  // En-tête Copper Kettle : 33 % d'une colonne de 600, marges nulles.
  { nom: "en-tête Copper Kettle (33 %, centré)", d: doc("1", [img(33, "center", { top: 26, left: 0, right: 0, bottom: 0 })]), largeur: 198 },
  // En-tête Harbor Tech : 37 % de 600 − 2 × 32.
  { nom: "en-tête Harbor Tech (37 %, centré)", d: doc("1", [img(37, "center", { top: 28, left: 32, right: 32, bottom: 0 })]), largeur: 198 },
  // Pied Northwind Sports : 18 % de 536.
  { nom: "pied Northwind Sports (18 %, centré)", d: doc("1", [img(18, "center", { top: 24, left: 32, right: 32, bottom: 0 })]), largeur: 96 },
  // En-tête Northwind Sports : moitié gauche d'un 1-1, 51 % de 300.
  { nom: "en-tête Northwind Sports (1-1, 51 %, centré dans sa colonne)", d: doc("1-1", [img(51, "center", { top: 0, left: 0, right: 0, bottom: 0 })]), largeur: 153 },
  // Giro do Tricolor : aligné à GAUCHE dans la moitié gauche d'un 1-1, marges 32 / 0 : 49 % de 268.
  { nom: "bandeau Giro do Tricolor (1-1, 49 %, à gauche, marges 32 / 0)", d: doc("1-1", [img(49, "left", { top: 22, left: 32, right: 0, bottom: 16 })]), largeur: 131 },
  // Aligné à DROITE, marges 0 / 24 : 40 % de 576.
  { nom: "logo aligné à droite (40 %, marges 0 / 24)", d: doc("1", [img(40, "right", { top: 10, left: 0, right: 24, bottom: 10 })]), largeur: 230 },
];

describe("le logo garde sa taille réglée sur mobile, et s'y centre", () => {
  for (const c of CAS) {
    test(`${c.nom} : ${c.largeur} px au plus à 375 px, centré`, async () => {
      const html = await compile(c.d);
      const l = logo(html);

      // La largeur réglée, en attribut (Outlook) comme en plafond de la cellule.
      expect(l.imgWidth).toBe(c.largeur);
      expect(l.tdStyle).toContain(`width:${c.largeur}px`);

      // À 375 px, rien ne donne de largeur à la table, au td ou à l'image : la cellule `width:<W>px`
      // plafonne le logo (l'image, à `width:100%`, ne rétrécit que si la colonne est plus étroite).
      expect(reglesQuiElargissent(html, l, 375)).toEqual([]);

      // Centré à 375 px : marges égales, et soit la cellule centre déjà (align="center"), soit une
      // règle active centre la table par des marges auto.
      // Marges égales, et jamais rognées : la plus grande des deux (32 / 0 → 32 / 32).
      const [, droite, , gauche] = l.cellulePadding;
      expect(margesA(html, l, 375)).toEqual({ gauche: Math.max(gauche, droite), droite: Math.max(gauche, droite) });
      if (l.align !== "center") expect(tableCentreeA(html, l, 375)).toBe(true);
    });
  }

  test("l'écran large ne bouge pas : alignement d'origine, et aucune règle de la cellule active à 600 px", async () => {
    for (const c of CAS) {
      const html = await compile(c.d);
      const l = logo(html);
      expect(l.align).toBe((c.d.rows[0]!.columns[0]!.blocks[0] as { align: string }).align);
      expect(reglesMiseEnPageDeLaCellule(html, l, 600)).toEqual([]);
      // Et sans marges auto au bureau : le logo à gauche reste à gauche.
      expect(tableCentreeA(html, l, 600)).toBe(false);
    }
  });

  test("le centrage suit le seuil d'empilement réglé (`columnBreakpoint`), pas celui des réglages mobiles", async () => {
    const giro = doc("1-1", [img(49, "left", { top: 22, left: 32, right: 0, bottom: 16 })], { columnBreakpoint: 560 });
    const html = await compile(giro);
    const l = logo(html);
    const centrage = regles(html).filter(
      (r) => /margin/.test(r.decl) && composes(r.selecteur).some((p) => p[1] === "table" && classesDe(p[0]!).some((k) => l.celluleClasses.includes(k))),
    );
    expect(centrage.map((r) => r.max)).toEqual([559]);
    expect(tableCentreeA(html, l, 559)).toBe(true);
    expect(tableCentreeA(html, l, 560)).toBe(false);
  });

  test("des marges mobiles réglées par l'auteur servent de base : la plus grande des deux, des deux côtés", async () => {
    const html = await compile(doc("1", [{ ...img(40, "left", { top: 0, left: 40, right: 0, bottom: 0 }), style: { padding: { top: 0, left: 40, right: 0, bottom: 0 }, paddingMobile: { left: 12, right: 20 } } }]));
    const l = logo(html);
    expect(margesA(html, l, 375)).toEqual({ gauche: 20, droite: 20 });
  });
});

/* ------------------------------------------------------------------ *
 * Frontière : 100 % veut dire « toute la colonne », sur mobile aussi
 * ------------------------------------------------------------------ */

describe("frontière : une image à 100 % reste fluide", () => {
  test("image pleine colonne d'un 1-1 : toujours passée à 100 % sous le seuil d'empilement", async () => {
    const html = await compile(doc("1-1", [img(100, "center")]));
    const l = logo(html);
    expect(l.tableClasses).toContain("mj-full-width-mobile");
    expect(l.tdClasses).toContain("mj-full-width-mobile");
    expect(reglesQuiElargissent(html, l, 375).length).toBeGreaterThan(0);
  });
});
