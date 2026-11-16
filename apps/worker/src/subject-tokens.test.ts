/**
 * Banc des SHORTCODES DE SUJET (lot du 08/09/2026).
 *
 * ⛔ POURQUOI CE FICHIER EXISTE. `{{first_article}}` était substitué au gel par un
 * `subject.split().join()` littéral, hors du registre de @nf/render. Retirer cette substitution
 * n'a fait tomber AUCUN test : il n'y en avait pas. Ce qui n'est pas collecté ne protège rien.
 *
 * Ce que ce banc verrouille : chaque jeton de sujet lit la source qu'on croit, la campagne sert de
 * repli à l'occurrence pour la date, et un envoi qui n'a PAS la donnée n'en invente pas.
 */
import { describe, expect, test } from "bun:test";

// @nf/tokens lève à l'import si le secret manque : on le pose avant de charger le module testé.
process.env.TOKEN_SECRET ??= "banc-subject-tokens-secret-de-test";
process.env.AUTH_SECRET ??= "banc-subject-tokens-secret-de-test";

const { render } = await import("./render");
type Ctx = Parameters<typeof render>[0];

const SHELL = "<html><body>{{legal_footer_html}}</body></html>";

/**
 * Contexte outbox minimal d'une campagne. `subscription_id`/`subscriber_id` restent nuls : le
 * rendu retombe alors sur des liens non signés, ce qui évite de faire dépendre ce banc du
 * mécanisme de signature — ce n'est pas lui qu'on mesure ici.
 */
function ctx(patch: Partial<Ctx> & { subject: string }): Ctx {
  return {
    id: "ob_1",
    kind: "campaign",
    to_email: "lectrice@exemple-nf.test",
    asset_name: "Quartz Tips",
    language: "pt-BR",
    campaign_html_shell: SHELL,
    subscription_id: null,
    subscriber_id: null,
    legal_footer: {},
    compliance_regime: "lgpd",
    ...patch,
  } as unknown as Ctx;
}

function sujet(c: Ctx): string {
  const out = render(c, "https://public.exemple-nf.test");
  if (!out.ok) throw new Error(`rendu refusé : ${out.reason}`);
  return out.email.subject;
}

describe("shortcodes de sujet", () => {
  test("l'article de tête et le nombre d'articles viennent de l'OCCURRENCE, pas du sujet gelé", () => {
    const s = sujet(
      ctx({
        subject: "{{first_article}} — et {{article_count}} autres",
        occurrence_id: "occ_1",
        occurrence_first_article: "Palmeiras vence o clássico",
        occurrence_article_count: 7,
      }),
    );
    expect(s).toBe("Palmeiras vence o clássico — et 7 autres");
  });

  /**
   * ⛔ Le sujet passe par `hydrateText`, donc SANS échappement HTML : un titre contenant `&` ou une
   * apostrophe doit arriver tel quel dans la boîte de réception. C'est exactement ce que l'ancienne
   * substitution littérale faisait par accident et que le passage au registre aurait pu casser.
   */
  test("un titre à caractères spéciaux n'est pas échappé dans le sujet", () => {
    const s = sujet(
      ctx({
        subject: "{{first_article}}",
        occurrence_id: "occ_1",
        occurrence_first_article: "Barça & Real : l'affiche",
      }),
    );
    expect(s).toBe("Barça & Real : l'affiche");
  });

  test("le nom de la campagne est servi", () => {
    expect(sujet(ctx({ subject: "[{{campaign_name}}] du jour", campaign_name: "Resumo da Semana" })))
      .toBe("[Resumo da Semana] du jour");
  });

  /**
   * ⛔ LE TROU QUE CE LOT COMBLE. Une campagne PONCTUELLE n'a pas d'occurrence : avant 0050,
   * `{{edition_date}}` retombait sur son repli vide et « Edição de  » partait chez les abonnés,
   * sans erreur nulle part.
   */
  test("sans occurrence, la date vient de la CAMPAGNE", () => {
    const s = sujet(ctx({ subject: "Edição de {{edition_date}}", campaign_local_date: "2026-09-06" }));
    expect(s).toBe("Edição de 6 de setembro de 2026");
  });

  test("avec une occurrence, c'est SA date qui prime sur celle de la campagne", () => {
    const s = sujet(
      ctx({
        subject: "{{edition_date}}",
        occurrence_id: "occ_1",
        occurrence_local_date: "2026-09-06",
        campaign_local_date: "2026-01-01",
      }),
    );
    expect(s).toBe("6 de setembro de 2026");
  });

  test("les variantes courtes décrivent le MÊME jour que la date longue", () => {
    const base = { occurrence_id: "occ_1", occurrence_local_date: "2026-09-06" };
    expect(sujet(ctx({ subject: "{{weekday}}", ...base }))).toBe("domingo");
    expect(sujet(ctx({ subject: "{{edition_date_short}}", ...base }))).toBe("6 de set. de 2026");
    expect(sujet(ctx({ subject: "{{edition_date}}", ...base }))).toBe("6 de setembro de 2026");
  });

  /**
   * ⛔ Zéro est une MESURE, pas une absence — même piège que `occurrence.seq = 0`. Une édition sans
   * article doit annoncer « 0 », pas un blanc qui laisse croire que le jeton est cassé.
   */
  test("un compte de 0 s'imprime, il ne disparaît pas", () => {
    const s = sujet(
      ctx({ subject: "{{article_count}} artigos", occurrence_id: "occ_1", occurrence_article_count: 0 }),
    );
    expect(s).toBe("0 artigos");
  });

  /**
   * ⛔ Un envoi hors série (bienvenue, confirmation, campagne ponctuelle) n'a ni numéro ni article.
   * Le repli doit rester VIDE : écrire « #1 » ou un titre inventé produirait un sujet plausible et
   * faux, que personne ne pourrait distinguer d'un vrai.
   */
  test("ce que l'envoi n'a pas, le sujet ne l'invente pas", () => {
    const s = sujet(ctx({ subject: "[{{edition_number}}][{{first_article}}][{{article_count}}]" }));
    expect(s).toBe("[][][]");
  });

  test("le repli inline du registre s'applique aussi au sujet", () => {
    expect(sujet(ctx({ subject: "{{first_article|Le résumé du jour}}" }))).toBe("Le résumé du jour");
  });

  /**
   * ⛔ Un jeton hors registre est retiré EN SILENCE par le moteur (fail-closed voulu). C'est
   * précisément pourquoi l'admin doit refuser de verrouiller un sujet qui en contient un — ce banc
   * fige le comportement du rendu, le refus se joue ailleurs (`campaigns.ts`).
   */
  test("un jeton inconnu s'efface sans faire échouer l'envoi", () => {
    const out = render(ctx({ subject: "Bonjour {{jeton_inexistant}}!" }), "https://public.exemple-nf.test");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.email.subject).toBe("Bonjour !");
      expect(out.email.unknownTokens ?? []).toEqual([]); // le sujet n'est pas rapporté, seul le shell l'est
    }
  });
});

/**
 * Le FORMAT des dates, choisi par modèle (inventaire du 22/09/2026, élément 100).
 *
 * Le worker ne voit jamais le document du builder, seulement le shell compilé : le choix y voyage
 * dans un commentaire `<!--nf:dates …-->` que le compilateur pose. ⛔ Deux choses à tenir : un shell
 * SANS marqueur (tous ceux d'avant) garde le format d'aujourd'hui, et le marqueur ne part JAMAIS chez
 * l'abonné.
 */
const { dateFormatsMarker } = await import("@nf/email");

describe("format des dates choisi par modèle", () => {
  const base = { occurrence_id: "occ_1", occurrence_local_date: "2026-09-06" };

  function rendu(shell: string, subject: string) {
    const out = render(ctx({ subject, campaign_html_shell: shell, ...base }), "https://public.exemple-nf.test");
    if (!out.ok) throw new Error(`rendu refusé : ${out.reason}`);
    return out.email;
  }

  test("le marqueur change le format du corps ET du sujet", () => {
    const m = dateFormatsMarker({ edition_date: "short", weekday: "weekday_short" });
    expect(m).toContain("nf:dates");
    const e = rendu(`${m}<html><body><p>[{{edition_date}}][{{weekday}}]</p>{{legal_footer_html}}</body></html>`, "{{edition_date}}");
    expect(e.subject).toBe("06/09/2026");
    expect(e.html).toContain("[06/09/2026][dom.]");
  });

  test("⛔ le marqueur est retiré du HTML et du texte envoyés", () => {
    const m = dateFormatsMarker({ edition_date: "full" });
    const e = rendu(`${m}<html><body>{{edition_date}}{{legal_footer_html}}</body></html>`, "x");
    expect(e.html).not.toContain("nf:dates");
    expect(e.text).not.toContain("nf:dates");
  });

  test("sans marqueur, le format d'avant (aucun modèle existant ne change)", () => {
    const e = rendu("<html><body>[{{edition_date}}][{{edition_date_short}}][{{weekday}}]{{legal_footer_html}}</body></html>", "{{edition_date}}");
    expect(e.subject).toBe("6 de setembro de 2026");
    expect(e.html).toContain("[6 de setembro de 2026][6 de set. de 2026][domingo]");
  });

  test("les formats par défaut ne posent AUCUN marqueur (le shell d'un modèle non réglé ne bouge pas d'un octet)", () => {
    expect(dateFormatsMarker({})).toBe("");
    expect(dateFormatsMarker({ edition_date: "long", edition_date_short: "medium", weekday: "weekday" })).toBe("");
  });
});
