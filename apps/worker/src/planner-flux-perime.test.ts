/**
 * Banc du JOURNAL DU GEL — un bloc « les derniers » qui sert des articles de plus de 24 h le DIT.
 *
 * ⛔ POURQUOI. Le 25/09/2026, deux éditions Northwind Sports ont envoyé les 7 MÊMES articles à trois heures
 * d'écart : le bloc filtrait sur des catégories que le site n'emploie plus, et rien, nulle part, ne
 * le signalait. Ce banc exerce la chaîne ENTIÈRE du gel — la VRAIE `resolveFeedsOfDoc`, seuls ses
 * lecteurs WordPress doublés — pour que le constat soit prouvé du mode servi jusqu'à la ligne
 * `feeds_resolved`.
 *
 * ⚠️ Les lecteurs sont INJECTÉS (`Recolteurs`), pas doublés sur `globalThis.fetch` : le
 * `mock.module("./guard")` de `packages/wp/src/client.test.ts` fuit vers toute la suite, et un banc
 * passé par le réseau doublé devenait vert ou rouge selon l'ordre des fichiers.
 */
import { describe, expect, test } from "bun:test";
import { toCandidates } from "@nf/wp";
import { resolveFeedsOfDoc, type Recolteurs } from "./feed-resolve";
import { runPlanner, type PlannerOptions } from "./planner";

type Db = Parameters<typeof runPlanner>[0];

const MAINTENANT = new Date("2026-09-25T09:00:00.000Z");

const blocFlux = (orderby: string) => ({
  id: "f1",
  type: "article-feed",
  sourceId: "src_1",
  sourceLabel: "Northwind Sports",
  categoryNames: ["Riverside", "Brasileirão"],
  tagNames: [],
  categories: [7101, 12087],
  tags: [],
  count: 2,
  minCount: 1,
  dedupeDays: 0,
  orderby,
  viewsWindow: "cadence",
  layout: "stacked",
  previewItems: [],
});

const docPublie = (orderby = "date") => ({
  schema: 2,
  meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "northwind-sports", locale: "pt-BR" },
  theme: {},
  rows: [{ id: "r_flux", layout: "1", columns: [{ id: "c_flux", blocks: [blocFlux(orderby)] }] }],
});

/** Un site qui rend des articles WordPress (forme `wp/v2/posts`) publiés aux dates GMT données. */
function site(dates: string[]): Recolteurs {
  const candidates = toCandidates(
    dates.map((d, i) => ({
      id: i + 1,
      link: `https://northwind-sports.invalid/artigo-${i + 1}/`,
      date_gmt: d,
      title: { rendered: `Artigo ${i + 1}` },
      excerpt: { rendered: `Resumo ${i + 1}` },
    })),
  );
  const refus = async (): Promise<never> => {
    throw new Error("ce lecteur ne doit pas servir en mode `date` sur une source REST");
  };
  return {
    fetchPosts: async () => ({ candidates, total: candidates.length, truncated: false }),
    fetchPostsByIds: refus,
    fetchFeedPosts: refus,
  };
}

interface Vu {
  freeze: { id: string; patch: Record<string, unknown> }[];
  held: { id: string; raison: string }[];
}

function fauxDb(doc: unknown): { db: Db; vu: Vu } {
  const vu: Vu = { freeze: [], held: [] };
  const db = {
    listArmedPlans: async () => [],
    countOutboxRowsWithOccurrence: async () => 0,
    countOverdueOccurrences: async () => 0,
    listOccurrencesToRefreeze: async () => [],
    listOccurrencesToFreeze: async () => [
      {
        id: "occ_1",
        campaign_id: "camp_1",
        asset_id: "asset_1",
        scheduled_at: "2026-09-25T10:30:00.000Z",
        subject: "Sujet fixe",
        preheader: null,
        segment_id: null,
        template_version_id: "tv_1",
        duplicate_ack_at: null,
        campaign: { name: "Northwind Sports teste", status: "scheduled", freeze_lead_minutes: 90 },
      },
    ],
    loadPublishedVersion: async () => ({
      id: "tv_1",
      status: "published",
      subject: "Sujet du modèle",
      preheader: "Preheader",
      doc,
      html_shell: "<html>{{legal_footer_html}}</html>",
      text_shell: "texte",
      size_bytes: 1234,
      template: { asset_id: "asset_1", archived_at: null },
    }),
    loadWpSource: async () => ({ kind: "wp-rest", label: "Northwind Sports", restRoot: "https://northwind-sports.invalid/wp-json" }),
    cadenceJours: async () => 7,
    articleViews: async () => ({ ok: true, vues: new Map<string, number>() }),
    brandPartialsOf: async () => [],
    findLastSettled: async () => null,
    freezeOccurrence: async (id: string, patch: Record<string, unknown>) => {
      vu.freeze.push({ id, patch });
      return true;
    },
    recordSentArticles: async () => {},
    holdOccurrence: async (id: string, raison: string) => {
      vu.held.push({ id, raison });
    },
  } as unknown as Db;
  return { db, vu };
}

/**
 * Le gel complet — la VRAIE résolution des flux, lecteurs WordPress doublés — journal intercepté et
 * rendu dans le `finally`.
 */
async function geler(doc: unknown, datesGmt: string[]) {
  const lignes: Record<string, unknown>[] = [];
  const vraiLog = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    try {
      lignes.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    } catch {
      /* une ligne qui n'est pas du JSON ne nous concerne pas */
    }
  };
  const resoudreFlux: PlannerOptions["resoudreFlux"] = (db, d, ctx) => resolveFeedsOfDoc(db, d, ctx, site(datesGmt));
  try {
    const { db, vu } = fauxDb(doc);
    const report = await runPlanner(db, { now: MAINTENANT, resoudreFlux });
    return { report, vu, compilation: lignes.find((l) => l.decision === "feeds_resolved") };
  } finally {
    // eslint-disable-next-line no-console
    console.log = vraiLog;
  }
}

describe("gel — le journal `feeds_resolved` porte les blocs « les derniers » de plus de 24 h", () => {
  test("⛔ plus récent à 26 h 30 ⇒ `stale_feeds` nomme le bloc, l'âge et la date — et l'édition PART", async () => {
    const { report, vu, compilation } = await geler(docPublie(), ["2026-09-24T06:30:00", "2026-09-23T20:00:00"]);

    expect(report.errors).toEqual([]);
    // Un avertissement, jamais une rétention : l'édition est gelée comme les autres.
    expect(vu.held).toEqual([]);
    expect(vu.freeze).toHaveLength(1);
    expect(vu.freeze[0]!.patch.article_count).toBe(2);

    expect(compilation).toBeDefined();
    const perimes = compilation!.stale_feeds as { block: string; age_hours: number; newest_published_at: string }[];
    expect(perimes).toHaveLength(1);
    expect(perimes[0]!.block).toBe("f1");
    expect(perimes[0]!.age_hours).toBe(26);
    expect(Date.parse(perimes[0]!.newest_published_at)).toBe(Date.parse("2026-09-24T06:30:00Z"));
  });

  test("TÉMOIN — plus récent à 3 h ⇒ aucune clé `stale_feeds`", async () => {
    const { report, vu, compilation } = await geler(docPublie(), ["2026-09-25T06:00:00", "2026-09-23T20:00:00"]);
    expect(report.errors).toEqual([]);
    expect(vu.freeze).toHaveLength(1);
    expect(compilation).toBeDefined();
    expect("stale_feeds" in compilation!).toBe(false);
  });

  test("⛔ ce qui part ne change pas d'un octet : même HTML figé avec ou sans constat", async () => {
    // Mêmes articles (titres, liens), seules les dates diffèrent : le HTML gelé doit être identique.
    const perime = await geler(docPublie(), ["2026-09-24T06:30:00", "2026-09-23T20:00:00"]);
    const frais = await geler(docPublie(), ["2026-09-25T06:00:00", "2026-09-23T20:00:00"]);
    expect(perime.compilation!.stale_feeds).toBeDefined();
    expect(frais.compilation!.stale_feeds).toBeUndefined();
    expect(perime.vu.freeze[0]!.patch.html_shell).toBe(frais.vu.freeze[0]!.patch.html_shell);
    expect(perime.vu.freeze[0]!.patch.subject).toBe(frais.vu.freeze[0]!.patch.subject);
  });
});
