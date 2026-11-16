/**
 * LES NOUVEAUX CONTRÔLES DE L'INSPECTEUR, DU GESTE À L'E-MAIL — `bun test` depuis la racine.
 *
 * Le garde de couverture (`inspector-coverage.test.ts`) prouve qu'une clé est ÉCRITE quelque part ;
 * il ne prouve ni que c'est le bon champ, ni que la valeur écrite change ce que l'abonné reçoit.
 * Ici, chaque cas :
 *   1. rend l'éditeur réel (les composants sans hook sont appelés comme des fonctions),
 *   2. trouve le contrôle par son libellé À L'ÉCRAN et déclenche SON `onChange` / `onClick`,
 *   3. fait passer l'écriture par le vrai réducteur,
 *   4. compile le document avant et après, et regarde le HTML.
 *
 * ⛔ Les champs de `fields.tsx` emploient `useId` : ils ne s'appellent pas hors de React. Ce sont
 * donc les FEUILLES de l'arbre, dont on lit les props ; tout ce qui est au-dessus est déplié.
 *
 * ⛔ LES CHAÎNES ATTENDUES SONT ÉCRITES EN DUR (« Leer la nota », `width="276"`) : un banc qui
 * recalcule sa référence avec le code qu'il surveille ne mesure que lui-même.
 */
import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { compileDoc } from "@nf/render/compile";
import { EmailDoc, type ArticleFeedBlock, type Block, type Theme } from "@nf/render/schema";
import { builderReducer, initBuilderState, type BuilderAction, type BuilderState, type FeedPart } from "./reducer";
import {
  ArticleLookFields,
  CardRuleFields,
  FeedLookSections,
  FontInput,
  MidSectionFields,
  resolveLookBase,
} from "./article-look-fields";
import {
  ButtonLookFields,
  CardButtonFields,
  DividerSegmentsEditor,
  DocumentOutputFields,
  LanguageDefaultsFields,
  LocaleField,
  MenuLookFields,
  SocialItemsEditor,
  SocialLookFields,
  WebFontsEditor,
} from "./extra-fields";
import { ChoiceInput, Group } from "./inspector-ui";
import {
  CalloutEditor,
  FeedCardFields,
  OddsTableEditor,
  PickEditor,
  PromoEditor,
  ScoreboardEditor,
  SectionTitleEditor,
  StandingsEditor,
  ThemePanel,
} from "./inspector";

/* ------------------------------------------------------------------ *
 * Banc : rendre, trouver, déclencher
 * ------------------------------------------------------------------ */

/**
 * Composants sans hook, dépliés. Tout autre composant est une feuille.
 * `ChoiceInput` est déplié pour que le banc déclenche SON `onChange` — celui qui écrit l'absence
 * quand on choisit la valeur par défaut — et pas celui de l'appelant.
 */
const EXPAND = new Set<unknown>([
  ArticleLookFields,
  FeedLookSections,
  MidSectionFields,
  CardRuleFields,
  FontInput,
  Group,
  SocialItemsEditor,
  DividerSegmentsEditor,
  WebFontsEditor,
  LocaleField,
  ChoiceInput,
  CardButtonFields,
  ButtonLookFields,
  MenuLookFields,
  SocialLookFields,
  DocumentOutputFields,
  LanguageDefaultsFields,
  FeedCardFields,
]);

interface Leaf {
  name: string;
  props: Record<string, unknown>;
  /** Les `Group` traversés pour y arriver (« Lead card », « Rule between cards »…). */
  groups: string[];
}

function leaves(node: ReactNode, groups: string[] = [], out: Leaf[] = []): Leaf[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) leaves(n as ReactNode, groups, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const type = node.type as unknown;
  const props = node.props as Record<string, unknown>;
  if (typeof type === "function") {
    if (EXPAND.has(type)) {
      const inner = type === Group ? [...groups, String(props.title)] : groups;
      leaves((type as (p: unknown) => ReactNode)(props), inner, out);
    } else {
      out.push({ name: type.name, props, groups });
    }
    return out;
  }
  return leaves(props.children as ReactNode, groups, out);
}

function control(tree: ReactNode, label: string, group?: string): Leaf {
  const found = leaves(tree).filter((l) => l.props.label === label && (group === undefined || l.groups.includes(group)));
  if (found.length !== 1) {
    throw new Error(`expected exactly one control “${label}”${group ? ` in “${group}”` : ""}, found ${found.length}`);
  }
  return found[0];
}

const change = (leaf: Leaf, value: unknown) => (leaf.props.onChange as (v: unknown) => void)(value);
const click = (leaf: Leaf) => (leaf.props.onClick as () => void)();

/** Un document vivant : l'état du réducteur, et les écritures que les contrôles y envoient. */
function bench(doc: EmailDoc) {
  let state: BuilderState = initBuilderState(doc);
  const dispatch = (a: BuilderAction) => {
    state = builderReducer(state, a);
  };
  return {
    dispatch,
    get doc() {
      return state.present;
    },
    block<T extends Block = Block>(): T {
      return state.present.rows[0].columns[0].blocks[0] as T;
    },
    patch: (p: Record<string, unknown>) => dispatch({ type: "updateBlock", blockId: "blk_1", patch: p as never }),
    patchPart: (part: FeedPart, p: Record<string, unknown> | null) =>
      dispatch({ type: "updateBlockPart", blockId: "blk_1", part, patch: p }),
  };
}

const html = async (doc: EmailDoc) => (await compileDoc(doc)).html;
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

function docWith(block: Record<string, unknown>, meta: Record<string, unknown> = {}, theme: Record<string, unknown> = {}) {
  return EmailDoc.parse({
    schema: 2,
    meta: { subject: "Banc", preheader: "", assetSlug: "demo-brand", locale: "en", ...meta },
    theme,
    rows: [{ id: "row_1", layout: "1", columns: [{ id: "col_1", blocks: [{ id: "blk_1", ...block }] }] }],
  });
}

const ITEM = (n: number) => ({
  postId: `post-${n}`,
  title: `Titre ${n}`,
  excerpt: `Chapeau ${n}`,
  href: `https://example.test/article-${n}`,
  imageSrc: `https://example.test/img-${n}.jpg`,
  imageAlt: "",
  publishedAt: "2026-09-22T21:42:00.000Z",
  category: "Noticias",
});

function feedDoc(settings: Record<string, unknown> = {}) {
  return docWith({
    type: "article-feed",
    sourceId: "src_1",
    count: 3,
    previewItems: [ITEM(1), ITEM(2), ITEM(3)],
    previewAt: "2026-09-22T12:00:00.000Z",
    ...settings,
  });
}

/**
 * L'éditeur des looks d'un flux, tel que `FeedEditor` le monte (sans panneau de style). Il ne reçoit
 * AUCUN `patch` depuis le 23/09/2026 (« Read link style — every card » est passé dans `FeedCardFields`) :
 * un look qui écrirait au niveau du bloc au lieu de `patchPart` appellerait ici une fonction absente,
 * et LÈVERAIT.
 */
const feedLooks = (block: ArticleFeedBlock, theme: Theme, patchPart: ReturnType<typeof bench>["patchPart"]) =>
  FeedLookSections({ block, locale: "en", theme, layers: [], patchPart, renderStyle: () => null });

/** Les réglages des cartes d'un flux, avec les props que `FeedEditor` leur passe. */
const feedCards = (b: ReturnType<typeof bench>) =>
  FeedCardFields({ block: b.block<ArticleFeedBlock>(), patch: b.patch, dispatch: b.dispatch, locale: "en" });

/** L'éditeur d'un article écrit à la main, avec les props que `ArticleEditor` lui passe. */
const articleLook = (block: Extract<Block, { type: "article" }>, theme: Theme, patch: (p: Record<string, unknown>) => void) =>
  ArticleLookFields({
    mode: "article",
    value: block,
    onPatch: patch,
    theme,
    base: resolveLookBase(theme, [block.style]),
    accent: { color: theme.brandColor, from: "the brand colour" },
    cta: { inherited: "Read more", inheritedFrom: "this document's language", hint: "" },
  });

/* ------------------------------------------------------------------ *
 * Lien de lecture : « None » le retire, partout où il existe
 * ------------------------------------------------------------------ */

describe("ctaStyle — the read link can be removed", () => {
  test("article : None écrit ctaStyle none et le libellé quitte l'e-mail", async () => {
    const b = bench(
      docWith({
        type: "article",
        title: "Un titre",
        excerpt: "",
        imageAlt: "",
        href: "https://example.test/a",
        ctaLabel: "Full story here",
        layout: "stacked",
      }),
    );
    const before = await html(b.doc);
    expect(before).toContain("Full story here");

    change(control(articleLook(b.block(), b.doc.theme, b.patch), "Read link style"), "none");
    expect((b.block() as { ctaStyle?: string }).ctaStyle).toBe("none");
    expect(await html(b.doc)).not.toContain("Full story here");
    // Et le libellé devenu mort n'est plus proposé à la saisie.
    expect(() => control(articleLook(b.block(), b.doc.theme, b.patch), "Read link label")).toThrow();
  });

  for (const [group, part, remaining] of [
    ["Lead card", "lead", 2],
    ["Other cards", "card", 1],
  ] as const) {
    test(`flux, ${group} : None retire le lien de ces cartes seulement`, async () => {
      const b = bench(feedDoc({ leadCount: 1, ctaLabel: "Full story here" }));
      const before = count(await html(b.doc), "Full story here");
      expect(before).toBeGreaterThan(0);

      change(control(feedLooks(b.block(), b.doc.theme, b.patchPart), "Read link style", group), "none");
      expect((b.block<ArticleFeedBlock>()[part] as { ctaStyle?: string }).ctaStyle).toBe("none");
      // Trois cartes, un même libellé : il en reste `remaining` sur 3.
      expect(count(await html(b.doc), "Full story here") * 3).toBe(before * remaining);
    });
  }
});

/* ------------------------------------------------------------------ *
 * Titre de section entre la une et les brèves
 * ------------------------------------------------------------------ */

describe("midSection — label, and removal", () => {
  test("ajouter, renommer, puis retirer le titre de section", async () => {
    const b = bench(feedDoc({ leadCount: 1 }));
    const view = () => feedLooks(b.block(), b.doc.theme, b.patchPart);

    click(control(view(), "Add a section title", "Section between them"));
    change(control(view(), "Section title", "Section between them"), "Otras noticias");
    expect(b.block<ArticleFeedBlock>().midSection?.label).toBe("Otras noticias");
    expect(await html(b.doc)).toContain("Otras noticias");

    click(control(view(), "Remove section", "Section between them"));
    expect(b.block<ArticleFeedBlock>().midSection).toBeUndefined();
    expect(await html(b.doc)).not.toContain("Otras noticias");
  });
});

/* ------------------------------------------------------------------ *
 * Filet entre les cartes
 * ------------------------------------------------------------------ */

describe("cardRule — colour, and removal", () => {
  test("la couleur du filet s'écrit sans perdre son épaisseur, puis le filet se retire", async () => {
    const b = bench(feedDoc({ cardRule: { thickness: 3 } }));
    const view = () => feedLooks(b.block(), b.doc.theme, b.patchPart);

    change(control(view(), "Rule colour", "Rule between cards"), "#123456");
    expect(b.block<ArticleFeedBlock>().cardRule).toEqual({ thickness: 3, color: "#123456" });
    expect((await html(b.doc)).toLowerCase()).toContain("#123456");

    click(control(view(), "Remove rule", "Rule between cards"));
    expect(b.block<ArticleFeedBlock>().cardRule).toBeUndefined();
    expect((await html(b.doc)).toLowerCase()).not.toContain("#123456");
  });
});

/* ------------------------------------------------------------------ *
 * Surtitre fixe de la une
 * ------------------------------------------------------------------ */

describe("kickerText — a fixed label above the lead title", () => {
  test("« A fixed label » puis le texte : il apparaît au-dessus de la une", async () => {
    const b = bench(feedDoc({ leadCount: 1 }));
    const view = () => feedLooks(b.block(), b.doc.theme, b.patchPart);
    expect(await html(b.doc)).not.toContain("Destacada");

    change(control(view(), "Kicker shows", "Lead card"), "text");
    change(control(view(), "Kicker label", "Lead card"), "Destacada");
    expect(b.block<ArticleFeedBlock>().lead).toEqual({ kickerMode: "text", kickerText: "Destacada" });
    expect(count(await html(b.doc), "Destacada")).toBe(1);
  });

  test("⛔ régler la police du titre de la une GARDE son surtitre (écriture imbriquée)", async () => {
    const b = bench(feedDoc({ leadCount: 1, lead: { kickerMode: "text", kickerText: "Destacada" } }));
    change(control(feedLooks(b.block(), b.doc.theme, b.patchPart), "Title font", "Lead card"), "Georgia, 'Times New Roman', serif");
    expect(b.block<ArticleFeedBlock>().lead).toEqual({
      kickerMode: "text",
      kickerText: "Destacada",
      titleFont: "Georgia, 'Times New Roman', serif",
    });
    const out = await html(b.doc);
    expect(out).toContain("Destacada");
    expect(out).toContain("Georgia");
  });
});

/* ------------------------------------------------------------------ *
 * Largeur de la vignette
 * ------------------------------------------------------------------ */

describe("imageWidthPct — thumbnail width beside the text", () => {
  test("50 % sur 552 px utiles (600 − 2 × 24) = 276 px", async () => {
    const b = bench(
      docWith({
        type: "article",
        title: "Un titre",
        excerpt: "",
        href: "https://example.test/a",
        imageSrc: "https://example.test/thumb.jpg",
        imageAlt: "",
        layout: "side",
      }),
    );
    expect(await html(b.doc)).not.toContain('width="276"');

    change(control(articleLook(b.block(), b.doc.theme, b.patch), "Thumbnail width"), 50);
    expect((b.block() as { imageWidthPct?: number }).imageWidthPct).toBe(50);
    expect(await html(b.doc)).toContain('width="276"');
  });
});

/* ------------------------------------------------------------------ *
 * Icône d'un lien social
 * ------------------------------------------------------------------ */

describe("social iconSrc — a real icon instead of the globe", () => {
  test("l'image posée part dans l'e-mail", async () => {
    const b = bench(
      docWith({ type: "social", items: [{ platform: "tiktok", href: "https://tiktok.com/@banc" }], iconSize: 24, mode: "horizontal" }),
    );
    const icon = "https://cdn.example.test/icons/tiktok.png";
    expect(await html(b.doc)).not.toContain(icon);

    const view = SocialItemsEditor({
      items: (b.block() as Extract<Block, { type: "social" }>).items,
      onChange: (items) => b.patch({ items }),
    });
    change(control(view, "Icon image (optional)"), icon);
    expect((b.block() as Extract<Block, { type: "social" }>).items).toEqual([
      { platform: "tiktok", href: "https://tiktok.com/@banc", iconSrc: icon },
    ]);
    expect(await html(b.doc)).toContain(icon);
  });
});

/* ------------------------------------------------------------------ *
 * Polices web du thème
 * ------------------------------------------------------------------ */

describe("theme.webFonts — a brand font is loaded", () => {
  test("ajouter une police nommée par le thème : sa feuille part dans le <head>", async () => {
    const b = bench(docWith({ type: "text", paragraphs: [{ spans: [{ text: "Bonjour" }] }] }, {}, { fontFamily: "Archivo, Arial, sans-serif" }));
    const sheet = "https://fonts.example.test/archivo.css";
    const view = () =>
      WebFontsEditor({
        fonts: b.doc.theme.webFonts,
        usedIn: JSON.stringify(b.doc.rows) + b.doc.theme.fontFamily,
        onChange: (next) => b.dispatch({ type: "setDoc", doc: { ...b.doc, theme: { ...b.doc.theme, webFonts: next } } }),
      });
    expect(await html(b.doc)).not.toContain(sheet);

    click(control(view(), "Add a web font"));
    change(control(view(), "Font 1 family"), "Archivo");
    change(control(view(), "Font 1 stylesheet URL"), sheet);
    expect(b.doc.theme.webFonts).toEqual([{ family: "Archivo", href: sheet }]);
    expect(await html(b.doc)).toContain(sheet);
  });
});

/* ------------------------------------------------------------------ *
 * Langue du document
 * ------------------------------------------------------------------ */

describe("meta.locale — the language of the email", () => {
  test("passer en espagnol change l'attribut lang et le libellé par défaut du lien", async () => {
    const b = bench(
      docWith({ type: "article", title: "Un titre", excerpt: "", imageAlt: "", href: "https://example.test/a", layout: "stacked" }),
    );
    const before = await html(b.doc);
    expect(before).not.toContain("Leer la nota");

    change(
      control(LocaleField({ value: b.doc.meta.locale, onChange: (v) => b.dispatch({ type: "updateMeta", patch: { locale: v } }) }), "Language"),
      "es",
    );
    expect(b.doc.meta.locale).toBe("es");
    const after = await html(b.doc);
    expect(after).toContain('lang="es"');
    expect(after).toContain("Leer la nota");
  });
});

/* ================================================================== *
 * Réglages du 22/09/2026 (`NEW_PROPS_2026_09_22`) — un contrôle représentatif par groupe
 * ================================================================== */

/** Les props que `BlockContent` passe aux éditeurs qui ont des réglages d'apparence. */
function lookProps<T extends Block>(b: ReturnType<typeof bench>) {
  const block = b.block<T>();
  const theme = b.doc.theme;
  return { block, patch: b.patch, theme, base: resolveLookBase(theme, ["style" in block ? block.style : undefined]) };
}

const PICK = {
  type: "pick",
  matchLabel: "A — B",
  marketLabel: "Both teams score",
  selectionLabel: "Yes",
  oddsLabel: "1.85",
  kickoffLabel: "Sunday 18:00",
  href: "https://example.test/pick",
  ctaLabel: "See the pick",
};

describe("article — card look (22/09)", () => {
  const article = () =>
    bench(
      docWith({
        type: "article",
        title: "Un titre",
        excerpt: "Son chapeau.",
        imageSrc: "https://example.test/thumb.jpg",
        imageAlt: "",
        href: "https://example.test/a",
        layout: "stacked",
      }),
    );

  test("Excerpt line height : l'interligne du chapeau part dans l'e-mail", async () => {
    const b = article();
    expect(await html(b.doc)).not.toContain("line-height:1.9;");
    change(control(articleLook(b.block(), b.doc.theme, b.patch), "Excerpt line height"), 1.9);
    expect((b.block() as { excerptLineHeight?: number }).excerptLineHeight).toBe(1.9);
    expect(await html(b.doc)).toContain("line-height:1.9;font-weight:400;");
  });

  test("Clickable image décoché : l'image ne porte plus le lien", async () => {
    const b = article();
    const before = count(await html(b.doc), 'href="https://example.test/a"');
    change(control(articleLook(b.block(), b.doc.theme, b.patch), "Clickable image"), false);
    expect((b.block() as { imageLink?: boolean }).imageLink).toBe(false);
    expect(count(await html(b.doc), 'href="https://example.test/a"')).toBe(before - 1);
  });

  test("Read link weight (bouton) : la graisse du libellé change", async () => {
    const b = article();
    change(control(articleLook(b.block(), b.doc.theme, b.patch), "Read link weight"), "900");
    expect((b.block() as { ctaWeight?: string }).ctaWeight).toBe("900");
    // Le bouton garde la couleur de texte de bouton du thème (#FEFEFE) : seule la graisse bouge.
    expect(await html(b.doc)).toContain("font-weight:900;color:#FEFEFE;");
  });
});

describe("article-feed — card looks and block settings (22/09)", () => {
  test("⛔ Button background de la une : écrit DANS le look, sans perdre son surtitre", async () => {
    const b = bench(feedDoc({ leadCount: 1, lead: { kickerMode: "text", kickerText: "Destacada" } }));
    expect((await html(b.doc)).toLowerCase()).not.toContain("#0a1b2c");
    change(control(feedLooks(b.block(), b.doc.theme, b.patchPart), "Button background", "Lead card"), "#0a1b2c");
    expect(b.block<ArticleFeedBlock>().lead).toEqual({ kickerMode: "text", kickerText: "Destacada", ctaBackground: "#0a1b2c" });
    const out = await html(b.doc);
    expect(out.toLowerCase()).toContain('bgcolor="#0a1b2c"');
    expect(out).toContain("Destacada");
  });

  test("Read link style — every card : None retire le lien de toutes les cartes", async () => {
    const b = bench(feedDoc({ ctaLabel: "Full story here" }));
    expect(count(await html(b.doc), "Full story here")).toBe(3);
    change(control(feedCards(b), "Read link style — every card", "Read link"), "none");
    expect(b.block<ArticleFeedBlock>().ctaStyle).toBe("none");
    expect(await html(b.doc)).not.toContain("Full story here");
  });

  test("Lead cards = 2 : deux unes, deux surtitres fixes", async () => {
    const b = bench(feedDoc({ leadCount: 1, lead: { kickerMode: "text", kickerText: "Destacada" } }));
    expect(count(await html(b.doc), "Destacada")).toBe(1);
    change(control(feedCards(b), "Lead cards"), "2");
    expect(b.block<ArticleFeedBlock>().leadCount).toBe(2);
    expect(count(await html(b.doc), "Destacada")).toBe(2);
    // Et « None » écrit l'absence, pas un 0.
    change(control(feedCards(b), "Lead cards"), "0");
    expect(b.block<ArticleFeedBlock>().leadCount).toBeUndefined();
  });

  test("Time format 12h et Kicker separator : l'heure du surtitre change de forme", async () => {
    const b = bench(feedDoc({ showKicker: true }));
    const before = await html(b.doc);
    expect(before).toContain("21:42");
    const view = () => feedCards(b);

    change(control(view(), "Kicker separator"), " | ");
    expect(b.block<ArticleFeedBlock>().kickerSeparator).toBe(" | ");
    expect(await html(b.doc)).toContain(" | 21:42");

    change(control(view(), "Time format"), "12h");
    expect(b.block<ArticleFeedBlock>().timeFormat).toBe("12h");
    const after = await html(b.doc);
    expect(after).not.toContain("21:42");
    expect(after).toMatch(/ \| 9:42\sPM/);
  });

  test("Show without a lead : le titre de section part au-dessus des cartes", async () => {
    const b = bench(feedDoc({ midSection: { label: "Otras noticias" } }));
    expect(await html(b.doc)).not.toContain("Otras noticias");
    change(
      control(feedLooks(b.block(), b.doc.theme, b.patchPart), "Show without a lead", "Section title above the cards"),
      true,
    );
    expect(b.block<ArticleFeedBlock>().midSection).toEqual({ label: "Otras noticias", showWithoutLead: true });
    expect(count(await html(b.doc), "Otras noticias")).toBe(1);
  });

  test("Rule style : le filet entre les cartes passe en pointillé, épaisseur gardée", async () => {
    const b = bench(feedDoc({ cardRule: { thickness: 3 } }));
    expect(await html(b.doc)).not.toContain("dotted");
    change(control(feedLooks(b.block(), b.doc.theme, b.patchPart), "Rule style", "Rule between cards"), "dotted");
    expect(b.block<ArticleFeedBlock>().cardRule).toEqual({ thickness: 3, lineStyle: "dotted" });
    expect(await html(b.doc)).toContain("border-top:dotted 3px");
  });
});

/* ------------------------------------------------------------------ *
 * « Arrangement » du flux — il gouverne les brèves pour de bon (23/09)
 * ------------------------------------------------------------------ */

/**
 * La forme RÉELLE de « Boletín semanal genérico » (lue en prod le 23/09/2026) : le flux ET ses deux
 * looks posent une disposition. `toArticle` fait `look.layout ?? feed.layout` : changer le seul
 * `layout` du flux laissait l'e-mail identique à l'octet.
 */
const BOLETIN = {
  layout: "side",
  leadCount: 1,
  card: { layout: "side", kickerMode: "category-time", titleSize: 20, imageWidthPct: 33 },
  lead: { layout: "stacked", kickerMode: "text", kickerText: "Destacada" },
  midSection: { label: "Más noticias" },
};
/** Une carte en vignette porte UNE cellule image à 100 % en `inline-block` (cf. `flux-rendu.test.ts`, (d)). */
const VIGNETTE = 'style="display:inline-block;vertical-align:top;width:100%;max-width:100%;"';
/** Le texte d'un `Note` : ses enfants mis bout à bout, comme React les affiche. */
const noteText = (leaf: Leaf) => [leaf.props.children].flat(Infinity).join("");

describe("article-feed — Arrangement governs the cards (23/09)", () => {
  test("la valeur affichée est celle qui part : le look `card`, pas le `layout` du flux", () => {
    const b = bench(feedDoc({ ...BOLETIN, layout: "stacked" }));
    expect(control(feedCards(b), "Arrangement").props.value).toBe("side");
  });

  test("⛔ Stacked : `card.layout` disparaît, le reste du look reste, et les brèves s'empilent", async () => {
    const b = bench(feedDoc(BOLETIN));
    expect(count(await html(b.doc), VIGNETTE)).toBe(2);

    change(control(feedCards(b), "Arrangement"), "stacked");
    const block = b.block<ArticleFeedBlock>();
    expect(block.layout).toBe("stacked");
    expect(block.card).toEqual({ kickerMode: "category-time", titleSize: 20, imageWidthPct: 33 });
    expect(block.lead).toEqual({ layout: "stacked", kickerMode: "text", kickerText: "Destacada" });
    expect(control(feedCards(b), "Arrangement").props.value).toBe("stacked");
    const after = await html(b.doc);
    expect(count(after, VIGNETTE)).toBe(0);
    expect(count(after, "Destacada")).toBe(1);
  });

  test("⛔ un look `card` qui ne portait QUE la disposition disparaît, et le document reste valide", () => {
    const b = bench(feedDoc({ layout: "side", card: { layout: "side" } }));
    change(control(feedCards(b), "Arrangement"), "stacked");
    expect("card" in b.block<ArticleFeedBlock>()).toBe(false);
    expect(b.block<ArticleFeedBlock>().layout).toBe("stacked");
    expect(EmailDoc.safeParse(b.doc).success).toBe(true);
  });

  test("un seul geste, un seul Ctrl+Z", () => {
    const b = bench(feedDoc(BOLETIN));
    const original = b.block<ArticleFeedBlock>();
    change(control(feedCards(b), "Arrangement"), "stacked");
    b.dispatch({ type: "undo" });
    expect(b.block<ArticleFeedBlock>()).toEqual(original);
  });

  test("sans look `card` : seul `layout` est écrit, et toutes les cartes changent", async () => {
    const b = bench(feedDoc({ layout: "stacked", leadCount: 1 }));
    expect(count(await html(b.doc), VIGNETTE)).toBe(0);
    change(control(feedCards(b), "Arrangement"), "side");
    expect(b.block<ArticleFeedBlock>().layout).toBe("side");
    expect(b.block<ArticleFeedBlock>().card).toBeUndefined();
    expect(count(await html(b.doc), VIGNETTE)).toBe(3);
  });

  test("le repère dit que la une garde sa propre disposition, au singulier comme au pluriel", () => {
    const b = bench(feedDoc(BOLETIN));
    expect(control(feedCards(b), "Arrangement").props.hint).toBe(
      "Applies to the other cards. The lead card keeps its own arrangement (Stacked) — change it under “Lead card” below.",
    );
    change(control(feedCards(b), "Lead cards"), "2");
    expect(control(feedCards(b), "Arrangement").props.hint).toBe(
      "Applies to the other cards. The lead cards keep their own arrangement (Stacked) — change it under “Lead cards” below.",
    );
    // Sans une, la disposition de `lead` ne sert à personne : le repère ne la cite plus.
    change(control(feedCards(b), "Lead cards"), "0");
    expect(control(feedCards(b), "Arrangement").props.hint).toBe(
      "Applies to every card the feed produces — they are rendered by the same code as a manual article block.",
    );
  });

  test("Lead cards sans look de une : un avertissement dit où le créer, et part avec le look", () => {
    const b = bench(feedDoc({ layout: "stacked", leadCount: 1 }));
    const warnings = () => leaves(feedCards(b)).filter((l) => l.name === "Note" && l.props.tone === "warn").map(noteText);
    expect(warnings()).toEqual([
      "No lead look is set yet, so the first card looks exactly like the others. Style it under “Card looks → Lead card” below.",
    ]);
    change(control(feedCards(b), "Lead cards"), "2");
    expect(warnings()).toEqual([
      "No lead look is set yet, so the first 2 cards look exactly like the others. Style them under “Card looks → Lead cards” below.",
    ]);
    b.patchPart("lead", { kickerMode: "text", kickerText: "Destacada" });
    expect(warnings()).toEqual([]);
  });
});

describe("pick — text lines and button (22/09)", () => {
  test("Kick-off colour (Text lines) et Button background (Button)", async () => {
    const b = bench(docWith(PICK));
    const before = (await html(b.doc)).toLowerCase();
    expect(before).not.toContain("#1a2b3c");
    expect(before).not.toContain("#2b3c4d");

    change(control(PickEditor(lookProps(b)), "Kick-off colour", "Text lines"), "#1a2b3c");
    change(control(PickEditor(lookProps(b)), "Button background", "Button"), "#2b3c4d");
    expect(b.block()).toMatchObject({ kickoffColor: "#1a2b3c", ctaBackground: "#2b3c4d" });
    const after = (await html(b.doc)).toLowerCase();
    expect(after).toContain("#1a2b3c");
    expect(after).toContain('bgcolor="#2b3c4d"');
  });
});

describe("odds_table / standings — table style (22/09)", () => {
  test("odds_table, Value colour", async () => {
    const b = bench(
      docWith({
        type: "odds_table",
        rows: [
          { label: "Home", value: "2.10" },
          { label: "Draw", value: "3.20" },
        ],
      }),
    );
    expect((await html(b.doc)).toLowerCase()).not.toContain("#3c4d5e");
    change(control(OddsTableEditor(lookProps(b)), "Value colour", "Table style"), "#3c4d5e");
    expect((b.block() as { valueColor?: string }).valueColor).toBe("#3c4d5e");
    expect((await html(b.doc)).toLowerCase()).toContain("#3c4d5e");
  });

  test("standings, Header colour", async () => {
    const b = bench(docWith({ type: "standings", columns: ["Team", "Pts"], rows: [["A", "45"]] }));
    expect((await html(b.doc)).toLowerCase()).not.toContain("#4d5e6f");
    change(control(StandingsEditor(lookProps(b)), "Header colour", "Header row"), "#4d5e6f");
    expect((b.block() as { headerColor?: string }).headerColor).toBe("#4d5e6f");
    expect((await html(b.doc)).toLowerCase()).toContain("#4d5e6f");
  });
});

describe("scoreboard — row colours (22/09)", () => {
  test("Label colour des lignes ordinaires", async () => {
    const b = bench(
      docWith({
        type: "scoreboard",
        kicker: "Full time",
        rows: [
          { label: "Winner", value: "2", highlight: true },
          { label: "Loser", value: "1" },
        ],
      }),
    );
    expect((await html(b.doc)).toLowerCase()).not.toContain("#5e6f70");
    change(control(ScoreboardEditor(lookProps(b)), "Label colour", "Row colours"), "#5e6f70");
    expect((b.block() as { labelColor?: string }).labelColor).toBe("#5e6f70");
    expect((await html(b.doc)).toLowerCase()).toContain("#5e6f70");
  });
});

describe("callout — title and button (22/09)", () => {
  const callout = (style?: Record<string, unknown>) =>
    bench(
      docWith({
        type: "callout",
        kicker: "Match of the day",
        title: "A hosts B",
        body: "All you need to know.",
        href: "https://example.test/preview",
        ctaLabel: "Read the preview",
        ...(style ? { style } : {}),
      }),
    );

  test("⛔ Title weight : sous un bloc en 600, choisir 700 ÉCRIT 700 (le défaut affiché est 600)", async () => {
    const b = callout({ fontWeight: "600" });
    const before = await html(b.doc);
    change(control(CalloutEditor(lookProps(b)), "Title weight"), "700");
    expect((b.block() as { titleWeight?: string }).titleWeight).toBe("700");
    expect(await html(b.doc)).not.toBe(before);
  });

  test("Button corner radius (Button style)", async () => {
    const b = callout();
    expect(await html(b.doc)).not.toContain("border-radius:17px;");
    change(control(CalloutEditor(lookProps(b)), "Button corner radius", "Button style"), 17);
    expect((b.block() as { ctaRadius?: number }).ctaRadius).toBe(17);
    expect(await html(b.doc)).toContain("border-radius:17px;");
  });
});

describe("promo — code and card (22/09)", () => {
  test("Code border style : le cadre du code passe en pointillé", async () => {
    const b = bench(
      docWith({ type: "promo", headline: "Welcome bonus", code: "BANC100", href: "https://promo.example.test", ctaLabel: "Claim" }),
    );
    expect(await html(b.doc)).not.toContain("dotted");
    change(control(PromoEditor(lookProps(b)), "Code border style", "Promo code"), "dotted");
    expect((b.block() as { codeBorderStyle?: string }).codeBorderStyle).toBe("dotted");
    expect(await html(b.doc)).toContain("dotted");
  });
});

describe("section_title — rule on both sides (22/09)", () => {
  test("Rule = both : la valeur s'écrit et le rendu change", async () => {
    const b = bench(docWith({ type: "section_title", label: "Top stories" }));
    const before = await html(b.doc);
    change(control(SectionTitleEditor({ block: b.block(), patch: b.patch }), "Rule"), "both");
    expect((b.block() as { rule?: string }).rule).toBe("both");
    const after = await html(b.doc);
    expect(after).not.toBe(before);
    expect(after).toContain("Top stories");
  });
});

describe("button / menu / social — their own look (22/09)", () => {
  test("button, Button background", async () => {
    const b = bench(docWith({ type: "button", label: "Go", href: "https://example.test/go" }));
    expect((await html(b.doc)).toLowerCase()).not.toContain("#6a7b8c");
    const blk = b.block<Extract<Block, { type: "button" }>>();
    change(control(ButtonLookFields({ block: blk, theme: b.doc.theme, base: { fontSize: 16 }, patch: b.patch }), "Button background"), "#6a7b8c");
    expect((b.block() as { buttonBackground?: string }).buttonBackground).toBe("#6a7b8c");
    expect((await html(b.doc)).toLowerCase()).toContain("#6a7b8c");
  });

  test("menu, Underline", async () => {
    const b = bench(
      docWith({ type: "menu", separator: "|", items: [{ label: "News", href: "https://example.test/n" }] }),
    );
    expect(await html(b.doc)).toContain("text-decoration:none;font-weight:600;");
    const blk = b.block<Extract<Block, { type: "menu" }>>();
    change(control(MenuLookFields({ block: blk, theme: b.doc.theme, base: { fontSize: 16 }, patch: b.patch }), "Underline"), true);
    expect((b.block() as { itemUnderline?: boolean }).itemUnderline).toBe(true);
    expect(await html(b.doc)).toContain("text-decoration:underline;font-weight:600;");
  });

  test("social, Label colour", async () => {
    const b = bench(
      docWith({ type: "social", items: [{ platform: "facebook", href: "https://facebook.com/banc", label: "Facebook" }] }),
    );
    expect((await html(b.doc)).toLowerCase()).not.toContain("#7c8d9e");
    const blk = b.block<Extract<Block, { type: "social" }>>();
    change(control(SocialLookFields({ block: blk, theme: b.doc.theme, patch: b.patch }), "Label colour"), "#7c8d9e");
    expect((b.block() as { labelColor?: string }).labelColor).toBe("#7c8d9e");
    expect((await html(b.doc)).toLowerCase()).toContain("#7c8d9e");
  });
});

describe("theme — presets, screen sizes (22/09)", () => {
  const themed = (theme: Record<string, unknown> = {}) =>
    bench(docWith({ type: "text", preset: "h1", paragraphs: [{ spans: [{ text: "Gros titre" }] }] }, {}, theme));
  const panel = (b: ReturnType<typeof bench>) =>
    ThemePanel({
      theme: b.doc.theme,
      usedIn: "",
      onChange: (next) => b.dispatch({ type: "setDoc", doc: { ...b.doc, theme: next } }),
    });

  test("⛔ Heading 1 → Size : écrit h1 SANS effacer le réglage de h2", async () => {
    const b = themed({ textPresets: { h2: { weight: "800" } } });
    expect(await html(b.doc)).not.toContain("font-size:40px");
    change(control(panel(b), "Size", "Heading 1"), 40);
    expect(b.doc.theme.textPresets).toEqual({ h2: { weight: "800" }, h1: { size: 40 } });
    expect(await html(b.doc)).toContain("font-size:40px");
  });

  test("Mobile below : la media query mobile suit le seuil", async () => {
    const b = themed();
    expect(await html(b.doc)).toContain("(max-width:600px)");
    change(control(panel(b), "Mobile below"), 480);
    expect(b.doc.theme.mobileBreakpoint).toBe(480);
    const after = await html(b.doc);
    expect(after).toContain("(max-width:480px)");
    expect(after).not.toContain("(max-width:600px)");
  });
});

describe("meta — plain text, language defaults (22/09)", () => {
  const withMeta = () =>
    bench(docWith({ type: "text", paragraphs: [{ spans: [{ text: "Hola {{first_name}}." }] }] }, { preheader: "Teaser" }));
  const updateMeta = (b: ReturnType<typeof bench>) => (p: Record<string, unknown>) =>
    b.dispatch({ type: "updateMeta", patch: p });

  test("⛔ Separator line puis Top line : plainText réécrit ENTIER, rien de perdu", async () => {
    const b = withMeta();
    expect((await compileDoc(b.doc)).text).toContain("----------------------------------------");
    change(control(DocumentOutputFields({ meta: b.doc.meta, onPatch: updateMeta(b) }), "Separator line"), "==========");
    change(control(DocumentOutputFields({ meta: b.doc.meta, onPatch: updateMeta(b) }), "Top line"), "Edition du jour");
    expect(b.doc.meta.plainText).toEqual({ rule: "==========", header: "Edition du jour" });
    const text = (await compileDoc(b.doc)).text;
    expect(text.startsWith("Edition du jour\n")).toBe(true);
    expect(text).toContain("Teaser\n\n==========");
    expect(text).not.toContain("----------------------------------------");
  });

  test("First-name fallback : le repli est écrit dans le jeton", async () => {
    const b = withMeta();
    expect(await html(b.doc)).not.toContain("{{first_name|Ana}}");
    change(control(LanguageDefaultsFields({ meta: b.doc.meta, onPatch: updateMeta(b) }), "First-name fallback"), "A{n}a");
    expect(b.doc.meta.firstNameFallback).toBe("Ana");
    expect(await html(b.doc)).toContain("{{first_name|Ana}}");
  });

  test("⛔ {{edition_date}} puis {{weekday}} : dateFormats réécrit ENTIER, le défaut s'efface", async () => {
    const b = withMeta();
    expect(await html(b.doc)).not.toContain("nf:dates");
    const dates = () => LanguageDefaultsFields({ meta: b.doc.meta, onPatch: updateMeta(b) });
    change(control(dates(), "{{edition_date}}", "Dates"), "full");
    change(control(dates(), "{{weekday}}", "Dates"), "weekday_short");
    expect(b.doc.meta.dateFormats).toEqual({ edition_date: "full", weekday: "weekday_short" });
    expect(await html(b.doc)).toContain("<!--nf:dates edition_date=full weekday=weekday_short-->");
    // Revenir au défaut n'écrit pas la valeur : il la RETIRE, et le marqueur avec elle.
    change(control(dates(), "{{edition_date}}", "Dates"), "long");
    change(control(dates(), "{{weekday}}", "Dates"), "weekday");
    expect(b.doc.meta.dateFormats).toBeUndefined();
    expect(await html(b.doc)).not.toContain("nf:dates");
  });
});

/* ------------------------------------------------------------------ *
 * Encart : « Background & layout » (23/09/2026) — chaque contrôle change l'e-mail
 * ------------------------------------------------------------------ */

describe("callout — Background & layout (23/09)", () => {
  const GROUP = "Background & layout";
  const COLOR = "#12A4C7";
  const callout = (extra: Record<string, unknown> = {}) =>
    bench(
      docWith({
        type: "callout",
        kicker: "Podcast",
        title: "Friday night preview",
        body: "Three matches worth your evening.",
        href: "https://example.test/listen",
        ctaLabel: "Listen now",
        style: { backgroundColor: "#101820" },
        ...extra,
      }),
    );
  const editor = (b: ReturnType<typeof bench>) => CalloutEditor(lookProps(b));
  /** `MediaField` garde son état (`useState`) : c'est une feuille, trouvée par son libellé d'URL. */
  const media = (b: ReturnType<typeof bench>, srcLabel: string) => {
    const found = leaves(editor(b)).filter((l) => l.name === "MediaField" && l.props.srcLabel === srcLabel);
    if (found.length !== 1) throw new Error(`expected one MediaField “${srcLabel}”, found ${found.length}`);
    return found[0].props as { onSrc: (v: string) => void; onAlt?: (v: string) => void; onPick: (m: { src: string; alt: string }) => void };
  };

  /** Un contrôle : sous quelle mise en page, quel geste, et la clé qu'il doit avoir écrite. */
  const CASES: { label: string; setup: Record<string, unknown>; value: unknown; key: string }[] = [
    { label: "Layout", setup: {}, value: "poster", key: "layout" },
    { label: "Picture framing", setup: { layout: "poster", backgroundImage: "https://example.test/bg.jpg" }, value: "right", key: "backgroundPosition" },
    { label: "Picture height", setup: { layout: "poster" }, value: 420, key: "minHeight" },
    { label: "Text position", setup: { layout: "poster" }, value: "top", key: "contentVAlign" },
    { label: "Kicker style", setup: { layout: "poster" }, value: "pill", key: "kickerStyle" },
    { label: "Pill color", setup: { layout: "poster", kickerStyle: "pill" }, value: COLOR, key: "kickerAccent" },
    { label: "Dot color", setup: { layout: "poster", kickerStyle: "dot" }, value: COLOR, key: "kickerAccent" },
    { label: "Badge background", setup: { layout: "player" }, value: COLOR, key: "playBackground" },
    { label: "Badge glyph", setup: { layout: "cover" }, value: COLOR, key: "playColor" },
    { label: "Played share", setup: { layout: "player" }, value: 80, key: "progress" },
    { label: "Played color", setup: { layout: "wave" }, value: COLOR, key: "progressColor" },
    { label: "Track color", setup: { layout: "player" }, value: COLOR, key: "progressTrackColor" },
    { label: "Waveform shape", setup: { layout: "wave" }, value: 7, key: "waveSeed" },
    { label: "Stub color", setup: { layout: "ticket" }, value: COLOR, key: "stubBackground" },
    { label: "Stub text color", setup: { layout: "ticket" }, value: COLOR, key: "stubTextColor" },
    { label: "Picture box color", setup: { layout: "cover", backgroundImage: "https://example.test/bg.jpg" }, value: COLOR, key: "stubBackground" },
    {
      label: "Alt text color",
      setup: { layout: "gallery", gallery: [{ src: "https://example.test/1.jpg", alt: "One" }] },
      value: COLOR,
      key: "stubTextColor",
    },
    { label: "Button width", setup: { layout: "poster" }, value: true, key: "ctaFullWidth" },
  ];

  for (const c of CASES) {
    test(`${c.label} → ${c.key} : écrit, et l'e-mail change`, async () => {
      const b = callout(c.setup);
      const before = await html(b.doc);
      change(control(editor(b), c.label, GROUP), c.value);
      expect((b.block() as Record<string, unknown>)[c.key]).toEqual(c.value);
      const after = await html(b.doc);
      expect(after).not.toBe(before);
      if (typeof c.value === "string" && c.value.startsWith("#")) expect(after.toLowerCase()).toContain(COLOR.toLowerCase());
    });
  }

  test("Layout → « Classic panel » RETIRE la clé : l'encart d'avant, à l'octet près", async () => {
    const classic = await html(callout().doc);
    const b = callout({ layout: "ticket" });
    change(control(editor(b), "Layout", GROUP), "classic");
    expect((b.block() as { layout?: string }).layout).toBeUndefined();
    expect(await html(b.doc)).toBe(classic);
  });

  test("les champs suivent la mise en page : rien d'une Onde sous une Affiche, rien du tout sans mise en page", () => {
    const labels = (b: ReturnType<typeof bench>) =>
      leaves(editor(b))
        .filter((l) => l.groups.includes(GROUP))
        .map((l) => String(l.props.label ?? l.props.srcLabel ?? l.name));
    expect(labels(callout())).toEqual(["Layout", "Note"]);
    const poster = labels(callout({ layout: "poster" }));
    expect(poster.includes("Waveform shape") || poster.includes("Stub color") || poster.includes("Played share")).toBe(false);
    expect(poster.includes("Picture height")).toBe(true);
    const wave = labels(callout({ layout: "wave" }));
    expect(wave.includes("Waveform shape") && wave.includes("Played share")).toBe(true);
    expect(wave.includes("Picture height") || wave.includes("Add a background picture")).toBe(false);
  });

  test("photo de fond : ajout, URL, bibliothèque, retrait — et chaque geste change l'e-mail", async () => {
    type C = Extract<Block, { type: "callout" }>;
    const b = callout({ layout: "poster" });
    const vide = await html(b.doc);
    click(control(editor(b), "Add a background picture", GROUP));
    expect(b.block<C>().backgroundImage).toBe("https://placehold.co/1200x720");
    const posee = await html(b.doc);
    expect(posee).not.toBe(vide);
    expect(posee).toContain("<v:rect");

    media(b, "Background picture").onSrc("https://example.test/typed.jpg");
    expect(await html(b.doc)).toContain('background="https://example.test/typed.jpg"');
    media(b, "Background picture").onPick({ src: "https://example.test/picked.jpg", alt: "ignored" });
    expect(b.block<C>().backgroundImage).toBe("https://example.test/picked.jpg");
    // La photo de fond n'a pas de champ alt : il n'irait nulle part (le texte est posé dessus).
    expect(media(b, "Background picture").onAlt).toBeUndefined();

    click(control(editor(b), "Remove background picture", GROUP));
    expect(await html(b.doc)).toBe(vide);
  });

  test("galerie : ajout jusqu'à 3, URL et alt par case, retrait — la liste réécrite en entier", async () => {
    type C = Extract<Block, { type: "callout" }>;
    const b = callout({ layout: "gallery" });
    const vide = await html(b.doc);
    for (let n = 1; n <= 3; n++) click(control(editor(b), "Add a gallery picture", GROUP));
    expect(b.block<C>().gallery?.length).toBe(3);
    // À 3, le bouton d'ajout disparaît : le schéma n'en accepte pas une quatrième.
    expect(leaves(editor(b)).some((l) => l.props.label === "Add a gallery picture")).toBe(false);
    expect(await html(b.doc)).not.toBe(vide);

    media(b, "Picture 2").onSrc("https://example.test/two.jpg");
    media(b, "Picture 2").onAlt?.("Two");
    expect(b.block<C>().gallery?.[1]).toEqual({ src: "https://example.test/two.jpg", alt: "Two" });
    expect(b.block<C>().gallery?.[0]).toEqual({ src: "https://placehold.co/400x400", alt: "" });
    expect(await html(b.doc)).toContain('<a href="https://example.test/listen" target="_blank"><img src="https://example.test/two.jpg"');

    for (let n = 1; n <= 3; n++) click(control(editor(b), "Remove picture 1", GROUP));
    // La dernière case retirée : la clé disparaît (le schéma exige au moins une case).
    expect(b.block<C>().gallery).toBeUndefined();
    expect(await html(b.doc)).toBe(vide);
  });
});
