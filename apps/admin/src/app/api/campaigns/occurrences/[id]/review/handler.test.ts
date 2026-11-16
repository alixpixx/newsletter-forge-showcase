/**
 * RELIRE UNE ÉDITION (0079) — la route, mesurée sans session ni base, et CONFRONTÉE AU WORKER.
 *
 * Même montage que `campaigns/[id]/archive/handler.test.ts` : la session est injectée, le client
 * Supabase est le double `fauxDb` (réponses consommées DANS L'ORDRE des requêtes).
 *
 * ⛔ LA BASE N'EST PAS FABRIQUÉE À LA MAIN : elle sort d'un VRAI gel du worker (`runPlanner`, modèle à
 * flux, en-tête de marque). Et le banc central fait tourner les DEUX appelants de `finaliserEdition` —
 * la passe de reconstruction du worker et l'aperçu de cette route — sur la même base et le même écart,
 * puis compare leurs shells OCTET POUR OCTET. C'est la preuve qu'il n'existe qu'une définition de
 * l'e-mail : ce qu'on relit à l'écran est ce que le worker écrira.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { articlesDeLEdition, lireBase, type EditionBase } from "@nf/edition";
import { eqsDe, fauxDb, type AppelDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `templates.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import si AUTH_SECRET manque.
process.env.AUTH_SECRET = "secret-de-test-uniquement-22092026";
const { getReview, postReview, postReviewPreview } = await import("./handler");

/*
 * ⚠️ LE WORKER EST CHARGÉ PAR UN CHEMIN CALCULÉ, PAS PAR UN `import` LITTÉRAL. Un import littéral ferait
 * vérifier les fichiers du worker par le `tsc` de l'admin, avec la configuration de l'admin (alias,
 * types). Bun le charge ici tel qu'il tourne en production. Huit niveaux : review → … → apps.
 */
type Rapport = { errors: string[]; refrozen: number };
const CHEMIN_PLANNER = join(import.meta.dir, "..", "..", "..", "..", "..", "..", "..", "..", "worker", "src", "planner.ts");
const { runPlanner } = (await import(pathToFileURL(CHEMIN_PLANNER).href)) as {
  runPlanner: (db: unknown, opts?: Record<string, unknown>) => Promise<Rapport>;
};

const OCC = "44444444-4444-4444-8444-444444444444";
const CAMP = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const ID_HEADER = "33333333-3333-4333-8333-333333333333";
const MAINTENANT = new Date("2026-09-22T12:00:00Z");
const EDITEUR = "editor@staff.invalid";

/* ------------------------------------------------------------------ *
 * La base : un VRAI gel du worker
 * ------------------------------------------------------------------ */

const DOC_FLUX = {
  schema: 2,
  meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "copper-kettle", locale: "es", headerPartialId: ID_HEADER },
  theme: {},
  rows: [
    {
      id: "r_flux",
      layout: "1",
      columns: [
        {
          id: "c_flux",
          blocks: [
            {
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
            },
          ],
        },
      ],
    },
  ],
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

async function silencieux<T>(fn: () => Promise<T>): Promise<T> {
  const vrai = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = vrai;
  }
}

const socleWorker = {
  listArmedPlans: async () => [],
  countOutboxRowsWithOccurrence: async () => 0,
  countOverdueOccurrences: async () => 0,
  findLastSettled: async () => null,
  recordSentArticles: async () => {},
};

/** Le patch écrit par le GEL du worker (base de relecture comprise). */
async function gelDuWorker(): Promise<Record<string, unknown>> {
  const patches: Record<string, unknown>[] = [];
  const db = {
    ...socleWorker,
    listOccurrencesToRefreeze: async () => [],
    listOccurrencesToFreeze: async () => [
      {
        id: OCC,
        campaign_id: CAMP,
        asset_id: ASSET,
        scheduled_at: "2026-09-22T13:00:00.000Z",
        subject: "Sujet fixe",
        preheader: null,
        segment_id: null,
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
      doc: DOC_FLUX,
      html_shell: "<html>ignoré</html>",
      text_shell: "texte {{legal_footer_text}}",
      size_bytes: 1234,
      template: { asset_id: ASSET, archived_at: null },
    }),
    brandPartialsOf: async () => PARTIALS,
    freezeOccurrence: async (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
      return true;
    },
    holdOccurrence: async () => {},
  };
  const rapport = await silencieux(() =>
    runPlanner(db, {
      now: MAINTENANT,
      resoudreFlux: async () => ({
        ok: true,
        resolutions: { f1: { items: [article(1), article(2), article(3)], fetchedAt: "2026-09-22T11:00:00.000Z" } },
        sent: [],
      }),
    }),
  );
  expect(rapport.errors).toEqual([]);
  expect(patches).toHaveLength(1);
  return patches[0]!;
}

/** Ce que la passe de RECONSTRUCTION du worker écrit pour `base` + `overrides`. */
async function reconstructionDuWorker(base: unknown, overrides: unknown): Promise<Record<string, unknown>> {
  const ecrits: Record<string, unknown>[] = [];
  const db = {
    ...socleWorker,
    listOccurrencesToFreeze: async () => [],
    listOccurrencesToRefreeze: async () => [
      {
        id: OCC,
        campaign_id: CAMP,
        asset_id: ASSET,
        review_base: base,
        review_overrides: overrides,
        review_rev: 1,
        review_applied_rev: 0,
        campaign: { name: "Boletín del día", status: "scheduled", archived_at: null },
      },
    ],
    applyReview: async (_id: string, _rev: number, patch: Record<string, unknown>) => {
      ecrits.push(patch);
      return true;
    },
    recordReviewError: async () => {},
  };
  const rapport = await silencieux(() => runPlanner(db, { now: MAINTENANT }));
  expect(rapport.errors).toEqual([]);
  expect(ecrits).toHaveLength(1);
  return ecrits[0]!;
}

let GEL: Record<string, unknown>;
let BASE: EditionBase;
let IDS: string[];
beforeAll(async () => {
  GEL = await gelDuWorker();
  BASE = lireBase(GEL.review_base)!;
  IDS = articlesDeLEdition(BASE.doc).map((a) => a.id);
});

/* ------------------------------------------------------------------ *
 * Le montage de la route
 * ------------------------------------------------------------------ */

const ligne = (extra: Record<string, unknown> = {}): ReponseDb => ({
  data: {
    id: OCC,
    campaign_id: CAMP,
    seq: 12,
    local_date: "2026-09-22",
    scheduled_at: "2026-09-22T13:00:00+00:00",
    status: "frozen",
    subject: "Sujet fixe",
    preheader: null,
    ai_status: null,
    ai_reason: null,
    review_base: BASE,
    review_overrides: null,
    review_rev: 0,
    review_applied_rev: 0,
    review_error: null,
    review_updated_at: null,
    review_updated_by: null,
    campaign: { id: CAMP, name: "Boletín del día", status: "scheduled", archived_at: null },
    ...extra,
  },
  error: null,
});
const planifiee = (extra: Record<string, unknown> = {}) => ligne({ status: "planned", review_base: null, ...extra });
const touche: ReponseDb = { data: [{ id: OCC }], error: null };
const rien: ReponseDb = { data: [], error: null };
const ok: ReponseDb = { data: null, error: null };

const ctx = (db: unknown) => ({
  ok: true as const,
  ctx: { db: db as never, asset: { id: ASSET, name: "PF" } as never, user: { email: EDITEUR } as never },
});

type Handler = typeof postReview;
async function appeler(fn: Handler, corps: unknown, ...reponses: ReponseDb[]) {
  const { db, appels, restantes } = fauxDb(...reponses);
  const req = new Request("http://x/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  const res = await fn(req, { params: Promise.resolve({ id: OCC }) }, {
    requireContext: async () => ctx(db),
    maintenant: () => MAINTENANT,
  });
  return { res, json: (await res.json()) as Record<string, unknown>, appels, restantes };
}

const ecritures = (appels: AppelDb[]) =>
  appels.filter((a) => a.methodes.some((m) => ["insert", "update", "upsert", "delete"].includes(m.m)));
const miseAJour = (appels: AppelDb[]) =>
  appels.find((a) => a.table === "campaign_occurrence" && a.methodes.some((m) => m.m === "update"));
const payloadDe = (a: AppelDb | undefined, m: string) =>
  a?.methodes.find((x) => x.m === m)?.args[0] as Record<string, unknown> | undefined;
const audit = (appels: AppelDb[]) => appels.find((a) => a.table === "audit_log");

/* ------------------------------------------------------------------ *
 * GET
 * ------------------------------------------------------------------ */

describe("GET /review — ce que l'écran relit", () => {
  test("une édition gelée : ses articles du jour, relisibles, rien en attente", async () => {
    const { res, json } = await appeler(getReview as Handler, undefined, ligne());
    expect(res.status).toBe(200);
    expect(json.editable).toBe(true);
    expect(json.stage).toBe("frozen");
    expect(json.pending).toBe(false);
    const base = json.base as { subject: string; articles: { title: string }[] };
    expect(base.subject).toBe("Sujet fixe");
    expect(base.articles.map((a) => a.title)).toEqual(["Artículo 1", "Artículo 2", "Artículo 3"]);
  });

  test("« pending » est la définition du fan-out : révision écrite > révision appliquée", async () => {
    const { json } = await appeler(getReview as Handler, undefined, ligne({ review_rev: 3, review_applied_rev: 2, review_error: "boom" }));
    expect(json.pending).toBe(true);
    expect(json.error).toBe("boom");
  });

  test("un identifiant qui n'est pas un uuid : 400, sans requête", async () => {
    const { db, appels } = fauxDb();
    const res = await getReview(new Request("http://x"), { params: Promise.resolve({ id: "pas-un-uuid" }) }, {
      requireContext: async () => ctx(db),
      maintenant: () => MAINTENANT,
    });
    expect(res.status).toBe(400);
    expect(appels).toEqual([]);
  });

  test("scopée marque : la lecture filtre `asset_id`, et une édition d'une autre marque est introuvable", async () => {
    const { res, appels } = await appeler(getReview as Handler, undefined, { data: null, error: null });
    expect(res.status).toBe(404);
    expect(eqsDe(appels[0]!)).toContainEqual(["asset_id", ASSET]);
  });

  test("migration 0079 absente : 503 qui le dit, pas un 500 opaque", async () => {
    const { res, json } = await appeler(getReview as Handler, undefined, {
      data: null,
      error: { message: "column campaign_occurrence.review_base does not exist" },
    });
    expect(res.status).toBe(503);
    expect(String(json.error)).toContain("0079");
  });
});

/* ------------------------------------------------------------------ *
 * POST — les refus d'état
 * ------------------------------------------------------------------ */

describe("⛔ POST /review — une édition qui part, partie ou rangée ne se relit plus (409)", () => {
  // Paresseux : la base n'existe qu'après `beforeAll`.
  const cas: [string, () => ReponseDb, string][] = [
    ["sending", () => ligne({ status: "sending" }), "being sent"],
    ["sent", () => ligne({ status: "sent" }), "already been sent"],
    ["campagne archivée", () => ligne({ campaign: { id: CAMP, name: "B", status: "scheduled", archived_at: "2026-09-21T10:00:00Z" } }), "archived"],
    ["archivée ET planifiée", () => planifiee({ campaign: { id: CAMP, name: "B", status: "scheduled", archived_at: "2026-09-21T10:00:00Z" } }), "archived"],
    ["held", () => ligne({ status: "held" }), "held"],
    ["cancelled", () => ligne({ status: "cancelled" }), "cancelled"],
    ["gelée avant 0079 (sans base)", () => ligne({ review_base: null }), "before edition review existed"],
  ];
  // MUTATIONS QUI DOIVENT TUER CE BLOC : laisser passer `sending`, ou retirer le refus d'archive.
  for (const [nom, reponse, mot] of cas) {
    test(`${nom} → 409, et RIEN n'est écrit`, async () => {
      const { res, json, appels } = await appeler(postReview, { rev: 0, overrides: { subject: "Otro asunto" } }, reponse(), touche, ok);
      expect(`${nom}:${res.status}`).toBe(`${nom}:409`);
      expect(String(json.error)).toContain(mot);
      expect(ecritures(appels)).toEqual([]);
    });
  }

  test("deux onglets : la révision lue n'est plus la bonne → 409, rien n'est écrit", async () => {
    const { res, appels } = await appeler(postReview, { rev: 0, overrides: { subject: "Otro" } }, ligne({ review_rev: 2, review_applied_rev: 2 }));
    expect(res.status).toBe(409);
    expect(ecritures(appels)).toEqual([]);
  });

  test("l'édition a changé entre la lecture et l'écriture (0 ligne touchée) → 409, et pas d'audit", async () => {
    const { res, appels } = await appeler(postReview, { rev: 0, overrides: { subject: "Otro" } }, ligne(), rien, ok);
    expect(res.status).toBe(409);
    expect(audit(appels)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * POST — la validation
 * ------------------------------------------------------------------ */

describe("POST /review — ce qui est refusé à l'écran (422) n'arrive jamais au worker", () => {
  test("⛔ cacher TOUS les articles est refusé", async () => {
    const tous = Object.fromEntries(IDS.map((id) => [id, { hidden: true }]));
    const { res, json, appels } = await appeler(postReview, { rev: 0, overrides: { articles: tous } }, ligne());
    expect(res.status).toBe(422);
    expect(String(json.error)).toContain("keep at least one article");
    expect(ecritures(appels)).toEqual([]);
  });

  const invalides: [string, unknown][] = [
    ["lien non http(s)", { articles: { ID0: { href: "javascript:alert(1)" } } }],
    ["image non http(s)", { articles: { ID0: { imageSrc: "ftp://img.test/x.jpg" } } }],
    ["titre vide", { articles: { ID0: { title: "   " } } }],
    ["article inconnu", { articles: { "pas-dans-l-edition": { hidden: true } } }],
    ["jeton inconnu dans le sujet", { subject: "Hola {{inconnu}}" }],
    ["sujet trop long", { subject: "x".repeat(251) }],
  ];
  for (const [nom, overrides] of invalides) {
    test(`${nom} → 422, rien n'est écrit`, async () => {
      const brut = JSON.parse(JSON.stringify(overrides).replaceAll("ID0", IDS[0]!));
      const { res, appels } = await appeler(postReview, { rev: 0, overrides: brut }, ligne());
      expect(`${nom}:${res.status}`).toBe(`${nom}:422`);
      expect(ecritures(appels)).toEqual([]);
    });
  }

  test("une édition PLANIFIÉE : sujet et preheader oui, articles et textes du modèle non (pas encore choisis)", async () => {
    const articles = await appeler(postReview, { rev: 0, overrides: { articles: { x: { hidden: true } } } }, planifiee());
    expect(articles.res.status).toBe(422);
    expect(String(articles.json.error)).toContain("frozen");
    const ia = await appeler(postReview, { rev: 0, overrides: { ai_intro: "Hola" } }, planifiee());
    expect(ia.res.status).toBe(422);
  });
});

/* ------------------------------------------------------------------ *
 * POST — l'enregistrement et sa trace
 * ------------------------------------------------------------------ */

describe("POST /review — l'écart est enregistré, gardé, tracé", () => {
  test("⛔ cacher un article : écriture gardée (statut ET révision lus), révision +1, erreur effacée", async () => {
    const { res, json, appels, restantes } = await appeler(
      postReview,
      { rev: 0, overrides: { articles: { [IDS[1]!]: { hidden: true } } } },
      ligne(),
      touche,
      ok,
    );
    expect(res.status).toBe(200);
    expect(json.rev).toBe(1);
    expect(restantes()).toBe(0);

    const maj = miseAJour(appels)!;
    expect(eqsDe(maj)).toEqual([
      ["id", OCC],
      ["asset_id", ASSET],
      ["status", "frozen"],
      ["review_rev", 0],
    ]);
    const patch = payloadDe(maj, "update")!;
    expect(patch.review_overrides).toEqual({ articles: { [IDS[1]!]: { hidden: true } } });
    expect(patch.review_rev).toBe(1);
    expect(patch.review_error).toBeNull();
    expect(patch.review_updated_by).toBe(EDITEUR);
    // ⛔ La route n'écrit JAMAIS ce qui part : le shell, le sujet et les textes sont l'affaire du worker.
    for (const col of ["html_shell", "subject", "preheader", "ai_intro", "ai_preheader", "review_applied_rev", "status"]) {
      expect(`${col}:${col in patch}`).toBe(`${col}:false`);
    }
  });

  /** MUTATION QUI DOIT TUER CE TEST : retirer l'appel à `journaliser` de `postReview`. */
  test("⛔ chaque relecture écrit UNE ligne d'audit — sans aucune donnée d'abonné", async () => {
    const { appels, json } = await appeler(
      postReview,
      { rev: 0, overrides: { subject: "Asunto relu", articles: { [IDS[0]!]: { title: "Titular corregido" }, [IDS[2]!]: { hidden: true } } } },
      ligne(),
      touche,
      ok,
    );
    expect(json.audited).toBe(true);
    const a = audit(appels)!;
    const ligneAudit = payloadDe(a, "insert")!;
    expect(ligneAudit.action).toBe("edition-reviewed");
    expect(ligneAudit.target_type).toBe("campaign_occurrence");
    expect(ligneAudit.target_id).toBe(OCC);
    expect(ligneAudit.asset_id).toBe(ASSET);
    expect(ligneAudit.actor).toBe(`admin:${EDITEUR}`);
    const meta = ligneAudit.meta as Record<string, unknown>;
    expect(meta.rev).toBe(1);
    expect(meta.changed).toEqual(["subject", "articles"]);
    expect(meta.articles_hidden).toBe(1);
    expect(meta.articles_edited).toBe(1);
    // Aucune adresse, et pas même le texte relu : des NOMS de champs et des compteurs.
    const brut = JSON.stringify(meta);
    expect(brut).not.toContain("@");
    expect(brut).not.toContain("Asunto relu");
    expect(brut).not.toContain("Titular corregido");
  });

  test("un audit raté ne défait pas la relecture : 200 et `audited: false`", async () => {
    const { res, json } = await appeler(postReview, { rev: 0, overrides: { subject: "Otro" } }, ligne(), touche, {
      data: null,
      error: { message: "audit indisponible" },
    });
    expect(res.status).toBe(200);
    expect(json.audited).toBe(false);
  });

  test("une édition planifiée : le sujet relu est enregistré, gardé par `planned`", async () => {
    const { res, appels } = await appeler(postReview, { rev: 0, overrides: { subject: "Asunto antes del gel" } }, planifiee(), touche, ok);
    expect(res.status).toBe(200);
    expect(eqsDe(miseAJour(appels)!)).toContainEqual(["status", "planned"]);
  });

  test("rien de changé (même écart) : aucune écriture, aucun audit", async () => {
    const { json, appels } = await appeler(
      postReview,
      { rev: 1, overrides: { subject: "Otro" } },
      ligne({ review_rev: 1, review_applied_rev: 1, review_overrides: { subject: "Otro" } }),
    );
    expect(json.unchanged).toBe(true);
    expect(ecritures(appels)).toEqual([]);
  });

  test("⛔ Reset to AI version : la clé retirée (ou remise au texte généré) écrit un écart NUL, tracé en `reset`", async () => {
    const baseIa = { ...BASE, ai: true, ai_intro: "Intro générée.", ai_preheader: "Accroche générée." };
    for (const overrides of [{}, { ai_intro: "Intro générée." }]) {
      const { res, appels } = await appeler(
        postReview,
        { rev: 2, overrides },
        ligne({ review_base: baseIa, review_rev: 2, review_applied_rev: 2, review_overrides: { ai_intro: "Intro corrigée." } }),
        touche,
        ok,
      );
      expect(res.status).toBe(200);
      expect(payloadDe(miseAJour(appels), "update")!.review_overrides).toBeNull();
      expect((payloadDe(audit(appels), "insert")!.meta as Record<string, unknown>).reset).toEqual(["ai_intro"]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * L'aperçu — et la preuve des deux appelants
 * ------------------------------------------------------------------ */

describe("POST /review/preview — l'e-mail recompilé, sans rien écrire", () => {
  test("un brouillon qui cache un article : l'aperçu ne le montre plus, et rien n'est écrit", async () => {
    const { res, json, appels } = await appeler(
      postReviewPreview as Handler,
      { overrides: { articles: { [IDS[1]!]: { hidden: true } } } },
      ligne(),
    );
    expect(res.status).toBe(200);
    expect(String(json.html)).not.toContain("Artículo 2");
    expect(String(json.html)).toContain("Artículo 1");
    expect(String(json.html)).toContain("COPPER-KETTLE-HEADER");
    expect(json.recompiled).toBe(true);
    expect(json.articleCount).toBe(2);
    expect(ecritures(appels)).toEqual([]);
  });

  test("une édition planifiée n'a pas encore de contenu : 409 qui le dit", async () => {
    const { res, json } = await appeler(postReviewPreview as Handler, undefined, planifiee());
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("not frozen yet");
  });

  test("un brouillon invalide : 422, la même règle que l'enregistrement", async () => {
    const tous = Object.fromEntries(IDS.map((id) => [id, { hidden: true }]));
    const { res } = await appeler(postReviewPreview as Handler, { overrides: { articles: tous } }, ligne());
    expect(res.status).toBe(422);
  });
});

describe("⛔ UNE SEULE DÉFINITION DE L'E-MAIL — l'aperçu de l'admin et la reconstruction du worker", () => {
  const ecarts: [string, () => Record<string, unknown> | null][] = [
    ["aucune relecture", () => null],
    ["sujet et preheader", () => ({ subject: "Asunto relu", preheader: "Preheader relu" })],
    [
      "article caché + article corrigé",
      () => ({
        articles: {
          [IDS[0]!]: { title: "Titular corregido", href: "https://corregido.test/nota", imageSrc: "" },
          [IDS[2]!]: { hidden: true },
        },
      }),
    ],
  ];
  for (const [nom, ecart] of ecarts) {
    test(`${nom} : le shell de l'aperçu est OCTET POUR OCTET celui que le worker écrit`, async () => {
      const worker = await reconstructionDuWorker(BASE, ecart());
      const { json } = await appeler(postReviewPreview as Handler, { overrides: ecart() }, ligne());
      expect(typeof json.shell).toBe("string");
      expect(json.shell === worker.html_shell).toBe(true);
      expect(json.subject).toBe(worker.subject);
      expect(json.preheader).toBe(worker.preheader);
      expect(json.articleCount).toBe(worker.article_count);
      expect(json.sizeBytes).toBe(worker.size_bytes);
    });
  }

  test("⛔ une édition que personne n'a relue : l'aperçu montre EXACTEMENT le shell du gel d'aujourd'hui", async () => {
    const { json } = await appeler(postReviewPreview as Handler, undefined, ligne());
    expect(json.shell === GEL.html_shell).toBe(true);
    expect(json.subject).toBe(GEL.subject);
    expect(json.recompiled).toBe(false);
  });
});
