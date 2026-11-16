/**
 * `insertRows` SANS index — la position « au-dessus du footer légal » de l'import de footer.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. Un template neuf met le texte et le footer légal dans la
 * même colonne ; insérer avant cette ligne posait le footer de marque importé AU-DESSUS de tout le
 * corps de l'e-mail (vu dans le navigateur le 16/09).
 */
import { describe, expect, test } from "bun:test";
import type { EmailDoc, Row } from "@nf/render/schema";
import { builderReducer, initBuilderState } from "./reducer";

const bloc = (id: string, type = "text") => ({ id, type, paragraphs: [] }) as never;
const legal = { id: "blk_legal", type: "footer_legal" } as never;

const ligne = (id: string, blocks: unknown[], extra: Partial<Row> = {}): Row =>
  ({ id, layout: "1", columns: [{ id: `${id}_col`, blocks }], ...extra }) as Row;

const docDe = (rows: Row[]) => ({ schema: 2, meta: {}, theme: {}, rows }) as unknown as EmailDoc;

const inserer = (doc: EmailDoc, rows: Row[], index?: number) =>
  builderReducer(initBuilderState(doc), { type: "insertRows", rows, ...(index === undefined ? {} : { index }) });

const types = (doc: EmailDoc) =>
  doc.rows.map((r) => r.columns.flatMap((c) => c.blocks.map((b) => (b as { id: string }).id)).join("+"));

const FOOTER = () => ligne("row_footer", [bloc("blk_footer")]);

describe("insertRows sans index : le footer importé passe SOUS le corps, au-dessus du légal", () => {
  test("corps et légal dans la même colonne : la ligne est coupée", () => {
    const style = { backgroundColor: "#ffffff" } as never;
    const doc = docDe([
      ligne("row_body", [bloc("blk_a"), bloc("blk_b"), legal], { style }),
    ]);
    const { present } = inserer(doc, [FOOTER()]);
    expect(types(present)).toEqual(["blk_a+blk_b", "blk_footer", "blk_legal"]);
    // Le corps garde ses ids (une sélection posée dessus y reste) ; la ligne légale en reçoit de neufs.
    expect(present.rows[0].id).toBe("row_body");
    expect(present.rows[0].columns[0].id).toBe("row_body_col");
    expect(present.rows[2].id).not.toBe("row_body");
    expect(present.rows[2].columns[0].id).not.toBe("row_body_col");
    // Même habillage des deux côtés de la coupe.
    expect(present.rows[2].style).toEqual(style);
  });

  test("légal déjà seul sur sa ligne : rien n'est coupé", () => {
    const doc = docDe([ligne("row_body", [bloc("blk_a")]), ligne("row_legal", [legal])]);
    const { present } = inserer(doc, [FOOTER()]);
    expect(types(present)).toEqual(["blk_a", "blk_footer", "blk_legal"]);
    expect(present.rows[2].id).toBe("row_legal");
  });

  test("ligne légale à deux colonnes : pas de coupe évidente, insertion avant la ligne entière", () => {
    const deux = {
      id: "row_2",
      layout: "1-1",
      columns: [
        { id: "c1", blocks: [bloc("blk_a")] },
        { id: "c2", blocks: [legal] },
      ],
    } as unknown as Row;
    const { present } = inserer(docDe([deux]), [FOOTER()]);
    expect(present.rows.map((r) => r.id)).toEqual(["row_footer", "row_2"]);
  });

  test("avec un index (header) : aucune coupe", () => {
    const doc = docDe([ligne("row_body", [bloc("blk_a"), legal])]);
    const { present } = inserer(doc, [FOOTER()], 0);
    expect(present.rows.map((r) => r.id)).toEqual(["row_footer", "row_body"]);
  });

  test("sans footer légal : à la fin", () => {
    const { present } = inserer(docDe([ligne("row_body", [bloc("blk_a")])]), [FOOTER()]);
    expect(present.rows.map((r) => r.id)).toEqual(["row_body", "row_footer"]);
  });

  test("au plafond de 200 lignes, la coupe (qui coûte une ligne) cède : insertion avant la ligne entière", () => {
    const pleines = Array.from({ length: 198 }, (_, i) => ligne(`row_${i}`, [bloc(`blk_${i}`)]));
    const doc = docDe([...pleines, ligne("row_body", [bloc("blk_a"), legal])]);
    const { present } = inserer(doc, [FOOTER()]);
    expect(present.rows).toHaveLength(200);
    expect(present.rows.slice(-2).map((r) => r.id)).toEqual(["row_footer", "row_body"]);
  });

  test("une ligne sous le plafond, la coupe a lieu", () => {
    const pleines = Array.from({ length: 197 }, (_, i) => ligne(`row_${i}`, [bloc(`blk_${i}`)]));
    const doc = docDe([...pleines, ligne("row_body", [bloc("blk_a"), legal])]);
    const { present } = inserer(doc, [FOOTER()]);
    expect(present.rows).toHaveLength(200);
    expect(types(present).slice(-3)).toEqual(["blk_a", "blk_footer", "blk_legal"]);
  });

  test("un seul Ctrl+Z rend le document d'avant, coupe comprise", () => {
    const doc = docDe([ligne("row_body", [bloc("blk_a"), legal])]);
    const apres = inserer(doc, [FOOTER()]);
    const annule = builderReducer(apres, { type: "undo" });
    expect(annule.present).toBe(doc);
  });
});
