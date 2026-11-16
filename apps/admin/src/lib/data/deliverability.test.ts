/**
 * Délivrabilité — la lecture et les verdicts, sans base.
 *
 * Ce qui compte : une réponse incomplète est ILLISIBLE (jamais des zéros), une panne garde sa raison,
 * le seuil de plainte se juge sur les remises, et zéro plainte sur un petit volume n'est pas « sain ».
 */
import { describe, expect, test } from "bun:test";
import {
  COMPLAINT_THRESHOLD,
  MIN_DELIVERED_FOR_VERDICT,
  complaintVerdict,
  getDeliverability,
  parseDayWindow,
  parseDeliverability,
  part,
  pct,
  reasonLabel,
} from "./deliverability";

/** Réponse relevée sur la base le 16/09/2026 (Copper Kettle, 30 jours), réduite. */
const REPONSE = {
  days: 30,
  since: "2026-08-18T00:00:00+00:00",
  measured_at: "2026-09-16T17:01:56+00:00",
  sending_subdomain: "news.copper-kettle.example",
  totals: { sent: 5, delivered: 5, bounced: 0, soft_failed: 0, no_outcome: 0, complained: 0, unsubscribed: 0, opened: 0, clicked: 0 },
  daily: [{ day: "2026-09-16", sent: 5, delivered: 5, bounced: 0, complained: 0 }],
  by_send: [
    { campaign_id: null, kind: "confirmation", name: null, sent: 4, delivered: 4, bounced: 0, complained: 0, unsubscribed: 0, last_sent_at: "2026-09-16T09:51:14Z" },
  ],
  queue: { pending: 0, sending: 0, oldest_pending: null },
  not_sent: [{ status: "skipped", reason: "stale_outbox", count: 4 }],
  suppressions: [],
  global_suppressions: 1,
  unlinked_events: 1,
};

describe("parseDeliverability", () => {
  test("la réponse réelle est lue telle quelle", () => {
    const d = parseDeliverability(REPONSE)!;
    expect(d.totals).toEqual({ sent: 5, delivered: 5, bounced: 0, softFailed: 0, noOutcome: 0, complained: 0, unsubscribed: 0, opened: 0, clicked: 0 });
    expect(d.bySend[0]).toMatchObject({ campaignId: null, kind: "confirmation", sent: 4 });
    expect(d.notSent).toEqual([{ status: "skipped", reason: "stale_outbox", count: 4 }]);
    expect(d.queue).toEqual({ pending: 0, sending: 0, oldestPending: null });
    expect(d.sendingSubdomain).toBe("news.copper-kettle.example");
    expect(d.unlinkedEvents).toBe(1);
  });

  test("un total absent rend TOUT illisible, jamais un zéro", () => {
    const { sent: _retire, ...sansSent } = REPONSE.totals;
    expect(parseDeliverability({ ...REPONSE, totals: sansSent })).toBeNull();
  });

  const illisibles: [string, unknown][] = [
    ["pas un objet", null],
    ["liste au lieu d'objet", []],
    ["compteur en texte", { ...REPONSE, global_suppressions: "1" }],
    ["compteur négatif", { ...REPONSE, unlinked_events: -1 }],
    ["série absente", { ...REPONSE, daily: undefined }],
    ["jour sans date", { ...REPONSE, daily: [{ sent: 1, delivered: 1, bounced: 0, complained: 0 }] }],
    ["file absente", { ...REPONSE, queue: null }],
    ["horodatage absent", { ...REPONSE, measured_at: undefined }],
  ];
  for (const [nom, raw] of illisibles) {
    test(`${nom} ⇒ illisible`, () => {
      expect(parseDeliverability(raw)).toBeNull();
    });
  }
});

describe("getDeliverability", () => {
  const db = (data: unknown, error: { message: string } | null = null) => {
    const appels: unknown[][] = [];
    return {
      appels,
      rpc: (fn: string, args: Record<string, unknown>) => {
        appels.push([fn, args]);
        return Promise.resolve({ data, error });
      },
    };
  };

  test("appelle la RPC avec la marque et la fenêtre", async () => {
    const d = db(REPONSE);
    const r = await getDeliverability(d, "a1", 7);
    expect(r.known).toBe(true);
    expect(d.appels).toEqual([["deliverability_summary", { p_asset_id: "a1", p_days: 7 }]]);
  });

  test("sans marque ⇒ aucune lecture", async () => {
    const d = db(REPONSE);
    expect(await getDeliverability(d, null, 30)).toEqual({ known: false, reason: "no brand selected" });
    expect(d.appels).toEqual([]);
  });

  test("fonction absente ⇒ nomme la migration 0069", async () => {
    const r = await getDeliverability(db(null, { message: "Could not find the function newsletter.deliverability_summary" }), "a1", 30);
    expect(r).toEqual({ known: false, reason: "migration 0069 has not been applied" });
  });

  test("autre erreur ⇒ sa raison, pas des zéros", async () => {
    expect(await getDeliverability(db(null, { message: "timeout" }), "a1", 30)).toEqual({ known: false, reason: "timeout" });
  });

  test("forme inattendue ⇒ illisible", async () => {
    const r = await getDeliverability(db({ days: 30 }), "a1", 30);
    expect(r.known).toBe(false);
  });
});

describe("verdict de plainte", () => {
  test("le seuil minimal de volume est celui où UNE plainte passe sous 0,3 %", () => {
    expect(1 / MIN_DELIVERED_FOR_VERDICT).toBeLessThanOrEqual(COMPLAINT_THRESHOLD);
    expect(1 / (MIN_DELIVERED_FOR_VERDICT - 1)).toBeGreaterThan(COMPLAINT_THRESHOLD);
  });

  test("aucune remise ⇒ no-data", () => {
    expect(complaintVerdict({ delivered: 0, complained: 0 })).toBe("no-data");
  });

  test("zéro plainte sur 5 remises ⇒ thin, pas ok", () => {
    expect(complaintVerdict({ delivered: 5, complained: 0 })).toBe("thin");
  });

  test("une plainte sur 5 remises ⇒ above, le petit volume n'excuse rien", () => {
    expect(complaintVerdict({ delivered: 5, complained: 1 })).toBe("above");
  });

  test("pile au seuil ⇒ pas au-dessus", () => {
    expect(complaintVerdict({ delivered: 1000, complained: 3 })).toBe("ok");
    expect(complaintVerdict({ delivered: 1000, complained: 4 })).toBe("above");
  });

  test("zéro plainte au volume minimal ⇒ ok", () => {
    expect(complaintVerdict({ delivered: MIN_DELIVERED_FOR_VERDICT, complained: 0 })).toBe("ok");
    expect(complaintVerdict({ delivered: MIN_DELIVERED_FOR_VERDICT - 1, complained: 0 })).toBe("thin");
  });
});

describe("formats", () => {
  test("part : dénominateur nul ⇒ null, jamais 0", () => {
    expect(part(0, 0)).toBeNull();
    expect(part(1, 4)).toBe(0.25);
  });

  test("pct garde deux décimales sous 1 %", () => {
    expect(pct(null)).toBe("—");
    expect(pct(0)).toBe("0.0%");
    expect(pct(0.003)).toBe("0.30%");
    expect(pct(1)).toBe("100.0%");
  });

  test("fenêtre : seules 7, 30 et 90 passent", () => {
    expect(parseDayWindow("7")).toBe(7);
    expect(parseDayWindow(["90", "7"])).toBe(90);
    expect(parseDayWindow("365")).toBe(30);
    expect(parseDayWindow(undefined)).toBe(30);
  });

  test("un code inconnu reste lisible", () => {
    expect(reasonLabel("stale_outbox")).toBe("Too old when the worker picked it up");
    expect(reasonLabel("brand_new_code")).toBe("brand new code");
  });
});
