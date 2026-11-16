/**
 * LA CEINTURE DE L'ARCHIVAGE (0077) — une campagne archivée n'est ni planifiée, ni gelée, ni enfilée.
 *
 * ⛔ POURQUOI UNE CEINTURE. La route d'archivage de l'admin arrête la série et annule ses éditions à
 * venir, ou remet un envoi programmé en brouillon : c'est elle qui ARRÊTE. Mais `archived_at` seul
 * n'arrêtait rien côté worker — le seul interrupteur qu'il respectait était le statut
 * (`campaignCanStillSend`). Une annulation en échec, ou une édition gelée entre la lecture et
 * l'écriture de la route, serait partie d'une campagne rangée dans un onglet que personne ne regarde.
 * Les quatre lectures qui mènent à un envoi refusent donc une campagne archivée, chacune testée ici.
 *
 * ⚠️ AUCUNE ÉCRITURE EN BASE. Le client Supabase est un double qui APPLIQUE les filtres
 * `.is(colonne, null)` aux lignes fabriquées (c'est le filtre de la ceinture côté requête) et
 * enregistre tout le reste. Retirer le filtre de la requête fait donc réapparaître la ligne archivée :
 * le banc mesure l'effet, pas seulement la présence d'un appel.
 */
import { describe, expect, test } from "bun:test";
import { PlannerDb } from "./planner-db";
import { FanoutDb } from "./fanout-db";
import { campaignCanStillSend } from "./campaign-status";

type Appel = { methode: string; args: unknown[] };

function fauxClient(lignes: Record<string, unknown>[]) {
  const appels: Appel[] = [];
  const nuls: string[] = [];
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          const gardees = lignes.filter((l) => nuls.every((col) => l[col] === null || l[col] === undefined));
          return (resoudre: (v: unknown) => void) => resoudre({ data: gardees, error: null, count: null });
        }
        return (...args: unknown[]) => {
          appels.push({ methode: prop, args });
          if (prop === "is" && args[1] === null) nuls.push(String(args[0]));
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  return { sb: proxy, appels };
}

function avecClient<T extends object>(proto: T, lignes: Record<string, unknown>[]) {
  const { sb, appels } = fauxClient(lignes);
  const db = Object.create(proto) as T;
  (db as unknown as { sb: unknown }).sb = sb;
  return { db, appels };
}

const ARCHIVEE = "2026-09-22T18:00:00Z";
const selectDe = (appels: Appel[]) => String(appels.find((a) => a.methode === "select")?.args[0] ?? "");

describe("campaignCanStillSend — le refus partagé, désormais à trois motifs", () => {
  test("une campagne archivée ne peut plus envoyer, quel que soit son statut", () => {
    for (const s of ["draft", "scheduled", "sent", null]) {
      expect(`${s}:${campaignCanStillSend(s, ARCHIVEE)}`).toBe(`${s}:false`);
    }
  });

  test("TÉMOIN — non archivée (null ou colonne absente), le statut seul décide comme avant", () => {
    expect(campaignCanStillSend("draft", null)).toBe(true);
    expect(campaignCanStillSend("draft", undefined)).toBe(true);
    expect(campaignCanStillSend("draft")).toBe(true);
    expect(campaignCanStillSend("paused", null)).toBe(false);
  });
});

describe("planification — listArmedPlans", () => {
  test("⛔ une série archivée n'est pas planifiée, même si son interrupteur était resté allumé", async () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer `.is("archived_at", null)` de `listArmedPlans`.
    const { db, appels } = avecClient(PlannerDb.prototype, [
      { id: "active", archived_at: null },
      { id: "rangee", archived_at: ARCHIVEE },
    ]);
    const plans = await (db as PlannerDb).listArmedPlans();
    expect(plans.map((p) => p.id)).toEqual(["active"]);
    expect(appels.some((a) => a.methode === "is" && a.args[0] === "archived_at" && a.args[1] === null)).toBe(true);
  });
});

/** Une occurrence due au gel (dans 30 min, fenêtre de 90) dont on ne fait varier que la campagne. */
function candidat(id: string, archived_at: string | null) {
  return {
    id,
    campaign_id: `camp_${id}`,
    asset_id: "asset_1",
    scheduled_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    subject: "Sujet",
    preheader: null,
    segment_id: null,
    template_version_id: "ver_1",
    duplicate_ack_at: null,
    campaign: { freeze_lead_minutes: 90, name: "C", status: "draft", archived_at },
  };
}

describe("gel — listOccurrencesToFreeze", () => {
  test("⛔ l'édition d'une campagne archivée n'est pas gelée (ses articles ne sont pas brûlés)", async () => {
    // MUTATION QUI DOIT TUER CE TEST : ne plus passer `archived_at` à `campaignCanStillSend` dans le gel.
    const { db } = avecClient(PlannerDb.prototype, [candidat("a", null), candidat("b", ARCHIVEE)]);
    const gardes = await (db as PlannerDb).listOccurrencesToFreeze(new Date().toISOString());
    expect(gardes.map((r) => r.id)).toEqual(["a"]);
  });

  test("la jointure demande bien `archived_at` à la campagne — sinon le refus ne verrait jamais rien", async () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer `archived_at` du `select` embarqué.
    const { db, appels } = avecClient(PlannerDb.prototype, []);
    await (db as PlannerDb).listOccurrencesToFreeze(new Date().toISOString());
    expect(selectDe(appels)).toMatch(/campaign:campaign_id\([^)]*\barchived_at\b/);
  });
});

describe("mise en file — les DEUX requêtes du fan-out", () => {
  test("⛔ une occurrence gelée d'une campagne archivée n'est pas enfilée", async () => {
    // MUTATION QUI DOIT TUER CE TEST : ne plus passer `archived_at` à `campaignCanStillSend` dans
    // `listDueOccurrences`.
    const occ = (id: string, archived_at: string | null) => ({
      id,
      campaign_id: `camp_${id}`,
      asset_id: "asset_1",
      segment_id: null,
      scheduled_at: "2026-09-22T10:00:00Z",
      recipients_planned: 10,
      campaign: { name: "C", purpose: "content", status: "draft", archived_at },
    });
    const { db, appels } = avecClient(FanoutDb.prototype, [occ("a", null), occ("b", ARCHIVEE)]);
    const cibles = await (db as FanoutDb).listDueOccurrences(new Date("2026-09-22T10:00:00Z"), 0);
    expect(cibles.map((c) => c.occurrenceId)).toEqual(["a"]);
    expect(selectDe(appels)).toMatch(/campaign:campaign_id\([^)]*\barchived_at\b/);
  });

  test("⛔ un envoi unique d'une campagne archivée n'est pas enfilé", async () => {
    // MUTATION QUI DOIT TUER CE TEST : retirer `.is("archived_at", null)` de `listDueCampaigns`.
    const camp = (id: string, archived_at: string | null) => ({
      id,
      asset_id: "asset_1",
      name: id,
      segment_id: null,
      purpose: "content",
      scheduled_at: "2026-09-22T10:00:00Z",
      recipients_planned: 10,
      archived_at,
    });
    const { db } = avecClient(FanoutDb.prototype, [camp("active", null), camp("rangee", ARCHIVEE)]);
    const cibles = await (db as FanoutDb).listDueCampaigns(new Date("2026-09-22T10:00:00Z"), 0);
    expect(cibles.map((c) => c.campaignId)).toEqual(["active"]);
  });
});
