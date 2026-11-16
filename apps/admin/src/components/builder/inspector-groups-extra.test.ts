/**
 * LES REPLIS DES BLOCS D'APPOINT (`extra-fields.tsx`, lot L5 du 23/09/2026) — `bun test` depuis la racine.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER :
 *   1. des liens sociaux qui s'ouvrent et se ferment ENSEMBLE : un `id` littéral dans le `.map()` est
 *      partagé par toutes les cartes (la mémoire de `Group` est indexée par l'id) ;
 *   2. une carte repliée qui ne dit plus QUEL réseau elle porte, ni si sa vraie adresse est posée :
 *      quatre en-têtes identiques obligeraient à tout rouvrir pour trouver le bon lien ;
 *   3. un champ sorti de sa carte, ou enfoui un niveau plus bas : ce qu'on tape doit rester à UN clic ;
 *   4. l'avertissement « the segments add up to N% » caché dans un groupe fermé.
 *
 * Les éditeurs sont appelés COMME DES FONCTIONS, comme le fait `inspector-controls.test.ts` (sans
 * hook, c'est la condition) ; les champs de `fields.tsx` (`useId`) sont des feuilles dont on lit les
 * props. ⛔ Les titres et résumés attendus sont ÉCRITS EN DUR : un banc qui les recalculerait avec
 * `NETWORK_NAMES` ou `overrides()` ne mesurerait que lui-même.
 */
import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { EmailDoc, type Block, type SocialItem } from "@nf/render/schema";
import {
  ButtonLookFields,
  DividerSegmentsEditor,
  MenuLookFields,
  SocialItemsEditor,
  SocialLookFields,
} from "./extra-fields";
import { Group } from "./inspector-ui";

/* ------------------------------------------------------------------ *
 * Banc : déplier, relever les groupes et les feuilles
 * ------------------------------------------------------------------ */

const EXPAND = new Set<unknown>([
  Group,
  SocialItemsEditor,
  DividerSegmentsEditor,
  ButtonLookFields,
  MenuLookFields,
  SocialLookFields,
]);

interface SeenGroup {
  id?: string;
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  /** Nombre de `Group` au-dessus de celui-ci. */
  depth: number;
}
interface Leaf {
  name: string;
  props: Record<string, unknown>;
  /** Titres des `Group` traversés pour y arriver. */
  groups: string[];
}

function walk(node: ReactNode) {
  const groups: SeenGroup[] = [];
  const leaves: Leaf[] = [];
  const visit = (n: unknown, path: string[]) => {
    if (n === null || n === undefined || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c, path);
      return;
    }
    if (!isValidElement(n)) return;
    const type = n.type as unknown;
    const props = n.props as Record<string, unknown>;
    if (typeof type === "function") {
      if (type === Group) {
        groups.push({
          id: props.id as string | undefined,
          title: String(props.title),
          summary: props.summary as string | undefined,
          defaultOpen: props.defaultOpen as boolean | undefined,
          depth: path.length,
        });
      }
      if (EXPAND.has(type)) {
        visit((type as (p: unknown) => ReactNode)(props), type === Group ? [...path, String(props.title)] : path);
      } else {
        leaves.push({ name: type.name, props, groups: path });
      }
      return;
    }
    visit(props.children, path);
  };
  visit(node, []);
  return { groups, leaves };
}

function leaf(leaves: Leaf[], label: string): Leaf {
  const found = leaves.filter((l) => l.props.label === label);
  if (found.length !== 1) throw new Error(`expected exactly one control “${label}”, found ${found.length}`);
  return found[0];
}

/** Un bloc et le thème, passés par le vrai schéma (défauts compris). */
function parsed<T extends Block>(block: Record<string, unknown>) {
  const doc = EmailDoc.parse({
    schema: 2,
    meta: { subject: "Banc", preheader: "", assetSlug: "demo-brand", locale: "en" },
    theme: {},
    rows: [{ id: "row_1", layout: "1", columns: [{ id: "col_1", blocks: [{ id: "blk_1", ...block }] }] }],
  });
  return { block: doc.rows[0].columns[0].blocks[0] as T, theme: doc.theme };
}

/* ------------------------------------------------------------------ *
 * 1. Liens sociaux : une carte repliée par lien
 * ------------------------------------------------------------------ */

const FOUR: SocialItem[] = [
  { platform: "facebook", href: "https://facebook.com/banc" },
  { platform: "instagram", href: "https://instagram.com/banc", label: "Instagram" },
  { platform: "twitter", href: "https://twitter.com/banc", iconSrc: "https://cdn.example.test/x.png" },
  { platform: "tiktok", href: "https://tiktok.com/@banc", iconSrc: "https://cdn.example.test/t.png", label: "TikTok" },
];

/** Rend l'éditeur ; `sink` reçoit ce que ses contrôles écrivent. */
function social(items: SocialItem[]) {
  const sink: SocialItem[][] = [];
  const tree = walk(SocialItemsEditor({ items, onChange: (next) => sink.push(next) }));
  return { ...tree, sink };
}

describe("social — un lien = une carte repliée", () => {
  test("une carte par lien, fermée, au premier niveau, sous un id PROPRE à chaque lien", () => {
    const { groups } = social(FOUR);
    expect(groups.length).toBe(4);
    expect(groups.map((g) => g.depth)).toEqual([0, 0, 0, 0]);
    expect(groups.every((g) => g.defaultOpen !== true)).toBe(true);
    // ⛔ Un id littéral dans le .map() → les quatre cartes s'ouvriraient ensemble.
    const ids = groups.map((g) => g.id);
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(ids).size).toBe(4);
    // La mémoire vaut par type de bloc : l'id commence par le type.
    expect(ids.every((id) => id!.startsWith("social."))).toBe(true);
  });

  test("changer « Platform » garde l'id de la carte (sinon une carte ouverte se refermerait)", () => {
    const a = social([{ platform: "facebook", href: "https://facebook.com/banc" }]).groups[0].id;
    const b = social([{ platform: "instagram", href: "https://facebook.com/banc" }]).groups[0].id;
    expect(typeof a).toBe("string");
    expect(b).toBe(a);
  });

  test("l'en-tête d'une carte nomme son réseau", () => {
    expect(social(FOUR).groups.map((g) => g.title)).toEqual([
      "Facebook · URL set",
      "Instagram · URL set",
      "Twitter / X · URL set",
      "TikTok · URL set",
    ]);
    const all: SocialItem["platform"][] = ["youtube", "linkedin", "telegram", "whatsapp", "web"];
    const titles = social(all.map((platform) => ({ platform, href: "https://x.test/banc" }))).groups.map((g) => g.title);
    expect(titles).toEqual(["YouTube · URL set", "LinkedIn · URL set", "Telegram · URL set", "WhatsApp · URL set", "Website · URL set"]);
  });

  test("l'en-tête dit si la vraie adresse est posée : vide ou exemple d'« Add link » = « needs a URL »", () => {
    const { groups } = social([
      { platform: "web", href: "https://example.com" },
      { platform: "facebook", href: "" },
      { platform: "youtube", href: "   " },
      { platform: "web", href: "https://example.com/banc" },
    ]);
    const state = groups.map((g) => g.title.split(" · ")[1]);
    expect(state).toEqual(["needs a URL", "needs a URL", "needs a URL", "URL set"]);
    // ⛔ Fermée AUSSI sans adresse : un défaut tiré de l'URL refermerait la carte à la première frappe
    // (`Group` relit `defaultOpen` à chaque rendu tant que l'en-tête n'a pas été cliqué).
    expect(groups.map((g) => g.defaultOpen === true)).toEqual([false, false, false, false]);
  });

  test("le résumé a la forme d'overrides() et compte l'icône et le libellé propres", () => {
    expect(social(FOUR).groups.map((g) => g.summary)).toEqual(["defaults", "1 set", "1 set", "2 set"]);
  });

  test("ce qu'on tape est à UN clic : les champs de chaque lien sont dans SA carte, et nulle part ailleurs", () => {
    const { groups, leaves } = social(FOUR);
    const labels = ["Platform", "URL", "Icon image (optional)", "Label (optional)"];
    for (const [i, g] of groups.entries()) {
      const inside = leaves.filter((l) => l.props.label !== undefined && l.groups.length === 1 && l.groups[0] === g.title);
      expect(inside.map((l) => l.props.label)).toEqual([...labels, `Remove social link ${i + 1}`]);
    }
    // Aucun champ d'un lien hors carte ; « Add link » reste visible, hors de toute carte.
    expect(leaves.filter((l) => labels.includes(String(l.props.label)) && l.groups.length !== 1)).toEqual([]);
    expect(leaf(leaves, "Add social link").groups).toEqual([]);
  });

  test("les écritures sont inchangées : même liste réécrite en entier, mêmes clés", () => {
    const { leaves, sink } = social(FOUR);
    const inCard = (title: string, label: string) => {
      const found = leaves.filter((l) => l.props.label === label && l.groups[0] === title);
      if (found.length !== 1) throw new Error(`“${label}” in “${title}”: ${found.length}`);
      return found[0];
    };
    (inCard("Instagram · URL set", "URL").props.onChange as (v: string) => void)("https://instagram.com/autre");
    expect(sink.at(-1)).toEqual([FOUR[0], { ...FOUR[1], href: "https://instagram.com/autre" }, FOUR[2], FOUR[3]]);

    (inCard("Facebook · URL set", "Platform").props.onChange as (v: string) => void)("youtube");
    expect(sink.at(-1)![0]).toEqual({ platform: "youtube", href: "https://facebook.com/banc" });

    (inCard("TikTok · URL set", "Icon image (optional)").props.onChange as (v: string) => void)("  ");
    expect(sink.at(-1)![3]).toEqual({ platform: "tiktok", href: "https://tiktok.com/@banc", label: "TikTok" });

    (leaf(leaves, "Remove social link 3").props.onClick as () => void)();
    expect(sink.at(-1)).toEqual([FOUR[0], FOUR[1], FOUR[3]]);

    (leaf(leaves, "Add social link").props.onClick as () => void)();
    expect(sink.at(-1)).toEqual([...FOUR, { platform: "web", href: "https://example.com" }]);
  });

  test("« Add link » ouvre la carte ajoutée — même refermée à la main avant — et elle seule", () => {
    /** L'état que sert chaque carte, et le clic sur son en-tête (le `toggle` du navigateur). */
    const cards = (items: SocialItem[]) =>
      walk(SocialItemsEditor({ items, onChange: () => {} })).groups.map((g) => {
        const el = Group({ id: g.id, title: g.title, summary: g.summary, children: null }) as unknown as {
          props: { open?: boolean; onToggle?: (e: { currentTarget: { open: boolean } }) => void };
        };
        const toggle = (open: boolean) => el.props.onToggle!({ currentTarget: { open } });
        return { id: g.id, open: el.props.open === true, toggle };
      });
    const setOpen = (card: ReturnType<typeof cards>[number], open: boolean) => {
      card.toggle(true);
      if (!open) card.toggle(false);
    };
    const add = (items: SocialItem[]) => {
      const { leaves, sink } = social(items);
      (leaf(leaves, "Add social link").props.onClick as () => void)();
      return sink.at(-1)!;
    };
    const three = FOUR.slice(0, 3);

    // 1. Premier ajout : la 4e carte s'ouvre.
    const added = add(three);
    expect(cards(added).map((c) => [c.id, c.open])[3]).toEqual(["social.link.3", true]);

    // 2. Réglées à la main — ouverte, fermée, ouverte — et la 4e REFERMÉE puis retirée.
    const four = cards(added);
    setOpen(four[0], true);
    setOpen(four[1], false);
    setOpen(four[2], true);
    setOpen(four[3], false);
    expect(cards(added).map((c) => c.open)).toEqual([true, false, true, false]);

    // 3. Ré-ajout à la même position : elle s'ouvre quand même, les autres n'ont pas bougé.
    expect(cards(add(three)).map((c) => [c.id, c.open])).toEqual([
      ["social.link.0", true],
      ["social.link.1", false],
      ["social.link.2", true],
      ["social.link.3", true],
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Séparateur : la barre multicolore repliée
 * ------------------------------------------------------------------ */

type Segments = Parameters<typeof DividerSegmentsEditor>[0]["segments"];

function divider(segments: Segments) {
  const sink: Segments[] = [];
  const tree = walk(
    DividerSegmentsEditor({ segments, fallbackColor: "#aaaaaa", accentColor: "#bbbbbb", onChange: (next) => sink.push(next) }),
  );
  return { ...tree, sink };
}

const THREE = [
  { color: "#112233", widthPct: 34 },
  { color: "#223344", widthPct: 33 },
  { color: "#334455", widthPct: 33 },
];

describe("divider — [Multicolour bar] est un groupe fermé", () => {
  test("un seul groupe, fermé, id du type, résumé « N set » = N tranches", () => {
    const on = divider(THREE).groups;
    expect(on.length).toBe(1);
    expect(on[0]).toEqual({ id: "divider.segments", title: "Multicolour bar", summary: "3 set", defaultOpen: undefined, depth: 0 });
    expect(divider(undefined).groups[0].summary).toBe("defaults");
  });

  test("tous les réglages de la barre sont dans le groupe", () => {
    const { leaves } = divider(THREE);
    for (const label of ["Segments", "Segment 1 colour", "Segment 3 width", "Remove segment 2", "Add a segment"]) {
      expect(leaf(leaves, label).groups).toEqual(["Multicolour bar"]);
    }
  });

  test("⛔ l'avertissement de largeur reste HORS du groupe : visible barre repliée", () => {
    const ok = divider(THREE).leaves.filter((l) => l.name === "Note");
    expect(ok).toEqual([]);
    const short = divider([
      { color: "#112233", widthPct: 40 },
      { color: "#223344", widthPct: 50 },
    ]).leaves.filter((l) => l.name === "Note");
    expect(short.length).toBe(1);
    expect(short[0].groups).toEqual([]);
  });

  test("les écritures sont inchangées : allumer, régler une tranche", () => {
    const off = divider(undefined);
    (leaf(off.leaves, "Segments").props.onChange as (v: boolean) => void)(true);
    expect(off.sink.at(-1)).toEqual([
      { color: "#aaaaaa", widthPct: 50 },
      { color: "#bbbbbb", widthPct: 50 },
    ]);
    const on = divider(THREE);
    (leaf(on.leaves, "Segment 2 width").props.onChange as (v: number) => void)(20);
    expect(on.sink.at(-1)).toEqual([THREE[0], { color: "#223344", widthPct: 20 }, THREE[2]]);
    (leaf(on.leaves, "Segments").props.onChange as (v: boolean) => void)(false);
    expect(on.sink.at(-1)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 3. L'apparence du bouton, du menu et des icônes : fermée, mémorisée par type de bloc
 * ------------------------------------------------------------------ */

describe("button / menu / social — l'apparence est un groupe fermé à id de son type", () => {
  const button = parsed<Extract<Block, { type: "button" }>>({ type: "button", label: "Go", href: "https://example.test/go" });
  const menu = parsed<Extract<Block, { type: "menu" }>>({
    type: "menu",
    separator: "|",
    items: [{ label: "News", href: "https://example.test/n" }],
  });
  const soc = parsed<Extract<Block, { type: "social" }>>({ type: "social", items: [{ platform: "facebook", href: "https://facebook.com/banc" }] });
  const base = { fontSize: 16 };
  const cases: [string, SeenGroup[]][] = [
    ["button", walk(ButtonLookFields({ block: button.block, theme: button.theme, base, patch: () => {} })).groups],
    ["menu", walk(MenuLookFields({ block: menu.block, theme: menu.theme, base, patch: () => {} })).groups],
    ["social", walk(SocialLookFields({ block: soc.block, theme: soc.theme, patch: () => {} })).groups],
  ];

  test("un groupe fermé chacun, dont l'id commence par le type du bloc", () => {
    expect(cases.map(([type, g]) => [type, g.length, g[0].defaultOpen === true, g[0].id?.split(".")[0]])).toEqual([
      ["button", 1, false, "button"],
      ["menu", 1, false, "menu"],
      ["social", 1, false, "social"],
    ]);
  });

  test("aucun id de ce lot n'en recoupe un autre (liens sociaux compris)", () => {
    const ids = [
      ...cases.map(([, g]) => g[0].id),
      ...divider(THREE).groups.map((g) => g.id),
      ...social(FOUR).groups.map((g) => g.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
