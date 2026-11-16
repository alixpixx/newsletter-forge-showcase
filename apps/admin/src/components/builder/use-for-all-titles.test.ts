/**
 * « USE FOR ALL TITLES » ET « CUSTOM STYLE » (24/09/2026, feature 5, étape 5).
 *
 * Ce qui est tenu :
 *  - sur un modèle IMPORTÉ (une couleur par titre), un clic efface la couleur propre de chaque titre et
 *    pose le style global ; rien d'autre ne bouge dans le document ;
 *  - ⛔ un titre posé sur un fond coloré (bloc, colonne, rangée ; look ou flux) garde la sienne, et un
 *    encart mis en page (`layout`) aussi ; un fond égal au fond du contenu n'est PAS « coloré » ;
 *  - les couleurs de rangée et de colonne, et le texte courant, ne sont jamais touchés ;
 *  - une seule étape d'annulation (reducer) ;
 *  - l'e-mail compilé : les titres effacés prennent la couleur globale, les titres gardés la leur ;
 *  - le lien n'apparaît que sous une couleur de titre POSÉE, et appelle l'action avec cette couleur ;
 *  - « Custom style » : statut « Uses the email styles » / « Reset to email styles », qui rend l'absence.
 */
import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { compileDoc } from "@nf/render/compile";
import { EmailDoc, Theme } from "@nf/render/schema";
import { ArticleLookFields, FontInput, resolveLookBase } from "./article-look-fields";
import { BlockCustomStyle, CalloutEditor, StylePanel } from "./inspector";
import { Group } from "./inspector-ui";
import { builderReducer, initBuilderState } from "./reducer";
import { utiliserPourTousLesTitres } from "./titres-globaux";

type Json = Record<string, unknown>;
const NOUVELLE = "#0B6E4F";
const IMPORTEE = "#AA0000";
const BLANC = "#FEFEFE";
const SOMBRE = "#101030";
const p = (text: string): Json => ({ spans: [{ text }] });
const row = (id: string, blocks: Json[], extra: Json = {}, col: Json = {}): Json => ({
  id,
  layout: "1",
  columns: [{ id: `${id}_c`, blocks, ...col }],
  ...extra,
});
const ITEM = (n: number) => ({
  postId: `post-${n}`,
  title: `Carte ${n}`,
  excerpt: `Chapeau ${n}`,
  href: `https://example.test/article-${n}`,
  imageAlt: "",
  publishedAt: "2026-09-22T21:42:00.000Z",
});

/** Un modèle importé : chaque titre porte SA couleur, comme après un import HTML. */
function importe(rows?: Json[]): EmailDoc {
  return EmailDoc.parse({
    schema: 2,
    meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "banc", locale: "en" },
    theme: { fontFamily: "Arial, sans-serif", textColor: "#1A1A20", contentBackground: "#FEFEFE" },
    rows: rows ?? [
      row("r_txt", [
        { id: "h1", type: "text", preset: "h1", style: { textColor: IMPORTEE, fontSize: 30 }, paragraphs: [p("Titre un")] },
        { id: "h2", type: "text", preset: "h2", style: { textColor: IMPORTEE }, paragraphs: [p("Titre deux")] },
        { id: "body", type: "text", preset: "body", style: { textColor: IMPORTEE }, paragraphs: [p("Texte courant")] },
        { id: "sec", type: "section_title", label: "Rubrique", rule: "none", style: { textColor: IMPORTEE } },
        {
          id: "art",
          type: "article",
          title: "Titre article",
          excerpt: "Chapeau article.",
          imageAlt: "",
          href: "https://news.example.com/a",
          titleColor: IMPORTEE,
        },
        {
          id: "call",
          type: "callout",
          kicker: "",
          title: "Titre encart",
          body: "Corps encart.",
          href: "https://example.com/c",
          ctaLabel: "Bouton",
          titleColor: IMPORTEE,
        },
        {
          id: "feed",
          type: "article-feed",
          sourceId: "src_1",
          count: 3,
          leadCount: 1,
          previewItems: [ITEM(1), ITEM(2), ITEM(3)],
          previewAt: "2026-09-22T12:00:00.000Z",
          lead: { titleColor: IMPORTEE },
          card: { titleColor: IMPORTEE, titleSize: 18 },
          midSection: { label: "Plus", style: { textColor: IMPORTEE } },
        },
      ]),
    ],
  });
}

const blocs = (d: EmailDoc) => d.rows.flatMap((r) => r.columns.flatMap((c) => c.blocks));
const bloc = (d: EmailDoc, id: string) => blocs(d).find((b) => b.id === id) as Json;

describe("modèle importé : les couleurs propres des titres tombent, rien d'autre ne bouge", () => {
  test("8 couleurs de titre effacées (h1, h2, rubrique, article, encart, une, brèves, intertitre), le style global posé, le texte courant intact", () => {
    const avant = importe();
    const { doc, effaces, gardes } = utiliserPourTousLesTitres(avant, NOUVELLE);
    expect([effaces, gardes]).toEqual([8, 0]);
    expect(doc.theme.headingColor).toBe(NOUVELLE);

    // Ce qui DOIT rester : la taille du h1, le texte courant, la taille des brèves, l'intertitre.
    const attendu = JSON.parse(JSON.stringify(avant)) as Json;
    const b = (attendu.rows as Json[])[0]!.columns as Json[];
    const liste = b[0]!.blocks as Json[];
    const par = (id: string) => liste.find((x) => x.id === id) as Json;
    par("h1").style = { fontSize: 30 };
    delete par("h2").style;
    delete par("sec").style;
    delete par("art").titleColor;
    delete par("call").titleColor;
    const feed = par("feed");
    delete (feed.lead as Json).titleColor;
    delete (feed.card as Json).titleColor;
    delete (feed.midSection as Json).style;
    (attendu.theme as Json).headingColor = NOUVELLE;
    expect(JSON.parse(JSON.stringify(doc))).toEqual(attendu);
    // Le texte courant garde sa couleur : ce n'est pas un titre.
    expect((bloc(doc, "body").style as Json).textColor).toBe(IMPORTEE);
  });

  test("le document d'origine n'est pas modifié (le reducer garde l'état précédent pour l'annulation)", () => {
    const avant = importe();
    const photo = JSON.stringify(avant);
    utiliserPourTousLesTitres(avant, NOUVELLE);
    expect(JSON.stringify(avant)).toBe(photo);
  });
});

describe("⛔ un titre sur fond coloré garde sa couleur", () => {
  const h = (id: string, style: Json): Json => ({ id, type: "text", preset: "h2", style, paragraphs: [p(id)] });

  test("fond du bloc, de la colonne, de la rangée : gardés ; fond égal au contenu (casse près) : effacé", () => {
    const d = importe([
      row("r1", [h("sur_bloc", { textColor: BLANC, backgroundColor: SOMBRE })]),
      row("r2", [h("sur_colonne", { textColor: BLANC })], {}, { style: { backgroundColor: SOMBRE } }),
      row("r3", [h("sur_rangee", { textColor: BLANC })], { style: { backgroundColor: SOMBRE } }),
      row("r4", [h("fond_contenu", { textColor: IMPORTEE, backgroundColor: "#fefefe" })]),
    ]);
    const { doc, effaces, gardes } = utiliserPourTousLesTitres(d, NOUVELLE);
    expect([effaces, gardes]).toEqual([1, 3]);
    for (const id of ["sur_bloc", "sur_colonne", "sur_rangee"]) expect([id, (bloc(doc, id).style as Json).textColor]).toEqual([id, BLANC]);
    expect(bloc(doc, "fond_contenu").style).toEqual({ backgroundColor: "#fefefe" });
    // Les couleurs de rangée et de colonne ne sont jamais touchées.
    expect(doc.rows[1]!.columns[0]!.style).toEqual({ backgroundColor: SOMBRE });
    expect(doc.rows[2]!.style).toEqual({ backgroundColor: SOMBRE });
  });

  test("un encart mis en page (`layout`) est toujours gardé, même sur fond blanc", () => {
    const d = importe([
      row("r", [
        {
          id: "lay",
          type: "callout",
          layout: "strip",
          kicker: "",
          title: "Mis en page",
          body: "Corps.",
          href: "https://example.com/l",
          ctaLabel: "Go",
          titleColor: BLANC,
        },
      ]),
    ]);
    const { doc, gardes } = utiliserPourTousLesTitres(d, NOUVELLE);
    expect(gardes).toBe(1);
    expect(bloc(doc, "lay").titleColor).toBe(BLANC);
  });

  test("look de flux : son propre fond, sinon celui du flux", () => {
    const d = importe([
      row("r", [
        {
          id: "feed",
          type: "article-feed",
          sourceId: "src_1",
          count: 3,
          leadCount: 1,
          previewItems: [ITEM(1), ITEM(2), ITEM(3)],
          previewAt: "2026-09-22T12:00:00.000Z",
          style: { backgroundColor: SOMBRE },
          lead: { titleColor: BLANC },
          card: { titleColor: IMPORTEE, style: { backgroundColor: "#FEFEFE" } },
        },
      ]),
    ]);
    const { doc, effaces, gardes } = utiliserPourTousLesTitres(d, NOUVELLE);
    expect([effaces, gardes]).toEqual([1, 1]);
    expect((bloc(doc, "feed").lead as Json).titleColor).toBe(BLANC);
    expect((bloc(doc, "feed").card as Json).titleColor).toBeUndefined();
  });
});

describe("reducer : une seule étape d'annulation", () => {
  test("useForAllTitles puis undo rend le document d'avant, à l'identique", () => {
    const avant = importe();
    const s1 = builderReducer(initBuilderState(avant), { type: "useForAllTitles", color: NOUVELLE });
    expect(s1.present.theme.headingColor).toBe(NOUVELLE);
    expect(s1.past.length).toBe(1);
    const s2 = builderReducer(s1, { type: "undo" });
    expect(JSON.stringify(s2.present)).toBe(JSON.stringify(avant));
  });

  test("un second clic (rien à effacer, couleur déjà posée) n'empile rien", () => {
    const s1 = builderReducer(initBuilderState(importe()), { type: "useForAllTitles", color: NOUVELLE });
    expect(builderReducer(s1, { type: "useForAllTitles", color: NOUVELLE })).toBe(s1);
    // Une autre couleur, elle, change le style global : une étape de plus.
    expect(builderReducer(s1, { type: "useForAllTitles", color: "#222230" }).past.length).toBe(2);
  });
});

describe("l'e-mail compilé", () => {
  /** Le style de l'élément qui porte le texte (n=1). */
  function styleDe(html: string, texte: string): string {
    const i = html.indexOf(`>${texte}<`);
    if (i < 0) throw new Error(`texte introuvable : ${texte}`);
    const styles = [...html.slice(0, i + 1).matchAll(/style="([^"]*)"/g)].map((m) => m[1] as string);
    return styles[styles.length - 1] ?? "";
  }

  test("les titres effacés prennent la couleur globale ; le titre sur bandeau garde la sienne", async () => {
    const d = importe([
      row("r1", [{ id: "a", type: "text", preset: "h1", style: { textColor: IMPORTEE }, paragraphs: [p("Titre libre")] }]),
      row("r2", [
        { id: "b", type: "text", preset: "h1", style: { textColor: BLANC, backgroundColor: SOMBRE }, paragraphs: [p("Titre bandeau")] },
      ]),
      row("r3", [{ id: "c", type: "section_title", label: "Rubrique", rule: "none", style: { textColor: IMPORTEE } }]),
    ]);
    const { html } = await compileDoc(utiliserPourTousLesTitres(d, NOUVELLE).doc);
    expect(styleDe(html, "Titre libre")).toContain(`color:${NOUVELLE}`);
    expect(styleDe(html, "Rubrique")).toContain(`color:${NOUVELLE}`);
    expect(styleDe(html, "Titre bandeau")).toContain(`color:${BLANC}`);
    expect(html.toLowerCase()).not.toContain(IMPORTEE.toLowerCase());
  });
});

/* ------------------------------------------------------------------ *
 * Le lien dans l'inspecteur
 * ------------------------------------------------------------------ */

const EXPAND = new Set<unknown>([Group, FontInput, StylePanel]);
interface Leaf {
  name: string;
  props: Record<string, unknown>;
}
function leaves(node: ReactNode, out: Leaf[] = []): Leaf[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) leaves(n as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const type = node.type as unknown;
  const props = node.props as Record<string, unknown>;
  if (typeof type === "function") {
    if (EXPAND.has(type)) leaves((type as (p: unknown) => ReactNode)(props), out);
    else out.push({ name: (type as { name: string }).name, props });
    return out;
  }
  return leaves(props.children as ReactNode, out);
}
const liens = (tree: ReactNode) => leaves(tree).filter((l) => l.name === "UseForAllTitles");

describe("le lien « Use for all titles »", () => {
  const theme = Theme.parse({ textColor: "#1A1A20" });
  const base = resolveLookBase(theme, []);
  const ENCART = { id: "c", type: "callout", kicker: "", title: "T", body: "B", href: "https://example.com/c", ctaLabel: "Go" };

  test("encart : présent sous une couleur de titre posée, absent sinon ; il envoie CETTE couleur", () => {
    const recu: string[] = [];
    const onUse = (c: string) => recu.push(c);
    const encart = (titleColor?: string) =>
      CalloutEditor({
        block: { ...ENCART, ...(titleColor ? { titleColor } : {}) } as never,
        patch: () => {},
        theme,
        base,
        onUseForAllTitles: onUse,
      });
    expect(liens(encart()).length).toBe(0);
    const trouves = liens(encart(IMPORTEE));
    expect(trouves.length).toBe(1);
    (trouves[0]!.props.onUse as (c: string) => void)(trouves[0]!.props.color as string);
    expect(recu).toEqual([IMPORTEE]);
    // Sans action branchée, pas de lien (un bouton qui ne fait rien est un mensonge d'interface).
    expect(liens(CalloutEditor({ block: { ...ENCART, titleColor: IMPORTEE } as never, patch: () => {}, theme, base })).length).toBe(0);
  });

  test("article et look de flux : sous « Title colour » posée", () => {
    const recu: string[] = [];
    const champs = (titleColor?: string) =>
      ArticleLookFields({
        mode: "look",
        value: titleColor ? { titleColor } : {},
        onPatch: () => {},
        theme,
        base,
        accent: { color: "#000000", from: "x" },
        cta: { hint: "" },
        onUseForAllTitles: (c) => recu.push(c),
      });
    expect(liens(champs()).length).toBe(0);
    const trouves = liens(champs(IMPORTEE));
    expect(trouves.length).toBe(1);
    (trouves[0]!.props.onUse as (c: string) => void)(trouves[0]!.props.color as string);
    expect(recu).toEqual([IMPORTEE]);
  });

  test("onglet Style : sous « Text color » d'un TITRE à couleur posée, jamais d'un texte courant", () => {
    const panneau = (titre: boolean, textColor?: string) =>
      StylePanel({
        scope: "block",
        style: textColor ? { textColor } : undefined,
        onChange: () => {},
        theme,
        parents: [],
        defaultPadding: theme.blockPadding,
        titre,
        onUseForAllTitles: () => {},
      });
    expect(liens(panneau(true, IMPORTEE)).map((l) => l.props.color)).toEqual([IMPORTEE]);
    expect(liens(panneau(true)).length).toBe(0);
    expect(liens(panneau(false, IMPORTEE)).length).toBe(0);
  });
});

describe("« Custom style » (portée Block de l'onglet Style)", () => {
  const theme = Theme.parse({ textColor: "#1A1A20" });
  const monte = (style: Json | undefined) => {
    let ecrit: unknown = "rien";
    const tree = BlockCustomStyle({
      style: style as never,
      theme,
      parents: [],
      onChange: (next) => (ecrit = next),
      titre: true,
      onUseForAllTitles: () => {},
    });
    return { tree, ecrit: () => ecrit };
  };
  const boutons = (tree: ReactNode) => leaves(tree).filter((l) => l.name === "MiniBtn" && l.props.label === "Reset this block to the email styles");
  const texte = (tree: ReactNode): string => {
    const out: string[] = [];
    const walk = (n: ReactNode) => {
      if (typeof n === "string") out.push(n);
      else if (Array.isArray(n)) n.forEach((x) => walk(x as ReactNode));
      else if (isValidElement(n) && typeof n.type === "string") walk((n.props as { children?: ReactNode }).children);
      else if (isValidElement(n) && n.type !== Group) walk((n.props as { children?: ReactNode }).children);
    };
    walk(tree);
    return out.join("");
  };

  test("sans style propre : « Uses the email styles », pas de bouton, groupe fermé", () => {
    const { tree } = monte(undefined);
    expect(texte(tree)).toContain("Uses the email styles.");
    expect(boutons(tree).length).toBe(0);
  });

  test("avec un style propre : le compte, et « Reset to email styles » rend l'ABSENCE", () => {
    const { tree, ecrit } = monte({ textColor: IMPORTEE, fontSize: 20 });
    expect(texte(tree)).toContain("Has its own style (2 set).");
    const b = boutons(tree);
    expect(b.length).toBe(1);
    (b[0]!.props.onClick as () => void)();
    expect(ecrit()).toBeUndefined();
  });

  test("le panneau est DANS le groupe « Custom style », avec le lien des titres", () => {
    const { tree } = monte({ textColor: IMPORTEE });
    expect(liens(tree).map((l) => l.props.color)).toEqual([IMPORTEE]);
  });
});
