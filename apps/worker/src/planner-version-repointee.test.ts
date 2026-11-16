/**
 * Banc de la COURSE entre le gel et l'enregistrement d'une campagne (décision d'Alix du 25/09/2026,
 * « A : l'enregistrement repointe »).
 *
 * Enregistrer une série avec une nouvelle version repointe ses éditions `planned` à venir (admin,
 * `repointUpcomingOccurrences`). L'admin se tient hors de la fenêtre de gel ; ce banc mesure la
 * CEINTURE côté worker : si le repointage tombe malgré tout entre la lecture de l'occurrence et
 * l'écriture du gel, le gel est REFUSÉ, rien n'est compté, les articles ne sont PAS mémorisés dans
 * `feed_article_sent`, et la passe suivante gèle avec la nouvelle version.
 *
 * Le double de `PlannerDb` émule la garde SQL de `freezeOccurrence` (statut ET version lue) sur une
 * ligne en mémoire. La garde elle-même (le `.eq` de la requête) est mesurée dans `planner-db.test.ts`.
 * Même motif que `planner-brand-partials-cablage.test.ts` : résolution des flux INJECTÉE, aucun
 * `mock.module`.
 */
import { describe, expect, test } from "bun:test";
import { runPlanner, type PlannerOptions } from "./planner";

type Db = Parameters<typeof runPlanner>[0];

const rowTexte = (id: string, texte: string): unknown => ({
  id,
  layout: "1",
  columns: [
    { id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: texte }] }] }] },
  ],
});

const blocFlux = {
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
};

/** Deux versions publiées que tout distingue : le texte du corps le dit dans le HTML gelé. */
const docDe = (marque: string) => ({
  schema: 2,
  meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "northwind-sports", locale: "pt-BR" },
  theme: {},
  rows: [rowTexte("r_txt", marque), { id: "r_flux", layout: "1", columns: [{ id: "c_flux", blocks: [blocFlux] }] }],
});

const article = (n: number) => ({
  postId: String(n),
  title: `Artigo ${n}`,
  excerpt: `Resumo ${n}`,
  href: `https://northwind-sports.test/a${n}/`,
  imageAlt: "",
});

const MAINTENANT = new Date("2026-09-25T12:00:00.000Z");

interface Ligne {
  id: string;
  status: string;
  template_version_id: string;
  html_shell: string | null;
}

interface Vu {
  versionsChargees: string[];
  gels: { versionLue: unknown; ok: boolean }[];
  articles: { occurrenceId: string | null; articleUrl: string }[];
  held: string[];
}

/**
 * `repointerPendant` : ce que fait l'admin PENDANT la passe, entre la lecture et l'écriture.
 */
function banc(repointerPendant: (l: Ligne) => void) {
  const ligne: Ligne = { id: "occ_1", status: "planned", template_version_id: "tv_8", html_shell: null };
  const vu: Vu = { versionsChargees: [], gels: [], articles: [], held: [] };
  let passes = 0;

  const db = {
    listArmedPlans: async () => [],
    countOutboxRowsWithOccurrence: async () => 0,
    countOverdueOccurrences: async () => 0,
    listOccurrencesToRefreeze: async () => [],
    listOccurrencesToFreeze: async () =>
      ligne.status !== "planned"
        ? []
        : [
            {
              id: ligne.id,
              campaign_id: "camp_1",
              asset_id: "asset_1",
              scheduled_at: "2026-09-25T13:00:00.000Z",
              subject: "Giro do Tricolor",
              preheader: null,
              segment_id: null,
              template_version_id: ligne.template_version_id,
              duplicate_ack_at: null,
              campaign: { name: "Giro do Tricolor", status: "draft", freeze_lead_minutes: 90 },
            },
          ],
    loadPublishedVersion: async (versionId: string) => {
      vu.versionsChargees.push(versionId);
      return {
        id: versionId,
        status: "published",
        subject: "Sujet du modèle",
        preheader: "Preheader",
        doc: docDe(versionId === "tv_10" ? "CONTENU-V10" : "CONTENU-V8"),
        html_shell: "<html>{{legal_footer_html}}</html>",
        text_shell: "texte",
        size_bytes: 1234,
        template: { asset_id: "asset_1", archived_at: null },
      };
    },
    brandPartialsOf: async () => [],
    findLastSettled: async () => null,
    // L'émulation de la garde SQL : `status = 'planned'` ET `template_version_id = versionLue`.
    freezeOccurrence: async (_id: string, patch: Record<string, unknown>, versionLue?: unknown) => {
      const ok = ligne.status === "planned" && ligne.template_version_id === versionLue;
      vu.gels.push({ versionLue, ok });
      if (ok) {
        ligne.status = "frozen";
        ligne.html_shell = String(patch.html_shell ?? "");
      }
      return ok;
    },
    recordSentArticles: async (rows: { occurrenceId: string | null; articleUrl: string }[]) => {
      for (const r of rows) vu.articles.push({ occurrenceId: r.occurrenceId, articleUrl: r.articleUrl });
    },
    holdOccurrence: async (id: string) => {
      vu.held.push(id);
    },
  } as unknown as Db;

  const resoudreFlux: PlannerOptions["resoudreFlux"] = async () => {
    passes++;
    // Première passe : l'admin enregistre la campagne sur v10 PENDANT que le worker résout les flux.
    if (passes === 1) repointerPendant(ligne);
    return {
      ok: true,
      resolutions: { f1: { items: [article(1), article(2), article(3)], fetchedAt: "2026-09-25T11:00:00.000Z" } },
      sent: [1, 2, 3].map((n) => ({
        blockId: "f1",
        articleUrl: article(n).href,
        articleTitle: article(n).title,
        publishedAt: null,
      })),
    };
  };

  return { db, vu, ligne, resoudreFlux };
}

/** Le journal du worker, avalé localement (pas de `mock.module`). */
async function silencieux<T>(fn: () => Promise<T>): Promise<T> {
  const vrai = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = vrai;
  }
}

describe("gel — une version repointée entre la lecture et l'écriture", () => {
  test("⛔ le gel est refusé : rien n'est compté, AUCUN article n'est mémorisé, l'édition reste planned", async () => {
    // MUTATIONS QUI DOIVENT TUER CE TEST : ne plus passer la version lue à `freezeOccurrence` ;
    // mémoriser les articles avant (ou sans) le constat du gel.
    const { db, vu, ligne, resoudreFlux } = banc((l) => {
      l.template_version_id = "tv_10";
    });
    const rapport = await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux }));

    expect(rapport.errors).toEqual([]);
    expect(vu.versionsChargees).toEqual(["tv_8"]);
    expect(vu.gels).toEqual([{ versionLue: "tv_8", ok: false }]);
    expect(rapport.frozen).toBe(0);
    expect(rapport.held).toBe(0);
    expect(vu.held).toEqual([]);
    expect(vu.articles).toEqual([]);
    expect(ligne.status).toBe("planned");
    expect(ligne.template_version_id).toBe("tv_10");
  });

  test("⛔ la passe suivante gèle avec la NOUVELLE version, et mémorise alors ses articles", async () => {
    const { db, vu, ligne, resoudreFlux } = banc((l) => {
      l.template_version_id = "tv_10";
    });
    await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux }));
    const seconde = await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux }));

    expect(seconde.errors).toEqual([]);
    expect(vu.versionsChargees).toEqual(["tv_8", "tv_10"]);
    expect(vu.gels.at(-1)).toEqual({ versionLue: "tv_10", ok: true });
    expect(seconde.frozen).toBe(1);
    expect(ligne.status).toBe("frozen");
    expect(ligne.html_shell).toContain("CONTENU-V10");
    expect(ligne.html_shell).not.toContain("CONTENU-V8");
    expect(vu.articles).toHaveLength(3);
    expect(vu.articles.every((a) => a.occurrenceId === "occ_1")).toBe(true);
  });

  test("TÉMOIN — sans repointage, le gel passe du premier coup avec la version lue", async () => {
    // Sans lui, une garde qui refuserait TOUT gel passerait les deux tests précédents à moitié — et
    // plus aucune série ne partirait.
    const { db, vu, ligne, resoudreFlux } = banc(() => {});
    const rapport = await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux }));

    expect(rapport.errors).toEqual([]);
    expect(vu.gels).toEqual([{ versionLue: "tv_8", ok: true }]);
    expect(rapport.frozen).toBe(1);
    expect(ligne.html_shell).toContain("CONTENU-V8");
    expect(vu.articles).toHaveLength(3);
  });
});

/*
 * LA MÊME COURSE POUR LE SUJET, LE PREHEADER ET LE SEGMENT (décision d'Alix du 25/09/2026 au soir,
 * « même règle »). Le gel FIGE ce qu'il a lu : il RÉÉCRIT `subject` et `preheader` avec ses propres
 * valeurs, et le segment lu entre dans l'empreinte anti-doublon et dans `review_base`. Sans garde, un
 * repointage tombé entre la lecture et l'écriture serait écrasé par l'ancien sujet — et partirait avec.
 *
 * Le double émule la garde SQL complète (statut, version ET contenu lu) et, quand elle passe, écrit sur
 * la ligne ce que le patch du gel porte : c'est ce qui rend l'écrasement VISIBLE.
 */
interface LigneContenu {
  id: string;
  status: string;
  template_version_id: string;
  subject: string;
  preheader: string | null;
  segment_id: string | null;
}

function bancContenu(modifierPendant: (l: LigneContenu) => void, initiale: Partial<LigneContenu> = {}) {
  const ligne: LigneContenu = {
    id: "occ_1",
    status: "planned",
    template_version_id: "tv_8",
    subject: "Ancien sujet",
    // NULL exprès : la garde doit le lire comme `is null`, et le gel retomber sur le preheader du modèle.
    preheader: null,
    segment_id: "seg_a",
    ...initiale,
  };
  const vu = { lus: [] as unknown[], ok: [] as boolean[], articles: 0 };
  let passes = 0;

  const db = {
    listArmedPlans: async () => [],
    countOutboxRowsWithOccurrence: async () => 0,
    countOverdueOccurrences: async () => 0,
    listOccurrencesToRefreeze: async () => [],
    listOccurrencesToFreeze: async () =>
      ligne.status !== "planned"
        ? []
        : [
            {
              id: ligne.id,
              campaign_id: "camp_1",
              asset_id: "asset_1",
              scheduled_at: "2026-09-25T13:00:00.000Z",
              subject: ligne.subject,
              preheader: ligne.preheader,
              segment_id: ligne.segment_id,
              template_version_id: ligne.template_version_id,
              duplicate_ack_at: null,
              campaign: { name: "Giro do Tricolor", status: "draft", freeze_lead_minutes: 90 },
            },
          ],
    loadPublishedVersion: async (versionId: string) => ({
      id: versionId,
      status: "published",
      subject: "Sujet du modèle",
      preheader: "Preheader du modèle",
      doc: docDe("CONTENU-V8"),
      html_shell: "<html>{{legal_footer_html}}</html>",
      text_shell: "texte",
      size_bytes: 1234,
      template: { asset_id: "asset_1", archived_at: null },
    }),
    brandPartialsOf: async () => [],
    findLastSettled: async () => null,
    // La garde SQL : statut, version lue ET sujet / preheader / segment lus.
    freezeOccurrence: async (_id: string, patch: Record<string, unknown>, versionLue: unknown, contenuLu: unknown) => {
      const lu = contenuLu as { subject?: unknown; preheader?: unknown; segment_id?: unknown } | undefined;
      vu.lus.push(lu);
      const ok =
        ligne.status === "planned" &&
        ligne.template_version_id === versionLue &&
        lu !== undefined &&
        ligne.subject === lu.subject &&
        ligne.preheader === lu.preheader &&
        ligne.segment_id === lu.segment_id;
      vu.ok.push(ok);
      if (ok) {
        ligne.status = "frozen";
        ligne.subject = String(patch.subject);
        ligne.preheader = (patch.preheader as string | null) ?? null;
      }
      return ok;
    },
    recordSentArticles: async (rows: unknown[]) => {
      vu.articles += rows.length;
    },
    holdOccurrence: async () => {},
  } as unknown as Db;

  const resoudreFlux: PlannerOptions["resoudreFlux"] = async () => {
    passes++;
    // Première passe : l'admin enregistre la campagne PENDANT que le worker résout les flux.
    if (passes === 1) modifierPendant(ligne);
    return {
      ok: true,
      resolutions: { f1: { items: [article(1), article(2), article(3)], fetchedAt: "2026-09-25T11:00:00.000Z" } },
      sent: [1, 2, 3].map((n) => ({
        blockId: "f1",
        articleUrl: article(n).href,
        articleTitle: article(n).title,
        publishedAt: null,
      })),
    };
  };

  return { db, vu, ligne, resoudreFlux };
}

describe("gel — un sujet, un preheader ou un segment repointés entre la lecture et l'écriture", () => {
  test("⛔ sujet : le gel est refusé, le NOUVEAU sujet survit, rien n'est compté ni mémorisé", async () => {
    // MUTATION QUI DOIT TUER CE TEST : ne plus passer le contenu lu à `freezeOccurrence` (ou passer celui
    // du gel). Sans garde, la ligne repartirait avec « Ancien sujet ».
    const { db, vu, ligne, resoudreFlux } = bancContenu((l) => {
      l.subject = "Nouveau sujet";
    });
    const rapport = await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux }));

    expect(rapport.errors).toEqual([]);
    expect(vu.ok).toEqual([false]);
    expect(rapport.frozen).toBe(0);
    expect(vu.articles).toBe(0);
    expect(ligne.status).toBe("planned");
    expect(ligne.subject).toBe("Nouveau sujet");
  });

  test("⛔ sujet : la passe suivante gèle AVEC le nouveau sujet", async () => {
    const { db, vu, ligne, resoudreFlux } = bancContenu((l) => {
      l.subject = "Nouveau sujet";
    });
    await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux }));
    const seconde = await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux }));

    expect(seconde.frozen).toBe(1);
    expect(vu.ok).toEqual([false, true]);
    expect(ligne.status).toBe("frozen");
    expect(ligne.subject).toBe("Nouveau sujet");
    expect(vu.articles).toBe(3);
  });

  test("⛔ preheader posé et segment changé : le gel est refusé aussi", async () => {
    for (const modifier of [
      (l: LigneContenu) => {
        l.preheader = "Nouveau preheader";
      },
      (l: LigneContenu) => {
        l.segment_id = "seg_b";
      },
    ]) {
      const { db, vu, ligne, resoudreFlux } = bancContenu(modifier);
      const rapport = await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux }));
      expect(vu.ok).toEqual([false]);
      expect(rapport.frozen).toBe(0);
      expect(vu.articles).toBe(0);
      expect(ligne.status).toBe("planned");
    }
  });

  test("TÉMOIN — rien ne bouge : gel du premier coup, avec les valeurs BRUTES de la ligne (preheader NULL)", async () => {
    // Sans lui, une garde qui refuserait tout gel passerait les tests ci-dessus. Il tue aussi la mutation
    // « passer le preheader EFFECTIF » : le gel retombe sur celui du modèle, que la ligne ne porte pas.
    const { db, vu, ligne, resoudreFlux } = bancContenu(() => {});
    const rapport = await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux }));

    expect(rapport.errors).toEqual([]);
    expect(vu.lus).toEqual([{ subject: "Ancien sujet", preheader: null, segment_id: "seg_a" }]);
    expect(vu.ok).toEqual([true]);
    expect(rapport.frozen).toBe(1);
    expect(ligne.subject).toBe("Ancien sujet");
    expect(vu.articles).toBe(3);
  });

  test("⛔ TÉMOIN — sujet VIDE sur l'édition (repli sur celui du modèle) : gel du premier coup", async () => {
    // MUTATION QUI DOIT TUER CE TEST : garder par le sujet QUI PART (« Sujet du modèle ») au lieu du sujet
    // LU (""). La garde ne correspondrait jamais à la ligne : l'édition ne gèlerait plus, à aucune passe,
    // et manquerait son heure sans une erreur.
    const { db, vu, ligne, resoudreFlux } = bancContenu(() => {}, { subject: "" });
    const rapport = await silencieux(() => runPlanner(db, { now: MAINTENANT, resoudreFlux }));

    expect(vu.lus).toEqual([{ subject: "", preheader: null, segment_id: "seg_a" }]);
    expect(vu.ok).toEqual([true]);
    expect(rapport.frozen).toBe(1);
    expect(ligne.subject).toBe("Sujet du modèle");
  });
});
