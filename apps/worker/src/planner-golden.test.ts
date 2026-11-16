/**
 * NON-RÉGRESSION DU GEL — une édition que personne n'a relue part OCTET POUR OCTET comme avant.
 *
 * ⛔ POURQUOI CE BANC EXISTE. La relecture d'édition (0079) a déplacé la fin du gel — preheader,
 * balisage UTM, taille, empreinte, article de tête — dans `@nf/edition`, pour que le gel, la
 * recompilation après relecture et l'aperçu de l'admin passent par UNE seule définition. Un
 * déplacement de code est exactement l'endroit où un octet change sans que personne ne le voie : une
 * espace dans le preheader, un paramètre UTM dans un autre ordre, une taille mesurée avant au lieu
 * d'après. Les empreintes ci-dessous ont été relevées sur le code d'AVANT le déplacement (master
 * d3c08be) ; elles ne doivent plus bouger pour une édition sans relecture. Seule exception : elles ont
 * été relevées de nouveau quand les noms de marque des fixtures ont été remplacés par des noms fictifs
 * (le banc d'origine, rejoué sur le code courant, restait vert : seules les données ont changé).
 *
 * On empreint le patch ENTIER écrit par `freezeOccurrence`, clés triées, MOINS les colonnes neuves
 * `review_*` (elles n'existaient pas avant, et elles ne sont pas envoyées).
 *
 * ⚠️ CE BANC GARDE LE DÉPLACEMENT, PAS LE COMPILATEUR. La fixture à flux passe par MJML : un
 * changement VOULU de `@nf/render` (nouveau rendu d'un bloc) change aussi ces empreintes. Dans ce cas
 * seulement, les relever de nouveau — après avoir vérifié que le diff du shell est bien celui du
 * compilateur et que rien d'autre (preheader, UTM, taille, empreinte, sujet) n'a bougé.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { runPlanner, type PlannerOptions } from "./planner";

type Db = Parameters<typeof runPlanner>[0];

const vraiFetch = globalThis.fetch;
const vraieCle = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  globalThis.fetch = vraiFetch;
  if (vraieCle === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = vraieCle;
});

const ID_HEADER = "11111111-1111-4111-8111-111111111111";

const rowTexte = (id: string, texte: string): unknown => ({
  id,
  layout: "1",
  columns: [{ id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: texte }] }] }] }],
});

const blocFlux = {
  id: "f1",
  type: "article-feed",
  sourceId: "src_1",
  sourceLabel: "Copper Kettle",
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
};

const DOC_FLUX = {
  schema: 2,
  meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "copper-kettle", locale: "es", headerPartialId: ID_HEADER },
  theme: {},
  rows: [{ id: "r_flux", layout: "1", columns: [{ id: "c_flux", blocks: [blocFlux] }] }],
};
const PARTIALS = [{ id: ID_HEADER, slot: "header", rows: [rowTexte("pf_head", "COPPER-KETTLE-HEADER")] }];

const article = (n: number) => ({
  postId: String(n),
  title: `Artículo ${n}`,
  excerpt: `Resumen ${n}`,
  href: `https://copper-kettle.test/a${n}/`,
  imageSrc: `https://img.copper-kettle.test/${n}.jpg`,
  imageAlt: `Foto ${n}`,
});

const resoudreFluxOk: PlannerOptions["resoudreFlux"] = async () => ({
  ok: true,
  resolutions: {
    f1: { items: [article(1), article(2), article(3)], fetchedAt: "2026-09-06T08:00:00.000Z" },
  },
  sent: [],
});

const DOC_STATIQUE = {
  meta: { subject: "", preheader: "", assetSlug: "quartz-tips", locale: "pt-BR" },
  rows: [
    {
      columns: [
        {
          blocks: [
            { id: "a1", type: "article", title: "Palmeiras vence o clássico", excerpt: "No Allianz." },
            { id: "a2", type: "article", title: "Segundo texto", excerpt: "" },
          ],
        },
      ],
    },
  ],
};

function fauxDb(opts: { doc: unknown; html: string; sujet: string | null; preheader: string | null }): {
  db: Db;
  patches: Record<string, unknown>[];
  held: string[];
} {
  const patches: Record<string, unknown>[] = [];
  const held: string[] = [];
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
        scheduled_at: "2026-09-06T10:00:00.000Z",
        subject: opts.sujet,
        preheader: opts.preheader,
        segment_id: "seg_1",
        template_version_id: "tv_1",
        duplicate_ack_at: null,
        campaign: { name: "Boletín del día", status: "scheduled", freeze_lead_minutes: 90 },
      },
    ],
    loadPublishedVersion: async () => ({
      id: "tv_1",
      status: "published",
      subject: "Sujet du modèle",
      preheader: "Preheader du modèle",
      doc: opts.doc,
      html_shell: opts.html,
      text_shell: "texte {{legal_footer_text}}",
      size_bytes: 1234,
      template: { asset_id: "asset_1", archived_at: null },
    }),
    brandPartialsOf: async () => PARTIALS,
    findLastSettled: async () => null,
    freezeOccurrence: async (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
      return true;
    },
    recordSentArticles: async () => {},
    holdOccurrence: async (_id: string, raison: string) => {
      held.push(raison);
    },
  } as unknown as Db;
  return { db, patches, held };
}

/** Empreinte stable d'un patch : clés triées, colonnes `review_*` exclues. */
function empreinteHistorique(patch: Record<string, unknown>): string {
  const cles = Object.keys(patch)
    .filter((k) => !k.startsWith("review_"))
    .sort();
  const h = createHash("sha256");
  for (const k of cles) h.update(`${k}\x00${JSON.stringify(patch[k])}\x01`);
  return h.digest("hex");
}

const MAINTENANT = new Date("2026-09-06T09:00:00.000Z");

function interceptFetch() {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        model: "modele-de-test",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify({ preheader: "Accroche du jour", intro: "Trois phrases." }) }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

async function silencieux<T>(fn: () => Promise<T>): Promise<T> {
  const vrai = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = vrai;
  }
}

describe("⛔ gel SANS relecture — octet pour octet comme avant 0079", () => {
  test("édition à flux, en-tête de marque, preheader du modèle", async () => {
    const { db, patches, held } = fauxDb({ doc: DOC_FLUX, html: "<html>ignoré</html>", sujet: "Sujet fixe", preheader: null });
    const report = await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux: resoudreFluxOk }));
    expect(report.errors).toEqual([]);
    expect(held).toEqual([]);
    expect(patches).toHaveLength(1);
    // Relevée de nouveau le 23/09/2026 (nf-render 1.6.0, color-scheme « light only » par défaut) : le
    // patch d'avant (9f3a60fb…) et celui-ci ne diffèrent QUE par deux lignes du shell — la meta et le
    // `:root` passés de « light dark » à « light only » — et par `content_sha256`, qui en découle.
    // Taille (même longueur), sujet, preheader, UTM, article de tête : identiques.
    // Relevée de nouveau le 23/09/2026 (nf-render 1.6.2, tables de blocs hybrides) : le patch d'avant
    // (00694892…) et celui-ci ne diffèrent QUE par le shell — ses 3 tables d'article passent de
    // `width:552px` à `width:100%;max-width:552px`, rien d'autre (vérifié par normalisation inverse) —,
    // par `size_bytes` (13 116 → 13 161, +15 octets par table) et par `content_sha256`, qui en découlent.
    // Sujet, preheader, UTM, texte, article de tête, nombre d'articles : identiques.
    expect(empreinteHistorique(patches[0]!)).toBe("9b61c2ea784665b19a2d7e64f6c0598c168b90558a6d7b55469997a5eef2bc3c");
  });

  test("édition statique, jeton IA, preheader de l'occurrence", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    interceptFetch();
    const { db, patches, held } = fauxDb({
      doc: DOC_STATIQUE,
      html: '<html><div style="display:none">Preheader du modèle</div><p>{{ai_intro}}</p><a href="https://quartz-tips.test/x">x</a>{{legal_footer_html}}</html>',
      sujet: "Edição {{edition_number}}",
      preheader: "Pre de l'occurrence",
    });
    const report = await silencieux(() => runPlanner(db, { now: MAINTENANT }));
    expect(report.errors).toEqual([]);
    expect(held).toEqual([]);
    expect(patches).toHaveLength(1);
    expect(empreinteHistorique(patches[0]!)).toBe("053d66a20e31f89f603bf03910ce44c97cab73e0a2550b99e04035ad7913e88e");
  });
});
