/**
 * LES ÉDITEURS MÉTIER DE L'INSPECTEUR, REPLIÉS (lot L3, 23/09/2026) — `bun test` depuis la racine.
 *
 * Pick, odds_table, standings, scoreboard, callout et promo suivent une seule grammaire : en tête ce
 * que l'éditeur TAPE (textes, liens, image, lignes de données), puis UN intertitre « Appearance »
 * suivi de sous-sections fermées (`Group`). Les lignes d'une liste (`ListCard`) se replient et leur
 * en-tête dit ce qu'elles contiennent.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER :
 *   1. un résumé qui ment — « defaults » sur un groupe dont un réglage est posé, parce qu'une clé écrite
 *      dans le groupe manque à la liste passée à `overrides()` (ou y figure sans y être écrite) ;
 *   2. de l'apparence revenue à plat, ou du texte à taper caché dans un groupe fermé : les clés écrites
 *      HORS de tout groupe sont EXACTEMENT celles du contenu, bloc par bloc ;
 *   3. un deuxième intertitre, ou un groupe posé avant « Appearance » ;
 *   4. deux lignes d'une même liste sous le même `id` : elles s'ouvriraient et se fermeraient ensemble ;
 *   5. un en-tête de ligne qui ne dit pas ce qu'elle contient, ou qui passe à la ligne.
 *
 * Les parties 1 à 3 lisent le source avec le compilateur TypeScript, comme le garde de couverture
 * (`inspector-coverage.test.ts`) : même définition d'une écriture (clé littérale dans l'argument d'un
 * appel `patch` / `onPatch` / `setRow`…). Les parties 4 et 5 appellent les éditeurs COMME DES
 * FONCTIONS, comme le banc des contrôles : un hook dans un éditeur ou dans `ListCard` les fait tomber.
 *
 * ⛔ Les listes attendues sont ÉCRITES EN DUR : un banc qui les recalculerait avec le code qu'il
 * surveille ne mesurerait que lui-même.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import ts from "typescript";
import { EmailDoc, type Block, type MenuItem } from "@nf/render/schema";
import { resolveLookBase } from "./article-look-fields";
import { Group } from "./inspector-ui";
import {
  CalloutEditor,
  MenuItemsEditor,
  OddsTableEditor,
  PickEditor,
  PromoEditor,
  ScoreboardEditor,
  StandingsEditor,
} from "./inspector";

/* ------------------------------------------------------------------ *
 * 0. Ce qui est attendu, écrit en dur
 * ------------------------------------------------------------------ */

/** Éditeur → type de bloc (préfixe obligatoire de ses `id` de groupe). */
const EDITORS: Record<string, string> = {
  PickEditor: "pick",
  OddsTableEditor: "odds_table",
  StandingsEditor: "standings",
  ScoreboardEditor: "scoreboard",
  CalloutEditor: "callout",
  PromoEditor: "promo",
};

/**
 * Ce que l'éditeur tape : les SEULES clés écrites hors de tout groupe. Les lignes de données
 * (`rows`, et `label` / `value` / `highlight` d'une ligne) sont du contenu, dans leur `ListCard`.
 */
const CONTENT: Record<string, string[]> = {
  PickEditor: ["matchLabel", "kickoffLabel", "marketLabel", "selectionLabel", "oddsLabel", "confidenceLabel", "href", "ctaLabel"],
  OddsTableEditor: ["rows", "label", "value", "caption"],
  StandingsEditor: ["columns", "rows", "caption"],
  ScoreboardEditor: ["kicker", "rows", "label", "value", "highlight", "footerLabel", "footerHref", "footerNote"],
  CalloutEditor: ["kicker", "title", "body", "href", "ctaLabel", "imageSrc", "imageAlt"],
  PromoEditor: ["headline", "body", "code", "href", "ctaLabel", "terms"],
};

/** Titres que le banc des contrôles cherche TELS QUELS (`inspector-controls.test.ts:655-746`). */
const PINNED: Record<string, string[]> = {
  PickEditor: ["Text lines", "Button"],
  OddsTableEditor: ["Table style"],
  StandingsEditor: ["Table style", "Header row"],
  ScoreboardEditor: ["Row colours"],
  CalloutEditor: ["Button style"],
  PromoEditor: ["Promo code"],
};

/* ------------------------------------------------------------------ *
 * 1. Lecture du source (même définition d'une écriture que le garde de couverture)
 * ------------------------------------------------------------------ */

const FILES = ["inspector.tsx", "article-look-fields.tsx", "extra-fields.tsx"];
const WRITERS = new Set([
  "patch",
  "onPatch",
  "patchPart",
  "patchBlock",
  "patchRow",
  "patchColumn",
  "set",
  "setItem",
  "setRow",
  "setSegment",
  "setFont",
  "onChange",
  "dispatch",
]);

const DIR = dirname(fileURLToPath(import.meta.url));
const sources = FILES.map((name) =>
  ts.createSourceFile(name, readFileSync(join(DIR, name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
);
const INSPECTOR = sources[0];

/** Les fonctions déclarées des trois fichiers : un composant monté dans un groupe y écrit aussi. */
const functions = new Map<string, ts.FunctionDeclaration>();
for (const sf of sources) {
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const tagName = (node: ts.Node): string | undefined => {
  const tag = ts.isJsxElement(node)
    ? node.openingElement.tagName
    : ts.isJsxSelfClosingElement(node)
      ? node.tagName
      : undefined;
  return tag !== undefined && ts.isIdentifier(tag) ? tag.text : undefined;
};
const attributesOf = (node: ts.JsxElement | ts.JsxSelfClosingElement) =>
  (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties;

function attr(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string): ts.Expression | undefined {
  for (const a of attributesOf(node)) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== name || a.initializer === undefined) continue;
    return ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer;
  }
  return undefined;
}
const literal = (e: ts.Expression | undefined): string | undefined =>
  e !== undefined && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;

const calleeName = (call: ts.CallExpression): string | undefined =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : undefined;

/**
 * Les clés ÉCRITES sous `node` : clés littérales des objets passés à un appel d'écriture, plus celles
 * des composants du dépôt montés là (`CardButtonFields`…). `skipGroups` : ne pas entrer dans un
 * `<Group>` — ce qui reste est ce que l'éditeur voit sans rien ouvrir.
 */
function keysIn(node: ts.Node, skipGroups: boolean, out = new Set<string>(), seen = new Set<string>()): Set<string> {
  const collect = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) out.add(n.name.text);
    if (ts.isShorthandPropertyAssignment(n)) out.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  const visit = (n: ts.Node) => {
    const tag = tagName(n);
    if (skipGroups && tag === "Group") return;
    if (tag !== undefined && tag !== "Group" && functions.has(tag) && !seen.has(tag)) {
      seen.add(tag);
      keysIn(functions.get(tag)!, skipGroups, out, seen);
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name !== undefined && WRITERS.has(name)) for (const a of n.arguments) collect(a);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

interface GroupSite {
  editor: string;
  id: string | undefined;
  title: string | undefined;
  /** Liste passée à `overrides(x, [...])`, ou `undefined` si le résumé n'a pas cette forme. */
  listed: string[] | undefined;
  written: Set<string>;
  pos: number;
  line: number;
}

function editorNode(name: string): ts.FunctionDeclaration {
  const fn = functions.get(name);
  if (fn === undefined || fn.getSourceFile() !== INSPECTOR) throw new Error(`${name} introuvable dans inspector.tsx`);
  return fn;
}

function groupsOf(editor: string): GroupSite[] {
  const out: GroupSite[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) && tagName(n) === "Group") {
      const summary = attr(n, "summary");
      let listed: string[] | undefined;
      if (summary && ts.isCallExpression(summary) && calleeName(summary) === "overrides") {
        const list = summary.arguments[1];
        if (list && ts.isArrayLiteralExpression(list) && list.elements.every((e) => ts.isStringLiteral(e))) {
          listed = list.elements.map((e) => (e as ts.StringLiteral).text);
        }
      }
      const written = new Set<string>();
      for (const child of n.children) keysIn(child, false, written);
      out.push({
        editor,
        id: literal(attr(n, "id")),
        title: literal(attr(n, "title")),
        listed,
        written,
        pos: n.getStart(INSPECTOR),
        line: INSPECTOR.getLineAndCharacterOfPosition(n.getStart(INSPECTOR)).line + 1,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(editorNode(editor));
  return out;
}

/** Les `<SectionTitle>` d'un éditeur, avec leur texte et leur position. */
function sectionTitles(editor: string): { text: string; pos: number }[] {
  const out: { text: string; pos: number }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) && tagName(n) === "SectionTitle") {
      out.push({ text: n.children.map((c) => c.getText(INSPECTOR)).join("").trim(), pos: n.getStart(INSPECTOR) });
    }
    ts.forEachChild(n, visit);
  };
  visit(editorNode(editor));
  return out;
}

const sorted = (s: Iterable<string>) => [...s].sort();

/* ------------------------------------------------------------------ *
 * 2. Gardes statiques
 * ------------------------------------------------------------------ */

describe("éditeurs métier — le résumé de chaque groupe dit la vérité", () => {
  test("la lecture voit bien les six éditeurs et leurs groupes (un garde aveugle serait vert pour rien)", () => {
    const all = Object.keys(EDITORS).flatMap(groupsOf);
    // 19 au 23/09/2026 : pick 4, odds_table 2, standings 3, scoreboard 4, callout 3, promo 3.
    expect(all.length >= 19).toBe(true);
    // Témoin : le groupe « Button » de pick écrit par CardButtonFields (extra-fields.tsx), pas en ligne.
    const button = groupsOf("PickEditor").find((g) => g.title === "Button");
    expect(sorted(button?.written ?? [])).toEqual(
      sorted(["ctaBackground", "ctaTextColor", "ctaSize", "ctaWeight", "ctaPadding", "ctaRadius"]),
    );
  });

  test("⛔ pour chaque groupe, la liste d'overrides() = les clés écrites dans le groupe", () => {
    const drift: string[] = [];
    for (const editor of Object.keys(EDITORS)) {
      for (const g of groupsOf(editor)) {
        if (g.listed === undefined) {
          drift.push(`${editor}:${g.line} « ${g.title} » — résumé absent ou hors de la forme overrides(x, [clés littérales])`);
          continue;
        }
        const missing = sorted(g.written).filter((k) => !g.listed!.includes(k));
        const extra = g.listed.filter((k) => !g.written.has(k));
        if (missing.length || extra.length) {
          drift.push(`${editor}:${g.line} « ${g.title} » — non listées : [${missing}] ; listées sans écriture : [${extra}]`);
        }
      }
    }
    expect(drift).toEqual([]);
  });
});

describe("éditeurs métier — le contenu en tête, l'apparence repliée", () => {
  test("⛔ hors de tout groupe, un éditeur n'écrit QUE son contenu (et tout son contenu)", () => {
    for (const editor of Object.keys(EDITORS)) {
      const outside = sorted(keysIn(editorNode(editor), true));
      expect({ editor, outside }).toEqual({ editor, outside: sorted(CONTENT[editor]) });
    }
  });

  test("un seul intertitre « Appearance », le dernier, et tous les groupes après lui", () => {
    for (const editor of Object.keys(EDITORS)) {
      const titles = sectionTitles(editor);
      const appearance = titles.filter((t) => t.text === "Appearance");
      expect({ editor, appearance: appearance.length }).toEqual({ editor, appearance: 1 });
      expect({ editor, last: titles[titles.length - 1].text }).toEqual({ editor, last: "Appearance" });
      const before = groupsOf(editor).filter((g) => g.pos < appearance[0].pos);
      expect({ editor, before: before.map((g) => g.title) }).toEqual({ editor, before: [] });
    }
  });

  test("les titres épinglés par le banc des contrôles existent encore, à l'identique", () => {
    for (const [editor, titles] of Object.entries(PINNED)) {
      const present = groupsOf(editor).map((g) => g.title);
      for (const t of titles) expect({ editor, t, present: present.includes(t) }).toEqual({ editor, t, present: true });
    }
  });

  test("chaque groupe a un id littéral « <type>.<partie> », unique, et aucun n'empiète sur les lignes de liste", () => {
    const ids: string[] = [];
    for (const [editor, type] of Object.entries(EDITORS)) {
      for (const g of groupsOf(editor)) {
        expect({ editor, title: g.title, id: g.id?.startsWith(`${type}.`) }).toEqual({ editor, title: g.title, id: true });
        // `<type>.row.<n>` est réservé aux lignes des ListCard (id calculé, invisible au garde des littéraux).
        expect({ editor, id: g.id, row: g.id?.startsWith(`${type}.row.`) }).toEqual({ editor, id: g.id, row: false });
        ids.push(g.id!);
      }
    }
    expect(ids.length).toBe(new Set(ids).size);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Les lignes de liste, rendues (éditeurs appelés comme des fonctions)
 * ------------------------------------------------------------------ */

function docWith(block: Record<string, unknown>) {
  return EmailDoc.parse({
    schema: 2,
    meta: { subject: "Banc", preheader: "", assetSlug: "demo-brand", locale: "en" },
    theme: {},
    rows: [{ id: "row_1", layout: "1", columns: [{ id: "col_1", blocks: [{ id: "blk_1", ...block }] }] }],
  });
}

function props<T extends Block>(block: Record<string, unknown>) {
  const doc = docWith(block);
  const b = doc.rows[0].columns[0].blocks[0] as T;
  return { block: b, patch: () => {}, theme: doc.theme, base: resolveLookBase(doc.theme, ["style" in b ? b.style : undefined]) };
}

interface Card {
  id: string;
  title: string;
  /** Les props du `Group` que la carte rend. */
  group: Parameters<typeof Group>[0];
  /** Les props de la `ListCard` elle-même (ses champs, `onMove`, `onRemove`, `total`, `min`). */
  card: Record<string, unknown>;
}

/** Les cartes de liste d'un arbre rendu : `ListCard` est appelée comme une fonction, on lit son `Group`. */
function cards(node: ReactNode, out: Card[] = []): Card[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) cards(n as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const type = node.type as unknown;
  const p = node.props as Record<string, unknown>;
  if (typeof type === "function" && type.name === "ListCard") {
    const group = (type as (q: unknown) => ReactNode)(p);
    if (!isValidElement(group) || group.type !== Group) throw new Error("ListCard ne rend plus un Group");
    const g = group.props as Card["group"];
    out.push({ id: String(g.id), title: String(g.title), group: g, card: p });
    return out;
  }
  return cards(p.children as ReactNode, out);
}

const STANDINGS = {
  type: "standings",
  columns: ["#", "Team", "P", "Pts"],
  rows: [
    ["1", "Arsenal", "38", "89"],
    ["2", "Manchester City", "38", "86"],
    ["3", "", "", ""],
    ["4", "Wolverhampton Wanderers Football Club", "38", "61"],
    ["", "", "", ""],
    ["6", "Aston Villa", "38", "58"],
  ],
};
const ODDS = {
  type: "odds_table",
  rows: [
    { label: "Home win", value: "2.10" },
    { label: "Draw", value: "3.20" },
    { label: "", value: "" },
  ],
};
const SCOREBOARD = {
  type: "scoreboard",
  kicker: "Full time",
  rows: [
    { label: "Arsenal", value: "2", highlight: true },
    { label: "Chelsea", value: "1" },
    { label: "", value: "" },
    { label: "Shots", value: "14" },
  ],
};

/**
 * Rendu DANS chaque test, jamais à la collecte : un hook glissé dans `ListCard` lèverait sinon entre
 * deux tests (« 1 error »), et les tests de cette section disparaîtraient du compte au lieu de rougir.
 */
const renderLists = () => ({
  standings: cards(StandingsEditor(props<Extract<Block, { type: "standings" }>>(STANDINGS))),
  odds_table: cards(OddsTableEditor(props<Extract<Block, { type: "odds_table" }>>(ODDS))),
  scoreboard: cards(ScoreboardEditor(props<Extract<Block, { type: "scoreboard" }>>(SCOREBOARD))),
});

describe("lignes de liste — repliables, chacune sous son id, résumées par leur contenu", () => {
  test("une carte par ligne", () => {
    const rendered = renderLists();
    expect(rendered.standings.length).toBe(6);
    expect(rendered.odds_table.length).toBe(3);
    expect(rendered.scoreboard.length).toBe(4);
  });

  test("⛔ chaque ligne a SON id, préfixé par le type du bloc — deux lignes ne s'ouvrent pas ensemble", () => {
    const rendered = renderLists();
    for (const [type, list] of Object.entries(rendered)) {
      const ids = list.map((c) => c.id);
      expect({ type, distinct: new Set(ids).size }).toEqual({ type, distinct: list.length });
      for (const id of ids) expect(id.startsWith(`${type}.row.`)).toBe(true);
    }
    // Et d'un bloc à l'autre : la mémoire vaut par type, jamais partagée entre deux types.
    const all = Object.values(rendered).flatMap((l) => l.map((c) => c.id));
    expect(new Set(all).size).toBe(all.length);
  });

  test("⛔ l'id suit la POSITION et pas le contenu : taper dans une ligne ne change pas son id", () => {
    const typed = structuredClone(STANDINGS);
    typed.rows[2] = ["3", "Newcastle United", "38", "71"];
    const after = cards(StandingsEditor(props<Extract<Block, { type: "standings" }>>(typed)));
    expect(after.map((c) => c.id)).toEqual(renderLists().standings.map((c) => c.id));
  });

  test("l'en-tête dit ce que la ligne contient ; une ligne vide se lit « empty »", () => {
    const rendered = renderLists();
    expect(rendered.standings[0].title).toBe("Row 1 · 1 · Arsenal · 38 · 89");
    expect(rendered.standings[2].title).toBe("Row 3 · 3");
    expect(rendered.standings[4].title).toBe("Row 5 · empty");
    expect(rendered.odds_table[1].title).toBe("Row 2 · Draw · 3.20");
    expect(rendered.odds_table[2].title).toBe("Row 3 · empty");
    expect(rendered.scoreboard[0].title).toBe("Row 1 · Arsenal · 2");
  });

  test("un contenu trop long est coupé (…) avant de passer à la ligne, et garde son début", () => {
    const long = renderLists().standings[3].title;
    expect(long.startsWith("Row 4 · 4 · Wolverhampton")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length < "Row 4 · 4 · Wolverhampton Wanderers Football Club · 38 · 61".length).toBe(true);
    // Des capitales pleines occupent plus de place que des minuscules : coupées plus tôt.
    const caps = cards(
      StandingsEditor(
        props<Extract<Block, { type: "standings" }>>({ type: "standings", columns: ["Team", "Pts"], rows: [["MANCHESTER UNITED FOOTBALL CLUB", "89"], ["manchester united football club", "89"]] }),
      ),
    );
    expect(caps[0].title.endsWith("…")).toBe(true);
    const capsShorter = caps[0].title.length < caps[1].title.length;
    expect({ caps: caps[0].title, lower: caps[1].title, capsShorter }).toEqual({ caps: caps[0].title, lower: caps[1].title, capsShorter: true });
  });
});

/* ------------------------------------------------------------------ *
 * 3 bis. Une ligne ajoutée s'ouvre — par le geste, jamais par son contenu
 * ------------------------------------------------------------------ */

/** Une carte rendue : l'état que son `<details>` sert, et le clic sur son en-tête (le `toggle` du navigateur). */
interface LiveCard {
  id: string;
  open: boolean;
  toggle: (open: boolean) => void;
}

function live(node: ReactNode): LiveCard[] {
  return cards(node).map((c) => {
    const el = Group(c.group) as unknown as {
      props: { open?: boolean; onToggle?: (e: { currentTarget: { open: boolean } }) => void };
    };
    return {
      id: c.id,
      open: el.props.open === true,
      toggle: (open: boolean) => el.props.onToggle!({ currentTarget: { open } }),
    };
  });
}

/** Le `onClick` du seul bouton de libellé `label` hors des cartes (les composants ne sont pas appelés). */
function button(node: ReactNode, label: string): () => void {
  const found: (() => void)[] = [];
  const visit = (n: unknown) => {
    if (n === null || n === undefined || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (!isValidElement(n)) return;
    const p = n.props as Record<string, unknown>;
    if (p.label === label && typeof p.onClick === "function") found.push(p.onClick as () => void);
    visit(p.children);
  };
  visit(node);
  if (found.length !== 1) throw new Error(`expected exactly one button “${label}”, found ${found.length}`);
  return found[0];
}

/** Pose l'état ouvert / fermé d'une carte comme la main : ouvrir, puis refermer si besoin. */
const setOpen = (card: LiveCard, open: boolean) => {
  card.toggle(true);
  if (!open) card.toggle(false);
};

type ListEditor = (p: ReturnType<typeof props>) => ReactNode;

/** Un éditeur de bloc à lignes, rendu avec `rows` : ses écritures de `rows` vont à `write`. */
const blockList =
  (editor: ListEditor, block: Record<string, unknown>) => (rows: unknown[], write: (rows: unknown[]) => void) =>
    editor({ ...props({ ...block, rows }), patch: (p: Record<string, unknown>) => write(p.rows as unknown[]) } as never);

const MENU: MenuItem[] = [
  { label: "News", href: "https://example.test/news" },
  { label: "Sport", href: "https://example.test/sport" },
  { label: "Newsletter archive and every past issue", href: "https://example.test/archive" },
];

/** Les quatre listes, leur bouton d'ajout, et ce qu'on attend : TOUT écrit en dur. */
const LISTS: {
  type: string;
  add: string;
  rows: unknown[];
  render: (rows: unknown[], write: (rows: unknown[]) => void) => ReactNode;
  ids: string[];
}[] = [
  {
    type: "odds_table",
    add: "Add odds row",
    rows: ODDS.rows,
    render: blockList(OddsTableEditor as ListEditor, ODDS),
    ids: ["odds_table.row.1", "odds_table.row.2", "odds_table.row.3", "odds_table.row.4"],
  },
  {
    type: "standings",
    add: "Add standings row",
    rows: STANDINGS.rows.slice(0, 3),
    render: blockList(StandingsEditor as ListEditor, STANDINGS),
    ids: ["standings.row.1", "standings.row.2", "standings.row.3", "standings.row.4"],
  },
  {
    type: "scoreboard",
    add: "Add scoreboard row",
    // 3 lignes : le bandeau en accepte 4 au plus, « Add row » serait grisé à 4.
    rows: SCOREBOARD.rows.slice(0, 3),
    render: blockList(ScoreboardEditor as ListEditor, SCOREBOARD),
    ids: ["scoreboard.row.1", "scoreboard.row.2", "scoreboard.row.3", "scoreboard.row.4"],
  },
  {
    type: "menu",
    add: "Add menu item",
    rows: MENU,
    render: (items, write) => MenuItemsEditor({ items: items as MenuItem[], onChange: write }),
    ids: ["menu.row.1", "menu.row.2", "menu.row.3", "menu.row.4"],
  },
];

describe("lignes de liste — « Add row » ouvre la carte ajoutée, et elle seule", () => {
  for (const list of LISTS) {
    test(`${list.type} : la ligne ajoutée arrive OUVERTE, les autres gardent leur état`, () => {
      const writes: unknown[][] = [];
      const render = (rows: unknown[]) => list.render(rows, (next) => void writes.push(next));
      const rows = list.rows;

      // 1. Premier ajout : la 4e carte s'ouvre.
      button(render(rows), list.add)();
      const added = writes.at(-1)!;
      expect(added.length).toBe(4);
      expect(live(render(added)).map((c) => [c.id, c.open])[3]).toEqual([list.ids[3], true]);

      // 2. L'éditeur règle les cartes à la main — ouverte, fermée, ouverte — et REFERME la 4e,
      //    puis la retire. La mémoire de cette position dit maintenant « fermée ».
      const four = live(render(added));
      setOpen(four[0], true);
      setOpen(four[1], false);
      setOpen(four[2], true);
      setOpen(four[3], false);
      expect(live(render(added)).map((c) => c.open)).toEqual([true, false, true, false]);

      // 3. Ré-ajout à la même position : elle s'ouvre quand même ; les trois autres n'ont pas bougé.
      button(render(rows), list.add)();
      const again = writes.at(-1)!;
      expect(live(render(again)).map((c) => [c.id, c.open])).toEqual([
        [list.ids[0], true],
        [list.ids[1], false],
        [list.ids[2], true],
        [list.ids[3], true],
      ]);
    });
  }
});

/* ------------------------------------------------------------------ *
 * 3 ter. Le menu passe sur ListCard (23/09/2026)
 * ------------------------------------------------------------------ */

describe("menu — un lien = une carte repliée (ListCard), comme les autres listes", () => {
  const view = (items: MenuItem[], sink: MenuItem[][] = []) => MenuItemsEditor({ items, onChange: (next) => void sink.push(next) });
  /** Les champs d'une carte : ses enfants, par libellé. */
  const fields = (c: Card) =>
    ([c.card.children].flat(Infinity) as unknown[]).filter(isValidElement).map((e) => e.props as Record<string, unknown>);

  test("une carte par lien, sous menu.row.<n>, fermée par défaut ; l'en-tête dit le libellé et l'adresse, coupé", () => {
    const list = cards(view(MENU));
    expect(list.map((c) => c.id)).toEqual(["menu.row.1", "menu.row.2", "menu.row.3"]);
    // L'adresse sans « https:// » (il mangeait la place) ; un libellé trop long est coupé (…).
    expect(list.map((c) => c.title)).toEqual([
      "Item 1 · News · example.test/news",
      "Item 2 · Sport · example.test/sport",
      "Item 3 · Newsletter archive and ev…",
    ]);
    expect(list.every((c) => c.group.defaultOpen !== true)).toBe(true);
    // ⛔ L'id suit la POSITION : taper un autre libellé ne le change pas (sinon la carte se refermerait).
    const typed = cards(view([{ ...MENU[0], label: "Actualités" }, MENU[1], MENU[2]]));
    expect(typed.map((c) => c.id)).toEqual(list.map((c) => c.id));
  });

  test("ce qu'on tape est dans SA carte ; « Add menu item » reste hors des cartes", () => {
    for (const c of cards(view(MENU))) expect(fields(c).map((f) => f.label)).toEqual(["Label", "URL"]);
    expect(typeof button(view(MENU), "Add menu item")).toBe("function");
  });

  test("les écritures : libellé, adresse, retrait, déplacement — la liste réécrite EN ENTIER", () => {
    const sink: MenuItem[][] = [];
    const list = cards(view(MENU, sink));
    const field = (i: number, label: string) => fields(list[i]).find((f) => f.label === label)!;

    (field(1, "Label").onChange as (v: string) => void)("Deportes");
    expect(sink.at(-1)).toEqual([MENU[0], { label: "Deportes", href: "https://example.test/sport" }, MENU[2]]);
    (field(0, "URL").onChange as (v: string) => void)("https://example.test/actu");
    expect(sink.at(-1)).toEqual([{ label: "News", href: "https://example.test/actu" }, MENU[1], MENU[2]]);
    (list[1].card.onRemove as () => void)();
    expect(sink.at(-1)).toEqual([MENU[0], MENU[2]]);
    (list[2].card.onMove as (d: -1 | 1) => void)(-1);
    expect(sink.at(-1)).toEqual([MENU[0], MENU[2], MENU[1]]);
    button(view(MENU, sink), "Add menu item")();
    expect(sink.at(-1)).toEqual([...MENU, { label: "New link", href: "https://example.com" }]);
  });

  test("un menu garde au moins un lien : le retrait du dernier est grisé (min 1), l'ajout s'arrête à 8", () => {
    const one = cards(view([MENU[0]]));
    expect([one[0].card.min, one[0].card.total]).toEqual([1, 1]);
    const eight = Array.from({ length: 8 }, (_, k) => ({ label: `L${k + 1}`, href: `https://example.test/${k + 1}` }));
    const disabled = (node: ReactNode, label: string): unknown => {
      const seen: unknown[] = [];
      const visit = (n: unknown) => {
        if (n === null || n === undefined || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(visit);
        if (!isValidElement(n)) return;
        const q = n.props as Record<string, unknown>;
        if (q.label === label) seen.push(q.disabled);
        visit(q.children);
      };
      visit(node);
      return seen.length === 1 ? seen[0] : `found ${seen.length}`;
    };
    expect(disabled(view(eight), "Add menu item")).toBe(true);
    expect(disabled(view(MENU), "Add menu item")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Un résumé qui tient compte d'un défaut de schéma
 * ------------------------------------------------------------------ */

/** Le `summary` du groupe `title` dans l'arbre rendu (les groupes ne sont pas appelés : on lit leurs props). */
function summaryOf(node: ReactNode, title: string): string | undefined {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const s = summaryOf(n as ReactNode, title);
      if (s !== undefined) return s;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const p = node.props as Record<string, unknown>;
  if (node.type === Group && p.title === title) return String(p.summary);
  return summaryOf(p.children as ReactNode, title);
}

describe("callout — [Panel]", () => {
  test("accentWidth vaut 0 par défaut de schéma : un encart neuf se lit « defaults », pas « 1 set »", () => {
    const fresh = props<Extract<Block, { type: "callout" }>>({ type: "callout", kicker: "", title: "", body: "", accentWidth: 0 });
    expect(summaryOf(CalloutEditor(fresh), "Panel")).toBe("defaults");
    const barred = props<Extract<Block, { type: "callout" }>>({ type: "callout", kicker: "", title: "", body: "", accentWidth: 4 });
    expect(summaryOf(CalloutEditor(barred), "Panel")).toBe("1 set");
  });

  test("la largeur de vignette n'est offerte qu'avec une vignette, et compte alors dans [Panel]", () => {
    const withImage = props<Extract<Block, { type: "callout" }>>({
      type: "callout",
      kicker: "",
      title: "T",
      body: "B",
      accentWidth: 0,
      imageSrc: "https://example.test/t.jpg",
      imageWidthPct: 30,
    });
    expect(summaryOf(CalloutEditor(withImage), "Panel")).toBe("1 set");
  });
});

describe("pick, promo — les groupes existants gardent leur forme", () => {
  test("rendus sans hook, avec leurs titres", () => {
    const pick = PickEditor(
      props<Extract<Block, { type: "pick" }>>({ type: "pick", matchLabel: "A — B", marketLabel: "", selectionLabel: "", oddsLabel: "" }),
    );
    for (const t of ["Text lines", "Odds badge", "Card", "Button"]) expect(summaryOf(pick, t)).toBe("defaults");
    const promo = PromoEditor(
      props<Extract<Block, { type: "promo" }>>({ type: "promo", headline: "H", href: "https://example.test", ctaLabel: "Go", code: "X", codeSize: 20 }),
    );
    expect(summaryOf(promo, "Promo code")).toBe("1 set");
  });
});
