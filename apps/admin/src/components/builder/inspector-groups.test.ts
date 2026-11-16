/**
 * LES SOUS-SECTIONS DE L'INSPECTEUR (`Group`, `inspector-ui.tsx`) — `bun test` depuis la racine.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER :
 *   1. un hook dans `Group` : rien ne casserait à l'écran, mais le banc des contrôles
 *      (`inspector-controls.test.ts`), qui appelle `Group` et les éditeurs comme des fonctions pour
 *      atteindre le `onChange` réel de chaque champ, deviendrait impossible ;
 *   2. une mémoire ouvert / fermé qui confond deux groupes, ou qui tombe avec le stockage du
 *      navigateur (navigation privée, stockage bloqué) ;
 *   3. deux `Group` du builder sous le même `id` : ils s'ouvriraient et se fermeraient ensemble.
 *
 * Les éléments rendus sont lus comme des objets (props du `<details>`), sans rendu React : le dépôt
 * n'a pas de banc de rendu, et c'est justement l'appel « comme une fonction » qu'on protège.
 * Le navigateur est simulé au plus juste : `onToggle` reçoit `{ currentTarget: { open } }`, et
 * `sessionStorage` est posé puis retiré par chaque test qui en a besoin (bun n'en a pas).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement } from "react";
import ts from "typescript";
import { Group, openGroup, overrides } from "./inspector-ui";

/* ------------------------------------------------------------------ *
 * Banc
 * ------------------------------------------------------------------ */

type GroupProps = Parameters<typeof Group>[0];

/** `Group` appelé comme une fonction — exactement ce que fait le banc des contrôles. */
function details(props: Omit<GroupProps, "children">) {
  const el = Group({ ...props, children: "champ" });
  if (!isValidElement(el)) throw new Error("Group n'a pas rendu un élément");
  return el as unknown as {
    type: unknown;
    key: string | null;
    props: { open?: boolean; onToggle?: (e: { currentTarget: { open: boolean } }) => void; children: unknown };
  };
}

/** Ce que fait le navigateur quand l'utilisateur clique l'en-tête : l'attribut change, puis `toggle`. */
function toggle(el: ReturnType<typeof details>, open: boolean) {
  if (el.props.onToggle === undefined) throw new Error("pas de onToggle : ce groupe n'a pas d'id");
  el.props.onToggle({ currentTarget: { open } });
}

/** Texte visible d'un arbre d'éléments hôtes (l'icône, composant, est ignorée). */
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement(node) && typeof node.type === "string") return text((node.props as { children?: unknown }).children);
  return "";
}

/** La mémoire est celle du module, partagée par tout le fichier : un `id` neuf par test. */
let seq = 0;
const fresh = (part: string) => `banc-groups.${part}.${++seq}`;

/** Clé écrite en dur : un banc qui la recalculerait avec le code surveillé ne mesurerait que lui-même. */
const STORED = (id: string) => `nf.builder.group:${id}`;

/** Pose un `sessionStorage` le temps de `fn`, puis rend l'état d'origine (bun n'en a pas). */
function withStorage(storage: PropertyDescriptor, fn: () => void) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, ...storage });
  try {
    fn();
  } finally {
    if (before) Object.defineProperty(globalThis, "sessionStorage", before);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

/* ------------------------------------------------------------------ *
 * 1. Sans hook, et rétrocompatible
 * ------------------------------------------------------------------ */

describe("Group — appelé comme une fonction, hors de React", () => {
  test("se rend sans hook : un <details> avec le titre et le résumé", () => {
    // Un `useState` dans Group lève ici (« Invalid hook call » / dispatcher nul), comme dans le banc.
    const el = details({ title: "Odds badge", summary: "2 set" });
    expect(el.type).toBe("details");
    expect(text(el)).toContain("Odds badge");
    expect(text(el)).toContain("2 set");
    expect(text(el)).toContain("champ");
  });

  test("sans id ni defaultOpen : fermé, sans clé ni écriture — le rendu d'avant pour les appelants actuels", () => {
    const el = details({ title: "Card" });
    expect(el.props.open).toBe(false);
    expect(el.key).toBeNull();
    expect(el.props.onToggle).toBeUndefined();
  });

  test("avec id : la clé React est l'id (un autre id = un autre nœud DOM)", () => {
    const id = fresh("key");
    expect(details({ id, title: "Title" }).key).toBe(id);
  });
});

/* ------------------------------------------------------------------ *
 * 2. defaultOpen, puis mémoire
 * ------------------------------------------------------------------ */

describe("Group — état ouvert / fermé", () => {
  test("defaultOpen est respecté quand rien n'est mémorisé", () => {
    expect(details({ title: "Title", defaultOpen: true }).props.open).toBe(true);
    expect(details({ title: "Title", defaultOpen: false }).props.open).toBe(false);
    expect(details({ id: fresh("default"), title: "Title", defaultOpen: true }).props.open).toBe(true);
    expect(details({ id: fresh("default"), title: "Title" }).props.open).toBe(false);
  });

  test("la mémoire relit, pour le MÊME id, l'état écrit par onToggle — et pour lui seul", () => {
    const a = fresh("a");
    const b = fresh("b");
    toggle(details({ id: a, title: "Title" }), true);
    expect(details({ id: a, title: "Title" }).props.open).toBe(true);
    expect(details({ id: b, title: "Title" }).props.open).toBe(false);

    // Fermé à la main : la mémoire l'emporte sur defaultOpen.
    toggle(details({ id: a, title: "Title" }), false);
    expect(details({ id: a, title: "Title", defaultOpen: true }).props.open).toBe(false);
    expect(details({ id: b, title: "Title", defaultOpen: true }).props.open).toBe(true);
  });

  test("le `toggle` que le navigateur émet au montage d'un groupe ouvert par défaut n'écrit rien", () => {
    // Sans ce filtre, afficher un bloc rempli (défaut « ouvert ») figerait « ouvert » pour tous les
    // blocs du même type, même vides.
    const id = fresh("mount");
    toggle(details({ id, title: "Title", defaultOpen: true }), true);
    expect(details({ id, title: "Title", defaultOpen: false }).props.open).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 3. sessionStorage
 * ------------------------------------------------------------------ */

describe("Group — sessionStorage", () => {
  test("écrit sous la clé de l'id, et relit après un rechargement (id absent de la mémoire du module)", () => {
    const storage = memoryStorage();
    withStorage({ value: storage }, () => {
      const id = fresh("store");
      toggle(details({ id, title: "Title" }), true);
      expect(storage.items.get(STORED(id))).toBe("1");
      toggle(details({ id, title: "Title" }), false);
      expect(storage.items.get(STORED(id))).toBe("0");

      const reloaded = fresh("reload");
      storage.items.set(STORED(reloaded), "1");
      expect(details({ id: reloaded, title: "Title" }).props.open).toBe(true);
    });
  });

  test("un sessionStorage qui lève ne casse rien : la mémoire du module prend le relais", () => {
    const refuse = () => {
      throw new Error("SecurityError: The operation is insecure.");
    };
    // L'accès lui-même lève (stockage bloqué) …
    withStorage({ get: refuse }, () => {
      const id = fresh("blocked");
      expect(details({ id, title: "Title" }).props.open).toBe(false);
      toggle(details({ id, title: "Title" }), true);
      expect(details({ id, title: "Title" }).props.open).toBe(true);
    });
    // … ou ses méthodes (quota plein, navigation privée).
    withStorage({ value: { getItem: refuse, setItem: refuse } }, () => {
      const id = fresh("quota");
      expect(details({ id, title: "Title", defaultOpen: true }).props.open).toBe(true);
      toggle(details({ id, title: "Title", defaultOpen: true }), false);
      expect(details({ id, title: "Title", defaultOpen: true }).props.open).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------ *
 * 3 bis. openGroup : ouvrir d'avance, par le geste, sans hook
 * ------------------------------------------------------------------ */

describe("openGroup — la carte qu'on vient d'ajouter s'ouvre", () => {
  test("écrit « ouvert » pour CET id : le Group le relit, même fermé à la main avant, même defaultOpen faux", () => {
    const id = fresh("open");
    const other = fresh("open-other");
    // Fermé à la main (ouvert puis refermé) : la mémoire dit « fermé ».
    toggle(details({ id, title: "Row 4" }), true);
    toggle(details({ id, title: "Row 4" }), false);
    toggle(details({ id: other, title: "Row 1" }), true);
    expect(details({ id, title: "Row 4" }).props.open).toBe(false);

    openGroup(id);
    expect(details({ id, title: "Row 4" }).props.open).toBe(true);
    expect(details({ id, title: "Row 4", defaultOpen: false }).props.open).toBe(true);
    // Les autres gardent leur état : l'ouvert reste ouvert, un id jamais touché reste fermé.
    expect(details({ id: other, title: "Row 1" }).props.open).toBe(true);
    expect(details({ id: fresh("open-untouched"), title: "Row 2" }).props.open).toBe(false);
    // Et la main garde le dernier mot : refermée ensuite, la carte reste fermée.
    toggle(details({ id, title: "Row 4" }), false);
    expect(details({ id, title: "Row 4" }).props.open).toBe(false);
  });

  test("écrit aussi dans sessionStorage, sous la clé de l'id", () => {
    const storage = memoryStorage();
    withStorage({ value: storage }, () => {
      const id = fresh("open-store");
      openGroup(id);
      expect(storage.items.get(STORED(id))).toBe("1");
      expect(storage.items.size).toBe(1);
    });
  });

  test("un sessionStorage qui lève ne casse ni l'appel ni l'ouverture", () => {
    const refuse = () => {
      throw new Error("SecurityError: The operation is insecure.");
    };
    // Un appel qui lèverait ferait tomber le test ici même.
    withStorage({ get: refuse }, () => {
      const id = fresh("open-blocked");
      openGroup(id);
      expect(details({ id, title: "Title" }).props.open).toBe(true);
    });
    withStorage({ value: { getItem: refuse, setItem: refuse } }, () => {
      const id = fresh("open-quota");
      openGroup(id);
      expect(details({ id, title: "Title" }).props.open).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ *
 * 4. Le résumé : une seule forme
 * ------------------------------------------------------------------ */

describe("overrides — la forme unique du résumé", () => {
  test("« defaults » ou « N set », sur une liste de clés ou sur tout un sous-objet", () => {
    expect(overrides({ a: 1, b: undefined, c: "x" }, ["a", "b"])).toBe("1 set");
    expect(overrides({ a: 1 }, ["b"])).toBe("defaults");
    expect(overrides(undefined)).toBe("defaults");
    expect(overrides({})).toBe("defaults");
    expect(overrides({ kickerMode: "text", kickerText: "Destacada", style: undefined })).toBe("2 set");
  });
});

/* ------------------------------------------------------------------ *
 * 5. Garde statique : un id littéral n'est porté qu'une fois dans le builder
 * ------------------------------------------------------------------ */

/**
 * Les `<Group>` d'un source TSX, et leurs `id` LITTÉRAUX (`id="x"`, `id={"x"}`, `id={`x`}`).
 * ⛔ Un id calculé (`id={`${prefix}.title`}`) n'est PAS vérifié ici : c'est à l'appelant de garantir
 * que chaque montage reçoit un préfixe distinct.
 */
function groupIds(file: string, source: string) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let groups = 0;
  const ids: { id: string; at: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === "Group"
    ) {
      groups++;
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== "id" || attr.initializer === undefined) continue;
        const value = ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr.initializer;
        if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
          ids.push({ id: value.text, at: `${file}:${sf.getLineAndCharacterOfPosition(attr.getStart(sf)).line + 1}` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { groups, ids };
}

/** « id → lieux » pour chaque id porté plus d'une fois. */
function duplicates(ids: { id: string; at: string }[]): string[] {
  const where = new Map<string, string[]>();
  for (const { id, at } of ids) where.set(id, [...(where.get(id) ?? []), at]);
  return [...where].filter(([, at]) => at.length > 1).map(([id, at]) => `${id} → ${at.join(", ")}`);
}

describe("garde : ids de Group uniques dans le builder", () => {
  test("le garde voit les trois formes littérales, et un doublon", () => {
    const { groups, ids } = groupIds(
      "banc.tsx",
      'const x = <><Group id="a.b" title="A">x</Group><Group id={"a.b"} title="B" /><Group id={`a.c`} title="C">y</Group><Group title="D">z</Group></>;',
    );
    expect(groups).toBe(4);
    expect(ids.map((i) => i.id)).toEqual(["a.b", "a.b", "a.c"]);
    expect(duplicates(ids)).toEqual(["a.b → banc.tsx:1, banc.tsx:1"]);
  });

  test("aucun id littéral n'est porté par deux Group de apps/admin/src/components/builder/*.tsx", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
    let groups = 0;
    const ids: { id: string; at: string }[] = [];
    for (const f of files) {
      const found = groupIds(f, readFileSync(join(dir, f), "utf8"));
      groups += found.groups;
      ids.push(...found.ids);
    }
    // Le garde doit VOIR le builder : un dossier mal lu serait vert sans rien vérifier.
    expect(files).toContain("inspector.tsx");
    expect(groups).toBeGreaterThan(19);
    expect(duplicates(ids)).toEqual([]);
  });
});
