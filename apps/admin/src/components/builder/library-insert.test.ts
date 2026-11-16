/**
 * IMPORTER UN BLOC DE LA BIBLIOTHÈQUE — où il atterrit, et ce qu'il emporte (fente `block`, 0080).
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER :
 *  1. qu'un bloc se pose SOUS le pied légal ou ENTRE le footer importé et le légal parce que la
 *     sélection était dans le pied — sur un modèle neuf, c'est la seule row, donc la sélection normale ;
 *  2. qu'un bloc de deux rows arrive en deux gestes, ou dans le désordre ;
 *  3. que le document reçoive les ids STOCKÉS dans la bibliothèque : ils sont humains et partagés
 *     entre modèles, et une seconde insertion serait refusée en silence par le réducteur ;
 *  4. que « Saved blocks » (palette) ou l'onglet Blocks (modale) liste un header ou un footer, ou
 *     qu'un bloc apparaisse sous l'onglet Header ;
 *  5. que « Save this row » écrive ailleurs que dans la bibliothèque de blocs.
 *
 * On mesure sur les formes RÉELLES : `initialDoc` (texte et légal dans la même colonne), un document
 * rangé avec footer importé, et le document d'un bloc en cours d'édition (aucun légal).
 */
import { describe, expect, test } from "bun:test";
import { withFreshRowIds, type EmailDoc, type Row } from "@nf/render/schema";
import { fauxDb } from "@/lib/testing/faux-db";
import type { PartialEntry } from "@/components/templates/library-client";
import {
  actionImport,
  blocsDeLaBibliotheque,
  corpsSaveThisRow,
  indexInsertionBloc,
  ouInsererBloc,
} from "./library-insert";
import { builderReducer, initBuilderState, type BuilderAction } from "./reducer";

// ⚠️ `templates.ts` et `brand-partials.ts` tirent `@/lib/session` → `auth.ts`, qui LÈVE à l'import sans
// AUTH_SECRET : poser la variable, PUIS charger dynamiquement.
process.env.AUTH_SECRET = "secret-de-test-uniquement-23092026";
const { initialDoc } = await import("@/lib/data/templates");
const { getBrandPartial } = await import("@/lib/data/brand-partials");
const { ONGLETS, entreesDeLOnglet } = await import("./import-template-dialog");

const bloc = (id: string) => ({ id, type: "text", paragraphs: [] }) as never;
const legal = { id: "blk_legal", type: "footer_legal" } as never;
const ligne = (id: string, blocks: unknown[]): Row => ({ id, layout: "1", columns: [{ id: `${id}_col`, blocks }] }) as Row;
const docDe = (rows: Row[]) => ({ schema: 2, meta: {}, theme: {}, rows }) as unknown as EmailDoc;

const appliquer = (doc: EmailDoc, ...actions: BuilderAction[]) =>
  actions.reduce((s, a) => builderReducer(s, a), initBuilderState(doc)).present;
const idsDeRows = (doc: EmailDoc) => doc.rows.map((r) => r.id);

/** Un document rangé : corps A, B, C puis la ligne légale seule. */
const RANGE = () => docDe([ligne("A", [bloc("a")]), ligne("B", [bloc("b")]), ligne("C", [bloc("c")]), ligne("L", [legal])]);
/** Deux rows d'un bloc, telles que la bibliothèque les sert (ids neufs, préfixe `row`). */
const BLOC_2 = () => [withFreshRowIds(ligne("x1", [bloc("x1b")])), withFreshRowIds(ligne("x2", [bloc("x2b")]))];

describe("indexInsertionBloc + actionImport — où atterrit un bloc", () => {
  test("sélection dans la row B : un bloc d'UNE row se pose juste après B", () => {
    const doc = RANGE();
    const [x] = BLOC_2();
    const apres = appliquer(doc, actionImport("block", [x!], doc, { rowId: "B" }));
    expect(idsDeRows(apres)).toEqual(["A", "B", x!.id, "C", "L"]);
  });

  test("sélection dans la row B : un bloc de DEUX rows se pose après B, dans son ordre, en UN geste", () => {
    const doc = RANGE();
    const rows = BLOC_2();
    const etat = builderReducer(initBuilderState(doc), actionImport("block", rows, doc, { rowId: "B" }));
    expect(idsDeRows(etat.present)).toEqual(["A", "B", rows[0]!.id, rows[1]!.id, "C", "L"]);
    // Un seul pas d'historique : un Ctrl+Z défait le bloc entier.
    expect(etat.past).toHaveLength(1);
  });

  test("sans sélection : juste au-dessus du pied légal", () => {
    const doc = RANGE();
    const rows = BLOC_2();
    expect(indexInsertionBloc(doc, null)).toBe(undefined);
    expect(idsDeRows(appliquer(doc, actionImport("block", rows, doc, null)))).toEqual([
      "A",
      "B",
      "C",
      rows[0]!.id,
      rows[1]!.id,
      "L",
    ]);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer `if (pied !== -1 && i >= pied) return undefined;`.
   * Symptôme : le bloc passe SOUS les mentions légales, et le pré-vol crie « le pied légal n'est pas
   * le dernier bloc » sur un geste que l'auteur croyait anodin.
   */
  test("⛔ sélection DANS la ligne légale : au-dessus du pied, jamais sous le légal", () => {
    const doc = RANGE();
    const rows = BLOC_2();
    expect(indexInsertionBloc(doc, { rowId: "L" })).toBe(undefined);
    const apres = appliquer(doc, actionImport("block", rows, doc, { rowId: "L" }));
    expect(apres.rows.at(-1)!.id).toBe("L");
  });

  test("⛔ modèle NEUF (`initialDoc`, texte et légal dans la même row, sélectionnée) : entre le texte et le légal", () => {
    const doc = initialDoc("pf", "es", "Essai");
    const seule = doc.rows[0]!;
    const rows = BLOC_2();
    const apres = appliquer(doc, actionImport("block", rows, doc, { rowId: seule.id }));
    // La row est coupée par le réducteur : le texte reste en tête, le légal part en dernier.
    expect(apres.rows).toHaveLength(4);
    expect(apres.rows[0]!.id).toBe(seule.id);
    expect(apres.rows[1]!.id).toBe(rows[0]!.id);
    expect(apres.rows[2]!.id).toBe(rows[1]!.id);
    expect(apres.rows[3]!.columns[0]!.blocks.map((b) => b.type)).toEqual(["footer_legal"]);
  });

  test("⛔ sélection dans un footer IMPORTÉ : au-dessus du footer, pas entre lui et le légal", () => {
    const footer = withFreshRowIds(ligne("f", [bloc("fb")]), "ftr");
    const doc = docDe([ligne("A", [bloc("a")]), footer, ligne("L", [legal])]);
    expect(indexInsertionBloc(doc, { rowId: footer.id })).toBe(undefined);
    const rows = BLOC_2();
    expect(idsDeRows(appliquer(doc, actionImport("block", rows, doc, { rowId: footer.id })))).toEqual([
      "A",
      rows[0]!.id,
      rows[1]!.id,
      footer.id,
      "L",
    ]);
  });

  test("document sans légal (un bloc en cours d'édition) : après la dernière row sélectionnée, à la fin", () => {
    const doc = docDe([ligne("A", [bloc("a")]), ligne("B", [bloc("b")])]);
    expect(indexInsertionBloc(doc, { rowId: "B" })).toBe(2);
    expect(ouInsererBloc(doc, { rowId: "B" })).toBe("at the end of the email");
  });

  test("sélection périmée (row disparue) : comme sans sélection", () => {
    expect(indexInsertionBloc(RANGE(), { rowId: "disparue" })).toBe(undefined);
  });

  test("le libellé dit l'endroit AVANT le clic", () => {
    expect(ouInsererBloc(RANGE(), { rowId: "B" })).toBe("after row 2");
    expect(ouInsererBloc(RANGE(), null)).toBe("just above the footer");
    expect(ouInsererBloc(RANGE(), { rowId: "L" })).toBe("just above the footer");
  });

  test("header : tout en haut ; footer : sans index (le réducteur le pose au-dessus du légal)", () => {
    const doc = RANGE();
    const rows = BLOC_2();
    expect(actionImport("header", rows, doc, { rowId: "B" })).toEqual({ type: "insertRows", rows, index: 0 });
    expect(actionImport("footer", rows, doc, { rowId: "B" })).toEqual({ type: "insertRows", rows });
  });
});

describe("insertion par COPIE — le document ne reçoit jamais les ids de la bibliothèque", () => {
  // Des rows VALIDES au schéma : la bibliothèque les relit avec `Row.safeParse`.
  const texte = (id: string) => ({ id, type: "text", paragraphs: [{ spans: [{ text: "Podcast" }] }] });
  const lignePartial = {
    id: "33333333-3333-4333-8333-333333333333",
    slot: "block",
    name: "Podcast",
    rows: [ligne("pod_1", [texte("pod_1_b")]), ligne("pod_2", [texte("pod_2_b")])],
    archived_at: null,
    updated_by: null,
    updated_at: "2026-09-23T00:00:00Z",
    created_at: "2026-09-23T00:00:00Z",
  };
  const lire = async () => {
    const f = fauxDb<Parameters<typeof getBrandPartial>[0]>({ data: lignePartial, error: null });
    const lu = await getBrandPartial(f.db, lignePartial.id, "asset_1");
    return lu.value!.rows;
  };
  const tousLesIds = (rows: Row[]) =>
    rows.flatMap((r) => [r.id, ...r.columns.flatMap((c) => [c.id, ...c.blocks.map((b) => b.id)])]);

  test("deux imports du même bloc : deux copies indépendantes, aucun id stocké, aucun id partagé", async () => {
    const doc = RANGE();
    const premiere = await lire();
    const seconde = await lire();
    const apres = appliquer(doc, actionImport("block", premiere, doc, { rowId: "A" }));
    const final = appliquer(apres, actionImport("block", seconde, apres, { rowId: "A" }));

    expect(final.rows).toHaveLength(8);
    const ids = tousLesIds(final.rows);
    expect(new Set(ids).size).toBe(ids.length);
    for (const stocke of ["pod_1", "pod_1_col", "pod_1_b", "pod_2", "pod_2_col", "pod_2_b"]) {
      expect(ids.includes(stocke)).toBe(false);
    }
  });

  test("témoin : réinsérer la MÊME copie est refusé par le réducteur — d'où la relecture à chaque clic", async () => {
    const doc = RANGE();
    const copie = await lire();
    const une = appliquer(doc, actionImport("block", copie, doc, null));
    const deux = appliquer(une, actionImport("block", copie, une, null));
    expect(deux.rows).toHaveLength(une.rows.length);
  });
});

describe("ce que listent « Saved blocks » (palette) et l'onglet Blocks (modale)", () => {
  const e = (id: string, slot: PartialEntry["slot"]): PartialEntry => ({ id, slot, name: id, rows: [{}] });
  const MELANGE = [e("h1", "header"), e("b1", "block"), e("f1", "footer"), e("b2", "block")];

  /** ⛔ MUTATION QUI DOIT LE TUER : `blocsDeLaBibliotheque` qui rend toutes les entrées. */
  test("la palette ne liste QUE les blocs — un header y serait posé au milieu de l'e-mail", () => {
    expect(blocsDeLaBibliotheque(MELANGE).map((p) => p.id)).toEqual(["b1", "b2"]);
  });

  /** ⛔ MUTATION QUI DOIT LE TUER : retirer l'onglet `block` de `ONGLETS`. */
  test("la modale « Import template » a un onglet « Blocks »", () => {
    expect(ONGLETS.map((o) => [o.cle, o.label])).toEqual([
      ["header", "Header"],
      ["footer", "Footer"],
      ["legal", "Legal footer"],
      ["block", "Blocks"],
    ]);
  });

  test("l'onglet Blocks liste les blocs, l'onglet Header n'en montre jamais", () => {
    expect(entreesDeLOnglet(MELANGE, "block").map((p) => p.id)).toEqual(["b1", "b2"]);
    expect(entreesDeLOnglet(MELANGE, "header").map((p) => p.id)).toEqual(["h1"]);
    expect(entreesDeLOnglet(MELANGE, "footer").map((p) => p.id)).toEqual(["f1"]);
  });
});

describe("« Save this row » écrit un BLOC", () => {
  /** ⛔ MUTATION QUI DOIT LE TUER : envoyer une autre fente, ou la row hors d'un tableau. */
  test("le corps envoyé est `{ slot: 'block', name, rows: [row] }`", () => {
    const row = ligne("r", [bloc("b")]);
    expect(corpsSaveThisRow("Podcast", row)).toEqual({ slot: "block", name: "Podcast", rows: [row] });
  });
});
