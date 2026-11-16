/**
 * BANC DE PREUVE DU PRÉ-VOL — `bun test` depuis la racine du dépôt.
 *
 * ⛔ CE QU'IL FAUT SAVOIR AVANT DE LIRE UN CHIFFRE ICI : `runPreflight(doc)` appelé SANS second
 * argument ne lève AUCUN constat de COMPILATEUR. L'alt manquant, la sentinelle `ai://` et le lien
 * `http://` appartiennent à `collectWarnings()`, qui vit dans `compileDoc()` — le pré-vol les
 * INGÈRE, il ne les recalcule pas. MJML ne tourne pas dans le navigateur : en production ces faits
 * arrivent par `POST /api/builder/preview` sous la forme d'un `CompiledFacts`.
 *
 * ⚠️ Ce qui NE dépend PAS du compilateur, ce sont les refus d'`EmailDocPublishable` : ils se lisent
 * sur le document lui-même et sortent dès le premier appel. Mesuré ici, fixture (d) — image seule
 * sans alt :
 *   runPreflight(doc)                       → blocking 1, source "schema",   size null
 *   runPreflight(doc, faits de compileDoc)  → blocking 1, source "compiler", size > 0
 * Le verrou de publication reste donc FERMÉ avant la première compilation : c'est le VOCABULAIRE
 * du constat qui change, pas le verdict. Un banc qui oublierait le second argument ne verrait pas
 * un document vert, il verrait le bon refus dit par la mauvaise bouche — et il perdrait au passage
 * tous les avertissements consultatifs. La suite `CompiledFacts` plus bas mesure cet écart dans les
 * deux sens.
 *
 * ⚠️ Les assertions portent sur des CHIFFRES et sur la STRUCTURE d'un constat (niveau, groupe,
 * source, bloc ciblé, présence ou absence d'un correctif) — jamais sur une phrase entière : les
 * messages sont de l'interface, ils bougeront, et un banc qui les recopie ne mesure que lui-même.
 *
 * ⛔ LA RÈGLE QUE CE BANC EXISTE POUR TENIR : un constat d'alt manquant N'A PAS DE CORRECTIF, et
 * ne doit jamais en avoir. Fabriquer un alt (recopier le titre, décrire le fichier) mentirait aux
 * lecteurs d'écran ET éteindrait le blocage — l'email partirait, l'écran serait vert, et
 * l'accessibilité serait pire qu'avant. Les tests (c) et (d) l'affirment explicitement.
 */
import { describe, expect, test } from "bun:test";
import { compileDoc } from "@nf/render/compile";
import { defaultArticleCta } from "@nf/render/cta";
import type { EmailDoc } from "@nf/render/schema";
import { runPreflight, type PreflightFinding, type PreflightReport } from "./index";
import {
  docArticleCtaDeadHref,
  docArticleCtaLiveHref,
  docArticleTitledNoAlt,
  docArticleUntitledNoAlt,
  docCalloutLayout,
  docFeedMinAboveCount,
  docFeedMinBelowCount,
  docImageNoAlt,
  docInsecureAndPlaceholder,
  docThreeFooters,
} from "./__fixtures__/docs";

/** Le chemin RÉEL : on compile, puis on passe les faits au pré-vol — comme l'aperçu du builder. */
async function audit(doc: EmailDoc): Promise<PreflightReport> {
  const compiled = await compileDoc(doc);
  return runPreflight(doc, { sizeBytes: compiled.sizeBytes, warnings: compiled.warnings });
}

const onBlock = (report: PreflightReport, blockId: string): PreflightFinding[] =>
  report.findings.filter((f) => f.target?.blockId === blockId);

const only = (findings: PreflightFinding[]): PreflightFinding => {
  expect(findings).toHaveLength(1);
  return findings[0] as PreflightFinding;
};

describe("(a) liens http://, sentinelle ai:// et libellé qui déborde", () => {
  test("les constats se cumulent et chacun porte son correctif mécanique", async () => {
    const report = await audit(docInsecureAndPlaceholder());

    expect(report.counts.blocking).toBe(1);
    expect(report.counts.advisory).toBe(7);
    expect(report.canPublish).toBe(false);

    // Cinq liens en clair = cinq constats, mais UN SEUL correctif, qui les répare tous d'un coup.
    // Corriger lien par lien ferait cliquer cinq fois sans jamais voir le panneau se vider.
    const menu = onBlock(report, "blk_menu");
    expect(menu).toHaveLength(5);
    for (const finding of menu) {
      expect(finding.level).toBe("advisory");
      expect(finding.group).toBe("links");
      expect(finding.source).toBe("compiler");
      expect(finding.fix?.blockId).toBe("blk_menu");
    }
    expect(new Set(menu.map((f) => f.fix?.label)).size).toBe(1);

    // Sentinelle d'illustration : BLOQUANT (la publication la refuse), réparable en retirant la
    // vignette — l'article reste publiable en texte seul.
    const article = only(onBlock(report, "blk_article"));
    expect(article.level).toBe("blocking");
    expect(article.group).toBe("images");
    expect(article.fix?.blockId).toBe("blk_article");

    const image = only(onBlock(report, "blk_image"));
    expect(image.level).toBe("advisory");
    expect(image.fix?.blockId).toBe("blk_image");

    // Débordement GÉOMÉTRIQUE : le libellé est valide au schéma, c'est la colonne qui est étroite.
    // Il vient du pré-vol seul, pas du compilateur — d'où `source: "preflight"`.
    const button = only(onBlock(report, "blk_button"));
    expect(button.level).toBe("advisory");
    expect(button.group).toBe("structure");
    expect(button.source).toBe("preflight");
    expect(button.fix?.blockId).toBe("blk_button");
  });
});

describe("(b)/(c) vignette d'article : la règle est CONDITIONNELLE, pas désarmée", () => {
  test("(b) un titre nomme la vignette — alt vide, aucun constat", async () => {
    const report = await audit(docArticleTitledNoAlt());

    expect(report.findings).toHaveLength(0);
    expect(report.counts).toEqual({ blocking: 0, advisory: 0 });
    expect(report.canPublish).toBe(true);
  });

  test("(c) plus de titre : la vignette redevient muette, le blocage revient SANS correctif", async () => {
    const report = await audit(docArticleUntitledNoAlt());

    expect(report.counts.blocking).toBe(1);
    expect(report.counts.advisory).toBe(1);
    expect(report.canPublish).toBe(false);

    const blocking = only(report.findings.filter((f) => f.level === "blocking"));
    expect(blocking.group).toBe("images");
    expect(blocking.target?.blockId).toBe("blk_article");
    // ⛔ Aucun correctif : la seule source d'un alt honnête est l'humain qui regarde l'image.
    expect(blocking.fix).toBeUndefined();

    // Le titre manquant est signalé à part, en consultatif : un brouillon sans titre reste un
    // brouillon, il ne se refuse pas.
    const advisory = only(report.findings.filter((f) => f.level === "advisory"));
    expect(advisory.group).toBe("content");
  });
});

describe("(d) image seule sans alt", () => {
  test("bloquant, et toujours sans correctif fabriqué", async () => {
    const report = await audit(docImageNoAlt());

    expect(report.counts).toEqual({ blocking: 1, advisory: 0 });
    expect(report.canPublish).toBe(false);

    const finding = only(onBlock(report, "blk_image"));
    expect(finding.level).toBe("blocking");
    expect(finding.group).toBe("images");
    expect(finding.fix).toBeUndefined();
  });
});

describe("(e)/(e′) flux d'articles : le plancher ne se rabote QUE s'il dépasse la demande", () => {
  test("(e) plancher au-dessus : refus du SCHÉMA, réparé avec la valeur lue à côté", async () => {
    const doc = docFeedMinAboveCount();
    const report = await audit(doc);

    expect(report.counts).toEqual({ blocking: 1, advisory: 0 });
    expect(report.canPublish).toBe(false);

    const finding = only(report.findings);
    expect(finding.level).toBe("blocking");
    // `source: "schema"` est l'assertion qui compte : c'est `EmailDocPublishable` — celui que
    // `POST …/publish` interroge — qui a parlé. Un jour où ce serait `"preflight"`, le pré-vol
    // aurait sa propre copie de la règle, et les deux dériveraient.
    expect(finding.source).toBe("schema");
    expect(finding.target?.blockId).toBe("blk_feed");

    // ⚠️ La demande est RELUE dans la fixture, jamais recopiée en dur ici : lire `count` dans le
    // bloc voisin est précisément ce que le correctif doit faire. Un `2` écrit en clair dans ce
    // test passerait encore le jour où le correctif se mettrait à inventer sa valeur.
    const feed = doc.rows[0]?.columns[0]?.blocks[0];
    if (feed?.type !== "article-feed") throw new Error("fixture (e) : le premier bloc n'est plus un flux d'articles");

    // Le refus est ATTEIGNABLE depuis l'éditeur (deux champs voisins, valides isolément) : sans
    // bouton, l'auteur voyait un blocage sur deux réglages dont rien ne disait qu'ils étaient liés.
    expect(finding.fix?.blockId).toBe("blk_feed");
    // ⛔ On BAISSE le plancher, on ne monte JAMAIS la demande : monter `count` ferait partir plus
    // d'articles que l'auteur n'en a demandé — c'est une décision éditoriale, pas une réparation.
    // `toEqual` sur le patch entier le verrouille : un `{ count: 3 }` ajouté ici ferait rougir.
    expect(finding.fix?.patch).toEqual({ minCount: feed.count });
    // Le libellé doit ANNONCER le résultat, sinon le bouton demande un acte de foi. On mesure le
    // chiffre qu'il porte, pas la phrase : le reste est de l'interface, et l'interface bougera.
    expect(finding.fix?.label).toContain(String(feed.count));
  });

  test("(e′) CONTRE-PREUVE — plancher SOUS la demande : ni constat, ni bouton", async () => {
    const report = await audit(docFeedMinBelowCount());

    expect(report.counts).toEqual({ blocking: 0, advisory: 0 });
    expect(report.canPublish).toBe(true);
    // ⛔ Le risque n'est pas le bouton absent, c'est le bouton de TROP : sur un flux sans faute il
    // raboterait un `minCount` volontaire au nom d'un refus qui n'existe pas. On mesure donc les
    // deux absences — aucun constat sur le bloc, et aucun correctif qui le vise depuis ailleurs.
    expect(onBlock(report, "blk_feed")).toHaveLength(0);
    expect(report.findings.filter((f) => f.fix?.blockId === "blk_feed")).toHaveLength(0);
  });
});

/**
 * ⛔ CE QUE CE COUPLE MESURE, ET QUE RIEN D'AUTRE NE MESURAIT : le pré-vol juge le CTA QUI PARTIRA,
 * pas celui qui dort en base. Le rendu pose le défaut de `meta.locale` sur tout article sans
 * libellé — mais SEULEMENT si le lien mène quelque part (`goesNowhere`, `@nf/render/links`).
 *
 * Les deux fixtures ne diffèrent QUE par le `href`, donc chaque écart de chiffre ci-dessous est
 * imputable à cette garde et à elle seule. Sensibilité MESURÉE sur ce banc, en substituant le seul
 * `goesNowhere` (`bun test … --preload` + `mock.module` sur `packages/render/src/links.ts`, tout le
 * reste du module inchangé — `isPlaceholderHref` compris, sinon le témoin de (g) s'éteindrait
 * aussi et on ne saurait plus quelle règle a bougé) :
 *   · prédicat intact                      →                                 11 pass / 0 fail ;
 *   · forcé à toujours-VRAI   → (g′) perd son constat de largeur  →           10 pass / 1 fail ;
 *   · forcé à toujours-FAUX   → (g)  gagne un constat de largeur  →           10 pass / 1 fail.
 * ⛔ Avant ce couple, LES DEUX mutations rendaient 9 pass / 0 fail : le banc était aveugle à la
 * garde, et toute la moitié « ce qui partira » du pré-vol n'était qu'affirmée. Les 9 tests
 * antérieurs restent d'ailleurs verts sous les deux mutations — c'est (g′)/(g) et rien d'autre qui
 * tient cette règle.
 */
describe("(g′)/(g) CTA d'article : c'est le libellé ENVOYÉ qui est jugé, pas le champ stocké", () => {
  test("(g′) lien vivant, champ vide : le défaut de langue est mesuré — et il déborde", async () => {
    const doc = docArticleCtaLiveHref();
    const report = await audit(doc);

    expect(report.counts).toEqual({ blocking: 0, advisory: 1 });
    // Un débordement de libellé n'interdit pas de publier : c'est laid, pas illégal.
    expect(report.canPublish).toBe(true);

    const finding = only(onBlock(report, "blk_article"));
    expect(finding.level).toBe("advisory");
    expect(finding.group).toBe("structure");
    // `"preflight"` : la géométrie n'est mesurable par personne d'autre — le compilateur ne connaît
    // pas la largeur de la colonne, et le schéma accepte ce libellé.
    expect(finding.source).toBe("preflight");

    // ⚠️ Le libellé attendu est RELU dans la table qui fait foi (`@nf/render/cta`), jamais recopié
    // ici : un `"Read more"` écrit en clair passerait encore le jour où le pré-vol se remettrait à
    // lire `block.ctaLabel` brut — c'est-à-dire `undefined` — ou changerait de table.
    expect(finding.message).toContain(defaultArticleCta(doc.meta.locale));

    // ⛔ AUCUN CORRECTIF, et c'est la règle : rogner un défaut de langue figerait « Read » dans le
    // document — un libellé qu'aucune table ne produit — et couperait le bloc de `@nf/render/cta`.
    // Un défaut qui déborde se répare en élargissant la colonne, pas en mutilant la traduction.
    expect(finding.fix).toBeUndefined();
  });

  test("(g) MÊME carte, lien mort : plus aucune ancre ne part, donc plus rien à mesurer", async () => {
    const report = await audit(docArticleCtaDeadHref());

    expect(report.counts).toEqual({ blocking: 0, advisory: 1 });
    expect(report.canPublish).toBe(true);

    // Le seul constat restant vient du COMPILATEUR et parle du « # » lui-même. Il ne dépend pas de
    // `goesNowhere` mais d'`isPlaceholderHref` : il sert ici de témoin, il doit rester allumé.
    const finding = only(onBlock(report, "blk_article"));
    expect(finding.group).toBe("links");
    expect(finding.source).toBe("compiler");

    // ⛔ L'ASSERTION CENTRALE : aucune règle de largeur ne s'est déclenchée. Le rendu ne fabrique
    // aucun libellé par-dessus ce href, `articleHtml` n'émet donc aucun `<a>` — prédire ici un
    // débordement, ce serait mesurer la mise en page d'un texte que personne ne reçoit, et envoyer
    // l'auteur raccourcir un libellé qui n'existe pas.
    expect(report.findings.filter((f) => f.group === "structure")).toHaveLength(0);
  });
});

describe("(f) trois footers légaux", () => {
  test("duplication signalée une seule fois, en consultatif", async () => {
    const report = await audit(docThreeFooters());

    expect(report.counts).toEqual({ blocking: 0, advisory: 1 });
    // ⚠️ Consultatif et non bloquant : trois footers font un email laid, pas un email illégal.
    // C'est l'ABSENCE de footer qui met l'envoi en veto, et ce n'est pas ce document.
    expect(report.canPublish).toBe(true);

    const finding = only(report.findings);
    expect(finding.group).toBe("structure");
    expect(finding.source).toBe("preflight");
    // Le constat porte sur le document entier : aucune cible cliquable, par construction.
    expect(finding.target).toBeUndefined();
  });
});

/**
 * POURQUOI CETTE SUITE EXISTE : elle documente la DIFFÉRENCE entre `runPreflight(doc)` et
 * `runPreflight(doc, faits)`. Cette différence est toujours là — elle a changé de NATURE, et c'est
 * tout l'objet du lot ; la prochaine personne doit lire ça avant de toucher un chiffre plus bas.
 *
 * ⛔ AVANT : sans les faits, le pré-vol sortait `blocking: 0` et `canPublish: true` sur un document
 * que `POST …/publish` refuse. Le verrou de publication s'ouvrait donc AVANT la première
 * compilation, et l'auteur lisait « publiable » sur un email qui repartait en 422. Ce `0` n'était
 * pas un contrat, c'était LE DÉFAUT — un écran vert qui laisse partir l'email.
 *
 * ⭐ MAINTENANT : la ligne de partage n'est plus le VERDICT mais la SOURCE du constat.
 *   • `source: "schema"` — les refus d'`EmailDocPublishable` se lisent sur le document seul et
 *     sortent dès le premier appel : le verdict est « refusé » avec ou sans compilateur ;
 *   • `source: "compiler"` — les avertissements de `collectWarnings()` restent absents tant que
 *     personne ne les a produits : le pré-vol les ingère, il ne sait pas les recalculer ;
 *   • `size` reste `null` sans les faits : on ne devine pas des octets.
 */
describe("CompiledFacts — ce que le pré-vol seul ne peut PAS voir", () => {
  test("sans les faits : les refus du SCHÉMA subsistent, les constats du COMPILATEUR sont absents", async () => {
    for (const make of [docInsecureAndPlaceholder, docArticleUntitledNoAlt, docImageNoAlt]) {
      const doc = make();
      const bare = runPreflight(doc);
      const full = await audit(doc);

      // ── Sens 1 : le verrou NE s'ouvre PAS avant la compilation. Le schéma a déjà refusé.
      const bareBlocking = bare.findings.filter((f) => f.level === "blocking");
      expect(bareBlocking.length).toBeGreaterThan(0);
      expect(bare.canPublish).toBe(false);
      // ⛔ Et ces bloquants viennent TOUS du schéma : si l'un d'eux affichait `source: "compiler"`,
      // c'est que le pré-vol aurait recopié une règle du compilateur au lieu de l'ingérer.
      expect(new Set(bareBlocking.map((f) => f.source))).toEqual(new Set(["schema"]));
      // On ne devine pas un poids sans avoir compilé.
      expect(bare.size).toBeNull();

      // ── Sens 2 : personne n'a produit les faits, donc aucun constat n'en vient…
      expect(bare.findings.filter((f) => f.source === "compiler")).toHaveLength(0);
      // …alors qu'avec les faits, il y en a. C'est cet écart qui prouve que le second argument
      // n'est pas décoratif — et qu'un banc qui l'oublie mesure un panneau à moitié rempli.
      expect(full.findings.filter((f) => f.source === "compiler").length).toBeGreaterThan(0);
      expect(full.canPublish).toBe(false);
      expect(full.size?.bytes).toBeGreaterThan(0);
    }
  });

  test("les constats du SCHÉMA et du pré-vol, eux, ne dépendent pas du compilateur", async () => {
    for (const make of [docFeedMinAboveCount, docThreeFooters]) {
      const doc = make();
      expect(runPreflight(doc).counts).toEqual((await audit(doc)).counts);
    }
  });
});


/**
 * LES E-MAILS DE CYCLE DE VIE — CE QUE LE BOUTON « PUBLISH » DOIT ANNONCER.
 *
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. `POST …/publish` contrôle TOUS les kinds servis par le
 * template (la clé est (asset_id, kind), rien n'interdit d'en servir deux) ; le pré-vol n'en
 * recevait qu'un — celui de plus petit indice dans LIFECYCLE_KINDS. Or `welcome` n'exige aucun
 * jeton : un template qui sert `welcome` ET `reengagement` s'affichait donc VERT, et le clic
 * rendait un 422 sur le `reengagement`, que l'écran venait de déclarer sain. Le pire sens de la
 * divergence : l'auteur n'a aucune raison de chercher le défaut là où on lui dit qu'il n'y en a pas.
 */
describe("cycle de vie — le pré-vol juge tous les kinds servis, pas le premier", () => {
  const faits = (html: string) => ({ sizeBytes: 1000, warnings: [], html });
  const cycle = (report: PreflightReport): PreflightFinding[] =>
    report.findings.filter((f) => f.id.startsWith("compliance:lifecycle:"));

  /**
   * ⛔ LE TEST CENTRAL. MUTATION QUI DOIT LE TUER : remplacer la boucle de `runPreflight` par
   * `const k = lifecycleKinds?.[0]` (le retour au « premier kind »).
   */
  test("welcome + reengagement : c'est le reengagement qui bloque, et il est vu", () => {
    const report = runPreflight(docImageNoAlt(), faits("<p>Nothing to click here.</p>"), [
      "welcome",
      "reengagement",
    ]);
    const constats = cycle(report);

    expect(constats).toHaveLength(1);
    expect(constats[0]?.id).toBe("compliance:lifecycle:reengagement");
    expect(constats[0]?.level).toBe("blocking");
    expect(constats[0]?.message).toContain("{{preferences_url}}");
    expect(report.canPublish).toBe(false);
  });

  test("deux kinds exigeants manquants font DEUX constats, jamais un seul fondu", () => {
    const constats = cycle(
      runPreflight(docImageNoAlt(), faits("<p>Nothing to click here.</p>"), [
        "confirmation",
        "reengagement",
      ]),
    );
    expect(constats.map((f) => f.id).sort()).toEqual([
      "compliance:lifecycle:confirmation",
      "compliance:lifecycle:reengagement",
    ]);
  });

  test("un template ordinaire n'est jamais concerné", () => {
    for (const kinds of [[], null, undefined]) {
      expect(cycle(runPreflight(docImageNoAlt(), faits("<p>Nothing to click here.</p>"), kinds))).toHaveLength(0);
    }
  });

  test("le jeton présent dans le HTML compilé suffit — c'est l'artefact que la publication juge", () => {
    const constats = cycle(
      runPreflight(docImageNoAlt(), faits('<a href="{{preferences_url}}">Keep receiving</a>'), [
        "reengagement",
      ]),
    );
    expect(constats).toHaveLength(0);
  });
});

/**
 * LE LIEN DE LECTURE D'UN ARTICLE A DEUX FORMES, ET ELLES N'OCCUPENT PAS LA MÊME PLACE.
 *
 * Depuis le 22/09/2026 (`COMPILER_VERSION` 1.4.0), `ctaStyle` absent ou `button` sort en BOUTON
 * plein — 22px de padding de chaque côté, taille `fontSize - 2` — et seul `ctaStyle:"link"` reste
 * un lien souligné à la taille du bloc, sans padding horizontal. Le pré-vol mesurait tout le monde
 * au gabarit du lien : il sous-estimait la largeur des boutons de 44px, c'est-à-dire qu'un libellé
 * qui déborde VRAIMENT pouvait ne faire rougir personne. C'est le seul endroit du dépôt où cette
 * géométrie est mesurée — le compilateur ne connaît pas la largeur de la colonne.
 */
describe("(k) la largeur jugee suit la FORME du lien de lecture, pas seulement son libelle", () => {
  /** Le nombre de pixels que le pré-vol annonce pour le libellé de `blk_article`. */
  const largeurAnnoncee = async (ctaStyle?: "button" | "link"): Promise<number> => {
    const doc = docArticleCtaLiveHref();
    const bloc = doc.rows[0]?.columns[0]?.blocks[0] as { ctaStyle?: string };
    if (ctaStyle !== undefined) bloc.ctaStyle = ctaStyle;
    const finding = only(onBlock(await audit(doc), "blk_article"));
    const px = /needs about (\d+)px/.exec(finding.message)?.[1];
    expect(px).toBeTruthy();
    return Number(px);
  };

  test("un bouton et un lien ne reclament PAS la meme largeur pour le meme libelle", async () => {
    // Le compte, à la main, sur « Read more » (9 caractères, corps 16 du thème de la fixture) :
    //   lien   = 9 × 16 × 0,58            = 84px  (aucun padding horizontal)
    //   bouton = 9 × 14 × 0,58 + 2 × 22px = 117px (corps réduit de 2, padding de `ctaTable`)
    // Soit +33px, et non +44 : les deux paddings du bouton coûtent 44px, sa police plus petite en
    // rend 11. Le chiffre est écrit ICI en dur — le relire dans le pré-vol ferait un banc qui se
    // compare à lui-même. ⚠️ Il dépend de la LONGUEUR du libellé : un libellé plus long rapproche
    // les deux estimations, et au-delà de ~38 caractères c'est le LIEN qui devient le plus large.
    expect(await largeurAnnoncee("link")).toBe(84);
    expect(await largeurAnnoncee(undefined)).toBe(117);
  });

  test("`ctaStyle` absent est jauge comme `button` — c'est le defaut du compilateur", async () => {
    expect(await largeurAnnoncee(undefined)).toBe(await largeurAnnoncee("button"));
  });
});

describe("(l) encart a mise en page : le contraste se juge sur la couleur PEINTE, le https couvre toutes les images", () => {
  const contrast = (report: PreflightReport) =>
    onBlock(report, "blk_callout").filter((f) => f.group === "contrast" && !f.message.startsWith("In dark mode"));

  test("un titre blanc sur l'aplat sombre ne declenche rien — il etait juge sur la couleur de texte du theme", async () => {
    // ⛔ Avant le 23/09 le titre se mesurait sur `r.textColor` (sombre), pas sur `titleColor` :
    // l'affiche blanche sur photo sortait en « contraste insuffisant » alors qu'elle est lisible.
    expect(contrast(await audit(docCalloutLayout({})))).toHaveLength(0);
  });

  test("un titre sombre sur l'aplat sombre est signale, et c'est le TITRE qui est cite", async () => {
    const finding = only(contrast(await audit(docCalloutLayout({ titleColor: "#1a1a1a" }))));
    expect(finding.message.startsWith("callout title is ")).toBe(true);
    expect(finding.detail?.startsWith("#1a1a1a on #101820")).toBe(true);
  });

  test("ticket : le corps est juge sur la SOUCHE, pas sur le fond du bloc", async () => {
    const finding = only(
      contrast(await audit(docCalloutLayout({ layout: "ticket", stubBackground: "#ffe600", stubTextColor: "#fefefe" }))),
    );
    expect(finding.message.startsWith("callout body is ")).toBe(true);
    expect(finding.detail?.startsWith("#fefefe on #ffe600")).toBe(true);
  });

  test("gelule : le surtitre est juge sur sa pastille", async () => {
    const finding = only(
      contrast(await audit(docCalloutLayout({ kickerStyle: "pill", kickerAccent: "#fefefe", kickerColor: "#f5f5f5" }))),
    );
    expect(finding.message.startsWith("callout kicker is ")).toBe(true);
    expect(finding.detail?.startsWith("#f5f5f5 on #fefefe")).toBe(true);
  });

  test("fond et galerie en http:// : un seul correctif, qui remplace la galerie ENTIERE", async () => {
    const report = await audit(
      docCalloutLayout({
        layout: "gallery",
        backgroundImage: "http://cdn.example.com/stadium.jpg",
        gallery: [
          { src: "https://cdn.example.com/1.jpg", alt: "One" },
          { src: "http://cdn.example.com/2.jpg", alt: "Two" },
        ],
      }),
    );
    const links = onBlock(report, "blk_callout").filter((f) => f.group === "links");
    expect(links).toHaveLength(2);
    const patch = links[0]?.fix?.patch as Record<string, unknown>;
    expect(patch.backgroundImage).toBe("https://cdn.example.com/stadium.jpg");
    expect(patch.gallery).toEqual([
      { src: "https://cdn.example.com/1.jpg", alt: "One" },
      { src: "https://cdn.example.com/2.jpg", alt: "Two" },
    ]);
    expect(links[1]?.fix?.label).toBe(links[0]?.fix?.label);
  });
});
