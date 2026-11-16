/**
 * Banc de l'EXTRACTION — quelle row d'un modèle devient un en-tête, et laquelle ne doit jamais l'être.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER : qu'on promeuve la row du PIED LÉGAL en « pied de marque ».
 * Elle compile vers `{{legal_footer_html}}`, que le worker remplit avec les liens de désabonnement
 * SIGNÉS du destinataire. Copiée dans un partial puis réinjectée, elle créerait une deuxième mention
 * de désabonnement — dont un lien non signé, donc mort. L'e-mail partirait, l'écran serait vert.
 */
import { describe, expect, test } from "bun:test";

// ⚠️ `brand-partials.ts` tire `@/lib/data/templates` (pour `isUuid`) → `@/lib/session` → `auth.ts`,
// qui LÈVE à l'import si AUTH_SECRET manque. Même parade que le banc voisin : poser la variable,
// puis charger le module DYNAMIQUEMENT — un import statique serait hissé avant l'affectation.
process.env.AUTH_SECRET = "secret-de-test-uniquement-15092026";
const { rowAPromouvoir } = await import("./brand-partials");

const rowTexte = (id: string, texte: string) => ({
  id,
  layout: "1",
  columns: [
    { id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "text", paragraphs: [{ spans: [{ text: texte }] }] }] },
  ],
});

const rowLegale = (id = "legal") => ({
  id,
  layout: "1",
  columns: [{ id: `${id}_c`, blocks: [{ id: `${id}_b`, type: "footer_legal" }] }],
});

const doc = (rows: unknown[]) => ({ rows });

describe("rowAPromouvoir — en-tête", () => {
  test("prend la PREMIÈRE row du document", () => {
    const r = rowAPromouvoir(doc([rowTexte("head", "Logo"), rowTexte("corps", "Article")]), "header");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.id).toBe("head");
  });

  test("⛔ refuse quand la première row EST le pied légal, au lieu de le promouvoir", () => {
    const r = rowAPromouvoir(doc([rowLegale(), rowTexte("corps", "Article")]), "header");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.error).toContain("legal footer");
  });
});

describe("rowAPromouvoir — pied éditorial", () => {
  test("prend la row JUSTE AVANT le pied légal, jamais le pied légal", () => {
    const r = rowAPromouvoir(
      doc([rowTexte("head", "Logo"), rowTexte("corps", "Article"), rowTexte("pied", "Suivez-nous"), rowLegale()]),
      "footer",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.id).toBe("pied");
  });

  test("sans pied légal dans le document, prend la DERNIÈRE row — là où il se serait trouvé", () => {
    const r = rowAPromouvoir(doc([rowTexte("head", "Logo"), rowTexte("pied", "Suivez-nous")]), "footer");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.id).toBe("pied");
  });

  test("⛔ un document qui COMMENCE par son pied légal n'a rien à lever au-dessus", () => {
    const r = rowAPromouvoir(doc([rowLegale(), rowTexte("corps", "Article")]), "footer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.error).toContain("no editorial footer");
  });
});

describe("rowAPromouvoir — l'index désigne le DOCUMENT, pas les rows lisibles", () => {
  // ⛔ CE QUE CE BLOC EXISTE POUR EMPÊCHER. La fonction filtrait les rows illisibles puis rendait son
  // choix sans dire OÙ il se trouvait ; l'appelant n'avait que le rang dans le tableau FILTRÉ. Dès
  // qu'une row plus haut ne parse plus, ce rang désigne une AUTRE ligne du document — et c'est cette
  // ligne-là qu'on retirerait en croyant retirer l'en-tête.
  test("une row illisible EN TÊTE décale l'index rendu, et c'est celui du document", () => {
    const r = rowAPromouvoir(doc([{ pas: "une row" }, rowTexte("head", "Logo"), rowTexte("corps", "Article")]), "header");
    expect(r.ok).toBe(true);
    // Rang dans les rows lisibles : 0. Position réelle dans `doc.rows` : 1. C'est la seconde qui vaut.
    if (r.ok) expect([r.row.id, r.index]).toEqual(["head", 1]);
  });

  test("sans row illisible, l'index est celui qu'on attend", () => {
    const r = rowAPromouvoir(doc([rowTexte("head", "Logo"), rowTexte("corps", "Article")]), "header");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.index).toBe(0);
  });

  test("pied éditorial : deux rows illisibles avant lui, l'index reste celui du document", () => {
    const r = rowAPromouvoir(
      doc([{ pas: "une row" }, { non: "plus" }, rowTexte("head", "Logo"), rowTexte("pied", "Suivez-nous"), rowLegale()]),
      "footer",
    );
    expect(r.ok).toBe(true);
    // Rang filtré du pied : 1. Position réelle : 3.
    if (r.ok) expect([r.row.id, r.index]).toEqual(["pied", 3]);
  });
});

describe("rowAPromouvoir — documents qu'on ne peut pas lire", () => {
  test("un document sans rows est refusé, pas traité comme vide", () => {
    for (const d of [null, undefined, {}, { rows: [] }, { rows: "pas un tableau" }]) {
      const r = rowAPromouvoir(d, "header");
      expect(r.ok).toBe(false);
    }
  });

  test("⛔ une row illisible AILLEURS n'empêche pas de lever un en-tête sain", () => {
    // Refuser tout le modèle parce que sa troisième row a vieilli interdirait de récupérer un
    // en-tête parfaitement valide — et c'est justement sur les vieux modèles qu'on veut le faire.
    const r = rowAPromouvoir(doc([rowTexte("head", "Logo"), { pas: "une row" }]), "header");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.id).toBe("head");
  });

  test("un document dont AUCUNE row ne parse est refusé avec sa raison propre", () => {
    const r = rowAPromouvoir(doc([{ pas: "une row" }]), "header");
    expect(r.ok).toBe(false);
    // ⚠️ La raison doit distinguer « ce modèle n'a pas de rows » de « ses rows sont illisibles » :
    // les deux mènent au même refus, pas au même geste de réparation.
    if (!r.ok) expect(r.refusal.error).toContain("none of this template's rows could be read");
  });
});
