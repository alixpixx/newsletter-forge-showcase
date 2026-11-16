/**
 * RELECTURE D'ÉDITION (0079), CÔTÉ WORKER — ce qu'un humain a relu est CE QUI PART.
 *
 * ⛔ POURQUOI CE BANC. La route de l'admin n'écrit que l'écart (`review_overrides`) ; c'est la passe
 * `refreezeReviewed` du worker qui reconstruit l'édition à partir de la base figée au gel. Si elle
 * ignore l'écart, l'écran affiche « Saved » et l'abonné reçoit l'article caché. On mesure donc les
 * colonnes que la passe ÉCRIT (celles que `render.ts` lit à l'envoi), pas un appel de fonction.
 *
 * La base n'est pas fabriquée à la main : elle sort d'un VRAI gel (`runPlanner` sur un modèle à flux,
 * en-tête de marque compris). C'est la base que la production écrira.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { articlesDeLEdition, lireBase, type EditionBase } from "@nf/edition";
import { runPlanner, type PlannerOptions } from "./planner";
import { PlannerDb } from "./planner-db";

type Db = Parameters<typeof runPlanner>[0];

const vraiFetch = globalThis.fetch;
const vraieCle = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  globalThis.fetch = vraiFetch;
  if (vraieCle === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = vraieCle;
});

const ID_HEADER = "11111111-1111-4111-8111-111111111111";
const MAINTENANT = new Date("2026-09-06T09:00:00.000Z");

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
const PARTIALS = [
  {
    id: ID_HEADER,
    slot: "header",
    rows: [
      {
        id: "pf_head",
        layout: "1",
        columns: [{ id: "pf_head_c", blocks: [{ id: "pf_head_b", type: "text", paragraphs: [{ spans: [{ text: "COPPER-KETTLE-HEADER" }] }] }] }],
      },
    ],
  },
];
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
  resolutions: { f1: { items: [article(1), article(2), article(3)], fetchedAt: "2026-09-06T08:00:00.000Z" } },
  sent: [],
});

const DOC_IA = {
  meta: { subject: "", preheader: "", assetSlug: "quartz-tips", locale: "pt-BR" },
  rows: [{ columns: [{ blocks: [{ id: "a1", type: "article", title: "Palmeiras vence o clássico", excerpt: "No Allianz." }] }] }],
};
const HTML_IA =
  '<html><div style="display:none">Preheader du modèle</div><p>{{ai_intro}}</p><a href="https://quartz-tips.test/x">x</a>{{legal_footer_html}}</html>';

async function silencieux<T>(fn: () => Promise<T>): Promise<T> {
  const vrai = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = vrai;
  }
}

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

/** Les doubles communs : aucune série à planifier, aucun compteur. */
const socle = {
  listArmedPlans: async () => [],
  countOutboxRowsWithOccurrence: async () => 0,
  countOverdueOccurrences: async () => 0,
  findLastSettled: async () => null,
  recordSentArticles: async () => {},
};

/** UN GEL réel. `occ` complète la ligne due (écart d'une relecture faite avant le gel, révision). */
async function geler(
  opts: { ia?: boolean; occ?: Record<string, unknown> } = {},
): Promise<{ patch: Record<string, unknown>; errors: string[]; held: string[] }> {
  if (opts.ia) {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    interceptFetch();
  }
  const patches: Record<string, unknown>[] = [];
  const held: string[] = [];
  const db = {
    ...socle,
    listOccurrencesToRefreeze: async () => [],
    listOccurrencesToFreeze: async () => [
      {
        id: "occ_1",
        campaign_id: "camp_1",
        asset_id: "asset_1",
        scheduled_at: "2026-09-06T10:00:00.000Z",
        subject: opts.ia ? "Edição {{edition_number}}" : "Sujet fixe",
        preheader: null,
        segment_id: "seg_1",
        template_version_id: "tv_1",
        duplicate_ack_at: null,
        campaign: { name: "Boletín del día", status: "scheduled", freeze_lead_minutes: 90 },
        ...opts.occ,
      },
    ],
    loadPublishedVersion: async () => ({
      id: "tv_1",
      status: "published",
      subject: "Sujet du modèle",
      preheader: "Preheader du modèle",
      doc: opts.ia ? DOC_IA : DOC_FLUX,
      html_shell: opts.ia ? HTML_IA : "<html>ignoré</html>",
      text_shell: "texte {{legal_footer_text}}",
      size_bytes: 1234,
      template: { asset_id: "asset_1", archived_at: null },
    }),
    brandPartialsOf: async () => PARTIALS,
    freezeOccurrence: async (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
      return true;
    },
    holdOccurrence: async (_id: string, raison: string) => {
      held.push(raison);
    },
  } as unknown as Db;
  const report = await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux: resoudreFluxOk }));
  expect(patches).toHaveLength(1);
  return { patch: patches[0]!, errors: report.errors, held };
}

/** La PASSE DE RELECTURE sur une édition gelée dont la base est `base` et l'écart `overrides`. */
async function relire(
  base: unknown,
  overrides: unknown,
  opts: { rev?: number; applique?: boolean; simulate?: boolean } = {},
) {
  const rev = opts.rev ?? 1;
  const appliques: { id: string; rev: number; patch: Record<string, unknown> }[] = [];
  const erreurs: { id: string; rev: number; raison: string }[] = [];
  const db = {
    ...socle,
    listOccurrencesToFreeze: async () => [],
    listOccurrencesToRefreeze: async () => [
      {
        id: "occ_1",
        campaign_id: "camp_1",
        asset_id: "asset_1",
        review_base: base,
        review_overrides: overrides,
        review_rev: rev,
        review_applied_rev: 0,
        campaign: { name: "Boletín del día", status: "scheduled", archived_at: null },
      },
    ],
    applyReview: async (id: string, r: number, patch: Record<string, unknown>) => {
      appliques.push({ id, rev: r, patch });
      return opts.applique ?? true;
    },
    recordReviewError: async (id: string, r: number, raison: string) => {
      erreurs.push({ id, rev: r, raison });
    },
  } as unknown as Db;
  const report = await silencieux(() => runPlanner(db, { now: MAINTENANT, simulate: opts.simulate }));
  return { report, appliques, erreurs, patch: appliques[0]?.patch };
}

async function baseFlux(): Promise<{ base: EditionBase; gel: Record<string, unknown> }> {
  const { patch, errors, held } = await geler();
  expect(errors).toEqual([]);
  expect(held).toEqual([]);
  const base = lireBase(patch.review_base);
  expect(base).not.toBeNull();
  return { base: base!, gel: patch };
}

describe("le gel écrit la base de relecture", () => {
  test("la base porte le document DÉPLIÉ (les 3 articles du jour) et les rows de l'en-tête", async () => {
    const { base, gel } = await baseFlux();
    expect(articlesDeLEdition(base.doc).map((a) => a.title)).toEqual(["Artículo 1", "Artículo 2", "Artículo 3"]);
    expect(base.pointeAuxPartials).toBe(true);
    expect(base.partials?.header).toBeDefined();
    expect(base.subject).toBe("Sujet fixe");
    // Aucune relecture : rien en attente, rien en erreur.
    expect(gel.review_applied_rev).toBe(0);
    expect(gel.review_error).toBeNull();
  });
});

describe("la passe de relecture — ce qui est relu est ce qui part", () => {
  test("⛔ un article CACHÉ n'est plus dans le shell, et le compte baisse", async () => {
    // MUTATION QUI DOIT TUER CE TEST : ignorer l'écart à la recompilation (`finaliserEdition(base, null)`).
    const { base, gel } = await baseFlux();
    const [, deuxieme] = articlesDeLEdition(base.doc);
    expect(String(gel.html_shell)).toContain("Artículo 2");

    const { report, patch, erreurs } = await relire(base, { articles: { [deuxieme!.id]: { hidden: true } } });
    expect(report.errors).toEqual([]);
    expect(erreurs).toEqual([]);
    const html = String(patch?.html_shell);
    expect(html).not.toContain("Artículo 2");
    expect(html).not.toContain("copper-kettle.test/a2/");
    expect(html).toContain("Artículo 1");
    expect(html).toContain("Artículo 3");
    // L'en-tête de marque survit à la recompilation (rows capturées au gel).
    expect(html).toContain("COPPER-KETTLE-HEADER");
    expect(patch?.article_count).toBe(2);
    expect(patch?.content_sha256).not.toBe(gel.content_sha256);
  });

  test("⛔ un article CORRIGÉ part corrigé : titre, extrait, lien, image", async () => {
    const { base } = await baseFlux();
    const [premier] = articlesDeLEdition(base.doc);
    const { report, patch } = await relire(base, {
      articles: {
        [premier!.id]: {
          title: "Titular corregido",
          excerpt: "Resumen corregido",
          href: "https://corregido.test/nota",
          imageSrc: "https://img.corregido.test/1.jpg",
        },
      },
    });
    expect(report.errors).toEqual([]);
    const html = String(patch?.html_shell);
    expect(html).toContain("Titular corregido");
    expect(html).toContain("Resumen corregido");
    expect(html).toContain("corregido.test/nota");
    expect(html).toContain("img.corregido.test/1.jpg");
    expect(html).not.toContain("Artículo 1");
    expect(patch?.first_article_title).toBe("Titular corregido");
  });

  test("⛔ le sujet et le preheader relus sont ceux qu'on écrit (le fan-out copie le sujet de l'occurrence)", async () => {
    const { base, gel } = await baseFlux();
    const { patch } = await relire(base, { subject: "Asunto relu", preheader: "Preheader relu" });
    expect(patch?.subject).toBe("Asunto relu");
    expect(patch?.preheader).toBe("Preheader relu");
    expect(String(patch?.html_shell)).toContain("Preheader relu");
    // Sans article relu : pas de recompilation, le reste du shell est celui du gel.
    expect(patch?.article_count).toBe(gel.article_count);
  });

  test("⛔ RESET complet (écart nul) : octet pour octet l'édition du gel", async () => {
    const { base, gel } = await baseFlux();
    const { patch } = await relire(base, null, { rev: 3 });
    for (const col of ["html_shell", "text_shell", "subject", "preheader", "content_sha256", "size_bytes", "article_count", "first_article_title"]) {
      expect(`${col}:${JSON.stringify(patch?.[col])}`).toBe(`${col}:${JSON.stringify(gel[col])}`);
    }
  });

  test("la révision écrite est celle LUE, et l'erreur précédente est effacée", async () => {
    const { base } = await baseFlux();
    const { appliques, report } = await relire(base, { subject: "Otro" }, { rev: 7 });
    expect(appliques).toHaveLength(1);
    expect(appliques[0]!.rev).toBe(7);
    expect(appliques[0]!.patch.review_applied_rev).toBe(7);
    expect(appliques[0]!.patch.review_error).toBeNull();
    expect(report.refrozen).toBe(1);
  });

  test("relue de nouveau pendant la reconstruction : l'écriture gardée ne touche rien, et ce n'est pas une erreur", async () => {
    const { base } = await baseFlux();
    const { report, erreurs } = await relire(base, { subject: "Otro" }, { applique: false });
    expect(report.errors).toEqual([]);
    expect(erreurs).toEqual([]);
    expect(report.refrozen).toBe(0);
  });

  test("⛔ TOUS les articles cachés : refusé, rien n'est écrit dans l'édition, la raison est enregistrée", async () => {
    const { base } = await baseFlux();
    const tous = Object.fromEntries(articlesDeLEdition(base.doc).map((a) => [a.id, { hidden: true }]));
    const { report, appliques, erreurs } = await relire(base, { articles: tous }, { rev: 4 });
    expect(appliques).toEqual([]);
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0]!.rev).toBe(4);
    expect(erreurs[0]!.raison).toContain("keep at least one article");
    expect(report.errors.some((e) => e.startsWith("review occ_1:"))).toBe(true);
  });

  test("une base illisible (gelée avant 0079) : en attente avec sa raison, jamais un repli", async () => {
    const { appliques, erreurs } = await relire(null, { subject: "X" });
    expect(appliques).toEqual([]);
    expect(erreurs[0]!.raison).toContain("no frozen base");
  });

  test("simulation : aucune écriture, ni reconstruction ni erreur", async () => {
    const { base } = await baseFlux();
    const ok = await relire(base, { subject: "Otro" }, { simulate: true });
    expect(ok.appliques).toEqual([]);
    expect(ok.report.refrozen).toBe(1);
    const ko = await relire(null, { subject: "Otro" }, { simulate: true });
    expect(ko.erreurs).toEqual([]);
  });
});

describe("les textes du modèle — lisibles, corrigibles, « Reset to AI version »", () => {
  test("⛔ l'intro corrigée est celle qu'on écrit ; l'accroche non touchée reste la générée", async () => {
    const { patch: gel, errors } = await geler({ ia: true });
    expect(errors).toEqual([]);
    expect(gel.ai_intro).toBe("Trois phrases.");
    const base = lireBase(gel.review_base)!;
    expect(base.ai).toBe(true);
    expect(base.ai_intro).toBe("Trois phrases.");

    const { patch } = await relire(base, { ai_intro: "Intro écrite par un humain." });
    expect(patch?.ai_intro).toBe("Intro écrite par un humain.");
    expect(patch?.ai_preheader).toBe("Accroche du jour");
  });

  test("⛔ Reset to AI version (la clé retirée) : le texte GÉNÉRÉ repart, pas le dernier corrigé", async () => {
    const { patch: gel } = await geler({ ia: true });
    const base = lireBase(gel.review_base)!;
    const { patch } = await relire(base, null, { rev: 2 });
    expect(patch?.ai_intro).toBe("Trois phrases.");
    expect(patch?.ai_preheader).toBe("Accroche du jour");
  });

  test("une intro VIDÉE est un choix (l'édition part sans intro), pas un reset", async () => {
    const { patch: gel } = await geler({ ia: true });
    const base = lireBase(gel.review_base)!;
    const { patch } = await relire(base, { ai_intro: "" });
    expect(patch?.ai_intro).toBe("");
  });
});

describe("relu AVANT le gel (édition encore planned)", () => {
  test("⛔ le sujet relu part dès le premier gel, et la révision est marquée appliquée", async () => {
    const { patch, errors } = await geler({ occ: { review_overrides: { subject: "Asunto relu antes" }, review_rev: 2 } });
    expect(errors).toEqual([]);
    expect(patch.subject).toBe("Asunto relu antes");
    expect(patch.review_applied_rev).toBe(2);
    expect(patch.review_error).toBeNull();
    // La base garde le sujet d'AVANT relecture : « reset » y revient.
    expect(lireBase(patch.review_base)?.subject).toBe("Sujet fixe");
  });

  test("un écart invalide au gel : l'édition gèle SANS lui, reste en attente (révision non appliquée) et dit pourquoi", async () => {
    const { patch } = await geler({ occ: { review_overrides: { subject: "Hola {{inconnu}}" }, review_rev: 1 } });
    expect(patch.subject).toBe("Sujet fixe");
    expect(patch.review_applied_rev).toBe(0);
    expect(String(patch.review_error)).toContain("{{inconnu}}");
  });
});

describe("PlannerDb — les requêtes de la relecture", () => {
  /** Le double du client Supabase : enregistre la chaîne, rend `lignes`. */
  function avecClient(lignes: Record<string, unknown>[]) {
    const appels: { methode: string; args: unknown[] }[] = [];
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resoudre: (v: unknown) => void) => resoudre({ data: lignes, error: null });
          return (...args: unknown[]) => {
            appels.push({ methode: prop, args });
            return proxy;
          };
        },
      },
    ) as Record<string, unknown>;
    const db = Object.create(PlannerDb.prototype) as PlannerDb;
    (db as unknown as { sb: unknown }).sb = proxy;
    const eqs = () => appels.filter((a) => a.methode === "eq").map((a) => `${a.args[0]}=${a.args[1]}`);
    return { db, appels, eqs };
  }

  test("listOccurrencesToRefreeze : gelées, en attente, d'une campagne qui peut encore envoyer", async () => {
    const ligne = (id: string, rev: number, appliquee: number, campagne: Record<string, unknown>) => ({
      id,
      campaign_id: "camp_1",
      asset_id: "asset_1",
      review_base: {},
      review_overrides: {},
      review_rev: rev,
      review_applied_rev: appliquee,
      campaign: { name: "C", status: "scheduled", archived_at: null, ...campagne },
    });
    const { db, appels, eqs } = avecClient([
      ligne("en-attente", 2, 1, {}),
      ligne("appliquee", 2, 2, {}),
      ligne("archivee", 2, 1, { archived_at: "2026-09-22T10:00:00Z" }),
      ligne("en-pause", 2, 1, { status: "paused" }),
    ]);
    const lignes = await db.listOccurrencesToRefreeze();
    expect(lignes.map((l) => l.id)).toEqual(["en-attente"]);
    expect(eqs()).toContain("status=frozen");
    expect(appels.some((a) => a.methode === "gt" && a.args[0] === "review_rev" && a.args[1] === 0)).toBe(true);
    expect(String(appels.find((a) => a.methode === "select")?.args[0])).toContain("review_base");
  });

  test("⛔ applyReview est gardée par `frozen` ET la révision lue, et relit ce qu'elle a touché", async () => {
    const { db, appels, eqs } = avecClient([{ id: "occ_1" }]);
    expect(await db.applyReview("occ_1", 4, { subject: "S", review_applied_rev: 4 })).toBe(true);
    expect(eqs()).toEqual(["id=occ_1", "status=frozen", "review_rev=4"]);
    expect(appels.some((a) => a.methode === "select")).toBe(true);
    const rien = avecClient([]);
    expect(await rien.db.applyReview("occ_1", 4, {})).toBe(false);
  });

  test("recordReviewError n'écrit que la raison, bornée, et seulement sur la révision lue", async () => {
    const { db, appels, eqs } = avecClient([]);
    await db.recordReviewError("occ_1", 3, "x".repeat(900));
    const maj = appels.find((a) => a.methode === "update")?.args[0] as Record<string, unknown>;
    expect(Object.keys(maj).sort()).toEqual(["review_error", "updated_at"]);
    expect(String(maj.review_error)).toHaveLength(500);
    expect(eqs()).toEqual(["id=occ_1", "review_rev=3"]);
  });
});