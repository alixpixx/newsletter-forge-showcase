/**
 * LA PHRASE DE L'OCCURRENCE RETENUE — elle désigne où chercher la panne.
 *
 * Le 23/09, un 414 de NOTRE proxy a été affiché « Copper Kettle did not answer » : l'opérateur était
 * envoyé chez le site de la marque, qui n'y était pour rien.
 */
import { describe, expect, test } from "bun:test";
import { PanneInterne, raisonDePanne, resolveFeedsOfDoc } from "./feed-resolve";

describe("raisonDePanne", () => {
  test("une panne de notre base ou de notre entrepôt ne s'impute pas à la marque", () => {
    const r = raisonDePanne("Copper Kettle", new PanneInterne("sentArticleUrls: 414 Request-URI Too Large"));
    expect(r).toBe(
      "building this edition failed on our side, not on Copper Kettle's — sentArticleUrls: 414 Request-URI Too Large",
    );
    expect(r.includes("did not answer")).toBe(false);
  });

  test("TÉMOIN — un site qui ne répond pas reste imputé au site", () => {
    expect(raisonDePanne("Copper Kettle", new Error("impossible de joindre https://www.copper-kettle.example/"))).toBe(
      "Copper Kettle did not answer while building this edition — impossible de joindre https://www.copper-kettle.example/",
    );
  });
});

describe("resolveFeedsOfDoc — une panne sort marquée `retry`", () => {
  type Db = Parameters<typeof resolveFeedsOfDoc>[0];
  type Doc = Parameters<typeof resolveFeedsOfDoc>[1];
  const doc = {
    schema: 2,
    meta: { subject: "Sujet", preheader: "", assetSlug: "northwind-sports", locale: "pt-BR" },
    theme: {},
    rows: [
      {
        id: "r1",
        layout: "1",
        columns: [
          {
            id: "c1",
            blocks: [
              {
                id: "f1",
                type: "article-feed",
                sourceId: "src_1",
                sourceLabel: "Northwind Sports",
                categoryNames: [],
                tagNames: [],
                categories: [],
                tags: [],
                count: 3,
                minCount: 1,
                dedupeDays: 0,
                orderby: "date",
                viewsWindow: "cadence",
                layout: "stacked",
                previewItems: [],
              },
            ],
          },
        ],
      },
    ],
  } as unknown as Doc;
  const ctx = { campaignId: "camp_1", assetId: "asset_1", occurrenceId: "occ_1", now: new Date("2026-09-25T11:30:00Z") };

  test("⛔ ce que la résolution LÈVE rend `retry: true` — c'est ce drapeau qui fait réessayer le gel", async () => {
    // Le lanceur le moins cher et sans réseau : un hôte que la garde de @nf/wp refuse avant tout appel.
    const db = {
      loadWpSource: async () => ({ kind: "wp", label: "Northwind Sports", restRoot: "https://northwind-sports.internal/wp-json" }),
    } as unknown as Db;
    const outcome = await resolveFeedsOfDoc(db, doc, ctx);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.retry).toBe(true);
    expect(outcome.reason).toStartWith("Northwind Sports did not answer while building this edition");
  });

  test("TÉMOIN — un VERDICT (source disparue) ne porte pas `retry`", async () => {
    const db = { loadWpSource: async () => null } as unknown as Db;
    const outcome = await resolveFeedsOfDoc(db, doc, ctx);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.retry).toBeUndefined();
  });
});
