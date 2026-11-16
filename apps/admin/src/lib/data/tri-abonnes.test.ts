import { describe, expect, test } from "bun:test";
import {
  libelleDuTri,
  ordreDuTri,
  TRIS_ABONNES,
  TRI_PAR_DEFAUT,
  triDemande,
} from "@/lib/data/tri-abonnes";

/**
 * L'ORDRE DE LA LISTE DES ABONNÉS.
 *
 * Ce qui peut casser en silence ici :
 *  1. UNE VALEUR D'URL QUI ATTEINT LA BASE. `?sort=` arrive de l'extérieur ; s'il devenait un nom
 *     de colonne dans un `.order()`, PostgREST répondrait en erreur et le composant serveur
 *     planterait — sur un chemin qu'aucun clic normal n'emprunte, donc invisible jusqu'au jour où
 *     un lien mal recopié traîne dans un e-mail interne.
 *  2. UNE COLONNE SUR UNE TABLE JOINTE. Trier sur `subscriber.email` fait perdre la pagination :
 *     la page 2 cesse d'être la suite de la page 1, et personne ne le voit puisque les deux pages
 *     affichent des lignes plausibles.
 */
describe("triDemande — rien de l'URL n'atteint la requête", () => {
  test("accepte les tris connus", () => {
    for (const t of TRIS_ABONNES) expect(triDemande(t.cle)).toBe(t.cle);
  });

  test("une valeur inconnue retombe sur le défaut", () => {
    expect(triDemande("engagement_score; drop table")).toBe(TRI_PAR_DEFAUT);
    expect(triDemande("email")).toBe(TRI_PAR_DEFAUT);
    expect(triDemande("")).toBe(TRI_PAR_DEFAUT);
  });

  test("absent = défaut", () => {
    expect(triDemande(undefined)).toBe(TRI_PAR_DEFAUT);
    expect(triDemande(null)).toBe(TRI_PAR_DEFAUT);
  });
});

describe("ordreDuTri — la colonne et le sens réellement posés", () => {
  test("le défaut reste l'ordre historique de la liste", () => {
    // ⛔ Changer le défaut en même temps qu'on ouvre le menu ferait croire à un bug d'affichage à
    // tous ceux qui connaissaient déjà cette liste.
    expect(TRI_PAR_DEFAUT).toBe("engagement");
    expect(ordreDuTri(TRI_PAR_DEFAUT)).toEqual({ colonne: "engagement_score", ascendant: false });
  });

  test("« newest » et « oldest » lisent la même colonne dans les deux sens", () => {
    expect(ordreDuTri("newest")).toEqual({ colonne: "created_at", ascendant: false });
    expect(ordreDuTri("oldest")).toEqual({ colonne: "created_at", ascendant: true });
  });

  test("AUCUNE colonne n'est sur une table jointe", () => {
    // Un point dans le nom trahirait un `subscriber.email` : PostgREST l'accepterait, et la
    // pagination deviendrait fausse sans qu'aucune erreur ne soit levée.
    for (const t of TRIS_ABONNES) expect(t.colonne).not.toContain(".");
  });

  test("chaque tri proposé a une colonne et un libellé", () => {
    for (const t of TRIS_ABONNES) {
      expect(t.colonne.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
      expect(libelleDuTri(t.cle)).toBe(t.label);
    }
  });

  test("les clés sont uniques — deux entrées de même clé rendraient le menu ambigu", () => {
    const cles = TRIS_ABONNES.map((t) => t.cle);
    expect(new Set(cles).size).toBe(cles.length);
  });
});
