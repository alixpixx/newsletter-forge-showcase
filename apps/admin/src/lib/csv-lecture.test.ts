import { describe, expect, test } from "bun:test";
import {
  contactsDuCsv,
  lireCsv,
  normaliserEntete,
  sansBom,
  separateurProbable,
  trouverColonne,
  ENTETES_EMAIL,
  ENTETES_PRENOM,
} from "./csv-lecture";

/**
 * ⛔ CE BANC EXISTE POUR QUATRE PANNES QUI RENDENT UN IMPORT « RÉUSSI » ET FAUX :
 *
 *  1. le point-virgule d'Excel européen lu comme du texte — zéro contact sur mille lignes ;
 *  2. le BOM collé au premier en-tête — la colonne des adresses introuvable alors qu'elle est là ;
 *  3. un saut de ligne dans un champ cité — les lignes suivantes décalées d'une colonne ;
 *  4. un doublon dans le fichier — un DEUXIÈME e-mail de confirmation à quelqu'un qui n'a rien
 *     demandé deux fois (`docs/INGEST-API.md` §7).
 */

describe("sansBom — la marque d'octets part avant toute comparaison", () => {
  test("le BOM est retiré", () => {
    expect(sansBom("﻿email")).toBe("email");
  });

  test("un texte sans BOM est rendu intact", () => {
    expect(sansBom("email")).toBe("email");
  });

  test("⛔ un BOM ailleurs qu'en tête n'est PAS touché", () => {
    // Il n'y est pas par accident : c'est une donnée, pas un préambule d'encodage.
    expect(sansBom("a﻿b")).toBe("a﻿b");
  });
});

describe("separateurProbable — Excel n'exporte pas toujours des virgules", () => {
  test("la virgule est reconnue", () => {
    expect(separateurProbable("email,first_name,country")).toBe(",");
  });

  test("⛔ le point-virgule d'Excel européen est reconnu", () => {
    expect(separateurProbable("email;first_name;country")).toBe(";");
  });

  test("la tabulation est reconnue", () => {
    expect(separateurProbable("email\tfirst_name\tcountry")).toBe("\t");
  });

  test("⛔ un séparateur À L'INTÉRIEUR d'un libellé cité ne compte pas", () => {
    // Sans la garde des guillemets, ces deux points-virgules l'emporteraient sur les virgules.
    expect(separateurProbable('email,"nom; prenom",pays')).toBe(",");
  });

  test("une seule colonne retombe sur la virgule sans rien casser", () => {
    expect(separateurProbable("email")).toBe(",");
  });

  test("le BOM ne masque pas la première ligne", () => {
    expect(separateurProbable("﻿email;nom")).toBe(";");
  });
});

describe("lireCsv — le balayage RFC 4180", () => {
  test("un tableau simple", () => {
    const { enregistrements } = lireCsv("a,b\n1,2");
    expect(enregistrements).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("les guillemets protègent le séparateur", () => {
    const { enregistrements } = lireCsv('a,b\n"Bravo, Sofia",2');
    expect(enregistrements[1]).toEqual(["Bravo, Sofia", "2"]);
  });

  test("⛔ deux guillemets d'affilée sont UN guillemet littéral", () => {
    const { enregistrements } = lireCsv('a\n"elle dit ""non"""');
    expect(enregistrements[1]).toEqual(['elle dit "non"']);
  });

  test("⛔ un saut de ligne cité ne coupe PAS l'enregistrement", () => {
    const { enregistrements } = lireCsv('a,b\n"rue des Lilas\n75011 Paris",x');
    expect(enregistrements).toHaveLength(2);
    expect(enregistrements[1]).toEqual(["rue des Lilas\n75011 Paris", "x"]);
  });

  test("CRLF, LF et CR seul donnent le même résultat", () => {
    const attendu = [["a"], ["1"], ["2"]];
    expect(lireCsv("a\r\n1\r\n2").enregistrements).toEqual(attendu);
    expect(lireCsv("a\n1\n2").enregistrements).toEqual(attendu);
    expect(lireCsv("a\r1\r2").enregistrements).toEqual(attendu);
  });

  test("la dernière ligne sans saut final est lue", () => {
    expect(lireCsv("a\n1").enregistrements).toHaveLength(2);
  });

  test("le saut de ligne final ne crée pas d'enregistrement fantôme", () => {
    expect(lireCsv("a\n1\n").enregistrements).toHaveLength(2);
    expect(lireCsv("a\n1\r\n").enregistrements).toHaveLength(2);
  });

  test("un champ vide reste un champ", () => {
    expect(lireCsv("a,b,c\n1,,3").enregistrements[1]).toEqual(["1", "", "3"]);
  });

  test("⛔ le numéro de ligne suit les sauts CITÉS", () => {
    // L'humain ouvrira son tableur : c'est la ligne physique de DÉBUT qu'il doit voir.
    const { debuts } = lireCsv('a,b\n"deux\nlignes",x\nsuivant,y');
    expect(debuts).toEqual([1, 2, 4]);
  });

  test("un texte vide ne rend aucun enregistrement", () => {
    expect(lireCsv("").enregistrements).toEqual([]);
  });
});

describe("normaliserEntete et trouverColonne", () => {
  test("accents, casse, souligné et espaces sont neutralisés", () => {
    expect(normaliserEntete("  Prénom ")).toBe("prenom");
    expect(normaliserEntete("First_Name")).toBe("first name");
  });

  test("la colonne est trouvée quel que soit le libellé", () => {
    expect(trouverColonne(["id", "E-Mail", "x"], ENTETES_EMAIL)).toBe(1);
    expect(trouverColonne(["Prénom", "email"], ENTETES_PRENOM)).toBe(0);
  });

  test("⛔ aucune colonne reconnue rend -1, PAS zéro", () => {
    // Retomber sur la première colonne importerait des identifiants internes comme adresses.
    expect(trouverColonne(["id", "montant"], ENTETES_EMAIL)).toBe(-1);
  });
});

describe("contactsDuCsv — ce que le fichier contient vraiment", () => {
  test("le cas nominal", () => {
    const lu = contactsDuCsv("email,first_name\nana@exemple.cl,Ana\nbruno@exemple.cl,Bruno");
    expect(lu.contacts).toEqual([
      { ligne: 2, email: "ana@exemple.cl", prenom: "Ana" },
      { ligne: 3, email: "bruno@exemple.cl", prenom: "Bruno" },
    ]);
    expect(lu.refus).toEqual([]);
  });

  test("⛔ un fichier au point-virgule est lu, pas avalé", () => {
    const lu = contactsDuCsv("email;prénom\nana@exemple.cl;Ana");
    expect(lu.separateur).toBe(";");
    expect(lu.contacts).toHaveLength(1);
    expect(lu.contacts[0].prenom).toBe("Ana");
  });

  test("⛔ le BOM ne cache pas la colonne des adresses", () => {
    const lu = contactsDuCsv("﻿email,first_name\nana@exemple.cl,Ana");
    expect(lu.colonneEmail).toBe(0);
    expect(lu.contacts).toHaveLength(1);
  });

  test("⛔ la même adresse deux fois n'est comptée qu'une, et le doublon EST DIT", () => {
    const lu = contactsDuCsv("email\nana@exemple.cl\nana@exemple.cl");
    expect(lu.contacts).toHaveLength(1);
    expect(lu.refus).toEqual([
      { ligne: 3, valeur: "ana@exemple.cl", motif: "doublon-dans-le-fichier" },
    ]);
  });

  test("⛔ le doublon est détecté À LA CASSE PRÈS, comme la route", () => {
    const lu = contactsDuCsv("email\nAna@Exemple.cl\nana@exemple.cl");
    expect(lu.contacts).toHaveLength(1);
    expect(lu.contacts[0].email).toBe("ana@exemple.cl");
    expect(lu.refus).toHaveLength(1);
  });

  test("une adresse invalide est écartée avec sa ligne", () => {
    const lu = contactsDuCsv("email\npas-une-adresse\nana@exemple.cl");
    expect(lu.contacts).toHaveLength(1);
    expect(lu.refus).toEqual([{ ligne: 2, valeur: "pas-une-adresse", motif: "email-invalide" }]);
  });

  test("une cellule d'adresse vide est écartée avec son propre motif", () => {
    const lu = contactsDuCsv("email,first_name\n,Ana");
    expect(lu.contacts).toEqual([]);
    expect(lu.refus).toEqual([{ ligne: 2, valeur: "", motif: "email-absent" }]);
  });

  test("⛔ rien n'est perdu en silence : retenus + écartés = lignes de données", () => {
    const texte = "email\nana@exemple.cl\nzut\nana@exemple.cl\n\nbruno@exemple.cl";
    const lu = contactsDuCsv(texte);
    // La ligne 5 est vide : elle n'est pas un enregistrement, donc pas une ligne de données.
    expect(lu.contacts.length + lu.refus.length).toBe(4);
  });

  test("⛔ aucune colonne d'adresses reconnue : -1 et zéro contact, à dire à l'écran", () => {
    const lu = contactsDuCsv("id,montant\n7,12");
    expect(lu.colonneEmail).toBe(-1);
    expect(lu.contacts).toEqual([]);
    expect(lu.refus).toEqual([]);
  });

  test("sans colonne de prénom, le prénom est vide et rien n'échoue", () => {
    const lu = contactsDuCsv("email\nana@exemple.cl");
    expect(lu.colonnePrenom).toBe(-1);
    expect(lu.contacts[0].prenom).toBe("");
  });

  test("un fichier vide ne rend ni contact ni refus", () => {
    const lu = contactsDuCsv("");
    expect(lu.contacts).toEqual([]);
    expect(lu.refus).toEqual([]);
    expect(lu.entetes).toEqual([]);
  });

  test("un fichier d'en-têtes seuls ne rend aucun contact", () => {
    const lu = contactsDuCsv("email,first_name\n");
    expect(lu.contacts).toEqual([]);
    expect(lu.refus).toEqual([]);
  });

  test("les espaces autour d'une adresse sont mangés", () => {
    const lu = contactsDuCsv('email,first_name\n"  ana@exemple.cl  ",  Ana  ');
    expect(lu.contacts[0].email).toBe("ana@exemple.cl");
    expect(lu.contacts[0].prenom).toBe("Ana");
  });

  test("⛔ un saut de ligne cité ne décale pas les lignes suivantes", () => {
    const texte = 'email,note\nana@exemple.cl,"deux\nlignes"\nbruno@exemple.cl,x';
    const lu = contactsDuCsv(texte);
    expect(lu.contacts).toHaveLength(2);
    expect(lu.contacts[1].email).toBe("bruno@exemple.cl");
    expect(lu.contacts[1].ligne).toBe(4);
  });
});
