/**
 * LE BANC DU REGISTRE DE CHAMPS — et il ne couvre qu'une moitié du défaut, ce qu'il faut dire.
 *
 * ⛔ CE QUI EST TESTÉ ICI : que `CATEGORIES` soit DÉRIVÉE de `FIELDS` et non recopiée à la main.
 * ⛔ CE QUI NE PEUT PAS L'ÊTRE : que l'écran rende effectivement chaque catégorie. Il n'existe
 *    AUCUN moteur de rendu React de test dans ce dépôt (ni testing-library, ni happy-dom, ni jsdom ;
 *    les fichiers `*.test.ts` sont tous de la logique pure). Cette moitié-là n'est tenue que par
 *    `tsc --noEmit` sur `apps/admin`, via `CATEGORY_LABEL_UI` retypé en `Record<FieldCategory, …>` :
 *    une catégorie neuve y devient une clé manquante, donc une erreur de compilation.
 *    Croire ce fichier plus large qu'il ne l'est, c'est croire couvert ce qui ne l'est pas.
 */
import { describe, expect, test } from "bun:test";
import {
  CATEGORIES, FIELDS, defaultValue, getField, summarize,
  type FieldCategory, type LabelBook, type Predicate,
} from "./fields";

describe("les catégories du menu dérivent des champs déclarés", () => {
  test("toute catégorie portée par un champ figure dans CATEGORIES", () => {
    // MUTATION QUI DOIT TUER CE TEST : remplacer la dérivation par un tableau littéral, puis
    // ajouter un champ dans une catégorie neuve. Sans ce test, ce champ serait accepté par
    // TypeScript et INVISIBLE dans le menu de l'écran, sans une seule erreur nulle part.
    for (const f of FIELDS) {
      expect(CATEGORIES).toContain(f.category);
    }
  });

  test("toute catégorie listée porte au moins un champ", () => {
    // L'autre sens : une catégorie qui ne contient rien rendrait un `<optgroup>` vide à l'écran.
    for (const cat of CATEGORIES) {
      expect(FIELDS.some((f) => f.category === cat)).toBe(true);
    }
  });

  test("l'ordre est celui de la première apparition, donc stable", () => {
    // Le menu ne doit pas se réordonner parce qu'un champ a été ajouté au milieu du registre.
    const attendu: FieldCategory[] = [];
    for (const f of FIELDS) if (!attendu.includes(f.category)) attendu.push(f.category);
    expect([...CATEGORIES]).toEqual(attendu);
  });
});

describe("les trois champs de provenance", () => {
  test("ils ne déclarent QUE les opérateurs multi", () => {
    // MUTATION QUI DOIT TUER CE TEST : ajouter `has`/`not_has` par commodité. Ils se compilent en
    // `cs` (« contient TOUTES »), c'est-à-dire l'inverse de « une ou des ».
    for (const key of ["capture_campaign", "capture_creative", "interest"]) {
      expect(getField(key)?.ops).toEqual(["any_of", "none_of"]);
      expect(getField(key)?.category).toBe("Capture");
    }
  });

  test("leur valeur par défaut est une liste VIDE, donc non compilable", () => {
    // ⛔ C'est la sentinelle : une condition de capture qu'on vient d'ajouter ne doit RIEN cibler
    // tant que rien n'est coché. `cs.{}` matcherait les 1 203 abonnés, `ov.{}` personne.
    const f = getField("capture_campaign");
    expect(f).toBeDefined();
    expect(defaultValue(f!)).toEqual([]);
  });

  test("aucune option n'est codée en dur : ces valeurs sont scopées marque", () => {
    // Un exemple inventé ici se compilerait en `null` et le prédicat serait silencieusement
    // écarté — le défaut exact que la route `/api/segments/options` a été écrite pour réparer.
    for (const key of ["capture_campaign", "capture_creative", "interest"]) {
      expect(getField(key)?.options).toBeUndefined();
    }
  });
});

/**
 * ⛔ LE CARNET DE LIBELLÉS EST INDEXÉ PAR VALEUR D'OPTION, ET UNE VALEUR D'INTÉRÊT EST UN PETIT
 * ENTIER. Les mêmes chaînes servent donc de clés à deux choses qui n'ont rien à voir : l'id du tag
 * « 7 » et le nombre 7 d'un `Open count ≥ 7`. Consulté sans discernement, le carnet traduit le
 * SECOND — un résumé faux, sans une seule erreur, juste au-dessus du bouton d'enregistrement.
 */
describe("le carnet de libellés ne s'applique qu'aux champs qui portent des identifiants", () => {
  const carnet: LabelBook = { "7": "Futebol", "12": "Libertadores", vip: "VIP readers" };
  const pred = (field: string, op: Predicate["op"], value: Predicate["value"]): Predicate =>
    ({ id: "n1", type: "predicate", field, op, value });

  test("un nombre reste un nombre, même si un intérêt porte le même id", () => {
    // MUTATION QUI DOIT TUER CE TEST : consulter `labels` avant de regarder le type du champ.
    expect(summarize(pred("open_count", "gte", 7), carnet)).toBe("Open count ≥ 7");
  });

  test("un code pays n'est pas traduit par un carnet d'identifiants", () => {
    // Même piège, une marque plus loin : un tag dont le slug vaut « BR ».
    expect(summarize(pred("country", "eq", "BR"), { BR: "Bresil (tag)" })).toBe("Country is Brazil");
  });

  test("un tag, un formulaire et une multi-sélection le sont, eux", () => {
    // Le témoin : sans lui, « ne jamais consulter le carnet » passerait les deux tests ci-dessus.
    expect(summarize(pred("tag", "has", "vip"), carnet)).toBe("Tag contains VIP readers");
    expect(summarize(pred("interest", "any_of", ["7", "12"]), carnet))
      .toBe("Interest is any of Futebol, Libertadores");
  });
});
