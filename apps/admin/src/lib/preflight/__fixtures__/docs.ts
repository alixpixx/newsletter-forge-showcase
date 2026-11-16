/**
 * FIXTURES DU PRÉ-VOL — six documents, un défaut mesuré par document.
 *
 * ⛔ Ces documents ne sont pas des exemples décoratifs : ce sont les ENTRÉES d'un banc qui compare
 * des CHIFFRES (`counts.blocking`, `counts.advisory`, présence d'un correctif). Un document qui
 * porte deux défauts à la fois rend le chiffre inexploitable — quand il bouge, on ne sait plus
 * lequel des deux a bougé. D'où : une fixture = une variable, sauf (a) qui est explicitement le
 * cas « plusieurs défauts d'un coup » servant à vérifier que les constats se CUMULENT.
 *
 * ⚠️ Le thème vient d'`emptyDoc()`, jamais d'un littéral écrit ici. `runPreflight` résout la
 * cascade de couleurs (contraste en clair PUIS en sombre) : un thème partiel le fait travailler sur
 * des `undefined` et le banc mesurerait un plantage, pas une règle. Et un thème recopié à la main
 * dériverait au premier changement de défaut du schéma — les chiffres décriraient alors un thème
 * qui n'existe plus nulle part.
 *
 * ⚠️ `subject` et `preheader` sont remplis dans TOUTES les fixtures, et toutes portent un
 * `footer_legal`. Sans ça, chaque document traîne trois constats parasites (« Subject line is
 * empty » bloquant, « Preheader is empty » consultatif, « No legal footer block » bloquant) qui
 * s'ajoutent au chiffre attendu et le font parler d'autre chose que du défaut testé.
 */
import { EmailDoc, emptyDoc } from "@nf/render/schema";

/** Thème COMPLET, pris à la source qui fait foi (defaults zod du schéma). */
const THEME = emptyDoc("demo-brand", "en").theme;

/**
 * Une row à une colonne. Les ids sont ÉCRITS, jamais tirés de `newId()` : les assertions portent
 * sur `fix.blockId` et sur les cibles cliquables, et un id aléatoire les rendrait invérifiables.
 */
const row = (id: string, blocks: unknown[]): unknown => ({
  id: `row_${id}`,
  layout: "1",
  columns: [{ id: `col_${id}`, blocks }],
});

/** Le footer légal, en dernier — la position que le pré-vol attend (`footerpos`). */
const footerRow = (): unknown => row("footer", [{ id: "blk_footer", type: "footer_legal" }]);

const build = (name: string, rows: unknown[]): EmailDoc =>
  EmailDoc.parse({
    schema: 2,
    meta: { subject: `Fixture ${name}`, preheader: `Preheader ${name}`, assetSlug: "demo-brand", locale: "en" },
    theme: THEME,
    rows,
  });

/**
 * (a) Le cas cumulé : 5 liens de menu en `http://`, une image en `http://`, une vignette d'article
 * restée sur la sentinelle `ai://`, et un libellé de bouton qui déborde de sa colonne.
 *
 * ⚠️ « CTA trop long » ne veut PAS dire « plus long que `MAX_BUTTON_LABEL` » : au-delà de 28
 * caractères le schéma refuse le bloc au parse et la fixture ne se construirait même pas. Le
 * débordement testé ici est GÉOMÉTRIQUE — un libellé valide posé dans une colonne de 150px (layout
 * `1-1-1-1`), qui est le seul cas que le pré-vol sait mesurer et réparer.
 *
 * ⚠️ L'`alt` de l'image et l'`imageAlt` de l'article sont REMPLIS : sans ça le document porterait
 * en plus les constats d'alt manquant, qui sont l'objet des fixtures (b) à (d).
 */
export const docInsecureAndPlaceholder = (): EmailDoc =>
  build("a", [
    row("menu", [
      {
        id: "blk_menu",
        type: "menu",
        items: [
          { label: "Home", href: "http://example.com/home" },
          { label: "Odds", href: "http://example.com/odds" },
          { label: "Picks", href: "http://example.com/picks" },
          { label: "Guides", href: "http://example.com/guides" },
          { label: "Contact", href: "http://example.com/contact" },
        ],
      },
    ]),
    row("image", [
      {
        id: "blk_image",
        type: "image",
        src: "http://cdn.example.com/banner.png",
        alt: "Weekly banner",
      },
    ]),
    row("article", [
      {
        id: "blk_article",
        type: "article",
        title: "Sunday preview",
        excerpt: "Everything to watch this weekend.",
        imageSrc: "ai://a stadium at dusk",
        imageAlt: "A stadium at dusk",
        href: "https://example.com/sunday-preview",
      },
    ]),
    {
      id: "row_cta",
      layout: "1-1-1-1",
      columns: [
        { id: "col_cta", blocks: [{ id: "blk_button", type: "button", label: "Claim your welcome bonus", href: "https://example.com/bonus" }] },
        { id: "col_cta_2", blocks: [] },
        { id: "col_cta_3", blocks: [] },
        { id: "col_cta_4", blocks: [] },
      ],
    },
    footerRow(),
  ]);

/**
 * (b) Article AVEC titre, SANS alt — le cas qui doit rester SILENCIEUX.
 *
 * ⛔ C'est la fixture la plus importante du lot. Une vignette collée au titre-lien qui la nomme est
 * DÉCORATIVE : WCAG demande `alt=""`, faute de quoi le lecteur d'écran annonce deux fois la même
 * phrase. Si un jour ce document se met à sortir un constat, c'est que quelqu'un a aligné la règle
 * de la vignette sur celle de l'image seule — et l'import WordPress redevient inutilisable (cinq
 * articles importés = cinq blocages, alors que WordPress ne remplit `alt_text` que très rarement).
 */
export const docArticleTitledNoAlt = (): EmailDoc =>
  build("b", [
    row("article", [
      {
        id: "blk_article",
        type: "article",
        title: "Sunday preview",
        excerpt: "Everything to watch this weekend.",
        imageSrc: "https://cdn.example.com/thumb.png",
        imageAlt: "",
        href: "https://example.com/sunday-preview",
      },
    ]),
    footerRow(),
  ]);

/**
 * (c) Article SANS titre ET SANS alt — plus rien ne nomme la vignette, donc le blocage revient.
 *
 * ⛔ Le pendant exact de (b) : c'est le COUPLE (b)/(c) qui prouve que la règle est conditionnelle
 * et non désarmée. Vérifier (b) seul laisserait passer un pré-vol qui ne dit plus jamais rien.
 */
export const docArticleUntitledNoAlt = (): EmailDoc =>
  build("c", [
    row("article", [
      {
        id: "blk_article",
        type: "article",
        title: "",
        excerpt: "Everything to watch this weekend.",
        imageSrc: "https://cdn.example.com/thumb.png",
        imageAlt: "",
        href: "https://example.com/sunday-preview",
      },
    ]),
    footerRow(),
  ]);

/** (d) Image seule sans alt — aucune règle décorative ici, l'alt est la SEULE description possible. */
export const docImageNoAlt = (): EmailDoc =>
  build("d", [
    row("image", [{ id: "blk_image", type: "image", src: "https://cdn.example.com/hero.png", alt: "" }]),
    footerRow(),
  ]);

/**
 * (e) Flux d'articles dont le plancher dépasse la demande (`count: 2`, `minCount: 3`).
 *
 * ⚠️ `previewItems` reste VIDE volontairement : un aperçu peuplé serait déplié par
 * `expandFeedBlocks()` en autant de blocs article, chacun avec ses propres constats — le chiffre ne
 * parlerait plus du plancher. Le bloc disparaît donc à la compilation, et le seul constat qui
 * subsiste est le refus du schéma de publication, qui lui travaille sur le document NON déplié.
 */
export const docFeedMinAboveCount = (): EmailDoc =>
  build("e", [
    row("feed", [
      {
        id: "blk_feed",
        type: "article-feed",
        sourceId: "src_demo",
        sourceLabel: "Demo site",
        count: 2,
        minCount: 3,
      },
    ]),
    footerRow(),
  ]);

/**
 * (f) Trois footers légaux. Le dernier bloc du document EST un footer : on isole ainsi la
 * duplication (`footerdup`) du mauvais placement (`footerpos`), qui sont deux constats distincts.
 */
export const docThreeFooters = (): EmailDoc =>
  build("f", [
    row("footer_1", [{ id: "blk_footer_1", type: "footer_legal" }]),
    row("footer_2", [{ id: "blk_footer_2", type: "footer_legal" }]),
    row("footer_3", [{ id: "blk_footer_3", type: "footer_legal" }]),
  ]);

/**
 * (e′) CONTRE-PREUVE de (e) : le MÊME bloc de flux, plancher SOUS la demande (`count: 3`,
 * `minCount: 2`) — la configuration normale, celle qui ne doit rien produire.
 *
 * ⛔ Sans elle, (e) mesure qu'un bouton APPARAÎT sans jamais mesurer qu'il se TAIT. Un correctif
 * qui s'affiche sur un flux sans faute est un faux positif : l'auteur clique, `minCount` tombe à la
 * valeur de `count`, et le pré-vol a raboté un réglage volontaire au nom d'un refus inexistant.
 * C'est le couple (e)/(e′) qui prouve que la règle est conditionnelle, exactement comme (b)/(c)
 * pour la vignette d'article.
 *
 * ⚠️ `count` vaut 3 et non 2 : à valeurs égales le prédicat `minCount <= count` serait vrai par
 * l'égalité, et la fixture ne testerait que la borne, pas le cas courant.
 */
export const docFeedMinBelowCount = (): EmailDoc =>
  build("e-prime", [
    row("feed", [
      {
        id: "blk_feed",
        type: "article-feed",
        sourceId: "src_demo",
        sourceLabel: "Demo site",
        count: 3,
        minCount: 2,
      },
    ]),
    footerRow(),
  ]);


/**
 * (g′) / (g) LE COUPLE DU CTA D'ARTICLE — deux documents IDENTIQUES au `href` près.
 *
 * ⛔ POURQUOI CE COUPLE EXISTE. Toutes les fixtures ci-dessus relient leurs articles à une URL À
 * CHEMIN (`https://example.com/sunday-preview`), que `goesNowhere` (`@nf/render/links`) exclut
 * explicitement. Aucune ne portait donc d'href MORT, et le banc était AVEUGLE à la garde : mesuré,
 * `goesNowhere` forcé à toujours-faux rendait 9 pass / 0 fail, et forcé à toujours-vrai, 9 pass /
 * 0 fail aussi. La moitié « ce qui PARTIRA » du pré-vol — libellé effectif, échantillon de
 * contraste, règle de largeur, inventaire des liens — n'était qu'affirmée.
 *
 * La variable est le `href`, et rien d'autre :
 *   · (g′) lien vivant, champ CTA vide  → le rendu posera le défaut de `meta.locale`, le pré-vol
 *     doit donc le JUGER (et ici, le voir déborder) ;
 *   · (g)  lien mort (« # »), champ vide → le rendu ne fabrique RIEN, `articleHtml` n'émet aucun
 *     `<a>` : il n'y a plus aucun texte cliquable à mesurer.
 *
 * ⚠️ GÉOMÉTRIE VOLONTAIRE : `layout: "side"` dans une colonne de tiers. La vignette mange 38 %
 * (plancher 80px) plus 14px de gouttière, ce qui laisse ~54px au lien — le défaut anglais y déborde
 * (~84px). C'est le seul moyen de rendre le libellé EFFECTIF observable dans un constat : la règle
 * de largeur est la seule qui cite le texte qu'elle a jugé. Sans débordement, (g′) et (g) rendraient
 * le même compte et le couple ne mesurerait rien.
 *
 * ⚠️ `imageAlt` est REMPLI et le titre aussi : sinon le document traîne les constats de vignette
 * muette, qui sont l'objet de (b)/(c) et qui feraient parler le chiffre d'autre chose.
 */
const articleCtaCard = (name: string, href: string): EmailDoc =>
  build(name, [
    {
      id: "row_article",
      layout: "1-1-1",
      columns: [
        {
          id: "col_article",
          blocks: [
            {
              id: "blk_article",
              type: "article",
              title: "Sunday preview",
              excerpt: "Everything to watch this weekend.",
              imageSrc: "https://cdn.example.com/thumb.png",
              imageAlt: "A stadium at dusk",
              layout: "side",
              href,
            },
          ],
        },
        { id: "col_article_2", blocks: [] },
        { id: "col_article_3", blocks: [] },
      ],
    },
    footerRow(),
  ]);

/** (g′) Lien VIVANT, aucun `ctaLabel` stocké : le défaut de langue partira, donc il se mesure. */
export const docArticleCtaLiveHref = (): EmailDoc =>
  articleCtaCard("g-prime", "https://example.com/sunday-preview");

/**
 * (g) LA MÊME carte, lien MORT. Aucun libellé n'est fabriqué par-dessus, donc aucune ancre ne part.
 *
 * ⛔ « # » n'est pas un cas de laboratoire : c'est exactement la forme que prend un lien refusé par
 * les garde-fous de la composition IA (`applyGuardrails`, apps/admin/src/lib/ai/compose.ts), et
 * celle qu'un auteur écrit quand il découvre que son URL est un 404.
 */
export const docArticleCtaDeadHref = (): EmailDoc => articleCtaCard("g", "#");

/**
 * (l) Un encart À MISE EN PAGE (23/09/2026), sur un aplat de repli sombre. Le bloc est passé en
 * paramètre : chaque test ne change QU'UNE variable (la couleur du titre, la souche, un lien http),
 * sur un encart par ailleurs sans défaut — href et images en https, alt remplis.
 */
export const docCalloutLayout = (callout: Record<string, unknown>): EmailDoc =>
  build("l", [
    row("callout", [
      {
        id: "blk_callout",
        type: "callout",
        layout: "poster",
        kicker: "PODCAST",
        title: "Friday night preview",
        body: "Three matches worth your evening.",
        href: "https://example.com/listen",
        ctaLabel: "Listen now",
        backgroundImage: "https://cdn.example.com/stadium.jpg",
        titleColor: "#fefefe",
        bodyColor: "#fefefe",
        kickerColor: "#fefefe",
        style: { backgroundColor: "#101820" },
        ...callout,
      },
    ]),
    footerRow(),
  ]);
