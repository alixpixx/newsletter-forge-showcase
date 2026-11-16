/**
 * `updateBlockPart` — l'écriture DANS `lead` / `card` / `midSection` / `cardRule` d'un flux.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER : un champ de l'inspecteur qui règle la police du titre de
 * la une et EFFACE en silence le reste du look (le surtitre « Destacada », le style du lien…).
 * `updateBlock` ne fusionne qu'au premier niveau ; un sous-objet réécrit à moitié reste un document
 * VALIDE, donc rien d'autre ne l'attraperait avant qu'un abonné ne reçoive la une amputée.
 */
import { describe, expect, test } from "bun:test";
import { EmailDoc } from "@nf/render/schema";
import { builderReducer, initBuilderState, type BuilderAction } from "./reducer";

type Feed = Record<string, unknown>;

function docFeed(extra: Feed = {}): EmailDoc {
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
              { id: "blk_feed", type: "article-feed", sourceId: "src_1", count: 3, ...extra },
              { id: "blk_text", type: "text", paragraphs: [{ spans: [{ text: "x" }] }] },
            ],
          },
        ],
      },
    ],
  });
}

const run = (doc: EmailDoc, ...actions: BuilderAction[]) => {
  let state = initBuilderState(doc);
  for (const a of actions) state = builderReducer(state, a);
  return state;
};

const feedOf = (doc: EmailDoc) => doc.rows[0].columns[0].blocks[0] as unknown as Feed;

describe("updateBlockPart", () => {
  test("⛔ fusionne DANS le sous-objet : les autres clés du look survivent", () => {
    const doc = docFeed({ leadCount: 1, lead: { kickerMode: "text", kickerText: "Destacada", ctaStyle: "link" } });
    const after = run(doc, { type: "updateBlockPart", blockId: "blk_feed", part: "lead", patch: { titleFont: "Georgia, serif" } });
    expect(feedOf(after.present).lead).toEqual({
      kickerMode: "text",
      kickerText: "Destacada",
      ctaStyle: "link",
      titleFont: "Georgia, serif",
    });
    // Et le document reste sauvegardable tel quel.
    expect(() => EmailDoc.parse(after.present)).not.toThrow();
  });

  test("une clé à undefined est RETIRÉE, pas écrite à undefined", () => {
    const doc = docFeed({ card: { titleSize: 18, ctaStyle: "none" } });
    const after = run(doc, { type: "updateBlockPart", blockId: "blk_feed", part: "card", patch: { ctaStyle: undefined } });
    const card = feedOf(after.present).card as Feed;
    expect(card).toEqual({ titleSize: 18 });
    expect("ctaStyle" in card).toBe(false);
  });

  test("une une vidée de sa dernière clé disparaît (elle rendait comme l'absence)", () => {
    const doc = docFeed({ leadCount: 1, lead: { titleSize: 26 } });
    const after = run(doc, { type: "updateBlockPart", blockId: "blk_feed", part: "lead", patch: { titleSize: undefined } });
    expect("lead" in feedOf(after.present)).toBe(false);
  });

  test("⛔ un filet vidé de ses clés RESTE `{}` : c'est « un filet aux valeurs par défaut »", () => {
    const doc = docFeed({ cardRule: { color: "#ff0000" } });
    const after = run(doc, { type: "updateBlockPart", blockId: "blk_feed", part: "cardRule", patch: { color: undefined } });
    expect(feedOf(after.present).cardRule).toEqual({});
  });

  test("ajouter un filet par défaut écrit `{}`", () => {
    const after = run(docFeed(), { type: "updateBlockPart", blockId: "blk_feed", part: "cardRule", patch: {} });
    expect(feedOf(after.present).cardRule).toEqual({});
  });

  test("null retire le sous-objet entier", () => {
    const doc = docFeed({ leadCount: 1, midSection: { label: "More news", rule: "under" } });
    const after = run(doc, { type: "updateBlockPart", blockId: "blk_feed", part: "midSection", patch: null });
    expect("midSection" in feedOf(after.present)).toBe(false);
    expect(after.past).toHaveLength(1);
  });

  test("retirer ce qui n'existe pas n'empile rien dans l'historique", () => {
    const after = run(docFeed(), { type: "updateBlockPart", blockId: "blk_feed", part: "cardRule", patch: null });
    expect(after.past).toHaveLength(0);
  });

  test("un bloc qui n'est pas un flux n'est pas touché", () => {
    const doc = docFeed();
    const after = run(doc, { type: "updateBlockPart", blockId: "blk_text", part: "lead", patch: { titleSize: 20 } });
    expect(after.present).toBe(doc);
    expect(after.past).toHaveLength(0);
  });
});
