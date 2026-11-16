/**
 * BANC DE `resolveFeed` — la fonction qui décide QUELS articles partent dans un email.
 *
 * Elle n'en avait aucun jusqu'ici, alors qu'elle est le dernier point où une lettre peut encore
 * être retenue plutôt qu'envoyée fausse. Ce banc couvre le tri par vues, ajouté le 01/09/2026, et
 * surtout les trois façons dont ce tri pourrait MENTIR sans lever la moindre erreur :
 *
 *  1. classer par vues sans lecteur de vues, et servir l'ordre de la source sous cette étiquette ;
 *  2. classer un pool dont AUCUN article n'est mesuré — ce qui, mesuré en production, est le cas
 *     par défaut : l'entrepôt s'arrête à J−2 et ces sites publient 42 à 53 articles par jour ;
 *  3. présenter le résultat par popularité, ce qui installe l'evergreen en tête de lettre.
 */
import { describe, expect, test } from "bun:test";
import { enrichir, feedFetchLimit, resolveFeed, type FeedCandidate, type FeedDeps, type FeedQuery } from "./feed";
import { MAX_ARTICLES, MAX_POOL } from "./client";

const NOW = new Date("2026-09-01T12:00:00Z");

function article(n: number, jour: number): FeedCandidate {
  return {
    postId: String(n),
    title: `Article ${n}`,
    excerpt: `Extrait ${n}`,
    href: `https://x.cl/a${n}/`,
    imageAlt: "",
    publishedAt: `2026-08-${String(jour).padStart(2, "0")}T08:00:00Z`,
  };
}

function requete(p: Partial<FeedQuery> = {}): FeedQuery {
  return { sourceId: "s1", categories: [], tags: [], count: 3, minCount: 2, dedupeDays: 0, ...p };
}

function deps(candidats: FeedCandidate[], vues?: Map<string, number>): FeedDeps {
  return {
    fetch: async () => candidats,
    alreadySent: async () => new Set<string>(),
    ...(vues ? { views: async () => vues } : {}),
    now: NOW,
  };
}

/**
 * ⛔ LA TAILLE DU POOL EST CE QUI REND L'ÉTIQUETTE VRAIE OU FAUSSE. Classer par vues sur la marge
 * du mode `date` (une douzaine d'articles) reviendrait à classer cinq heures de publication chez
 * northwind-sports, qui en publie 52,9 par jour — sous une étiquette qui promet une période. Le tri serait
 * exact, la fenêtre mensongère, et rien ne le dirait.
 */
describe("feedFetchLimit — le pool suit le mode, pas l'inverse", () => {
  test("en mode `date`, la marge reste petite et bornée au rendu", () => {
    // 3 voulus + 3 de marge d'anti-répétition + 2 d'inutilisables.
    expect(feedFetchLimit(requete({ count: 3, dedupeDays: 14 }))).toBe(8);
    // Sans anti-répétition, la marge tombe à deux.
    expect(feedFetchLimit(requete({ count: 3, dedupeDays: 0 }))).toBe(5);
    // Et jamais au-delà de ce qu'un email peut porter.
    expect(feedFetchLimit(requete({ count: 12, dedupeDays: 14 }))).toBe(MAX_ARTICLES);
  });

  test("en mode `views`, on demande la fenêtre entière", () => {
    expect(feedFetchLimit(requete({ count: 3, dedupeDays: 14, orderby: "views" }))).toBe(MAX_POOL);
    // ⛔ TÉMOIN : le pool ne doit dépendre NI de `count` NI de l'anti-répétition — sinon un bloc
    // réglé sur 3 articles classerait une fenêtre plus étroite qu'un bloc réglé sur 10, alors que
    // les deux annoncent la même période.
    expect(feedFetchLimit(requete({ count: 10, dedupeDays: 0, orderby: "views" }))).toBe(MAX_POOL);
  });

  test("témoin — le mode `views` demande bien plus que le mode `date`", () => {
    const parDate = feedFetchLimit(requete({ count: 5, dedupeDays: 14 }));
    const parVues = feedFetchLimit(requete({ count: 5, dedupeDays: 14, orderby: "views" }));
    expect(parVues > parDate).toBe(true);
  });
});

/**
 * ⛔ CE QUI SE JOUE ICI : le pool d'un classement par vues est récolté SANS médias (une page de
 * cent articles avec `_embed` pèse 6,3 Mo chez northwind-sports, mesuré le 03/09). Les vignettes sont
 * recollées après la sélection. Cette couture est exactement l'endroit où un article pourrait
 * hériter de l'image d'un autre — plausible, faux, et invisible à la relecture.
 */
describe("enrichir — recoller les médias sans changer les articles", () => {
  const leger = (n: number): FeedCandidate => ({
    postId: String(n),
    title: `Article ${n}`,
    excerpt: `Extrait ${n}`,
    href: `https://x.cl/a${n}/`,
    imageAlt: "",
    publishedAt: "2026-08-30T08:00:00Z",
  });

  test("pose l'image, l'alt et la catégorie du BON article", () => {
    const items = [leger(1), leger(2)];
    const frais: FeedCandidate[] = [
      { ...leger(2), imageSrc: "https://x.cl/i2.jpg", imageAlt: "Deux", category: "Fútbol" },
      { ...leger(1), imageSrc: "https://x.cl/i1.jpg", imageAlt: "Un", category: "Tenis" },
    ];
    // ⛔ TÉMOIN : `frais` est rendu DANS LE DÉSORDRE. Un appariement par position au lieu de l'id
    // donnerait à l'article 1 l'image de l'article 2 — deux vraies images, la mauvaise sur chacun.
    const r = enrichir(items, frais);

    expect(r.map((i) => i.postId)).toEqual(["1", "2"]);
    expect(r[0]?.imageSrc).toBe("https://x.cl/i1.jpg");
    expect(r[0]?.category).toBe("Tenis");
    expect(r[1]?.imageSrc).toBe("https://x.cl/i2.jpg");
    expect(r[1]?.imageAlt).toBe("Deux");
  });

  test("un article introuvable garde sa version légère, sans image", () => {
    // Article dépublié entre les deux appels. Mieux vaut une carte sans vignette qu'une vignette
    // empruntée : la première se voit, la seconde se croit.
    const r = enrichir([leger(1), leger(9)], [{ ...leger(1), imageSrc: "https://x.cl/i1.jpg", imageAlt: "Un" }]);
    expect(r[1]?.imageSrc).toBe(undefined);
    expect(r[1]?.imageAlt).toBe("");
    expect(r[1]?.href).toBe("https://x.cl/a9/");
  });

  test("ne touche NI au titre NI au lien, même si la seconde réponse diffère", () => {
    // Une correction éditoriale survenue entre les deux appels changerait l'article sous le
    // classement : ce qui a été choisi doit rester ce qui part.
    const r = enrichir(
      [leger(1)],
      [{ ...leger(1), title: "Titre réécrit", href: "https://x.cl/autre/", imageSrc: "https://x.cl/i1.jpg", imageAlt: "Un" }],
    );
    expect(r[0]?.title).toBe("Article 1");
    expect(r[0]?.href).toBe("https://x.cl/a1/");
  });

  test("les bornes du schéma sont RÉAPPLIQUÉES après enrichissement", () => {
    // ⛔ Sans cela, un `alt_text` de 340 caractères écrit à la main dans la médiathèque ferait
    // échouer la validation du document ENTIER au gel — l'occurrence mourrait sur un message Zod.
    const r = enrichir([leger(1)], [{ ...leger(1), imageAlt: "a".repeat(400), category: "c".repeat(120) }]);
    expect(r[0]?.imageAlt.length).toBe(300);
    expect(r[0]?.category?.length).toBe(80);
  });

  test("témoin — sans articles frais, rien ne change", () => {
    const items = [leger(1), leger(2)];
    expect(enrichir(items, [])).toEqual(items);
  });
});

describe("resolveFeed — l'ordre par défaut reste celui de la source", () => {
  test("témoin — sans `orderby`, les articles sortent dans l'ordre reçu", async () => {
    const pool = [article(1, 30), article(2, 29), article(3, 28), article(4, 27)];
    const v = await resolveFeed(requete(), deps(pool));

    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("succès attendu");
    expect(v.items.map((i) => i.postId)).toEqual(["1", "2", "3"]);
  });

  test("un lecteur de vues fourni mais NON demandé ne change rien", async () => {
    // Sinon brancher l'analytics modifierait en silence des lettres qui n'ont rien demandé.
    const pool = [article(1, 30), article(2, 29), article(3, 28)];
    const vues = new Map([["https://x.cl/a3/", 9999]]);
    const v = await resolveFeed(requete(), deps(pool, vues));

    if (!v.ok) throw new Error("succès attendu");
    expect(v.items.map((i) => i.postId)).toEqual(["1", "2", "3"]);
  });
});

describe("resolveFeed — `orderby: views` ne ment jamais sur ce qu'il classe", () => {
  test("sans lecteur de vues, c'est un REFUS — pas un repli sur l'ordre de la source", async () => {
    const pool = [article(1, 30), article(2, 29), article(3, 28)];
    const v = await resolveFeed(requete({ orderby: "views", label: "Destacadas" }), deps(pool));

    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("refus attendu");
    expect(v.reason).toContain("no analytics source is wired");
    expect(v.reason).toContain("Destacadas");
  });

  /**
   * LE CAS QUI SE PRODUIT VRAIMENT. Mesuré en production le 01/09/2026 sur copper-kettle : les
   * 8 articles servis par défaut sont appariés 0 fois sur 8, parce qu'ils sont tous postérieurs à
   * la borne haute de l'entrepôt. Sans ce refus, le bloc rendrait l'ordre de la source sous
   * l'étiquette « les plus vus », et rien dans la lettre ne le signalerait.
   */
  test("un pool dont AUCUN article n'est mesuré est un refus qui dit pourquoi", async () => {
    const pool = [article(1, 31), article(2, 31), article(3, 31), article(4, 31)];
    const v = await resolveFeed(requete({ orderby: "views" }), deps(pool, new Map()));

    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("refus attendu");
    expect(v.reason).toContain("analytics lags by two days");
    expect(v.reason).toContain("0 of the 4");
    expect(v.kept).toBe(0);
  });

  test("mesurés en nombre insuffisant : refus aussi, avec le compte exact", async () => {
    const pool = [article(1, 30), article(2, 29), article(3, 28), article(4, 27)];
    // Un seul mesuré, le plancher est à 2.
    const v = await resolveFeed(requete({ orderby: "views" }), deps(pool, new Map([["https://x.cl/a1/", 500]])));

    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("refus attendu");
    expect(v.reason).toContain("1 of the 4");
    expect(v.kept).toBe(1);
  });

  // TÉMOIN : sans lui, les trois refus ci-dessus passeraient sur une fonction qui refuse TOUJOURS.
  test("témoin — assez d'articles mesurés : le tri a bien lieu, sur les vues", async () => {
    const pool = [article(1, 30), article(2, 29), article(3, 28), article(4, 27)];
    const vues = new Map([
      ["https://x.cl/a1/", 10],
      ["https://x.cl/a2/", 900],
      ["https://x.cl/a3/", 50],
      ["https://x.cl/a4/", 400],
    ]);
    const v = await resolveFeed(requete({ orderby: "views" }), deps(pool, vues));

    if (!v.ok) throw new Error("succès attendu");
    // Les trois plus vus sont a2 (900), a4 (400) et a3 (50) — a1 (10) est écarté.
    expect(v.items.map((i) => i.postId).sort()).toEqual(["2", "3", "4"]);
    expect(v.items.map((i) => i.postId)).not.toContain("1");
  });

  test("un article NON mesuré passe sous un article mesuré à zéro", async () => {
    // « Pas de mesure » et « lu par personne » ne sont pas le même fait : le second est une mesure.
    //
    // ⛔ L'ARTICLE NON MESURÉ EST EN TÊTE DU POOL, ET C'EST TOUT L'INTÉRÊT DU TEST. Placé en
    // dernier, il resterait dernier même si le code traitait « non mesuré » comme un zéro : le tri
    // est stable, donc la mutation `?? -1` → `?? 0` passerait sans faire rougir personne. Placé en
    // tête, il n'est relégué que si le code le range VRAIMENT sous les zéros. (Ce test ne prouvait
    // rien dans sa première version ; c'est une passe de mutation qui l'a montré.)
    const nonMesure = article(9, 31);
    const pool = [nonMesure, article(1, 30), article(2, 29)];
    const vues = new Map([
      ["https://x.cl/a1/", 0],
      ["https://x.cl/a2/", 0],
      // a9 : absent de la carte, donc jamais mesuré.
    ]);
    const v = await resolveFeed(requete({ count: 2, minCount: 2, orderby: "views" }), deps(pool, vues));

    if (!v.ok) throw new Error("succès attendu");
    expect(v.items.map((i) => i.postId).sort()).toEqual(["1", "2"]);
    expect(v.items.map((i) => i.postId)).not.toContain("9");
  });
});

describe("resolveFeed — on choisit sur la popularité, on présente sur la fraîcheur", () => {
  /**
   * La première carte est un emplacement éditorial (`leadCount`). Présenter par popularité y
   * installerait l'evergreen : la lettre s'ouvrirait sur ce que l'abonné a déjà lu.
   */
  test("la sélection se fait par vues, l'affichage en antéchronologique", async () => {
    const pool = [article(1, 30), article(2, 29), article(3, 25)];
    const vues = new Map([
      ["https://x.cl/a1/", 10], // le plus récent, le moins vu
      ["https://x.cl/a2/", 50],
      ["https://x.cl/a3/", 900], // le plus vu, mais vieux de six jours
    ]);
    const v = await resolveFeed(requete({ count: 3, minCount: 2, orderby: "views" }), deps(pool, vues));

    if (!v.ok) throw new Error("succès attendu");
    // Les trois sont retenus ; l'ORDRE rendu est celui des dates, pas celui des vues.
    expect(v.items.map((i) => i.postId)).toEqual(["1", "2", "3"]);
    // Contre-épreuve : l'ordre par vues aurait donné exactement l'inverse.
    expect(v.items.map((i) => i.postId)).not.toEqual(["3", "2", "1"]);
  });

  test("une date manquante ne remonte pas en tête", async () => {
    // Les flux RSS produisent des dates illisibles ; les laisser trier ferait ouvrir la lettre sur
    // l'article dont on sait le moins de choses.
    const sansDate: FeedCandidate = { ...article(9, 30), publishedAt: undefined };
    const pool = [sansDate, article(1, 30), article(2, 29)];
    const vues = new Map([
      ["https://x.cl/a9/", 999],
      ["https://x.cl/a1/", 500],
      ["https://x.cl/a2/", 400],
    ]);
    const v = await resolveFeed(requete({ count: 3, minCount: 2, orderby: "views" }), deps(pool, vues));

    if (!v.ok) throw new Error("succès attendu");
    expect(v.items[0]!.postId).not.toBe("9");
    expect(v.items[v.items.length - 1]!.postId).toBe("9");
  });
});

describe("resolveFeed — le tri par vues ne désarme aucune règle existante", () => {
  test("l'anti-répétition s'applique AVANT le classement", async () => {
    // Arbitrage d'Alix : le dedup gagne sur la popularité. Un article déjà envoyé ne repart pas,
    // même s'il est le plus vu de la semaine.
    const pool = [article(1, 30), article(2, 29), article(3, 28)];
    const vues = new Map([
      ["https://x.cl/a1/", 9999],
      ["https://x.cl/a2/", 50],
      ["https://x.cl/a3/", 40],
    ]);
    const d: FeedDeps = {
      fetch: async () => pool,
      alreadySent: async () => new Set(["https://x.cl/a1/"]),
      views: async () => vues,
      now: NOW,
    };
    const v = await resolveFeed(requete({ count: 2, minCount: 2, dedupeDays: 14, orderby: "views" }), d);

    if (!v.ok) throw new Error("succès attendu");
    expect(v.items.map((i) => i.postId).sort()).toEqual(["2", "3"]);
    expect(v.dropped).toBe(1);
  });

  test("le plancher reste ramené à `count`, tri par vues ou non", async () => {
    // Un plancher plus haut que la cible ne peut jamais être atteint : il retiendrait l'occurrence
    // à chaque échéance avec une phrase que personne ne peut satisfaire.
    const pool = [article(1, 30), article(2, 29)];
    const vues = new Map([
      ["https://x.cl/a1/", 10],
      ["https://x.cl/a2/", 20],
    ]);
    const v = await resolveFeed(requete({ count: 2, minCount: 12, orderby: "views" }), deps(pool, vues));

    expect(v.ok).toBe(true);
  });
});

/**
 * BANC DU MODE `mixed` — moitié plus lus, moitié plus récents.
 *
 * ⛔ CE QUI SE JOUE ICI : l'entrepôt d'audience s'arrête à J−2, donc les articles des 48 dernières
 * heures n'ont AUCUNE mesure — et ce sont les plus performants (97 vues moyennes à un jour
 * d'exposition contre 32 à sept, mesuré le 01/09/2026). Le mode `mixed` compose donc la lettre à
 * partir de DEUX périodes disjointes. Les trois façons dont il pourrait mentir sans lever d'erreur :
 *
 *  1. ranger un article frais dans la moitié « les plus lus » — un ordre de source sous une
 *     étiquette de popularité, exactement ce que le mode `views` refuse ;
 *  2. laisser une moitié vide sans le dire, et livrer une lettre à demi remplie qui a l'air entière ;
 *  3. donner l'arrondi impair à la mauvaise moitié, ce qui ne se voit sur aucune capture d'écran.
 */
describe("resolveFeed — mode `mixed`", () => {
  /**
   * ⚠️ TÉMOIN DE FORMAT. Cette valeur est ce que rend `fenetreClassement(NOW).frontiereFraicheUtc`
   * (`@nf/analytics/article-views`) : la fin de J−2, en UTC, avec le `Z` — parce qu'on la compare à
   * des `publishedAt` issus de `date_gmt`. ⛔ Ce n'est PAS `avant`, qui part dans `before` et que
   * WordPress lit dans le fuseau du site. Le banc ne peut pas importer la fonction (packages/wp ne
   * dépend pas de packages/analytics) : l'alignement des deux se prouve chez l'appelant.
   *
   * ✅ VÉRIFIÉ le 03/09/2026 en exécutant la vraie fonction pour ce même `NOW` :
   * `fenetreClassement(new Date("2026-09-01T12:00:00Z"), 7)` rend
   * `{apres: "2026-08-23T23:59:59", avant: "2026-08-30T23:59:59",
   *   fraisAvant: "2026-09-01T12:00:00", frontiereFraicheUtc: "2026-08-30T23:59:59Z"}`.
   * La constante ci-dessous n'est donc pas une valeur plausible recopiée à la main — c'est la
   * sortie mesurée du producteur.
   */
  const FRONTIERE = "2026-08-30T23:59:59Z";

  function post(n: number, publishedAt?: string): FeedCandidate {
    return {
      postId: String(n),
      title: `Article ${n}`,
      excerpt: `Extrait ${n}`,
      href: `https://x.cl/a${n}/`,
      imageAlt: "",
      ...(publishedAt ? { publishedAt } : {}),
    };
  }
  /** Zone MESURABLE : publié avant la frontière, donc l'entrepôt a eu le temps de le compter. */
  const mesurable = (n: number, jour: number) => post(n, `2026-08-${jour}T08:00:00Z`);
  /** Zone FRAÎCHE : publié après la frontière, donc aucune mesure possible — c'est le trou de 48 h. */
  const frais = (n: number, heure: string) => post(n, `2026-08-31T${heure}:00:00Z`);

  const mixte = (p: Partial<FeedQuery> = {}) =>
    requete({ orderby: "mixed", freshBoundary: FRONTIERE, count: 5, minCount: 1, ...p });

  test("le pool couvre la fenêtre entière, comme en mode `views`", () => {
    expect(feedFetchLimit(mixte({ count: 3, dedupeDays: 14 }))).toBe(MAX_POOL);
  });

  /**
   * ⭐ L'ARBITRAGE D'ALIX : sur cinq cartes, trois plus lues et deux plus récentes.
   * MUTATION QUI DOIT TUER CE TEST : `Math.ceil(count / 2)` → `Math.floor(count / 2)`.
   */
  test("l'arrondi impair va aux plus lus, pas aux récents", async () => {
    const candidats = [
      mesurable(1, 25),
      mesurable(2, 26),
      mesurable(3, 27),
      mesurable(4, 28),
      frais(5, "10"),
      frais(6, "11"),
      frais(7, "12"),
    ];
    const vues = new Map([
      ["https://x.cl/a1/", 10],
      ["https://x.cl/a2/", 90],
      ["https://x.cl/a3/", 50],
      ["https://x.cl/a4/", 70],
    ]);
    const v = await resolveFeed(mixte({ count: 5 }), deps(candidats, vues));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.composition).toEqual({ mostViewed: 3, latest: 2, wantedMostViewed: 3, wantedLatest: 2 });
    expect(v.items.length).toBe(5);
  });

  /**
   * ⛔ LE CŒUR DU MODE : chaque moitié vient de SA période. Un seau échangé rendrait exactement le
   * même nombre de cartes, avec la même composition affichée, et un contenu faux.
   * MUTATION QUI DOIT TUER CE TEST : échanger `parVues` et `parDate` dans les deux `slice`.
   */
  test("les plus lus viennent du passé mesurable, les récents de la zone aveugle", async () => {
    const candidats = [
      mesurable(1, 25), // 10 vues
      mesurable(2, 26), // 90 vues → le plus lu
      mesurable(3, 27), // 50 vues
      frais(4, "10"),
      frais(5, "20"), // le plus récent
    ];
    const vues = new Map([
      ["https://x.cl/a1/", 10],
      ["https://x.cl/a2/", 90],
      ["https://x.cl/a3/", 50],
    ]);
    const v = await resolveFeed(mixte({ count: 4 }), deps(candidats, vues));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // 4 cartes ⇒ 2 plus lues + 2 plus récentes.
    expect(v.composition).toEqual({ mostViewed: 2, latest: 2, wantedMostViewed: 2, wantedLatest: 2 });
    const liens = v.items.map((i) => i.href);
    // Les deux plus lus du seau mesurable : 90 et 50 vues — PAS celui à 10.
    expect(liens).toContain("https://x.cl/a2/");
    expect(liens).toContain("https://x.cl/a3/");
    expect(liens).not.toContain("https://x.cl/a1/");
    // Et les deux frais, entiers.
    expect(liens).toContain("https://x.cl/a4/");
    expect(liens).toContain("https://x.cl/a5/");
  });

  /**
   * ⛔ LA DISJONCTION EST CE QUI REND LE DÉDOUBLONNAGE INUTILE. Si elle tombe, un article
   * apparaîtrait dans les deux moitiés — deux cartes identiques dans le même email.
   * MUTATION QUI DOIT TUER CE TEST : bâtir `zoneMesurable` sur `fresh` au lieu de `!estFrais`.
   */
  test("aucun article ne peut être dans les deux moitiés", async () => {
    const candidats = [mesurable(1, 25), mesurable(2, 26), frais(3, "10"), frais(4, "20")];
    const vues = new Map([
      ["https://x.cl/a1/", 10],
      ["https://x.cl/a2/", 90],
      ["https://x.cl/a3/", 999], // ⚠️ mesuré ALORS QU'IL EST FRAIS : la date tranche, pas la mesure.
      ["https://x.cl/a4/", 999],
    ]);
    const v = await resolveFeed(mixte({ count: 4 }), deps(candidats, vues));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const liens = v.items.map((i) => i.href);
    expect(new Set(liens).size).toBe(liens.length);
    expect(v.composition).toEqual({ mostViewed: 2, latest: 2, wantedMostViewed: 2, wantedLatest: 2 });
  });

  /**
   * ⭐ LE CAS RÉEL : atlas-review n'a rien publié depuis le 21/08. La zone fraîche est VIDE.
   * La lettre part quand même complète, et le chiffre dit d'où viennent les cartes.
   */
  test("zone fraîche vide — les plus lus comblent, et la composition le dit", async () => {
    const candidats = [mesurable(1, 24), mesurable(2, 25), mesurable(3, 26), mesurable(4, 27)];
    const vues = new Map([
      ["https://x.cl/a1/", 10],
      ["https://x.cl/a2/", 90],
      ["https://x.cl/a3/", 50],
      ["https://x.cl/a4/", 70],
    ]);
    const v = await resolveFeed(mixte({ count: 4 }), deps(candidats, vues));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.items.length).toBe(4);
    // ⛔ L'écart entre voulu et obtenu est ce que l'écran doit pouvoir montrer.
    expect(v.composition).toEqual({ mostViewed: 4, latest: 0, wantedMostViewed: 2, wantedLatest: 2 });
  });

  test("aucun article mesuré — les récents comblent, et la composition le dit", async () => {
    const candidats = [frais(1, "08"), frais(2, "10"), frais(3, "12"), frais(4, "14")];
    const v = await resolveFeed(mixte({ count: 4 }), deps(candidats, new Map()));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.composition).toEqual({ mostViewed: 0, latest: 4, wantedMostViewed: 2, wantedLatest: 2 });
  });

  /**
   * ⛔ UN NON-MESURÉ NE MONTE JAMAIS DANS LA MOITIÉ « LES PLUS LUS ». Il peut servir de récent s'il
   * est frais ; sinon il ne sert à rien, et c'est le bon défaut.
   * MUTATION QUI DOIT TUER CE TEST : retirer le `.filter((c) => views.has(c.href))` de `parVues`.
   */
  test("un article ancien sans mesure ne compte pas comme « le plus lu »", async () => {
    const candidats = [mesurable(1, 25), mesurable(2, 26), frais(3, "10"), frais(4, "20")];
    const vues = new Map([["https://x.cl/a1/", 10]]); // a2 : ancien ET jamais mesuré.
    const v = await resolveFeed(mixte({ count: 4 }), deps(candidats, vues));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.items.map((i) => i.href)).not.toContain("https://x.cl/a2/");
    expect(v.composition).toEqual({ mostViewed: 1, latest: 2, wantedMostViewed: 2, wantedLatest: 2 });
  });

  /**
   * ⚠️ Les flux RSS produisent des dates illisibles. « Je ne sais pas quand » ne devient pas
   * « publié à l'instant » : la moitié fraîche ne vaut que si elle l'est réellement.
   */
  test("une date absente ou illisible ne fabrique pas de la fraîcheur", async () => {
    const candidats = [post(1), post(2, "pas une date"), frais(3, "10")];
    const v = await resolveFeed(mixte({ count: 4, minCount: 1 }), deps(candidats, new Map()));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // Ni mesurés ni frais : les deux sans date sortent, seul le vrai frais reste.
    expect(v.items.map((i) => i.href)).toEqual(["https://x.cl/a3/"]);
    expect(v.composition).toEqual({ mostViewed: 0, latest: 1, wantedMostViewed: 2, wantedLatest: 2 });
  });

  /** ⛔ Pas de repli silencieux : sans lecteur de vues, il n'y a pas de moitié à composer. */
  test("sans lecteur de vues, on refuse au lieu de servir les plus récents", async () => {
    const v = await resolveFeed(mixte({ label: "Lakeside" }), deps([mesurable(1, 25), frais(2, "10")]));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("Lakeside");
    expect(v.reason).toContain("no analytics source is wired");
  });

  /**
   * ⛔ LA FRONTIÈRE NE SE RECALCULE PAS ICI. Sans elle, tous les articles tomberaient du même côté
   * et le mode rendrait un classement par vues déguisé — juste sur le tri, faux sur l'étiquette.
   * MUTATION QUI DOIT TUER CE TEST : déduire la frontière de `deps.now` quand elle manque.
   */
  test("sans frontière transmise, on refuse et on nomme un défaut de câblage", async () => {
    const vues = new Map([["https://x.cl/a1/", 10]]);
    const sans = await resolveFeed(
      requete({ orderby: "mixed", count: 4, minCount: 1 }),
      deps([mesurable(1, 25), frais(2, "10")], vues),
    );
    expect(sans.ok).toBe(false);
    if (sans.ok) return;
    expect(sans.reason).toContain("wiring bug");

    const illisible = await resolveFeed(
      requete({ orderby: "mixed", count: 4, minCount: 1, freshBoundary: "hier soir" }),
      deps([mesurable(1, 25), frais(2, "10")], vues),
    );
    expect(illisible.ok).toBe(false);
  });

  /**
   * ⛔ LE PLANCHER SE JUGE SUR LA COMPOSITION, PAS SUR LE POOL. Sept candidats retenus par
   * l'anti-répétition peuvent ne donner que deux cartes plaçables.
   * MUTATION QUI DOIT TUER CE TEST : comparer `fresh.length` à `floor` au lieu de `choix.length`.
   */
  test("le refus compte les cartes réellement plaçables, pas les candidats", async () => {
    const candidats = [
      ...[24, 25, 26, 27, 28, 29, 30].map((j) => mesurable(j, j)), // anciens, AUCUN mesuré
      frais(1, "10"),
      frais(2, "20"),
    ];
    const v = await resolveFeed(mixte({ count: 6, minCount: 5 }), deps(candidats, new Map()));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.kept).toBe(2);
    expect(v.reason).toContain("only fill 2 of its 6 cards");
  });

  /**
   * ⛔ ON CHOISIT SUR DEUX CRITÈRES, ON PRÉSENTE SUR UN SEUL : la fraîcheur.
   * MUTATION QUI DOIT TUER CE TEST : retirer `|| query.orderby === "mixed"` du tri final.
   */
  test("la présentation reste antéchronologique", async () => {
    const candidats = [
      mesurable(1, 25), // 10 vues
      mesurable(2, 26), // 90 vues → premier CHOISI, jamais premier AFFICHÉ
      frais(3, "10"),
      frais(4, "20"), // le plus récent → doit ouvrir la lettre
    ];
    const vues = new Map([
      ["https://x.cl/a1/", 10],
      ["https://x.cl/a2/", 90],
    ]);
    const v = await resolveFeed(mixte({ count: 4 }), deps(candidats, vues));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.items.map((i) => i.href)).toEqual([
      "https://x.cl/a4/",
      "https://x.cl/a3/",
      "https://x.cl/a2/",
      "https://x.cl/a1/",
    ]);
  });

  /** ⚠️ Un chiffre juste répondant à une question que personne n'a posée reste un chiffre de trop. */
  test("`composition` n'existe QUE dans le mode qui compose", async () => {
    const candidats = [mesurable(1, 25), mesurable(2, 26), frais(3, "10")];
    const vues = new Map([
      ["https://x.cl/a1/", 10],
      ["https://x.cl/a2/", 90],
      ["https://x.cl/a3/", 50],
    ]);
    const parDate = await resolveFeed(requete({ count: 3, minCount: 1 }), deps(candidats, vues));
    expect(parDate.ok).toBe(true);
    const parVues = await resolveFeed(requete({ count: 3, minCount: 1, orderby: "views" }), deps(candidats, vues));
    expect(parVues.ok).toBe(true);
    if (!parDate.ok || !parVues.ok) return;
    expect(parDate.composition).toBe(undefined);
    expect(parVues.composition).toBe(undefined);
  });
});
