/**
 * Banc du formatage de la date d'édition.
 *
 * ⛔ CE QUI SE JOUE ICI : `campaign_occurrence.local_date` est une date SEULE (`2026-09-06`), sans
 * heure ni fuseau. `new Date("2026-09-06")` la lit à minuit UTC ; la formater dans le fuseau du
 * serveur la ferait reculer d'un jour partout à l'ouest de Greenwich — c'est-à-dire pour São Paulo
 * (−03) et Santiago (−04), soit les deux marques les plus actives. Une édition datée du 6 partirait
 * en annonçant le 5, sans erreur, sans trace, et seulement pour certains fuseaux.
 */
import { describe, expect, test } from "bun:test";
import type { OutboxContext } from "./db";

const { formatEditionDate, render } = await import("./render");

/** Exécute `f` en capturant les lignes JSON que `log()` écrit (console.log remis en place ensuite). */
function journal<T>(f: () => T): { valeur: T; lignes: Record<string, unknown>[] } {
  const lignes: Record<string, unknown>[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => {
    try {
      lignes.push(JSON.parse(String(a[0])) as Record<string, unknown>);
    } catch {
      /* ligne non JSON : ignorée */
    }
  };
  try {
    return { valeur: f(), lignes };
  } finally {
    console.log = original;
  }
}

/** Un contexte de ligne d'outbox complet. Chaque test ne change QUE ce qu'il mesure. */
function ctx(p: Partial<OutboxContext> = {}): OutboxContext {
  return {
    id: "o1",
    kind: "reengagement",
    subject: "s",
    action_url: null,
    payload: null,
    to_email: "a@example.invalid",
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: "2026-09-08T00:00:00Z",
    created_at: "2026-09-08T00:00:00Z",
    asset_id: "asset-1",
    subscription_id: "sub-1",
    asset_name: "Quartz Tips",
    asset_slug: "quartz-tips",
    sending_subdomain: "mg",
    compliance_regime: "gdpr",
    legal_footer: { physical_address: "1 rue X", privacy_url: "https://x.invalid/privacy", controller: "X" },
    language: "fr",
    sub_status: "active",
    subscriber_id: "subr-1",
    tracking_consent: false,
    suppressed: false,
    purpose: "content",
    market: null,
    consent_mode: null,
    granted_purposes: { content: true },
    ...p,
  } as OutboxContext;
}

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. Le réengagement est le seul e-mail dont le SEUL but est
 * d'obtenir un geste : sans lien cliquable, il demande une action impossible, constate qu'elle n'a
 * pas eu lieu, et fait cesser les envois. On perdrait l'abonné en lui reprochant de n'avoir pas
 * répondu à une question qu'on ne lui a pas posée.
 */
describe("render — réengagement", () => {
  test("l'e-mail porte un lien de préférences cliquable", () => {
    const r = render(ctx(), "https://nf.invalid");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.email.html).toContain('href="https://nf.invalid/preferences?token=');
    // Le lien doit aussi exister dans la version TEXTE : certains clients n'affichent que celle-ci,
    // et un CTA absent du texte rend l'e-mail inutilisable pour eux.
    expect(r.email.text).toContain("https://nf.invalid/preferences?token=");
  });

  test("il ANNONCE qu'on va cesser d'écrire", () => {
    // ⛔ C'est ce qui rend la politique de sunset loyale, et c'est aussi ce qui fait réagir.
    // Retirer cette phrase ferait disparaître quelqu'un de la liste sans qu'il ait jamais su
    // qu'il pouvait rester d'un clic.
    const r = render(ctx(), "https://nf.invalid");
    if (!r.ok) throw new Error(`attendu : rendu. Obtenu : ${r.reason}`);
    expect(r.email.html).toContain("cesserons de vous écrire");
    expect(r.email.text).toContain("cesserons de vous écrire");
  });

  test("SANS abonné identifiable, la ligne est INENVOYABLE — pas envoyée sans lien", () => {
    // `prefsUrl` est nul quand `subscriber_id` l'est. Le rendu doit refuser, pas produire un
    // e-mail dont le bouton ne mène nulle part.
    const r = render(ctx({ subscriber_id: null }), "https://nf.invalid");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("missing_prefs_url");
  });

  test("le sujet et le corps sont dans la langue de la marque", () => {
    const fr = render(ctx({ language: "fr" }), "https://nf.invalid");
    const pt = render(ctx({ language: "pt-BR" }), "https://nf.invalid");
    if (!fr.ok || !pt.ok) throw new Error("attendu : rendu dans les deux langues");
    expect(fr.email.subject).toContain("Quartz Tips");
    expect(fr.email.subject).not.toBe(pt.email.subject);
    expect(pt.email.html).toContain("Você");
  });
});

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER (5A). Rendre les e-mails de cycle de vie éditables est une
 * bonne chose ; les rendre CASSABLES en serait une très mauvaise. Un e-mail de confirmation qui ne
 * part pas, c'est une inscription perdue ET un consentement non prouvé — et personne ne s'en aperçoit
 * avant des semaines, puisque rien n'échoue : la ligne devient un `skipped` silencieux.
 *
 * La règle tenue ici est donc unique et absolue : un template rattaché peut REMPLACER le HTML en
 * dur, il ne peut jamais EMPÊCHER l'envoi. Chaque test ci-dessous casse le template d'une façon
 * différente et vérifie que l'e-mail part quand même.
 */
/**
 * ⛔ POURQUOI CE BANC EXISTE. Le jeton de préférences identifie l'ABONNÉ, jamais l'envoi : sans le
 * paramètre `ls`, l'ouverture des préférences depuis le footer d'une campagne ordinaire serait
 * comptée comme une réaction à une relance. Le taux de réengagement monterait alors tout seul, à
 * mesure qu'on envoie AUTRE CHOSE — un chiffre flatteur qui ne mesure rien, et que personne ne
 * remet en cause parce qu'il va dans le bon sens.
 */
describe("render — le lien de préférences rattache la relance, et elle seule", () => {
  test("une relance porte `&ls=<id de la ligne d'outbox>`, dans le HTML ET dans le texte", () => {
    // Le texte compte autant : certains clients n'affichent que lui, et un rattachement absent là
    // ferait manquer exactement les lecteurs les plus discrets.
    const r = render(ctx({ id: "outbox-42" }), "https://nf.invalid");
    if (!r.ok) throw new Error(`attendu : rendu. Obtenu : ${r.reason}`);
    // ⛔ DANS UN ATTRIBUT HTML, L'ESPERLUETTE S'ÉCRIT `&amp;` — et c'est la forme que le client de
    // messagerie redécode en `&` avant d'appeler l'URL. Le corps de l'e-mail l'écrivait déjà ainsi ;
    // le pied écrivait l'esperluette NUE, ce qui rendait les deux chemins incohérents.
    //
    // ⛔ ANCRÉ SUR LE LIEN DU PIED, PAS SUR LE DOCUMENT. Avant l'échappement, `&ls=` nu n'existait
    // QUE dans le pied, si bien qu'un `toContain` nu le désignait sans ambiguïté. Depuis, le bouton
    // du corps porte la MÊME chaîne échappée : chercher `&amp;ls=outbox-42` partout laisserait le
    // pied perdre son lien de préférences sans que ce test tombe. Le suffixe `" style="color:` est
    // ce qui distingue le lien du pied de celui du corps.
    expect(r.email.html).toContain('&amp;ls=outbox-42" style="color:');
    // Le texte, lui, n'est pas du HTML : l'esperluette y reste nue.
    expect(r.email.text).toContain("&ls=outbox-42");
  });

  test("⛔ un e-mail qui n'est PAS une relance n'en porte pas", () => {
    // Il n'aurait rien à rattacher — et `apps/public` compterait une réaction à une relance qui
    // n'a jamais été envoyée.
    const r = render(ctx({ kind: "welcome", id: "outbox-42" }), "https://nf.invalid");
    if (!r.ok) throw new Error(`attendu : rendu. Obtenu : ${r.reason}`);
    // ⛔ LES DEUX ÉCRITURES, SINON LE GARDE NE GARDE PLUS RIEN. Depuis que le pied échappe ses URL,
    // chercher la seule esperluette nue laisserait passer un `&amp;ls=` — le test resterait vert
    // pendant que le rattachement fautif serait bel et bien dans l'e-mail.
    expect(r.email.html).not.toContain("&ls=");
    expect(r.email.html).not.toContain("&amp;ls=");
  });

  test("le rattachement suit AUSSI le jeton `{{preferences_url}}` d'un template", () => {
    // ⛔ Deux chemins servent le même e-mail — le HTML en dur et le shell rattaché (5A). Si le
    // paramètre n'était posé que sur le premier, rattacher un template ferait tomber la mesure à
    // zéro sans qu'aucune ligne n'échoue.
    //
    // ⛔ CETTE ASSERTION A ÉTÉ VERTE SANS RIEN PROUVER. Le shell contient AUSSI `{{legal_footer_html}}`,
    // et le pied porte son propre lien de préférences : chercher le rattachement dans TOUT le document
    // le trouvait dans le pied même si le jeton du template ne l'avait pas. Elle est donc désormais
    // ancrée sur l'ancre du JETON (`…">rester</a>`), la seule que ce test prétend mesurer.
    const r = render(
      ctx({
        id: "outbox-42",
        lifecycle_html_shell: '<a href="{{preferences_url}}">rester</a>{{legal_footer_html}}',
        lifecycle_subject: "x",
      }),
      "https://nf.invalid",
    );
    if (!r.ok) throw new Error(`attendu : rendu. Obtenu : ${r.reason}`);
    expect(r.email.html).toContain('&amp;ls=outbox-42">rester</a>');
  });
});

describe("render — le template de cycle de vie remplace, et ne peut jamais empêcher", () => {
  const SHELL = "<html><body>SHELL RATTACHE pour {{first_name}} {{legal_footer_html}}</body></html>";

  test("sans rattachement, c'est le HTML en dur qui part", () => {
    // L'état de TOUTES les marques aujourd'hui : la vue rend les colonnes nulles, et ce n'est pas
    // une panne.
    const r = render(ctx({ kind: "welcome" }), "https://nf.invalid");
    if (!r.ok) throw new Error(`attendu : rendu. Obtenu : ${r.reason}`);
    expect(r.email.html).not.toContain("SHELL RATTACHE");
    expect(r.email.html).toContain("Quartz Tips");
  });

  test("avec un shell publié, c'est LUI qui part, hydraté", () => {
    const r = render(
      ctx({
        kind: "welcome",
        payload: { first_name: "Alix" },
        lifecycle_html_shell: SHELL,
        lifecycle_text_shell: "texte {{first_name}}",
        lifecycle_subject: "Bonjour {{first_name}}",
      }),
      "https://nf.invalid",
    );
    if (!r.ok) throw new Error(`attendu : rendu. Obtenu : ${r.reason}`);
    expect(r.email.html).toContain("SHELL RATTACHE pour Alix");
    expect(r.email.subject).toBe("Bonjour Alix");
    expect(r.email.text).toBe("texte Alix");
    // Le footer légal est injecté par le jeton, pas recopié par l'auteur.
    expect(r.email.html).not.toContain("{{legal_footer_html}}");
  });

  /**
   * Les quatre façons de casser un template. AUCUNE ne doit produire un refus : toutes ramènent au
   * HTML en dur. MUTATION QUI DOIT TUER : remplacer un `return null` de `renderLifecycle` par un
   * `return { ok: false, ... }`.
   */
  for (const [nom, patch, raison] of [
    ["shell vide", { lifecycle_html_shell: "   " }, "empty_shell"],
    ["shell sans point d'injection de footer", { lifecycle_html_shell: "<html>rien du tout</html>" }, "no_legal_footer_slot"],
    ["sujet vide après hydratation", { lifecycle_html_shell: SHELL, lifecycle_subject: "{{inconnu}}", subject: "" }, "empty_subject"],
    // ⚠️ Mesuré le 16/09 : l'ancien cas (`{{legal_footer_html}}` seul, `legal_footer: null`) ne
    // s'hydratait PAS en vide — le pied légal le remplissait, le template partait, et le banc était
    // vert pour une autre raison. Ici tout le shell est derrière une condition fausse (aucun numéro
    // d'édition hors série).
    ["shell qui s'hydrate en vide", { lifecycle_html_shell: "<!--nf:if edition_number-->{{legal_footer_html}}<!--nf:endif-->", lifecycle_subject: "x" }, "empty_html"],
  ] as [string, Partial<OutboxContext>, string][]) {
    test(`${nom} ⇒ retour au HTML en dur, jamais un refus, et le repli est journalisé`, () => {
      const { valeur: r, lignes } = journal(() => render(ctx({ kind: "welcome", ...patch }), "https://nf.invalid"));
      // ⛔ Assertion en deux temps, pas une conjonction : `expect(r.ok && x).toBe(false)` serait
      // vert aussi bien si le rendu échouait, et le banc ne prouverait rien.
      if (!r.ok) throw new Error(`refus interdit ici : ${r.reason}`);
      expect(r.email.html).not.toContain("SHELL RATTACHE");
      expect(lignes.filter((l) => l.event === "lifecycle_fallback").map((l) => l.reason)).toEqual([raison]);
    });
  }

  test("sans template rattaché : repli sur le dur SANS ligne de journal (cas normal)", () => {
    const { valeur: r, lignes } = journal(() => render(ctx({ kind: "welcome" }), "https://nf.invalid"));
    expect(r.ok).toBe(true);
    expect(lignes.filter((l) => l.event === "lifecycle_fallback")).toEqual([]);
  });

  test("une confirmation sans lien reste INENVOYABLE, template ou pas", () => {
    // ⛔ La garde d'inenvoyabilité passe avant le template. Un shell qui porte {{confirm_url}} sans
    // action_url derrière imprimerait le repli "#" : l'inscription serait perdue sur un lien mort
    // plutôt que refusée bruyamment.
    const r = render(ctx({ kind: "confirmation", action_url: null, lifecycle_html_shell: SHELL, lifecycle_subject: "x" }), "https://nf.invalid");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("missing_action_url");
  });

  test("un réengagement sans lien de préférences reste INENVOYABLE, template ou pas", () => {
    const r = render(
      ctx({ kind: "reengagement", subscriber_id: null, lifecycle_html_shell: SHELL, lifecycle_subject: "x" }),
      "https://nf.invalid",
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("missing_prefs_url");
  });

  test("{{confirm_url}} est résolu, pas retiré en silence", () => {
    // ⛔ Le jeton vient d'entrer au registre. Sans cette ligne, `applyTokens` le remplaçait par du
    // VIDE : un e-mail de confirmation partait avec un bouton sans destination.
    const r = render(
      ctx({
        kind: "confirmation",
        action_url: "https://nf.invalid/confirm?t=abc",
        lifecycle_html_shell: "<a href=\"{{confirm_url}}\">ok</a>{{legal_footer_html}}",
        lifecycle_subject: "Confirmez",
      }),
      "https://nf.invalid",
    );
    if (!r.ok) throw new Error(`attendu : rendu. Obtenu : ${r.reason}`);
    expect(r.email.html).toContain('href="https://nf.invalid/confirm?t=abc"');
    expect(r.email.html).not.toContain("{{confirm_url}}");
  });

  test("le kind décide : un rattachement de welcome ne sert pas une confirmation", () => {
    // La vue joint sur (asset_id, kind) ; ce banc garde le contrat côté rendu, où le shell est déjà
    // résolu. Un shell absent = pas de rattachement pour CE kind.
    const r = render(ctx({ kind: "confirmation", action_url: "https://nf.invalid/c" }), "https://nf.invalid");
    if (!r.ok) throw new Error(`attendu : rendu. Obtenu : ${r.reason}`);
    expect(r.email.html).not.toContain("SHELL RATTACHE");
  });
});

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER (5B). Le moteur de conditionnels n'a PAS de `else`, et il
 * est fail-closed dans les DEUX polarités : si aucun drapeau de régime n'est vrai, tous les blocs
 * légaux disparaissent et l'e-mail part SANS AUCUNE mention — sans qu'une seule ligne de code
 * échoue, et sans que rien ne l'indique avant la boîte de réception.
 *
 * Ce banc tient la jonction : que le rendu RÉEL pose bien, depuis `compliance_regime`, exactement
 * un drapeau vrai. Le moteur lui-même est tenu par `packages/render/src/hydrate/conditions.test.ts`.
 */
describe("render — les drapeaux de régime arrivent jusqu'au template", () => {
  const DOC =
    "<!--nf:if is_gdpr-->RGPD<!--nf:endif-->" +
    "<!--nf:if is_lgpd-->LGPD<!--nf:endif-->" +
    "<!--nf:if is_can_spam-->CANSPAM<!--nf:endif-->" +
    "{{legal_footer_html}}";

  for (const [regime, attendu] of [
    ["gdpr", "RGPD"],
    ["lgpd", "LGPD"],
    ["canspam", "CANSPAM"],
    // ⛔ Les trois cas qui feraient partir un e-mail MUET si le calcul n'était pas exhaustif.
    // Un régime absent retombe sur le plus strict : de trop, ce n'est qu'une mention en trop.
    [null, "RGPD"],
    ["", "RGPD"],
    ["regime_invente", "RGPD"],
  ] as [string | null, string][]) {
    test(`régime ${regime === null ? "absent" : regime || "vide"} ⇒ ${attendu}, et lui seul`, () => {
      const r = render(
        // ⚠️ Le cast est le SUJET du test, pas un contournement : `compliance_regime` est typé sur
        // trois valeurs, mais la colonne est du texte libre côté base — rien n'empêche une
        // migration, un seed ou une saisie d'y écrire autre chose. Le typage protège le code
        // qu'on écrit, pas la donnée qu'on lit.
        ctx({
          kind: "welcome",
          compliance_regime: regime as OutboxContext["compliance_regime"],
          lifecycle_html_shell: DOC,
          lifecycle_subject: "x",
        }),
        "https://nf.invalid",
      );
      if (!r.ok) throw new Error(`attendu : rendu. Obtenu : ${r.reason}`);
      for (const bloc of ["RGPD", "LGPD", "CANSPAM"]) {
        if (bloc === attendu) expect(r.email.html).toContain(bloc);
        else expect(r.email.html).not.toContain(bloc);
      }
    });
  }

  test("market est déjà servi : <!--nf:if market==\"DE\"--> marche sans code neuf", () => {
    const doc = '<!--nf:if market=="DE"-->IMPRESSUM<!--nf:endif-->{{legal_footer_html}}';
    const de = render(ctx({ kind: "welcome", market: "DE", lifecycle_html_shell: doc, lifecycle_subject: "x" }), "https://nf.invalid");
    const br = render(ctx({ kind: "welcome", market: "BR", lifecycle_html_shell: doc, lifecycle_subject: "x" }), "https://nf.invalid");
    if (!de.ok || !br.ok) throw new Error("attendu : rendu dans les deux marchés");
    expect(de.email.html).toContain("IMPRESSUM");
    expect(br.email.html).not.toContain("IMPRESSUM");
  });
});

describe("formatEditionDate", () => {
  test("écrit le jour en toutes lettres, dans la langue de la marque", async () => {
    expect(formatEditionDate("2026-09-06", "pt-BR")).toBe("6 de setembro de 2026");
    expect(formatEditionDate("2026-09-06", "es")).toBe("6 de septiembre de 2026");
    expect(formatEditionDate("2026-09-06", "en")).toBe("September 6, 2026");
    expect(formatEditionDate("2026-09-06", "fr")).toBe("6 septembre 2026");
  });

  test("les bascules de mois et d'année sont rendues telles quelles", async () => {
    expect(formatEditionDate("2026-09-01", "pt-BR")).toBe("1 de setembro de 2026");
    expect(formatEditionDate("2026-01-01", "pt-BR")).toBe("1 de janeiro de 2026");
  });

  /**
   * ⛔ CE TEST DOIT TOURNER DANS UN SOUS-PROCESSUS, et c'est tout son intérêt.
   *
   * `bun test` force le fuseau du runtime à **UTC** (vérifié : `Intl…resolvedOptions().timeZone`
   * rend "UTC" sous `bun test`, alors que la machine est en America/Sao_Paulo). C'est précisément
   * le seul fuseau où l'oubli de `timeZone: "UTC"` ne se voit PAS. Un test écrit normalement reste
   * donc vert même si le garde-fou est retiré — mesuré le 03/09/2026 : la mutation survivait.
   *
   * On relance donc la fonction dans un processus au fuseau de São Paulo (−03), celui de la marque
   * la plus active. Sans le garde-fou, le 1er septembre y est rendu « 31 de agosto ».
   */
  test("⛔ le jour rendu est celui de la base, même sous un fuseau négatif", async () => {
    const fichier = `file:///${import.meta.dir.replace(/\\/g, "/")}/render.ts`;
    const script = `const {formatEditionDate} = await import(${JSON.stringify(fichier)});
      console.log(formatEditionDate("2026-09-01", "pt-BR"));`;
    const r = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env, TZ: "America/Sao_Paulo" },
    });
    const sortie = new TextDecoder().decode(r.stdout).trim();
    // La sonde doit prouver qu'elle a lu quelque chose avant qu'on interprète son silence.
    expect(sortie.length).toBeGreaterThan(0);
    expect(sortie).toBe("1 de setembro de 2026");
  });

  test("une date absente ou illisible rend du vide, jamais « Invalid Date »", async () => {
    // Une occurrence annulée peut avoir perdu sa date : `local_date` est nullable.
    expect(formatEditionDate(null, "pt-BR")).toBe("");
    expect(formatEditionDate(undefined, "pt-BR")).toBe("");
    expect(formatEditionDate("", "pt-BR")).toBe("");
    expect(formatEditionDate("pas une date", "pt-BR")).toBe("");
    expect(formatEditionDate("2026-13-45", "pt-BR")).toBe("");
  });
});
