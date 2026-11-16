import { describe, expect, spyOn, test } from "bun:test";
import { choisirAccuseGlobal, mettreEnFileAccuse } from "./accuse-desabonnement";
import { fausseBasePostgrest } from "./faux-postgrest";

describe("choisirAccuseGlobal — UN accusé pour « tout désinscrire »", () => {
  const s = (asset_id: string, created_at: string | null) => ({ asset_id, created_at });

  test("rien n'a changé ⇒ aucun accusé", () => {
    expect(choisirAccuseGlobal([])).toBeNull();
    expect(choisirAccuseGlobal([], "a")).toBeNull();
  });

  test("sans marque désignée ⇒ la plus récente", () => {
    const l = [s("a", "2026-01-01T00:00:00Z"), s("b", "2026-06-01T00:00:00Z"), s("c", "2026-03-01T00:00:00Z")];
    expect(choisirAccuseGlobal(l)?.asset_id).toBe("b");
  });

  test("la marque désignée, si ce geste l'a changée", () => {
    const l = [s("a", "2026-01-01T00:00:00Z"), s("b", "2026-06-01T00:00:00Z")];
    expect(choisirAccuseGlobal(l, "a")?.asset_id).toBe("a");
  });

  test("une marque désignée mais PAS changée par ce geste ne gagne pas : retour à la plus récente", () => {
    const l = [s("a", "2026-01-01T00:00:00Z"), s("b", "2026-06-01T00:00:00Z")];
    expect(choisirAccuseGlobal(l, "z")?.asset_id).toBe("b");
  });

  test("une date illisible ne passe jamais devant une date lue", () => {
    const l = [s("a", null), s("b", "2026-01-01T00:00:00Z"), s("c", "pas-une-date")];
    expect(choisirAccuseGlobal(l)?.asset_id).toBe("b");
  });
});

describe("mettreEnFileAccuse", () => {
  test("sans adresse ⇒ rien en file, et c'est dit (sans lever)", async () => {
    const f = fausseBasePostgrest({});
    const espion = spyOn(console, "error").mockImplementation(() => {});
    try {
      const ok = await mettreEnFileAccuse(f.db as never, {
        subscriptionId: "s1", assetId: "a1", email: null, marque: "X", langue: "fr", origine: "banc",
      });
      expect(ok).toBe(false);
      expect(f.outbox()).toHaveLength(0);
      expect(String(espion.mock.calls[0]?.[0])).toContain("unsubscribe-ack-queue-failed");
    } finally {
      espion.mockRestore();
    }
  });

  test("aucun suivi, aucun lien d'action : la ligne ne porte que l'accusé", async () => {
    const f = fausseBasePostgrest({});
    await mettreEnFileAccuse(f.db as never, {
      subscriptionId: "s1", assetId: "a1", email: "x@example.invalid", marque: "Northwind Sports", langue: "fr-FR", origine: "banc",
    });
    expect(f.outbox()).toHaveLength(1);
    expect(f.outbox()[0]).toMatchObject({
      kind: "unsubscribe_ack",
      action_url: null,
      payload: {},
      subject: "Désinscription confirmée — Northwind Sports",
    });
  });
});
