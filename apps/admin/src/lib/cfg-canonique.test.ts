/**
 * Banc de `canonique`.
 *
 * ⛔ CE QU'IL DOIT EMPÊCHER EN PRIORITÉ N'EST PAS LE FAUX POSITIF, C'EST LE FAUX NÉGATIF. Qu'elle
 * déclare « modifié » un formulaire qui ne l'est pas coûte un bouton actif de trop. Qu'elle déclare
 * « identique » deux configs DIFFÉRENTES désactive le bouton Save sur du travail non enregistré :
 * l'auteur quitte la page en croyant avoir fini. Les tests d'égalité ci-dessous cherchent donc
 * d'abord ce cas-là.
 */
import { describe, expect, test } from "bun:test";
import { canonique } from "./cfg-canonique";

describe("l'ordre des clés ne compte pas", () => {
  test("deux objets aux mêmes paires, insérées dans un ordre inverse, sont égaux", () => {
    // C'est LE cas réel : Postgres réordonne les clés d'un `jsonb` (longueur puis octets).
    expect(canonique({ a: 1, b: 2 })).toBe(canonique({ b: 2, a: 1 }));
    expect(canonique({ privacy_url: "u", controller: "c" })).toBe(
      canonique({ controller: "c", privacy_url: "u" }),
    );
  });

  test("l'ordre est égalisé AUSSI dans un objet imbriqué — le champ `style` en est un", () => {
    expect(canonique({ style: { color: "#111", align: "left" } })).toBe(
      canonique({ style: { align: "left", color: "#111" } }),
    );
  });
});

describe("⛔ ce qui DIFFÈRE doit rester différent", () => {
  test("une valeur qui change", () => {
    expect(canonique({ a: 1 })).not.toBe(canonique({ a: 2 }));
  });

  test("⛔ une clé EN PLUS — sinon un champ ajouté ne serait jamais enregistré", () => {
    expect(canonique({ a: 1 })).not.toBe(canonique({ a: 1, b: 2 }));
  });

  test("⛔ un nombre et sa chaîne ne sont PAS confondus", () => {
    // `<input>` rend toujours une chaîne ; la route stocke un nombre. Les confondre masquerait la
    // divergence que l'adoption de la config renvoyée par le serveur est justement là pour régler.
    expect(canonique({ opt_out_days: "30" })).not.toBe(canonique({ opt_out_days: 30 }));
  });

  test("⛔ un espace de bord compte — c'est la normalisation du serveur qui le retire, pas cette fonction", () => {
    expect(canonique({ controller: "X " })).not.toBe(canonique({ controller: "X" }));
  });

  test("⛔ l'ORDRE D'UN TABLEAU est porteur de sens et ne doit PAS être trié", () => {
    // Le tri ne s'applique qu'aux objets. Trier un tableau ferait passer deux listes distinctes pour
    // la même — et `rows`, ailleurs dans ce produit, est une liste dont l'ordre EST le contenu.
    expect(canonique({ xs: [1, 2] })).not.toBe(canonique({ xs: [2, 1] }));
    expect(canonique([1, 2])).toBe("[1,2]");
  });

  test("`null`, `undefined` et l'absence se comportent comme dans JSON", () => {
    // Ancré pour que le jour où quelqu'un « améliore » la fonction, le changement soit visible.
    expect(canonique({ a: null })).toBe('{"a":null}');
    expect(canonique({ a: undefined })).toBe("{}");
    expect(canonique(undefined)).toBe(undefined);
  });
});
