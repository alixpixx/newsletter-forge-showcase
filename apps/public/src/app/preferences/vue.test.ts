/**
 * `/preferences` — un abonné EFFACÉ voit exactement l'écran d'un lien faux (22/09/2026).
 *
 * Avant : un vieux lien de pied de page rouvrait l'écran sur l'adresse `erased+…@deleted.invalid`,
 * avec la liste des marques et des interrupteurs qui écrivaient encore. On compare ici le rendu d'un
 * abonné effacé à celui d'un jeton contrefait : même composant, mêmes propriétés.
 * MUTATION QUI DOIT LE TUER : retirer le test `deleted_at` de `resoudreAbonnePrefs`.
 */
import { describe, expect, test } from "bun:test";
import { fausseBasePostgrest } from "@/lib/faux-postgrest";
import { vuePreferences } from "./vue";

const SUBR = "22222222-2222-4222-8222-222222222222";
const JETON = "jeton-prefs";

function monter(deleted_at: string | null) {
  return fausseBasePostgrest({
    subscriber: [
      deleted_at
        ? { id: SUBR, email: `erased+${SUBR}@deleted.invalid`, first_name: null, deleted_at }
        : { id: SUBR, email: "lectrice@example.invalid", first_name: "Ana", deleted_at: null },
    ],
    subscription: [
      {
        id: "sa", subscriber_id: SUBR, asset_id: "a", status: deleted_at ? "deleted" : "active",
        language: "pt-BR", created_at: "2026-01-01T00:00:00Z", granted_purposes: { content: true },
        tracking_consent: false, asset: { name: "Northwind Sports" },
      },
    ],
  });
}

async function rendre(f: ReturnType<typeof monter>, params: { token?: string; lang?: string; ls?: string }) {
  const el = (await vuePreferences(params, {
    getDb: () => f.db as never,
    verifyPrefs: (t) => (t === JETON ? SUBR : null),
  })) as { type: unknown; props: Record<string, unknown>; key: unknown };
  // ⚠️ On compare type, propriétés et clé — pas l'objet entier : en mode développement React 19
  // accroche à chaque élément une pile d'appels (`_debugStack`) propre à l'endroit du rendu.
  return { type: el.type, props: el.props, key: el.key };
}

describe("⛔ /preferences : un abonné effacé voit l'écran d'un lien faux", () => {
  for (const lang of [undefined, "fr", "es"]) {
    test(`même rendu qu'un jeton contrefait (lang=${lang ?? "aucune"})`, async () => {
      const efface = await rendre(monter("2026-09-20T10:00:00Z"), { token: JETON, lang });
      const faux = await rendre(monter(null), { token: "jeton-contrefait", lang });
      expect(efface).toEqual(faux);
    });
  }

  test("ni liste, ni adresse pseudonymisée : seule la résolution de l'abonné a été lue", async () => {
    const f = monter("2026-09-20T10:00:00Z");
    const efface = await rendre(f, { token: JETON, ls: "44444444-4444-4444-8444-444444444444" });
    expect(JSON.stringify(efface.props)).not.toContain("deleted.invalid");
    expect(f.appels.map((a) => a.cible)).toEqual(["subscriber"]);
  });

  test("contre-épreuve : un abonné vivant voit bien ses préférences, et le banc les distingue", async () => {
    const vivant = await rendre(monter(null), { token: JETON });
    const faux = await rendre(monter(null), { token: "jeton-contrefait" });
    expect(vivant).not.toEqual(faux);
    expect(vivant.props.email).toBe("lectrice@example.invalid");
    expect((vivant.props.items as unknown[]).length).toBe(1);
  });
});

/**
 * ⛔ UN CONTACT HORS NEWSLETTER (0088) N'EST PAS LISTÉ : l'afficher proposerait un interrupteur
 * « Newsletter » qui l'inscrirait sans double opt-in.
 * MUTATION QUI DOIT LE TUER : retirer `.neq("status", "contact")` de la lecture des souscriptions.
 */
describe("/preferences : une ligne contact n'apparaît pas", () => {
  test("abonné Northwind Sports + contact Copper Kettle ⇒ seule Northwind Sports est listée", async () => {
    const f = monter(null);
    f.tables.subscription.push({
      id: "sb", subscriber_id: SUBR, asset_id: "b", status: "contact",
      language: "es", created_at: "2026-02-01T00:00:00Z", granted_purposes: {},
      tracking_consent: false, asset: { name: "Copper Kettle" },
    });
    const rendu = await rendre(f, { token: JETON });
    const items = rendu.props.items as { assetId: string }[];
    expect(items.map((i) => i.assetId)).toEqual(["a"]);
  });
});
