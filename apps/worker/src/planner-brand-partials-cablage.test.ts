/**
 * Banc du CÂBLAGE — la seule ligne qui pose vraiment l'en-tête dans l'e-mail qui part.
 *
 * ⛔ POURQUOI CE FICHIER EXISTE, ET C'EST MESURÉ. Le 15/09, en remplaçant dans `planner.ts` la ligne
 * `compileDoc(expanded, partialsDeMarque)` par un `throw` INCONDITIONNEL, `bun test` à la racine
 * rendait **981 pass / 0 fail**. Aucun test du dépôt n'atteignait cette ligne : le banc voisin
 * (`planner-brand-partials.test.ts`) prouve que la garde RETIENT, jamais que la résolution est
 * APPLIQUÉE, puisque tous ses cas se terminent avant la recompilation. Le lot entier reposait donc
 * sur un argument que rien n'exerçait — un refactor, un merge, et l'en-tête disparaissait des
 * newsletters hebdomadaires sans un seul test rouge.
 *
 * ⛔ POURQUOI AUCUN `mock.module` ICI, ET C'EST MESURÉ AUSSI. Atteindre cette ligne exige que la
 * résolution des flux RÉUSSISSE, donc de doubler l'appel WordPress. Doubler `@nf/wp` par
 * `mock.module` a fait tomber **10 tests de `packages/wp/src/client.test.ts`** : le double est
 * GLOBAL au processus de test et fuit vers tous les fichiers suivants, et ni `afterAll` ni un
 * re-mock avec le vrai module ne le restaurent. La résolution des flux est donc INJECTÉE
 * (`PlannerOptions.resoudreFlux`), sur le même motif que `now` — rien ne déborde du fichier.
 *
 * ⛔ `expect(report.errors).toEqual([])` N'EST PAS DÉCORATIF. `freezeDue` est enveloppé d'un `catch`
 * qui pousse dans `report.errors` : une exception en cours de route laisse `held` ET `freeze` vides,
 * donc un banc qui n'assert que « rien n'a été retenu » reste VERT sur un plantage. C'est exactement
 * ce qui masquait le trou.
 */
import { describe, expect, test } from "bun:test";
import { runPlanner, type PlannerOptions } from "./planner";

type Db = Parameters<typeof runPlanner>[0];

const ID_HEADER = "11111111-1111-4111-8111-111111111111";

const rowTexte = (id: string, texte: string): unknown => ({
  id,
  layout: "1",
  columns: [
    { id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: texte }] }] }] },
  ],
});

/** Le bloc flux : c'est lui qui déclenche la RECOMPILATION, le seul chemin qui nous intéresse. */
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

const rowFlux = { id: "r_flux", layout: "1", columns: [{ id: "c_flux", blocks: [blocFlux] }] };

const docPublie = (rows: unknown[], meta: Record<string, unknown> = {}) => ({
  schema: 2,
  meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "copper-kettle", locale: "es", ...meta },
  theme: {},
  rows,
});

const article = (n: number) => ({
  postId: String(n),
  title: `Artículo ${n}`,
  excerpt: `Resumen ${n}`,
  href: `https://copper-kettle.test/a${n}/`,
  imageAlt: "",
});

/** La résolution des flux, DOUBLÉE : ce banc mesure ce qui se passe APRÈS elle. */
const resoudreFluxOk: PlannerOptions["resoudreFlux"] = async () => ({
  ok: true,
  resolutions: {
    f1: { items: [article(1), article(2), article(3)], fetchedAt: "2026-09-06T08:00:00.000Z" },
  },
  sent: [],
});

interface Vu {
  freeze: { id: string; patch: Record<string, unknown> }[];
  held: { id: string; raison: string }[];
}

function fauxDb(opts: { doc: unknown; partials: unknown[] }): { db: Db; vu: Vu } {
  const vu: Vu = { freeze: [], held: [] };
  const db = {
    listArmedPlans: async () => [],
    countOutboxRowsWithOccurrence: async () => 0,
    countOverdueOccurrences: async () => 0,
    // Passe de relecture (0079) : aucune édition relue dans ce banc.
    listOccurrencesToRefreeze: async () => [],
    listOccurrencesToFreeze: async () => [
      {
        id: "occ_1",
        campaign_id: "camp_1",
        asset_id: "asset_1",
        scheduled_at: "2026-09-06T10:00:00.000Z",
        subject: "Sujet fixe",
        preheader: null,
        segment_id: null,
        template_version_id: "tv_1",
        duplicate_ack_at: null,
        campaign: { name: "Boletín", status: "scheduled", freeze_lead_minutes: 90 },
      },
    ],
    loadPublishedVersion: async () => ({
      id: "tv_1",
      status: "published",
      subject: "Sujet du modèle",
      preheader: "Preheader",
      doc: opts.doc,
      html_shell: "<html>{{legal_footer_html}}</html>",
      text_shell: "texte",
      size_bytes: 1234,
      template: { asset_id: "asset_1", archived_at: null },
    }),
    brandPartialsOf: async () => opts.partials,
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
 * Le journal du worker passe par `console.log(JSON.stringify(...))`. On l'intercepte LOCALEMENT et
 * on le rend dans le `finally` : pas de `mock.module`, donc rien ne déborde sur les autres fichiers.
 */
async function avecJournal<T>(fn: () => Promise<T>): Promise<{ valeur: T; lignes: Record<string, unknown>[] }> {
  const lignes: Record<string, unknown>[] = [];
  const vrai = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    try {
      lignes.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    } catch {
      /* une ligne qui n'est pas du JSON ne nous concerne pas */
    }
  };
  try {
    return { valeur: await fn(), lignes };
  } finally {
    // eslint-disable-next-line no-console
    console.log = vrai;
  }
}

const MAINTENANT = new Date("2026-09-06T09:00:00.000Z");

describe("matérialiseur — l'en-tête de marque ENTRE VRAIMENT dans le HTML figé", () => {
  test("⛔ le HTML gelé porte l'en-tête résolu, pas seulement le corps recompilé", async () => {
    /*
     * ⛔ MUTATION QUI DOIT LE TUER : `compileDoc(expanded, partialsDeMarque)` → `compileDoc(expanded)`.
     * C'est LE mutant qui survivait à la suite entière avant ce banc.
     */
    const { db, vu } = fauxDb({
      doc: docPublie([rowFlux], { headerPartialId: ID_HEADER }),
      partials: [{ id: ID_HEADER, slot: "header", rows: [rowTexte("pf_head", "COPPER-KETTLE-HEADER")] }],
    });

    const { valeur: report } = await avecJournal(() =>
      runPlanner(db, { now: MAINTENANT, resoudreFlux: resoudreFluxOk }),
    );

    // Une exception en route laisserait `held` ET `freeze` vides : sans cette ligne, le banc serait
    // vert sur un plantage.
    expect(report.errors).toEqual([]);
    expect(vu.held).toEqual([]);
    expect(vu.freeze).toHaveLength(1);
    expect(String(vu.freeze[0]!.patch.html_shell)).toContain("COPPER-KETTLE-HEADER");
    // La preuve que la recompilation a bien eu lieu : les articles du jour sont dedans.
    expect(vu.freeze[0]!.patch.article_count).toBe(3);
  });

  test("sans pointeur, le HTML gelé ne gagne aucun en-tête — la contre-épreuve", async () => {
    // Sans elle, un test qui trouve « COPPER-KETTLE-HEADER » ne prouverait pas que c'est le POINTEUR
    // qui l'a mis là : un partial appliqué à tout le monde passerait aussi.
    const { db, vu } = fauxDb({
      doc: docPublie([rowFlux]),
      partials: [{ id: ID_HEADER, slot: "header", rows: [rowTexte("pf_head", "COPPER-KETTLE-HEADER")] }],
    });

    const { valeur: report } = await avecJournal(() =>
      runPlanner(db, { now: MAINTENANT, resoudreFlux: resoudreFluxOk }),
    );

    expect(report.errors).toEqual([]);
    expect(vu.freeze).toHaveLength(1);
    expect(String(vu.freeze[0]!.patch.html_shell)).not.toContain("COPPER-KETTLE-HEADER");
  });

  test("⛔ l'avertissement de la compilation est JOURNALISÉ, plus jeté par terre", async () => {
    /*
     * Le scénario exact du jour où l'on posera un pointeur sur un modèle existant SANS retirer sa
     * row d'en-tête : `applyBrandPartials` préfixe, le document garde sa copie, l'abonné voit
     * l'en-tête deux fois. `compileDoc` le DIT dans `warnings` — encore faut-il que quelqu'un
     * l'écrive quelque part.
     *
     * ⛔ MUTATION QUI DOIT LE TUER : retirer `...(built.warnings.length > 0 ? { warnings } : {})`
     * du `log("planner", …)`.
     */
    const { db, vu } = fauxDb({
      doc: docPublie([rowTexte("pf_head", "COPPER-KETTLE-HEADER"), rowFlux], { headerPartialId: ID_HEADER }),
      partials: [{ id: ID_HEADER, slot: "header", rows: [rowTexte("pf_head", "COPPER-KETTLE-HEADER")] }],
    });

    const { valeur: report, lignes } = await avecJournal(() =>
      runPlanner(db, { now: MAINTENANT, resoudreFlux: resoudreFluxOk }),
    );

    expect(report.errors).toEqual([]);
    expect(vu.freeze).toHaveLength(1);

    const compilation = lignes.find((l) => l.decision === "feeds_resolved");
    expect(compilation).toBeDefined();
    const avertissements = (compilation!.warnings ?? []) as string[];
    expect(avertissements.some((w) => /show it twice/i.test(w))).toBe(true);
  });
});
