/**
 * Statistiques de campagne (0085) — lecture de la réponse, taux, export.
 *
 * ⛔ Ce qui est tenu : une réponse illisible ne devient JAMAIS des zéros ; un taux d'ouverture ou de
 * clic n'est calculé que sur des délivrés SUIVIS, et vaut « — » (jamais 0 %) sinon ; un envoi au suivi
 * inconnu (parti avant 0085) n'est pas mêlé aux autres ; le CSV laisse VIDE ce qui n'est pas mesuré.
 */
import { describe, expect, test } from "bun:test";
import {
  cibleEnvoi,
  cumuler,
  duree,
  finEstimee,
  heure,
  lignesCsv,
  lireEnCours,
  lireReponse,
  nomEnvoi,
  noteExclues,
  pct,
  raisonNonMesure,
  restants,
  rythmeParHeure,
  taux,
  type EnvoiEnCours,
  type EnvoiStats,
} from "./campaign-stats";
import { lireEnvoisEnCours, lireStatsCampagnes } from "./data/campaign-stats";

const ENVOI = {
  occurrence_id: "occ-1",
  seq: 3,
  local_date: "2026-09-23",
  sent_at: "2026-09-23T13:30:03Z",
  sent: 100,
  delivered: 95,
  bounced: 3,
  complained: 1,
  opened: 12,
  clicked: 4,
  tracked: 40,
  tracking_unknown: 0,
};
const REPONSE = {
  total: 1,
  campaigns: [
    { id: "c1", name: "Friday NL", status: "draft", archived: false, recurring: true, last_sent_at: "2026-09-23T13:30:03Z", editions: [ENVOI] },
  ],
};

function envoi(p: Partial<EnvoiStats> = {}): EnvoiStats {
  return {
    occurrenceId: "occ-1", seq: 3, localDate: "2026-09-23", sentAt: "2026-09-23T13:30:03Z",
    sent: 100, delivered: 95, bounced: 3, complained: 1, opened: 12, clicked: 4, tracked: 40, trackingUnknown: 0,
    ...p,
  };
}

describe("lireReponse", () => {
  test("réponse complète ⇒ lue telle quelle", () => {
    const r = lireReponse(REPONSE);
    expect(r?.total).toBe(1);
    expect(r?.campaigns[0]?.editions[0]).toEqual(envoi());
  });

  test("envoi unique d'une one-shot : occurrence_id et seq nuls acceptés", () => {
    const r = lireReponse({ ...REPONSE, campaigns: [{ ...REPONSE.campaigns[0]!, recurring: false, editions: [{ ...ENVOI, occurrence_id: null, seq: null, local_date: null }] }] });
    expect(r?.campaigns[0]?.editions[0]?.occurrenceId).toBeNull();
  });

  const illisibles: [string, unknown][] = [
    ["nul", null],
    ["total absent", { campaigns: [] }],
    ["campagnes absentes", { total: 0 }],
    ["compteur manquant", { ...REPONSE, campaigns: [{ ...REPONSE.campaigns[0]!, editions: [{ ...ENVOI, opened: undefined }] }] }],
    ["compteur négatif", { ...REPONSE, campaigns: [{ ...REPONSE.campaigns[0]!, editions: [{ ...ENVOI, sent: -1 }] }] }],
    ["compteur texte", { ...REPONSE, campaigns: [{ ...REPONSE.campaigns[0]!, editions: [{ ...ENVOI, tracked: "40" }] }] }],
    ["nom absent", { ...REPONSE, campaigns: [{ ...REPONSE.campaigns[0]!, name: undefined }] }],
    ["archived non booléen", { ...REPONSE, campaigns: [{ ...REPONSE.campaigns[0]!, archived: "false" }] }],
  ];
  for (const [nom, raw] of illisibles) {
    test(`${nom} ⇒ illisible (null), jamais des zéros`, () => {
      expect(lireReponse(raw)).toBeNull();
    });
  }
});

describe("taux", () => {
  test("mesuré : ouverture et clic sur les délivrés SUIVIS, rebond sur les envoyés, plainte sur les délivrés", () => {
    const t = taux(envoi());
    expect(t.openRate).toBe(12 / 40);
    expect(t.ctr).toBe(4 / 40);
    expect(t.bounceRate).toBe(3 / 100);
    expect(t.spamRate).toBe(1 / 95);
    expect(t.deliveryRate).toBe(95 / 100);
  });

  test("⛔ aucun destinataire suivi ⇒ ouverture et clic NON mesurés (null, « — »), jamais 0 %", () => {
    const e = envoi({ tracked: 0, opened: 0, clicked: 0 });
    expect(taux(e).openRate).toBeNull();
    expect(taux(e).ctr).toBeNull();
    expect(pct(taux(e).openRate)).toBe("—");
    expect(raisonNonMesure(e)).toBe("Not measured — 0 of 95 delivered recipients allow open and click tracking.");
  });

  test("⛔ suivi INCONNU (parti avant 0085) ⇒ non mesuré, même si d'autres délivrés sont suivis", () => {
    const e = envoi({ trackingUnknown: 5 });
    expect(taux(e).openRate).toBeNull();
    expect(raisonNonMesure(e)).toContain("before open and click tracking was recorded");
  });

  test("rien de délivré ⇒ non mesuré, et plainte sans dénominateur ⇒ null", () => {
    const e = envoi({ delivered: 0, tracked: 0, opened: 0, clicked: 0, complained: 0 });
    expect(raisonNonMesure(e)).toBe("Not measured — nothing delivered yet.");
    expect(taux(e).spamRate).toBeNull();
  });

  test("rien envoyé ⇒ taux de remise et de rebond nuls (null), pas 0 %", () => {
    const t = taux(envoi({ sent: 0, delivered: 0, bounced: 0, tracked: 0, opened: 0, clicked: 0, complained: 0 }));
    expect(t.deliveryRate).toBeNull();
    expect(t.bounceRate).toBeNull();
  });

  test("cumul d'une campagne = somme de ses envois", () => {
    const c = cumuler([envoi(), envoi({ sent: 10, delivered: 9, tracked: 2, opened: 1, trackingUnknown: 0 })]);
    expect(c.sent).toBe(110);
    expect(c.tracked).toBe(42);
    expect(taux(c).openRate).toBe(13 / 42);
    expect(c.exclues).toBe(0);
  });

  const ancienne = (p: Partial<EnvoiStats> = {}) =>
    envoi({ tracked: 0, opened: 0, clicked: 0, trackingUnknown: 95, ...p });

  test("⛔ des éditions anciennes (suivi inconnu) ne masquent PAS les éditions mesurées : elles sortent de Open/Click seulement", () => {
    const c = cumuler([envoi(), envoi({ opened: 8, clicked: 2 }), ancienne(), ancienne()]);
    expect(raisonNonMesure(c)).toBeNull();
    expect(c.exclues).toBe(2);
    expect(c.tracked).toBe(80);
    expect(taux(c).openRate).toBe(20 / 80);
    expect(taux(c).ctr).toBe(6 / 80);
    // Sent, Delivered, Bounce, Spam comptent TOUT.
    expect(c.sent).toBe(400);
    expect(c.delivered).toBe(380);
    expect(taux(c).spamRate).toBe(4 / 380);
    expect(noteExclues(c)).toBe("Open and click leave out 2 editions sent before tracking was recorded (Sep 24, 2026).");
  });

  test("⛔ une édition à moitié suivie (suivi inconnu sur une partie) sort ENTIÈRE de Open/Click", () => {
    const c = cumuler([envoi(), envoi({ opened: 30, tracked: 50, trackingUnknown: 5 })]);
    expect(c.tracked).toBe(40);
    expect(taux(c).openRate).toBe(12 / 40);
    expect(c.exclues).toBe(1);
  });

  test("que des éditions anciennes ⇒ non mesuré « before tracking », sans note d'exclusion", () => {
    const c = cumuler([ancienne(), ancienne()]);
    expect(raisonNonMesure(c)).toContain("before open and click tracking was recorded");
    expect(c.exclues).toBe(0);
    expect(noteExclues(c)).toBeNull();
  });

  test("anciennes + nouvelles sans suivi ⇒ « 0 of N » compte les délivrés des NOUVELLES seulement", () => {
    const c = cumuler([envoi({ tracked: 0, opened: 0, clicked: 0, delivered: 90 }), ancienne({ delivered: 500, trackingUnknown: 500 })]);
    expect(raisonNonMesure(c)).toBe("Not measured — 0 of 90 delivered recipients allow open and click tracking.");
    expect(taux(c).openRate).toBeNull();
    expect(c.delivered).toBe(590);
  });

  test("pct : une décimale", () => {
    expect(pct(0.12345)).toBe("12.3%");
    expect(pct(0)).toBe("0.0%");
  });
});

describe("noms et export", () => {
  test("nomEnvoi : édition numérotée datée, ou « Single send »", () => {
    expect(nomEnvoi(envoi())).toBe("#3 · Sep 23, 2026");
    expect(nomEnvoi(envoi({ occurrenceId: null, seq: null }))).toBe("Single send");
  });

  test("CSV : les colonnes de l'écran, taux à une décimale", () => {
    expect(lignesCsv([envoi()])).toEqual([["#3", "2026-09-23", "100", "95", "3", "1", "12", "30.0", "4", "10.0", "40"]]);
  });

  test("⛔ CSV : ce qui n'est pas mesuré reste VIDE, jamais « 0 »", () => {
    const [ligne] = lignesCsv([envoi({ tracked: 0, opened: 0, clicked: 0 })]);
    expect(ligne!.slice(6, 10)).toEqual(["", "", "", ""]);
    const [inconnu] = lignesCsv([envoi({ trackingUnknown: 2 })]);
    expect(inconnu![10]).toBe("");
  });
});

describe("lireStatsCampagnes", () => {
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

  test("appelle la RPC avec la marque, les filtres et la page", async () => {
    const d = db(REPONSE);
    const r = await lireStatsCampagnes(d, "a1", { since: new Date("2026-08-25T00:00:00Z"), search: "  friday ", limit: 25, offset: 50 });
    expect(r.known).toBe(true);
    expect(d.appels).toEqual([
      ["campaign_send_stats", { p_asset_id: "a1", p_campaign_id: null, p_since: "2026-08-25T00:00:00.000Z", p_search: "friday", p_limit: 25, p_offset: 50 }],
    ]);
  });

  test("sans marque ⇒ aucune lecture", async () => {
    const d = db(REPONSE);
    expect(await lireStatsCampagnes(d, null)).toEqual({ known: false, reason: "no brand selected" });
    expect(d.appels).toEqual([]);
  });

  test("fonction absente ⇒ nomme la migration 0085", async () => {
    const r = await lireStatsCampagnes(db(null, { message: "Could not find the function newsletter.campaign_send_stats" }), "a1");
    expect(r).toEqual({ known: false, reason: "migration 0085 has not been applied" });
  });

  test("⛔ réponse illisible ⇒ known:false, jamais une liste vide", async () => {
    expect(await lireStatsCampagnes(db({ total: 1 }), "a1")).toEqual({
      known: false,
      reason: "the database answered in an unexpected shape",
    });
  });
});

/* ------------------------------------------------------------------ *
 * Envois EN COURS (0096) — l'encart « Sending now »
 * ------------------------------------------------------------------ */

/** La forme réelle rendue le 09/10/2026 à 14:37 UTC pour le lot 2 Harbor Tech (relue sur la base). */
const EN_COURS = {
  campaign_id: "e89827ab-f794-42a4-b071-ce7fa2aea2c5",
  occurrence_id: null,
  name: "Arena account update — resend to verified · lot 2/2 (13 347)",
  recurring: false,
  seq: null,
  local_date: null,
  scheduled_at: "2026-10-09T13:00:00+00:00",
  planned: 13347,
  queued: 13347,
  sent: 5030,
  pending: 8317,
  in_flight: 0,
  failed: 0,
  skipped: 0,
  sent_last_15m: 750,
  first_sent_at: "2026-10-09T13:00:05.934055+00:00",
  last_sent_at: "2026-10-09T14:34:29.418837+00:00",
  next_attempt_at: "2026-10-09T13:00:03.666425+00:00",
  delivered: 4901,
  bounced: 117,
  complained: 0,
  opened: 288,
  clicked: 18,
  tracked: 4901,
  tracking_unknown: 0,
};
const AS_OF = "2026-10-09T14:37:16.287097+00:00";

function enCours(p: Partial<EnvoiEnCours> = {}): EnvoiEnCours {
  const lu = lireEnCours({ as_of: AS_OF, sending: [EN_COURS] });
  return { ...lu!.sending[0]!, ...p };
}

describe("lireEnCours", () => {
  test("lit la forme réelle de campaign_send_progress", () => {
    const lu = lireEnCours({ as_of: AS_OF, sending: [EN_COURS] });
    expect(lu?.asOf).toBe(AS_OF);
    expect(lu?.sending).toHaveLength(1);
    const e = lu!.sending[0]!;
    expect([e.campaignId, e.occurrenceId, e.planned, e.queued, e.sent, e.pending, e.inFlight]).toEqual([
      EN_COURS.campaign_id, null, 13347, 13347, 5030, 8317, 0,
    ]);
    expect([e.sentLast15m, e.delivered, e.bounced, e.opened, e.clicked, e.tracked, e.trackingUnknown]).toEqual([
      750, 4901, 117, 288, 18, 4901, 0,
    ]);
    expect(e.firstSentAt).toBe(EN_COURS.first_sent_at);
  });

  test("rien en cours = liste vide, lisible", () => {
    expect(lireEnCours({ as_of: AS_OF, sending: [] })).toEqual({ asOf: AS_OF, sending: [] });
  });

  test("planned null est accepté (la base ne l'a pas écrit)", () => {
    expect(lireEnCours({ as_of: AS_OF, sending: [{ ...EN_COURS, planned: null }] })?.sending[0]?.planned).toBeNull();
  });

  test("⛔ un compteur manquant, négatif ou mal typé ⇒ null, jamais un zéro", () => {
    for (const cle of ["queued", "sent", "pending", "in_flight", "failed", "skipped", "sent_last_15m", "delivered", "bounced", "tracked"]) {
      const sans = { ...EN_COURS } as Record<string, unknown>;
      delete sans[cle];
      expect(lireEnCours({ as_of: AS_OF, sending: [sans] })).toBeNull();
      expect(lireEnCours({ as_of: AS_OF, sending: [{ ...EN_COURS, [cle]: -1 }] })).toBeNull();
      expect(lireEnCours({ as_of: AS_OF, sending: [{ ...EN_COURS, [cle]: "12" }] })).toBeNull();
    }
  });

  test("⛔ sans as_of, sans liste, sans id ou planned mal typé ⇒ null", () => {
    expect(lireEnCours({ sending: [EN_COURS] })).toBeNull();
    expect(lireEnCours({ as_of: AS_OF })).toBeNull();
    expect(lireEnCours({ as_of: AS_OF, sending: [{ ...EN_COURS, campaign_id: null }] })).toBeNull();
    expect(lireEnCours({ as_of: AS_OF, sending: [{ ...EN_COURS, planned: "13347" }] })).toBeNull();
    expect(lireEnCours({ as_of: AS_OF, sending: [{ ...EN_COURS, occurrence_id: 3 }] })).toBeNull();
    expect(lireEnCours(null)).toBeNull();
  });
});

describe("progression d'un envoi en cours", () => {
  test("cible = prévus ; jamais moins que ce qui est en file", () => {
    expect(cibleEnvoi(enCours())).toBe(13347);
    expect(cibleEnvoi(enCours({ planned: null }))).toBe(13347);
    expect(cibleEnvoi(enCours({ planned: 100 }))).toBe(13347);
  });

  test("reste = en attente + en vol + pas encore en file", () => {
    expect(restants(enCours())).toBe(8317);
    expect(restants(enCours({ inFlight: 250, pending: 8067 }))).toBe(8317);
    expect(restants(enCours({ queued: 10000, planned: 13347, pending: 4970 }))).toBe(4970 + 3347);
  });

  test("rythme = 15 dernières minutes × 4", () => {
    expect(rythmeParHeure(enCours())).toBe(3000);
  });

  test("fin estimée au rythme des 15 dernières minutes", () => {
    // 8 317 restants à 3 000/h = 2,772 h = 2 h 46 min 21 s après 14:37:16.
    expect(finEstimee(enCours(), AS_OF)).toBe(new Date(Date.parse(AS_OF) + (8317 / 3000) * 3_600_000).toISOString());
    expect(heure(finEstimee(enCours(), AS_OF))).toBe("17:23 UTC");
  });

  test("⛔ rien parti depuis 15 min ⇒ PAS d'estimation ; rien à envoyer ⇒ pas d'estimation", () => {
    expect(finEstimee(enCours({ sentLast15m: 0 }), AS_OF)).toBeNull();
    expect(finEstimee(enCours({ pending: 0 }), AS_OF)).toBeNull();
  });

  test("les taux de la liste s'appliquent tels quels", () => {
    const t = taux(enCours());
    expect(pct(t.bounceRate)).toBe("2.3%");
    expect(pct(t.openRate)).toBe("5.9%");
    expect(raisonNonMesure(enCours({ tracked: 0 }))).toContain("0 of 4,901");
  });

  test("heure et durée", () => {
    expect(heure("2026-10-09T13:00:05.934055+00:00")).toBe("13:00 UTC");
    expect(heure(null)).toBe("—");
    expect(duree(10_000)).toBe("less than a minute");
    expect(duree(12 * 60_000)).toBe("12 min");
    expect(duree(59 * 60_000)).toBe("59 min");
    expect(duree(75 * 60_000)).toBe("1 h 15 min");
    expect(duree((2 * 60 + 5) * 60_000)).toBe("2 h 05 min");
  });
});

describe("lireEnvoisEnCours", () => {
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

  test("appelle la RPC avec la seule marque de la session", async () => {
    const d = db({ as_of: AS_OF, sending: [EN_COURS] });
    const r = await lireEnvoisEnCours(d, "a1");
    expect(r.known).toBe(true);
    expect(d.appels).toEqual([["campaign_send_progress", { p_asset_id: "a1" }]]);
  });

  test("sans marque ⇒ aucune lecture", async () => {
    const d = db({ as_of: AS_OF, sending: [] });
    expect(await lireEnvoisEnCours(d, null)).toEqual({ known: false, reason: "no brand selected" });
    expect(d.appels).toEqual([]);
  });

  test("fonction absente ⇒ nomme la migration 0096", async () => {
    const r = await lireEnvoisEnCours(db(null, { message: "Could not find the function newsletter.campaign_send_progress" }), "a1");
    expect(r).toEqual({ known: false, reason: "migration 0096 has not been applied" });
  });

  test("⛔ réponse illisible ⇒ known:false, jamais « rien ne part »", async () => {
    expect(await lireEnvoisEnCours(db({ sending: [] }), "a1")).toEqual({
      known: false,
      reason: "the database answered in an unexpected shape",
    });
  });
});
