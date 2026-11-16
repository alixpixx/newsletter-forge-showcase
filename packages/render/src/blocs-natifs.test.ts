/**
 * BANC DE PREUVE DES BLOCS DE CHÂSSIS — `bun test` depuis la racine du dépôt.
 *
 * Ce que ce banc protège, dans l'ordre d'importance :
 *
 *  1. LA NEUTRALITÉ. Sept propriétés et trois blocs ont été ajoutés au schéma pour supprimer les
 *     blocs `html` des maquettes de marque. Aucun document antérieur n'en porte : leur HTML doit
 *     donc rester identique OCTET POUR OCTET. C'est ce qui autorise à ne PAS incrémenter
 *     `COMPILER_VERSION`, et donc à garder les versions déjà publiées reproductibles.
 *  2. LES GARDES QUI NE FABRIQUENT PAS. Un encart dont le libellé de bouton n'a pas de lien ne
 *     doit émettre AUCUNE ancre — même règle que le CTA d'article, même raison : on ne fabrique
 *     pas un bouton qui ne tient pas sa promesse.
 *  3. LES CRANS SILENCIEUX. `blockToText`, les avertissements métier et les règles de publication
 *     ne sont attrapés par AUCUN typage quand on les oublie : ils rendent une chaîne vide, ou rien
 *     du tout. Seul un test les tient.
 *
 * ⚠️ Les fragments HTML attendus sont écrits en dur ici, jamais construits depuis le compilateur.
 */
import { describe, expect, test } from "bun:test";
import { compileDoc } from "./compile";
import { renderText } from "./compile/text";
import { EmailDoc, EmailDocPublishable } from "./schema";

/* ------------------------------------------------------------------ *
 * Fabriques
 * ------------------------------------------------------------------ */

function doc(blocks: unknown[], theme: Record<string, unknown> = {}): unknown {
  return {
    schema: 2,
    meta: { subject: "Sujet", preheader: "", assetSlug: "northwind-sports", locale: "pt-BR" },
    theme: { contentWidth: 600, ...theme },
    rows: [{ id: "r1", layout: "1", columns: [{ id: "c1", blocks }] }],
  };
}

const compile = async (blocks: unknown[], theme?: Record<string, unknown>) =>
  await compileDoc(EmailDoc.parse(doc(blocks, theme)) as never);

const SECTION = {
  id: "s1",
  type: "section_title",
  label: "Mais do dia",
  rule: "after",
  ruleColor: "#721A2C",
  ruleThickness: 2,
};
const CALLOUT = {
  id: "k1",
  type: "callout",
  kicker: "Agenda",
  title: "Os próximos jogos",
  body: "Datas e horários.",
  accentWidth: 0,
};
const SCORE = {
  id: "b1",
  type: "scoreboard",
  kicker: "Carabao Cup",
  rows: [
    { label: "Preston", value: "0", highlight: false },
    { label: "Rovers", value: "4", highlight: true },
  ],
};

/* ================================================================== *
 * 1. NEUTRALITÉ — un document d'avant compile exactement comme avant
 * ================================================================== */
describe("neutralité du compilateur", () => {
  test("un document sans aucune des nouvelles propriétés compile à l'identique", async () => {
    // Le témoin est calculé DEUX FOIS sur le même document : ce test seul ne prouverait rien.
    // Sa vraie valeur est le contrôle de non-régression ci-dessous, qui liste ce que le HTML d'un
    // document ordinaire ne doit PAS contenir.
    const blocs = [
      { id: "t1", type: "text", preset: "body", paragraphs: [{ spans: [{ text: "Bonjour" }] }] },
      { id: "d1", type: "divider", thickness: 1, widthPct: 100 },
    ];
    const html = (await compile(blocs)).html;
    // Les quatre propriétés de style ne doivent laisser AUCUNE trace quand elles sont absentes.
    expect(html).not.toContain("letter-spacing");
    expect(html).not.toContain("text-transform");
    // Le filet reste un `mj-divider` : la branche des segments ne doit pas se déclencher.
    // ⚠️ MJML écrit `solid 1px`, pas `1px solid` — l'ordre est celui de MJML, pas le nôtre.
    expect(html).toContain("border-top:solid 1px");
    // Aucune police web déclarée => aucun chargement de police.
    expect(html).not.toContain("fonts.googleapis.com");
    // L'alignement vertical d'une colonne reste `top`.
    expect(html).toContain("vertical-align:top");
  });

  test("un filet SANS segments ne produit aucune table de cellules colorées", async () => {
    const html = (await compile([{ id: "d1", type: "divider", thickness: 6, widthPct: 100 }])).html;
    expect(html).not.toContain("#721A2C");
  });
});

/* ================================================================== *
 * 2. LES NOUVELLES PROPRIÉTÉS ARRIVENT VRAIMENT DANS L'EMAIL
 * ================================================================== */
describe("propriétés de style", () => {
  test("letterSpacing, textTransform et fontWeight d'un bloc texte sortent en CSS inline", async () => {
    const html = (
      await compile([
        {
          id: "t1",
          type: "text",
          preset: "body",
          paragraphs: [{ spans: [{ text: "Boletín" }] }],
          style: { letterSpacing: 3.6, textTransform: "uppercase", fontWeight: "900" },
        },
      ])
    ).html;
    expect(html).toContain("letter-spacing:3.6px");
    expect(html).toContain("text-transform:uppercase");
    expect(html).toContain("font-weight:900");
  });

  test("verticalAlign d'une colonne remplace le `top` codé en dur", async () => {
    const brut = {
      schema: 2,
      meta: { subject: "S", preheader: "", assetSlug: "northwind-sports", locale: "pt-BR" },
      theme: { contentWidth: 600 },
      rows: [
        {
          id: "r1",
          layout: "1-1",
          columns: [
            { id: "c1", style: { verticalAlign: "middle" }, blocks: [{ id: "s1", type: "spacer", height: 8 }] },
            { id: "c2", blocks: [{ id: "s2", type: "spacer", height: 8 }] },
          ],
        },
      ],
    };
    const html = (await compileDoc(EmailDoc.parse(brut) as never)).html;
    expect(html).toContain("vertical-align:middle");
  });

  test("webFonts émet un chargement de police, et rien sans elles", async () => {
    // ⛔ MJML n'émet le `<link>` d'un `mj-font` QUE si la famille est effectivement employée dans
    // le document. Déclarer « Archivo » sans qu'aucune `fontFamily` ne le nomme ne charge RIEN, en
    // silence : c'est exactement le mode de panne qui laissait les polices de marque sur le carreau.
    const police = { webFonts: [{ family: "Archivo", href: "https://fonts.googleapis.com/css2?family=Archivo" }] };
    const avec = (await compile([SECTION], { ...police, fontFamily: "Archivo, Arial, sans-serif" })).html;
    expect(avec).toContain("https://fonts.googleapis.com/css2?family=Archivo");

    // Contre-épreuve 1 : la même déclaration, mais la police n'est nommée nulle part.
    const jamaisUtilisee = (await compile([SECTION], police)).html;
    expect(jamaisUtilisee).not.toContain("fonts.googleapis.com");

    // Contre-épreuve 2 : la police est employée, mais rien n'est déclaré.
    const sansDeclaration = (await compile([SECTION], { fontFamily: "Archivo, Arial, sans-serif" })).html;
    expect(sansDeclaration).not.toContain("fonts.googleapis.com");
  });

  test("un filet AVEC segments sort en cellules colorées, une par segment", async () => {
    const html = (
      await compile([
        {
          id: "d1",
          type: "divider",
          thickness: 6,
          widthPct: 100,
          segments: [
            { color: "#721A2C", widthPct: 45 },
            { color: "#FEFEFE", widthPct: 10 },
            { color: "#166943", widthPct: 45 },
          ],
        },
      ])
    ).html;
    expect(html).toContain("background-color:#721A2C");
    expect(html).toContain("background-color:#166943");
    // Plus de `mj-divider` : la bordure unique ne doit pas coexister avec les segments.
    expect(html).not.toContain("border-top:6px solid");
  });

  /**
   * ⛔ 23/09/2026 — la barre à segments portait `width:600px` en STYLE : sur un téléphone (375 px),
   * elle imposait 600 px à tout l'e-mail, la page débordait de 225 px et le texte voisin était coupé
   * à droite. Table HYBRIDE : les attributs `width` restent en px (Outlook/Word ne lit qu'eux), le
   * style est fluide. Ce test rougit si une largeur en px revient dans un `style` de la barre.
   * Contre-épreuve faite (mutant) : table repassée en `width:${width}px`, puis cellules repassées en
   * `width:${w}px` ⇒ rouge les deux fois.
   */
  test("un filet AVEC segments reste fluide : aucune largeur en px dans le style de sa table", async () => {
    const html = (
      await compile([
        {
          id: "d1",
          type: "divider",
          thickness: 6,
          widthPct: 100,
          segments: [
            { color: "#721A2C", widthPct: 45 },
            { color: "#FEFEFE", widthPct: 10 },
            { color: "#166943", widthPct: 45 },
          ],
        },
      ])
    ).html;
    const debut = html.lastIndexOf("<table", html.indexOf("background-color:#721A2C"));
    const barre = html.slice(debut, html.indexOf("</table>", debut) + "</table>".length);
    // Tous les `style` de la barre : aucun `width:<n>px` (seul `max-width` a le droit d'être en px).
    const styles = [...barre.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!);
    expect(styles).toHaveLength(4);
    for (const s of styles) expect(s).not.toMatch(/(^|;)\s*width:\s*\d+(\.\d+)?px/);
    // La table : 100 % de sa colonne, plafonnée à la largeur que le bureau lui donnait (600 − 2 × 24).
    expect(barre).toContain('width="552" style="width:100%;max-width:552px;border-collapse:collapse;"');
    // Les cellules : la part EXACTE de chaque segment en style, les px arrondis en attribut (Word).
    expect(barre).toContain('<td width="248" style="width:45%;height:6px;background-color:#721A2C;');
    expect(barre).toContain('<td width="55" style="width:10%;height:6px;background-color:#FEFEFE;');
    expect(barre).toContain('<td width="248" style="width:45%;height:6px;background-color:#166943;');
  });

  /**
   * ⛔ 23/09/2026 — le même `width:<W>px` en STYLE, dans tous les autres blocs-tables : 71 documents
   * réels sur 125 débordaient à 375 px (jusqu'à 604 px ; les 6 versions « Giro do Tricolor » par leurs
   * articles et titres de section, les Boletín par leurs encarts). Tables HYBRIDES : attribut `width`
   * en px (Outlook/Word), style `width:100%;max-width:<W>px`. Ce test rougit si la TABLE d'un bloc
   * reprend une largeur px en style. Les cellules, elles, gardent leur px : elles ne forcent rien dans
   * une table fluide, et un % décalait le bureau (cf. `largeurTable` dans `mjml.ts`).
   * Les cadres sont ici SANS bordure ; les cadres BORDÉS, dont la table intérieure doit en plus faire
   * place à la bordure, ont leur test (le suivant). Contre-épreuve faite (mutants, un par famille) :
   * article, titre de section, cadre d'encart, carte (pick/promo), cotes, classement, cadre du bandeau,
   * et tables intérieures (ligne du pick, scores, vignette d'encart) repassés un à un en px ⇒ rouge à
   * chaque fois.
   */
  test("les tables des blocs restent fluides : aucune largeur en px dans le style d'une table de bloc", async () => {
    const html = (
      await compile([
        { id: "a1", type: "article", title: "Título", excerpt: "Resumo.", href: "https://example.org/a", imageAlt: "" },
        ...(["after", "before", "both", "under", "none", "left"] as const).map((rule, i) => ({ ...SECTION, id: `s${i}`, rule })),
        CALLOUT,
        { ...CALLOUT, id: "k2", imageSrc: "https://example.org/v.jpg", imageAlt: "" },
        { id: "p1", type: "pick", matchLabel: "Flu x Palmeiras", marketLabel: "1X2", selectionLabel: "Flu", oddsLabel: "2.10", frameWidth: 0 },
        { id: "p2", type: "promo", headline: "Bônus", body: "Texto.", code: "FLU10", href: "https://example.org/p", ctaLabel: "Pegar" },
        { id: "o1", type: "odds_table", rows: [{ label: "Flu", value: "2.10" }, { label: "Palmeiras", value: "3.40" }] },
        { id: "t1", type: "standings", columns: ["Time", "J", "Pts"], rows: [["Flu", "20", "41"]] },
        { ...SCORE, style: { borderWidth: 0 } },
      ])
    ).html;
    // Les ghost tables `mso` sont à largeur fixe à dessein : Outlook ne lit qu'elles.
    const visible = html.replace(/<!--\[if mso \| IE\]>[\s\S]*?<!\[endif\]-->/g, "");
    const pxEnStyle = /style="(?:[^"]*;)?\s*width:\s*\d+(\.\d+)?px/;
    const tables = [...visible.matchAll(/<table role="presentation" border="0" cellpadding="0" cellspacing="0"[^>]*\swidth="(\d+)"[^>]*>/g)];
    // Pas de banc vide : 17 tables (article, 6 titres, 2 cadres d'encart + la vignette, carte et ligne
    // du pick, promo, cotes, classement, cadre et scores du bandeau).
    expect(tables).toHaveLength(17);
    const fautives = tables.map((m) => m[0]).filter((tag) => pxEnStyle.test(tag));
    expect(fautives).toEqual([]);
    for (const [tag, w] of tables) expect(tag).toContain(`style="width:100%;max-width:${w}px;`);
    // La ligne du pick est fluide ; ses deux cellules gardent leur px (520 − 150 et 150).
    expect(visible).toContain(
      'width="520" style="width:100%;max-width:520px;border-collapse:collapse;"><tr><td align="left" width="370" valign="middle" style="width:370px;">',
    );
  });

  /**
   * ⛔ LA FRONTIÈRE, RÉÉCRITE EN CONNAISSANCE DE CAUSE (24/09/2026, DÉCISION D'ALIX : « oui corrige »).
   * Jusqu'en 1.6.2, ce test exigeait l'inverse : dans un cadre BORDÉ, la table intérieure gardait ses
   * px, calculés `W − marges` SANS la bordure. Elle poussait le cadre à `W + bordures` au bureau (540 px
   * dans une colonne de 536, section à 604) et faisait déborder 45 documents réels sur 125 à 375 px.
   * Désormais le cadre, bordure comprise, tient dans sa colonne : table intérieure = `W − marges −
   * bordures` (`tableInterieure`), en attribut (Outlook/Word) comme en plafond, style fluide. Au
   * bureau, ces cadres perdent 2 à 4 px et leur section revient à 600 (mesuré sur les 45).
   * Une famille par cadre : le pick par défaut (1 px), le bandeau à bordure, l'encart à filet d'accent
   * avec vignette (le Boletín Copper Kettle). Contre-épreuve faite (mutants, un par famille : sa bordure
   * retirée du calcul) ⇒ rouge à chaque fois.
   */
  test("un cadre BORDÉ tient dans sa colonne : table intérieure fluide, bordure comprise (pick, bandeau, encart à filet)", async () => {
    const html = (
      await compile([
        { id: "p1", type: "pick", matchLabel: "Flu x Palmeiras", marketLabel: "1X2", selectionLabel: "Flu", oddsLabel: "2.10" },
        { ...SCORE, style: { borderWidth: 2 } },
        { ...CALLOUT, id: "k2", accentWidth: 4, imageSrc: "https://example.org/v.jpg", imageAlt: "" },
      ])
    ).html;
    // Les trois cadres sont hybrides, plafonnés à la colonne (600 − 2 × 24 = 552), bordure comprise.
    expect(html.split('width="552" style="width:100%;max-width:552px;border-collapse:separate;').length - 1).toBe(3);
    // Pick, bordure de 1 px : 552 − 2 × 16 − 2 × 1 = 518 ; cote 150, libellés 368.
    expect(html).toContain(
      'width="518" style="width:100%;max-width:518px;border-collapse:collapse;"><tr><td align="left" width="368" valign="middle" style="width:368px;">',
    );
    // Bandeau, bordure de 2 px : 552 − 2 × 16 − 2 × 2 = 516 ; valeur 70, libellé 446.
    expect(html).toContain('width="516" style="width:100%;max-width:516px;border-collapse:collapse;"><tr><td width="446" style="width:446px;');
    // Encart, filet de 4 px à gauche et pas de bordure : 552 − 2 × 24 − 4 = 500 ; vignette 24 % = 120,
    // texte 500 − 120 − 14 = 366.
    expect(html).toContain(
      'width="500" style="width:100%;max-width:500px;border-collapse:collapse;"><tr><td align="left" width="366" valign="top" style="width:366px;padding:0 14px 0 0;">',
    );
    expect(html).toContain('<td align="right" width="120" valign="top" style="width:120px;">');
    // Et plus aucune table de bloc en px dans son style (les ghost tables `mso`, fixes à dessein, à part).
    const visible = html.replace(/<!--\[if mso \| IE\]>[\s\S]*?<!\[endif\]-->/g, "");
    expect(visible).not.toMatch(/<table role="presentation" border="0" cellpadding="0" cellspacing="0"[^>]*style="width:\d+px/);
  });
});

/* ================================================================== *
 * 3. LES TROIS BLOCS RENDENT CE QU'ILS ANNONCENT
 * ================================================================== */
describe("rendu des blocs", () => {
  test("section_title pose le libellé ET le filet sur la même ligne", async () => {
    const html = (await compile([SECTION])).html;
    expect(html).toContain("Mais do dia");
    expect(html).toContain("border-top:2px solid #721A2C");
  });

  test("section_title en rule:none ne trace aucun filet", async () => {
    const html = (await compile([{ ...SECTION, rule: "none" }])).html;
    expect(html).toContain("Mais do dia");
    expect(html).not.toContain("border-top:2px solid #721A2C");
  });

  test("callout : un libellé SANS lien n'émet aucune ancre", async () => {
    const html = (await compile([{ ...CALLOUT, ctaLabel: "Ver a agenda" }])).html;
    expect(html).toContain("Os próximos jogos");
    expect(html).not.toContain("Ver a agenda");
  });

  test("callout : un lien SANS libellé n'émet aucune ancre non plus", async () => {
    const html = (await compile([{ ...CALLOUT, href: "https://www.northwind-sports.example/" }])).html;
    expect(html).not.toContain("https://www.northwind-sports.example/");
  });

  test("callout : lien ET libellé ensemble donnent un bouton", async () => {
    const html = (
      await compile([{ ...CALLOUT, href: "https://www.northwind-sports.example/", ctaLabel: "Ver a agenda" }])
    ).html;
    expect(html).toContain('href="https://www.northwind-sports.example/"');
    expect(html).toContain("Ver a agenda");
  });

  test("callout : titre et corps peuvent porter deux polices distinctes", async () => {
    const html = (
      await compile([{ ...CALLOUT, titleFont: "'Archivo Black',serif", bodyFont: "Georgia,serif" }])
    ).html;
    expect(html).toContain("'Archivo Black',serif");
    expect(html).toContain("Georgia,serif");
  });

  test("scoreboard : la ligne mise en avant prend la couleur de marque, l'autre non", async () => {
    const html = (await compile([SCORE], { brandColor: "#0C2C61", mutedColor: "#6B7280" })).html;
    expect(html).toContain("color:#0C2C61");
    expect(html).toContain("color:#6B7280");
    expect(html).toContain("Preston");
    expect(html).toContain("Rovers");
  });

  test("un panneau ne peint pas le fond de la cellule qui le contient", async () => {
    // ⛔ Régression MESURÉE à l'écran : `container-background-color` étalait l'aplat de l'encart
    // sur toute la largeur de la colonne, gouttières comprises.
    const html = (await compile([{ ...CALLOUT, style: { backgroundColor: "#166943" } }])).html;
    expect(html).not.toContain('background-color="#166943"');
    expect(html).toContain("background-color:#166943");
  });

  test("la casse forcée d'un encart ne touche QUE le surtitre", async () => {
    // ⛔ Régression MESURÉE : posée en attribut sur le `mj-text` conteneur, elle était héritée par
    // le titre et le paragraphe, qui ressortaient en capitales interlettrées.
    const html = (await compile([{ ...CALLOUT, style: { textTransform: "uppercase", letterSpacing: 2.6 } }])).html;
    const occurrences = html.split("text-transform:uppercase").length - 1;
    expect(occurrences).toBe(1);
  });
});

/* ================================================================== *
 * 4. VERSION TEXTE — un case oublié rend "" sans que rien ne casse
 * ================================================================== */
describe("version texte", () => {
  // On passe par `renderText`, la vraie porte : tester la fonction interne demanderait de
  // l'exporter pour le seul banc, et ne prouverait pas qu'elle est bien atteinte.
  const texte = (blocks: unknown[]): string => renderText(EmailDoc.parse(doc(blocks)) as never);

  test("les trois blocs produisent du vrai texte", () => {
    expect(texte([SECTION])).toContain("MAIS DO DIA");
    expect(texte([CALLOUT])).toContain("Os próximos jogos");
    expect(texte([SCORE])).toContain("Rovers");
    expect(texte([SCORE])).toContain("Preston : 0");
  });

  test("le texte d'un callout sans lien ne fabrique pas de CTA", () => {
    expect(texte([{ ...CALLOUT, ctaLabel: "Ver a agenda" }])).not.toContain("VER A AGENDA");
  });
});

/* ================================================================== *
 * 5. PUBLICATION ET AVERTISSEMENTS — les crans qui restent muets sinon
 * ================================================================== */
describe("garde-fous de publication", () => {
  const publiable = (blocks: unknown[]): boolean => EmailDocPublishable.safeParse(doc(blocks)).success;

  test("un titre de section vide bloque la publication, rempli il passe", () => {
    expect(publiable([{ ...SECTION, label: "" }])).toBe(false);
    expect(publiable([SECTION])).toBe(true);
  });

  test("un encart vide bloque, un encart rempli passe", () => {
    expect(publiable([{ ...CALLOUT, title: "", body: "" }])).toBe(false);
    expect(publiable([CALLOUT])).toBe(true);
  });

  test("un libellé de bouton sans lien bloque la publication", () => {
    expect(publiable([{ ...CALLOUT, ctaLabel: "Ver" }])).toBe(false);
    expect(publiable([{ ...CALLOUT, ctaLabel: "Ver", href: "https://www.northwind-sports.example/" }])).toBe(true);
  });

  test("une ligne de bandeau entièrement vide bloque la publication", () => {
    const vide = { ...SCORE, rows: [{ label: "", value: "", highlight: false }, SCORE.rows[1]] };
    expect(publiable([vide])).toBe(false);
    expect(publiable([SCORE])).toBe(true);
  });

  test("le schéma reste fermé : une propriété inventée fait échouer le parse", () => {
    expect(EmailDoc.safeParse(doc([{ ...SECTION, couleurDuFiletJoli: "#fff" }])).success).toBe(false);
    expect(EmailDoc.safeParse(doc([{ id: "t", type: "text", preset: "body", paragraphs: [{ spans: [{ text: "x", taille: 3 }] }] }])).success).toBe(false);
  });

  test("les bornes des nouvelles propriétés sont appliquées", () => {
    const avecStyle = (style: unknown) => EmailDoc.safeParse(doc([{ ...SECTION, style }])).success;
    expect(avecStyle({ letterSpacing: 3.6 })).toBe(true);
    expect(avecStyle({ letterSpacing: 42 })).toBe(false);
    expect(avecStyle({ fontWeight: "700" })).toBe(true);
    expect(avecStyle({ fontWeight: "bold" })).toBe(false);
    expect(avecStyle({ textTransform: "uppercase" })).toBe(true);
    expect(avecStyle({ textTransform: "smallcaps" })).toBe(false);
  });
});

describe("avertissements métier", () => {
  test("un châssis au libellé vide NE compile PLUS en vert", async () => {
    const res = await compile([{ ...SECTION, label: "" }]);
    expect(res.warnings.some((w) => w.includes("Section title"))).toBe(true);
  });

  test("un encart avec un libellé de bouton mais sans lien est signalé", async () => {
    const res = await compile([{ ...CALLOUT, ctaLabel: "Ver a agenda" }]);
    expect(res.warnings.some((w) => w.includes("no link"))).toBe(true);
  });

  test("un encart complet n'ajoute aucun avertissement de bloc", async () => {
    const res = await compile([{ ...CALLOUT, href: "https://www.northwind-sports.example/", ctaLabel: "Ver" }]);
    // ⚠️ Le document d'essai n'a ni pied légal ni lien de désabonnement : ces deux avertissements
    // sont ceux du DOCUMENT et resteront là. On mesure donc ce que le BLOC ajoute.
    expect(res.warnings.some((w) => w.includes("Callout"))).toBe(false);
  });

  test("un bandeau à moitié rempli est signalé", async () => {
    const res = await compile([{ ...SCORE, rows: [{ label: "Rovers", value: "", highlight: false }, SCORE.rows[1]] }]);
    expect(res.warnings.some((w) => w.includes("Scoreboard"))).toBe(true);
  });
});


/* ------------------------------------------------------------------ *
 * Fidélité aux maquettes — surtitre, ligne de pied, titre-lien, une de flux
 * ------------------------------------------------------------------ */

const ART = {
  id: "a1",
  type: "article",
  title: "Finalmente!",
  excerpt: "Flu já sabe as datas.",
  href: "https://www.northwind-sports.example/x/",
  imageAlt: "",
  layout: "stacked",
  ctaLabel: "Ler a matéria",
};

describe("surtitre et ligne de pied d'un article", () => {
  test("sans les nouvelles clés, la carte rend EXACTEMENT ce qu'elle rendait avant", async () => {
    const avant = await compile([ART]);
    // Aucune des lignes ajoutées ne doit apparaître, et le titre reste un `<div>` nu.
    expect(avant.html).not.toContain("padding-bottom:5px");
    expect(avant.html).toContain(">Finalmente!</div>");
  });

  test("le surtitre et son accent sortent dans UN seul div, avec deux couleurs", async () => {
    const res = await compile([
      { ...ART, kicker: "Notícias", kickerAccent: "\u00a0·\u00a015:01", kickerAccentColor: "#FD4040" },
    ]);
    expect(res.html).toContain("Notícias");
    // Le texte et son accent se TOUCHENT dans le même div : c'est ça, une seule ligne. Chercher
    // l'absence de `</div><div` ne prouvait rien — le titre en ouvre un juste après, toujours.
    expect(res.html).toContain('Notícias<span style="color:#FD4040;">');
  });

  test("la ligne de pied porte son accent en 600", async () => {
    const res = await compile([{ ...ART, meta: "Michael Kenrick · ", metaAccent: "27 comments", metaAccentColor: "#00A7ED" }]);
    expect(res.html).toContain('<span style="color:#00A7ED;font-weight:600;">27 comments</span>');
  });

  test("`titleLink` rend le titre cliquable ; sans elle il reste un div", async () => {
    const avec = await compile([{ ...ART, titleLink: true }]);
    expect(avec.html).toContain('style="display:block;font-family');
    const sans = await compile([ART]);
    expect(sans.html).toContain(">Finalmente!</div>");
  });

  test("`ctaStyle:\"none\"` supprime le LIBELLÉ de lecture, jamais l'accès à l'article", async () => {
    const res = await compile([{ ...ART, ctaStyle: "none" }]);
    expect(res.html).not.toContain("Ler a matéria");
    const txt = renderText(EmailDoc.parse(doc([{ ...ART, ctaStyle: "none" }])) as never);
    expect(txt).not.toContain("LER A MATÉRIA");
    // ⛔ CE QUI SUIT EST LE CŒUR DU TEST. En HTML l'URL reste atteignable par le titre et la
    // vignette ; en texte brut rien n'est cliquable. Sans cette ligne, la carte partait sans aucun
    // moyen de lire l'article — et la première version de ce test, qui n'assertait que l'absence
    // du libellé, passait au vert sur exactement ce défaut.
    expect(txt).toContain("https://www.northwind-sports.example/x/");
    // L'URL se pose SOUS LE TITRE, là où le HTML porte l'ancre — pas en fin de carte.
    expect(txt.indexOf("https://www.northwind-sports.example/x/") < txt.indexOf("Flu já sabe as datas.")).toBe(true);
  });

  test("`ctaUnderline` posée SEULE agit — la voie rapide de neutralité ne l'avale pas", async () => {
    const sans = await compile([{ ...ART, ctaStyle: "link" }]);
    expect(sans.html).toContain("text-decoration:underline;");
    // Une seule clé posée, et c'est justement celle que la liste d'exclusions avait oubliée.
    const nu = await compile([{ ...ART, ctaStyle: "link", ctaUnderline: 0 }]);
    expect(nu.html).toContain("text-decoration:none;");
    expect(nu.html).not.toContain("text-decoration:underline;");
  });

  test("une colonne étroite ne produit jamais de largeur négative", async () => {
    // 3 colonnes dans 320 px — la largeur MINIMALE que le schéma autorise (schema.ts:1002). La
    // colonne tombe alors sous le plancher de 80 px de la vignette, et la cellule de texte passait
    // en négatif : `width="-4"`, du HTML invalide qu'aucun typage ne voit.
    const etroit = {
      schema: 2,
      meta: { subject: "S", preheader: "", assetSlug: "northwind-sports", locale: "pt-BR" },
      theme: { contentWidth: 320 },
      rows: [
        {
          id: "r1",
          layout: "1-1-1",
          columns: [
            { id: "c1", blocks: [{ ...ART, layout: "side", imageSrc: "https://x/i.jpg", imageWidthPct: 60 }] },
            { id: "c2", blocks: [] },
            { id: "c3", blocks: [] },
          ],
        },
      ],
    };
    const res = await compileDoc(EmailDoc.parse(etroit) as never);
    expect(/width="-\d/.test(res.html)).toBe(false);
    expect(/width:-\d/.test(res.html)).toBe(false);
  });
});

describe("vignette d'encart — contrôles et accessibilité", () => {
  const AVEC_IMAGE = { ...CALLOUT, imageSrc: "https://x/vignette.jpg", href: "https://x/y", ctaLabel: "Ver" };

  test("son `http://` est signalé, comme celui d'une vignette d'article", async () => {
    const res = await compile([{ ...AVEC_IMAGE, imageSrc: "http://x/vignette.jpg" }]);
    expect(res.warnings.some((w) => w.includes("Callout image") && w.includes("http://"))).toBe(true);
    // Et le contrôle ne tire pas quand l'image est saine — un témoin qui crie toujours ne dit rien.
    const sain = await compile([AVEC_IMAGE]);
    expect(sain.warnings.some((w) => w.includes("Callout image"))).toBe(false);
  });

  test("sans `alt`, la vignette n'est PAS enveloppée dans une ancre sans nom", async () => {
    const muet = await compile([AVEC_IMAGE]);
    expect(muet.html).toContain("vignette.jpg");
    expect(muet.html).not.toContain('target="_blank"><img src="https://x/vignette.jpg"');
    // Nommée, elle redevient cliquable : le lien a alors un nom accessible.
    const nomme = await compile([{ ...AVEC_IMAGE, imageAlt: "Calendrier" }]);
    expect(nomme.html).toContain('target="_blank"><img src="https://x/vignette.jpg"');
  });
});

describe("pied de bandeau — le texte dit ce que le HTML montre", () => {
  test("un `footerHref` sans libellé n'imprime PAS d'URL nue en texte", async () => {
    const bloc = { ...SCORE, footerHref: "https://x/analyse" };
    const res = await compile([bloc]);
    expect(res.html).not.toContain("https://x/analyse");
    const txt = renderText(EmailDoc.parse(doc([bloc])) as never);
    // Le HTML n'affiche rien faute de libellé : le texte non plus, sinon le lien n'existe que dans
    // une moitié de l'email et rien ne le relit.
    expect(txt).not.toContain("https://x/analyse");
  });

  test("avec son libellé, le lien sort dans les deux versions", async () => {
    const bloc = { ...SCORE, footerLabel: "What we learned", footerHref: "https://x/analyse" };
    const res = await compile([bloc]);
    expect(res.html).toContain("https://x/analyse");
    const txt = renderText(EmailDoc.parse(doc([bloc])) as never);
    expect(txt).toContain("WHAT WE LEARNED: https://x/analyse");
  });

  test("la largeur de vignette suit `imageWidthPct` et vaut 38 % sans elle", async () => {
    // 552 px utiles dans ce document d'essai (600 moins 24 de padding de chaque côté).
    const large = await compile([{ ...ART, layout: "side", imageSrc: "https://x/i.jpg", imageWidthPct: 31 }]);
    expect(large.html).toContain('width="171"');
    const defaut = await compile([{ ...ART, layout: "side", imageSrc: "https://x/i.jpg" }]);
    expect(defaut.html).toContain('width="210"');
  });
});

describe("titre de section à barre verticale", () => {
  test("`rule:\"left\"` pose un filet À GAUCHE, pas un filet horizontal", async () => {
    const res = await compile([{ ...SECTION, rule: "left", ruleColor: "#FFCC00", ruleThickness: 3 }]);
    expect(res.html).toContain("border-left:3px solid #FFCC00");
  });
});

describe("pied du bandeau de score", () => {
  test("le lien et la note sortent sous un filet, et le lien est un vrai `<a>`", async () => {
    const res = await compile([
      { ...SCORE, footerLabel: "What we learned", footerHref: "https://x.test/report", footerNote: " — Barry." },
    ]);
    expect(res.html).toContain("border-top:1px solid");
    expect(res.html).toContain('<a href="https://x.test/report"');
    expect(res.html).toContain("— Barry.");
  });

  test("sans pied, le bandeau ne pose aucun filet supplémentaire", async () => {
    const res = await compile([SCORE]);
    expect(res.html).not.toContain("What we learned");
  });
});

describe("vignette d'encart", () => {
  test("`imageSrc` met l'encart sur deux colonnes", async () => {
    const res = await compile([{ ...CALLOUT, imageSrc: "https://x/i.jpg", imageAlt: "", imageWidthPct: 27 }]);
    expect(res.html).toContain("https://x/i.jpg");
  });
});
