/**
 * L'ARTICLE ET LES LOOKS DU FLUX EN SOUS-SECTIONS (`article-look-fields.tsx`, lot L2 du 23/09/2026)
 * — `bun test` depuis la racine.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER :
 *   1. un champ que l'auteur TAPE (surtitre, image, ligne de pied) renvoyé au milieu de l'apparence :
 *      le 23/09/2026, il fallait descendre à 1 517 px pour taper le surtitre d'un article ;
 *   2. un réglage d'apparence qui ressort de son groupe : la colonne redéroulerait à plat (3 996 px
 *      pour un article, 5 500 px pour un look de flux ouvert) ;
 *   3. la une et les brèves sous le même préfixe d'`id` : leurs sous-sections s'ouvriraient et se
 *      fermeraient ensemble. Le garde des `id` LITTÉRAUX (`inspector-groups.test.ts`) ne voit pas un
 *      `id` calculé (`${prefix}.title`) : c'est ici qu'on le voit, au rendu ;
 *   4. un deuxième vocabulaire de résumé (« customised », « on », « 2 settings »…) : il n'y en a
 *      qu'un, celui d'`overrides()` — « defaults » ou « N set ».
 *
 * Les composants sans hook sont appelés comme des fonctions (même principe que le banc des
 * contrôles) ; les emplacements éditoriaux d'`ArticleEditor` sont remplacés par des TÉMOINS
 * (`<i data-slot>`), pour savoir où ils atterrissent sans monter `inspector.tsx`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactNode } from "react";
import ts from "typescript";
import { ArticleLook, EmailDoc, type ArticleFeedBlock, type Block } from "@nf/render/schema";
import {
  ArticleLookFields,
  CardRuleFields,
  FeedLookSections,
  FontInput,
  LOOK_GROUP_KEYS,
  MidSectionFields,
  resolveLookBase,
  type ArticleLookFieldsProps,
} from "./article-look-fields";
import { CardButtonFields } from "./extra-fields";
import { SectionTitle } from "./fields";
import { ChoiceInput, Group, Note } from "./inspector-ui";

/* ------------------------------------------------------------------ *
 * Banc : le plan de ce qui est rendu
 * ------------------------------------------------------------------ */

type Item =
  | { kind: "group"; id?: string; title: string; summary?: string; open: boolean; path: string[] }
  | { kind: "section"; text: string; path: string[] }
  | { kind: "slot"; slot: string; path: string[] }
  | { kind: "note"; path: string[] }
  | { kind: "control"; label: string; path: string[] };

/** Composants sans hook, dépliés. Tout autre composant est un contrôle (une feuille). */
const EXPAND = new Set<unknown>([
  ArticleLookFields,
  FeedLookSections,
  MidSectionFields,
  CardRuleFields,
  FontInput,
  ChoiceInput,
  CardButtonFields,
]);

const text = (node: unknown): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(text).join("")
      : "";

/** Le plan, dans l'ordre d'affichage. `path` = les titres des `Group` traversés pour y arriver. */
function plan(node: unknown, path: string[] = [], out: Item[] = []): Item[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) plan(n, path, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const type = node.type as unknown;
  const props = node.props as Record<string, unknown>;
  if (type === Group) {
    // Appelé comme une fonction, comme le fait le banc des contrôles : `open` est l'état servi.
    const details = Group(props as Parameters<typeof Group>[0]) as { props: { open?: boolean } };
    out.push({
      kind: "group",
      id: props.id as string | undefined,
      title: String(props.title),
      summary: props.summary as string | undefined,
      open: details.props.open === true,
      path,
    });
    return plan(props.children, [...path, String(props.title)], out);
  }
  if (type === SectionTitle) {
    out.push({ kind: "section", text: text(props.children), path });
    return out;
  }
  if (type === Note) {
    out.push({ kind: "note", path });
    return out;
  }
  if (typeof type === "function") {
    if (EXPAND.has(type)) return plan((type as (p: unknown) => ReactNode)(props), path, out);
    out.push({ kind: "control", label: String(props.label), path });
    return out;
  }
  if (typeof props["data-slot"] === "string") {
    out.push({ kind: "slot", slot: props["data-slot"], path });
    return out;
  }
  return plan(props.children, path, out);
}

const groups = (items: Item[]) => items.filter((i): i is Extract<Item, { kind: "group" }> => i.kind === "group");
const controls = (items: Item[]) => items.filter((i): i is Extract<Item, { kind: "control" }> => i.kind === "control");
const slot = (name: string) => createElement("i", { "data-slot": name });

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

function blockOf(block: Record<string, unknown>) {
  const doc = EmailDoc.parse({
    schema: 2,
    meta: { subject: "Banc", preheader: "", assetSlug: "demo-brand", locale: "en" },
    theme: {},
    rows: [{ id: "row_1", layout: "1", columns: [{ id: "col_1", blocks: [{ id: "blk_1", ...block }] }] }],
  });
  return { theme: doc.theme, block: doc.rows[0].columns[0].blocks[0] as Block };
}

/** L'article tel qu'`ArticleEditor` le monte : ses trois emplacements éditoriaux sont des témoins. */
function article(settings: Record<string, unknown> = {}) {
  const { theme, block } = blockOf({
    type: "article",
    title: "Un titre",
    excerpt: "",
    imageAlt: "",
    href: "https://example.test/a",
    ...settings,
  });
  const value = block as Extract<Block, { type: "article" }>;
  return plan(
    ArticleLookFields({
      mode: "article",
      value,
      onPatch: () => {},
      theme,
      base: resolveLookBase(theme, [value.style]),
      accent: { color: theme.brandColor, from: "the brand colour" },
      cta: { inherited: "Read more", inheritedFrom: "this document's language", hint: "" },
      slots: { kicker: slot("kicker"), image: slot("image"), meta: slot("meta") },
    }),
  );
}

/** Un look seul, monté comme `FeedLookSections` le monte (préfixe fourni ou non). */
function look(extra: Partial<ArticleLookFieldsProps> = {}) {
  const { theme } = blockOf({ type: "article-feed", sourceId: "src_1", count: 3 });
  return plan(
    ArticleLookFields({
      mode: "look",
      value: {},
      onPatch: () => {},
      theme,
      base: resolveLookBase(theme, []),
      accent: { color: theme.brandColor, from: "the brand colour" },
      cta: { hint: "" },
      renderStyle: () => slot("style"),
      ...extra,
    }),
  );
}

/** Les quatre apparences d'un flux, avec un panneau de style témoin, TELLES QUE MONTÉES (racine comprise). */
function feedRaw(settings: Record<string, unknown> = {}) {
  const { theme, block } = blockOf({ type: "article-feed", sourceId: "src_1", count: 3, ...settings });
  return plan(
    FeedLookSections({
      block: block as ArticleFeedBlock,
      locale: "en",
      theme,
      layers: [],
      patchPart: () => {},
      renderStyle: () => slot("style"),
    }),
  );
}

/**
 * Les quatre apparences, chemins RELATIFS au groupe « Card looks ». Depuis le 24/09/2026 (feature 5,
 * étape 6), tout vit dans ce groupe replié, sous les styles prêts : il ouvre la liste, fermé, et tout le
 * reste est dedans (tenu ici à chaque appel, pour que les bancs ci-dessous gardent leurs chemins).
 */
function feed(settings: Record<string, unknown> = {}) {
  const [racine, ...reste] = feedRaw(settings);
  if (racine?.kind !== "group" || racine.id !== "article-feed.looks" || racine.title !== "Card looks" || racine.open)
    throw new Error("« Card looks » doit ouvrir le flux, fermé, sous l'id article-feed.looks");
  return reste.map((i) => {
    if (i.path[0] !== "Card looks") throw new Error(`hors de « Card looks » : ${JSON.stringify(i)}`);
    return { ...i, path: i.path.slice(1) };
  });
}

/** Les sous-sections d'apparence, dans l'ordre de lecture de la carte. */
const PARTS = [
  ["kicker", "Kicker"],
  ["image", "Image & layout"],
  ["title", "Title"],
  ["excerpt", "Excerpt"],
  ["meta", "Meta line"],
  ["read-link", "Read link"],
  ["spacing", "Spacing inside the card"],
] as const;

/* ------------------------------------------------------------------ *
 * 1. Ce que l'auteur tape passe en tête, toujours visible
 * ------------------------------------------------------------------ */

describe("article — le contenu éditorial en tête, avant l'apparence", () => {
  test("surtitre, image puis ligne de pied, hors de tout groupe, puis UN intertitre « Appearance »", () => {
    const items = article();
    const head = items.slice(0, items.findIndex((i) => i.kind === "group"));
    expect(head).toEqual([
      { kind: "slot", slot: "kicker", path: [] },
      { kind: "slot", slot: "image", path: [] },
      { kind: "slot", slot: "meta", path: [] },
      { kind: "section", text: "Appearance", path: [] },
    ]);
    // Un seul intertitre : les six anciens titres de section sont devenus des groupes.
    expect(items.filter((i) => i.kind === "section")).toHaveLength(1);
    // Et aucun emplacement éditorial ne se retrouve plus loin, dans un groupe.
    expect(items.filter((i) => i.kind === "slot" && i.path.length > 0)).toEqual([]);
  });

  test("⛔ garde de repli : hors d'un groupe, aucun réglage — ni sur l'article, ni sur un look", () => {
    // Sur l'article, tout contrôle hors groupe viendrait de ce fichier : les champs éditoriaux sont
    // des témoins ici. Un « Title colour » sorti de son groupe tombe ici.
    expect(controls(article()).filter((c) => c.path.length === 0).map((c) => c.label)).toEqual([]);
    expect(controls(look({ idPrefix: "banc.look" })).filter((c) => c.path.length === 0).map((c) => c.label)).toEqual([]);
    // Même avec tous les états conditionnels allumés (lien texte, surtitre fixe).
    const on = look({ idPrefix: "banc.look", value: { ctaStyle: "link", kickerMode: "text", kickerText: "Destacada" } });
    expect(controls(on).filter((c) => c.path.length === 0).map((c) => c.label)).toEqual([]);
  });

  test("chaque réglage est dans la sous-section de SA partie", () => {
    const where = (items: Item[], label: string) => controls(items).filter((c) => c.label === label).map((c) => c.path);
    const art = article({ ctaStyle: "link" });
    for (const [label, part] of [
      ["Kicker font", "Kicker"],
      ["Kicker accent colour", "Kicker"],
      ["Arrangement", "Image & layout"],
      ["Thumbnail width", "Image & layout"],
      ["Clickable image", "Image & layout"],
      ["Title colour", "Title"],
      ["Clickable title", "Title"],
      ["Excerpt line height", "Excerpt"],
      ["Meta accent colour", "Meta line"],
      ["Read link style", "Read link"],
      ["Read link label", "Read link"],
      ["Underline", "Read link"],
      ["Below the kicker", "Spacing inside the card"],
    ] as const) {
      expect([label, where(art, label)]).toEqual([label, [[part]]]);
    }
    // Le bouton de lecture (`CardButtonFields`) suit le lien de lecture.
    expect(where(article(), "Button corner radius")).toEqual([["Read link"]]);
    // Sur un look, les choix « ce que montre la ligne » vivent avec leur partie.
    const lk = look({ idPrefix: "banc.look" });
    expect(where(lk, "Kicker shows")).toEqual([["Kicker"]]);
    expect(where(lk, "Meta line shows")).toEqual([["Meta line"]]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Des sous-sections fermées, sous des id qui ne se croisent pas
 * ------------------------------------------------------------------ */

describe("sous-sections fermées, id distincts pour l'article, la une et les brèves", () => {
  test("article : 7 sous-sections FERMÉES, dans l'ordre de lecture, sous article.<partie>", () => {
    const gs = groups(article());
    expect(gs.map((g) => [g.title, g.id, g.open])).toEqual(PARTS.map(([part, title]) => [title, `article.${part}`, false]));
  });

  test("flux : la une et les brèves ont chacune leurs 8 sous-sections fermées, sous leur propre préfixe", () => {
    const gs = groups(feed({ leadCount: 1 }));
    const inside = (outer: string) => gs.filter((g) => g.path.length === 1 && g.path[0] === outer);
    const expected = (prefix: string) => [
      ...PARTS.map(([part, title]) => [title, `${prefix}.${part}`, false]),
      ["Card box & text", `${prefix}.box`, false],
    ];
    expect(inside("Lead card").map((g) => [g.title, g.id, g.open])).toEqual(expected("article-feed.lead"));
    expect(inside("Other cards").map((g) => [g.title, g.id, g.open])).toEqual(expected("article-feed.card"));
    // Sans une, les brèves s'appellent « Cards » et gardent LEUR préfixe.
    const alone = groups(feed()).filter((g) => g.path[0] === "Cards");
    expect(alone.map((g) => g.id)).toEqual(expected("article-feed.card").map(([, id]) => id));
  });

  test("⛔ aucun id porté deux fois entre l'article et le flux (la mémoire est commune à tout le builder)", () => {
    // `feedRaw` : la racine « Card looks » compte aussi (1).
    const ids = [...groups(article()), ...groups(feedRaw({ leadCount: 1, midSection: { label: "M" }, cardRule: {} }))].map(
      (g) => g.id,
    );
    expect(ids.filter((id) => id === undefined)).toEqual([]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(ids).toHaveLength(7 + 1 + 4 + 2 * 8 + 2);
  });

  test("ouvrir « Title » de la une n'ouvre pas « Title » des brèves (ni celui de l'article)", () => {
    const titleOf = (items: Item[], outer?: string) =>
      groups(items).find((g) => g.title === "Title" && (outer === undefined || g.path[0] === outer));
    const lead = titleOf(feed({ leadCount: 1 }), "Lead card");
    if (lead?.id === undefined) throw new Error("pas de « Title » mémorisé dans la une");
    // Ce que fait le navigateur au clic sur l'en-tête : l'attribut change, puis `toggle`.
    const click = (id: string, open: boolean) =>
      (Group({ id, title: "Title", children: null }) as { props: { onToggle: (e: unknown) => void } }).props.onToggle({
        currentTarget: { open },
      });
    click(lead.id, true);
    try {
      expect(titleOf(feed({ leadCount: 1 }), "Lead card")?.open).toBe(true);
      expect(titleOf(feed({ leadCount: 1 }), "Other cards")?.open).toBe(false);
      expect(titleOf(article())?.open).toBe(false);
    } finally {
      click(lead.id, false); // la mémoire est celle du module : on la rend fermée
    }
  });

  test("un look monté SANS préfixe ne mémorise rien plutôt que de partager l'état d'un autre", () => {
    expect(groups(look()).map((g) => g.id)).toEqual(PARTS.map(() => undefined).concat([undefined]));
  });
});

/* ------------------------------------------------------------------ *
 * 3. Un seul résumé : overrides()
 * ------------------------------------------------------------------ */

/**
 * Les `summary` de `<Group>` qui ne sont pas un appel direct à `overrides(…)` : littéral, ternaire,
 * gabarit, autre fonction. « Rien que `overrides` » = une seule forme, « defaults » / « N set ».
 */
function foreignSummaries(file: string, source: string) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let summaries = 0;
  const offenders: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === "Group"
    ) {
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== "summary" || attr.initializer === undefined) continue;
        summaries++;
        const value = ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr.initializer;
        const ok =
          value !== undefined &&
          ts.isCallExpression(value) &&
          ts.isIdentifier(value.expression) &&
          value.expression.text === "overrides";
        if (!ok) {
          const line = sf.getLineAndCharacterOfPosition(attr.getStart(sf)).line + 1;
          offenders.push(`${file}:${line} ${attr.getText(sf).replace(/\s+/g, " ")}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { summaries, offenders };
}

describe("résumé — une seule forme, celle d'overrides()", () => {
  test("le garde voit les formes interdites", () => {
    const { summaries, offenders } = foreignSummaries(
      "banc.tsx",
      [
        "const x = <>",
        '<Group title="A" summary={overrides(v, ["a"])}>a</Group>',
        '<Group title="B" summary="customised">b</Group>',
        '<Group title="C" summary={s === undefined ? "none" : "on"}>c</Group>',
        "<Group title=\"D\" summary={summaryOf(look)}>d</Group>",
        '<Group title="E" summary={`${n} segments`}>e</Group>',
        '<Group title="F">f</Group>',
        "</>;",
      ].join("\n"),
    );
    expect(summaries).toBe(5);
    expect(offenders.map((o) => o.split(" ")[0])).toEqual(["banc.tsx:3", "banc.tsx:4", "banc.tsx:5", "banc.tsx:6"]);
  });

  test("⛔ aucun résumé de Group hors overrides() dans apps/admin/src/components/builder/*.tsx", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
    let summaries = 0;
    const offenders: string[] = [];
    for (const f of files) {
      const found = foreignSummaries(f, readFileSync(join(dir, f), "utf8"));
      summaries += found.summaries;
      offenders.push(...found.offenders);
    }
    // Le garde doit VOIR le builder : un dossier mal lu serait vert sans rien vérifier.
    expect(files).toContain("article-look-fields.tsx");
    expect(summaries).toBeGreaterThan(25);
    expect(offenders).toEqual([]);
  });

  test("chaque clé d'ArticleLook est comptée par une sous-section, et une seule", () => {
    const counted = [...Object.values(LOOK_GROUP_KEYS).flat(), "style"];
    expect(counted.filter((k, i) => counted.indexOf(k) !== i)).toEqual([]);
    expect([...counted].sort()).toEqual(Object.keys(ArticleLook.shape).sort());
  });

  test("les résumés disent vrai : un article jamais touché est « defaults » partout", () => {
    // `layout` est TOUJOURS posé sur un article (« stacked » par le schéma) : il ne compte pas.
    expect(groups(article()).map((g) => g.summary)).toEqual(PARTS.map(() => "defaults"));
    const touched = groups(article({ layout: "side", titleColor: "#123456", titleLink: true, ctaStyle: "link" }));
    expect(touched.map((g) => [g.title, g.summary])).toEqual([
      ["Kicker", "defaults"],
      ["Image & layout", "1 set"],
      ["Title", "2 set"],
      ["Excerpt", "defaults"],
      ["Meta line", "defaults"],
      ["Read link", "1 set"],
      ["Spacing inside the card", "defaults"],
    ]);
  });

  test("flux : le look, le titre de section et le filet parlent la même langue", () => {
    const summaries = (items: Item[]) =>
      Object.fromEntries(groups(items).filter((g) => g.path.length <= 1).map((g) => [`${g.path.join("/")}>${g.title}`, g.summary]));
    const empty = summaries(feed({ leadCount: 1 }));
    expect(empty[">Lead card"]).toBe("defaults");
    expect(empty[">Other cards"]).toBe("defaults");
    expect(empty[">Section between them"]).toBe("defaults");
    expect(empty[">Rule between cards"]).toBe("defaults");
    // La racine repliée « Card looks » compte ses quatre parties posées (une, brèves, intertitre, filet).
    expect(groups(feedRaw({ leadCount: 1 }))[0]?.summary).toBe("defaults");
    expect(
      groups(feedRaw({ leadCount: 1, lead: { kickerMode: "text" }, midSection: { label: "M" }, cardRule: {} }))[0]?.summary,
    ).toBe("3 set");

    const full = summaries(
      feed({
        leadCount: 1,
        lead: { kickerMode: "text", kickerText: "Destacada" },
        midSection: { label: "Más noticias", ruleThickness: 3 },
        // `{}` = un filet aux valeurs par défaut : il EXISTE, le résumé doit le dire.
        cardRule: {},
      }),
    );
    expect(full[">Lead card"]).toBe("2 set");
    expect(full["Lead card>Kicker"]).toBe("2 set");
    expect(full[">Other cards"]).toBe("defaults");
    expect(full[">Section between them"]).toBe("2 set");
    expect(full["Section between them>Heading box & text"]).toBe("defaults");
    expect(full[">Rule between cards"]).toBe("1 set");
    expect(full["Rule between cards>Rule box"]).toBe("defaults");
  });
});
