import { describe, expect, test } from "bun:test";
import { etatDuTest, refusAvantFile, verifierExclusion } from "./test-send-verdict";

/** Une base factice : ce que chaque fonction répond, et les appels reçus. */
function base(reponses: Record<string, { data: unknown; error: unknown }>) {
  const appels: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    appels,
    rpc: (fn: string, args: Record<string, unknown>) => {
      appels.push({ fn, args });
      return Promise.resolve(reponses[fn] ?? { data: null, error: { message: `inconnue: ${fn}` } });
    },
  };
}

describe("verifierExclusion", () => {
  test("le cas mesuré : adresse effacée ⇒ 409, et rien n'est mis en file", async () => {
    const db = base({ is_suppressed: { data: true, error: null }, is_hard_suppressed: { data: false, error: null } });
    const r = await verifierExclusion(db, "x@example.com", "asset-pf");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.message.includes("subscribes to a newsletter and confirms")).toBe(true);
    }
  });

  test("la liste est lue POUR LA MARQUE du test", async () => {
    const db = base({ is_suppressed: { data: false, error: null }, is_hard_suppressed: { data: false, error: null } });
    await verifierExclusion(db, "x@example.com", "asset-pf");
    expect(db.appels.map((a) => a.args.p_asset_id)).toEqual(["asset-pf", "asset-pf"]);
  });

  test("adresse libre ⇒ ok", async () => {
    const db = base({ is_suppressed: { data: false, error: null }, is_hard_suppressed: { data: false, error: null } });
    expect((await verifierExclusion(db, "x@example.com", "a")).ok).toBe(true);
  });

  test("liste illisible ⇒ 503, jamais « ok »", async () => {
    const db = base({ is_suppressed: { data: null, error: { message: "boom" } }, is_hard_suppressed: { data: false, error: null } });
    const r = await verifierExclusion(db, "x@example.com", "a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });
});

/**
 * ⛔ UN ENVOI DE TEST QUI NE PART PAS DOIT LE DIRE (24/09/2026 : deux tests « Queued » écartés en
 * silence, adresse effacée). Au clic pour la liste d'exclusion, puis après le passage du worker.
 */
describe("refusAvantFile", () => {
  test("adresse libre ⇒ rien ne s'oppose", () => {
    expect(refusAvantFile({ suppressed: false, hard: false })).toBe(null);
  });

  test("effacée ou désinscrite de tout ⇒ refus qui dit comment en sortir", () => {
    const m = refusAvantFile({ suppressed: true, hard: false }) ?? "";
    expect(m.includes("do-not-send list")).toBe(true);
    expect(m.includes("subscribes to a newsletter and confirms")).toBe(true);
  });

  test("rebond dur ou plainte ⇒ refus sans sortie par réinscription", () => {
    const m = refusAvantFile({ suppressed: true, hard: true }) ?? "";
    expect(m.includes("do-not-send list")).toBe(true);
    expect(m.includes("confirms")).toBe(false);
  });
});

describe("etatDuTest", () => {
  test("en file ou en cours ⇒ pending", () => {
    expect(etatDuTest({ status: "pending", error: null, sent_at: null }).etat).toBe("pending");
    expect(etatDuTest({ status: "sending", error: null, sent_at: null }).etat).toBe("pending");
  });

  test("parti ⇒ sent, avec l'heure", () => {
    const e = etatDuTest({ status: "sent", error: null, sent_at: "2026-09-24T12:20:41Z" });
    expect(e.etat).toBe("sent");
    expect(e.message.includes("12:20 UTC")).toBe(true);
  });

  test("le cas mesuré : skipped / suppressed ⇒ not_sent, et le motif est dit", () => {
    const e = etatDuTest({ status: "skipped", error: "suppressed", sent_at: null });
    expect(e.etat).toBe("not_sent");
    expect(e.message).toBe("Not sent: the address is on the do-not-send list.");
  });

  test("pied légal incomplet ⇒ les champs manquants sont nommés", () => {
    const e = etatDuTest({ status: "skipped", error: "footer_incomplete:address,company", sent_at: null });
    expect(e.message).toBe("Not sent: the legal footer is incomplete (address, company).");
  });

  test("motif inconnu ⇒ montré tel quel, jamais tu", () => {
    expect(etatDuTest({ status: "skipped", error: "doi_token_expire", sent_at: null }).message).toBe(
      "Not sent: doi_token_expire.",
    );
  });

  test("refus du fournisseur ⇒ failed avec son message", () => {
    const e = etatDuTest({ status: "failed", error: "550 mailbox unavailable", sent_at: null });
    expect(e.etat).toBe("failed");
    expect(e.message.includes("550 mailbox unavailable")).toBe(true);
  });

  test("statut imprévu ⇒ jamais présenté comme parti", () => {
    expect(etatDuTest({ status: "cancelled", error: null, sent_at: null }).etat).toBe("failed");
  });
});
