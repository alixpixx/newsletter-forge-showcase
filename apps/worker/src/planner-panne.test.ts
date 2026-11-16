/**
 * Banc de la PANNE PASSAGÈRE au gel : une panne se réessaie, un verdict se retient.
 *
 * ⛔ POURQUOI CE FICHIER EXISTE (25/09/2026). Une édition Northwind Sports a été retenue parce que le site avait
 * mis plus de 10 s à répondre, UNE fois, 90 minutes avant l'envoi. `held` n'est jamais repris (le gel
 * ne relit que `planned`) : une panne de dix secondes coûtait l'édition entière, alors que neuf passes
 * restaient avant l'heure. Les commentaires de `planner.ts` promettaient « la passe suivante
 * réessaiera » ; aucun test ne le vérifiait, et le code faisait l'inverse.
 *
 * Même motif que `planner-brand-partials-cablage.test.ts` : la résolution des flux est INJECTÉE
 * (`resoudreFlux`), aucun `mock.module`.
 */
import { describe, expect, test } from "bun:test";
import { DERNIERE_CHANCE_MS, reessayable, runPlanner, type PlannerOptions } from "./planner";

type Db = Parameters<typeof runPlanner>[0];

const ID_HEADER = "11111111-1111-4111-8111-111111111111";

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

const docPublie = (meta: Record<string, unknown> = {}) => ({
  schema: 2,
  meta: { subject: "Sujet", preheader: "Preheader", assetSlug: "northwind-sports", locale: "pt-BR", ...meta },
  theme: {},
  rows: [{ id: "r_flux", layout: "1", columns: [{ id: "c_flux", blocks: [blocFlux] }] }],
});

const MAINTENANT = new Date("2026-09-25T11:30:00.000Z");
const dans = (minutes: number) => new Date(MAINTENANT.getTime() + minutes * 60_000).toISOString();

const RAISON_SITE = "Northwind Sports did not answer while building this edition — https://www.northwind-sports.example/… n'a pas répondu en 30000 ms";

/** Le site ne répond pas : ce que `resolveFeedsOfDoc` rend quand `resolveFeed` LÈVE. */
const siteMuet: PlannerOptions["resoudreFlux"] = async () => ({ ok: false, reason: RAISON_SITE, retry: true });
/** Un VERDICT sur le contenu (flux sous son plancher) : aucune raison de réessayer. */
const fluxMaigre: PlannerOptions["resoudreFlux"] = async () => ({
  ok: false,
  reason: "only 0 article(s) for \"3 latest from Northwind Sports\" — minimum 1",
});

interface Vu {
  freeze: string[];
  held: { id: string; raison: string }[];
}

function fauxDb(opts: { scheduledAt: string | null; doc?: unknown; partials?: () => Promise<unknown[]> }): { db: Db; vu: Vu } {
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
        scheduled_at: opts.scheduledAt,
        subject: "Giro do Tricolor",
        preheader: null,
        segment_id: null,
        template_version_id: "tv_1",
        duplicate_ack_at: null,
        campaign: { name: "Giro do Tricolor", status: "scheduled", freeze_lead_minutes: 90 },
      },
    ],
    loadPublishedVersion: async () => ({
      id: "tv_1",
      status: "published",
      subject: "Sujet du modèle",
      preheader: "Preheader",
      doc: opts.doc ?? docPublie(),
      html_shell: "<html>{{legal_footer_html}}</html>",
      text_shell: "texte",
      size_bytes: 1234,
      template: { asset_id: "asset_1", archived_at: null },
    }),
    brandPartialsOf: opts.partials ?? (async () => []),
    findLastSettled: async () => null,
    freezeOccurrence: async (id: string) => {
      vu.freeze.push(id);
      return true;
    },
    recordSentArticles: async () => {},
    holdOccurrence: async (id: string, raison: string) => {
      vu.held.push({ id, raison });
    },
  } as unknown as Db;
  return { db, vu };
}

/** Journal intercepté LOCALEMENT (pas de `mock.module`), rendu dans le `finally`. */
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

describe("gel — une PANNE se réessaie à la passe suivante", () => {
  test("⛔ site muet 90 min avant l'envoi : l'édition reste `planned`, rien n'est retenu", async () => {
    const { db, vu } = fauxDb({ scheduledAt: dans(90) });
    const { valeur: report, lignes } = await avecJournal(() =>
      runPlanner(db, { now: MAINTENANT, resoudreFlux: siteMuet }),
    );

    expect(report.errors).toEqual([]);
    expect(vu.held).toEqual([]);
    expect(vu.freeze).toEqual([]);
    expect(report.retrying).toBe(1);
    expect(report.held).toBe(0);
    // La panne ne disparaît pas : elle est au journal, avec sa raison.
    const ligne = lignes.find((l) => l.decision === "retry_next_pass");
    expect(ligne?.reason).toBe(RAISON_SITE);
  });

  test("⛔ site muet à la dernière passe utile : retenue, avec la raison ET le fait qu'on a réessayé", async () => {
    const { db, vu } = fauxDb({ scheduledAt: dans(10) });
    const { valeur: report } = await avecJournal(() => runPlanner(db, { now: MAINTENANT, resoudreFlux: siteMuet }));

    expect(report.errors).toEqual([]);
    expect(report.retrying).toBe(0);
    expect(vu.held).toHaveLength(1);
    expect(vu.held[0]!.raison).toStartWith(RAISON_SITE);
    expect(vu.held[0]!.raison).toContain("last pass before the send time");
  });

  test("un VERDICT (flux sous son plancher) est retenu tout de suite, même 90 min avant", async () => {
    const { db, vu } = fauxDb({ scheduledAt: dans(90) });
    const { valeur: report } = await avecJournal(() => runPlanner(db, { now: MAINTENANT, resoudreFlux: fluxMaigre }));

    expect(report.errors).toEqual([]);
    expect(report.retrying).toBe(0);
    expect(vu.held).toHaveLength(1);
    expect(vu.held[0]!.raison).not.toContain("last pass");
  });

  test("⛔ la lecture de l'en-tête de marque en panne se réessaie aussi", async () => {
    const { db, vu } = fauxDb({
      scheduledAt: dans(90),
      doc: docPublie({ headerPartialId: ID_HEADER }),
      partials: async () => {
        throw new Error("fetch failed");
      },
    });
    const { valeur: report } = await avecJournal(() => runPlanner(db, { now: MAINTENANT, resoudreFlux: siteMuet }));

    expect(report.errors).toEqual([]);
    expect(vu.held).toEqual([]);
    expect(report.retrying).toBe(1);
  });
});

describe("reessayable — la dernière passe utile", () => {
  test("au-delà de la marge : on réessaie ; à la marge pile ou en deçà : non", () => {
    const t = MAINTENANT.getTime();
    expect(reessayable(new Date(t + DERNIERE_CHANCE_MS + 1).toISOString(), MAINTENANT)).toBe(true);
    expect(reessayable(new Date(t + DERNIERE_CHANCE_MS).toISOString(), MAINTENANT)).toBe(false);
    expect(reessayable(new Date(t - 60_000).toISOString(), MAINTENANT)).toBe(false);
  });

  test("sans heure lisible, on ne peut pas savoir s'il reste une passe : non", () => {
    expect(reessayable(null, MAINTENANT)).toBe(false);
    expect(reessayable("pas une date", MAINTENANT)).toBe(false);
  });

  test("la marge laisse au moins une passe `*/10` avant l'envoi", () => {
    expect(DERNIERE_CHANCE_MS).toBeGreaterThan(10 * 60_000);
  });
});
