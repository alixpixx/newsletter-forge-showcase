import { describe, expect, test } from "bun:test";
import { champCsv } from "@/lib/csv";
import {
  dejaTague,
  ENTETES_EXPORT,
  fusionnerTags,
  ligneExport,
  personnesDistinctes,
} from "./subscriber-actions";
import type { SubscriberRow, TagInfo } from "./subscribers";

const TAGS: Record<number, TagInfo> = {
  3: { slug: "colo-colo", label: "Colo-Colo", kind: "interest" },
  7: { slug: "vip", label: "VIP", kind: "manual" },
  9: { slug: "u-catolica", label: "Universidad Católica", kind: "interest" },
};

/** Une souscription de test — jamais une adresse réelle, et jamais une adresse qui pourrait l'être. */
function souscription(p: Partial<SubscriberRow> = {}): SubscriberRow {
  return {
    id: "sub-1",
    email: "personne@exemple.invalid",
    first_name: null,
    status: "active",
    source: null,
    country: "CL",
    engagement_score: 40,
    engagement_level: "active",
    created_at: "2026-09-13T10:00:00.000Z",
    tag_ids: [],
    optin_id: null,
    capture_campaign_id: null,
    capture_campaign_ids: [],
    capture_optin_ids: [],
    interest_ids: [],
    capture_event_count: 0,
    purposes: {},
    ...p,
  };
}

describe("fusionnerTags — poser un tag n'en retire aucun", () => {
  test("⛔ les tags existants SURVIVENT : la colonne est un tableau, l'écrire c'est la remplacer", () => {
    // La panne qu'on empêche : `[5]` au lieu de `[3,5,7]` — une perte muette, l'écran affichant
    // simplement « un tag », ce qui a l'air normal.
    expect(fusionnerTags([3, 7], 5)).toEqual([3, 5, 7]);
  });

  test("le résultat est trié, donc comparable d'une écriture à l'autre", () => {
    expect(fusionnerTags([7, 3], 5)).toEqual([3, 5, 7]);
    expect(fusionnerTags([9, 1], 4)).toEqual([1, 4, 9]);
  });

  test("poser deux fois le même tag ne le duplique pas", () => {
    expect(fusionnerTags([3, 7], 7)).toEqual([3, 7]);
  });

  test("une colonne vide ou absente part de zéro sans planter", () => {
    expect(fusionnerTags([], 4)).toEqual([4]);
    expect(fusionnerTags(null, 4)).toEqual([4]);
    expect(fusionnerTags(undefined, 4)).toEqual([4]);
  });

  test("dejaTague dit s'il n'y a rien à écrire", () => {
    expect(dejaTague([3, 7], 7)).toBe(true);
    expect(dejaTague([3, 7], 5)).toBe(false);
    expect(dejaTague(null, 5)).toBe(false);
  });
});

describe("personnesDistinctes — le piège souscription / personne", () => {
  test("⛔ TROIS lignes cochées peuvent ne faire QU'UNE personne à effacer", () => {
    // C'est ce nombre-là que la confirmation doit annoncer. Annoncer « 3 » ferait croire à trois
    // effacements, et le compte rendu final en montrerait un seul — sans que rien n'ait raté.
    const lignes = [
      { subscriber_id: "p1" },
      { subscriber_id: "p1" },
      { subscriber_id: "p2" },
    ];
    expect(personnesDistinctes(lignes)).toEqual(["p1", "p2"]);
  });

  test("⛔ une ligne sans personne rattachée ne produit PAS d'identifiant vide", () => {
    // Un `""` passé à la fonction d'effacement ne lève rien : elle sort en silence, et l'écran
    // annoncerait un effacement de plus qu'il n'y en a eu.
    expect(personnesDistinctes([{ subscriber_id: null }, { subscriber_id: "" }, {}])).toEqual([]);
  });

  test("l'ordre d'apparition est conservé — un compte rendu se relit dans l'ordre coché", () => {
    expect(personnesDistinctes([{ subscriber_id: "b" }, { subscriber_id: "a" }])).toEqual(["b", "a"]);
  });
});

describe("ligneExport — chaque valeur sous son en-tête", () => {
  test("la ligne a exactement autant de champs que d'en-têtes", () => {
    // ⛔ Le décalage de colonnes est la panne d'export classique : le fichier reste lisible et
    // chaque valeur se retrouve sous le mauvais titre.
    expect(ligneExport(souscription(), TAGS)).toHaveLength(ENTETES_EXPORT.length);
  });

  test("⛔ des LIBELLÉS, pas des identifiants — sinon l'export renvoie son lecteur dans l'outil", () => {
    const ligne = ligneExport(souscription({ tag_ids: [7], interest_ids: [3] }), TAGS);
    const tags = String(ligne[ENTETES_EXPORT.indexOf("tags")]);
    expect(tags).toContain("Colo-Colo");
    expect(tags).toContain("VIP");
    expect(tags).not.toContain("3");
  });

  test("un tag inconnu de la carte est ignoré, il ne laisse pas un trou nommé « undefined »", () => {
    const ligne = ligneExport(souscription({ tag_ids: [999] }), TAGS);
    expect(ligne[ENTETES_EXPORT.indexOf("tags")]).toBe("");
  });

  test("le séparateur de tags ne réveille PAS la citation CSV", () => {
    // Une virgule entre deux tags obligerait à citer le champ ; ` | ` reste lisible et neutre.
    const ligne = ligneExport(souscription({ tag_ids: [7], interest_ids: [3, 9] }), TAGS);
    const rendu = champCsv(ligne[ENTETES_EXPORT.indexOf("tags")]);
    expect(rendu.startsWith('"')).toBe(false);
    expect(rendu).toBe("Colo-Colo | Universidad Católica | VIP");
  });

  test("⛔ SEULES les finalités accordées sortent : une clé absente n'est pas un refus", () => {
    const ligne = ligneExport(
      souscription({ purposes: { content: true, offers: false, partners: true } }),
      TAGS,
    );
    const options = String(ligne[ENTETES_EXPORT.indexOf("subscription_options")]);
    expect(options).toBe("content | partners");
    expect(options).not.toContain("offers");
  });

  test("aucune finalité recueillie ⇒ colonne vide, pas le mot « none »", () => {
    expect(ligneExport(souscription({ purposes: {} }), TAGS)[ENTETES_EXPORT.indexOf("subscription_options")]).toBe("");
  });

  test("un prénom absent rend une chaîne vide, jamais « null »", () => {
    const ligne = ligneExport(souscription({ first_name: null, country: null }), TAGS);
    expect(ligne[ENTETES_EXPORT.indexOf("first_name")]).toBe("");
    expect(ligne[ENTETES_EXPORT.indexOf("country")]).toBe("");
  });
});
