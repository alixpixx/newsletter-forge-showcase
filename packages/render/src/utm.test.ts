/**
 * Banc du balisage UTM.
 *
 * ⛔ CE QUI SE JOUE ICI N'EST PAS L'ANALYTICS. Une réécriture d'href qui déborde sur le lien de
 * désinscription produit un manquement de conformité : l'abonné ne peut plus se désinscrire, et
 * personne ne le voit avant la plainte. La garantie « on ne touche que les liens de contenu » doit
 * donc être MESURÉE, pas raisonnée — d'autant que le raisonnement (« au moment où on réécrit, les
 * liens système sont encore des jetons ») est vrai aujourd'hui et pourrait cesser de l'être.
 */
import { describe, expect, test } from "bun:test";
import { applyUtm, utmSlug } from "./links";

const P = { source: "newsletter", medium: "email", campaign: "resumo-da-semana" };

/** Les href d'un HTML, dans l'ordre — c'est ce qu'on mesure, jamais le HTML entier. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/\shref=(["'])([^"']*)\1/gi)].map((m) => m[2] as string);
}

describe("applyUtm — ce qu'il baliserait", () => {
  test("un lien de contenu reçoit source, medium et campagne", () => {
    const r = applyUtm(`<a href="https://quartz-tips.example/noticia">lire</a>`, P);
    expect(hrefs(r.html)[0]).toBe(
      "https://quartz-tips.example/noticia?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=resumo-da-semana",
    );
    expect(r.tagged).toBe(1);
  });

  test("les paramètres déjà présents dans l'URL survivent", () => {
    const r = applyUtm(`<a href="https://s.example/a?ref=home&amp;p=2">x</a>`, P);
    const h = hrefs(r.html)[0]!;
    expect(h).toContain("ref=home");
    expect(h).toContain("p=2");
    expect(h).toContain("utm_source=newsletter");
    // ⛔ Le `&` reste échappé : un `&` nu dans un attribut est coupé par certains clients mail.
    expect(h).not.toMatch(/&(?!amp;)/);
  });

  test("le fragment reste à la fin, après la query", () => {
    const r = applyUtm(`<a href="https://s.example/a#resultats">x</a>`, P);
    expect(hrefs(r.html)[0]).toBe(
      "https://s.example/a?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=resumo-da-semana#resultats",
    );
  });

  test("utm_content n'est posé que s'il est fourni", () => {
    expect(hrefs(applyUtm(`<a href="https://s.example/a">x</a>`, P).html)[0]).not.toContain("utm_content");
    const avec = applyUtm(`<a href="https://s.example/a">x</a>`, { ...P, content: "edition-7" });
    expect(hrefs(avec.html)[0]).toContain("utm_content=edition-7");
  });
});

describe("applyUtm — ce qu'il ne touche JAMAIS", () => {
  /**
   * ⛔ LE TEST QUI COMPTE. Les liens système sont des jetons au moment où on réécrit ; s'ils
   * devenaient un jour de vraies URL, ce test tomberait — et c'est exactement ce qu'on veut.
   */
  test("un href contenant un jeton est rendu octet pour octet", () => {
    const html =
      `<a href="{{unsubscribe_url}}">unsub</a>` +
      `<a href="{{preferences_url}}">prefs</a>` +
      `<a href="{{privacy_url}}">privacy</a>` +
      `<a href="{{web_version_url}}">web</a>` +
      `<a href="https://s.example/x?u={{email}}">mixte</a>`;
    const r = applyUtm(html, P);
    expect(r.html).toBe(html);
    expect(r.tagged).toBe(0);
    expect(r.skipped.token).toBe(5);
  });

  test("mailto, tel, ancres et chemins relatifs sont laissés tels quels", () => {
    const html =
      `<a href="mailto:contact@s.example">mail</a>` +
      `<a href="tel:+5511999">tel</a>` +
      `<a href="#top">haut</a>` +
      `<a href="/relatif">rel</a>` +
      `<a href="">vide</a>`;
    const r = applyUtm(html, P);
    expect(r.html).toBe(html);
    expect(r.skipped.nonHttp).toBe(5);
  });

  /**
   * ⛔ Tout ou rien. Compléter un balisage existant produirait un mélange dont personne ne saurait
   * dire ce qu'il mesure — et écraserait une intention explicite de l'auteur.
   */
  test("un lien qui porte déjà un utm_ n'est ni complété ni écrasé", () => {
    const html = `<a href="https://s.example/a?utm_source=partenaire">x</a>`;
    const r = applyUtm(html, P);
    expect(r.html).toBe(html);
    expect(r.skipped.alreadyTagged).toBe(1);
    const majuscule = `<a href="https://s.example/a?UTM_Source=partenaire">x</a>`;
    expect(applyUtm(majuscule, P).skipped.alreadyTagged).toBe(1);
  });

  test("une URL illisible est laissée intacte plutôt que réparée", () => {
    const html = `<a href="https://[pas-une-url">x</a>`;
    const r = applyUtm(html, P);
    expect(r.html).toBe(html);
    expect(r.skipped.unparsable).toBe(1);
  });

  /**
   * Le HTML autour des href ne bouge pas : un attribut voisin nommé `data-href` ou un texte
   * contenant « href= » ne doit pas être confondu avec un lien.
   */
  test("seuls les attributs href sont réécrits", () => {
    const html = `<td data-x="href=https://s.example/piege"><a href="https://s.example/a">x</a></td>`;
    const r = applyUtm(html, P);
    expect(r.tagged).toBe(1);
    expect(r.html).toContain(`data-x="href=https://s.example/piege"`);
  });

  /**
   * ⛔ LE CAS QUI A ÉTÉ MESURÉ EN VRAI, pas imaginé. Les dix versions publiées en base portent un
   * `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?…">` : une première version de
   * cette fonction, qui visait tout attribut `href=`, y collait les paramètres de campagne. Un
   * UTM sur une requête de police ne mesure rien et s'invite dans une URL dont on ne maîtrise pas
   * le contrat. Seules les ANCRES sont des liens.
   */
  test("un <link> de feuille de style n'est pas un lien de contenu", () => {
    const html =
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit&amp;display=swap">` +
      `<img src="https://s.example/i.png">` +
      `<a href="https://s.example/a">lire</a>`;
    const r = applyUtm(html, P);
    expect(r.tagged).toBe(1);
    expect(r.html).toContain(`href="https://fonts.googleapis.com/css2?family=Outfit&amp;display=swap"`);
    expect(r.html).not.toContain("family=Outfit&amp;display=swap&amp;utm_source");
  });

  test("une ancre avec d'autres attributs avant href est bien balisée", () => {
    const r = applyUtm(`<a class="cta" target="_blank" href="https://s.example/a">x</a>`, P);
    expect(r.tagged).toBe(1);
  });

  test("appliquer deux fois ne double aucun paramètre", () => {
    const une = applyUtm(`<a href="https://s.example/a">x</a>`, P);
    const deux = applyUtm(une.html, P);
    expect(deux.html).toBe(une.html);
    expect(deux.tagged).toBe(0);
  });
});

describe("utmSlug", () => {
  test("rend un slug lisible dans Analytics", () => {
    expect(utmSlug("Resumo da Semana")).toBe("resumo-da-semana");
    expect(utmSlug("Édition spéciale — Coupe")).toBe("edition-speciale-coupe");
    expect(utmSlug("  ///  ")).toBe("");
  });

  test("les accents deviennent leur lettre, ils ne disparaissent pas", () => {
    // ⛔ « Résumé » → « resume », jamais « r-sum » : un slug amputé rendrait deux campagnes
    // différentes indiscernables dans Analytics.
    expect(utmSlug("Résumé")).toBe("resume");
    expect(utmSlug("Notícia")).toBe("noticia");
  });
});
