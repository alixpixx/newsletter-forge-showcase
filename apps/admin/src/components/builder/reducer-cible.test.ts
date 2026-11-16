/**
 * Où la palette pose un bloc ou une ligne quand on clique (décision d'Alix du 16/09 : « et ui gere
 * moi tout ca », dont « sans sélection, un bloc ajouté se place sous le footer importé »).
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER : un clic qui pose un bloc SOUS le pied légal, ou DANS un
 * footer importé, sans que l'auteur l'ait choisi. On mesure sur les formes RÉELLES : un modèle neuf
 * (corps et légal dans la même colonne), puis le même après import d'un footer.
 */
import { describe, expect, test } from "bun:test";
import { isImportedFooterRow, withFreshRowIds, type EmailDoc, type Row } from "@nf/render/schema";
import { builderReducer, debutDuPied, initBuilderState, resoudreCible, type BuilderAction } from "./reducer";

const bloc = (id: string) => ({ id, type: "text", paragraphs: [] }) as never;
const legal = { id: "blk_legal", type: "footer_legal" } as never;

const ligne = (id: string, blocks: unknown[]): Row => ({ id, layout: "1", columns: [{ id: `${id}_col`, blocks }] }) as Row;
const docDe = (rows: Row[]) => ({ schema: 2, meta: {}, theme: {}, rows }) as unknown as EmailDoc;

const appliquer = (doc: EmailDoc, ...actions: BuilderAction[]) =>
  actions.reduce((s, a) => builderReducer(s, a), initBuilderState(doc)).present;

const ids = (doc: EmailDoc) =>
  doc.rows.map((r) => r.columns.flatMap((c) => c.blocks.map((b) => (b as { id: string }).id)).join("+"));

/** Un modèle neuf : le texte d'accueil et le légal partagent la colonne. */
const NEUF = () => docDe([ligne("row_body", [bloc("blk_a"), legal])]);
/** Un footer tel que la bibliothèque le sert (préfixe `ftr_`). */
const FOOTER = () => withFreshRowIds(ligne("x", [bloc("blk_f1")]), "ftr");

/** Ajoute un bloc à la cible résolue, comme `placeBlock`, puis sélectionne sa COLONNE seule. */
function cliquer(doc: EmailDoc, active: { rowId: string; colId: string } | null, id: string) {
  const c = resoudreCible(doc, active)!;
  const suivant = appliquer(doc, { type: "addBlock", rowId: c.rowId, colId: c.colId, block: bloc(id), index: c.index });
  return { doc: suivant, active: { rowId: c.rowId, colId: c.colId } };
}

describe("resoudreCible — sans sélection", () => {
  test("modèle neuf : au-dessus du bloc légal, dans la même colonne", () => {
    expect(resoudreCible(NEUF(), null)).toEqual({ rowId: "row_body", colId: "row_body_col", index: 1 });
  });

  test("⛔ trois clics d'affilée restent au-dessus du légal, dans l'ordre des clics", () => {
    let etat = { doc: NEUF(), active: null as { rowId: string; colId: string } | null };
    for (const id of ["blk_1", "blk_2", "blk_3"]) etat = cliquer(etat.doc, etat.active, id);
    expect(ids(etat.doc)).toEqual(["blk_a+blk_1+blk_2+blk_3+blk_legal"]);
  });

  test("⛔ après import d'un footer : le bas du CORPS, pas le footer ni le légal", () => {
    const doc = appliquer(NEUF(), { type: "insertRows", rows: [FOOTER()] });
    expect(ids(doc)).toHaveLength(3);
    expect([ids(doc)[0], ids(doc)[2]]).toEqual(["blk_a", "blk_legal"]);
    expect(isImportedFooterRow(doc.rows[1])).toBe(true);
    const c = resoudreCible(doc, null);
    expect(c).toEqual({ rowId: "row_body", colId: "row_body_col" });
    const apres = cliquer(doc, null, "blk_new").doc;
    expect(ids(apres)[0]).toBe("blk_a+blk_new");
  });

  test("⛔ après import d'un HEADER dans un modèle neuf : sous le texte d'accueil, pas dans le header", () => {
    const header = withFreshRowIds(ligne("x", [bloc("blk_h")]));
    const doc = appliquer(NEUF(), { type: "insertRows", rows: [header], index: 0 });
    expect(resoudreCible(doc, null)).toEqual({ rowId: "row_body", colId: "row_body_col", index: 1 });
  });

  test("sans marque d'import (footer composé à la main) : la row juste avant le légal", () => {
    const doc = docDe([ligne("row_h", [bloc("blk_h")]), ligne("row_b", [bloc("blk_b")]), ligne("row_l", [legal])]);
    expect(resoudreCible(doc, null)).toEqual({ rowId: "row_b", colId: "row_b_col" });
  });

  test("document réduit au légal : en tête de sa colonne", () => {
    expect(resoudreCible(docDe([ligne("row_l", [legal])]), null)).toEqual({ rowId: "row_l", colId: "row_l_col", index: 0 });
  });

  test("le footer importé ouvre le document : en tête du footer, jamais sous le légal", () => {
    const f = FOOTER();
    const doc = docDe([f, ligne("row_l", [legal])]);
    expect(resoudreCible(doc, null)).toEqual({ rowId: f.id, colId: f.columns[0].id, index: 0 });
  });

  test("éditeur d'un pied de marque (aucun légal) : le préfixe `ftr_` est ignoré, fin de la dernière colonne", () => {
    const a = FOOTER();
    const b = FOOTER();
    const doc = docDe([a, b]);
    expect(debutDuPied(doc)).toBe(-1);
    expect(resoudreCible(doc, null)).toEqual({ rowId: b.id, colId: b.columns[0].id });
  });

  test("document vide : aucune cible", () => {
    expect(resoudreCible(docDe([]), null)).toBeNull();
  });
});

describe("resoudreCible — avec sélection", () => {
  test("colonne sans légal : fin de cette colonne", () => {
    const doc = docDe([ligne("row_a", [bloc("blk_a")]), ligne("row_l", [legal])]);
    expect(resoudreCible(doc, { rowId: "row_a", colId: "row_a_col" })).toEqual({ rowId: "row_a", colId: "row_a_col" });
  });

  test("⛔ colonne qui porte le légal : au-dessus du bloc légal", () => {
    const doc = docDe([ligne("row_a", [bloc("blk_a")]), ligne("row_l", [legal])]);
    expect(resoudreCible(doc, { rowId: "row_l", colId: "row_l_col" })).toEqual({ rowId: "row_l", colId: "row_l_col", index: 0 });
  });

  test("sélection périmée : retombe sur la règle sans sélection", () => {
    expect(resoudreCible(NEUF(), { rowId: "row_gone", colId: "col_gone" })).toEqual({
      rowId: "row_body",
      colId: "row_body_col",
      index: 1,
    });
  });
});

describe("insertRows sans index, avec un footer importé", () => {
  test("⛔ des articles WordPress (ou une row neuve) passent AU-DESSUS du footer importé", () => {
    const doc = appliquer(NEUF(), { type: "insertRows", rows: [FOOTER()] });
    const suivant = appliquer(doc, { type: "insertRows", rows: [ligne("row_art", [bloc("blk_art")])] });
    expect(ids(suivant)[0]).toBe("blk_a");
    expect(ids(suivant)[1]).toBe("blk_art");
    expect(isImportedFooterRow(suivant.rows[2])).toBe(true);
    expect(ids(suivant)[3]).toBe("blk_legal");
  });
});

describe("addRow", () => {
  test("refusé au plafond de 200 rows", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ligne(`r${i}`, []));
    const etat = builderReducer(initBuilderState(docDe(rows)), { type: "addRow", layout: "1" });
    expect(etat.present.rows).toHaveLength(200);
  });
});

describe("withFreshRowIds — préfixe", () => {
  test("footer : `ftr_` ; défaut : `row_`", () => {
    expect(isImportedFooterRow(withFreshRowIds(ligne("x", []), "ftr"))).toBe(true);
    expect(isImportedFooterRow(withFreshRowIds(ligne("x", [])))).toBe(false);
    expect(withFreshRowIds(ligne("x", [])).id.startsWith("row_")).toBe(true);
  });
});
