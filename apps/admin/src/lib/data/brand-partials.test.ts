/**
 * EN-TÊTE ET PIED DE MARQUE — LES GARDES QUE LE SERVEUR PORTE, ET QUE L'UI NE PEUT PAS PORTER.
 *
 * ⚠️ Aucun accès réseau : le client Supabase est un double qui enregistre les requêtes construites et
 * sert des réponses préparées. Ce qui est mesuré, c'est la REQUÊTE et la DÉCISION, pas ce que
 * PostgREST en ferait.
 */
import { describe, expect, test } from "bun:test";

// ⚠️ `brand-partials.ts` tire `@/lib/data/templates` (pour `isUuid`) → `@/lib/session` → `auth.ts`,
// qui LÈVE à l'import si AUTH_SECRET manque. Même parade que `campaigns.test.ts` : poser la
// variable, puis charger le module dynamiquement — un import statique serait hissé avant
// l'affectation et le fichier échouerait au chargement.
process.env.AUTH_SECRET = "secret-de-test-uniquement-13092026";
const {
  archiveBrandPartial,
  countTemplatesUsingPartial,
  resolveBrandPartials,
  updateBrandPartial,
  validateBrandPartialRows,
} = await import("./brand-partials");

type Appel = { table: string; methodes: { m: string; args: unknown[] }[] };
type Reponse = { data: unknown; error: unknown };

function fauxDb(...reponses: Reponse[]) {
  const appels: Appel[] = [];
  let i = 0;

  const db = {
    from(table: string) {
      const appel: Appel = { table, methodes: [] };
      appels.push(appel);

      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              const reponse = reponses[i++] ?? { data: null, error: null };
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

  return { db: db as unknown as Parameters<typeof archiveBrandPartial>[0], appels };
}

const filtres = (appel: Appel): [string, unknown][] =>
  appel.methodes.filter((m) => m.m === "eq").map((m) => [String(m.args[0]), m.args[1]]);

const ASSET = "asset_1";
const UUID_H = "11111111-1111-4111-8111-111111111111";
const UUID_F = "22222222-2222-4222-8222-222222222222";

const rowTexte = (id: string, texte = "T"): unknown => ({
  id,
  layout: "1",
  columns: [
    { id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: texte }] }] }] },
  ],
});

const rowLegale = (id = "legal"): unknown => ({
  id,
  layout: "1",
  columns: [{ id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "footer_legal" }] }],
});

const ligne = (over: Record<string, unknown> = {}) => ({
  id: UUID_H,
  slot: "header",
  name: "Main header",
  rows: [rowTexte("pf_head")],
  archived_at: null,
  updated_by: null,
  updated_at: "2026-09-13T00:00:00Z",
  created_at: "2026-09-13T00:00:00Z",
  ...over,
});

/* ------------------------------------------------------------------ *
 * Invariants 1 et 2 — validés À L'ÉCRITURE
 * ------------------------------------------------------------------ */

describe("validateBrandPartialRows — le schéma et la conformité, côté serveur", () => {
  test("des rows valides passent, et sortent NORMALISÉES par le schéma", () => {
    const r = validateBrandPartialRows([rowTexte("pf_head")]);
    expect(r.ok).toBe(true);
    // `preset` n'était pas dans l'entrée : le défaut du schéma a bien été appliqué avant stockage.
    expect(r.ok && (r.rows[0]!.columns[0]!.blocks[0] as { preset?: string }).preset).toBe("body");
  });

  /**
   * ⛔ INVARIANT 1. MUTATION QUI DOIT LE TUER : remplacer le `Row.safeParse` de
   * `validateBrandPartialRows` par un `rows.push(item as Row)`.
   * Symptôme en production : la forme non conforme est stockée telle quelle, et c'est la
   * COMPILATION du modèle qui pointe dessus qui échoue — des jours plus tard, sur un autre écran,
   * avec un message qui ne nomme ni le partial ni la personne qui l'a enregistré.
   */
  test("une row non conforme est refusée en 422, avec le chemin exact du défaut", () => {
    // `layout: "1-1"` exige DEUX colonnes ; il n'y en a qu'une.
    const bancale = { ...(rowTexte("x") as Record<string, unknown>), layout: "1-1" };
    const r = validateBrandPartialRows([bancale]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal.status).toBe(422);
    expect(!r.ok && r.refusal.issues?.some((i) => i.startsWith("rows.0."))).toBe(true);
  });

  /**
   * ⛔ INVARIANT 2. MUTATION QUI DOIT LE TUER : retirer le test `rows.some(rowCarriesFooterLegal)`.
   * Symptôme en production : le partial embarque le pied légal, qui compile vers
   * `{{legal_footer_html}}` ; l'e-mail en porte alors DEUX — deux mentions de désabonnement, dont
   * une que la plateforme n'a pas placée là où elle croit.
   */
  test("une row qui porte le pied légal est refusée en 422", () => {
    const r = validateBrandPartialRows([rowTexte("pf_head"), rowLegale()]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal.status).toBe(422);
    expect(!r.ok && /legal footer/i.test(r.refusal.error)).toBe(true);
  });

  test("un tableau vide n'est pas un en-tête", () => {
    expect(validateBrandPartialRows([]).ok).toBe(false);
  });

  test("ce qui n'est pas un tableau est refusé avant tout le reste", () => {
    expect(validateBrandPartialRows({ id: "pf_head" }).ok).toBe(false);
    expect(validateBrandPartialRows(null).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Résolution des pointeurs — ce que la compilation reçoit
 * ------------------------------------------------------------------ */

describe("resolveBrandPartials — honorer un pointeur, ou dire qu'on n'a pas su", () => {
  test("aucun pointeur : rien à résoudre, et la base n'est même pas interrogée", async () => {
    const { db, appels } = fauxDb();
    const r = await resolveBrandPartials(db, ASSET, {});
    expect(r).toEqual({ known: true, value: { header: [], footer: [], missing: [] } });
    expect(appels).toHaveLength(0);
  });

  /**
   * ⛔ LE TEST CENTRAL DE L'ARCHIVAGE. MUTATION QUI DOIT LE TUER : ajouter `.is("archived_at", null)`
   * à la requête de `resolveBrandPartials`.
   * Symptôme en production : archiver un en-tête est censé le retirer de la BIBLIOTHÈQUE. Avec ce
   * filtre, il disparaît aussi des modèles qui pointent déjà dessus — quatre newsletters perdraient
   * leur en-tête à leur prochaine publication, sans qu'aucun écran ne l'ait annoncé.
   */
  test("un partial ARCHIVÉ se résout encore : archiver n'est pas retirer des modèles", async () => {
    const { db, appels } = fauxDb({ data: [ligne({ archived_at: "2026-09-13T10:00:00Z" })], error: null });
    const r = await resolveBrandPartials(db, ASSET, { headerPartialId: UUID_H });

    expect(r.known).toBe(true);
    expect(r.value.header).toHaveLength(1);
    expect(appels[0]!.methodes.some((m) => m.m === "is")).toBe(false);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : rendre `{ known: true, ... }` quand la requête est en erreur.
   * Symptôme en production : le modèle se publierait SANS son en-tête de marque, et le HTML figé
   * partirait ainsi à toute la liste. Un e-mail expédié ne se rattrape pas.
   */
  test("une lecture en erreur n'est PAS « pas d'en-tête »", async () => {
    const { db } = fauxDb({ data: null, error: { message: "timeout" } });
    const r = await resolveBrandPartials(db, ASSET, { headerPartialId: UUID_H });
    expect(r.known).toBe(false);
    expect(r.value.missing).toEqual(["header"]);
  });

  test("un pointeur qui ne désigne aucune ligne rend known:false", async () => {
    const { db } = fauxDb({ data: [], error: null });
    const r = await resolveBrandPartials(db, ASSET, { footerPartialId: UUID_F });
    expect(r).toEqual({ known: false, value: { header: [], footer: [], missing: ["footer"] } });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer le contrôle `partial.slot !== slot`.
   * Symptôme en production : un pointeur d'en-tête qui vise un pied de page poserait le pied
   * éditorial EN HAUT de l'e-mail — personne n'a jamais demandé ça, et rien ne l'aurait signalé.
   */
  test("une fente qui ne correspond pas n'est pas honorée", async () => {
    const { db } = fauxDb({ data: [ligne({ slot: "footer" })], error: null });
    const r = await resolveBrandPartials(db, ASSET, { headerPartialId: UUID_H });
    expect(r.known).toBe(false);
    expect(r.value.header).toEqual([]);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : rendre les rows telles qu'elles sont stockées (`rows` au lieu de
   * `rows.map(withFreshRowIds)` dans `toBrandPartial`).
   * Symptôme en production : `pf_head` est le même id sur les quatre modèles Copper Kettle ; insérer
   * la row telle quelle pose un id déjà présent, et le reducer du builder rend `null` — l'insertion
   * échoue SANS message.
   */
  test("les rows sortent avec des ids NEUFS", async () => {
    const { db } = fauxDb({ data: [ligne()], error: null });
    const r = await resolveBrandPartials(db, ASSET, { headerPartialId: UUID_H });

    expect(r.value.header[0]!.id).not.toBe("pf_head");
    expect(r.value.header[0]!.id.startsWith("row_")).toBe(true);
    expect(r.value.header[0]!.columns[0]!.blocks[0]!.id).not.toBe("pf_head_b");
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : poser le préfixe `row` quelle que soit la fente.
   * Symptôme : la palette ne sait plus où finit le corps, et un clic pose le bloc DANS le footer importé.
   */
  test("les rows d'un pied sortent préfixées `ftr_`, celles d'un en-tête non", async () => {
    const { db } = fauxDb({ data: [ligne({ id: UUID_F, slot: "footer" })], error: null });
    const r = await resolveBrandPartials(db, ASSET, { footerPartialId: UUID_F });
    expect(r.known).toBe(true);
    expect(r.value.footer[0]!.id.startsWith("ftr_")).toBe(true);

    const h = await resolveBrandPartials(fauxDb({ data: [ligne()], error: null }).db, ASSET, { headerPartialId: UUID_H });
    expect(h.value.header[0]!.id.startsWith("ftr_")).toBe(false);
  });

  /** Le scope marque n'est pas une commodité : il vit dans la requête, pas dans l'écran. */
  test("la lecture est scopée sur la marque", async () => {
    const { db, appels } = fauxDb({ data: [ligne()], error: null });
    await resolveBrandPartials(db, ASSET, { headerPartialId: UUID_H });
    expect(appels[0]!.table).toBe("brand_partial");
    expect(filtres(appels[0]!)).toEqual([["asset_id", ASSET]]);
  });

  /**
   * Une ligne dont les rows ne parsent plus est INCONNUE, pas vide : la rendre vide publierait un
   * e-mail sans en-tête en croyant l'avoir appliqué.
   */
  test("des rows illisibles rendent known:false, jamais un tableau vide", async () => {
    const { db } = fauxDb({ data: [ligne({ rows: [{ id: "x", layout: "impossible", columns: [] }] })], error: null });
    const r = await resolveBrandPartials(db, ASSET, { headerPartialId: UUID_H });
    expect(r.known).toBe(false);
    expect(r.value.header).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Invariant 4 — on archive, on ne supprime pas
 * ------------------------------------------------------------------ */

describe("archiveBrandPartial — le pointeur ne doit jamais tomber dans le vide", () => {
  /**
   * ⛔ INVARIANT 4. MUTATION QUI DOIT LE TUER : remplacer l'`update({archived_at})` par un `delete()`.
   * Symptôme en production : des `template_version` déjà FIGÉS portent le pointeur vers cette ligne.
   * Détruite, chaque republication de ces modèles se retrouve incapable de résoudre son en-tête
   * (`known:false`), et la seule réparation est de rouvrir chaque modèle à la main.
   */
  test("la requête construite est un UPDATE qui pose archived_at — jamais un DELETE", async () => {
    const { db, appels } = fauxDb({ data: { id: UUID_H }, error: null });
    const r = await archiveBrandPartial(db, UUID_H, ASSET, "moi@example.com");

    expect(r).toEqual({ ok: true });
    const appel = appels[0]!;
    expect(appel.table).toBe("brand_partial");
    expect(appel.methodes.some((m) => m.m === "delete")).toBe(false);

    const update = appel.methodes.find((m) => m.m === "update");
    expect(update).toBeDefined();
    expect((update!.args[0] as { archived_at?: unknown }).archived_at).toBeTypeOf("string");
  });

  test("l'archivage est scopé sur l'id ET la marque, et ne rejoue pas un archivage déjà fait", async () => {
    const { db, appels } = fauxDb({ data: { id: UUID_H }, error: null });
    await archiveBrandPartial(db, UUID_H, ASSET, null);

    expect(filtres(appels[0]!)).toEqual([
      ["id", UUID_H],
      ["asset_id", ASSET],
    ]);
    expect(appels[0]!.methodes.some((m) => m.m === "is" && m.args[0] === "archived_at")).toBe(true);
  });

  test("une erreur d'écriture est rendue, pas avalée", async () => {
    const { db } = fauxDb({ data: null, error: { message: "conflit" } });
    expect(await archiveBrandPartial(db, UUID_H, ASSET, null)).toEqual({
      ok: false,
      status: 500,
      message: "conflit",
    });
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer le `.select()` de l'archivage.
   * Symptôme en production : archiver un partial DÉJÀ archivé — ou d'une autre marque — ne touche
   * aucune ligne, PostgREST ne lève pas, et la fonction répond « archivé ». L'écran affiche un
   * succès pour un geste qui n'a rien fait, et l'objet reste dans la bibliothèque.
   */
  test("zéro ligne touchée n'est pas un archivage réussi", async () => {
    const { db, appels } = fauxDb({ data: null, error: null });
    expect(await archiveBrandPartial(db, UUID_H, ASSET, null)).toEqual({
      ok: false,
      status: 404,
      message: "brand partial not found",
    });
    // La requête doit demander à voir ce qu'elle a écrit, sinon elle ne peut pas le savoir.
    expect(appels[0]!.methodes.some((m) => m.m === "select")).toBe(true);
  });

  test("un id qui n'est pas un uuid n'atteint jamais la base", async () => {
    const { db, appels } = fauxDb({ data: { id: "x" }, error: null });
    expect(await archiveBrandPartial(db, "pas-un-uuid", ASSET, null)).toEqual({
      ok: false,
      status: 404,
      message: "brand partial not found",
    });
    expect(appels).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Édition d'un partial — le compare-and-swap, et le `.select()` qui dit la vérité
 * ------------------------------------------------------------------ */

describe("updateBrandPartial — enregistrer sans écraser le travail d'un autre", () => {
  const ROW = rowTexte("r1") as never;

  test("le patch porte le nom, les rows et l'auteur, scopé sur l'id ET la marque", async () => {
    const { db, appels } = fauxDb({ data: { updated_at: "2026-09-15T18:00:00Z" }, error: null });
    const r = await updateBrandPartial(db, {
      id: UUID_H,
      assetId: ASSET,
      name: "Header PF",
      rows: [ROW],
      author: "moi@example.com",
    });

    expect(r).toEqual({ ok: true, updatedAt: "2026-09-15T18:00:00Z" });
    const appel = appels[0]!;
    const patch = appel.methodes.find((m) => m.m === "update")!.args[0] as Record<string, unknown>;
    expect(patch.name).toBe("Header PF");
    expect(patch.rows).toEqual([ROW]);
    expect(patch.updated_by).toBe("moi@example.com");
    expect(filtres(appel)).toEqual([
      ["id", UUID_H],
      ["asset_id", ASSET],
    ]);
    // Un partial archivé entre la lecture et l'écriture ne doit pas être ressuscité.
    expect(appel.methodes.some((m) => m.m === "is" && m.args[0] === "archived_at")).toBe(true);
  });

  test("ce qui n'est pas fourni n'est pas écrit — renommer n'efface pas les rows", async () => {
    const { db, appels } = fauxDb({ data: { updated_at: "t" }, error: null });
    await updateBrandPartial(db, { id: UUID_H, assetId: ASSET, name: "Autre nom", author: null });

    const patch = appels[0]!.methodes.find((m) => m.m === "update")!.args[0] as Record<string, unknown>;
    expect(patch.name).toBe("Autre nom");
    expect("rows" in patch).toBe(false);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : supprimer le `.eq("updated_at", baseUpdatedAt)`.
   * Symptôme en production : deux personnes ouvrent le même en-tête — il sert quatre newsletters,
   * c'est le cas normal. Le second enregistrement écrase le premier SANS que rien ne le dise, et
   * le travail perdu ne se voit qu'à la publication suivante.
   */
  test("baseUpdatedAt devient un filtre sur updated_at — le compare-and-swap est dans la REQUÊTE", async () => {
    const { db, appels } = fauxDb({ data: { updated_at: "t2" }, error: null });
    await updateBrandPartial(db, {
      id: UUID_H,
      assetId: ASSET,
      name: "N",
      author: null,
      baseUpdatedAt: "2026-09-15T17:00:00Z",
    });

    expect(filtres(appels[0]!)).toEqual([
      ["id", UUID_H],
      ["asset_id", ASSET],
      ["updated_at", "2026-09-15T17:00:00Z"],
    ]);
  });

  test("sans baseUpdatedAt, aucun filtre sur updated_at n'est posé", async () => {
    const { db, appels } = fauxDb({ data: { updated_at: "t" }, error: null });
    await updateBrandPartial(db, { id: UUID_H, assetId: ASSET, name: "N", author: null });

    expect(filtres(appels[0]!).some(([col]) => col === "updated_at")).toBe(false);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : retirer le `.select()` et rendre `{ok:true}` sans regarder `data`.
   * Symptôme : le compare-and-swap ne sert plus à rien. Il filtre bien, donc rien n'est écrasé —
   * mais la route répond « enregistré », l'écran ferme l'éditeur, et le travail est perdu en
   * silence. Un garde qui refuse sans le dire est pire qu'une absence de garde.
   */
  test("zéro ligne touchée avec un baseUpdatedAt périmé ⇒ 409, jamais « enregistré »", async () => {
    const { db } = fauxDb(
      { data: null, error: null }, // l'update ne touche rien
      { data: ligne(), error: null }, // la relecture le retrouve : il existe, quelqu'un l'a modifié
    );
    const r = await updateBrandPartial(db, {
      id: UUID_H,
      assetId: ASSET,
      name: "N",
      author: null,
      baseUpdatedAt: "horodatage-perime",
    });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.refusal.status).toBe(409);
    expect(r.ok === false && r.refusal.error).toMatch(/changed somewhere else/);
  });

  /**
   * ⛔ Le 409 et le 404 ne se confondent pas. Dire « quelqu'un l'a modifié » sur un partial ARCHIVÉ
   * enverrait l'auteur recharger une page qui ne montrera plus rien.
   */
  test("zéro ligne touchée sur un partial disparu ⇒ 404, pas un conflit d'édition", async () => {
    const { db } = fauxDb(
      { data: null, error: null }, // l'update ne touche rien
      { data: null, error: null }, // la relecture ne le retrouve pas : archivé ou autre marque
    );
    const r = await updateBrandPartial(db, {
      id: UUID_H,
      assetId: ASSET,
      name: "N",
      author: null,
      baseUpdatedAt: "peu-importe",
    });

    expect(r.ok === false && r.refusal.status).toBe(404);
  });

  test("une lecture ratée pendant le diagnostic rend 503, jamais un verdict inventé", async () => {
    const { db } = fauxDb(
      { data: null, error: null },
      { data: null, error: { message: "base injoignable" } },
    );
    const r = await updateBrandPartial(db, { id: UUID_H, assetId: ASSET, name: "N", author: null });

    expect(r.ok === false && r.refusal.status).toBe(503);
  });

  test("un nom déjà pris rend 409, pas 500", async () => {
    const { db } = fauxDb({ data: null, error: { code: "23505", message: "duplicate" } });
    const r = await updateBrandPartial(db, { id: UUID_H, assetId: ASSET, name: "Pris", author: null });

    expect(r.ok === false && r.refusal.status).toBe(409);
    expect(r.ok === false && r.refusal.error).toMatch(/already has that name/);
  });

  test("un id qui n'est pas un uuid n'atteint jamais la base", async () => {
    const { db, appels } = fauxDb({ data: { updated_at: "t" }, error: null });
    const r = await updateBrandPartial(db, { id: "pas-un-uuid", assetId: ASSET, name: "N", author: null });

    expect(r.ok === false && r.refusal.status).toBe(404);
    expect(appels).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * « Used by N templates » — une phrase que la base doit pouvoir soutenir
 * ------------------------------------------------------------------ */

describe("countTemplatesUsingPartial", () => {
  /**
   * ⛔ MUTATION QUI DOIT LE TUER : rendre `{ known: true, value: 0 }` quand une des lectures échoue.
   * Symptôme en production : l'écran affiche « used by 0 templates » à côté d'un bouton
   * « Archive » — et la personne archive un en-tête qui sert quatre newsletters.
   */
  test("une lecture ratée n'est pas un compte de zéro", async () => {
    const { db } = fauxDb({ data: null, error: { message: "timeout" } });
    expect(await countTemplatesUsingPartial(db, ASSET, UUID_H)).toEqual({ known: false, value: 0 });
  });

  test("l'échec de la seconde lecture compte autant que celui de la première", async () => {
    const { db } = fauxDb(
      { data: [{ id: "t1" }], error: null },
      { data: [], error: null },
      { data: null, error: { message: "timeout" } },
    );
    expect((await countTemplatesUsingPartial(db, ASSET, UUID_H)).known).toBe(false);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : compter les LIGNES rendues au lieu des `template_id` DISTINCTS.
   * Symptôme : un modèle qui porte le pointeur sur son brouillon et sur trois versions publiées
   * serait annoncé « used by 4 templates » alors qu'il n'y en a qu'un.
   */
  test("compte des MODÈLES distincts, pas des versions", async () => {
    const { db } = fauxDb(
      { data: [{ id: "t1" }, { id: "t2" }], error: null },
      { data: [{ template_id: "t1" }, { template_id: "t1" }, { template_id: "t2" }], error: null },
      { data: [{ template_id: "t1" }], error: null },
    );
    expect(await countTemplatesUsingPartial(db, ASSET, UUID_H)).toEqual({ known: true, value: 2 });
  });

  test("aucun modèle vivant dans la marque : zéro, et on le sait vraiment", async () => {
    const { db, appels } = fauxDb({ data: [], error: null });
    expect(await countTemplatesUsingPartial(db, ASSET, UUID_H)).toEqual({ known: true, value: 0 });
    expect(appels).toHaveLength(1);
  });

  /** Les deux fentes sont interrogées : un partial peut être pointé comme en-tête ou comme pied. */
  test("les deux pointeurs sont cherchés", async () => {
    const { db, appels } = fauxDb(
      { data: [{ id: "t1" }], error: null },
      { data: [], error: null },
      { data: [], error: null },
    );
    await countTemplatesUsingPartial(db, ASSET, UUID_H);
    const cles = appels.slice(1).flatMap((a) => filtres(a).map(([c]) => c));
    expect(cles).toEqual(["doc->meta->>headerPartialId", "doc->meta->>footerPartialId"]);
  });
});
