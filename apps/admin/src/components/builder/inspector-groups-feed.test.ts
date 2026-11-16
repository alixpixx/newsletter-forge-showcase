/**
 * LE FLUX D'ARTICLES DANS LA COLONNE CONTENT (lot L4 de la refonte, 23/09/2026) — `bun test` depuis la racine.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER :
 *   1. l'aperçu renvoyé en bas de la colonne : c'est le retour de la requête (Source / Filters /
 *      Selection), et il arrivait à 2 400 px, sous quatre looks ;
 *   2. un réglage d'apparence du flux resté à plat, ou un groupe qui s'ouvre tout seul, ou sans résumé ;
 *   3. la une et les brèves sous le même `id` de groupe : elles s'ouvriraient et se fermeraient
 *      ensemble. Le garde statique de L1 (`inspector-groups.test.ts`) ne voit que les `id`
 *      LITTÉRAUX ; ici, on relève les `id` RÉELLEMENT portés par l'arbre rendu, une et brèves montées
 *      toutes les deux — un `id` calculé (`idPrefix`) ou un littéral dans un composant monté deux fois
 *      y est attrapé ;
 *   4. le correctif `9f626bd` défait par le rangement : « Arrangement » et « Lead cards » repliés, ou
 *      l'avertissement de une caché dans un groupe fermé ;
 *   5. un réglage de texte sur le filet entre les cartes, qui n'en dessine aucun.
 *
 * Deux façons de regarder, chacune là où l'autre ne peut pas :
 *   • `FeedEditor` porte des hooks (sources, aperçu) : l'ORDRE de la colonne se lit sur le rendu RÉEL
 *     de l'inspecteur (`renderToStaticMarkup`, le même que l'audit a mesuré) ;
 *   • les champs, leurs groupes, leur état ouvert / fermé et leurs écritures se lisent en appelant les
 *     composants sans hook comme des fonctions, exactement comme `inspector-controls.test.ts`.
 *
 * ⛔ Les attendus sont écrits EN DUR (libellés, clés, résumés) : un banc qui recalculerait sa
 * référence avec le code qu'il surveille ne mesurerait que lui-même.
 */
import { describe, expect, test } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compileDoc } from "@nf/render/compile";
import { EmailDoc, type ArticleFeedBlock, type BoxStyle, type Theme } from "@nf/render/schema";
import type { BuilderAction, FeedPart } from "./reducer";
import { ArticleLookFields, CardRuleFields, FeedLookSections, FontInput, MidSectionFields } from "./article-look-fields";
import { CardButtonFields } from "./extra-fields";
import { ChoiceInput, Group } from "./inspector-ui";
import { FeedCardFields, Inspector, StylePanel } from "./inspector";

/* ------------------------------------------------------------------ *
 * Banc
 * ------------------------------------------------------------------ */

/** Composants sans hook, dépliés (le même jeu que le banc des contrôles pour le flux). */
const EXPAND = new Set<unknown>([
  Group,
  FeedCardFields,
  FeedLookSections,
  ArticleLookFields,
  MidSectionFields,
  CardRuleFields,
  FontInput,
  ChoiceInput,
  CardButtonFields,
]);

interface GroupSeen {
  id?: string;
  title: string;
  summary?: string;
  /** L'état servi au premier affichage : `open` du `<details>` que `Group` rend. */
  open: boolean;
}

interface Leaf {
  name: string;
  props: Record<string, unknown>;
  /** Les `Group` traversés, du plus extérieur au plus proche. */
  groups: GroupSeen[];
}

/** Les feuilles d'un arbre, et pour chacune les groupes traversés avec leur état. */
function leaves(node: ReactNode, groups: GroupSeen[] = [], out: Leaf[] = []): Leaf[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) leaves(n as ReactNode, groups, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const type = node.type as unknown;
  const props = node.props as Record<string, unknown>;
  if (typeof type === "function") {
    if (type === Group) {
      // `Group` appelé comme une fonction : on lit l'état que son `<details>` sert vraiment.
      const details = (Group as (p: unknown) => ReactNode)(props) as unknown as { props: { open?: boolean } };
      const seen: GroupSeen = {
        id: props.id as string | undefined,
        title: String(props.title),
        summary: props.summary as string | undefined,
        open: details.props.open === true,
      };
      leaves(props.children as ReactNode, [...groups, seen], out);
    } else if (EXPAND.has(type)) {
      leaves((type as (p: unknown) => ReactNode)(props), groups, out);
    } else {
      out.push({ name: type.name, props, groups });
    }
    return out;
  }
  return leaves(props.children as ReactNode, groups, out);
}

/** Les contrôles : les feuilles qui portent un libellé à l'écran. */
const controls = (tree: ReactNode) => leaves(tree).filter((l) => typeof l.props.label === "string");

function control(tree: ReactNode, label: string): Leaf {
  const found = controls(tree).filter((l) => l.props.label === label);
  if (found.length !== 1) throw new Error(`expected exactly one control “${label}”, found ${found.length}`);
  return found[0];
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
  return EmailDoc.parse({
    schema: 2,
    meta: { subject: "Banc", preheader: "", assetSlug: "demo-brand", locale: "en" },
    theme: {},
    rows: [
      {
        id: "row_1",
        layout: "1",
        columns: [
          {
            id: "col_1",
            blocks: [
              {
                id: "blk_1",
                type: "article-feed",
                sourceId: "src_1",
                count: 3,
                previewItems: [ITEM(1), ITEM(2), ITEM(3)],
                previewAt: "2026-09-22T12:00:00.000Z",
                ...settings,
              },
            ],
          },
        ],
      },
    ],
  });
}

const feedOf = (doc: EmailDoc) => doc.rows[0].columns[0].blocks[0] as ArticleFeedBlock;

/** Le flux « rempli » de l'audit : une posée avec son look, titre de section, filet, surtitres. */
const FILLED = {
  orderby: "views",
  leadCount: 1,
  showKicker: true,
  lead: { kickerMode: "text", kickerText: "Destacada" },
  midSection: { label: "Más noticias" },
  cardRule: { thickness: 1 },
};

/** Ce qu'une écriture a envoyé : `patch` et `dispatch` espions. */
function spies() {
  const patches: Record<string, unknown>[] = [];
  const actions: BuilderAction[] = [];
  return {
    patches,
    actions,
    patch: (p: Record<string, unknown>) => void patches.push(p),
    dispatch: (a: BuilderAction) => void actions.push(a),
  };
}

const cardsOf = (block: ArticleFeedBlock, s = spies()) =>
  FeedCardFields({ block, patch: s.patch as never, dispatch: s.dispatch, locale: "en" });

/** Le panneau Style que le flux monte dans ses looks, appelé comme une fonction (il n'a pas de hook). */
const styleOf = (theme: Theme) => (style: BoxStyle | undefined, onChange: (next: BoxStyle | undefined) => void, opts?: { typography?: boolean }) =>
  StylePanel({
    scope: "block",
    style,
    onChange,
    theme,
    parents: [],
    defaultPadding: theme.blockPadding,
    typography: opts?.typography,
  });

/** Tout ce que `FeedEditor` monte sous « Cards », dans son ordre : ses réglages de cartes, puis les looks. */
function feedTree(doc: EmailDoc) {
  const block = feedOf(doc);
  const s = spies();
  const patchPart = (_part: FeedPart, _p: Record<string, unknown> | null) => {};
  return [
    cardsOf(block, s),
    FeedLookSections({
      block,
      locale: "en",
      theme: doc.theme,
      layers: [],
      patchPart,
      renderStyle: styleOf(doc.theme),
    }),
  ];
}

/* ------------------------------------------------------------------ *
 * 1. L'ordre de la colonne, sur le rendu réel de l'inspecteur
 * ------------------------------------------------------------------ */

describe("flux — l'aperçu suit la requête, avant les looks (rendu réel)", () => {
  const page = renderToStaticMarkup(
    createElement(Inspector, { doc: feedDoc(FILLED), selection: { kind: "block", id: "blk_1" }, dispatch: () => {} }),
  );
  // La colonne du flux commence à sa première note : l'en-tête de l'inspecteur, au-dessus, dit
  // « Selection » lui aussi.
  const html = page.slice(page.indexOf("This block stores a"));
  test("le rendu contient bien l'éditeur du flux", () => {
    expect(page.indexOf("This block stores a")).toBeGreaterThan(0);
  });
  /** Position d'un repère, qui doit exister une seule fois dans la colonne. */
  const at = (marker: string) => {
    const i = html.indexOf(marker);
    expect({ marker, found: i >= 0 }).toEqual({ marker, found: true });
    expect({ marker, again: html.indexOf(marker, i + 1) }).toEqual({ marker, again: -1 });
    return i;
  };

  test("Source → Filters → Selection → Preview → Cards → Card looks", () => {
    const order = [">Source<", ">Filters<", ">Selection<", ">Preview<", "Refresh preview</button>", ">Cards<", ">Card looks<"];
    const positions = order.map(at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("l'aperçu vient avant le premier groupe repliable et avant chaque look", () => {
    const preview = at("Refresh preview</button>");
    expect(html.indexOf("<details")).toBeGreaterThan(preview);
    for (const look of [">Lead card<", ">Other cards<", ">Section between them<", ">Rule between cards<"]) {
      expect({ look, before: preview < at(look) }).toEqual({ look, before: true });
    }
  });

  test("ce qu'on choisit d'abord reste à plat : source, nombre d'articles, Arrangement, Lead cards avant tout groupe", () => {
    const firstGroup = html.indexOf("<details");
    expect(firstGroup).toBeGreaterThan(0);
    // `html.indexOf` : la PREMIÈRE occurrence — « Arrangement » revient plus bas dans chaque look.
    for (const marker of [">Source<", "How many</label>", "Arrangement</label>", "Lead cards</label>"]) {
      expect({ marker, flat: html.indexOf(marker) >= 0 && html.indexOf(marker) < firstGroup }).toEqual({ marker, flat: true });
    }
  });
});

describe("flux — la ligne d'état de l'aperçu est une phrase ponctuée (rendu réel)", () => {
  /** La ligne sous « Refresh preview », jusqu'au début de sa seconde phrase. */
  const line = (settings: Record<string, unknown>) => {
    const page = renderToStaticMarkup(
      createElement(Inspector, { doc: feedDoc(settings), selection: { kind: "block", id: "blk_1" }, dispatch: () => {} }),
    ).replace(/<!-- -->/g, "");
    const end = page.indexOf(" The no-repeat window");
    expect(end).toBeGreaterThan(0);
    return page.slice(page.lastIndexOf(">", end) + 1, end + " The no-repeat window".length);
  };

  test("sans date d'aperçu (modèle importé), la première phrase garde son point", () => {
    expect(line({ previewAt: undefined })).toBe("3 articles in the preview. The no-repeat window");
    expect(line({ previewItems: [ITEM(1)], previewAt: undefined })).toBe("1 article in the preview. The no-repeat window");
  });

  test("avec la date, et sans aperçu : inchangés", () => {
    expect(line({})).toBe("3 articles in the preview, taken 2026-09-22 12:00 UTC. The no-repeat window");
    expect(line({ previewItems: [], previewAt: undefined })).toBe("Nothing previewed yet. The no-repeat window");
  });
});

/* ------------------------------------------------------------------ *
 * 2. Le correctif 9f626bd, intact sous le rangement
 * ------------------------------------------------------------------ */

describe("flux — le correctif 9f626bd reste en tête, hors groupe", () => {
  const BOLETIN = {
    layout: "side",
    leadCount: 1,
    card: { layout: "side", kickerMode: "category-time" },
    midSection: { label: "Más noticias" },
  };

  test("« Arrangement » puis « Lead cards » : les deux premiers contrôles, hors de tout groupe", () => {
    const first = controls(cardsOf(feedOf(feedDoc(BOLETIN)))).slice(0, 2);
    expect(first.map((l) => [l.props.label, l.groups.length])).toEqual([
      ["Arrangement", 0],
      ["Lead cards", 0],
    ]);
  });

  test("« Arrangement » montre la valeur effective et écrit bloc + look en UN pas (`batch`)", () => {
    const s = spies();
    const arrangement = control(cardsOf(feedOf(feedDoc({ ...BOLETIN, layout: "stacked" })), s), "Arrangement");
    expect(arrangement.props.value).toBe("side");
    (arrangement.props.onChange as (v: string) => void)("stacked");
    expect(s.actions).toHaveLength(1);
    expect(s.actions[0]).toEqual({
      type: "batch",
      actions: [
        { type: "updateBlock", blockId: "blk_1", patch: { layout: "stacked" } },
        { type: "updateBlockPart", blockId: "blk_1", part: "card", patch: { layout: undefined } },
      ],
    });
  });

  test("le repère de la une et l'avertissement « no lead look » restent visibles, hors groupe", () => {
    const tree = cardsOf(feedOf(feedDoc({ layout: "side", leadCount: 1, lead: { layout: "stacked" } })));
    expect(control(tree, "Arrangement").props.hint).toBe(
      "Applies to the other cards. The lead card keeps its own arrangement (Stacked) — change it under “Lead card” below.",
    );
    const warn = leaves(cardsOf(feedOf(feedDoc({ leadCount: 1 })))).filter((l) => l.name === "Note" && l.props.tone === "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0].groups).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Sous-sections fermées, résumées
 * ------------------------------------------------------------------ */

/** Les clés que [Kicker & time] écrit — en dur, relevées sur les champs du 23/09/2026. */
const KICKER_TIME_KEYS = ["showKicker", "timeZone", "timeFormat", "timeColor", "kickerSeparator"];

describe("flux — [Kicker & time] et [Read link] : fermés, résumés, dans l'ordre de lecture", () => {
  test("leurs champs, leur id, fermés au premier affichage", () => {
    const tree = cardsOf(feedOf(feedDoc({ showKicker: true, leadCount: 1, lead: { ctaStyle: "link" } })));
    const where = controls(tree).map((l) => [l.props.label, l.groups.map((g) => `${g.id}|${g.title}|${g.open}`).join(" > ")]);
    expect(where).toEqual([
      ["Arrangement", ""],
      ["Lead cards", ""],
      ["Kicker", "article-feed.kicker-time|Kicker & time|false"],
      ["Time zone", "article-feed.kicker-time|Kicker & time|false"],
      ["Time format", "article-feed.kicker-time|Kicker & time|false"],
      ["Time color", "article-feed.kicker-time|Kicker & time|false"],
      ["Kicker separator", "article-feed.kicker-time|Kicker & time|false"],
      ["Read link style — every card", "article-feed.read-link|Read link|false"],
      ["CTA label", "article-feed.read-link|Read link|false"],
    ]);
  });

  test("le résumé compte EXACTEMENT les clés que les champs du groupe écrivent", () => {
    // 1. Ce que chaque champ de [Kicker & time] écrit, déclenché pour de vrai.
    const s = spies();
    const tree = cardsOf(feedOf(feedDoc({ showKicker: true })), s);
    const values: Record<string, unknown> = {
      Kicker: true,
      "Time zone": "Europe/Paris",
      "Time format": "12h",
      "Time color": "#123456",
      "Kicker separator": " | ",
    };
    for (const leaf of controls(tree).filter((l) => l.groups.some((g) => g.id === "article-feed.kicker-time"))) {
      (leaf.props.onChange as (v: unknown) => void)(values[String(leaf.props.label)]);
    }
    expect(new Set(s.patches.flatMap((p) => Object.keys(p)))).toEqual(new Set(KICKER_TIME_KEYS));

    // 2. Et le résumé les compte, ni plus ni moins.
    const summary = (settings: Record<string, unknown>) =>
      leaves(cardsOf(feedOf(feedDoc(settings)))).flatMap((l) => l.groups).find((g) => g.id === "article-feed.kicker-time")?.summary;
    expect(summary({})).toBe("defaults");
    expect(summary({ showKicker: true, timeZone: "Europe/Paris", timeColor: "#123456" })).toBe("3 set");
    expect(
      summary({ showKicker: true, timeZone: "Europe/Paris", timeFormat: "12h", timeColor: "#123456", kickerSeparator: " | " }),
    ).toBe("5 set");
    // Une clé d'un AUTRE groupe ne compte pas ici.
    expect(summary({ ctaLabel: "Leer" })).toBe("defaults");

    // 3. [Read link] : ce que ses champs écrivent, déclenché pour de vrai, puis ce que son résumé compte.
    const r = spies();
    const readTree = cardsOf(feedOf(feedDoc({})), r);
    const readValues: Record<string, unknown> = { "Read link style — every card": "link", "CTA label": "Leer" };
    const inReadLink = controls(readTree).filter((l) => l.groups.some((g) => g.id === "article-feed.read-link"));
    expect(inReadLink.map((l) => l.props.label)).toEqual(["Read link style — every card", "CTA label"]);
    for (const leaf of inReadLink) (leaf.props.onChange as (v: unknown) => void)(readValues[String(leaf.props.label)]);
    expect(new Set(r.patches.flatMap((p) => Object.keys(p)))).toEqual(new Set(["ctaStyle", "ctaLabel"]));

    const readLink = (settings: Record<string, unknown>) =>
      leaves(cardsOf(feedOf(feedDoc(settings)))).flatMap((l) => l.groups).find((g) => g.id === "article-feed.read-link")?.summary;
    expect(readLink({})).toBe("defaults");
    expect(readLink({ ctaLabel: "Leer la nota" })).toBe("1 set");
    expect(readLink({ ctaStyle: "none" })).toBe("1 set");
    expect(readLink({ ctaStyle: "link", ctaLabel: "Leer la nota" })).toBe("2 set");
    // Une clé d'un AUTRE groupe ne compte pas ici.
    expect(readLink({ showKicker: true, timeZone: "Europe/Paris" })).toBe("defaults");
  });

  test("[Read link] : le texte sous le sélecteur suit la forme choisie juste au-dessus", () => {
    // Lien retiré par le sélecteur du groupe, aucun look ne pose sa forme : c'est LUI qu'il faut changer.
    const notes = (settings: Record<string, unknown>) =>
      leaves(cardsOf(feedOf(feedDoc(settings))))
        .filter((l) => l.name === "Note" && l.groups.some((g) => g.id === "article-feed.read-link"))
        .map((l) => [l.props.children].flat(Infinity).join(""));
    expect(notes({ ctaStyle: "none" })).toEqual([
      "No read link is sent on any card, so there is no label to set. Pick Button or Link above to bring it back.",
    ]);
    // Un look reprend la main (sa propre forme, son propre libellé) : c'est dans le look qu'on change.
    expect(notes({ ctaStyle: "none", card: { ctaStyle: "button", ctaLabel: "Leer" } })).toEqual([
      "No card reads a block-wide read-link label: each look below sets its own label or removes the read link. Change it there.",
    ]);
    expect(notes({})).toEqual([]);
    // Le repère du libellé nomme la forme que le sélecteur a posée.
    const hint = (settings: Record<string, unknown>) => String(control(cardsOf(feedOf(feedDoc(settings))), "CTA label").props.hint);
    expect(hint({}).startsWith("The read link under every card — a button unless a card look says otherwise.")).toBe(true);
    expect(hint({ ctaStyle: "link" }).startsWith("The read link under every card — an underlined link unless a card look says otherwise.")).toBe(
      true,
    );
  });

  test("les looks montés par le flux : tout réglage est dans un groupe fermé et résumé", () => {
    const loose: string[] = [];
    for (const leaf of controls(feedTree(feedDoc(FILLED)))) {
      const label = String(leaf.props.label);
      // La tête, voulue à plat. (« Read link style — every card » n'y figure plus : il est dans
      // [Read link] depuis l'intégration, fermé et résumé comme le reste.)
      if (["Arrangement", "Lead cards"].includes(label)) continue;
      if (leaf.groups.length === 0) loose.push(`${label}: hors groupe`);
      for (const g of leaf.groups) {
        if (g.open) loose.push(`${label}: « ${g.title} » ouvert d'emblée`);
        if (!g.summary) loose.push(`${label}: « ${g.title} » sans résumé`);
      }
    }
    expect(loose).toEqual([]);
    // Le banc a bien vu les quatre looks et leur panneau de boîte : sinon il serait vert pour rien.
    const titles = new Set(leaves(feedTree(feedDoc(FILLED))).flatMap((l) => l.groups.map((g) => g.title)));
    for (const t of ["Kicker & time", "Read link", "Lead card", "Other cards", "Section between them", "Rule between cards", "Rule box"]) {
      expect({ t, seen: titles.has(t) }).toEqual({ t, seen: true });
    }
    expect(controls(feedTree(feedDoc(FILLED))).filter((l) => l.props.label === "Font size").length).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Ids : uniques dans l'arbre RENDU, une et brèves montées ensemble
 * ------------------------------------------------------------------ */

describe("flux — ids de groupe uniques dans l'arbre rendu (une et brèves comprises)", () => {
  test("aucun id porté deux fois, et ceux du flux n'empiètent pas sur les préfixes des looks", () => {
    // Chaque `Group` rendu est UN objet, partagé par toutes ses feuilles : on compte les groupes, pas
    // les feuilles.
    const groups = [...new Set(leaves(feedTree(feedDoc(FILLED))).flatMap((l) => l.groups))];
    const where = new Map<string, string[]>();
    for (const g of groups) if (g.id !== undefined) where.set(g.id, [...(where.get(g.id) ?? []), g.title]);
    const doubles = [...where].filter(([, titles]) => titles.length > 1).map(([id, titles]) => `${id} → ${titles.join(" | ")}`);
    expect(doubles).toEqual([]);
    const ids = [...where.keys()];

    expect(ids).toContain("article-feed.kicker-time");
    expect(ids).toContain("article-feed.read-link");
    // `article-feed.lead.*` et `article-feed.card.*` sont les sous-sections des looks (lot L2).
    for (const id of ["article-feed.kicker-time", "article-feed.read-link"]) {
      expect(id.startsWith("article-feed.lead.") || id.startsWith("article-feed.card.")).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. Le filet entre les cartes : pas de réglage de texte sans effet
 * ------------------------------------------------------------------ */

/** Les huit réglages de texte du panneau Style, et la clé que chacun écrit. */
const TEXT_SETTINGS: [label: string, key: keyof BoxStyle, value: unknown][] = [
  ["Text color", "textColor", "#ff0000"],
  ["Link color", "linkColor", "#00ff00"],
  ["Font family", "fontFamily", "Georgia, serif"],
  ["Font size", "fontSize", 30],
  ["Line height", "lineHeight", 2],
  ["Font weight", "fontWeight", "900"],
  ["Letter spacing", "letterSpacing", 3],
  ["Text case", "textTransform", "uppercase"],
];

describe("filet entre les cartes — la boîte sans réglage de texte", () => {
  test("compilé : les 8 réglages de texte du filet ne changent pas l'e-mail, l'alignement si", async () => {
    // Un filet à 50 % : c'est là que l'alignement se voit.
    const html = async (style?: Record<string, unknown>) =>
      (await compileDoc(feedDoc({ cardRule: { widthPct: 50, ...(style ? { style } : {}) } }))).html;
    const base = await html();
    for (const [label, key, value] of TEXT_SETTINGS) {
      expect({ label, same: (await html({ [key]: value })) === base }).toEqual({ label, same: true });
    }
    expect((await html({ align: "right" })) === base).toBe(false);
  });

  test("StylePanel typography=false : les 8 réglages de texte disparaissent, alignement, boîte et bordure restent", () => {
    const theme = feedDoc().theme;
    const labels = (typography?: boolean) =>
      controls(styleOf(theme)(undefined, () => {}, typography === undefined ? undefined : { typography })).map((l) => l.props.label);
    const full = labels();
    const rule = labels(false);
    for (const [label] of TEXT_SETTINGS) {
      expect({ label, full: full.includes(label), rule: rule.includes(label) }).toEqual({ label, full: true, rule: false });
    }
    for (const label of ["Background color", "Padding (px)", "Content alignment", "Border width", "Border color", "Corner radius"]) {
      expect({ label, rule: rule.includes(label) }).toEqual({ label, rule: true });
    }
    expect(labels(true)).toEqual(full);
    // L'intertitre dit ce qui reste.
    const titles = (typography?: boolean) =>
      leaves(styleOf(theme)(undefined, () => {}, { typography }))
        .filter((l) => l.name === "SectionTitle")
        .map((l) => l.props.children);
    expect(titles(false)).toEqual(["Box", "Alignment", "Border"]);
    expect(titles(undefined)).toEqual(["Box", "Typography", "Border"]);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Intégration avec L2 : deux fils à poser dans `article-look-fields.tsx`
 * ------------------------------------------------------------------ */

describe("INTÉGRATION L2 ↔ L4 — les deux fils posés dans `article-look-fields.tsx`", () => {
  /**
   * Le filet est monté par `CardRuleFields` (`article-look-fields.tsx`) : il appelle
   * `renderStyle(rule.style, …, { typography: false })`. Le titre de section, lui, garde son texte.
   * (Posé en `test.failing` par L4 tant que le fil manquait ; branché à l'intégration du 23/09/2026.)
   */
  test("INTÉGRATION L2 : [Rule box] monte le panneau sans réglage de texte, et lui seul", () => {
    const seen: (string | undefined)[] = [];
    const spy = (who: string) => (_s: BoxStyle | undefined, _c: unknown, opts?: { typography?: boolean }) => {
      seen.push(`${who}:${opts?.typography === false ? "no-text" : "text"}`);
      return null;
    };
    const theme = feedDoc().theme;
    CardRuleFields({ rule: { thickness: 1 }, theme, patchPart: () => {}, renderStyle: spy("rule") as never });
    MidSectionFields({ mid: { label: "M" }, theme, patchPart: () => {}, renderStyle: spy("mid") as never, leadOn: true });
    expect(seen).toEqual(["rule:no-text", "mid:text"]);
  });

  /**
   * L'audit (§3.3, L4) range « Read link style — every card » dans [Read link], à côté de « CTA
   * label ». Il a quitté `FeedLookSections` pour `FeedCardFields` : présent aux deux endroits, il
   * s'afficherait deux fois (et `control()` du banc des contrôles échouerait sur le doublon).
   * (Posé en `test.failing` par L4 ; déménagé à l'intégration du 23/09/2026.)
   */
  test("INTÉGRATION L2 : « Read link style — every card » vit dans [Read link], plus dans Card looks", () => {
    const doc = feedDoc(FILLED);
    const inCards = control(cardsOf(feedOf(doc)), "Read link style — every card");
    expect(inCards.groups.map((g) => g.id)).toEqual(["article-feed.read-link"]);
    const inLooks = controls(feedTree(doc)).filter((l) => l.props.label === "Read link style — every card");
    expect(inLooks).toHaveLength(1);
  });
});
