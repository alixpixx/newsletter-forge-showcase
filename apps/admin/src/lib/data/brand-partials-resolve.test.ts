/**
 * Banc de `resolveBrandPartials` — la moitié ADMIN de la résolution, celle qui décide si une
 * publication, un envoi de test ou un rattachement de cycle de vie a le droit d'aboutir.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER : qu'un e-mail se compile SANS son en-tête de marque avec
 * un `known: true` — donc une publication en 200, un écran vert, et le défaut visible seulement
 * dans la boîte de réception. Les appelants ne regardent que `known` : tout ce qui rend `known`
 * vrai à tort est une régression silencieuse, et rien d'autre ne la rattrape.
 */
import { describe, expect, test } from "bun:test";

// ⚠️ La chaîne d'imports tire `auth.ts`, qui LÈVE si `AUTH_SECRET` manque : poser la variable PUIS
// charger le module dynamiquement — un import statique serait hissé avant l'affectation.
process.env.AUTH_SECRET = "secret-de-test-uniquement-15092026";
const { resolveBrandPartials } = await import("./brand-partials");

type Db = Parameters<typeof resolveBrandPartials>[0];

const ID_HEADER = "11111111-1111-4111-8111-111111111111";
const ID_FOOTER = "22222222-2222-4222-8222-222222222222";

const rowTexte = (id: string, texte: string): unknown => ({
  id,
  layout: "1",
  columns: [
    { id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: texte }] }] }] },
  ],
});

/** Une ligne de `brand_partial` telle que PostgREST la rend, avec les colonnes du SELECT. */
const ligne = (over: Record<string, unknown> = {}) => ({
  id: ID_HEADER,
  slot: "header",
  name: "Copper Kettle header",
  rows: [rowTexte("pf_head", "Copper Kettle")],
  archived_at: null,
  updated_by: "claude",
  updated_at: "2026-09-15T13:00:00Z",
  created_at: "2026-09-15T13:00:00Z",
  ...over,
});

/**
 * Faux client : le constructeur de requête de PostgREST est *thenable*, c'est ce qui permet
 * `await db.from(...).select(...).eq(...)`. On rejoue cette forme, pas une promesse déjà résolue.
 */
function fauxDb(reponse: { data?: unknown[] | null; error?: unknown }): { db: Db; vu: { filtres: string[] } } {
  const vu = { filtres: [] as string[] };
  const chaine = {
    select: () => chaine,
    eq: (col: string) => {
      vu.filtres.push(col);
      return chaine;
    },
    in: (col: string) => {
      vu.filtres.push(col);
      return chaine;
    },
    is: (col: string) => {
      vu.filtres.push(col);
      return chaine;
    },
    then: (resolve: (v: { data: unknown[] | null; error: unknown }) => unknown) =>
      resolve({ data: reponse.data ?? null, error: reponse.error ?? null }),
  };
  return { db: { from: () => chaine } as unknown as Db, vu };
}

describe("resolveBrandPartials — ce qui a le droit d'aboutir", () => {
  test("aucun pointeur : rien à résoudre, et la base n'est même pas interrogée", async () => {
    const { db, vu } = fauxDb({ data: [] });
    const r = await resolveBrandPartials(db, "asset_1", {});
    expect(r.known).toBe(true);
    expect(r.value.missing).toEqual([]);
    expect(vu.filtres).toEqual([]);
  });

  test("un pointeur honoré rend les rows, et `known` est vrai", async () => {
    const { db } = fauxDb({ data: [ligne()] });
    const r = await resolveBrandPartials(db, "asset_1", { headerPartialId: ID_HEADER });
    expect(r.known).toBe(true);
    expect(r.value.header).toHaveLength(1);
    expect(r.value.missing).toEqual([]);
  });

  test("⛔ un partial dont `rows` est VIDE rend `known: false`, jamais un en-tête vide accepté", async () => {
    /*
     * LE test de ce banc. Un tableau vide rendu comme résolu donnerait `known: true` avec
     * `header: []`, et `applyBrandPartials` ne dit RIEN d'un tableau vide — il n'avertit que sur
     * `undefined`. La publication répondrait 200 et l'e-mail partirait sans son en-tête.
     *
     * La route de création refuse déjà `rows: []` ; une écriture SQL directe, non — et c'est par là
     * que les en-têtes de production ont été créés.
     */
    const { db } = fauxDb({ data: [ligne({ rows: [] })] });
    const r = await resolveBrandPartials(db, "asset_1", { headerPartialId: ID_HEADER });
    expect(r.known).toBe(false);
    expect(r.value.missing).toEqual(["header"]);
    expect(r.value.header).toEqual([]);
  });

  test("⛔ la fente doit correspondre : un pointeur d'en-tête vers un PIED est un refus", async () => {
    const { db } = fauxDb({ data: [ligne({ slot: "footer" })] });
    const r = await resolveBrandPartials(db, "asset_1", { headerPartialId: ID_HEADER });
    expect(r.known).toBe(false);
    expect(r.value.missing).toEqual(["header"]);
  });

  test("⛔ une LECTURE EN PANNE rend `known: false` — pas une bibliothèque vide", async () => {
    // « La base n'a pas répondu » et « ce modèle n'a pas d'en-tête » ne doivent pas emprunter le
    // même chemin : le premier doit retenir la publication, le second non.
    const { db } = fauxDb({ error: { message: "connexion refusée" } });
    const r = await resolveBrandPartials(db, "asset_1", { headerPartialId: ID_HEADER });
    expect(r.known).toBe(false);
    expect(r.value.missing).toEqual(["header"]);
  });

  test("une ligne ABSENTE de la lecture est un refus", async () => {
    const { db } = fauxDb({ data: [] });
    const r = await resolveBrandPartials(db, "asset_1", { headerPartialId: ID_HEADER });
    expect(r.known).toBe(false);
    expect(r.value.missing).toEqual(["header"]);
  });

  test("⛔ un partial ARCHIVÉ se résout quand même — archiver ne retire pas l'en-tête des modèles", async () => {
    // Filtrer l'archivage ici ferait disparaître l'en-tête de plusieurs newsletters à leur
    // prochaine publication, sans qu'aucun écran ne l'ait annoncé.
    const { db, vu } = fauxDb({ data: [ligne({ archived_at: "2026-09-15T00:00:00Z" })] });
    const r = await resolveBrandPartials(db, "asset_1", { headerPartialId: ID_HEADER });
    expect(r.known).toBe(true);
    expect(r.value.header).toHaveLength(1);
    expect(vu.filtres).not.toContain("archived_at");
  });

  test("les deux fentes sont jugées séparément, et `known` tombe dès que l'une manque", async () => {
    const { db } = fauxDb({ data: [ligne()] });
    const r = await resolveBrandPartials(db, "asset_1", {
      headerPartialId: ID_HEADER,
      footerPartialId: ID_FOOTER,
    });
    expect(r.value.header).toHaveLength(1);
    expect(r.value.missing).toEqual(["footer"]);
    expect(r.known).toBe(false);
  });

  test("un pointeur mal formé est refusé sans interroger la base", async () => {
    const { db, vu } = fauxDb({ data: [ligne()] });
    const r = await resolveBrandPartials(db, "asset_1", { headerPartialId: "pas-un-uuid" });
    expect(r.known).toBe(false);
    expect(vu.filtres).toEqual([]);
  });

  test("⛔ le cloisonnement par marque est bien un filtre de la requête", async () => {
    // Sans `asset_id`, l'en-tête d'une marque pourrait se poser sur la newsletter d'une autre.
    const { db, vu } = fauxDb({ data: [ligne()] });
    await resolveBrandPartials(db, "asset_1", { headerPartialId: ID_HEADER });
    expect(vu.filtres).toContain("asset_id");
    expect(vu.filtres).toContain("id");
  });
});
