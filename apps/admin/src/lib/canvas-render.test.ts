/**
 * LE CANVAS MONTRE CE QUE L'ABONNÉ REÇOIT — mesuré bloc par bloc contre le vrai `compileDoc`.
 *
 * Pour chacun des 18 types de bloc (et un flux « une + Más noticias + filets »), le fragment que le
 * canvas affiche doit se retrouver MOT POUR MOT dans le HTML du document complet compilé comme à la
 * publication. Seuls les numéros des classes générées diffèrent (le canvas compile un document
 * synthétique, cf. `canvas-render.ts`) : ils sont neutralisés des deux côtés, rien d'autre.
 *
 * ⛔ Ce banc ne recopie AUCUNE valeur du compilateur : s'il rougit, c'est que le canvas montre autre
 * chose que l'e-mail, pas que le compilateur a changé d'avis.
 */
import { describe, expect, test } from "bun:test";
import { compileDoc } from "@nf/render/compile";
import { BLOCK_TYPES, EmailDoc, type Block, type EmailDocInput, type Row } from "@nf/render/schema";
import { headCss, renderCanvas, CanvasRenderError } from "./canvas-render";

/** Espaces écrasés, classes générées (`nf-m-3`, `nf-sp-a`…) anonymisées. */
const norme = (html: string): string =>
  html
    .replace(/\bnf-[a-z]+-[0-9a-z]+\b/g, "nf-#")
    .replace(/\s+/g, " ")
    .trim();

const item = (i: number, cat: string) => ({
  postId: `p${i}`,
  title: `Titular ${i}`,
  excerpt: `Resumen ${i}`,
  href: `https://copper-kettle.example/nota-${i}`,
  imageSrc: `https://copper-kettle.example/img-${i}.jpg`,
  imageAlt: "",
  publishedAt: `2026-09-22T1${i}:42:00Z`,
  category: cat,
});

/** Un bloc de chaque type, chacun avec un réglage que l'ancien canvas dessinait faux. */
/** Forme d'ENTRÉE d'un bloc : les défauts du schéma (`sourceLabel`, `categories`…) s'appliquent au parse. */
type BlockInput = EmailDocInput["rows"][number]["columns"][number]["blocks"][number];

const BLOCS: BlockInput[] = [
  {
    id: "b-text",
    type: "text",
    preset: "h2",
    style: { fontSize: 31, fontWeight: "800", lineHeight: 1.1 },
    paragraphs: [{ spans: [{ text: "Titre du jour " }, { text: "lien", href: "https://ex.example/a" }] }],
  },
  { id: "b-image", type: "image", src: "https://ex.example/i.png", alt: "Logo", widthPct: 60, align: "left" },
  {
    id: "b-button",
    type: "button",
    label: "Leer más",
    href: "https://ex.example/b",
    align: "right",
    style: { backgroundColor: "#00AA00", fontSize: 20 },
  },
  {
    id: "b-divider",
    type: "divider",
    thickness: 4,
    widthPct: 100,
    segments: [
      { color: "#FF0000", widthPct: 50 },
      { color: "#0000FF", widthPct: 50 },
    ],
  },
  { id: "b-spacer", type: "spacer", height: 37, heightMobile: 11 },
  { id: "b-html", type: "html", raw: '<p style="color:#123456">brut</p>' },
  {
    id: "b-social",
    type: "social",
    iconSize: 28,
    mode: "horizontal",
    items: [
      { platform: "instagram", href: "https://instagram.com/x", label: "Insta" },
      { platform: "tiktok", href: "https://tiktok.com/@x", iconSrc: "https://ex.example/tt.png" },
    ],
  },
  {
    id: "b-menu",
    type: "menu",
    separator: "|",
    style: { align: "left" },
    items: [
      { label: "Inicio", href: "https://ex.example/" },
      { label: "Fútbol", href: "https://ex.example/f" },
    ],
  },
  {
    id: "b-pick",
    type: "pick",
    matchLabel: "Colo-Colo — U. de Chile",
    kickoffLabel: "21:00",
    marketLabel: "Ganador",
    selectionLabel: "Colo-Colo",
    oddsLabel: "2.10",
    confidenceLabel: "Confianza alta",
    href: "https://ex.example/p",
    ctaLabel: "Apostar",
  },
  {
    id: "b-odds",
    type: "odds_table",
    caption: "Cuotas",
    rows: [
      { label: "Local", value: "1.80" },
      { label: "Visita", value: "4.20" },
    ],
  },
  {
    id: "b-standings",
    type: "standings",
    columns: ["Equipo", "Pts"],
    rows: [
      ["Colo-Colo", "40"],
      ["U. Católica", "38"],
    ],
  },
  {
    id: "b-scoreboard",
    type: "scoreboard",
    kicker: "Final",
    valueSize: 34,
    rows: [
      { label: "Rovers", value: "2", highlight: true },
      { label: "Leeds", value: "0", highlight: false },
    ],
    footerLabel: "What we learned ›",
    footerHref: "https://ex.example/s",
    footerNote: "Barry was the star.",
  },
  {
    id: "b-article",
    type: "article",
    layout: "side",
    title: "Nota lateral",
    excerpt: "Un resumen",
    href: "https://ex.example/n",
    imageSrc: "https://ex.example/n.jpg",
    imageAlt: "",
    kicker: "Noticias",
    kickerAccent: " · 21:42",
    meta: "Hace 2 h",
    metaSize: 15,
    ctaStyle: "link",
    ctaLabel: "LEER LA NOTA",
    ctaUnderline: 2,
  },
  {
    id: "b-section",
    type: "section_title",
    label: "Más noticias",
    rule: "after",
    ruleThickness: 3,
    style: { fontWeight: "900", textTransform: "uppercase" },
  },
  {
    id: "b-callout",
    type: "callout",
    kicker: "Partido del día",
    title: "Clásico",
    titleFont: "Georgia, serif",
    titleSize: 27,
    body: "Todo lo que hay que saber",
    href: "https://ex.example/c",
    ctaLabel: "Ver",
    ctaBackground: "#111111",
    ctaTextColor: "#EEEEEE",
    accentWidth: 4,
    innerPadding: { top: 21, right: 21, bottom: 21, left: 21 },
    imageSrc: "https://ex.example/c.jpg",
    imageAlt: "",
  },
  {
    id: "b-promo",
    type: "promo",
    headline: "Bono de bienvenida",
    body: "Hasta 100 €",
    code: "HOLA100",
    terms: "T&C aplican",
    href: "https://ex.example/pr",
    ctaLabel: "Reclamar",
  },
  {
    id: "b-feed",
    type: "article-feed",
    sourceId: "src-1",
    count: 3,
    leadCount: 1,
    showKicker: true,
    lead: { kickerMode: "text", kickerText: "Destacada", ctaStyle: "link", titleSize: 26 },
    card: { layout: "side", kickerMode: "category-time", ctaStyle: "none", metaMode: "time" },
    midSection: { label: "Más noticias", rule: "under", ruleColor: "#CC0000" },
    cardRule: { color: "#ABCDEF", thickness: 2 },
    previewItems: [item(1, "Noticias"), item(2, "Mercado"), item(3, "Noticias")],
    previewAt: "2026-09-22T12:00:00Z",
  },
  { id: "b-footer", type: "footer_legal" },
];

type RowInput = EmailDocInput["rows"][number];

function docAvec(blocs: BlockInput[]): EmailDocInput {
  const [text, image, ...reste] = blocs;
  const rows: RowInput[] = [
    {
      // Row à deux colonnes, padding de row ET de colonne, typo mobile héritée : tout ce qui décide
      // de la largeur utile d'un bloc et de ses classes générées.
      id: "row-2col",
      layout: "1-1",
      style: { padding: { top: 12, left: 6 }, fontSizeMobile: 14, backgroundColor: "#F0F0F0" },
      columns: [
        { id: "c-a", style: { padding: { left: 10, right: 4 } }, blocks: [text!] },
        {
          id: "c-b",
          style: { backgroundColor: "#FAFAFA", borderWidth: 1 },
          blocks: [{ ...image!, style: { hideOnMobile: true }, visibleIf: { token: "is_premium" } } as BlockInput],
        },
      ],
    },
    ...reste.map(
      (b, i): RowInput => ({ id: `row-${i}`, layout: "1", columns: [{ id: `col-${i}`, blocks: [b] }] }),
    ),
  ];
  return {
    schema: 2,
    meta: { subject: "Boletín", preheader: "Hoy", assetSlug: "copper-kettle", locale: "es" },
    theme: { blockPadding: { top: 9, right: 22, bottom: 9, left: 22 }, radius: 8 },
    rows,
  };
}

describe("fidélité bloc par bloc", () => {
  test("la liste couvre les 17 types de la palette plus le flux", () => {
    const types = new Set(BLOCS.map((b) => b.type));
    for (const t of BLOCK_TYPES) expect(types.has(t)).toBe(true);
    expect(types.has("article-feed")).toBe(true);
    expect(types.size).toBe(18);
  });

  test("chaque fragment du canvas est, mot pour mot, un morceau de l'e-mail compilé", async () => {
    const doc = docAvec(BLOCS);
    const vrai = norme((await compileDoc(doc)).html);
    const canvas = await renderCanvas(doc);

    expect(canvas.invalid).toEqual({});
    expect(Object.keys(canvas.blocks).sort()).toEqual(BLOCS.map((b) => b.id).sort());
    for (const b of BLOCS) {
      const fragment = norme(canvas.blocks[b.id]!.html);
      // Pas de fragment vide qui passerait trivialement le test d'inclusion.
      expect(fragment.length).toBeGreaterThan(30);
      if (!vrai.includes(fragment)) throw new Error(`le canvas diverge de l'e-mail sur ${b.type} (${b.id})`);
    }
  });

  // Chaque ligne nomme ce que l'ancien canvas dessinait faux, et le lit dans le fragment — donc dans
  // le HTML compilé, jamais dans une valeur recopiée ici.
  const temoins: [string, string, (html: string) => boolean][] = [
    ["text : la taille et la graisse du bloc", "b-text", (h) => h.includes("font-size:31px") && h.includes("font-weight:800")],
    ["image : rayon du thème, pas 4 px", "b-image", (h) => h.includes("border-radius:8px") && !h.includes("border-radius:4px")],
    ["button : fond de marque SUR le bouton, fond de Style sur la cellule", "b-button", (h) => /bgcolor="#E11D48"/i.test(h) && h.includes("#00AA00")],
    ["divider : les segments", "b-divider", (h) => h.includes("#FF0000") && h.includes("#0000FF")],
    ["spacer : la hauteur", "b-spacer", (h) => h.includes("height:37px")],
    ["html : rendu, pas cité", "b-html", (h) => h.includes('<p style="color:#123456">brut</p>')],
    ["social : icônes, pas des pastilles de texte", "b-social", (h) => h.includes("<img") && h.includes("https://ex.example/tt.png")],
    ["menu : aligné comme le compilateur, sans soulignement", "b-menu", (h) => h.includes("text-decoration:none") && !h.includes("underline")],
    ["pick", "b-pick", (h) => h.includes("Colo-Colo") && h.includes("2.10")],
    ["odds_table", "b-odds", (h) => h.includes("4.20")],
    ["standings", "b-standings", (h) => h.includes("U. Católica")],
    ["scoreboard : taille de valeur", "b-scoreboard", (h) => h.includes("34px")],
    ["article : taille de méta", "b-article", (h) => h.includes("15px") && h.includes("LEER LA NOTA")],
    ["section_title : graisse 900", "b-section", (h) => h.includes("900")],
    ["callout : police et taille du titre", "b-callout", (h) => h.includes("Georgia") && h.includes("27px") && h.includes("#111111")],
    ["promo : code", "b-promo", (h) => h.includes("HOLA100")],
    ["flux : une, section intercalée, filets", "b-feed", (h) => h.includes("Destacada") && h.includes("Más noticias") && h.includes("#ABCDEF") && h.includes("Titular 3")],
    ["footer_legal : le jeton que l'envoi remplit", "b-footer", (h) => h.includes("{{legal_footer_html}}")],
  ];
  for (const [nom, id, lu] of temoins) {
    test(nom, async () => {
      const canvas = await renderCanvas(docAvec(BLOCS));
      expect(lu(canvas.blocks[id]!.html)).toBe(true);
    });
  }

  test("la feuille de style est celle du head compilé, sans Outlook ni @import", async () => {
    const canvas = await renderCanvas(docAvec(BLOCS));
    expect(canvas.sheets).toHaveLength(1);
    const css = canvas.sheets[0]!;
    expect(css).toContain("a { text-decoration: none; }");
    expect(css).toContain("@media only screen and (max-width:600px)");
    expect(css).not.toContain("mj-outlook-group-fix");
    expect(css).not.toContain("@import");
  });
});

describe("le canvas lit le meta du document comme l'e-mail (23/09/2026)", () => {
  /** Un article sans libellé propre, un flux dont la une lit le libellé par défaut, un texte qui salue. */
  const docMeta = (meta: Record<string, unknown>): EmailDocInput => {
    const feed = BLOCS.find((b) => b.id === "b-feed")!;
    const row = (id: string, block: BlockInput): RowInput => ({ id: `r-${id}`, layout: "1", columns: [{ id: `c-${id}`, blocks: [block] }] });
    return {
      schema: 2,
      meta: { subject: "Boletín", preheader: "Hoy", assetSlug: "copper-kettle", locale: "es", ...meta },
      theme: {},
      rows: [
        row("art", { id: "b-art", type: "article", title: "Nota", excerpt: "", href: "https://ex.example/n", imageAlt: "", layout: "stacked" }),
        row("feed", feed),
        row("hola", { id: "b-hola", type: "text", preset: "body", paragraphs: [{ spans: [{ text: "Hola {{first_name}}" }] }] }),
      ],
    };
  };

  test("defaultCtaLabel : l'article et la une portent le libellé du MODÈLE, pas celui de la langue", async () => {
    const doc = docMeta({ defaultCtaLabel: "Seguir leyendo" });
    const vrai = norme((await compileDoc(doc)).html);
    // Contrôle : l'e-mail porte bien le libellé du modèle (sinon ce test ne mesurerait rien).
    expect(vrai).toContain("Seguir leyendo");
    expect(vrai).not.toContain("Leer la nota");
    const canvas = await renderCanvas(doc);
    for (const id of ["b-art", "b-feed"]) {
      const fragment = norme(canvas.blocks[id]!.html);
      expect({ id, modele: fragment.includes("Seguir leyendo"), langue: fragment.includes("Leer la nota") }).toEqual({
        id,
        modele: true,
        langue: false,
      });
      if (!vrai.includes(fragment)) throw new Error(`le canvas diverge de l'e-mail sur ${id}`);
    }
  });

  test("firstNameFallback : le repli du modèle est écrit dans le jeton, comme dans l'e-mail", async () => {
    const doc = docMeta({ firstNameFallback: "Ana" });
    expect((await compileDoc(doc)).html).toContain("{{first_name|Ana}}");
    const canvas = await renderCanvas(doc);
    expect(canvas.blocks["b-hola"]!.html).toContain("{{first_name|Ana}}");
  });

  test("sans réglage de meta : la langue décide, comme avant", async () => {
    const canvas = await renderCanvas(docMeta({}));
    expect(canvas.blocks["b-art"]!.html).toContain("Leer la nota");
  });
});

describe("robustesse", () => {
  test("un bloc invalide est suspendu, pas le canvas", async () => {
    // Copie profonde : `BLOCS` est partagé par tout le fichier.
    const doc = structuredClone(docAvec(BLOCS)) as { rows: { columns: { blocks: Record<string, unknown>[] }[] }[] };
    const bouton = doc.rows.flatMap((r) => r.columns.flatMap((c) => c.blocks)).find((b) => b.id === "b-button")!;
    bouton.href = "";
    const canvas = await renderCanvas(doc);
    expect(Object.keys(canvas.invalid)).toEqual(["b-button"]);
    expect(canvas.invalid["b-button"]![0]).toContain("href");
    expect(canvas.blocks["b-button"]).toBeUndefined();
    expect(canvas.blocks["b-promo"]).toBeDefined();
  });

  test("un thème invalide lève, avec ses motifs", async () => {
    const doc = { ...docAvec(BLOCS), theme: { radius: 999 } };
    await expect(renderCanvas(doc)).rejects.toBeInstanceOf(CanvasRenderError);
  });

  test("au-delà de 200 blocs, plusieurs passes, chacune sa feuille", async () => {
    const texte = (i: number): Block => ({
      id: `t${i}`,
      type: "text",
      preset: "body",
      paragraphs: [{ spans: [{ text: `Ligne ${i}` }] }],
    });
    const doc: EmailDocInput = {
      schema: 2,
      meta: { assetSlug: "x" },
      rows: Array.from({ length: 3 }, (_, r) => ({
        id: `r${r}`,
        layout: "1" as const,
        columns: [{ id: `c${r}`, blocks: Array.from({ length: 90 }, (_, b) => texte(r * 90 + b)) }],
      })),
    };
    const canvas = await renderCanvas(doc);
    expect(canvas.sheets).toHaveLength(2);
    expect(canvas.blocks.t0!.sheet).toBe(0);
    expect(canvas.blocks.t269!.sheet).toBe(1);
    expect(canvas.blocks.t269!.html).toContain("Ligne 269");
  });
});

describe("en-tête et pied de marque", () => {
  const rowMarque = (id: string, texte: string): Row =>
    EmailDoc.parse({
      schema: 2,
      meta: { assetSlug: "x" },
      rows: [
        {
          id,
          layout: "1",
          columns: [{ id: `${id}-c`, blocks: [{ id: `${id}-b`, type: "text", preset: "body", paragraphs: [{ spans: [{ text: texte }] }] }] }],
        },
      ],
    }).rows[0]!;

  test("les rows de la marque sont rendues et placées comme à l'envoi", async () => {
    const doc = docAvec(BLOCS);
    const canvas = await renderCanvas(
      { ...doc, meta: { ...doc.meta, headerPartialId: "11111111-1111-4111-8111-111111111111", footerPartialId: "11111111-1111-4111-8111-111111111112" } },
      { header: [rowMarque("h", "LOGO MARQUE")], footer: [rowMarque("f", "PIED MARQUE")] },
    );
    expect(canvas.header).toHaveLength(1);
    expect(canvas.footer).toHaveLength(1);
    const idEntete = canvas.header[0]!.columns[0]!.blocks[0]!.id;
    const idPied = canvas.footer[0]!.columns[0]!.blocks[0]!.id;
    // Les ids sont régénérés par `applyBrandPartials` : on lit les fragments par les rows rendues.
    expect(canvas.blocks[idEntete]!.html).toContain("LOGO MARQUE");
    expect(canvas.blocks[idPied]!.html).toContain("PIED MARQUE");
    expect(canvas.warnings).toEqual([]);
  });

  test("un pointeur sans rows fournies le dit", async () => {
    const doc = docAvec(BLOCS);
    const canvas = await renderCanvas({ ...doc, meta: { ...doc.meta, headerPartialId: "11111111-1111-4111-8111-111111111111" } });
    expect(canvas.header).toEqual([]);
    expect(canvas.warnings.join(" ")).toContain("brand header");
  });
});

describe("headCss", () => {
  test("garde ce qu'un navigateur lit, jette ce qui est réservé à Outlook", () => {
    const html = [
      "<html><head>",
      '<style type="text/css">p { margin:13px 0; }</style>',
      "<!--[if lte mso 11]><style>.mj-outlook-group-fix { width:100% !important; }</style><![endif]-->",
      '<!--[if !mso]><!--><link href="https://fonts.googleapis.com/css?family=Archivo" rel="stylesheet" type="text/css"><style type="text/css">@import url(https://fonts.googleapis.com/css?family=Archivo);</style><!--<![endif]-->',
      '<style media="screen and (min-width:480px)">.moz-text-html .x { width:50% }</style>',
      "</head><body><style>.corps { color:red }</style></body></html>",
    ].join("");
    const css = headCss(html);
    expect(css).toContain("p { margin:13px 0; }");
    expect(css).not.toContain("mj-outlook-group-fix");
    expect(css).not.toContain("@import");
    expect(css).not.toContain("fonts.googleapis");
    expect(css).toContain("@media screen and (min-width:480px) {\n.moz-text-html .x { width:50% }\n}");
    expect(css).not.toContain(".corps");
  });
});
