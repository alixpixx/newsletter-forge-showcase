/**
 * BANC DE PREUVE « CE QUI PART = CE QUE L'ÉDITEUR MONTRE » — `bun test` depuis la racine.
 *
 * Ce que ce fichier surveille, né d'un rapport du 22/09/2026 sur « Boletín semanal genérico »
 * (Copper Kettle) : l'abonné recevait une UNE en grande photo, un surtitre « Destacada », un titre
 * « Más noticias » et un lien souligné là où l'éditeur dessinait des cartes toutes pareilles à
 * bouton rouge. L'audit a montré que trois de ces quatre écarts venaient du MODÈLE — ils sont
 * configurés — et un seul du compilateur (le lien de lecture).
 *
 * ⛔ D'OÙ LA FORME DE CHAQUE CAS : une NEUTRALITÉ (« sans réglage, rien n'apparaît ») ET sa
 * CONTRE-ÉPREUVE (« avec le réglage, ça apparaît »). Sans la contre-épreuve, un dépliage qui
 * n'émettrait plus jamais ni une, ni surtitre, ni titre de section resterait vert — et on aurait
 * « réparé » le bug en supprimant une fonctionnalité que trois marques utilisent en production.
 *
 * ⛔ LES CHAÎNES ATTENDUES SONT ÉCRITES EN DUR. Rien n'est relu depuis le code mesuré : un banc qui
 * recalcule sa référence avec la règle qu'il surveille ne mesure que lui-même.
 */
import { describe, expect, test } from "bun:test";
import { compileDoc } from "./compile";
import { expandFeedBlocks, feedCards, type FeedResolution } from "./feed";
import { ArticleFeedBlock, EmailDoc, type Block } from "./schema";

const ITEM = (n: number): Record<string, unknown> => ({
  postId: `post-${n}`,
  title: `Titre ${n}`,
  excerpt: `Chapeau ${n}`,
  href: `https://example.test/article-${n}`,
  imageSrc: `https://example.test/img-${n}.jpg`,
  imageAlt: "",
  publishedAt: "2026-09-22T21:42:00.000Z",
  category: "Noticias",
});

/** Un document à UN flux, dont seuls les réglages passés varient. */
function docFlux(reglages: Record<string, unknown> = {}, count = 3): EmailDoc {
  return EmailDoc.parse({
    schema: 2,
    meta: { subject: "Banc flux", preheader: "Banc flux", assetSlug: "demo-brand", locale: "es-CL" },
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
                count,
                previewItems: Array.from({ length: count }, (_, i) => ITEM(i + 1)),
                previewAt: "2026-09-22T12:00:00.000Z",
                ...reglages,
              },
            ],
          },
        ],
      },
    ],
  });
}

/** Le bloc flux d'un document de banc, typé — c'est lui que le canvas passe à `feedCards`. */
const flux = (doc: EmailDoc): ArticleFeedBlock =>
  (doc.rows[0] as { columns: { blocks: Block[] }[] }).columns[0]?.blocks[0] as ArticleFeedBlock;

/** Les blocs qu'un document déplié contient, dans l'ordre de lecture. */
function blocsDe(doc: EmailDoc): Block[] {
  const out: Block[] = [];
  for (const row of doc.rows) for (const column of row.columns) out.push(...column.blocks);
  return out;
}

const deplie = (doc: EmailDoc, resolu?: Record<string, FeedResolution>): Block[] =>
  blocsDe(expandFeedBlocks(doc, resolu).doc);

/* ============================================================================================ *
 * (a) TEXTES QUE PERSONNE N'A DEMANDÉS
 * ============================================================================================ */

describe("(a) un flux sans reglage n'invente aucun texte", () => {
  const blocs = deplie(docFlux());

  test("aucune une, aucun titre de section, aucun filet : trois cartes et rien d'autre", () => {
    expect(blocs.map((b) => b.type)).toEqual(["article", "article", "article"]);
  });

  test("aucun surtitre", () => {
    for (const b of blocs) {
      expect((b as { kicker?: string }).kicker ?? "").toBe("");
      expect((b as { kickerAccent?: string }).kickerAccent ?? "").toBe("");
    }
  });

  test("les trois cartes ont la MÊME mise en page — la première n'est pas une une", () => {
    const vus = new Set(blocs.map((b) => `${(b as { layout?: string }).layout}|${(b as { titleSize?: number }).titleSize}`));
    expect(vus.size).toBe(1);
  });
});

describe("(a') contre-epreuve : les memes textes apparaissent des que le modele les demande", () => {
  // Les réglages RÉELS de « Boletín semanal genérico », recopiés à la main depuis le JSON en base.
  const blocs = deplie(
    docFlux({
      leadCount: 1,
      showKicker: true,
      timeZone: "America/Santiago",
      lead: { layout: "stacked", kickerMode: "text", kickerText: "Destacada" },
      card: { layout: "side", kickerMode: "category-time" },
      midSection: { label: "Más noticias", rule: "after", ruleColor: "#FF2F2F" },
    }),
  );

  test("l'ordre de lecture est une, titre de section, puis les breves", () => {
    expect(blocs.map((b) => b.type)).toEqual(["article", "section_title", "article", "article"]);
  });

  test("« Destacada » sur la une, « Más noticias » en titre de section", () => {
    expect((blocs[0] as { kicker?: string }).kicker).toBe("Destacada");
    expect((blocs[1] as { label?: string }).label).toBe("Más noticias");
  });

  test("les breves portent « categorie · heure », a l'heure de Santiago", () => {
    // 21:42 UTC le 22/09/2026 = 18:42 à Santiago : le Chili est à UTC−3 depuis le 6 septembre
    // (heure d'été), pas à UTC−4. Le décalage est écrit ici À LA MAIN — reprendre `timeZone` pour
    // formater l'attendu reviendrait à comparer le code à lui-même, et ce banc a d'ailleurs commencé
    // par rougir sur un UTC−4 saisi de mémoire : c'est exactement ce qu'on lui demande de faire.
    // Les espaces du séparateur sont INSÉCABLES : « · 18:42 » ne doit jamais tomber seul à la ligne.
    expect((blocs[2] as { kicker?: string }).kicker).toBe("Noticias");
    expect((blocs[2] as { kickerAccent?: string }).kickerAccent).toBe(" · 18:42");
  });
});

describe("(a'') `showKicker` decoche coupe VRAIMENT les surtitres de categorie et d'heure", () => {
  const regle = {
    leadCount: 1,
    lead: { kickerMode: "text", kickerText: "Destacada" },
    card: { kickerMode: "category-time" },
  };

  test("sans la case, la breve n'a plus de surtitre", () => {
    const blocs = deplie(docFlux({ ...regle, showKicker: false }));
    for (const b of blocs) if (b.type === "article") expect(b.kicker ?? "").not.toContain("Noticias");
  });

  test("mais le libelle FIXE de la une survit : il suit « Lead card », pas la case surtitre", () => {
    const blocs = deplie(docFlux({ ...regle, showKicker: false }));
    expect((blocs[0] as { kicker?: string }).kicker).toBe("Destacada");
  });

  test("contre-epreuve : la case cochee rend les surtitres", () => {
    const blocs = deplie(docFlux({ ...regle, showKicker: true }));
    expect((blocs[2] as { kicker?: string }).kicker).toBe("Noticias");
    // Ce bloc-ci n'a PAS de `timeZone` : l'heure reste en UTC, telle que l'article la porte.
    expect((blocs[2] as { kickerAccent?: string }).kickerAccent).toBe(" · 21:42");
  });
});

/* ============================================================================================ *
 * (b) LE CANVAS ET L'ENVOI LISENT LA MÊME DÉFINITION
 * ============================================================================================ */

describe("(b) `feedCards` (canvas) rend EXACTEMENT ce que l'envoi deplie", () => {
  const reglages = {
    leadCount: 1,
    showKicker: true,
    lead: { layout: "stacked", kickerMode: "text", kickerText: "Destacada", ctaStyle: "link" },
    card: { layout: "side", kickerMode: "category-time", ctaStyle: "none" },
    midSection: { label: "Más noticias" },
    cardRule: { color: "#E6E6E6", thickness: 1 },
  };

  test("apercu : meme liste de blocs, cle pour cle", () => {
    const doc = docFlux(reglages);
    expect(feedCards(flux(doc), doc.meta.locale)).toEqual(deplie(doc));
  });

  test("resolution reelle : la meme fonction sert, avec les articles du jour", () => {
    const doc = docFlux(reglages);
    const resolu: Record<string, FeedResolution> = {
      blk_feed: {
        items: [ITEM(7), ITEM(8)] as never,
        fetchedAt: "2026-09-22T12:00:08.872Z",
      },
    };
    expect(feedCards(flux(doc), doc.meta.locale, resolu.blk_feed)).toEqual(deplie(doc, resolu));
  });

  test("l'apercu se tronque a `count` : 5 items stockes, 3 demandes, 3 cartes", () => {
    const doc = docFlux({ count: 3, previewItems: Array.from({ length: 5 }, (_, i) => ITEM(i + 1)) }, 5);
    expect(feedCards(flux(doc), doc.meta.locale).filter((b) => b.type === "article")).toHaveLength(3);
  });
});

/* ============================================================================================ *
 * (c) LE LIEN DE LECTURE
 * ============================================================================================ */

describe("(c) le lien de lecture sort comme l'editeur le dessine", () => {
  // Le markup du bouton, recopié à la main depuis ce que `ctaTable` doit produire.
  const BOUTON = 'bgcolor="#';
  const PADDING_BOUTON = "padding:12px 22px;mso-padding-alt:12px 22px;";

  test("sans `ctaStyle`, c'est un BOUTON — plus un lien souligne", async () => {
    const { html } = await compileDoc(docFlux({ card: { layout: "stacked" } }));
    expect(html).toContain(PADDING_BOUTON);
    expect(html).toContain(BOUTON);
    expect(html).not.toContain("text-decoration:underline");
  });

  test("`ctaStyle:\"button\"` donne le meme bouton", async () => {
    const { html } = await compileDoc(docFlux({ card: { ctaStyle: "button" } }));
    expect(html).toContain(PADDING_BOUTON);
    expect(html).not.toContain("text-decoration:underline");
  });

  test("contre-epreuve : `ctaStyle:\"link\"` reste un lien souligne, JAMAIS un bouton", async () => {
    const { html } = await compileDoc(docFlux({ card: { ctaStyle: "link" } }));
    expect(html).toContain("text-decoration:underline");
    expect(html).not.toContain(PADDING_BOUTON);
  });

  test("contre-epreuve : `ctaStyle:\"none\"` n'emet AUCUN lien de lecture", async () => {
    const { html } = await compileDoc(docFlux({ card: { ctaStyle: "none" } }));
    expect(html).not.toContain(PADDING_BOUTON);
    expect(html).not.toContain("Leer la nota");
  });

  test("un soulignement epais reste un filet `border-bottom`, pas un bouton", async () => {
    const { html } = await compileDoc(docFlux({ card: { ctaStyle: "link", ctaUnderline: 2 } }));
    expect(html).toContain("border-bottom:2px solid");
    expect(html).not.toContain(PADDING_BOUTON);
  });
});

/* ============================================================================================ *
 * (d) L'EMPILEMENT MOBILE D'UNE CARTE EN VIGNETTE
 * ============================================================================================ */

describe("(d) une carte en vignette s'empile sur mobile sans dependre du `<style>` du head", () => {
  const docSide = () => docFlux({ card: { layout: "side" }, layout: "side" });

  test("deux colonnes `inline-block` a 100 % : SANS aucun CSS, la vignette est au-dessus", async () => {
    const { html } = await compileDoc(docSide());
    expect(html).toContain('style="display:inline-block;vertical-align:top;width:100%;max-width:100%;"');
  });

  test("la vignette n'a plus de plafond en px : pleine largeur une fois empilee", async () => {
    const { html } = await compileDoc(docSide());
    expect(html).toMatch(/<img [^>]*style="display:block;width:100%;max-width:100%;height:auto;/);
  });

  test("le cote-a-cote est un AJOUT, sous `min-width:480px`", async () => {
    const { html } = await compileDoc(docSide());
    const cls = /class="(nf-col-[0-9a-z]+)-a"/.exec(html)?.[1];
    expect(cls).toBeTruthy();
    expect(html).toMatch(new RegExp(`@media only screen and \\(min-width:480px\\) \\{[^}]*\\.${cls as string}-a `));
    // Thunderbird ne lit pas les media queries : MJML lui sert la même règle via `.moz-text-html`.
    expect(html).toContain(`.moz-text-html .${cls as string}-a `);
  });

  test("Outlook, qui n'a pas de media query, garde ses deux cellules a largeur fixe", async () => {
    const { html } = await compileDoc(docSide());
    expect(html).toContain("<!--[if mso | IE]><table role=\"presentation\"");
  });

  test("l'ancien montage a disparu : plus une seule regle `.nf-art-…`", async () => {
    const { html } = await compileDoc(docSide());
    expect(html).not.toContain("nf-art-");
    expect(html).not.toContain("td { display:block !important;");
  });

  test("les cartes de MÊME gabarit partagent une classe : le head ne gonfle pas avec le nombre d'articles", async () => {
    const trois = await compileDoc(docFlux({ card: { layout: "side" } }, 3));
    const classes = new Set([...trois.html.matchAll(/class="(nf-col-[0-9a-z]+)-a"/g)].map((m) => m[1]));
    expect(classes.size).toBe(1);
  });

  test("colonne trop etroite pour deux : la carte est empilee PARTOUT, jamais un `width` negatif", async () => {
    // Une rangée à quatre colonnes laisse ~130 px : la vignette (80 px plancher) et le texte n'y
    // tiennent pas côte à côte. Personne ne doit recevoir de `width="-4"`.
    const doc = EmailDoc.parse({
      schema: 2,
      meta: { subject: "Etroit", preheader: "Etroit", assetSlug: "demo-brand", locale: "es-CL" },
      theme: {},
      rows: [
        {
          id: "row_etroit",
          layout: "1-1-1-1",
          columns: [1, 2, 3, 4].map((n) => ({
            id: `col_${n}`,
            blocks: [
              {
                id: `blk_${n}`,
                type: "article",
                layout: "side",
                title: `Titre ${n}`,
                excerpt: "Chapeau",
                href: "https://example.test/a",
                imageSrc: "https://example.test/i.jpg",
                imageAlt: "",
                ctaLabel: "Leer la nota",
              },
            ],
          })),
        },
      ],
    });
    const { html } = await compileDoc(doc);
    expect(html).not.toMatch(/width="-\d/);
    expect(html).not.toMatch(/width:-\d/);
  });
});

/* ============================================================================================ *
 * (e) APERÇU ET ENVOI PASSENT PAR LE MÊME CODE
 * ============================================================================================ */

describe("(e) l'apercu compile et l'envoi produisent le MEME HTML sur les memes articles", () => {
  test("octet pour octet", async () => {
    const reglages = {
      leadCount: 1,
      showKicker: true,
      timeZone: "America/Santiago",
      lead: { layout: "stacked", kickerMode: "text", kickerText: "Destacada", ctaStyle: "link" },
      card: { layout: "side", kickerMode: "category-time" },
      midSection: { label: "Más noticias" },
    };
    // L'aperçu : `compileDoc` déplie tout seul les `previewItems`.
    const apercu = await compileDoc(docFlux(reglages));
    // L'envoi : le worker déplie AVANT, avec les articles résolus 90 min plus tôt.
    const doc = docFlux(reglages);
    const resolu: Record<string, FeedResolution> = {
      blk_feed: { items: [ITEM(1), ITEM(2), ITEM(3)] as never, fetchedAt: "2026-09-22T12:00:00.000Z" },
    };
    const envoi = await compileDoc(expandFeedBlocks(doc, resolu).doc);
    expect(envoi.html).toBe(apercu.html);
  });
});

/* ============================================================================================ *
 * (f) « ARRANGEMENT » DU FLUX — le look `card` le masquait (rapport du 23/09/2026)
 * ============================================================================================ */

/**
 * La forme de « Boletín semanal genérico » (et des 3 autres « Boletín semanal … ») : le flux ET ses
 * deux looks posent une disposition. `toArticle` fait `look.layout ?? feed.layout`, donc changer le
 * seul `layout` du flux ne touchait AUCUNE carte — c'était le bug. L'inspecteur retire désormais
 * `card.layout` en même temps ; le compilateur, lui, ne change pas (106/108 modèles réels identiques
 * à l'octet). Neutralité et contre-épreuve, comme partout dans ce fichier.
 */
describe("(f) « Arrangement » gouverne les breves des que le look `card` ne le masque plus", () => {
  const LEAD = { layout: "stacked", kickerMode: "text", kickerText: "Destacada" };
  const CARD_SANS_LAYOUT = { imageWidthPct: 33, titleSize: 20 };
  const origine = () => docFlux({ layout: "side", leadCount: 1, lead: LEAD, card: { layout: "side", ...CARD_SANS_LAYOUT } });
  // Une carte en vignette porte UNE cellule image à 100 % en `inline-block` (voir (d)).
  const VIGNETTE = 'style="display:inline-block;vertical-align:top;width:100%;max-width:100%;"';
  const vignettes = (html: string) => html.split(VIGNETTE).length - 1;

  test("contrat du compilateur : le look l'emporte, `layout` seul ne change pas un octet", async () => {
    const avant = (await compileDoc(origine())).html;
    const ancien = docFlux({ layout: "stacked", leadCount: 1, lead: LEAD, card: { layout: "side", ...CARD_SANS_LAYOUT } });
    expect((await compileDoc(ancien)).html).toBe(avant);
    expect(vignettes(avant)).toBe(2);
  });

  test("le patch de l'inspecteur (`layout` + `card` sans `layout`) empile les deux breves, la une reste", async () => {
    const apres = docFlux({ layout: "stacked", leadCount: 1, lead: LEAD, card: CARD_SANS_LAYOUT });
    const html = (await compileDoc(apres)).html;
    expect(html).not.toBe((await compileDoc(origine())).html);
    expect(vignettes(html)).toBe(0);
    // Le reste du look des brèves est gardé : `titleSize` 20 sur les deux brèves.
    expect(deplie(apres).filter((b) => (b as { titleSize?: number }).titleSize === 20)).toHaveLength(2);
    expect(html.split("Destacada").length - 1).toBe(1);
  });
});
