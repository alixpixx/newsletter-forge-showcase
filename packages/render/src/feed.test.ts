/**
 * BANC DE PREUVE DU DÉPLIAGE DES FLUX — `bun test` depuis la racine du dépôt.
 *
 * ⛔ LES LIBELLÉS ATTENDUS SONT ÉCRITS EN DUR ICI, jamais lus dans `./cta`. Un banc qui recopie sa
 * référence depuis la table qu'il surveille ne mesure que lui-même : la table pourrait passer au
 * klingon, il resterait vert. Changer un libellé DOIT faire rougir ce fichier — c'est le seul
 * endroit du dépôt où le choix éditorial est écrit une seconde fois, et cette duplication est le
 * mécanisme même de la preuve.
 *
 * ⚠️ CE QUE CE BANC PROTÈGE EN PRIORITÉ N'EST PAS LE DÉFAUT, C'EST LA CONTRE-ÉPREUVE (b). Un
 * libellé saisi à la main ne doit jamais être écrasé : « Read and comment » est propre à Harbor Tech
 * (c'est un forum, pas un journal). Si le défaut l'écrase, rien ne casse et rien ne s'affiche en
 * rouge à l'écran — l'email part, et la marque a perdu sa voix. La contre-épreuve se joue donc sur
 * un document `pt-BR`, dont le défaut (« Ler a matéria ») DIFFÈRE du libellé saisi : mesurée sur un
 * document anglais, elle passerait même avec un défaut qui écrase tout, puisque les deux chaînes
 * coïncideraient.
 *
 * ⚠️ Pourquoi le dépliage et pas le schéma : le défaut est posé par `withDefaultCta`, appelée depuis
 * `expandFeedBlocks` — le seul endroit qui tienne à la fois le bloc et `meta.locale`. `toArticle`,
 * elle, ne reçoit PAS la locale et recopie le libellé du flux tel quel. Les assertions portent donc
 * TOUJOURS sur une locale de document, jamais sur une constante globale — c'est précisément la
 * propriété qu'un `.default()` de schéma perdrait.
 */
import { describe, expect, test } from "bun:test";
import { defaultArticleCta } from "./cta";
import { expandFeedBlocks, type FeedResolution } from "./feed";
import { ArticleBlock, EmailDoc, FeedItem, type Block } from "./schema";

/**
 * LES SIX LIBELLÉS, RECOPIÉS À LA MAIN. Toute la valeur de ce banc tient dans le fait que cette
 * table n'est PAS importée. Ne jamais la remplacer par un import de `./cta`.
 */
const EN = "Read more";
const ES = "Leer la nota";
const PT = "Ler a matéria";
const FR = "Lire l'article";
const IT = "Leggi l'articolo";
const SV = "Läs artikeln";

const item = (n: number): Record<string, unknown> => ({
  postId: `post-${n}`,
  title: `Article ${n}`,
  excerpt: `Excerpt ${n}`,
  href: `https://example.test/article-${n}`,
});

/**
 * Un document à UN flux. Locale et libellé du flux sont les deux SEULES variables : un banc qui
 * ferait bouger autre chose ne saurait plus dire laquelle des deux a produit le chiffre.
 */
function docWithFeed(locale: string, ctaLabel?: string, count = 2): EmailDoc {
  return EmailDoc.parse({
    schema: 2,
    meta: { subject: "Fixture feed", preheader: "Fixture feed", assetSlug: "demo-brand", locale },
    theme: {},
    rows: [
      {
        id: "row_feed",
        layout: "1",
        columns: [
          {
            id: "col_feed",
            blocks: [
              {
                id: "blk_feed",
                type: "article-feed",
                sourceId: "src_1",
                ...(ctaLabel === undefined ? {} : { ctaLabel }),
                previewItems: Array.from({ length: count }, (_, i) => item(i + 1)),
                previewAt: "2026-08-28T06:00:00.000Z",
              },
            ],
          },
        ],
      },
    ],
  });
}

/** Les cartes produites, dans l'ordre de lecture. */
function articlesOf(doc: EmailDoc): Extract<Block, { type: "article" }>[] {
  const out: Extract<Block, { type: "article" }>[] = [];
  for (const row of doc.rows) {
    for (const column of row.columns) {
      for (const block of column.blocks) if (block.type === "article") out.push(block);
    }
  }
  return out;
}

/** Les libellés des cartes d'un document déplié — la grandeur mesurée dans presque tout ce banc. */
const ctaLabelsOf = (locale: string, ctaLabel?: string, count = 2): (string | undefined)[] =>
  articlesOf(expandFeedBlocks(docWithFeed(locale, ctaLabel, count)).doc).map((a) => a.ctaLabel);

describe("(a) sans libellé de flux, chaque carte reçoit le défaut de la LOCALE DU DOCUMENT", () => {
  test("pt-BR", () => {
    expect(ctaLabelsOf("pt-BR")).toEqual([PT, PT]);
  });

  test("es-CL", () => {
    expect(ctaLabelsOf("es-CL")).toEqual([ES, ES]);
  });

  // `sv` n'existe pas dans le `Locale` de `@nf/email` : c'est le cas qui justifie une table PROPRE à
  // `packages/render` plutôt qu'un emprunt à l'i18n des transactionnels.
  test("sv", () => {
    expect(ctaLabelsOf("sv")).toEqual([SV, SV]);
  });

  test("une locale inconnue retombe sur l'anglais, jamais sur du vide", () => {
    expect(ctaLabelsOf("xx-YY")).toEqual([EN, EN]);
  });

  // ⛔ Le vrai défaut corrigé n'est pas « pas de bouton », c'est « aucun lien cliquable » : dans
  // `compile/mjml.ts` le titre est un `<div>` nu, seuls l'image et le CTA portent un `<a>`.
  test("aucune carte ne repart sans libellé", () => {
    for (const locale of ["en", "es", "pt-BR", "fr", "it", "sv", "xx-YY"]) {
      for (const label of ctaLabelsOf(locale)) {
        expect(label).toBeTruthy();
        expect((label ?? "").trim()).not.toBe("");
      }
    }
  });
});

describe("(b) CONTRE-ÉPREUVE — un libellé saisi n'est JAMAIS réécrit par le défaut", () => {
  // Document brésilien, libellé anglais saisi : les deux chaînes diffèrent, donc l'assertion sait
  // distinguer « le défaut respecte la saisie » de « le défaut écrase tout ».
  test("« Read and comment » survit sur un document pt-BR", () => {
    const labels = ctaLabelsOf("pt-BR", "Read and comment");
    expect(labels).toEqual(["Read and comment", "Read and comment"]);
    for (const label of labels) expect(label).not.toBe(PT);
  });

  test("un libellé saisi dans la langue du document survit aussi", () => {
    expect(ctaLabelsOf("es", "Ver el análisis")).toEqual(["Ver el análisis", "Ver el análisis"]);
  });
});

describe("(c) une chaîne vide est une ABSENCE, pas un libellé", () => {
  // Le schéma l'autorise (`z.string().max(28).optional()`, sans `.min(1)`), donc le cas est
  // atteignable en base par une saisie effacée. Le laisser passer intact rendrait une carte que
  // `blank()` juge sans CTA au rendu : exactement le défaut que ce chantier corrige.
  test("« » retombe sur le défaut de la locale", () => {
    expect(ctaLabelsOf("es", "")).toEqual([ES, ES]);
  });

  test("des espaces seuls aussi", () => {
    expect(ctaLabelsOf("pt-BR", "   ")).toEqual([PT, PT]);
  });
});

describe("(d) defaultArticleCta — normalisation du tag BCP-47 et repli", () => {
  // La table est indexée par la LANGUE seule : `pt-PT` doit hériter du portugais, pas de l'anglais.
  // Une clé régionale `pt-BR` produirait ce défaut-là, d'où ce cas.
  const cases: [string | undefined, string][] = [
    ["en", EN],
    ["en-GB", EN],
    ["EN_us", EN],
    ["es", ES],
    ["es-CL", ES],
    ["pt", PT],
    ["pt-BR", PT],
    ["pt-PT", PT],
    ["fr", FR],
    ["fr-BE", FR],
    ["it", IT],
    ["sv", SV],
    ["xx-YY", EN],
    ["", EN],
    ["  ", EN],
    [undefined, EN],
  ];

  for (const [locale, expected] of cases) {
    test(`${JSON.stringify(locale)} → ${expected}`, () => {
      expect(defaultArticleCta(locale)).toBe(expected);
    });
  }

  // Un libellé trop long ne serait pas tronqué mais REFUSÉ par le schéma au parse : le bloc produit
  // par le dépliage serait invalide et la publication tomberait. On mesure donc les deux : la
  // longueur écrite ici en dur, et l'acceptation par la contrainte réelle du schéma.
  test("aucun défaut ne dépasse 28 caractères, et tous passent le schéma", () => {
    for (const label of [EN, ES, PT, FR, IT, SV]) {
      expect(label.length).toBeLessThanOrEqual(28);
      const parsed = ArticleBlock.parse({
        id: "blk_probe",
        type: "article",
        title: "Probe",
        excerpt: "Probe",
        imageAlt: "",
        href: "https://example.test/probe",
        ctaLabel: label,
      });
      expect(parsed.ctaLabel).toBe(label);
    }
  });
});

describe("(e) le report du dépliage reste juste", () => {
  test("aperçu : un flux plein, un flux vide, et un bloc qui n'est pas un flux", () => {
    const doc = EmailDoc.parse({
      schema: 2,
      meta: { subject: "Fixture report", preheader: "Fixture report", assetSlug: "demo-brand", locale: "fr" },
      theme: {},
      rows: [
        {
          id: "row_a",
          layout: "1",
          columns: [
            {
              id: "col_a",
              blocks: [
                {
                  id: "blk_full",
                  type: "article-feed",
                  sourceId: "src_1",
                  previewItems: [item(1), item(2), item(3)],
                },
                {
                  id: "blk_empty",
                  type: "article-feed",
                  sourceId: "src_2",
                  previewItems: [],
                },
                { id: "blk_footer", type: "footer_legal" },
              ],
            },
          ],
        },
      ],
    });

    const { doc: expanded, report } = expandFeedBlocks(doc);

    expect(report.feeds).toBe(2);
    expect(report.articles).toBe(3);
    expect(report.emptyBlockIds).toEqual(["blk_empty"]);
    expect(report.previewBlockIds).toEqual(["blk_full", "blk_empty"]);

    // Le flux vide DISPARAÎT, le bloc étranger reste : 3 cartes + le pied de page.
    const blocks = expanded.rows[0]?.columns[0]?.blocks ?? [];
    expect(blocks.map((b) => b.id)).toEqual(["blk_full-1", "blk_full-2", "blk_full-3", "blk_footer"]);
    expect(articlesOf(expanded).map((a) => a.ctaLabel)).toEqual([FR, FR, FR]);
  });

  test("chemin d'envoi réel : une résolution fournie ne compte plus comme aperçu", () => {
    const resolved: Record<string, FeedResolution> = {
      blk_feed: {
        items: [FeedItem.parse(item(9))],
        fetchedAt: "2026-08-28T05:30:00.000Z",
      },
    };

    const { doc: expanded, report } = expandFeedBlocks(docWithFeed("it"), resolved);
    const cards = articlesOf(expanded);

    expect(report).toEqual({ feeds: 1, articles: 1, emptyBlockIds: [], previewBlockIds: [] });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.source?.fetchedAt).toBe("2026-08-28T05:30:00.000Z");
    // Le défaut est posé par le dépliage lui-même, pas par la fabrique de carte : il doit donc
    // valoir sur le chemin d'envoi (résolution fournie), pas seulement sur l'aperçu à l'écran.
    expect(cards[0]?.ctaLabel).toBe(IT);
  });

  test("un document sans flux ressort INCHANGÉ, à l'identité près", () => {
    const doc = docWithFeed("en");
    const { doc: once } = expandFeedBlocks(doc);
    const { doc: twice, report } = expandFeedBlocks(once);

    expect(report).toEqual({ feeds: 0, articles: 0, emptyBlockIds: [], previewBlockIds: [] });
    expect(twice).toBe(once);
  });
});

/* ================================================================== *
 * SOCLE BIS — les blocs article DÉJÀ STOCKÉS, ceux qui ne viennent d'aucun flux.
 *
 * ⛔ C'EST LE CAS QUI A FAIT LE BUG HARBOR TECH, et il n'avait aucune preuve. Tant que le dépliage
 * sautait les colonnes sans flux, ces blocs-là ne voyaient jamais le défaut : Harbor Tech partait
 * avec 1 CTA sur 3, et les deux articles muets n'avaient AUCUN lien cliquable (dans `compile/mjml`
 * le titre est un `<div>` nu). Les cas (a)-(e) ci-dessus passent TOUS par un flux — ils seraient
 * restés verts pendant que la moitié des emails partaient mutilés.
 * ================================================================== */

/**
 * Un document à UNE colonne de blocs article STOCKÉS, sans le moindre flux. `labels` décrit bloc
 * par bloc ce qui est en base : `undefined` = jamais saisi, `""` / `"   "` = saisie effacée.
 */
function docWithStoredArticles(locale: string, labels: (string | undefined)[]): EmailDoc {
  return EmailDoc.parse({
    schema: 2,
    meta: { subject: "Fixture stored", preheader: "Fixture stored", assetSlug: "demo-brand", locale },
    theme: {},
    rows: [
      {
        id: "row_stored",
        layout: "1",
        columns: [
          {
            id: "col_stored",
            blocks: labels.map((label, i) => ({
              id: `blk_art_${i + 1}`,
              type: "article",
              title: `Article ${i + 1}`,
              excerpt: `Excerpt ${i + 1}`,
              imageAlt: "",
              href: `https://example.test/stored-${i + 1}`,
              ...(label === undefined ? {} : { ctaLabel: label }),
            })),
          },
        ],
      },
    ],
  });
}

describe("(f) blocs article STOCKÉS, aucun flux — le cas du bug Harbor Tech", () => {
  // La forme exacte de `docs/maquettes/compile/harborTech.doc.json` : 3 blocs article, UN seul
  // ctaLabel saisi. Le document est en pt-BR pour que le saisi (« Read and comment ») DIVERGE du
  // défaut (« Ler a matéria ») : mesurée en anglais, l'assertion passerait même avec un défaut qui
  // écrase tout, puisque les deux chaînes coïncideraient.
  test("les muets reçoivent le défaut, le saisi ressort intact", () => {
    const doc = docWithStoredArticles("pt-BR", ["Read and comment", undefined, undefined]);
    const labels = articlesOf(expandFeedBlocks(doc).doc).map((a) => a.ctaLabel);

    expect(labels).toEqual(["Read and comment", PT, PT]);
    expect(labels[0]).not.toBe(PT);
  });

  // Pas « une copie égale » mais LE MÊME OBJET : c'est ce qui prouve qu'aucun autre champ du bloc
  // saisi n'a été reconstruit au passage, et que le libellé n'a pas été réécrit par chance avec la
  // même valeur.
  test("un bloc qui porte un libellé ressort par IDENTITÉ, pas par recopie", () => {
    const doc = docWithStoredArticles("pt-BR", ["Read and comment", undefined]);
    const original = doc.rows[0]?.columns[0]?.blocks[0];

    expect(expandFeedBlocks(doc).doc.rows[0]?.columns[0]?.blocks[0]).toBe(original);
  });

  test("chaque locale pose SON défaut sur un bloc stocké", () => {
    const cases: [string, string][] = [
      ["en", EN],
      ["es-CL", ES],
      ["pt-BR", PT],
      ["fr", FR],
      ["it", IT],
      ["sv", SV],
      ["xx-YY", EN],
    ];
    for (const [locale, expected] of cases) {
      const { doc } = expandFeedBlocks(docWithStoredArticles(locale, [undefined]));
      expect(articlesOf(doc).map((a) => a.ctaLabel)).toEqual([expected]);
    }
  });

  // Le pendant du cas (c), mais sur le chemin STOCKÉ : une saisie effacée en base ne doit pas plus
  // produire un bouton vide ici qu'au bout d'un flux. Deux chemins, une seule définition d'absence.
  test("chaîne vide et espaces seuls sont des ABSENCES ici aussi", () => {
    const { doc } = expandFeedBlocks(docWithStoredArticles("pt-BR", ["", "   ", "\t\n"]));
    expect(articlesOf(doc).map((a) => a.ctaLabel)).toEqual([PT, PT, PT]);
  });

  test("aucun bloc stocké ne repart sans libellé, quelle que soit la locale", () => {
    for (const locale of ["en", "es", "pt-BR", "fr", "it", "sv", "xx-YY"]) {
      const { doc } = expandFeedBlocks(docWithStoredArticles(locale, [undefined, "", "   "]));
      for (const article of articlesOf(doc)) {
        expect(typeof article.ctaLabel).toBe("string");
        expect((article.ctaLabel ?? "").trim()).not.toBe("");
      }
    }
  });

  // L'identité du document sert d'optimisation à des appelants. Elle ne tient plus par « pas de
  // flux ⇒ colonne intacte » mais par « rien à modifier ⇒ colonne intacte » : elle doit donc être
  // remesurée sur un document SANS flux, là où l'ancien mécanisme la donnait gratuitement.
  test("un second passage ressort le MÊME document, par identité", () => {
    const { doc: once } = expandFeedBlocks(docWithStoredArticles("fr", [undefined, "Voir"]));
    expect(expandFeedBlocks(once).doc).toBe(once);
  });

  test("un document dont TOUS les blocs portent déjà un libellé ressort inchangé", () => {
    const doc = docWithStoredArticles("pt-BR", ["Read and comment", "Ver"]);
    expect(expandFeedBlocks(doc).doc).toBe(doc);
  });
});

describe("(g) le report ne compte QUE les flux, jamais les blocs stockés complétés", () => {
  // Un compteur qui se mettrait à voir les défauts posés ferait mentir `articles`, dont le
  // planificateur se sert pour décider s'il a de quoi envoyer. Un bloc stocké n'est pas un article
  // PRODUIT : il était déjà là avant le dépliage.
  test("aucun flux : report entièrement à zéro malgré 3 défauts posés", () => {
    const { doc, report } = expandFeedBlocks(docWithStoredArticles("pt-BR", [undefined, "", "   "]));

    expect(report).toEqual({ feeds: 0, articles: 0, emptyBlockIds: [], previewBlockIds: [] });
    expect(articlesOf(doc).map((a) => a.ctaLabel)).toEqual([PT, PT, PT]);
  });

  test("flux et blocs stockés mêlés : seules les cartes du flux sont comptées", () => {
    const doc = EmailDoc.parse({
      schema: 2,
      meta: { subject: "Fixture mixte", preheader: "Fixture mixte", assetSlug: "demo-brand", locale: "pt-BR" },
      theme: {},
      rows: [
        {
          id: "row_mix",
          layout: "1",
          columns: [
            {
              id: "col_mix",
              blocks: [
                {
                  id: "blk_stored",
                  type: "article",
                  title: "Stored",
                  excerpt: "Stored",
                  imageAlt: "",
                  href: "https://example.test/stored",
                },
                {
                  id: "blk_feed",
                  type: "article-feed",
                  sourceId: "src_1",
                  previewItems: [item(1), item(2)],
                  previewAt: "2026-08-28T06:00:00.000Z",
                },
              ],
            },
          ],
        },
      ],
    });

    const { doc: expanded, report } = expandFeedBlocks(doc);

    expect(report).toEqual({ feeds: 1, articles: 2, emptyBlockIds: [], previewBlockIds: ["blk_feed"] });
    // Le bloc stocké garde sa place AVANT les cartes du flux, et reçoit le même défaut qu'elles.
    expect(articlesOf(expanded).map((a) => a.id)).toEqual(["blk_stored", "blk_feed-1", "blk_feed-2"]);
    expect(articlesOf(expanded).map((a) => a.ctaLabel)).toEqual([PT, PT, PT]);
  });
});

describe("(h) FUITE PAR LA CHAÎNE DE PROTOTYPES — le tag de langue est une entrée non fiable", () => {
  // `meta.locale` est recopié depuis `asset.languages` en base : rien ne garantit que c'est un vrai
  // tag BCP-47. Sur un littéral objet, `ARTICLE_CTA["constructor"]` rend une FONCTION et
  // `["__proto__"]` l'objet racine, que `??` laisse passer puisqu'il ne filtre que `null` et
  // `undefined` — le bouton d'un email afficherait alors du code source. Ce test est le seul
  // garde-fou du choix `Map` : sans lui, un refactor « simplifions en objet littéral » repasse au
  // vert et la promesse « ne rend jamais autre chose qu'un libellé » se défait en silence.
  //
  // ⚠️ MESURÉ, pas supposé : en remplaçant la `Map` par un objet littéral, SEUL « constructor »
  // rougit. La normalisation en désamorce les autres par effet de bord — `toString` est
  // minusculisé en `tostring`, `__proto__` est coupé au premier `_` et devient la clé vide. Ce
  // sont des protections ACCIDENTELLES : elles disparaîtraient si la normalisation changeait.
  // La liste reste donc complète, et c'est « constructor » qui tient le garde-fou.
  const hostile = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "prototype"];

  for (const locale of hostile) {
    test(`defaultArticleCta(${JSON.stringify(locale)}) rend LA CHAÎNE de repli`, () => {
      const label = defaultArticleCta(locale);
      expect(typeof label).toBe("string");
      expect(label).toBe(EN);
    });
  }

  // La même attaque, mais servie par le document plutôt que par un appel direct : `meta.locale` est
  // contraint à 2..12 caractères, ce qui laisse passer « constructor » (11) et « __proto__ » (9).
  // La fuite est donc atteignable depuis la base, et pas seulement depuis un test.
  for (const locale of ["constructor", "__proto__"]) {
    test(`un document en locale ${JSON.stringify(locale)} pose un libellé, pas une fonction`, () => {
      const { doc } = expandFeedBlocks(docWithStoredArticles(locale, [undefined]));
      const label = articlesOf(doc)[0]?.ctaLabel;
      expect(typeof label).toBe("string");
      expect(label).toBe(EN);
    });
  }
});

/**
 * Combien de fois `needle` apparaît dans `hay`. Dans le HTML d'un bloc article, le libellé du CTA
 * n'est écrit QU'UNE fois (le `<a>` du bas de carte) : compter la chaîne compte donc les boutons.
 */
const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe("(i) LA MESURE DE BOUT EN BOUT — le HTML compilé, pas seulement le document", () => {
  // ⛔ Le bug Harbor Tech ne se voyait ni dans le schéma ni dans le report : il se voyait dans le
  // HTML, à 1 CTA au lieu de 3. Toutes les assertions ci-dessus portent sur le document déplié —
  // elles resteraient vertes si le compilateur cessait de rendre le bouton. Ce cas-ci descend donc
  // jusqu'à la sortie livrée. Locale pt-BR : le défaut ne porte pas d'apostrophe, que `escapeHtml`
  // transformerait en `&#39;` et qui rendrait le comptage illisible.
  test("3 blocs article stockés, 1 libellé saisi ⇒ 3 CTA dans le HTML", async () => {
    const { compileDoc } = await import("./compile");
    const { html } = await compileDoc(docWithStoredArticles("pt-BR", ["Read and comment", undefined, ""]));

    expect(countOf(html, "Read and comment")).toBe(1);
    expect(countOf(html, PT)).toBe(2);

    // ⛔ CE QUE LE COMPTAGE DES LIBELLÉS NE VOIT PAS, et qui est le vrai dégât du bug Harbor Tech :
    // sans libellé, `articleHtml` ne rend AUCUN `<a>` pour la carte (compile/mjml.ts, `cta` vaut
    // "") et le titre reste un `<div>` nu — l'article part sans un seul lien cliquable. Ces cartes
    // n'ont pas d'image, donc leur `href` n'apparaît dans le HTML QUE par le bouton : compter les
    // URL ancrées compte les cartes atteignables. Les 3 doivent y être, pas seulement celle qui
    // porte un libellé saisi.
    const linked = [1, 2, 3].filter((n) => html.includes(`<a href="https://example.test/stored-${n}"`));
    expect(linked).toEqual([1, 2, 3]);
  });

  test("un libellé saisi survit à la compilation d'un document dont il n'est pas la langue", async () => {
    const { compileDoc } = await import("./compile");
    const { html } = await compileDoc(docWithStoredArticles("pt-BR", ["Read and comment"]));

    expect(countOf(html, "Read and comment")).toBe(1);
    expect(countOf(html, PT)).toBe(0);
  });
});

/**
 * Un document à UN bloc article stocké dont le HREF est la variable mesurée. `docWithStoredArticles`
 * ne sait poser qu'un lien légitime : c'est justement l'autre moitié du plan de mesure.
 */
function docWithHref(locale: string, href: string, ctaLabel?: string): EmailDoc {
  return EmailDoc.parse({
    schema: 2,
    meta: { subject: "Fixture href", preheader: "Fixture href", assetSlug: "demo-brand", locale },
    theme: {},
    rows: [
      {
        id: "row_href",
        layout: "1",
        columns: [
          {
            id: "col_href",
            blocks: [
              {
                id: "blk_art_1",
                type: "article",
                title: "Article",
                excerpt: "Excerpt",
                imageAlt: "",
                href,
                ...(ctaLabel === undefined ? {} : { ctaLabel }),
              },
            ],
          },
        ],
      },
    ],
  });
}

const labelOf = (locale: string, href: string, ctaLabel?: string): string | undefined =>
  articlesOf(expandFeedBlocks(docWithHref(locale, href, ctaLabel)).doc)[0]?.ctaLabel;

/* ================================================================== *
 * LA GARDE — on ne fabrique pas un bouton par-dessus un lien qui ne mène nulle part.
 *
 * ⛔ CE BANC MESURE UN ARBITRAGE, PAS UNE ABSENCE. Les deux sens comptent autant l'un que l'autre :
 * poser le défaut sur « # » expédie chez l'abonné le lien mort que `lib/ai/compose.ts` venait de
 * neutraliser ; refuser le défaut trop largement rouvre le bug Harbor Tech sur du stock parfaitement
 * relié. Un test qui ne prouverait que le premier sens laisserait passer le second.
 * ================================================================== */
describe("(j) la garde : aucun défaut sur un href qui ne mène nulle part", () => {
  // Locale pt-BR partout : le défaut (« Ler a matéria ») DIFFÈRE du libellé saisi, donc une
  // assertion sur le saisi ne peut pas coïncider par hasard avec un défaut qui écraserait tout.
  test("href « # » et libellé absent ⇒ AUCUN libellé posé", () => {
    expect(labelOf("pt-BR", "#")).toBe(undefined);
  });

  test("href de remplissage des fabriques et libellé absent ⇒ AUCUN libellé posé", () => {
    expect(labelOf("pt-BR", "https://example.com")).toBe(undefined);
    expect(labelOf("pt-BR", "https://example.com/")).toBe(undefined);
    // Espaces autour : c'est la même valeur, elle doit être jugée pareil.
    expect(labelOf("pt-BR", "  #  ")).toBe(undefined);
  });

  // ⛔ LE SENS QUI PROTÈGE LE TRAVAIL HUMAIN, et le plus grave à casser : la garde ne retient que le
  // DÉFAUT. Un auteur qui a tapé son libellé sur un bloc au lien douteux le garde — sinon la garde
  // effacerait de la saisie, exactement ce que tout ce chantier interdit.
  test("MÊME href, mais libellé SAISI ⇒ le libellé survit", () => {
    expect(labelOf("pt-BR", "#", "Read and comment")).toBe("Read and comment");
    expect(labelOf("pt-BR", "https://example.com", "Read and comment")).toBe("Read and comment");
  });

  /**
   * ⛔ LE CAS QUE LA COMPARAISON DE VALEURS NE SAIT PAS VOIR. Quand la saisie humaine est
   * EXACTEMENT le défaut de sa langue, « le libellé a survécu » et « on a reposé le même texte
   * par-dessus » produisent la même chaîne : aucun `toBe(PT)` ne peut les départager. Le seul
   * témoin restant est l'IDENTITÉ PAR RÉFÉRENCE du document — s'il ressort `===`, aucun bloc n'a
   * été reconstruit, donc rien n'a été réécrit. Une assertion de valeur ici ne mesurerait rien ;
   * c'est le piège qu'une ancienne ligne `not.toBe(PT)`, posée juste après un `toBe` sur la même
   * expression, ne pouvait pas non plus éviter — elle ne pouvait échouer que si l'autre avait déjà
   * échoué.
   *
   * Les DEUX formes d'href comptent : sur un lien légitime, c'est la branche d'écriture qui est à
   * un test de distance (un `blank()` cassé et le bloc est recopié à l'identique de valeur) ; sur
   * un lien mort, c'est la garde qui doit s'abstenir SANS toucher au bloc.
   */
  test("libellé saisi ÉGAL au défaut de sa langue ⇒ le document ressort par IDENTITÉ", () => {
    const linked = docWithHref("pt-BR", "https://harbor-tech.example/nota", PT);
    expect(expandFeedBlocks(linked).doc).toBe(linked);

    const dead = docWithHref("pt-BR", "#", PT);
    expect(expandFeedBlocks(dead).doc).toBe(dead);
  });

  test("href légitime et libellé absent ⇒ le défaut de la locale est posé", () => {
    expect(labelOf("pt-BR", "https://harbor-tech.example/nota")).toBe(PT);
    expect(labelOf("es-CL", "https://copper-kettle.example/nota")).toBe(ES);
    // Un CHEMIN sur le domaine réservé n'est pas le remplissage des fabriques : quelqu'un l'a écrit,
    // la carte garde son bouton. La garde vise une valeur précise, pas un domaine entier.
    expect(labelOf("pt-BR", "https://example.com/sunday-preview")).toBe(PT);
  });

  // Un bloc que la garde laisse tel quel ne doit pas être recopié : c'est la même propriété
  // d'identité que pour un libellé saisi, et elle protège les appelants qui s'en servent.
  test("un bloc retenu par la garde ressort par IDENTITÉ", () => {
    const doc = docWithHref("pt-BR", "#");
    expect(expandFeedBlocks(doc).doc).toBe(doc);
  });
});

describe("(k) LA GARDE MESURÉE SUR LE HTML LIVRÉ", () => {
  // ⛔ La mesure qui compte. Le document déplié peut bien être vide de libellé, c'est le HTML qui
  // part dans la boîte : ces cartes n'ont pas d'image, donc le CTA est leur SEUL `<a>` possible.
  test("href mort ⇒ pas une seule ancre dans le HTML", async () => {
    const { compileDoc } = await import("./compile");
    const { html } = await compileDoc(docWithHref("pt-BR", "#"));

    expect(countOf(html, '<a href="#"')).toBe(0);
    expect(countOf(html, PT)).toBe(0);
  });

  test("href de remplissage ⇒ pas une seule ancre vers le domaine réservé", async () => {
    const { compileDoc } = await import("./compile");
    const { html } = await compileDoc(docWithHref("pt-BR", "https://example.com"));

    expect(countOf(html, '<a href="https://example.com"')).toBe(0);
  });

  // CONTRE-ÉPREUVE : sans elle, une garde qui retiendrait TOUT rendrait les deux cas ci-dessus
  // verts tout en supprimant les CTA des 9 marques.
  test("href légitime ⇒ l'ancre et son libellé sortent bien", async () => {
    const { compileDoc } = await import("./compile");
    const { html } = await compileDoc(docWithHref("pt-BR", "https://harbor-tech.example/nota"));

    expect(countOf(html, '<a href="https://harbor-tech.example/nota"')).toBe(1);
    expect(countOf(html, PT)).toBe(1);
  });
});

/**
 * RÉTRO-COMPATIBILITÉ DU CHAMP `orderby` (ajouté le 01/09/2026).
 *
 * `ArticleFeedBlock` est `.strict()`. Au moment de l'ajout, la base portait 38 `template_version`,
 * dont **15 avec un bloc `article-feed`** et **0 avec `orderby`** : sans `.default()`, ces quinze
 * modèles cesseraient tous de se relire — un modèle enregistré hier deviendrait illisible
 * aujourd'hui, et aucune migration côté auteur ne pourrait le rattraper.
 */
describe("article-feed : `orderby` n'invalide aucun modèle déjà enregistré", () => {
  const blocSansOrderby = {
    id: "f1",
    type: "article-feed" as const,
    sourceId: "src-1",
    count: 5,
    minCount: 3,
    dedupeDays: 14,
  };

  test("un bloc SANS `orderby` se relit, et vaut « date »", async () => {
    const { ArticleFeedBlock } = await import("./schema");
    const r = ArticleFeedBlock.safeParse(blocSansOrderby);

    expect(r.success).toBe(true);
    if (!r.success) throw new Error("le bloc historique doit rester lisible");
    expect(r.data.orderby).toBe("date");
  });

  test("un bloc AVEC `orderby: views` se relit tel quel", async () => {
    const { ArticleFeedBlock } = await import("./schema");
    const r = ArticleFeedBlock.safeParse({ ...blocSansOrderby, orderby: "views" });

    expect(r.success).toBe(true);
    if (!r.success) throw new Error("le nouveau mode doit être accepté");
    expect(r.data.orderby).toBe("views");
  });

  // TÉMOIN : sans lui, les deux tests ci-dessus passeraient sur un champ `z.string()` permissif,
  // qui laisserait entrer une valeur qu'aucun code ne sait traiter — donc un tri silencieusement
  // ignoré, le défaut exact que ce champ existe pour empêcher.
  test("témoin — une valeur inconnue est REFUSÉE, jamais ramenée au défaut", async () => {
    const { ArticleFeedBlock } = await import("./schema");
    expect(ArticleFeedBlock.safeParse({ ...blocSansOrderby, orderby: "popularity" }).success).toBe(false);
    expect(ArticleFeedBlock.safeParse({ ...blocSansOrderby, orderby: "" }).success).toBe(false);
  });

  /**
   * RÉTRO-COMPATIBILITÉ DU CHAMP `viewsWindow` (ajouté le 03/09/2026) — même risque, même remède.
   * Au moment de l'ajout, les blocs `article-feed` enregistrés n'ont aucun de ces champs.
   */
  test("un bloc SANS `viewsWindow` se relit, et suit la cadence", async () => {
    const { ArticleFeedBlock } = await import("./schema");
    const r = ArticleFeedBlock.safeParse({ ...blocSansOrderby, orderby: "views" });

    expect(r.success).toBe(true);
    if (!r.success) throw new Error("le bloc historique doit rester lisible");
    // ⛔ Le défaut est la CADENCE, pas sept jours : un nombre par défaut figerait dans le modèle une
    // durée que la campagne aurait dû fournir, et deux campagnes de cadences différentes partageant
    // ce modèle hériteraient toutes deux de la même.
    expect(r.data.viewsWindow).toBe("cadence");
  });

  test("une durée fixe se relit telle quelle", async () => {
    const { ArticleFeedBlock } = await import("./schema");
    const r = ArticleFeedBlock.safeParse({ ...blocSansOrderby, orderby: "views", viewsWindow: 30 });

    expect(r.success).toBe(true);
    if (!r.success) throw new Error("une durée fixe doit être acceptée");
    expect(r.data.viewsWindow).toBe(30);
  });

  test("témoin — les durées absurdes sont REFUSÉES, jamais ramenées au défaut", async () => {
    const { ArticleFeedBlock } = await import("./schema");
    const bloc = { ...blocSansOrderby, orderby: "views" };
    // Zéro jour rendrait une fenêtre inversée, donc une liste vide indiscernable d'une période sans
    // publication ; 365 dépasse ce qu'une récolte peut rapatrier chez une source qui publie 50
    // articles par jour, et le classement ne couvrirait plus la période annoncée.
    expect(ArticleFeedBlock.safeParse({ ...bloc, viewsWindow: 0 }).success).toBe(false);
    expect(ArticleFeedBlock.safeParse({ ...bloc, viewsWindow: 365 }).success).toBe(false);
    expect(ArticleFeedBlock.safeParse({ ...bloc, viewsWindow: 7.5 }).success).toBe(false);
    // Et surtout : une chaîne qui n'est pas `cadence` ne doit pas entrer.
    expect(ArticleFeedBlock.safeParse({ ...bloc, viewsWindow: "weekly" }).success).toBe(false);
    expect(ArticleFeedBlock.safeParse({ ...bloc, viewsWindow: "7" }).success).toBe(false);
  });
});

/**
 * `describeFeed` — la phrase que l'opérateur lit à côté d'une occurrence RETENUE, sans le modèle
 * sous les yeux, et sur laquelle il décide quoi corriger.
 *
 * ⛔ ELLE DOIT DIRE LA COMPOSITION, PAS LE NOM DU MODE. « mixed » ne lui apprend rien ; « 3 most
 * viewed + 2 latest » lui dit ce que la lettre aurait contenu. Une phrase identique pour deux
 * réglages différents est le défaut le plus coûteux ici : elle envoie corriger le mauvais champ.
 */
describe("describeFeed — trois modes, trois phrases", () => {
  const base = {
    id: "f1",
    type: "article-feed" as const,
    sourceId: "src-1",
    sourceLabel: "northwind-sports",
    categoryNames: ["Lakeside"],
    tagNames: [],
    count: 5,
    minCount: 3,
    dedupeDays: 14,
    viewsWindow: "cadence" as const,
    layout: "stacked" as const,
    leadCount: 1,
  };

  test("mode `date` — la phrase ne parle ni de vues ni de période", async () => {
    const { describeFeed } = await import("./feed");
    const { ArticleFeedBlock } = await import("./schema");
    const bloc = ArticleFeedBlock.parse({ ...base, orderby: "date" });
    expect(describeFeed(bloc)).toBe("5 latest from Lakeside");
  });

  test("mode `views` — la phrase dit la période, jamais un nombre de jours inventé", async () => {
    const { describeFeed } = await import("./feed");
    const { ArticleFeedBlock } = await import("./schema");
    const bloc = ArticleFeedBlock.parse({ ...base, orderby: "views" });
    expect(describeFeed(bloc)).toBe("5 most viewed from Lakeside over the send interval");
  });

  /**
   * ⭐ L'ARRONDI IMPAIR SE LIT DANS LA PHRASE. Sur cinq cartes, l'arbitrage d'Alix donne trois plus
   * lues et deux récentes ; une phrase qui dirait « 2 + 3 » enverrait chercher un défaut là où il
   * n'y en a pas.
   * MUTATION QUI DOIT TUER CE TEST : `Math.ceil(feed.count / 2)` → `Math.floor`.
   */
  test("mode `mixed` — la phrase dit la composition, pas le nom du mode", async () => {
    const { describeFeed } = await import("./feed");
    const { ArticleFeedBlock } = await import("./schema");
    const bloc = ArticleFeedBlock.parse({ ...base, orderby: "mixed" });
    expect(describeFeed(bloc)).toBe("3 most viewed over the send interval + 2 latest, from Lakeside");
    expect(describeFeed(bloc)).not.toContain("mixed");
  });

  test("une durée fixe remplace « the send interval » dans les deux modes qui classent", async () => {
    const { describeFeed } = await import("./feed");
    const { ArticleFeedBlock } = await import("./schema");
    const vues = ArticleFeedBlock.parse({ ...base, orderby: "views", viewsWindow: 30 });
    const mixte = ArticleFeedBlock.parse({ ...base, orderby: "mixed", viewsWindow: 30, count: 4 });
    expect(describeFeed(vues)).toBe("5 most viewed from Lakeside over 30 days");
    expect(describeFeed(mixte)).toBe("2 most viewed over 30 days + 2 latest, from Lakeside");
  });

  // TÉMOIN : les trois phrases doivent être DISTINCTES. Deux réglages décrits pareil rendraient la
  // ligne inutile là où elle sert : à côté d'une occurrence retenue, sans le modèle sous les yeux.
  test("témoin — aucun mode ne se décrit comme un autre", async () => {
    const { describeFeed } = await import("./feed");
    const { ArticleFeedBlock } = await import("./schema");
    const phrases = (["date", "views", "mixed"] as const).map((orderby) =>
      describeFeed(ArticleFeedBlock.parse({ ...base, orderby })),
    );
    expect(new Set(phrases).size).toBe(3);
  });

  test("un bloc AVEC `orderby: mixed` se relit tel quel", async () => {
    const { ArticleFeedBlock } = await import("./schema");
    const r = ArticleFeedBlock.safeParse({ ...base, orderby: "mixed" });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("le troisième mode doit être accepté");
    expect(r.data.orderby).toBe("mixed");
  });
});
