import { describe, expect, test } from "bun:test";
import {
  FILTRES_STATUT,
  libelleDuStatut,
  statutDemande,
  statutsDuGroupe,
} from "@/lib/data/statut-abonnes";

/**
 * LE FILTRE PAR ÉTAT DE CONSENTEMENT.
 *
 * Ce qui se trompe en silence ici :
 *  1. UN GROUPE INCOMPLET. « Suppressed » recouvre DEUX statuts en base. N'en ramener qu'un rend
 *     une liste plus courte que ce que le filtre annonce, et le manque est invisible : toutes les
 *     lignes rendues portent bien le libellé demandé.
 *  2. UN STATUT QUI N'EST DANS AUCUN GROUPE. Ses lignes s'affichent dans la liste complète et ne
 *     ressortent d'aucun filtre — ce qui se lit comme « il n'y en a pas ».
 */

/** Les statuts que la table sait afficher (`CONSENT_PILL`, `bulk-actions.tsx`). */
const STATUTS_AFFICHES = [
  "active",
  "pending",
  "unsubscribed",
  "suppressed_soft",
  "suppressed_hard",
  "complained",
  "deleted",
  // 0088 : le contact hors newsletter. Sans groupe, ses lignes ne ressortiraient d'aucun filtre.
  "contact",
];

describe("FILTRES_STATUT — aucun statut n'est infiltrable", () => {
  test("chaque statut que l'écran sait afficher appartient à un groupe", () => {
    const couverts = new Set(FILTRES_STATUT.flatMap((f) => f.statuts));
    for (const s of STATUTS_AFFICHES) expect(couverts).toContain(s);
  });

  test("« Suppressed » couvre bien SES DEUX statuts", () => {
    // ⛔ La base distingue soft et hard ; l'écran les affiche tous deux « Suppressed ». Un filtre
    // qui n'en ramènerait qu'un mentirait sur sa propre étiquette.
    expect(statutsDuGroupe("suppressed").sort()).toEqual(["suppressed_hard", "suppressed_soft"]);
  });

  test("aucun statut n'appartient à deux groupes à la fois", () => {
    const tous = FILTRES_STATUT.flatMap((f) => f.statuts);
    expect(new Set(tous).size).toBe(tous.length);
  });

  test("les clés de menu sont uniques et ont toutes un libellé", () => {
    const cles = FILTRES_STATUT.map((f) => f.cle);
    expect(new Set(cles).size).toBe(cles.length);
    for (const f of FILTRES_STATUT) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(libelleDuStatut(f.cle)).toBe(f.label);
      expect(f.statuts.length).toBeGreaterThan(0);
    }
  });
});

describe("statutDemande — une valeur inconnue ne filtre RIEN", () => {
  test("accepte les groupes connus", () => {
    for (const f of FILTRES_STATUT) expect(statutDemande(f.cle)).toBe(f.cle);
  });

  test("inconnu, vide ou absent = pas de filtre", () => {
    // ⛔ `null` et non « liste vide » : un `?status=` mal orthographié ne désigne aucune population.
    // Rendre zéro ligne ferait croire que la marque est vide — l'inverse du service rendu.
    expect(statutDemande("actif")).toBeNull();
    expect(statutDemande("active")).toBeNull(); // le statut BRUT n'est pas une clé de menu
    expect(statutDemande("")).toBeNull();
    expect(statutDemande(undefined)).toBeNull();
    expect(statutDemande(null)).toBeNull();
  });

  test("pas de filtre = aucun statut à poser sur la requête", () => {
    expect(statutsDuGroupe(null)).toEqual([]);
  });
});
