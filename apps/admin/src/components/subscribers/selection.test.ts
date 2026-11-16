import { describe, expect, test } from "bun:test";
import { cleDeSelection, ecrireSelection, lireSelection } from "@/components/subscribers/selection";

/**
 * LA SÉLECTION QUI SURVIT À UNE NAVIGATION — les deux règles qui se trompent en silence.
 *
 *  1. LE CLOISONNEMENT PAR MARQUE. S'il saute, une sélection faite sur une marque reste cochée
 *     après bascule et porte des identifiants d'une autre marque : les routes rejettent tout en
 *     `no-match` pendant que l'écran annonce fièrement « 20 selected ».
 *  2. LA RELECTURE TOLÉRANTE. Ce qui sort du stockage a pu être écrit par une version précédente de
 *     l'écran, tronqué, ou modifié à la main. Une exception ici blanchirait la page des abonnés ;
 *     une valeur à moitié lue ferait AGIR sur des lignes que personne n'a cochées.
 */
describe("cleDeSelection — une marque, une sélection", () => {
  test("deux marques ne partagent jamais la même clé", () => {
    expect(cleDeSelection("asset_a")).not.toBe(cleDeSelection("asset_b"));
  });

  test("la marque non résolue a sa propre clé, elle n'écrit pas dans celle d'une vraie marque", () => {
    const sansMarque = cleDeSelection(null);
    expect(sansMarque).not.toBe(cleDeSelection("asset_a"));
    // Et elle reste stable d'un rendu à l'autre, sinon la sélection se perdrait à chaque re-rendu.
    expect(cleDeSelection(null)).toBe(sansMarque);
  });

  test("la clé porte l'identifiant de la marque, pour être reconnaissable dans l'inspecteur", () => {
    expect(cleDeSelection("asset_a")).toContain("asset_a");
  });
});

describe("lireSelection — rien de ce qui sort du stockage n'est cru sur parole", () => {
  test("relit ce qu'`ecrireSelection` a écrit", () => {
    expect(lireSelection(ecrireSelection(["a", "b", "c"]))).toEqual(["a", "b", "c"]);
  });

  test("relit ce qu'un Set a produit — c'est la forme réelle de la sélection", () => {
    expect(lireSelection(ecrireSelection(new Set(["x", "y"])))).toEqual(["x", "y"]);
  });

  test("rien de stocké = sélection vide", () => {
    expect(lireSelection(null)).toEqual([]);
    expect(lireSelection("")).toEqual([]);
  });

  test("JSON cassé = sélection vide, PAS une exception", () => {
    // Une exception ici remonterait pendant le montage de la table et blanchirait l'écran.
    expect(lireSelection("{pas du json")).toEqual([]);
    expect(lireSelection("[1, 2,")).toEqual([]);
  });

  test("un JSON valide mais qui n'est pas une liste = sélection vide", () => {
    expect(lireSelection('{"a":1}')).toEqual([]);
    expect(lireSelection('"a"')).toEqual([]);
    expect(lireSelection("42")).toEqual([]);
    expect(lireSelection("null")).toEqual([]);
  });

  test("les entrées non textuelles sont écartées UNE PAR UNE, pas la liste entière", () => {
    // Un tableau dont une case est abîmée garde ses autres identifiants : ce sont de vraies lignes
    // cochées, les jeter toutes ferait perdre un travail de sélection réel.
    expect(lireSelection('["a", 42, null, "b", {}, ""]')).toEqual(["a", "b"]);
  });

  test("les doublons sont réduits", () => {
    // La sélection est un Set : deux fois le même id ne fait pas deux lignes, et laisser passer le
    // doublon ferait compter « 3 selected » pour deux personnes.
    expect(lireSelection('["a", "a", "b"]')).toEqual(["a", "b"]);
  });
});
