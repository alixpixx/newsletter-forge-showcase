/**
 * Banc du GEL : ce que l'occurrence retient de l'édition qu'elle fige.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. Les colonnes `first_article_title` / `article_count`
 * (migration 0050) ne servent à rien si personne ne les écrit : une colonne qu'aucun code
 * n'alimente n'existe pas, et le sujet retomberait sur un repli vide sans qu'aucune erreur ne le
 * dise. On mesure donc ce que `freezeOccurrence` REÇOIT, pas ce que le code a l'air de faire.
 *
 * Second point mesuré : le sujet gelé garde `{{first_article}}` INTACT. La substitution littérale
 * qui existait ici figeait le titre en dur ; la corriger après le gel ne corrigeait plus rien.
 */
import { describe, expect, test } from "bun:test";

const { runPlanner, countArticles, firstArticleTitle } = await import("./planner");
type Db = Parameters<typeof runPlanner>[0];

/** Un document du builder : `rows` → `columns` → `blocks`. */
function doc(blocks: Record<string, unknown>[]) {
  return { rows: [{ columns: [{ blocks }] }] };
}

/** Trois articles, AUCUN bloc flux : le gel n'appelle donc ni WordPress ni MJML. */
const DOC_3_ARTICLES = doc([
  { type: "article", title: "Palmeiras vence o clássico" },
  { type: "article", title: "Segundo texto" },
  { type: "article", title: "Terceiro texto" },
]);
const DOC_SANS_ARTICLE = doc([{ type: "text", value: "rien" }]);

interface Capture {
  freeze: { id: string; patch: Record<string, unknown> }[];
  held: { id: string; raison: string }[];
}

function fauxDb(docPublie: unknown, sujetOccurrence: string | null): { db: Db; vu: Capture } {
  const vu: Capture = { freeze: [], held: [] };
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
        subject: sujetOccurrence,
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
      preheader: "Preheader du modèle",
      doc: docPublie,
      html_shell: "<html>{{legal_footer_html}}</html>",
      text_shell: "texte",
      size_bytes: 1234,
      template: { asset_id: "asset_1", archived_at: null },
    }),
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

describe("gel d'une occurrence", () => {
  test("⛔ l'article de tête et le nombre d'articles sont ÉCRITS sur l'occurrence", async () => {
    const { db, vu } = fauxDb(DOC_3_ARTICLES, "{{first_article}} et {{article_count}} autres");
    await runPlanner(db, { now: new Date("2026-09-06T09:00:00.000Z") });

    expect(vu.freeze).toHaveLength(1);
    expect(vu.freeze[0]!.patch.first_article_title).toBe("Palmeiras vence o clássico");
    expect(vu.freeze[0]!.patch.article_count).toBe(3);
  });

  test("⛔ le sujet gelé garde le jeton, il n'est plus substitué en dur", async () => {
    const { db, vu } = fauxDb(DOC_3_ARTICLES, "{{first_article}} — l'essentiel");
    await runPlanner(db, { now: new Date("2026-09-06T09:00:00.000Z") });

    expect(vu.freeze[0]!.patch.subject).toBe("{{first_article}} — l'essentiel");
  });

  /**
   * ⛔ LA GARDE RESTE. Sans elle, un sujet qui promet un titre partirait amputé : le jeton vide
   * s'efface en silence et « — l'essentiel » arriverait dans la boîte de réception.
   */
  test("un sujet qui promet un titre retient l'édition quand il n'y a aucun article", async () => {
    const { db, vu } = fauxDb(DOC_SANS_ARTICLE, "{{first_article}} !");
    await runPlanner(db, { now: new Date("2026-09-06T09:00:00.000Z") });

    expect(vu.freeze).toHaveLength(0);
    expect(vu.held).toHaveLength(1);
    expect(vu.held[0]!.raison).toContain("{{first_article}}");
  });

  /**
   * Sans le jeton dans le sujet, une édition sans article se gèle normalement — et annonce
   * honnêtement zéro article. C'est le pendant du test précédent : la garde ne doit pas mordre
   * là où rien n'a été promis.
   */
  test("sans le jeton, une édition sans article passe et compte zéro", async () => {
    const { db, vu } = fauxDb(DOC_SANS_ARTICLE, "Sujet fixe");
    await runPlanner(db, { now: new Date("2026-09-06T09:00:00.000Z") });

    expect(vu.held).toHaveLength(0);
    expect(vu.freeze[0]!.patch.article_count).toBe(0);
    expect(vu.freeze[0]!.patch.first_article_title).toBeNull();
  });
});

describe("countArticles", () => {
  test("compte les blocs article du document déplié, à n'importe quelle profondeur", () => {
    expect(countArticles(DOC_3_ARTICLES)).toBe(3);
    expect(countArticles({ rows: [{ cols: [{ blocks: [{ type: "article", title: "A" }] }] }] })).toBe(1);
    expect(countArticles(DOC_SANS_ARTICLE)).toBe(0);
    expect(countArticles(null)).toBe(0);
  });

  /**
   * ⛔ Un article sans titre COMPTE quand même : il est dans l'édition. C'est `firstArticleTitle`
   * qui exige un titre, parce qu'elle doit en imprimer un. Confondre les deux ferait annoncer
   * « 2 articles » pour une édition qui en porte trois.
   */
  test("un article sans titre compte, mais ne peut pas être l'article de tête", () => {
    const d = doc([{ type: "article", title: "  " }, { type: "article", title: "Vrai titre" }]);
    expect(countArticles(d)).toBe(2);
    expect(firstArticleTitle(d)).toBe("Vrai titre");
  });
});
