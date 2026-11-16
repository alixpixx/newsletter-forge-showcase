/**
 * DANS QUELLE LANGUE UNE MARQUE ÉCRIT — ET QUI DÉCIDE DE L'ORDRE.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. `value[0]` n'est pas un détail d'affichage : c'est la
 * langue dans laquelle « Customise » écrit le modèle de cycle de vie, et celle que le bandeau
 * annonce avant le clic. Un tri qui désigne la mauvaise édition ne fait échouer aucune ligne de
 * code — il fait simplement partir la confirmation d'un abonné dans une langue qu'il ne lit pas,
 * découvert par lui seul.
 *
 * ⛔ ON MESURE LA REQUÊTE CONSTRUITE, PAS CE QUE POSTGREST EN FERAIT. Aucun accès réseau : le client
 * est un double qui enregistre les méthodes reçues. C'est la seule façon d'exercer un ORDRE sans
 * base — et l'ordre est précisément ce qui se trompe en silence.
 */
import { describe, expect, test } from "bun:test";
import {
  assetEditionLocalesWith,
  listEditionLegalFooters,
  updateEditionLegalFooter,
} from "./asset-editions";

type Appel = { table: string; methodes: { m: string; args: unknown[] }[] };

function fauxDb(reponse: { data: unknown; error: unknown }) {
  const appels: Appel[] = [];

  const db = {
    from(table: string) {
      const appel: Appel = { table, methodes: [] };
      appels.push(appel);

      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (resoudre: (v: unknown) => void) => resoudre(reponse);
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

  return { db: db as unknown as Parameters<typeof assetEditionLocalesWith>[0], appels };
}

const tris = (appel: Appel): unknown[][] =>
  appel.methodes.filter((m) => m.m === "order").map((m) => m.args);

const ASSET = "asset_1";

describe("assetEditionLocalesWith — l'ordre décide de la langue du modèle", () => {
  /**
   * ⛔ LE TEST CENTRAL. MUTATION QUI DOIT LE TUER : retirer `.order("is_primary", …)`, le tri
   * redevenant `created_at` seul.
   * Symptôme en production : l'équipe ouvre l'édition italienne de Harbor Tech et déplace la primaire
   * dessus (la migration 0026 annonce ce geste). Le lecteur continue de désigner l'édition ANGLAISE,
   * la plus ancienne ; « Customise » écrit le modèle en anglais et le bandeau l'annonce en anglais,
   * alors que tout nouvel inscrit atterrit sur l'édition primaire italienne.
   */
  test("la primaire d'abord, la plus ancienne ensuite, l'id pour départager", async () => {
    const { db, appels } = fauxDb({ data: [], error: null });
    await assetEditionLocalesWith(db, ASSET);

    const appel = appels[0]!;
    expect(appel.table).toBe("asset_edition");
    expect(tris(appel)).toEqual([
      ["is_primary", { ascending: false }],
      ["created_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer `.order("id", …)`.
   * Le défaut de `created_at` est `now()`, l'horodatage de TRANSACTION : deux éditions insérées par
   * le même `insert` portent la même valeur et l'ordre entre elles redevient arbitraire. Deux clics
   * de suite pourraient alors semer deux langues pour la même marque.
   */
  test("le départage par id est le DERNIER tri, pas le premier", async () => {
    const { db, appels } = fauxDb({ data: [], error: null });
    await assetEditionLocalesWith(db, ASSET);

    const ordres = tris(appels[0]!).map((args) => String(args[0]));
    expect(ordres[ordres.length - 1]).toBe("id");
  });

  test("la marque filtre la lecture — jamais les éditions d'une autre marque", async () => {
    const { db, appels } = fauxDb({ data: [], error: null });
    await assetEditionLocalesWith(db, ASSET);

    expect(appels[0]!.methodes.filter((m) => m.m === "eq").map((m) => m.args)).toEqual([
      ["asset_id", ASSET],
    ]);
  });

  test("les langues sont normalisées et dédoublonnées, dans l'ordre rendu", async () => {
    // « sv » n'existe pas dans `Locale` : le lecteur reçoit de l'anglais, comme le worker.
    const { db } = fauxDb({
      data: [{ language: "sv" }, { language: "pt" }, { language: "en" }],
      error: null,
    });
    expect(await assetEditionLocalesWith(db, ASSET)).toEqual({ known: true, value: ["en", "pt-BR"] });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : rendre `{ known: true, value: [] }` sur erreur.
   * Une lecture ratée deviendrait « cette marque n'a aucune édition », c'est-à-dire l'autorisation
   * de retomber en silence sur ce que la marque DÉCLARE au registre.
   */
  test("une lecture en erreur n'est PAS une marque sans édition", async () => {
    const { db } = fauxDb({ data: null, error: { message: "timeout" } });
    expect(await assetEditionLocalesWith(db, ASSET)).toEqual({ known: false, value: [] });
  });
});

/* ------------------------------------------------------------------ *
 * Le pied légal par édition — ajouté le 15/09/2026
 * ------------------------------------------------------------------ */

const edition = (over: Record<string, unknown> = {}) => ({
  id: "ed_1",
  market: "BR",
  language: "pt-BR",
  compliance_regime: "lgpd",
  is_primary: true,
  legal_footer: {},
  ...over,
});

describe("listEditionLegalFooters — ce qui manque vient de buildFooter, jamais d'une liste écrite ici", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : construire `missing` à la main dans cette fonction.
   * Symptôme : la liste de l'écran et celle qui met l'envoi en veto divergent. L'écran dirait « tout
   * est rempli » pendant que le worker refuse d'envoyer — et personne ne saurait où regarder.
   */
  test("une édition sans URL de confidentialité est signalée comme bloquante", async () => {
    const { db } = fauxDb({ data: [edition()], error: null });
    const r = await listEditionLegalFooters(db, "asset_1", "Quartz Tips");

    expect(r.known).toBe(true);
    expect(r.value[0]!.missing).toContain("privacy_url");
  });

  test("une édition complète ne signale rien", async () => {
    const { db } = fauxDb({
      data: [edition({ legal_footer: { privacy_url: "https://x.invalid/p" } })],
      error: null,
    });
    expect((await listEditionLegalFooters(db, "asset_1", "Quartz Tips")).value[0]!.missing).toEqual([]);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retomber sur `"gdpr"` quand le régime est illisible.
   * Symptôme : le régime décide des mentions OBLIGATOIRES. En inventer un ferait afficher — et
   * mesurer — les obligations d'un autre pays, donc déclarer conforme un pied qui ne l'est pas.
   */
  test("un régime inconnu rend « je ne sais pas », jamais un régime par défaut", async () => {
    const { db } = fauxDb({ data: [edition({ compliance_regime: "ccpa" })], error: null });
    const r = await listEditionLegalFooters(db, "asset_1", "Quartz Tips");

    expect(r.known).toBe(false);
    expect(r.value).toEqual([]);
  });

  test("une lecture en erreur n'est pas « aucune édition »", async () => {
    const { db } = fauxDb({ data: null, error: { message: "boom" } });
    expect(await listEditionLegalFooters(db, "asset_1", "S")).toEqual({ known: false, value: [] });
  });

  test("la lecture est scopée sur la marque, et la primaire vient en premier", async () => {
    const { db, appels } = fauxDb({ data: [edition()], error: null });
    await listEditionLegalFooters(db, "asset_1", "S");

    const appel = appels[0]!;
    expect(appel.table).toBe("asset_edition");
    expect(appel.methodes.filter((m) => m.m === "eq").map((m) => m.args)).toEqual([
      ["asset_id", "asset_1"],
    ]);
    expect(appel.methodes.filter((m) => m.m === "order").map((m) => m.args[0])).toEqual([
      "is_primary",
      "created_at",
      "id",
    ]);
  });
});

describe("updateEditionLegalFooter — écrire chez soi, et savoir qu'on a écrit", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer le `.eq("asset_id", …)`.
   * Symptôme : l'id d'une édition appartenant à une AUTRE marque est accepté, et le pied légal de
   * cette marque-là est réécrit. Aucune erreur, aucun écran ne le montre — c'est la marque voisine
   * qui envoie soudain les mentions de celle-ci.
   */
  test("l'écriture est filtrée sur l'id ET la marque", async () => {
    const { db, appels } = fauxDb({ data: { id: "ed_1" }, error: null });
    await updateEditionLegalFooter(db, {
      editionId: "ed_1",
      assetId: "asset_1",
      cfg: { controller: "Example Media" },
    });

    expect(appels[0]!.methodes.filter((m) => m.m === "eq").map((m) => m.args)).toEqual([
      ["id", "ed_1"],
      ["asset_id", "asset_1"],
    ]);
  });

  test("la colonne est REMPLACÉE, pour qu'un champ vidé le soit vraiment", async () => {
    const { db, appels } = fauxDb({ data: { id: "ed_1" }, error: null });
    await updateEditionLegalFooter(db, { editionId: "ed_1", assetId: "a", cfg: { phone: "+1" } });

    const patch = appels[0]!.methodes.find((m) => m.m === "update")!.args[0] as Record<string, unknown>;
    expect(patch).toEqual({ legal_footer: { phone: "+1" } });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer le `.select()` et rendre `{ok:true}` sans regarder `data`.
   * Symptôme : poster sur une édition d'une autre marque répond « enregistré ». La personne ferme
   * l'écran en croyant sa mention légale posée ; elle ne l'est nulle part.
   */
  test("zéro ligne touchée n'est pas un enregistrement", async () => {
    const { db, appels } = fauxDb({ data: null, error: null });
    const r = await updateEditionLegalFooter(db, { editionId: "ed_x", assetId: "a", cfg: {} });

    expect(r).toEqual({ ok: false, status: 404, error: "edition not found" });
    expect(appels[0]!.methodes.some((m) => m.m === "select")).toBe(true);
  });

  test("une erreur d'écriture est rendue, pas avalée", async () => {
    const { db } = fauxDb({ data: null, error: { message: "conflit" } });
    expect(await updateEditionLegalFooter(db, { editionId: "e", assetId: "a", cfg: {} })).toEqual({
      ok: false,
      status: 500,
      error: "conflit",
    });
  });
});
