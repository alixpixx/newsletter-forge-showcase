/**
 * BANCS DES RÉGLAGES DU 22/09/2026 — « tout ce que l'abonné reçoit se règle dans le builder ».
 *
 * Le banc octet pour octet (`golden.test.ts`) prouve qu'un réglage ABSENT ne change rien. Celui-ci
 * prouve l'autre moitié, pour CHAQUE entrée du manifeste (`new-props-2026-09-22.ts`) :
 *   1. la clé existe dans le schéma, au chemin annoncé, avec les bornes annoncées ;
 *   2. posée, elle CHANGE ce qui part (HTML ou texte) — une clé acceptée mais ignorée par le
 *      compilateur est exactement le défaut que la règle d'Alix interdit ;
 *   3. posée À SA VALEUR PAR DÉFAUT, elle ne change RIEN — sinon l'inspecteur afficherait un défaut
 *      faux, et « remettre la valeur par défaut » modifierait l'envoi.
 * Les cas sont DÉRIVÉS du manifeste : une entrée ajoutée sans effet rougit ici sans qu'on ait à y
 * penser. Suivent les correctifs délibérés (menu à gauche, allemand, repli du prénom, `ctaStyle:
 * "none"`, plusieurs unes, heure 12 h, version texte).
 *
 * Contre-épreuves faites le 22/09/2026 (mutants) : `buttonBackground` ignoré par le compilateur ⇒
 * « button:buttonBackground » rouge ; garde `ctaStyle === "none"` retirée de `articleHtml` ⇒ les
 * bancs `ctaStyle: "none"` rouges.
 */
import { describe, expect, test } from "bun:test";
import { compileDoc, type CompileResult } from "./index";
import { NEW_PROPS_2026_09_22, newPropKey, type NewPropSpec } from "../new-props-2026-09-22";
import * as S from "../schema";
import { defaultArticleCta } from "../cta";
import { feedCards } from "../feed";
import { defaultFirstName, hydrateText } from "../hydrate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/* ------------------------------------------------------------------ *
 * Le document de banc : chaque bloc réglable, rempli pour que chaque réglage ait prise
 * (un pick sans bouton ne montrerait jamais `ctaBackground`).
 * ------------------------------------------------------------------ */

const p = (text: string): Json => ({ spans: [{ text }] });
const row = (id: string, blocks: Json[], extra: Json = {}): Json => ({ id, layout: "1", columns: [{ id: `${id}_c`, blocks }], ...extra });

const items = (n = 5): Json[] =>
  Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return {
      postId: String(200 + i),
      title: `Titre ${i}`,
      excerpt: `Chapeau ${i}.`,
      href: `https://news.example.com/a-${i}`,
      imageSrc: `https://cdn.example.com/i-${i}.jpg`,
      imageAlt: "",
      publishedAt: `2026-09-21T13:4${i}:00Z`,
      category: "Sport",
    };
  });

function baseDoc(): Json {
  return {
    schema: 2,
    meta: { subject: "Sujet pour {{first_name}}", preheader: "Le preheader du jour", assetSlug: "banc", locale: "en" },
    theme: {
      bodyBackground: "#EDEDF2",
      contentBackground: "#FEFEFE",
      fontFamily: "Arial, sans-serif",
      fontSize: 15,
      textColor: "#1A1A20",
      mutedColor: "#6B6B76",
      linkColor: "#C8102E",
      brandColor: "#C8102E",
      radius: 6,
      darkBodyBackground: "#101014",
      darkContentBackground: "#16161C",
      darkTextColor: "#EDEDF2",
    },
    rows: [
      // Bandeau sombre sans texte : c'est lui que `pinDarkRows` épingle.
      row("r_band", [{ id: "b_logo", type: "image", src: "https://cdn.example.com/logo.png", alt: "Logo" }], { style: { backgroundColor: "#0D0D12" } }),
      row("r_txt", [
        { id: "b_h1", type: "text", preset: "h1", paragraphs: [p("Titre h1")] },
        { id: "b_h2", type: "text", preset: "h2", paragraphs: [p("Titre h2")] },
        { id: "b_h3", type: "text", preset: "h3", paragraphs: [p("Titre h3")] },
        { id: "b_text", type: "text", preset: "body", paragraphs: [p("Bonjour {{first_name}}."), p("Second paragraphe.")] },
        { id: "b_small", type: "text", preset: "small", paragraphs: [p("Petit texte.")] },
        // Du HTML brut aux couleurs pures : c'est lui que `neutralizePureColors` réécrit.
        { id: "b_html", type: "html", raw: '<table><tr><td style="color:#000000;background:#ffffff">brut</td></tr></table>' },
        { id: "b_button", type: "button", label: "Go", href: "https://example.com/go" },
        { id: "b_divider", type: "divider", color: "#DDDDE3", thickness: 2, widthPct: 60 },
        {
          id: "b_social",
          type: "social",
          items: [
            { platform: "facebook", href: "https://facebook.com/banc", label: "Facebook" },
            { platform: "tiktok", href: "https://tiktok.com/@banc", label: "TikTok" },
          ],
        },
        { id: "b_menu", type: "menu", separator: "|", items: [{ label: "News", href: "https://example.com/n" }, { label: "Sport", href: "https://example.com/s" }] },
      ]),
      row("r_sport", [
        {
          id: "b_pick",
          type: "pick",
          matchLabel: "A — B",
          marketLabel: "Both teams score",
          selectionLabel: "Yes",
          oddsLabel: "1.85",
          kickoffLabel: "Sunday 18:00",
          confidenceLabel: "Medium confidence",
          href: "https://example.com/pick",
          ctaLabel: "See the pick",
        },
        { id: "b_odds", type: "odds_table", rows: [{ label: "Home", value: "2.10" }, { label: "Draw", value: "3.20" }], caption: "Indicative odds." },
        { id: "b_standings", type: "standings", columns: ["Team", "P", "Pts"], rows: [["A", "20", "45"], ["B", "20", "41"]], caption: "Round 20." },
        {
          id: "b_score",
          type: "scoreboard",
          kicker: "Full time",
          rows: [
            { label: "A", value: "2", highlight: true },
            { label: "B", value: "1" },
          ],
          footerLabel: "What we learned",
          footerHref: "https://example.com/report",
          footerNote: " — a fine evening.",
        },
      ]),
      row("r_art", [
        { id: "b_section", type: "section_title", label: "Top stories" },
        {
          id: "b_article",
          type: "article",
          layout: "side",
          title: "A side article",
          excerpt: "Its excerpt.",
          imageSrc: "https://cdn.example.com/a.jpg",
          imageAlt: "",
          href: "https://example.com/a",
          kicker: "News",
          meta: "By the desk",
          ctaLabel: "Read it",
        },
      ]),
      row("r_feed", [
        {
          id: "b_feed",
          type: "article-feed",
          sourceId: "src_banc",
          count: 5,
          leadCount: 1,
          showKicker: true,
          timeZone: "UTC",
          lead: { layout: "side", kickerMode: "category-time", metaMode: "time" },
          card: { layout: "side", kickerMode: "category-time", metaMode: "time" },
          midSection: { label: "More news" },
          cardRule: { color: "#E0E0E6", thickness: 1 },
          previewItems: items(),
          previewAt: "2026-09-22T08:00:00Z",
        },
      ]),
      row("r_encarts", [
        {
          id: "b_callout",
          type: "callout",
          kicker: "Match of the day",
          title: "A hosts B",
          titleFont: "Georgia, serif",
          body: "All you need to know.",
          href: "https://example.com/preview",
          ctaLabel: "Read the preview",
        },
        {
          id: "b_promo",
          type: "promo",
          headline: "Welcome bonus",
          body: "We double your first deposit.",
          code: "BANC100",
          terms: "T&Cs apply. 18+.",
          href: "https://promo.example.com",
          ctaLabel: "Claim",
        },
      ]),
      row("r_footer", [{ id: "b_footer", type: "footer_legal" }]),
    ],
  };
}

/** Le bloc que chaque cible règle dans `baseDoc`. */
const BLOCK_OF: Readonly<Record<string, string>> = {
  text: "b_text",
  button: "b_button",
  divider: "b_divider",
  social: "b_social",
  menu: "b_menu",
  pick: "b_pick",
  odds_table: "b_odds",
  standings: "b_standings",
  scoreboard: "b_score",
  article: "b_article",
  "article-feed": "b_feed",
  section_title: "b_section",
  callout: "b_callout",
  promo: "b_promo",
};

function findBlock(doc: Json, id: string): Json {
  for (const r of doc.rows) for (const c of r.columns) for (const b of c.blocks) if (b.id === id) return b;
  throw new Error(`bloc introuvable : ${id}`);
}

/** L'objet que règle une cible : le thème, la méta, un bloc, ou le look `card`/`lead` du flux. */
function targetOf(doc: Json, target: string): Json {
  if (target === "theme") return doc.theme;
  if (target === "meta") return doc.meta;
  if (target === "article-feed.card" || target === "article-feed.lead") {
    const feed = findBlock(doc, "b_feed");
    const cle = target.endsWith("card") ? "card" : "lead";
    feed[cle] ??= {};
    return feed[cle];
  }
  const id = BLOCK_OF[target];
  if (id === undefined) throw new Error(`cible sans bloc de banc : ${target}`);
  return findBlock(doc, id);
}

function setPath(obj: Json, path: string, value: unknown): void {
  const segs = path.split(".");
  let o = obj;
  for (const s of segs.slice(0, -1)) o = o[s] ??= {};
  o[segs[segs.length - 1] as string] = value;
}

function deletePath(obj: Json, path: string): void {
  const segs = path.split(".");
  let o: Json | undefined = obj;
  for (const s of segs.slice(0, -1)) o = o?.[s];
  if (o) delete o[segs[segs.length - 1] as string];
}

const COLOR = "#12A4C7";
const WORD = "Zz-sample";
const FONT = "Courier New, monospace";

/** Une valeur valide et DIFFÉRENTE du défaut, tirée des bornes du manifeste. */
function sample(spec: NewPropSpec): unknown {
  switch (spec.kind) {
    case "color":
      return COLOR;
    case "boolean":
      return !(spec.default as boolean);
    case "enum":
      return (spec.options as readonly string[]).find((o) => o !== spec.default);
    case "string":
      return spec.path === "kickerSeparator" ? " | " : WORD;
    case "font":
      return FONT;
    case "spacing":
      return { top: 33, right: 7, bottom: 33, left: 7 };
    case "number":
      return spec.default === spec.max ? spec.min : spec.max;
    case "images":
      return [{ src: "https://cdn.example.com/zz-1.jpg", alt: WORD }];
  }
}

/** Les réglages d'une mise en page n'ont prise que sous elle : on pose la mise en page qui les lit. */
const underLayout =
  (layout: string, extra: Json = {}) =>
  (doc: Json): void => {
    Object.assign(findBlock(doc, "b_callout"), { layout, ...extra });
  };

/** Réglage à poser AVANT la mesure, des deux côtés : le contexte sans lequel la clé n'a pas prise. */
const PREPARE: Readonly<Record<string, (doc: Json) => void>> = {
  // Le titre de section sans une : il faut un flux SANS une pour que la clé ait prise.
  "article-feed:midSection.showWithoutLead": (doc) => {
    findBlock(doc, "b_feed").leadCount = 0;
  },
  // Encart à mise en page (23/09/2026). La photo est posée là où le cadrage n'a d'effet qu'avec elle.
  "callout:backgroundImage": underLayout("poster"),
  "callout:backgroundPosition": underLayout("poster", { backgroundImage: "https://cdn.example.com/bg.jpg" }),
  "callout:minHeight": underLayout("poster"),
  "callout:contentVAlign": underLayout("poster"),
  "callout:kickerStyle": underLayout("poster"),
  "callout:kickerAccent": underLayout("poster", { kickerStyle: "dot" }),
  "callout:playBackground": underLayout("player"),
  "callout:playColor": underLayout("player"),
  "callout:progress": underLayout("player"),
  "callout:progressColor": underLayout("player"),
  "callout:progressTrackColor": underLayout("player"),
  "callout:waveSeed": underLayout("wave"),
  "callout:stubBackground": underLayout("ticket"),
  "callout:stubTextColor": underLayout("ticket"),
  "callout:gallery": underLayout("gallery"),
  "callout:ctaFullWidth": underLayout("poster"),
};

const compile = (doc: Json): Promise<CompileResult> => compileDoc(doc as never);
const MJML_ATTR = /illegal|attribute/i;

const base = await compile(baseDoc());

/* ------------------------------------------------------------------ *
 * 1. Manifeste ↔ schéma
 * ------------------------------------------------------------------ */

const SCHEMA_OF: Readonly<Record<string, unknown>> = {
  theme: S.Theme,
  meta: S.Meta,
  text: S.TextBlock,
  button: S.ButtonBlock,
  divider: S.DividerBlock,
  social: S.SocialBlock,
  menu: S.MenuBlock,
  pick: S.PickBlock,
  odds_table: S.OddsTableBlock,
  standings: S.StandingsBlock,
  scoreboard: S.ScoreboardBlock,
  article: S.ArticleBlock,
  "article-feed": S.ArticleFeedBlock,
  "article-feed.card": S.ArticleLook,
  "article-feed.lead": S.ArticleLook,
  section_title: S.SectionTitleBlock,
  callout: S.CalloutBlock,
  promo: S.PromoBlock,
};

// Navigation dans les définitions Zod 4 (`_zod.def`) : optionnel/défaut/pipe dépliés.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = any;
function unwrap(s: AnySchema): AnySchema {
  for (;;) {
    const t = s?._zod?.def?.type;
    if (t === "optional" || t === "default" || t === "nullable" || t === "prefault" || t === "readonly" || t === "catch") s = s._zod.def.innerType;
    else if (t === "pipe") s = s._zod.def.in;
    else return s;
  }
}
function fieldAt(schema: AnySchema, path: string): AnySchema | undefined {
  let s = unwrap(schema);
  for (const seg of path.split(".")) {
    const def = s?._zod?.def;
    if (def?.type === "object") s = def.shape[seg];
    else if (def?.type === "record") s = (S.TEXT_PRESETS as readonly string[]).includes(seg) ? def.valueType : undefined;
    else return undefined;
    if (s === undefined) return undefined;
    s = unwrap(s);
  }
  return s;
}

const ok = (s: AnySchema, v: unknown): boolean => s.safeParse(v).success;

describe("manifeste des réglages ↔ schéma", () => {
  test("chaque entrée est unique, porte une indication anglaise et une cible connue", () => {
    const cles = NEW_PROPS_2026_09_22.map(newPropKey);
    expect(new Set(cles).size).toBe(cles.length);
    for (const spec of NEW_PROPS_2026_09_22) {
      expect(SCHEMA_OF[spec.target]).toBeDefined();
      expect(spec.hint.length).toBeGreaterThan(8);
      if (spec.kind === "enum") expect(spec.options?.includes(String(spec.default)) || spec.computed === true).toBe(true);
    }
  });

  for (const spec of NEW_PROPS_2026_09_22) {
    test(`${newPropKey(spec)} existe avec le type et les bornes annoncés`, () => {
      const field = fieldAt(SCHEMA_OF[spec.target], spec.path);
      if (field === undefined) throw new Error(`${newPropKey(spec)} absent du schéma`);
      const type = field._zod.def.type as string;
      switch (spec.kind) {
        case "number":
          expect(type).toBe("number");
          expect(ok(field, spec.min)).toBe(true);
          expect(ok(field, spec.max)).toBe(true);
          expect(ok(field, (spec.min as number) - 1)).toBe(false);
          expect(ok(field, (spec.max as number) + 1)).toBe(false);
          break;
        case "enum":
          expect(type).toBe("enum");
          expect([...field.options].sort()).toEqual([...(spec.options as readonly string[])].sort());
          break;
        case "boolean":
          expect(type).toBe("boolean");
          break;
        case "color":
          expect(ok(field, COLOR)).toBe(true);
          expect(ok(field, "red")).toBe(false);
          break;
        case "string":
        case "font":
          expect(type).toBe("string");
          if (spec.max !== undefined) {
            expect(ok(field, "x".repeat(spec.max))).toBe(true);
            expect(ok(field, "x".repeat(spec.max + 1))).toBe(false);
          }
          if (spec.min !== undefined && spec.min > 0) expect(ok(field, "x".repeat(spec.min - 1))).toBe(false);
          break;
        case "spacing":
          expect(type).toBe("object");
          expect(ok(field, { top: spec.max })).toBe(true);
          expect(ok(field, { top: (spec.max as number) + 1 })).toBe(false);
          expect(ok(field, { top: (spec.min as number) - 1 })).toBe(false);
          break;
        case "images": {
          // `min`/`max` comptent des cases : `max` passe, une de plus non, une de moins que `min` non.
          const tiles = (n: number) => Array.from({ length: n }, (_, i) => ({ src: `https://cdn.example.com/${i}.jpg`, alt: "x" }));
          expect(type).toBe("array");
          expect(ok(field, tiles(spec.max as number))).toBe(true);
          expect(ok(field, tiles((spec.max as number) + 1))).toBe(false);
          expect(ok(field, tiles((spec.min as number) - 1))).toBe(false);
          break;
        }
      }
      // Le défaut littéral doit être une valeur que le schéma accepte : c'est ce que l'inspecteur
      // affichera, et ce qu'un « réinitialiser » pourrait écrire.
      if (spec.computed !== true && spec.kind !== "spacing") expect(ok(field, spec.default)).toBe(true);
    });
  }
});

/* ------------------------------------------------------------------ *
 * 2 et 3. Chaque réglage : posé, il change la sortie ; posé à son défaut, il n'en change rien.
 * ------------------------------------------------------------------ */

describe("chaque réglage du manifeste a prise sur ce qui part", () => {
  for (const spec of NEW_PROPS_2026_09_22) {
    const key = newPropKey(spec);
    test(`${key} : posé, la sortie change`, async () => {
      const prepare = PREPARE[key];
      const avant = prepare === undefined ? base : await compile((() => { const d = baseDoc(); prepare(d); return d; })());
      const doc = baseDoc();
      prepare?.(doc);
      const valeur = sample(spec);
      setPath(targetOf(doc, spec.target), spec.path, valeur);
      const apres = await compile(doc);
      expect(apres.html !== avant.html || apres.text !== avant.text).toBe(true);
      // La valeur elle-même doit se retrouver dans ce qui part, quand elle est lisible telle quelle.
      if (spec.kind === "color") expect(apres.html.toLowerCase()).toContain(COLOR.toLowerCase());
      if (spec.kind === "font") expect(apres.html).toContain("Courier New");
      if (spec.kind === "string" && valeur === WORD) expect(apres.html.includes(WORD) || apres.text.includes(WORD)).toBe(true);
      // Aucun attribut MJML refusé de plus que sans le réglage.
      expect(apres.warnings.filter((w) => MJML_ATTR.test(w)).length).toBe(avant.warnings.filter((w) => MJML_ATTR.test(w)).length);
    });

    if (spec.computed === true || spec.kind === "spacing") continue;
    test(`${key} : posé à son défaut (${JSON.stringify(spec.default)}), rien ne change`, async () => {
      // Référence = la clé ABSENTE (le document de banc en pose parfois une, comme `leadCount`).
      const sans = baseDoc();
      PREPARE[key]?.(sans);
      deletePath(targetOf(sans, spec.target), spec.path);
      const avec = baseDoc();
      PREPARE[key]?.(avec);
      setPath(targetOf(avec, spec.target), spec.path, spec.default);
      const [a, b] = await Promise.all([compile(sans), compile(avec)]);
      expect(b.html).toBe(a.html);
      expect(b.text).toBe(a.text);
    });
  }

  test("tous les réglages posés ensemble : le document compile, sans attribut MJML refusé", async () => {
    const doc = baseDoc();
    for (const spec of NEW_PROPS_2026_09_22) setPath(targetOf(doc, spec.target), spec.path, sample(spec));
    const out = await compile(doc);
    expect(out.html.length).toBeGreaterThan(1000);
    expect(out.warnings.filter((w) => MJML_ATTR.test(w))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Correctifs délibérés et formes nouvelles
 * ------------------------------------------------------------------ */

/** Un document minimal autour de quelques blocs. */
function docWith(blocks: Json[], meta: Json = {}): Json {
  const d = baseDoc();
  d.meta = { ...d.meta, ...meta };
  d.rows = [row("r_only", blocks), row("r_footer", [{ id: "b_footer", type: "footer_legal" }])];
  return d;
}

// La version texte écrit les libellés de lecture en capitales (« WEITERLESEN: url ») : un
// `not.toContain` sensible à la casse y passerait toujours, et ne garderait rien.
const has = (s: string, x: string): boolean => s.toLowerCase().includes(x.toLowerCase());
const count = (s: string, x: string): number => s.toLowerCase().split(x.toLowerCase()).length - 1;

describe("menu : un alignement à gauche POSÉ est respecté (correctif 70)", () => {
  const menu = (style?: Json): Json => ({
    id: "b_menu",
    type: "menu",
    separator: "|",
    items: [{ label: "News", href: "https://example.com/n" }],
    ...(style ? { style } : {}),
  });

  test("absent = centré comme avant ; « left » posé ≠ centré", async () => {
    const [absent, centre, gauche] = await Promise.all([
      compile(docWith([menu()])),
      compile(docWith([menu({ align: "center" })])),
      compile(docWith([menu({ align: "left" })])),
    ]);
    expect(absent.html).toBe(centre.html);
    expect(gauche.html).not.toBe(centre.html);
    expect(gauche.html).toContain("text-align:left");
  });
});

describe("libellé de lecture par défaut : allemand (84) et libellé du modèle", () => {
  const article = (extra: Json = {}): Json => ({ id: "b_a", type: "article", title: "T", excerpt: "E.", href: "https://example.com/a", imageAlt: "", ...extra });

  test("defaultArticleCta : allemand, langue inconnue, libellé du modèle, libellé blanc ignoré", () => {
    expect(defaultArticleCta("de")).toBe("Weiterlesen");
    expect(defaultArticleCta("de-AT")).toBe("Weiterlesen");
    expect(defaultArticleCta("xx")).toBe(defaultArticleCta("en"));
    expect(defaultArticleCta("de", "Mehr lesen")).toBe("Mehr lesen");
    expect(defaultArticleCta("de", "   ")).toBe("Weiterlesen");
  });

  test("un modèle allemand reçoit « Weiterlesen », en HTML et en texte", async () => {
    const out = await compile(docWith([article()], { locale: "de" }));
    expect(out.html).toContain(">Weiterlesen</a>");
    expect(has(out.text, "Weiterlesen: https://example.com/a")).toBe(true);
  });

  test("meta.defaultCtaLabel remplace le défaut de langue, jamais un libellé saisi", async () => {
    const out = await compile(docWith([article(), article({ id: "b_b", ctaLabel: "Saisi" })], { locale: "fr", defaultCtaLabel: "Lire la suite" }));
    expect(out.html).toContain("Lire la suite");
    expect(out.html).toContain("Saisi");
    expect(out.html).not.toContain(defaultArticleCta("fr"));
  });
});

describe("ctaStyle « none » retire le lien de lecture PARTOUT (85)", () => {
  const LABEL = "Ignorado";

  test("article saisi à la main, libellé compris : ni en HTML ni en texte", async () => {
    const out = await compile(
      docWith([{ id: "b_a", type: "article", title: "T", excerpt: "E.", href: "https://example.com/a", imageAlt: "", ctaStyle: "none", ctaLabel: LABEL }]),
    );
    expect(has(out.html, LABEL)).toBe(false);
    expect(has(out.text, LABEL)).toBe(false);
    // L'article reste atteignable en texte : son lien passe sous le titre.
    expect(out.text).toContain("https://example.com/a");
    // Témoin : le même article en forme `link` montre bien son libellé — le banc sait le voir.
    const temoin = await compile(
      docWith([{ id: "b_a", type: "article", title: "T", excerpt: "E.", href: "https://example.com/a", imageAlt: "", ctaStyle: "link", ctaLabel: LABEL }]),
    );
    expect(has(temoin.html, LABEL) && has(temoin.text, LABEL)).toBe(true);
  });

  test("article sans libellé : le défaut de langue n'est pas posé", async () => {
    const out = await compile(docWith([{ id: "b_a", type: "article", title: "T", excerpt: "E.", href: "https://example.com/a", imageAlt: "", ctaStyle: "none" }]));
    expect(has(out.html, defaultArticleCta("en"))).toBe(false);
    expect(has(out.text, defaultArticleCta("en"))).toBe(false);
  });

  const feed = (extra: Json): Json => ({
    id: "b_feed",
    type: "article-feed",
    sourceId: "src_banc",
    count: 3,
    leadCount: 1,
    previewItems: items(3),
    ...extra,
  });

  test("flux : ctaStyle « none » au niveau du flux retire le lien de TOUTES les cartes", async () => {
    const out = await compile(docWith([feed({ ctaStyle: "none", ctaLabel: LABEL })]));
    expect(has(out.html, LABEL)).toBe(false);
    expect(has(out.text, LABEL)).toBe(false);
    expect(has(out.html, defaultArticleCta("en"))).toBe(false);
    expect(has(out.text, defaultArticleCta("en"))).toBe(false);
  });

  // Le HTML et le texte ont chacun leur garde ; le DÉPLIAGE doit tenir seul, parce que le canvas de
  // l'éditeur le lit sans passer par le compilateur (contre-épreuve du 22/09/2026 : garde retirée de
  // `withDefaultCta` ⇒ HTML et texte restaient verts, seul ce banc rougissait).
  test("dépliage : aucune carte « none » ne reçoit le libellé par défaut", () => {
    const cards = feedCards(S.ArticleFeedBlock.parse(feed({ ctaStyle: "none" })), "en");
    expect(cards.filter((b) => b.type === "article").length).toBe(3);
    expect(cards.filter((b) => b.type === "article" && b.ctaLabel !== undefined)).toEqual([]);
  });

  test("flux : un look l'emporte sur le flux, dans les deux sens", async () => {
    const out = await compile(docWith([feed({ ctaStyle: "none", ctaLabel: LABEL, lead: { ctaStyle: "button" } })]));
    // La une seule garde son bouton.
    expect(count(out.html, LABEL)).toBe(1);
    expect(count(out.text, LABEL)).toBe(1);
    const inverse = await compile(docWith([feed({ ctaLabel: LABEL, card: { ctaStyle: "none" } })]));
    expect(count(inverse.html, LABEL)).toBe(1);
    expect(count(inverse.text, LABEL)).toBe(1);
  });
});

describe("flux : plusieurs unes, titre de section sans une, heure 12 h, séparateur (86-89)", () => {
  const LEAD = "#AA0011";
  const block = (extra: Json): S.ArticleFeedBlock =>
    S.ArticleFeedBlock.parse({
      id: "b_feed",
      type: "article-feed",
      sourceId: "src_banc",
      count: 5,
      lead: { titleColor: LEAD },
      midSection: { label: "More news" },
      previewItems: items(),
      ...extra,
    });
  const kinds = (blocks: S.Block[]): string[] =>
    blocks.map((b) => (b.type === "article" ? (b.titleColor === LEAD ? "une" : "breve") : b.type));

  test("leadCount 0, 1, 2, 3 : autant de unes, puis le titre de section, puis les brèves", () => {
    expect(kinds(feedCards(block({}), "en"))).toEqual(["breve", "breve", "breve", "breve", "breve"]);
    expect(kinds(feedCards(block({ leadCount: 1 }), "en"))).toEqual(["une", "section_title", "breve", "breve", "breve", "breve"]);
    expect(kinds(feedCards(block({ leadCount: 2 }), "en"))).toEqual(["une", "une", "section_title", "breve", "breve", "breve"]);
    expect(kinds(feedCards(block({ leadCount: 3 }), "en"))).toEqual(["une", "une", "une", "section_title", "breve", "breve"]);
  });

  test("showWithoutLead : sans une, le titre de section passe au-dessus de la première carte", () => {
    const b = block({ midSection: { label: "More news", showWithoutLead: true } });
    expect(kinds(feedCards(b, "en"))).toEqual(["section_title", "breve", "breve", "breve", "breve", "breve"]);
  });

  test("filet entre brèves : jamais avant la première, même avec plusieurs unes", () => {
    const b = block({ leadCount: 2, cardRule: { widthPct: 50, lineStyle: "dotted" } });
    expect(kinds(feedCards(b, "en"))).toEqual(["une", "une", "section_title", "breve", "divider", "breve", "divider", "breve"]);
  });

  test("timeFormat 12h et kickerSeparator, dans le surtitre ET le texte", async () => {
    const feed = { ...findBlock(baseDoc(), "b_feed"), leadCount: 0, midSection: undefined };
    const h24 = await compile(docWith([feed]));
    expect(h24.text).toContain("13:41");
    const h12 = await compile(docWith([{ ...feed, timeFormat: "12h", kickerSeparator: " | " }]));
    expect(h12.text).not.toContain("13:41");
    // L'espace avant « PM » dépend de la version d'ICU (espace fine insécable ou non) : on la laisse libre.
    expect(h12.text).toMatch(/Sport \| 1:41.PM/);
  });
});

describe("repli de {{first_name}} par langue (99)", () => {
  const withName = (meta: Json): Json => docWith([{ id: "b_t", type: "text", paragraphs: [p("Olá {{first_name}} e {{ first_name }}!")] }], meta);

  test("defaultFirstName : langues, langue inconnue, surcharge", () => {
    expect(defaultFirstName("en")).toBe("there");
    expect(defaultFirstName("pt-BR")).toBe("amigo");
    expect(defaultFirstName("es-CL")).toBe("amigo");
    expect(defaultFirstName("de")).toBe("zusammen");
    expect(defaultFirstName("fr-BE")).toBe("cher lecteur");
    expect(defaultFirstName("xx")).toBe("there");
    expect(defaultFirstName("pt", "  ")).toBe("amigo");
    expect(defaultFirstName("pt", "Zé")).toBe("Zé");
  });

  test("portugais : repli inline posé dans le HTML (titre compris) et le texte", async () => {
    const out = await compile(withName({ locale: "pt-BR", subject: "Oi {{first_name}}" }));
    expect(out.html).toContain("{{first_name|amigo}}");
    expect(out.html).not.toMatch(/\{\{\s*first_name\s*\}\}/);
    expect(out.text).toContain("Olá {{first_name|amigo}} e {{first_name|amigo}}!");
  });

  test("anglais : rien ne change, le repli reste celui du registre", async () => {
    const out = await compile(withName({ locale: "en" }));
    expect(out.html).not.toContain("{{first_name|");
    expect(out.text).toContain("{{first_name}}");
  });

  test("surcharge du modèle, y compris des caractères spéciaux de remplacement", async () => {
    const out = await compile(withName({ locale: "pt-BR", firstNameFallback: "$& leitor" }));
    expect(out.text).toContain("{{first_name|$& leitor}}");
    // Brut dans le shell : c'est `hydrate` qui échappe le repli inline à l'envoi.
    expect(out.html).toContain("{{first_name|$& leitor}}");
  });

  test("un repli écrit par l'auteur est laissé tel quel", async () => {
    const out = await compile(docWith([{ id: "b_t", type: "text", paragraphs: [p("Oi {{first_name|amiga}}")] }], { locale: "pt-BR" }));
    expect(out.text).toContain("{{first_name|amiga}}");
  });

  test("le schéma refuse un repli qui casserait le jeton", () => {
    expect(S.Meta.safeParse({ ...baseDoc().meta, firstNameFallback: "a|b" }).success).toBe(false);
    expect(S.Meta.safeParse({ ...baseDoc().meta, firstNameFallback: "{x}" }).success).toBe(false);
    expect(S.Meta.safeParse({ ...baseDoc().meta, firstNameFallback: "   " }).success).toBe(false);
  });

  test("à l'envoi, le repli inline s'applique quand l'abonné n'a pas de prénom", () => {
    expect(hydrateText("Olá {{first_name|amigo}}", {} as never)).toBe("Olá amigo");
    expect(hydrateText("Olá {{first_name|amigo}}", { first_name: "Ana" } as never)).toBe("Olá Ana");
  });
});

describe("version texte : en-tête, preheader, filet (98)", () => {
  const RULE = "-".repeat(40);

  test("absents : preheader recopié, filet de 40 tirets", () => {
    expect(base.text).toContain("Le preheader du jour");
    expect(base.text).toContain(RULE);
  });

  test("header en tête, preheader retiré, filet remplacé partout", async () => {
    const doc = baseDoc();
    doc.meta.plainText = { header: "  View online: {{view_url}}  ", includePreheader: false, rule: "=====" };
    const out = await compile(doc);
    expect(out.text.startsWith("View online: {{view_url}}")).toBe(true);
    expect(out.text).not.toContain("Le preheader du jour");
    expect(out.text).not.toContain(RULE);
    expect(out.text).toContain("=====");
    // Le HTML, lui, garde son preheader : le réglage ne vise que la partie texte.
    expect(out.html).toContain("Le preheader du jour");
  });
});

describe("titre de section : filet avant, des deux côtés, écart réglable (90)", () => {
  const section = (extra: Json): Json => ({ id: "b_s", type: "section_title", label: "Top", ...extra });

  test("before et both se distinguent de after, et ruleGap règle l'écart", async () => {
    const [apres, avant, deux, deuxLarge] = await Promise.all([
      compile(docWith([section({})])),
      compile(docWith([section({ rule: "before" })])),
      compile(docWith([section({ rule: "both" })])),
      compile(docWith([section({ rule: "both", ruleGap: 20 })])),
    ]);
    expect(apres.html).toContain("white-space:nowrap;padding-right:12px;");
    expect(avant.html).toContain("white-space:nowrap;padding-left:12px;");
    expect(deux.html).toContain("white-space:nowrap;padding:0 12px;");
    expect(deuxLarge.html).toContain("white-space:nowrap;padding:0 20px;");
    expect(new Set([apres.html, avant.html, deux.html]).size).toBe(3);
  });
});
