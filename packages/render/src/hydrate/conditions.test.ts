/**
 * Banc du moteur de blocs conditionnels `<!--nf:if x-->…<!--nf:endif-->`.
 *
 * ⛔ POURQUOI IL N'EXISTAIT PAS, ET POURQUOI C'ÉTAIT GRAVE. Au 09/09/2026, aucun `*.test.ts` du
 * dépôt ne contenait `nf:if`, `endif`, `buildFooter(` ni `Impressum` : le seul mécanisme capable de
 * faire DISPARAÎTRE une mention légale d'un e-mail n'était couvert par rien. Une régression y est
 * invisible jusqu'à la boîte de réception — et ce qui manque, personne ne le voit manquer.
 *
 * Le lot 5B en fait le socle de la conformité par pays : c'est le moment de le tenir.
 */
import { describe, expect, test } from "bun:test";
import { hydrate, hydrateReport } from "./index";

const BLOC = (cond: string, dedans = "DEDANS") => `avant<!--nf:if ${cond}-->${dedans}<!--nf:endif-->apres`;

describe("nf:if — véracité", () => {
  test("un drapeau vrai laisse le bloc, un drapeau faux le retire", () => {
    expect(hydrate(BLOC("is_gdpr"), { is_gdpr: true })).toBe("avantDEDANSapres");
    expect(hydrate(BLOC("is_gdpr"), { is_gdpr: false })).toBe("avantapres");
  });

  test("les valeurs qui ressemblent à du vide sont fausses", () => {
    // Un drapeau posé à la chaîne "false" vient d'un formulaire ou d'un jsonb : le traiter comme
    // vrai — puisque c'est une chaîne non vide — afficherait le bloc à l'envers.
    for (const faux of ["", "0", "false", "null", false, 0]) {
      expect(hydrate(BLOC("is_gdpr"), { is_gdpr: faux as never })).toBe("avantapres");
    }
    for (const vrai of ["1", "true", "oui", true]) {
      expect(hydrate(BLOC("is_gdpr"), { is_gdpr: vrai as never })).toBe("avantDEDANSapres");
    }
  });

  test("la négation inverse", () => {
    expect(hydrate(BLOC("!is_gdpr"), { is_gdpr: false })).toBe("avantDEDANSapres");
    expect(hydrate(BLOC("!is_gdpr"), { is_gdpr: true })).toBe("avantapres");
  });
});

describe("nf:if — égalité", () => {
  test('market=="DE" fonctionne SANS une ligne de code neuve', () => {
    // ⛔ Le lot 5B n'a rien à écrire pour `market_de` : `market` est déjà une variable du registre.
    // Ce banc est là pour l'empêcher d'être « réimplémenté » un jour par quelqu'un qui l'ignore.
    expect(hydrate(BLOC('market=="DE"'), { market: "DE" })).toBe("avantDEDANSapres");
    expect(hydrate(BLOC('market=="DE"'), { market: "BR" })).toBe("avantapres");
  });

  test("la comparaison ignore la casse et les espaces de bord", () => {
    expect(hydrate(BLOC('market=="de"'), { market: " DE " })).toBe("avantDEDANSapres");
  });

  test("la différence s'écrit !champ==\"valeur\"", () => {
    expect(hydrate(BLOC('!market=="DE"'), { market: "BR" })).toBe("avantDEDANSapres");
    expect(hydrate(BLOC('!market=="DE"'), { market: "DE" })).toBe("avantapres");
  });

  test("⛔ l'égalité compare la donnée BRUTE, sans le repli du registre", () => {
    // `locale` a le repli "en". Un abonné sans langue IMPRIME « en » mais ne SATISFAIT pas
    // `locale=="en"`. C'est un piège : ne jamais conditionner sur une variable à repli.
    expect(hydrate(BLOC('locale=="en"'), {})).toBe("avantapres");
    expect(hydrate("{{locale}}", {})).toBe("en");
  });
});

describe("nf:if — ce qui protège du pire", () => {
  test("⛔ un champ INCONNU masque le bloc dans LES DEUX polarités", () => {
    // Fail-closed voulu. La conséquence pratique : publier un template qui utilise un drapeau que
    // le worker déployé ne connaît pas encore fait disparaître le bloc chez TOUT LE MONDE, sans
    // erreur. C'est pourquoi le registre et le calcul partent toujours ensemble.
    expect(hydrate(BLOC("champ_inexistant"), {})).toBe("avantapres");
    expect(hydrate(BLOC("!champ_inexistant"), {})).toBe("avantapres");
  });

  test("le champ inconnu est REMONTÉ, pas seulement masqué", () => {
    const r = hydrateReport(BLOC("champ_inexistant"), {});
    expect(r.unknownConditions).toContain("champ_inexistant");
  });

  test("l'imbrication tient : un enfant vrai dans un parent faux reste masqué", () => {
    const doc = "A<!--nf:if is_gdpr-->B<!--nf:if is_lgpd-->C<!--nf:endif-->D<!--nf:endif-->E";
    expect(hydrate(doc, { is_gdpr: true, is_lgpd: true })).toBe("ABCDE");
    expect(hydrate(doc, { is_gdpr: true, is_lgpd: false })).toBe("ABDE");
    // Le parent commande : l'enfant vrai ne ressort pas.
    expect(hydrate(doc, { is_gdpr: false, is_lgpd: true })).toBe("AE");
  });

  test("⛔ une valeur d'abonné ne peut pas détourner la structure", () => {
    // Les conditionnels sont résolus AVANT les jetons : un prénom contenant `<!--nf:endif-->` ne
    // referme rien. Sans cet ordre, un abonné pourrait faire apparaître un bloc masqué pour lui —
    // par exemple une mention réservée à un autre régime.
    const doc = "<!--nf:if is_gdpr-->SECRET<!--nf:endif-->{{first_name}}";
    expect(hydrate(doc, { is_gdpr: false, first_name: "<!--nf:endif-->PIRATE" })).not.toContain("SECRET");
  });

  test("un endif orphelin est ignoré, un if non fermé se referme en fin de document", () => {
    // Le balisage bancal ne doit pas produire du HTML cassé : il produit du HTML valide et
    // incomplet, ce qui est la moins mauvaise des deux sorties.
    expect(hydrate("A<!--nf:endif-->B", {})).toBe("AB");
    expect(hydrate("A<!--nf:if is_gdpr-->B", { is_gdpr: true })).toBe("AB");
    expect(hydrate("A<!--nf:if is_gdpr-->B", { is_gdpr: false })).toBe("A");
  });
});

describe("les trois drapeaux de régime, tels qu'un template les utilisera", () => {
  /**
   * ⛔ LE SCÉNARIO QUI COMPTE. Le moteur n'a PAS de `else`. « GDPR sinon CAN-SPAM » s'écrit en deux
   * blocs indépendants, et si les deux conditions sont fausses l'e-mail part SANS AUCUNE mention.
   * On vérifie donc qu'avec les drapeaux calculés par `@nf/config`, il y a TOUJOURS exactement un
   * bloc qui sort — y compris pour un régime absent ou inconnu.
   */
  const DOC =
    "<!--nf:if is_gdpr-->RGPD<!--nf:endif-->" +
    "<!--nf:if is_lgpd-->LGPD<!--nf:endif-->" +
    "<!--nf:if is_can_spam-->CANSPAM<!--nf:endif-->";

  test("un et un seul bloc sort pour chaque combinaison exhaustive", () => {
    // ⚠️ Les drapeaux sont posés À LA MAIN ici : `packages/render` n'a pas — et ne doit pas avoir —
    // de dépendance sur `@nf/config` (le moteur d'hydratation est sans import par contrat). Ce banc
    // tient donc le MOTEUR ; que le worker calcule bien ces drapeaux depuis le régime est tenu par
    // `apps/worker/src/render.test.ts`, qui a les deux côtés sous la main.
    expect(hydrate(DOC, { is_gdpr: true, is_lgpd: false, is_can_spam: false })).toBe("RGPD");
    expect(hydrate(DOC, { is_gdpr: false, is_lgpd: true, is_can_spam: false })).toBe("LGPD");
    expect(hydrate(DOC, { is_gdpr: false, is_lgpd: false, is_can_spam: true })).toBe("CANSPAM");
  });

  test("⛔ trois drapeaux faux ⇒ e-mail MUET — le cas que l'exhaustivité doit rendre impossible", () => {
    // Ce banc ne teste pas un comportement souhaitable : il DOCUMENTE le danger. Le moteur n'a pas
    // de `else`, donc rien ici ne rattrape l'absence. La seule protection est en amont, dans
    // `regimeFlags()`, qui ne rend jamais trois faux.
    expect(hydrate(DOC, { is_gdpr: false, is_lgpd: false, is_can_spam: false })).toBe("");
  });
});
