import { describe, expect, test } from "bun:test";
import { libelleDuPays, paysDemande, paysDesLignes, MAX_ECHANTILLON_PAYS } from "./pays-abonnes";

/**
 * ⛔ CE BANC TIENT TROIS CHOSES QUI TOMBENT EN SILENCE :
 *
 *  1. `Intl.DisplayNames.of("")` LÈVE — une cellule vide ferait tomber l'écran entier ;
 *  2. une valeur d'URL mal formée ne doit JAMAIS atteindre un `.eq()` ;
 *  3. un menu trié sur le code mais affiché par nom se lit comme un menu non trié.
 */

describe("paysDemande — ce qui a le droit d'atteindre un .eq()", () => {
  test("un code valide passe, normalisé en majuscules", () => {
    expect(paysDemande("cl")).toBe("CL");
    expect(paysDemande(" BR ")).toBe("BR");
  });

  test("⛔ un code BIEN FORMÉ mais inconnu passe AUSSI, et c'est voulu", () => {
    // Contrairement au statut : « ZZ » désigne une population parfaitement définie, qui se trouve
    // être vide. La rendre vide est la vérité — comme pour une provenance introuvable.
    expect(paysDemande("ZZ")).toBe("ZZ");
  });

  test("⛔ ce qui ne désigne rien est écarté avant la requête", () => {
    expect(paysDemande("united kingdom")).toBeNull();
    expect(paysDemande("1")).toBeNull();
    expect(paysDemande("FRA")).toBeNull();
    expect(paysDemande("")).toBeNull();
    expect(paysDemande("  ")).toBeNull();
    expect(paysDemande(undefined)).toBeNull();
    expect(paysDemande(null)).toBeNull();
  });

  test("⛔ une injection ne franchit pas la forme", () => {
    expect(paysDemande("CL' OR 1=1--")).toBeNull();
  });
});

describe("libelleDuPays — le nom affiché", () => {
  test("les codes connus deviennent des noms", () => {
    expect(libelleDuPays("CL")).toBe("Chile");
    expect(libelleDuPays("BR")).toBe("Brazil");
    expect(libelleDuPays("gb")).toBe("United Kingdom");
  });

  test("⛔ une chaîne VIDE ne fait pas tomber l'écran", () => {
    // `Intl.DisplayNames.of("")` lève une RangeError — mesuré sous Bun. Sans la garde de forme,
    // l'exception remonterait jusqu'au rendu du composant serveur.
    expect(libelleDuPays("")).toBe("");
    expect(libelleDuPays("   ")).toBe("");
  });

  test("⛔ un code inconnu rend quelque chose de NON VIDE, sans lever", () => {
    // ⚠️ Ma première mesure portait sur « XX » seul et concluait « le code est rendu tel quel ».
    // C'est FAUX en général : CLDR réserve « ZZ » et rend « Unknown Region ». La garantie tenable
    // n'est donc pas la valeur, c'est qu'il y en ait une.
    expect(libelleDuPays("XX")).toBe("XX");
    expect(libelleDuPays("ZZ").length).toBeGreaterThan(0);
    expect(libelleDuPays("ZZ")).not.toBe("");
  });

  test("une valeur mal formée est rendue telle quelle, sans exception", () => {
    expect(libelleDuPays("FRA")).toBe("FRA");
  });
});

describe("paysDesLignes — le menu", () => {
  test("dédoublonne et normalise", () => {
    expect(paysDesLignes([{ country: "cl" }, { country: "CL" }, { country: "br" }])).toEqual([
      "BR",
      "CL",
    ]);
  });

  test("⛔ ordonné par NOM AFFICHÉ, pas par code", () => {
    // Par code : DE, ES, GB. Par nom : Germany, Spain, United Kingdom — même ordre ici.
    // Le cas qui sépare les deux : CL (Chile) doit précéder CN (China), et GB (United Kingdom)
    // doit suivre ES (Spain) alors que « GB » < « ES » est faux et « CN » < « CL » aussi.
    expect(paysDesLignes([{ country: "CN" }, { country: "CL" }])).toEqual(["CL", "CN"]);
    expect(paysDesLignes([{ country: "GB" }, { country: "ES" }])).toEqual(["ES", "GB"]);
    // Celui-ci tombe si on trie sur le code : Brazil < Chile, mais « BR » < « CL » aussi…
    // donc on prend un vrai contre-exemple : Germany (DE) < Japan (JP) < Spain (ES) par NOM.
    expect(paysDesLignes([{ country: "ES" }, { country: "JP" }, { country: "DE" }])).toEqual([
      "DE",
      "JP",
      "ES",
    ]);
  });

  test("⛔ rien de ce qui ne peut pas filtrer n'entre dans le menu", () => {
    expect(
      paysDesLignes([
        { country: null },
        { country: "" },
        { country: "   " },
        { country: "FRA" },
        { country: 42 },
        {},
        { country: "CL" },
      ]),
    ).toEqual(["CL"]);
  });

  test("une liste vide rend un menu vide", () => {
    expect(paysDesLignes([])).toEqual([]);
  });
});

describe("le plafond de l'échantillon", () => {
  test("⛔ il existe et il est borné — PostgREST n'a pas de SELECT DISTINCT", () => {
    expect(MAX_ECHANTILLON_PAYS).toBeGreaterThan(0);
    expect(MAX_ECHANTILLON_PAYS).toBeLessThanOrEqual(5000);
  });
});
