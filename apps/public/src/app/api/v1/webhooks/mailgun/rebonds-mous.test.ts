/**
 * Rebonds MOUS (migration 0081) — la route du webhook, sur une base EN MÉMOIRE qui garde son état.
 *
 * ⛔ POURQUOI PAS LE DOUBLE À RÉPONSES ORDONNÉES DE `handler.test.ts`. Ce qui se mesure ici se lit
 * sur PLUSIEURS événements : le 4e message supprime parce que les trois premiers sont en base, un
 * rejeu ne compte pas parce que la ligne existe déjà, une livraison efface ce qui précède. Un double
 * qui sert des réponses fixes dirait vert même si le compte ne lisait rien.
 *
 * MUTATIONS QUI DOIVENT LE TUER : compter les événements au lieu des messages ; ignorer la dernière
 * livraison ; seuil à 3 ou à 5 ; ne pas écrire `soft_bounce_count` ; avaler une erreur d'écriture.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { fausseBasePostgrest, type Ligne, type Panne, type Appel } from "@/lib/faux-postgrest";
import { handleMailgunWebhook, SEUIL_REBONDS_MOUS } from "./handler";

const CLE = "cle-de-test-uniquement";
const NOW = 1_789_560_000;
const ASSET = "ed806139-74f6-46e9-9769-7c0bc005789a";
const ADRESSE = "lecteur@example.invalid";
const SUB = "sub-rebonds";

/** Un uuid par message envoyé (le webhook refuse un `outbox_id` qui n'en a pas la forme). */
const O = (i: number) => `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`;

function monter(o: { panne?: (a: Appel) => Panne } = {}) {
  const tables: Record<string, Ligne[]> = {
    email_outbox: [1, 2, 3, 4, 5, 6].map((i) => ({
      id: O(i),
      asset_id: ASSET,
      subscription_id: SUB,
      campaign_id: null,
      occurrence_id: null,
      to_email: ADRESSE,
    })),
    subscription: [{ id: SUB, soft_bounce_count: 0 }],
    email_event: [],
  };
  // ⛔ L'index unique `uq_email_event_provider`, que le double ne connaît pas : un rejeu rend 23505.
  const f = fausseBasePostgrest(tables, {
    panne: (a) => {
      const ins = a.methodes.find((m) => m.m === "insert");
      if (a.cible === "email_event" && ins) {
        const v = ins.args[0] as Ligne;
        if ((tables.email_event ?? []).some((l) => l.provider_event_id === v.provider_event_id)) {
          return { message: "duplicate key value violates unique constraint", code: "23505" } as Panne;
        }
      }
      return o.panne?.(a) ?? null;
    },
  });
  let horloge = NOW - 600;
  const envoyer = async (
    id: string,
    outbox: string,
    event: "failed" | "delivered",
    severity: "temporary" | "permanent" | null = "temporary",
  ) => {
    horloge += 10;
    const token = `tok-${id}-${horloge}`;
    const body = {
      signature: {
        timestamp: String(NOW),
        token,
        signature: createHmac("sha256", CLE).update(`${NOW}${token}`).digest("hex"),
      },
      "event-data": {
        id,
        event,
        ...(severity && event === "failed" ? { severity } : {}),
        timestamp: horloge,
        reason: event === "failed" ? "generic" : undefined,
        "user-variables": { outbox_id: outbox },
        message: { headers: { "message-id": `<${outbox}@mg.example>` } },
      },
    };
    const res = await handleMailgunWebhook(new Request("http://x/webhook", { method: "POST", body: JSON.stringify(body) }), {
      signingKey: CLE,
      getDb: () => f.db as never,
      now: () => NOW,
    });
    return res.status;
  };
  const compteur = () => tables.subscription![0]!.soft_bounce_count;
  const suppressions = () =>
    f.appels.filter((a) => a.cible === "rpc:suppress").map((a) => a.methodes[0]!.args[0] as Record<string, unknown>);
  const mous = () => suppressions().filter((s) => String(s.p_reason).startsWith("soft_bounce:"));
  return { tables, envoyer, compteur, suppressions, mous };
}

describe("rebonds mous : le seuil", () => {
  test("le seuil documenté est 4", () => {
    expect(SEUIL_REBONDS_MOUS).toBe(4);
  });

  test("3 messages en échec temporaire ⇒ compteur à 3, personne n'est supprimé", async () => {
    const m = monter();
    for (const i of [1, 2, 3]) expect(await m.envoyer(`e${i}`, O(i), "failed")).toBe(200);
    expect(m.compteur()).toBe(3);
    expect(m.suppressions()).toHaveLength(0);
  });

  test("le 4e message ⇒ suppression PAR MARQUE, motif soft_bounce:4", async () => {
    const m = monter();
    for (const i of [1, 2, 3, 4]) expect(await m.envoyer(`e${i}`, O(i), "failed")).toBe(200);
    expect(m.compteur()).toBe(4);
    const s = m.mous();
    expect(s).toHaveLength(1);
    expect(s[0]!.p_scope).toBe("asset");
    expect(s[0]!.p_asset_id).toBe(ASSET);
    expect(s[0]!.p_email).toBe(ADRESSE);
    expect(String(s[0]!.p_reason).startsWith("soft_bounce:4:")).toBe(true);
  });
});

describe("rebonds mous : un message compte une fois", () => {
  test("rejeu du même événement + nouvelles tentatives du même message ⇒ compté UNE fois", async () => {
    const m = monter();
    expect(await m.envoyer("e1", O(1), "failed")).toBe(200);
    expect(await m.envoyer("e1", O(1), "failed")).toBe(200); // rejeu : doublon 23505
    expect(await m.envoyer("e1-bis", O(1), "failed")).toBe(200); // Mailgun retente le même message
    expect(await m.envoyer("e1-ter", O(1), "failed")).toBe(200);
    expect(m.compteur()).toBe(1);
    // Contre-épreuve : le rejeu est bien passé par le doublon (3 lignes, pas 4)…
    expect(m.tables.email_event).toHaveLength(3);
    // …et quatre événements sur UN message ne suppriment personne.
    expect(m.suppressions()).toHaveLength(0);
  });

  test("rejeu du 4e message ⇒ le compteur reste à 4, la suppression rejouée ne compte pas plus", async () => {
    const m = monter();
    for (const i of [1, 2, 3, 4]) await m.envoyer(`e${i}`, O(i), "failed");
    expect(await m.envoyer("e4", O(4), "failed")).toBe(200);
    expect(m.compteur()).toBe(4);
    expect(m.mous().every((s) => String(s.p_reason).startsWith("soft_bounce:4:"))).toBe(true);
  });
});

describe("rebonds mous : remise à zéro (tranchée le 24/09/2026)", () => {
  test("une LIVRAISON remet à zéro, et les échecs d'avant ne comptent plus", async () => {
    const m = monter();
    for (const i of [1, 2, 3]) await m.envoyer(`e${i}`, O(i), "failed");
    expect(m.compteur()).toBe(3);
    expect(await m.envoyer("d4", O(4), "delivered", null)).toBe(200);
    expect(m.compteur()).toBe(0);
    expect(await m.envoyer("e5", O(5), "failed")).toBe(200);
    expect(m.compteur()).toBe(1);
    expect(m.suppressions()).toHaveLength(0);
  });

  test("un rebond DUR ne remet PAS à zéro : le message suivant atteint le seuil", async () => {
    const m = monter();
    for (const i of [1, 2, 3]) await m.envoyer(`e${i}`, O(i), "failed");
    expect(await m.envoyer("b4", O(4), "failed", "permanent")).toBe(200);
    expect(m.compteur()).toBe(3);
    // Le rebond dur a suivi SON chemin (motif hard_bounce), pas celui des rebonds mous.
    expect(m.suppressions().map((s) => String(s.p_reason).split(":")[0])).toEqual(["hard_bounce"]);
    expect(await m.envoyer("e5", O(5), "failed")).toBe(200);
    expect(m.compteur()).toBe(4);
    expect(m.mous()).toHaveLength(1);
  });
});

describe("rebonds mous : un échec d'écriture fait REJOUER", () => {
  test("écriture du compteur en panne ⇒ 500 (Mailgun rejoue)", async () => {
    const m = monter({
      panne: (a) => (a.cible === "subscription" && a.methodes.some((x) => x.m === "update") ? { message: "panne" } : null),
    });
    expect(await m.envoyer("e1", O(1), "failed")).toBe(500);
  });

  test("suppression au seuil en panne ⇒ 500, puis le rejeu la réussit", async () => {
    let enPanne = true;
    const m = monter({ panne: (a) => (enPanne && a.cible === "rpc:suppress" ? { message: "panne" } : null) });
    for (const i of [1, 2, 3]) await m.envoyer(`e${i}`, O(i), "failed");
    expect(await m.envoyer("e4", O(4), "failed")).toBe(500);
    enPanne = false;
    expect(await m.envoyer("e4", O(4), "failed")).toBe(200);
    expect(m.compteur()).toBe(4);
    expect(m.mous().length).toBeGreaterThan(0);
  });

  test("remise à zéro en panne sur une livraison ⇒ 500", async () => {
    const m = monter({
      panne: (a) => (a.cible === "subscription" && a.methodes.some((x) => x.m === "update") ? { message: "panne" } : null),
    });
    expect(await m.envoyer("d1", O(1), "delivered", null)).toBe(500);
  });
});
