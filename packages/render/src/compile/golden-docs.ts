/**
 * DOCUMENTS DE RÉFÉRENCE du banc octet pour octet (`golden.test.ts`).
 *
 * ⛔ CES DOCUMENTS NE PORTENT AUCUN RÉGLAGE AJOUTÉ LE 22/09/2026, ET C'EST LEUR RAISON D'ÊTRE. Ils
 * décrivent ce qui existe en base : chaque type de bloc, chaque forme de lien de lecture, les flux
 * (une, brèves, titre de section, filets, surtitres horodatés), les conditions, les réglages mobiles,
 * le thème sombre. Leurs sorties HTML et texte ont été produites par le compilateur de `5311631`
 * (avant le chantier) et figées dans `__golden__/golden.json`. Le banc exige que le compilateur
 * courant les reproduise À L'OCTET : la preuve que les nouveaux réglages, absents, ne changent rien.
 *
 * ⚠️ Ce qui est VOLONTAIREMENT absent : un `{{first_name}}` dans une langue autre que l'anglais, un
 * modèle en allemand, un menu aligné à gauche — les trois correctifs délibérés du 22/09/2026, qui
 * changent la sortie et ont leurs propres bancs (`reglages.test.ts`).
 *
 * ⛔ Ne JAMAIS ajouter un réglage neuf ici, ni régénérer le fichier de référence avec le compilateur
 * courant : le banc comparerait alors le compilateur à lui-même, et ne garderait plus rien.
 */

type Json = Record<string, unknown>;

const txt = (id: string, text: string, extra: Json = {}): Json => ({
  id,
  type: "text",
  paragraphs: [{ spans: [{ text }] }],
  ...extra,
});

const row = (id: string, blocks: Json[], extra: Json = {}): Json => ({
  id,
  layout: "1",
  columns: [{ id: `${id}_c`, blocks }],
  ...extra,
});

const footer = row("r_footer", [{ id: "b_footer", type: "footer_legal" }]);

const ITEMS = (prefix: string): Json[] =>
  [1, 2, 3, 4, 5].map((i) => ({
    postId: String(100 + i),
    title: `${prefix} titulo ${i}`,
    excerpt: `Resumen ${i} con "comillas" & signos <b>no</b> HTML.`,
    href: `https://noticias.example.com/articulo-${i}`,
    ...(i === 4 ? {} : { imageSrc: `https://cdn.example.com/img-${i}.jpg` }),
    imageAlt: i === 2 ? "Foto del partido" : "",
    ...(i === 5 ? {} : { publishedAt: `2026-09-2${i}T1${i}:4${i}:00Z` }),
    ...(i === 3 ? {} : { category: i % 2 === 0 ? "Noticias" : "Destacadas" }),
  }));

/** Le châssis complet, en espagnol : tous les blocs, toutes les formes. */
const chassisEs: Json = {
  schema: 2,
  meta: {
    subject: "Boletín del día — {{edition_date}}",
    preheader: "Las noticias que importan hoy",
    assetSlug: "copper-kettle",
    locale: "es-CL",
  },
  theme: {
    bodyBackground: "#EDEDF2",
    contentBackground: "#FEFEFE",
    fontFamily: "Archivo, Arial, sans-serif",
    fontSize: 15,
    textColor: "#1A1A20",
    mutedColor: "#6B6B76",
    linkColor: "#C8102E",
    brandColor: "#C8102E",
    radius: 6,
    webFonts: [{ family: "Archivo", href: "https://fonts.googleapis.com/css2?family=Archivo:wght@400;700" }],
    darkBodyBackground: "#101014",
    darkContentBackground: "#16161C",
    darkTextColor: "#EDEDF2",
  },
  rows: [
    // Bandeau sombre sans texte : épinglé contre le thème sombre.
    row("r_head", [{ id: "b_logo", type: "image", src: "https://cdn.example.com/logo.png", alt: "Copper Kettle", widthPct: 40, href: "https://copper-kettle.example.com" }], {
      style: { backgroundColor: "#0D0D12", padding: { top: 16, bottom: 16 } },
    }),
    row("r_flag", [
      {
        id: "b_flag",
        type: "divider",
        thickness: 4,
        segments: [
          { color: "#0033A0", widthPct: 50 },
          { color: "#D52B1E", widthPct: 50 },
        ],
      },
    ]),
    row("r_menu", [
      { id: "b_menu", type: "menu", items: [{ label: "Fútbol", href: "https://copper-kettle.example.com/futbol" }, { label: "Copa", href: "https://copper-kettle.example.com/copa" }] },
      { id: "b_menu_r", type: "menu", separator: "|", items: [{ label: "Tabla", href: "https://copper-kettle.example.com/tabla" }], style: { align: "right", fontSize: 12 } },
    ]),
    row("r_textes", [
      txt("b_h1", "Titular principal"),
      { id: "b_h2", type: "text", preset: "h2", paragraphs: [{ spans: [{ text: "Subtítulo" }] }] },
      { id: "b_h3", type: "text", preset: "h3", paragraphs: [{ spans: [{ text: "Sección" }] }], style: { fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" } },
      {
        id: "b_body",
        type: "text",
        preset: "body",
        paragraphs: [
          {
            spans: [
              { text: "Texto con " },
              { text: "negrita", bold: true },
              { text: ", cursiva", italic: true },
              { text: ", subrayado", underline: true },
              { text: ", tachado", strike: true },
              { text: " y un ", color: "#0033A0" },
              { text: "enlace", href: "https://copper-kettle.example.com/nota?a=1&b=2" },
              { text: ".\nSegunda línea." },
            ],
          },
          { spans: [{ text: "Segundo párrafo." }] },
          { spans: [{ text: "Tercer párrafo." }] },
        ],
        style: { fontSizeMobile: 14, paddingMobile: { left: 12, right: 12 }, lineHeight: 1.6 },
      },
      { id: "b_small", type: "text", preset: "small", paragraphs: [{ spans: [{ text: "Letra chica." }] }], style: { textColor: "#6B6B76", align: "center" } },
    ]),
    row("r_boutons", [
      { id: "b_btn", type: "button", label: "Ver la tabla", href: "https://copper-kettle.example.com/tabla" },
      { id: "b_btn2", type: "button", label: "Suscribirse", href: "https://copper-kettle.example.com/s", align: "left", style: { fontSize: 18, borderRadius: 20, backgroundColor: "#F4F4F7" } },
      { id: "b_div", type: "divider", color: "#DDDDE3", thickness: 2, widthPct: 60, style: { align: "center" } },
      { id: "b_sp", type: "spacer", height: 24, heightMobile: 12 },
      { id: "b_html", type: "html", raw: '<table><tr><td style="color:#000000;background:#ffffff">HTML libre</td></tr></table>' },
    ]),
    row("r_social", [
      {
        id: "b_social",
        type: "social",
        items: [
          { platform: "facebook", href: "https://facebook.com/copper-kettle", label: "Facebook" },
          { platform: "tiktok", href: "https://tiktok.com/@copper-kettle" },
          { platform: "whatsapp", href: "https://wa.me/1", iconSrc: "https://cdn.example.com/wa.png", label: "WhatsApp" },
        ],
      },
    ]),
    row("r_sport", [
      {
        id: "b_pick",
        type: "pick",
        matchLabel: "Colo-Colo — U. de Chile",
        marketLabel: "Ambos marcan",
        selectionLabel: "Sí",
        oddsLabel: "1.85",
        kickoffLabel: "Domingo 18:00",
        confidenceLabel: "Confianza media",
        href: "https://copper-kettle.example.com/pick",
        ctaLabel: "Ver análisis",
      },
      { id: "b_pick2", type: "pick", matchLabel: "Audax — Palestino", marketLabel: "", selectionLabel: "Local", oddsLabel: "", style: { borderColor: "#0033A0", align: "center" } },
      { id: "b_odds", type: "odds_table", rows: [{ label: "Local", value: "2.10" }, { label: "Empate", value: "3.20" }, { label: "Visita", value: "3.60" }], caption: "Cuotas indicativas.\nPueden cambiar." },
      {
        id: "b_standings",
        type: "standings",
        columns: ["Equipo", "PJ", "Pts"],
        rows: [["Colo-Colo", "20", "45"], ["U. de Chile", "20", "41"], ["Audax", "19"]],
        caption: "Fecha 20.",
      },
      {
        id: "b_score",
        type: "scoreboard",
        kicker: "Resultado final",
        kickerColor: "#C8102E",
        rows: [
          { label: "Colo-Colo", value: "2", highlight: true },
          { label: "U. de Chile", value: "1" },
        ],
        footerLabel: "Lo que aprendimos ›",
        footerHref: "https://copper-kettle.example.com/cronica",
        footerNote: " — Una tarde redonda.",
        style: { backgroundColor: "#F4F4F7", borderRadius: 8 },
      },
      { id: "b_score2", type: "scoreboard", kicker: "", rows: [{ label: "A", value: "0" }, { label: "B", value: "0" }], footerNote: "Sin goles." },
    ]),
    row("r_articles", [
      { id: "b_st_after", type: "section_title", label: "Destacadas", ruleColor: "#C8102E" },
      {
        id: "b_art_stacked",
        type: "article",
        title: "Nota principal",
        excerpt: "Un chapeau.\nEn dos líneas.",
        imageSrc: "https://cdn.example.com/a.jpg",
        imageAlt: "",
        href: "https://copper-kettle.example.com/a",
        kicker: "Noticias",
        kickerAccent: " · 13:50",
        kickerAccentColor: "#FD4040",
        meta: "Por la redacción · ",
        metaAccent: "27 comentarios",
        titleLink: true,
        titleSize: 24,
        titleLineHeight: 1.1,
      },
      {
        id: "b_art_side",
        type: "article",
        layout: "side",
        imageWidthPct: 30,
        title: "Breve con vignette",
        excerpt: "Resumen.",
        imageSrc: "https://cdn.example.com/b.jpg",
        imageAlt: "",
        href: "https://copper-kettle.example.com/b",
        ctaLabel: "Leer más",
        ctaStyle: "link",
        ctaUnderline: 2,
        ctaColor: "#C8102E",
        ctaLetterSpacing: 1,
        ctaTransform: "uppercase",
        ctaFont: "Georgia, serif",
        kickerFont: "Georgia, serif",
        titleFont: "Georgia, serif",
        titleColor: "#0D0D12",
        titleWeight: "900",
        metaColor: "#888890",
        metaSize: 11,
        meta: "15:29",
      },
      { id: "b_art_link", type: "article", title: "Con enlace simple", excerpt: "", href: "https://copper-kettle.example.com/c", imageAlt: "", ctaLabel: "Leer", ctaStyle: "link" },
      { id: "b_art_none", type: "article", title: "Sin lectura", excerpt: "Nada debajo.", imageSrc: "https://cdn.example.com/d.jpg", imageAlt: "Foto", href: "https://copper-kettle.example.com/d", ctaStyle: "none", ctaLabel: "Ignorado" },
      { id: "b_art_default", type: "article", title: "Recibe el defecto de idioma", excerpt: "Texto.", href: "https://copper-kettle.example.com/e", imageAlt: "", style: { align: "center", fontSize: 14 } },
      { id: "b_art_nowhere", type: "article", title: "Enlace vacío", excerpt: "Texto.", href: "#", imageAlt: "" },
      { id: "b_art_side_narrow", type: "article", layout: "side", imageWidthPct: 60, title: "Columna estrecha", excerpt: "x", imageSrc: "https://cdn.example.com/f.jpg", imageAlt: "", href: "https://copper-kettle.example.com/f" },
    ]),
    {
      id: "r_narrow",
      layout: "1-2",
      columns: [
        { id: "r_narrow_a", blocks: [{ id: "b_narrow_side", type: "article", layout: "side", imageWidthPct: 60, title: "Estrecha", excerpt: "x", imageSrc: "https://cdn.example.com/g.jpg", imageAlt: "", href: "https://copper-kettle.example.com/g" }] },
        { id: "r_narrow_b", blocks: [txt("b_narrow_txt", "Columna ancha")], style: { verticalAlign: "middle", padding: { left: 8 } } },
      ],
    },
    row("r_flux", [
      {
        id: "b_feed_lead",
        type: "article-feed",
        sourceId: "src_1",
        sourceLabel: "Copper Kettle — racine",
        count: 5,
        minCount: 3,
        leadCount: 1,
        showKicker: true,
        timeZone: "America/Santiago",
        timeColor: "#FD4040",
        lead: { layout: "stacked", kickerMode: "text", kickerText: "Destacada", ctaStyle: "link", titleSize: 26, titleLink: true },
        card: { layout: "side", imageWidthPct: 28, kickerMode: "category-time", ctaStyle: "none", titleLink: true, metaMode: "time", style: { fontSize: 13 } },
        midSection: { label: "Más noticias", rule: "after", ruleColor: "#FF2F2F", ruleThickness: 3 },
        cardRule: { color: "#E0E0E6", thickness: 1, style: { padding: { top: 4, bottom: 4 } } },
        previewItems: ITEMS("Flujo"),
        previewAt: "2026-09-22T08:00:00Z",
      },
      { id: "b_st_under", type: "section_title", label: "Más", rule: "under", ruleThickness: 1 },
      {
        id: "b_feed_plain",
        type: "article-feed",
        sourceId: "src_2",
        count: 3,
        layout: "side",
        ctaLabel: "Seguir leyendo",
        showKicker: true,
        card: { kickerMode: "category" },
        previewItems: ITEMS("Plano"),
        visibleIf: { token: "is_premium" },
      },
      { id: "b_st_none", type: "section_title", label: "Sin filete", rule: "none", style: { fontSize: 20, textTransform: "uppercase" } },
      { id: "b_st_left", type: "section_title", label: "News", rule: "left", ruleThickness: 4, ruleColor: "#0033A0" },
    ]),
    row("r_encarts", [
      {
        id: "b_callout",
        type: "callout",
        kicker: "El partido del día",
        kickerColor: "#C8102E",
        title: "Colo-Colo recibe a la U",
        titleFont: "Georgia, serif",
        body: "Todo lo que hay que saber.",
        bodyColor: "#333338",
        bodyFont: "Arial, sans-serif",
        href: "https://copper-kettle.example.com/previa",
        ctaLabel: "Leer la previa",
        ctaBackground: "#0D0D12",
        accentColor: "#C8102E",
        accentWidth: 4,
        imageSrc: "https://cdn.example.com/p.jpg",
        imageAlt: "Estadio",
        style: { backgroundColor: "#F4F4F7", borderRadius: 10, borderWidth: 1, borderColor: "#E0E0E6" },
      },
      { id: "b_callout2", type: "callout", kicker: "", title: "", body: "Solo cuerpo.", innerPadding: { top: 10, bottom: 10 } },
      {
        id: "b_promo",
        type: "promo",
        headline: "Bono de bienvenida",
        body: "Duplicamos tu primer depósito.",
        code: "COPPERKETTLE100",
        terms: "Aplican términos y condiciones. +18.",
        href: "https://promo.example.com",
        ctaLabel: "Obtener",
      },
    ], { visibleIf: { token: "market", equals: "CL" } }),
    {
      id: "r_cols",
      layout: "1-1-1",
      style: { padding: { top: 8, bottom: 8 }, paddingMobile: { top: 0 }, fontSizeMobile: 13, hideOnMobile: false },
      columns: [
        { id: "c1", blocks: [txt("b_c1", "Uno")], visibleIf: { token: "has_first_name", exists: false } },
        { id: "c2", blocks: [txt("b_c2", "Dos", { visibleIf: { token: "locale", equals: "es" } })], style: { backgroundColor: "#F4F4F7", borderWidth: 1, hideOnMobile: true } },
        { id: "c3", blocks: [{ id: "b_c3", type: "image", src: "https://cdn.example.com/c3.png", alt: "Tres", align: "right", widthPct: 50 }] },
      ],
    },
    footer,
  ],
};

/** Portugais : un flux « une seule brève », un preheader, pas de titre de section. */
const fluxPt: Json = {
  schema: 2,
  meta: { subject: "Resumo da rodada", preheader: "", assetSlug: "quartz-tips", locale: "pt-BR" },
  theme: { brandColor: "#0B7A3B", linkColor: "#0B7A3B" },
  rows: [
    row("r_intro", [txt("b_intro", "Olá! Aqui está o resumo."), { id: "b_art_pt", type: "article", title: "Sem rótulo", excerpt: "Recebe o padrão.", href: "https://quartz-tips.example.com/x", imageAlt: "" }]),
    row("r_feed", [
      {
        id: "b_feed_pt",
        type: "article-feed",
        sourceId: "src_pt",
        count: 4,
        leadCount: 1,
        lead: { kickerMode: "text", kickerText: "Destaque" },
        midSection: { label: "Mais do dia", rule: "left" },
        previewItems: ITEMS("Rodada"),
      },
      { id: "b_feed_empty", type: "article-feed", sourceId: "src_vide", count: 3, minCount: 1, previewItems: [] },
    ]),
    footer,
  ],
};

/** Anglais : prénom, colonnes, conditions, masquage mobile, réglages de rangée. */
const colonnesEn: Json = {
  schema: 2,
  meta: {
    subject: "Hi {{first_name}}, your weekly picks",
    preheader: "Three picks for {{ first_name }} this week",
    assetSlug: "harbor-tech",
    locale: "en-GB",
  },
  theme: { contentWidth: 640, fontSize: 16, blockPadding: { top: 10, right: 20, bottom: 10, left: 20 }, rowPadding: { top: 4, bottom: 4 } },
  rows: [
    row("r_hello", [
      txt("b_hello", "Hi {{first_name}}, here is the week.", { visibleIf: { token: "has_first_name" } }),
      txt("b_hello2", "Hi {{first_name|friend}}!", { visibleIf: { token: "has_first_name", exists: false } }),
      { id: "b_raw_en", type: "html", raw: "<p>Raw for {{first_name}}</p>" },
    ]),
    {
      id: "r_21",
      layout: "2-1",
      style: { backgroundColor: "#F7F7FA", padding: { top: 12, right: 12, bottom: 12, left: 12 }, paddingMobile: { left: 4, right: 4 }, align: "center" },
      columns: [
        {
          id: "c21a",
          blocks: [
            { id: "b_en_art", type: "article", title: "Rovers sign a striker", excerpt: "Deal done.", href: "https://harbor-tech.example.com/news/1", imageSrc: "https://cdn.example.com/e.jpg", imageAlt: "", layout: "side", ctaLabel: "Read and comment", ctaStyle: "button" },
            { id: "b_en_art2", type: "article", title: "Match report", excerpt: "A draw.", href: "https://harbor-tech.example.com/news/2", imageAlt: "" },
          ],
        },
        { id: "c21b", blocks: [{ id: "b_en_btn", type: "button", label: "Subscribe", href: "https://harbor-tech.example.com/s", style: { hideOnMobile: true } }] },
      ],
    },
    {
      id: "r_1111",
      layout: "1-1-1-1",
      columns: ["a", "b", "c", "d"].map((k) => ({ id: `c4${k}`, blocks: [txt(`b4${k}`, k.toUpperCase(), { style: { align: "center", fontSizeMobile: 12 } })] })),
    },
    row("r_menu_en", [{ id: "b_menu_en", type: "menu", items: [{ label: "News", href: "https://harbor-tech.example.com/news" }], style: { align: "center" } }]),
    footer,
  ],
};

/** Français, italien et suédois : les libellés par défaut de trois autres langues. */
const langue = (locale: string, slug: string): Json => ({
  schema: 2,
  meta: { subject: `Édition ${locale}`, preheader: `Preheader ${locale}`, assetSlug: slug, locale },
  theme: {},
  rows: [
    row("r_l", [
      { id: "b_l1", type: "article", title: "Article", excerpt: "Texte.", href: "https://example.org/a", imageAlt: "" },
      { id: "b_l2", type: "article", title: "Avec vignette", excerpt: "Texte.", href: "https://example.org/b", imageSrc: "https://example.org/b.jpg", imageAlt: "" },
    ]),
    footer,
  ],
});

/** Le plus petit document publiable : un pied légal. */
const minimal: Json = {
  schema: 2,
  meta: { subject: "", preheader: "", assetSlug: "vide", locale: "en" },
  theme: {},
  rows: [footer],
};

export const GOLDEN_DOCS: Readonly<Record<string, Json>> = {
  "chassis-es": chassisEs,
  "flux-pt": fluxPt,
  "colonnes-en": colonnesEn,
  "langue-fr": langue("fr-BE", "demo-fr"),
  "langue-it": langue("it", "demo-it"),
  "langue-sv": langue("sv", "demo-sv"),
  minimal,
};
