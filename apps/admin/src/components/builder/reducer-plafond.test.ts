/**
 * Le plafond de lignes d'un en-tête ou d'un pied de marque (20), tenu par le RÉDUCTEUR.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER : une 21e ligne construite à l'écran puis refusée en 422 à
 * l'enregistrement, loin du geste. Toutes les actions qui créent une ligne sont mesurées — pas
 * seulement « ajouter une ligne » : un dépôt entre deux lignes ou une ligne enregistrée en créent
 * aussi. Et le plafond doit survivre à l'historique : un état reconstruit à la main le perdrait.
 */
import { describe, expect, test } from "bun:test";
import { MAX_BRAND_PARTIAL_ROWS, type EmailDoc, type Row } from "@nf/render/schema";
import { builderReducer, initBuilderState, type BuilderAction, type BuilderState } from "./reducer";

const bloc = (id: string) => ({ id, type: "text", paragraphs: [] }) as never;
// Deux blocs : sortir le SEUL bloc d'une ligne pour le reposer juste au-dessus est un non-geste que
// le réducteur ignore, et le cas `moveBlockToNewRow` mesurerait cette règle-là au lieu du plafond.
const ligne = (id: string, blocks: unknown[] = [bloc(`${id}_b`), bloc(`${id}_c`)]): Row =>
  ({ id, layout: "1", columns: [{ id: `${id}_col`, blocks }] }) as Row;
const docDe = (n: number) =>
  ({ schema: 2, meta: {}, theme: {}, rows: Array.from({ length: n }, (_, i) => ligne(`r${i}`)) }) as unknown as EmailDoc;

const jouer = (etat: BuilderState, ...actions: BuilderAction[]) => actions.reduce((s, a) => builderReducer(s, a), etat);
const lignes = (etat: BuilderState) => etat.present.rows.length;

const CREATRICES: [string, BuilderAction][] = [
  ["addRow", { type: "addRow", layout: "1" }],
  ["insertRow", { type: "insertRow", row: ligne("neuve") }],
  ["insertRows", { type: "insertRows", rows: [ligne("neuve")] }],
  ["moveBlockToNewRow", { type: "moveBlockToNewRow", blockId: "r0_b", index: 0 }],
  ["batch", { type: "batch", actions: [{ type: "addRow", layout: "1" }] }],
];

describe("au plafond, aucune action ne crée de ligne", () => {
  for (const [nom, action] of CREATRICES) {
    test(nom, () => {
      const plein = initBuilderState(docDe(MAX_BRAND_PARTIAL_ROWS), MAX_BRAND_PARTIAL_ROWS);
      expect(jouer(plein, action)).toBe(plein);
    });

    test(`${nom} passe encore une ligne en dessous`, () => {
      const presque = initBuilderState(docDe(MAX_BRAND_PARTIAL_ROWS - 1), MAX_BRAND_PARTIAL_ROWS);
      expect(lignes(jouer(presque, action))).toBe(MAX_BRAND_PARTIAL_ROWS);
    });
  }

  test("un lot qui dépasserait est refusé entier", () => {
    const presque = initBuilderState(docDe(MAX_BRAND_PARTIAL_ROWS - 1), MAX_BRAND_PARTIAL_ROWS);
    expect(jouer(presque, { type: "insertRows", rows: [ligne("n1"), ligne("n2")] })).toBe(presque);
  });

  test("insertRows sur la ligne légale : la coupe qui coûterait une ligne n'a pas lieu au plafond", () => {
    const legal = { id: "blk_legal", type: "footer_legal" } as never;
    const doc = docDe(MAX_BRAND_PARTIAL_ROWS - 2);
    doc.rows.push(ligne("legale", [bloc("corps"), legal]));
    const etat = jouer(initBuilderState(doc, MAX_BRAND_PARTIAL_ROWS), { type: "insertRows", rows: [ligne("n1")] });
    expect(lignes(etat)).toBe(MAX_BRAND_PARTIAL_ROWS);
  });
});

describe("le plafond survit à l'historique", () => {
  test("après annuler puis rétablir, la 21e ligne reste refusée", () => {
    const debut = initBuilderState(docDe(MAX_BRAND_PARTIAL_ROWS - 1), MAX_BRAND_PARTIAL_ROWS);
    const plein = jouer(debut, { type: "addRow", layout: "1" }, { type: "undo" }, { type: "redo" });
    expect(lignes(plein)).toBe(MAX_BRAND_PARTIAL_ROWS);
    expect(plein.maxRows).toBe(MAX_BRAND_PARTIAL_ROWS);
    expect(lignes(jouer(plein, { type: "addRow", layout: "1" }))).toBe(MAX_BRAND_PARTIAL_ROWS);
  });

  test("après annulation, le plafond tient encore", () => {
    const debut = initBuilderState(docDe(MAX_BRAND_PARTIAL_ROWS), MAX_BRAND_PARTIAL_ROWS);
    const apres = jouer(debut, { type: "removeRow", rowId: "r0" }, { type: "undo" });
    expect(apres.maxRows).toBe(MAX_BRAND_PARTIAL_ROWS);
    expect(jouer(apres, { type: "addRow", layout: "1" })).toBe(apres);
  });

  test("un rechargement (setDoc + resetHistory) garde le plafond", () => {
    const debut = initBuilderState(docDe(1), MAX_BRAND_PARTIAL_ROWS);
    const recharge = jouer(debut, { type: "setDoc", doc: docDe(MAX_BRAND_PARTIAL_ROWS), resetHistory: true });
    expect(recharge.maxRows).toBe(MAX_BRAND_PARTIAL_ROWS);
    expect(jouer(recharge, { type: "addRow", layout: "1" })).toBe(recharge);
  });
});

describe("sans plafond propre", () => {
  test("un modèle garde le plafond général : la 21e ligne passe", () => {
    const modele = initBuilderState(docDe(MAX_BRAND_PARTIAL_ROWS));
    expect(modele).not.toHaveProperty("maxRows");
    expect(lignes(jouer(modele, { type: "addRow", layout: "1" }))).toBe(MAX_BRAND_PARTIAL_ROWS + 1);
  });

  test("un plafond plus haut que 200 ne relève pas celui du schéma", () => {
    const etat = initBuilderState(docDe(200), 500);
    expect(jouer(etat, { type: "addRow", layout: "1" })).toBe(etat);
  });
});
