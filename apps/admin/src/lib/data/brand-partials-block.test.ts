/**
 * LA TROISIÈME FENTE — `brand_partial.slot = 'block'` (migration 0080).
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER :
 *  1. qu'une seule ligne `block` rende TOUTE la bibliothèque de la marque illisible (`known: false`,
 *     donc 503 sur les en-têtes et les pieds aussi) — c'est ce que fait une liste de fentes fermée ;
 *  2. qu'un bloc sorte préfixé `ftr_` : inséré au milieu du corps, il serait pris pour le début du
 *     pied, et les rows suivantes passeraient au-dessus de lui ;
 *  3. qu'un pointeur d'en-tête ou de pied qui désigne un bloc soit honoré : le bloc serait posé en
 *     tête de l'e-mail sans que personne ne l'ait demandé.
 *
 * ⚠️ Aucun accès réseau : le client Supabase est le double de `@/lib/testing/faux-db`.
 */
import { describe, expect, test } from "bun:test";
import { fauxDb, type ReponseDb } from "@/lib/testing/faux-db";

// ⚠️ `brand-partials.ts` tire `@/lib/session` → `auth.ts`, qui LÈVE à l'import sans AUTH_SECRET.
process.env.AUTH_SECRET = "secret-de-test-uniquement-23092026";
const {
  MAX_BRAND_PARTIAL_ROWS,
  isBrandPartialSlot,
  isPositionedSlot,
  listBrandPartials,
  resolveBrandPartials,
  validateBrandPartialRows,
} = await import("./brand-partials");

type Db = Parameters<typeof listBrandPartials>[0];

const ASSET = "asset_1";
const UUID_BLOC = "33333333-3333-4333-8333-333333333333";
const UUID_HEADER = "11111111-1111-4111-8111-111111111111";

const rowTexte = (id: string, texte = "T"): unknown => ({
  id,
  layout: "1",
  columns: [
    { id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: texte }] }] }] },
  ],
});

const rowLegale = (): unknown => ({
  id: "legal",
  layout: "1",
  columns: [{ id: "legal_c", blocks: [{ id: "legal_b", type: "footer_legal" }] }],
});

const ligne = (over: Record<string, unknown> = {}) => ({
  id: UUID_BLOC,
  slot: "block",
  name: "Podcast · Poster",
  rows: [rowTexte("pod_1"), rowTexte("pod_2")],
  archived_at: null,
  updated_by: null,
  updated_at: "2026-09-23T00:00:00Z",
  created_at: "2026-09-23T00:00:00Z",
  ...over,
});

const r = (data: unknown, error: unknown = null): ReponseDb => ({ data, error });

describe("les fentes", () => {
  test("`block` est une fente de la bibliothèque, mais PAS une fente à place fixe", () => {
    expect(isBrandPartialSlot("block")).toBe(true);
    expect(isPositionedSlot("block")).toBe(false);
    // Témoins : les deux fentes historiques restent à place fixe, une valeur inconnue n'est rien.
    expect(isPositionedSlot("header")).toBe(true);
    expect(isPositionedSlot("footer")).toBe(true);
    expect(isBrandPartialSlot("sidebar")).toBe(false);
  });
});

describe("validateBrandPartialRows — un bloc passe les mêmes gardes que l'en-tête et le pied", () => {
  const n = (k: number) => Array.from({ length: k }, (_, i) => rowTexte(`r${i}`));

  test("1 row et 20 rows passent ; 0 et 21 sont refusées en 422", () => {
    expect(validateBrandPartialRows(n(1)).ok).toBe(true);
    expect(validateBrandPartialRows(n(MAX_BRAND_PARTIAL_ROWS)).ok).toBe(true);
    const vide = validateBrandPartialRows([]);
    const trop = validateBrandPartialRows(n(MAX_BRAND_PARTIAL_ROWS + 1));
    expect(!vide.ok && vide.refusal.status).toBe(422);
    expect(!trop.ok && trop.refusal.status).toBe(422);
  });

  test("le pied légal est refusé dans un bloc comme ailleurs, avec un message qui nomme le bloc", () => {
    const v = validateBrandPartialRows([rowTexte("a"), rowLegale()]);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.refusal.status).toBe(422);
    expect(!v.ok && v.refusal.error.includes("block")).toBe(true);
  });
});

describe("listBrandPartials — une ligne `block` est lisible", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer `"block"` de `BRAND_PARTIAL_SLOTS`.
   * Symptôme en production : la première ligne `block` écrite rend la bibliothèque ENTIÈRE illisible
   * (503), en-têtes et pieds compris — l'import de header casse le jour où l'on crée un bloc.
   */
  test("une bibliothèque qui mêle en-tête et bloc rend `known: true`, avec la fente de chacun", async () => {
    const f = fauxDb<Db>(r([ligne(), ligne({ id: UUID_HEADER, slot: "header", name: "Header", rows: [rowTexte("h")] })]));
    const lu = await listBrandPartials(f.db, ASSET);
    expect(lu.known).toBe(true);
    expect(lu.value.map((p) => p.slot)).toEqual(["block", "header"]);
    expect(lu.value[0]!.rows).toHaveLength(2);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : préfixer `ftr` tout ce qui n'est pas un en-tête
   * (`r.slot !== "header"` au lieu de `r.slot === "footer"`).
   */
  test("les rows d'un bloc sortent avec des ids NEUFS préfixés `row_`, jamais `ftr_`", async () => {
    const f = fauxDb<Db>(r([ligne()]));
    const [bloc] = (await listBrandPartials(f.db, ASSET)).value;
    const ids = bloc!.rows.map((row) => row.id);
    expect(ids.every((id) => id.startsWith("row_"))).toBe(true);
    expect(ids.some((id) => id.startsWith("ftr_"))).toBe(false);
    expect(ids.includes("pod_1")).toBe(false);
    expect(bloc!.rows[0]!.columns[0]!.blocks[0]!.id === "pod_1_b").toBe(false);
  });
});

describe("resolveBrandPartials — un pointeur ne désigne jamais un bloc", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer le contrôle `partial.slot !== slot`.
   * Symptôme en production : un `headerPartialId` qui vise un bloc poserait ce bloc EN HAUT de
   * l'e-mail, et la publication répondrait 200.
   */
  test("un `headerPartialId` qui désigne un bloc sort `missing: ['header']`", async () => {
    const f = fauxDb<Db>(r([ligne()]));
    const res = await resolveBrandPartials(f.db, ASSET, { headerPartialId: UUID_BLOC });
    expect(res.known).toBe(false);
    expect(res.value.missing).toEqual(["header"]);
    expect(res.value.header).toEqual([]);
  });

  test("un `footerPartialId` qui désigne un bloc sort `missing: ['footer']`", async () => {
    const f = fauxDb<Db>(r([ligne()]));
    const res = await resolveBrandPartials(f.db, ASSET, { footerPartialId: UUID_BLOC });
    expect(res.known).toBe(false);
    expect(res.value.missing).toEqual(["footer"]);
  });

  test("témoin : la même ligne en fente `header` est honorée — le refus vient bien de la fente", async () => {
    const f = fauxDb<Db>(r([ligne({ slot: "header" })]));
    const res = await resolveBrandPartials(f.db, ASSET, { headerPartialId: UUID_BLOC });
    expect(res.known).toBe(true);
    expect(res.value.header).toHaveLength(2);
  });
});
