/**
 * `Db` — ce que le worker demande à la base, mesuré sans base.
 *
 * ⚠️ AUCUNE ÉCRITURE EN BASE. Le client Supabase est remplacé par un double qui rend des réponses
 * programmées DANS L'ORDRE et enregistre chaque appel : un test vérifie la requête partie, pas
 * seulement le résultat. Même méthode que `planner-db.test.ts` — jamais `mock.module`, qui fuit
 * d'un fichier de test à l'autre.
 *
 * Ce qui compte ici : une erreur de lecture LÈVE (jamais un faux « rien à faire » ni un faux
 * « lien valide »), les lots vides ne font aucun appel, le dry-run ne touche à aucune RPC
 * d'écriture, et les messages d'erreur sont tronqués avant de partir.
 */
import { describe, expect, test } from "bun:test";
import { Db } from "./db";

type Reponse = { data?: unknown; error?: { message: string; code?: string } | null };

function dbAvec(...reponses: Reponse[]) {
  const appels: { methode: string; args: unknown[] }[] = [];
  const file = [...reponses];
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          const r = file.shift();
          if (!r) throw new Error("réponse non programmée");
          return (resoudre: (v: unknown) => void) => resoudre({ data: r.data ?? null, error: r.error ?? null });
        }
        return (...args: unknown[]) => {
          appels.push({ methode: prop, args });
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  const db = Object.create(Db.prototype) as Db;
  (db as unknown as { sb: unknown }).sb = proxy;
  return { db, appels, restantes: () => file.length };
}

const panne = { error: { message: "boom" } };
const long = "x".repeat(800);

describe("claim", () => {
  test("appelle claim_outbox avec ses trois paramètres et rend les ids", async () => {
    const { db, appels } = dbAvec({ data: [{ id: "a" }, { id: "b" }] });
    expect(await db.claim("w1", 25, 300)).toEqual(["a", "b"]);
    expect(appels).toEqual([{ methode: "rpc", args: ["claim_outbox", { p_worker: "w1", p_batch: 25, p_stale_seconds: 300 }] }]);
  });

  test("data nulle ⇒ lot vide", async () => {
    const { db } = dbAvec({ data: null });
    expect(await db.claim("w1", 25, 300)).toEqual([]);
  });

  test("erreur ⇒ lève, jamais un lot vide qui passerait pour « rien à envoyer »", async () => {
    const { db } = dbAvec(panne);
    await expect(db.claim("w1", 25, 300)).rejects.toThrow("claim_outbox: boom");
  });
});

describe("claimInteractive (0073)", () => {
  /** MUTATION QUI DOIT LE TUER : appeler `claim_outbox` — la file commune, newsletters comprises. */
  test("appelle claim_outbox_interactive avec ses trois paramètres et rend les ids", async () => {
    const { db, appels } = dbAvec({ data: [{ id: "c" }] });
    expect(await db.claimInteractive("w1", 10, 900)).toEqual(["c"]);
    expect(appels).toEqual([
      { methode: "rpc", args: ["claim_outbox_interactive", { p_worker: "w1", p_batch: 10, p_stale_seconds: 900 }] },
    ]);
  });

  test("erreur ⇒ lève (la boucle retombe alors sur la file commune)", async () => {
    const { db } = dbAvec(panne);
    await expect(db.claimInteractive("w1", 10, 900)).rejects.toThrow("claim_outbox_interactive: boom");
  });
});

describe("fetchContext", () => {
  test("aucun id ⇒ aucun appel", async () => {
    const { db, appels } = dbAvec();
    expect(await db.fetchContext([])).toEqual([]);
    expect(appels).toEqual([]);
  });

  test("lit la vue outbox_context filtrée sur les ids", async () => {
    const { db, appels } = dbAvec({ data: [{ id: "a" }] });
    expect(await db.fetchContext(["a"])).toEqual([{ id: "a" }] as never);
    expect(appels).toEqual([
      { methode: "from", args: ["outbox_context"] },
      { methode: "select", args: ["*"] },
      { methode: "in", args: ["id", ["a"]] },
    ]);
  });

  test("erreur ⇒ lève", async () => {
    const { db } = dbAvec(panne);
    await expect(db.fetchContext(["a"])).rejects.toThrow("fetchContext: boom");
  });
});

describe("peekPending (dry-run)", () => {
  test("lecture seule des pending, les plus anciennes d'abord, sans aucune RPC", async () => {
    const { db, appels } = dbAvec({ data: [] });
    await db.peekPending(10);
    expect(appels).toEqual([
      { methode: "from", args: ["outbox_context"] },
      { methode: "select", args: ["*"] },
      { methode: "eq", args: ["status", "pending"] },
      { methode: "order", args: ["created_at", { ascending: true }] },
      { methode: "limit", args: [10] },
    ]);
  });

  test("erreur ⇒ lève", async () => {
    const { db } = dbAvec(panne);
    await expect(db.peekPending(10)).rejects.toThrow("peekPending: boom");
  });
});

describe("etatLienConfirmation", () => {
  const NOW = new Date("2026-09-16T12:00:00Z");

  test("sans souscription ⇒ absent, sans lire la base", async () => {
    const { db, appels } = dbAvec();
    expect(await db.etatLienConfirmation(null, NOW)).toBe("absent");
    expect(appels).toEqual([]);
  });

  test("lit le DERNIER jeton de la souscription", async () => {
    const { db, appels } = dbAvec({ data: { expires_at: "2026-09-17T12:00:00Z", confirmed_at: null } });
    expect(await db.etatLienConfirmation("s1", NOW)).toBe("valide");
    expect(appels).toEqual([
      { methode: "from", args: ["doi_token"] },
      { methode: "select", args: ["expires_at, confirmed_at"] },
      { methode: "eq", args: ["subscription_id", "s1"] },
      { methode: "order", args: ["created_at", { ascending: false }] },
      { methode: "limit", args: [1] },
      { methode: "maybeSingle", args: [] },
    ]);
  });

  test("l'horloge injectée fait foi : jeton échu à NOW ⇒ expire", async () => {
    const { db } = dbAvec({ data: { expires_at: "2026-09-16T11:59:59Z", confirmed_at: null } });
    expect(await db.etatLienConfirmation("s1", NOW)).toBe("expire");
  });

  test("aucun jeton ⇒ absent", async () => {
    const { db } = dbAvec({ data: null });
    expect(await db.etatLienConfirmation("s1", NOW)).toBe("absent");
  });

  test("erreur ⇒ lève, jamais « valide » ni « expire »", async () => {
    const { db } = dbAvec(panne);
    await expect(db.etatLienConfirmation("s1", NOW)).rejects.toThrow("etatLienConfirmation: boom");
  });
});

describe("écritures de statut", () => {
  test("markSent transmet l'identifiant tel quel", async () => {
    const { db, appels } = dbAvec({});
    await db.markSent("o1", "abc@mg.example");
    expect(appels).toEqual([{ methode: "rpc", args: ["outbox_mark_sent", { p_id: "o1", p_provider_message_id: "abc@mg.example" }] }]);
  });

  test.each([true, false])("markSent mémorise le suivi (%p) par la surcharge à 3 arguments, en UN appel", async (suivi) => {
    const { db, appels, restantes } = dbAvec({});
    await db.markSent("o1", "m", suivi);
    expect(appels).toEqual([
      { methode: "rpc", args: ["outbox_mark_sent", { p_id: "o1", p_provider_message_id: "m", p_tracked: suivi }] },
    ]);
    expect(restantes()).toBe(0);
  });

  /*
   * ⛔ Le message est DÉJÀ parti : une ligne laissée `sending` serait RENVOYÉE par `claim_outbox`.
   * Surcharge inconnue (0085 absente, cache de l'API pas rechargé) ⇒ l'appel d'origine, sans la mesure.
   */
  test.each(["PGRST202", "42883"])("surcharge absente (%s) ⇒ repli sur l'appel d'origine, qui marque envoyé", async (code) => {
    const { db, appels, restantes } = dbAvec({ error: { message: "Could not find the function", code } }, {});
    await db.markSent("o1", "m", true);
    expect(appels).toEqual([
      { methode: "rpc", args: ["outbox_mark_sent", { p_id: "o1", p_provider_message_id: "m", p_tracked: true }] },
      { methode: "rpc", args: ["outbox_mark_sent", { p_id: "o1", p_provider_message_id: "m" }] },
    ]);
    expect(restantes()).toBe(0);
  });

  test("autre erreur sur la surcharge ⇒ lève, sans second appel (comportement d'avant 0085)", async () => {
    const { db, appels } = dbAvec({ error: { message: "boom", code: "08006" } });
    await expect(db.markSent("o1", "m", true)).rejects.toThrow("outbox_mark_sent: boom");
    expect(appels).toHaveLength(1);
  });

  test("repli qui échoue aussi ⇒ lève", async () => {
    const { db } = dbAvec({ error: { message: "absente", code: "PGRST202" } }, panne);
    await expect(db.markSent("o1", "m", false)).rejects.toThrow("outbox_mark_sent: boom");
  });

  test("markFailed tronque l'erreur à 500 caractères", async () => {
    const { db, appels } = dbAvec({});
    await db.markFailed("o1", long, true);
    expect(appels).toEqual([{ methode: "rpc", args: ["outbox_mark_failed", { p_id: "o1", p_error: "x".repeat(500), p_retryable: true }] }]);
  });

  test("markSkipped tronque la raison à 500 caractères", async () => {
    const { db, appels } = dbAvec({});
    await db.markSkipped("o1", long);
    expect(appels).toEqual([{ methode: "rpc", args: ["outbox_mark_skipped", { p_id: "o1", p_reason: "x".repeat(500) }] }]);
  });

  test("release sans id ⇒ aucun appel ; avec ids ⇒ outbox_release", async () => {
    const vide = dbAvec();
    await vide.db.release([]);
    expect(vide.appels).toEqual([]);
    const plein = dbAvec({});
    await plein.db.release(["a", "b"]);
    expect(plein.appels).toEqual([{ methode: "rpc", args: ["outbox_release", { p_ids: ["a", "b"] }] }]);
  });

  test.each([
    ["markSent", (db: Db) => db.markSent("o1", "m"), "outbox_mark_sent: boom"],
    ["markFailed", (db: Db) => db.markFailed("o1", "e", false), "outbox_mark_failed: boom"],
    ["markSkipped", (db: Db) => db.markSkipped("o1", "r"), "outbox_mark_skipped: boom"],
    ["release", (db: Db) => db.release(["a"]), "outbox_release: boom"],
  ] as const)("%s : erreur ⇒ lève", async (_nom, appel, message) => {
    const { db } = dbAvec(panne);
    await expect(appel(db)).rejects.toThrow(message);
  });
});
