/**
 * LA CRÉATIVE (niveau 2) — et la seule chose qui rende « absence ≠ null » implémentable.
 *
 * ⛔ CE QUE CES TESTS TIENNENT EN PLACE. PostgREST n'écrit QUE les colonnes présentes dans le
 * payload. C'est ce mécanisme, et rien d'autre, qui permet à une inscription dont l'émetteur ne
 * dit rien de la campagne de ne PAS détacher la créative de la sienne — alors qu'un `null`
 * explicite la détache pour de bon. Un `capture_campaign_id: id ?? null` casserait la distinction
 * en une ligne, sans erreur, sans journal, et le niveau 1 disparaîtrait à la première inscription
 * d'un émetteur muet.
 *
 * C'est aussi ce qui protège `first_seen_at` et `default_tag_id` depuis le lot précédent : ils ne
 * sont pas cités, donc ils survivent à chaque upsert.
 *
 * ⚠️ Aucun accès réseau : le client est un double chaînable qui enregistre les arguments reçus. Ce
 * qui est mesuré, c'est le PAYLOAD — `createClient<any>` ne vérifie aucun nom de colonne à la
 * compilation, donc seul un banc peut les tenir en place.
 */
import { describe, expect, test } from "bun:test";
import { resolveOptin } from "./optin";

const ASSET = "asset_1";
const CREATIVE_ID = "9f1c4a1e-2b3d-4c5e-8a90-1234567890ab";

type Reponse = { data?: unknown; error?: unknown };
type Appel = { table: string; methodes: { m: string; args: unknown[] }[] };

function fauxDb(reponses: (table: string, n: number) => Reponse) {
  const appels: Appel[] = [];
  const compteur: Record<string, number> = {};

  const db = {
    from(table: string) {
      compteur[table] = (compteur[table] ?? 0) + 1;
      const rep = reponses(table, compteur[table]);
      const appel: Appel = { table, methodes: [] };
      appels.push(appel);

      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (resoudre: (v: unknown) => void) =>
                resoudre({ data: rep.data ?? null, error: rep.error ?? null });
            }
            return (...args: unknown[]) => {
              appel.methodes.push({ m: prop, args });
              return chaine;
            };
          },
        },
      );
      return chaine;
    },
  };

  return { db: db as unknown as Parameters<typeof resolveOptin>[0], appels };
}

/** Réponse nominale : l'upsert passe, la relecture rend l'id de la créative. */
const NOMINAL = (t: string, n: number): Reponse =>
  t === "optin" && n === 2 ? { data: { id: "op_1", default_tag_id: null } } : { data: null };

const payloadUpsert = (appels: Appel[]): Record<string, unknown> =>
  ((appels[0] as Appel).methodes.find((m) => m.m === "upsert")?.args[0] ?? {}) as Record<string, unknown>;

describe("resolveOptin — ce qui n'est pas cité n'est pas écrit", () => {
  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : construire le payload avec
   * `capture_campaign_id: optin.captureCampaignId ?? null`. Symptôme en production : chaque
   * inscription v1 — ou chaque inscription v2 sans campagne — DÉTACHE la créative de sa campagne.
   */
  test("un appel v1 n'écrit AUCUNE colonne du contrat v2", async () => {
    const { db, appels } = fauxDb(NOMINAL);
    await resolveOptin(db, ASSET, { slug: "sidebar-guide", name: "Sidebar" });

    const cles = Object.keys(payloadUpsert(appels));
    expect(cles).not.toContain("capture_campaign_id");
    expect(cles).not.toContain("external_id");
    expect(cles).not.toContain("placement");
    expect(cles).not.toContain("asks_interests");
    expect(cles).not.toContain("offered_interest_ids");
    // Et les colonnes que la migration précédente protège déjà.
    expect(cles).not.toContain("first_seen_at");
    expect(cles).not.toContain("default_tag_id");
  });

  test("campagne ABSENTE ⇒ la colonne n'est pas citée (le rattachement survit)", async () => {
    const { db, appels } = fauxDb(NOMINAL);
    await resolveOptin(db, ASSET, { slug: CREATIVE_ID, name: "Guide", asksInterests: true });

    const p = payloadUpsert(appels);
    expect(Object.keys(p)).not.toContain("capture_campaign_id");
    expect(p.asks_interests).toBe(true);
  });

  /**
   * ⛔ MUTATION QUI DOIT TUER CE TEST : traiter `null` comme une absence. Symptôme : l'émetteur
   * détache une créative de sa campagne, la route répond 200, et le rattachement reste en place
   * pour toujours — un ordre exécuté nulle part.
   */
  test("campagne à NULL ⇒ la colonne EST citée, à null (détachement demandé)", async () => {
    const { db, appels } = fauxDb(NOMINAL);
    await resolveOptin(db, ASSET, { slug: CREATIVE_ID, name: "Guide", captureCampaignId: null });

    const p = payloadUpsert(appels);
    expect(Object.keys(p)).toContain("capture_campaign_id");
    expect(p.capture_campaign_id).toBeNull();
  });

  test("contrat v2 complet ⇒ les cinq colonnes partent, avec l'unique `(asset_id, slug)`", async () => {
    const { db, appels } = fauxDb(NOMINAL);
    const r = await resolveOptin(db, ASSET, {
      slug: CREATIVE_ID,
      name: "In-article guide",
      externalId: CREATIVE_ID,
      placement: "in_article",
      captureCampaignId: "cc_1",
      asksInterests: true,
      offeredInterestIds: [3, 9],
    });
    expect(r.value?.id).toBe("op_1");

    const p = payloadUpsert(appels);
    expect(p.slug).toBe(CREATIVE_ID);
    expect(p.external_id).toBe(CREATIVE_ID);
    expect(p.placement).toBe("in_article");
    expect(p.capture_campaign_id).toBe("cc_1");
    expect(p.asks_interests).toBe(true);
    expect(p.offered_interest_ids).toEqual([3, 9]);

    const options = (appels[0] as Appel).methodes.find((m) => m.m === "upsert")?.args[1] as Record<string, unknown>;
    expect(options.onConflict).toBe("asset_id,slug");
    expect(options.ignoreDuplicates).toBe(false);
  });

  /**
   * ⛔ Un échec de classement ne lève jamais : le consentement est déjà en base quand cette
   * fonction est appelée, et il ne se rattrape pas — un classement, si.
   */
  test("un échec rend son motif au lieu de lever", async () => {
    const { db } = fauxDb(() => ({ error: { message: "boom" } }));
    const r = await resolveOptin(db, ASSET, { slug: "sidebar-guide" });
    expect(r.value).toBeNull();
    expect(r.error).toBe("optin-upsert:boom");
  });
});
