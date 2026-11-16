/**
 * Banc de l'INTRODUCTION ÉCRITE PAR LE MODÈLE, au gel d'une occurrence.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER — trois défauts qui ne s'annoncent pas :
 *  1. **Un appel payant sans usage.** Le modèle n'est appelé que si le contenu figé porte
 *     `{{ai_intro}}` ou `{{ai_preheader}}`. Sinon on paierait un texte que rien n'affiche.
 *  2. **Le faux négatif du repli inline.** `{{ai_intro|Le résumé du jour}}` est le MÊME jeton.
 *     Une détection par recherche de chaîne le manquerait : l'auteur verrait son jeton dans le
 *     modèle, rien ne se générerait, et aucune erreur ne le dirait.
 *  3. **Un envoi bloqué par un service tiers.** Crédit épuisé, refus, timeout : l'occurrence doit
 *     geler quand même, avec `ai_status='failed'` et son motif. Une édition perdue coûte
 *     infiniment plus cher qu'une édition sans son introduction.
 *
 * On mesure ce que `freezeOccurrence` REÇOIT et ce que le client ENVOIE — pas ce que le code a
 * l'air de faire.
 */
import { afterEach, describe, expect, test } from "bun:test";

const { runPlanner } = await import("./planner");
type Db = Parameters<typeof runPlanner>[0];

const vraiFetch = globalThis.fetch;
const vraieCle = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  globalThis.fetch = vraiFetch;
  if (vraieCle === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = vraieCle;
});

/** Un document du builder : `rows` → `columns` → `blocks`, plus le `meta` que porte un vrai doc. */
function doc(blocks: Record<string, unknown>[]) {
  return {
    meta: { subject: "", preheader: "", assetSlug: "quartz-tips", locale: "pt-BR" },
    rows: [{ columns: [{ blocks }] }],
  };
}

const DOC_2_ARTICLES = doc([
  { type: "article", title: "Palmeiras vence o clássico", excerpt: "No Allianz." },
  { type: "article", title: "Segundo texto", excerpt: "" },
]);

interface Capture {
  freeze: { id: string; patch: Record<string, unknown> }[];
  held: { id: string; raison: string }[];
}

function fauxDb(htmlShell: string, sujet: string | null): { db: Db; vu: Capture } {
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
        subject: sujet,
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
      doc: DOC_2_ARTICLES,
      html_shell: htmlShell,
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

/** Remplace `fetch` par un double qui compte les appels et retient ce qui a été envoyé. */
function interceptFetch(preheader = "Accroche du jour", intro = "Trois phrases d'introduction.") {
  const vu: { appels: number; body?: any } = { appels: 0 };
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    vu.appels += 1;
    vu.body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({
        model: "modele-de-test",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify({ preheader, intro }) }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return vu;
}

const MAINTENANT = { now: new Date("2026-09-06T09:00:00.000Z") };

describe("gel — introduction écrite par le modèle", () => {
  test("⛔ sans jeton IA, AUCUN appel n'est fait et aucune colonne ai_* n'est écrite", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    const reseau = interceptFetch();
    const { db, vu } = fauxDb("<html>{{legal_footer_html}}</html>", "Sujet fixe");
    await runPlanner(db, MAINTENANT);

    expect(reseau.appels).toBe(0);
    expect(vu.freeze).toHaveLength(1);
    // Absentes, pas nulles : un NULL se lirait comme « la génération a échoué ».
    expect(vu.freeze[0]!.patch).not.toHaveProperty("ai_status");
    expect(vu.freeze[0]!.patch).not.toHaveProperty("ai_intro");
  });

  test("le jeton dans le HTML déclenche la génération et les colonnes sont écrites", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    const reseau = interceptFetch();
    const { db, vu } = fauxDb("<html><p>{{ai_intro}}</p></html>", "Sujet fixe");
    await runPlanner(db, MAINTENANT);

    expect(reseau.appels).toBe(1);
    const p = vu.freeze[0]!.patch;
    expect(p.ai_status).toBe("ok");
    expect(p.ai_intro).toBe("Trois phrases d'introduction.");
    expect(p.ai_preheader).toBe("Accroche du jour");
    expect(p.ai_model).toBe("modele-de-test");
    expect(p.ai_reason).toBeNull();
    expect(typeof p.ai_generated_at).toBe("string");
  });

  test("⛔ un repli inline est le MÊME jeton — il déclenche aussi la génération", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    const reseau = interceptFetch();
    const { db } = fauxDb("<html><p>{{ai_intro|Le résumé du jour}}</p></html>", "Sujet fixe");
    await runPlanner(db, MAINTENANT);

    expect(reseau.appels).toBe(1);
  });

  test("le jeton dans le SUJET déclenche aussi la génération, et le sujet gelé le garde intact", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    const reseau = interceptFetch();
    const { db, vu } = fauxDb("<html>rien</html>", "{{ai_preheader}}");
    await runPlanner(db, MAINTENANT);

    expect(reseau.appels).toBe(1);
    // Le jeton reste : la valeur est hydratée au drain, donc corrigeable jusqu'à l'envoi.
    expect(vu.freeze[0]!.patch.subject).toBe("{{ai_preheader}}");
  });

  test("le modèle reçoit les titres RÉELS de l'édition, avec sa langue", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    const reseau = interceptFetch();
    const { db } = fauxDb("<html><p>{{ai_intro}}</p></html>", "Sujet fixe");
    await runPlanner(db, MAINTENANT);

    const envoye = String(reseau.body.messages[0].content[0].text);
    expect(envoye).toContain("1. Palmeiras vence o clássico — No Allianz.");
    expect(envoye).toContain("2. Segundo texto");
    expect(envoye).toContain("Language: pt-BR");
    expect(envoye).toContain("Headlines in this edition (2)");
  });

  /** ⛔ LA GARANTIE CENTRALE : un service tiers en panne ne fait pas perdre une édition. */
  test("⛔ le modèle indisponible n'empêche PAS le gel — l'édition part sans son introduction", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { db, vu } = fauxDb("<html><p>{{ai_intro}}</p></html>", "Sujet fixe");
    await runPlanner(db, MAINTENANT);

    expect(vu.held).toHaveLength(0);
    expect(vu.freeze).toHaveLength(1);
    const p = vu.freeze[0]!.patch;
    expect(p.ai_status).toBe("failed");
    expect(p.ai_intro).toBeNull();
    // Sans motif écrit, l'écran dirait « échec » sans jamais pouvoir dire pourquoi.
    expect(String(p.ai_reason)).toContain("not_configured");
  });

  test("un refus du modèle gèle aussi, avec son motif", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ model: "m", stop_reason: "refusal", stop_details: { category: "x" }, content: [] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const { db, vu } = fauxDb("<html><p>{{ai_intro}}</p></html>", "Sujet fixe");
    await runPlanner(db, MAINTENANT);

    expect(vu.freeze).toHaveLength(1);
    expect(vu.freeze[0]!.patch.ai_status).toBe("failed");
    expect(String(vu.freeze[0]!.patch.ai_reason)).toContain("refusal");
  });

  test("⛔ une passe de SIMULATION ne dépense rien", async () => {
    process.env.ANTHROPIC_API_KEY = "cle-de-test";
    const reseau = interceptFetch();
    const { db, vu } = fauxDb("<html><p>{{ai_intro}}</p></html>", "Sujet fixe");
    await runPlanner(db, { ...MAINTENANT, simulate: true });

    expect(reseau.appels).toBe(0);
    expect(vu.freeze).toHaveLength(0);
  });
});
