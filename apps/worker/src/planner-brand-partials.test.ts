/**
 * Banc du BRANCHEMENT de l'en-tête de marque dans le matérialiseur.
 *
 * ⛔ CE QUI EST MESURÉ ICI N'EST PAS LA LOGIQUE (elle a son propre banc, `brand-partials.test.ts`)
 * MAIS L'EFFET SUR L'OCCURRENCE : l'édition est-elle RETENUE, et l'a-t-on retenue AVANT de dépenser
 * un aller-retour WordPress ? Un module pur parfait branché nulle part ne protège rien — c'est
 * exactement l'état dans lequel la fondation header/footer dormait depuis le 14/09.
 *
 * Le témoin de l'ordre est `loadWpSource` : c'est le premier geste de la résolution des flux. S'il
 * a été appelé alors que l'en-tête était introuvable, c'est que la garde mord trop tard.
 */
import { describe, expect, test } from "bun:test";

const { runPlanner } = await import("./planner");
type Db = Parameters<typeof runPlanner>[0];

const ID_HEADER = "11111111-1111-4111-8111-111111111111";

/** Un document à FLUX : c'est le seul cas où le worker recompile, donc le seul qui nous concerne. */
const docAvecFlux = (meta: Record<string, unknown>) => ({
  meta,
  rows: [
    {
      id: "r1",
      layout: "1",
      columns: [{ id: "c1", blocks: [{ id: "f1", type: "article-feed", sourceId: "src_1", count: 3 }] }],
    },
  ],
});

const rowTexte = (id: string, texte: string) => ({
  id,
  layout: "1",
  columns: [
    { id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: texte }] }] }] },
  ],
});

interface Vu {
  held: { id: string; raison: string }[];
  freeze: number;
  appelsWordpress: number;
  demandesPartials: { assetId: string; ids: readonly string[] }[];
}

function fauxDb(opts: {
  doc: unknown;
  partials?: unknown[];
  lectureLeve?: boolean;
}): { db: Db; vu: Vu } {
  const vu: Vu = { held: [], freeze: 0, appelsWordpress: 0, demandesPartials: [] };
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
        campaign: { name: "Resumo", status: "scheduled", freeze_lead_minutes: 90 },
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
    brandPartialsOf: async (assetId: string, ids: readonly string[]) => {
      vu.demandesPartials.push({ assetId, ids });
      if (opts.lectureLeve) throw new Error("brandPartialsOf: connexion refusée");
      return opts.partials ?? [];
    },
    // Témoin d'ordre : premier geste de la résolution des flux.
    loadWpSource: async () => {
      vu.appelsWordpress += 1;
      return null;
    },
    findLastSettled: async () => null,
    freezeOccurrence: async () => {
      vu.freeze += 1;
      return true;
    },
    recordSentArticles: async () => {},
    holdOccurrence: async (id: string, raison: string) => {
      vu.held.push({ id, raison });
    },
  } as unknown as Db;
  return { db, vu };
}

const MAINTENANT = new Date("2026-09-06T09:00:00.000Z");

describe("matérialiseur — l'en-tête de marque d'une édition à flux", () => {
  test("⛔ un pointeur introuvable RETIENT l'édition, au lieu de la compiler sans en-tête", async () => {
    const { db, vu } = fauxDb({ doc: docAvecFlux({ headerPartialId: ID_HEADER }), partials: [] });
    await runPlanner(db, { now: MAINTENANT });

    expect(vu.freeze).toBe(0);
    expect(vu.held).toHaveLength(1);
    expect(vu.held[0]!.raison).toContain("brand header");
  });

  test("⛔ et elle est retenue AVANT le premier aller-retour WordPress", async () => {
    // Dépenser les articles du jour pour une édition qu'on va retenir trois lignes plus loin les
    // brûlerait pour rien : ils sont mémorisés comme « déjà envoyés ».
    const { db, vu } = fauxDb({ doc: docAvecFlux({ headerPartialId: ID_HEADER }), partials: [] });
    await runPlanner(db, { now: MAINTENANT });

    expect(vu.appelsWordpress).toBe(0);
    expect(vu.demandesPartials).toHaveLength(1);
    expect(vu.demandesPartials[0]!.assetId).toBe("asset_1");
    expect(vu.demandesPartials[0]!.ids).toEqual([ID_HEADER]);
  });

  test("⛔ une LECTURE EN PANNE retient aussi — elle ne vaut pas « ce modèle n'a pas d'en-tête »", async () => {
    const { db, vu } = fauxDb({ doc: docAvecFlux({ headerPartialId: ID_HEADER }), lectureLeve: true });
    // ⚠️ À LA DERNIÈRE PASSE UTILE (10 min avant l'envoi). Plus tôt, une panne n'est plus retenue :
    // l'édition reste `planned` et la passe suivante réessaie (25/09/2026, `planner-panne.test.ts`).
    await runPlanner(db, { now: new Date("2026-09-06T09:50:00.000Z") });

    expect(vu.freeze).toBe(0);
    expect(vu.appelsWordpress).toBe(0);
    /*
     * ⛔ L'ASSERTION PORTE SUR LA PANNE ELLE-MÊME, et une passe de mutation a montré pourquoi :
     * `toContain("could not be read")` est vraie AUSSI du message de pointeur manquant, si bien
     * qu'un mutant supprimant ce `catch` restait vert. Les deux chemins retiennent, mais ils ne se
     * réparent pas au même endroit — l'un dit de regarder la base, l'autre de regarder le modèle.
     */
    expect(vu.held[0]!.raison).toContain("connexion refusée");
    expect(vu.held[0]!.raison).toContain("last pass before the send time");
  });

  test("⛔ un pointeur MAL FORMÉ retient sans interroger la base — et surtout, la garde s'applique", async () => {
    /*
     * Le piège que ce test ferme : filtrer les pointeurs illisibles AVANT de décider s'il y a
     * quelque chose à résoudre ferait sortir ce document sans garde, donc partir sans en-tête.
     * C'est le document qui dit qu'une fente doit être honorée, pas la liste des ids lisibles.
     */
    const { db, vu } = fauxDb({ doc: docAvecFlux({ headerPartialId: "pas-un-uuid" }) });
    await runPlanner(db, { now: MAINTENANT });

    expect(vu.demandesPartials).toHaveLength(0);
    expect(vu.freeze).toBe(0);
    expect(vu.held).toHaveLength(1);
    expect(vu.held[0]!.raison).toContain("brand header");
    expect(vu.appelsWordpress).toBe(0);
  });

  test("un partial de la MAUVAISE FENTE ne se pose pas en haut : l'édition est retenue", async () => {
    const { db, vu } = fauxDb({
      doc: docAvecFlux({ headerPartialId: ID_HEADER }),
      partials: [{ id: ID_HEADER, slot: "footer", rows: [rowTexte("pied", "mentions")] }],
    });
    await runPlanner(db, { now: MAINTENANT });

    expect(vu.freeze).toBe(0);
    expect(vu.held[0]!.raison).toContain("brand header");
  });

  test("sans pointeur, la garde ne mord pas : la résolution des flux a bien lieu", async () => {
    // Le pendant obligatoire des tests ci-dessus : une garde qui retient TOUT protégerait aussi,
    // et casserait toutes les newsletters hebdomadaires qui n'ont pas d'en-tête partagé.
    const { db, vu } = fauxDb({ doc: docAvecFlux({}) });
    await runPlanner(db, { now: MAINTENANT });

    expect(vu.demandesPartials).toHaveLength(0);
    expect(vu.appelsWordpress).toBeGreaterThan(0);
  });

  test("un pointeur résolu laisse l'édition suivre son cours normal", async () => {
    const { db, vu } = fauxDb({
      doc: docAvecFlux({ headerPartialId: ID_HEADER }),
      partials: [{ id: ID_HEADER, slot: "header", rows: [rowTexte("pf_head", "Copper Kettle")] }],
    });
    await runPlanner(db, { now: MAINTENANT });

    expect(vu.demandesPartials).toHaveLength(1);
    // La garde a laissé passer : la suite du gel se joue sur les flux, pas sur l'en-tête.
    expect(vu.appelsWordpress).toBeGreaterThan(0);
    expect(vu.held.map((h) => h.raison).join(" ")).not.toContain("brand header");
  });
});
