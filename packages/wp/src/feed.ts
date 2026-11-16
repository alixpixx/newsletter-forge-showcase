/**
 * ---------------------------------------------------------------------------
 * RÉSOLVEUR DE FLUX — quels articles partent ce soir, et POURQUOI pas les autres.
 * ---------------------------------------------------------------------------
 *
 * ⛔ UNE SEULE RÉSOLUTION, DEUX APPELANTS. L'admin l'appelle pour remplir l'APERÇU d'un bloc
 * `article-feed` ; le worker l'appelle 90 min avant l'échéance pour fabriquer ce qui part
 * vraiment. Deux implémentations divergeraient, et l'aperçu se mettrait à promettre des articles
 * que l'envoi ne choisit pas — le mensonge exact que le bloc flux existe pour tuer.
 *
 * ⛔ AUCUN ACCÈS RÉSEAU, AUCUNE BASE : tout entre par `FeedDeps`. Le chemin REST (`fetchPosts`) et
 * le chemin RSS (`fetchFeedPosts`) rendent le MÊME `WpCandidate` — donc un seul adaptateur couvre
 * les 8 sources, dont les 3 qui n'ont pas d'API REST (lumen-living, bluefin-news, pixel-daily). Et
 * l'anti-répétition, qui est une requête SQL, reste chez celui qui détient la base : ici on ne
 * fait que décider, et une décision se rejoue à l'identique dans un test.
 *
 * ⚠️ CE FICHIER N'IMPORTE PAS `@nf/render`. `FeedCandidate` a la forme du `FeedItem` du schéma
 * (structurellement assignable, champ pour champ) sans créer la dépendance : `@nf/wp` doit rester
 * chargeable dans le worker, dont l'invariant est de ne tirer ni Zod ni MJML dans le chemin
 * d'envoi.
 */
import { MAX_ARTICLES, MAX_POOL } from "./client";
import type { WpCandidate } from "./normalize";

const DAY_MS = 86_400_000;

/**
 * Marge de sur-demande couvrant ce qui est INUTILISABLE (titre ou lien manquant, doublon dans le
 * même lot). Petite : ces cas sont rares, mais ils existent sur les flux RSS où un `<item>` sans
 * `<link>` passe sans lever la moindre erreur.
 */
const OVERFETCH_UNUSABLE = 2;

/**
 * ⛔ Ces plafonds sont ceux du schéma (`FeedItem` / `ArticleBlock` dans `@nf/render`). On coupe
 * ICI plutôt que de laisser passer : un titre de 210 caractères fait échouer la validation du
 * document ENTIER au moment du gel, et l'occurrence meurt avec un message Zod qui désigne
 * `rows[2].columns[0].blocks[3].title`. Une manchette coupée est visible et réparable ; une
 * occurrence retenue pour cause d'erreur de schéma ne se répare pas depuis l'écran.
 */
const MAX_TITLE = 200;
const MAX_EXCERPT = 1000;
/**
 * ⛔ Même plafond que `FeedItem.imageAlt` / `ImageBlock.alt` (300). Depuis qu'on RECOPIE
 * l'`alt_text` de la médiathèque au lieu de le jeter, il entre du texte rédigé à la main, sans
 * limite côté WordPress. Un alt de 340 caractères ferait échouer la validation du document ENTIER
 * au gel — comme un titre trop long, mais pour une raison que personne n'irait chercher.
 */
const MAX_ALT = 300;
/** Même borne que `FeedItem.category` dans le schéma : au-delà, `EmailDoc.parse` refuserait. */
const MAX_CATEGORY = 80;

/** La REQUÊTE que porte un bloc `article-feed`, réduite à ce dont la décision a besoin. */
export interface FeedQuery {
  /** Id de la ligne `wp_source`. Le résolveur ne s'en sert pas : c'est l'adaptateur qui sait où aller chercher. */
  sourceId: string;
  /** Ids de catégories WordPress. Vide = toute la source. Sert à dire quel filtre élargir. */
  categories: number[];
  tags: number[];
  /** Combien de cartes on VEUT. */
  count: number;
  /** Plancher : en dessous, l'occurrence est retenue plutôt qu'envoyée maigre. */
  minCount: number;
  /** Fenêtre d'anti-répétition, en jours. ⛔ `0` DÉSACTIVE l'exclusion — on assume la répétition. */
  dedupeDays: number;
  /**
   * Nom lisible de ce qu'on cherche (noms de catégories, sinon libellé de la source).
   *
   * ⛔ Pas décoratif : la phrase d'échec est affichée TELLE QUELLE dans l'écran des occurrences,
   * loin du bloc qui l'a produite. Sans ce nom elle dirait « ce flux » et l'opérateur devrait
   * ouvrir le modèle pour savoir duquel des trois flux on parle.
   */
  label?: string;
  /**
   * `date` (défaut) : l'ordre de la source, les plus récents d'abord.
   * `views` : les plus vus sur la fenêtre de mesure de l'entrepôt.
   *
   * ⚠️ `views` n'est PAS « les plus lus du jour ». L'entrepôt s'arrête à J−2, donc les articles
   * publiés depuis 48 h n'ont aucune mesure — et ce sont justement les plus performants (mesuré le
   * 01/09/2026 sur copper-kettle : 97 vues moyennes à 1 jour d'exposition contre 32 à 7 jours, la
   * décroissance de l'attention l'emportant largement sur le cumul). Ce mode convient donc à un
   * récapitulatif périodique, jamais à une lettre quotidienne.
   *
   * `mixed` : la moitié la plus lue du passé mesurable, la moitié la plus récente des 48 h aveugles.
   * C'est la réponse au décalage ci-dessus — on ne le réduit pas, on le contourne. Les deux moitiés
   * couvrent des périodes **DISJOINTES** (avant `freshBoundary` / après), donc aucun doublon n'est
   * possible par construction : il n'y a pas de dédoublonnage à faire entre elles.
   */
  orderby?: "date" | "views" | "mixed";
  /**
   * La frontière UTC entre « mesurable » et « frais », telle que décidée par
   * `fenetreClassement().frontiereFraicheUtc`. **Exigée par le seul mode `mixed`.**
   *
   * ⛔ SON ABSENCE EST UN REFUS, JAMAIS UN CALCUL DE SECOURS. La déduire ici depuis `deps.now`
   * rouvrirait la divergence que `fenetreClassement` existe pour fermer : deux endroits décidant
   * la même borne finissent toujours par ne plus la décider pareil.
   *
   * ⛔ ET CE N'EST PAS `avant`. `avant` part dans `before` et WordPress l'interprète dans le
   * fuseau du SITE ; `FeedCandidate.publishedAt` vient de `date_gmt`, donc d'UTC. Comparer l'un à
   * l'autre décalerait la frontière de trois heures chez northwind-sports, et rangerait tout article publié
   * en soirée dans le mauvais seau.
   */
  freshBoundary?: string;
}

/**
 * Un article candidat, dans la forme exacte du `FeedItem` du schéma — pour que le worker le pose
 * dans le bloc sans re-mapper quoi que ce soit (un second mapping finit toujours par diverger).
 */
export interface FeedCandidate {
  postId: string;
  title: string;
  excerpt: string;
  href: string;
  imageSrc?: string;
  /**
   * L'`alt_text` de la médiathèque WordPress, TEL QUEL, ou la chaîne vide quand la source n'en
   * porte pas.
   *
   * ⛔ ON NE FABRIQUE RIEN ICI. Recopier le titre ferait annoncer deux fois la même phrase par un
   * lecteur d'écran, en se donnant l'air d'être accessible : vide côté WordPress ⇒ vide en sortie,
   * et une vignette collée à un titre-lien qui la nomme est de toute façon DÉCORATIVE (`alt=""`,
   * ce que WCAG demande). Mais jeter un `alt_text` que la rédaction a écrit n'a jamais été une
   * décision d'accessibilité — c'était une perte sèche, et le chemin d'import manuel
   * (`api/builder/wp/insert`) le conservait déjà. Les deux chemins traitent enfin ce champ pareil.
   */
  imageAlt: string;
  publishedAt?: string;
  /**
   * Nom lisible de la PREMIÈRE catégorie de l'article — « Noticias », « Destacadas ».
   *
   * ⛔ Absente quand WordPress n'en donne aucune, et RIEN ne la remplace alors : les maquettes
   * Copper Kettle et Northwind Sports affichent deux catégories différentes selon l'article, donc c'est une
   * donnée. Un libellé de repli serait indiscernable d'une vraie catégorie, et se retrouverait
   * dans la boîte du lecteur sans que personne puisse le corriger.
   *
   * ⚠️ La PREMIÈRE, faute de mieux : WordPress ne dit pas laquelle est principale, et l'ordre
   * d'`_embedded` est celui des ids. Un article multi-catégories affichera donc la plus ancienne
   * de ses catégories — arbitraire, mais VRAI, ce qu'un choix inventé ne serait pas.
   */
  category?: string;
}

export interface FeedDeps {
  /**
   * Va chercher chez la source, au plus `limit` articles, les plus récents d'abord.
   *
   * ⚠️ Si la source est injoignable, cette fonction DOIT lever. Un rejet réseau et un flux trop
   * maigre appellent deux gestes différents (réessayer / republier) : les confondre en un verdict
   * `ok:false` ferait afficher « publiez davantage » le soir où c'est le site qui est tombé.
   *
   * `query` est fourni en second argument pour l'adaptateur qui en a besoin ; une fonction d'arité
   * 1 satisfait ce type sans rien changer.
   */
  fetch: (limit: number, query: FeedQuery) => Promise<FeedCandidate[]>;
  /**
   * Parmi ces liens, ceux qui sont DÉJÀ partis depuis `sinceIso`.
   *
   * ⛔ Appelée seulement si `dedupeDays > 0` : l'appeler pour ignorer sa réponse serait un aller
   * simple vers une exclusion qu'on croit désarmée mais qui coûte quand même une requête.
   */
  alreadySent: (hrefs: string[], sinceIso: string) => Promise<Set<string>>;
  /**
   * Les vues de ces liens sur la fenêtre de mesure. Un lien **absent** de la carte n'a pas été
   * mesuré — ce n'est pas un zéro, et les deux ne se rangent pas au même endroit.
   *
   * ⛔ Optionnelle, et son absence est un REFUS, jamais un repli. Demander `orderby: "views"` sans
   * pouvoir lire les vues et servir malgré tout les plus récents rendrait un bloc qui annonce un
   * classement et en produit un autre — le lecteur n'aurait aucun moyen de s'en apercevoir.
   */
  views?: (hrefs: string[]) => Promise<Map<string, number>>;
  /**
   * L'instant de la résolution. Injecté, jamais `new Date()` : toutes les cartes d'une même
   * occurrence doivent porter le MÊME `fetchedAt`, sinon le bandeau de fraîcheur d'un email se
   * contredit d'un bloc à l'autre. Et une décision qui lit l'horloge ne se rejoue pas dans un test.
   */
  now: Date;
}

/**
 * Ce que le mode `mixed` a RÉELLEMENT composé.
 *
 * ⛔ LES QUATRE CHIFFRES, PAS DEUX. Rendre seulement `mostViewed`/`latest` laisserait l'écran
 * incapable de distinguer « 3 + 2, comme prévu » de « 5 + 0 parce que le site n'a rien publié
 * depuis deux jours » : deux lettres identiques à l'affichage, deux situations qui n'appellent pas
 * le même geste. Le voulu accompagne donc l'obtenu, et l'écart se lit sans arithmétique.
 */
export interface FeedComposition {
  /** Cartes retenues pour leur audience (seau mesurable, publiées avant la frontière). */
  mostViewed: number;
  /** Cartes retenues pour leur fraîcheur (seau des 48 h que l'entrepôt ne sait pas encore mesurer). */
  latest: number;
  /** La moitié visée côté audience — `Math.ceil(count / 2)`, l'arrondi va aux plus lus. */
  wantedMostViewed: number;
  /** La moitié visée côté fraîcheur. `mostViewed`/`latest` s'en écartent quand l'un a comblé l'autre. */
  wantedLatest: number;
}

export type FeedVerdict =
  | {
      ok: true;
      items: FeedCandidate[];
      /**
       * Candidats REFUSÉS : déjà envoyés, inutilisables, ou en double dans le lot. ⚠️ Le surplus
       * coupé par `count` n'en fait pas partie — ce n'est pas un refus, c'est la requête servie.
       */
      dropped: number;
      /** ISO 8601, dérivé de `deps.now`. Devient le `fetchedAt` des cartes produites. */
      fetchedAt: string;
      /**
       * Présente **uniquement** en mode `mixed` : d'où viennent les cartes rendues.
       *
       * ⚠️ Absente ailleurs, et c'est voulu — un `{mostViewed: 0, latest: 5}` rendu par un bloc en
       * mode `date` serait un chiffre juste répondant à une question que personne n'a posée.
       */
      composition?: FeedComposition;
    }
  | { ok: false; reason: string; found: number; kept: number };

/**
 * Combien demander à la source pour espérer garder `count` articles.
 *
 * ⛔ ON DEMANDE PLUS QUE `count`. Demander exactement `count` garantit de tomber sous le plancher
 * dès la DEUXIÈME échéance : l'anti-répétition retire ce qui est déjà parti, et il ne reste rien
 * pour combler. La marge vaut `count` de plus quand la fenêtre est armée — de quoi absorber une
 * échéance entière de répétition — plus deux pour les articles inutilisables.
 *
 * ⚠️ En mode `date`, plafonné à `MAX_ARTICLES` parce que `fetchPosts` y ramènerait le `limit` de
 * toute façon : annoncer une limite que la couche du dessous ne sert pas serait un chiffre faux
 * dans un journal.
 *
 * ⛔ EN MODE `views`, LA RÈGLE S'INVERSE : le pool n'est plus « ce qu'on veut rendre, plus une
 * marge », c'est « tout ce que la fenêtre contient ». Classer les douze derniers articles et
 * appeler ça « les plus lus des sept derniers jours » serait vrai sur le classement et faux sur la
 * fenêtre — chez northwind-sports, douze articles couvrent cinq heures de publication, pas sept jours. Ce
 * sont les bornes de date (`after`/`before`) qui délimitent alors le pool ; `MAX_POOL` n'est qu'un
 * garde-fou de volume, et une troncature à ce plafond est rapportée, jamais tue.
 */
export function feedFetchLimit(query: FeedQuery): number {
  // ⚠️ Même règle en mode `mixed`, et pour une raison de PLUS : le pool doit couvrir la fenêtre
  // mesurable ET la zone fraîche. Deux moitiés à remplir dans deux périodes disjointes ne se
  // servent pas d'un pool taillé pour une seule.
  if (query.orderby === "views" || query.orderby === "mixed") return MAX_POOL;
  const count = Math.max(1, Math.trunc(query.count));
  const margin = query.dedupeDays > 0 ? count + OVERFETCH_UNUSABLE : OVERFETCH_UNUSABLE;
  return Math.min(MAX_ARTICLES, count + margin);
}

/**
 * `WpCandidate` (REST comme RSS) → candidat de flux. Le mapping vit ICI, en un seul endroit :
 * l'admin et le worker qui l'écriraient chacun de leur côté finiraient par ne pas poser la même
 * `publishedAt`, et le bandeau de provenance ne saurait plus lire la moitié des blocs.
 */
export function toFeedCandidate(c: WpCandidate): FeedCandidate {
  return {
    postId: c.id,
    title: c.title,
    excerpt: c.excerpt,
    href: c.permalink,
    // `null` = pas d'image. La propriété est OMISE plutôt que posée à vide : le schéma la veut
    // absente ou non vide, et `imageSrc: ""` ferait rendre une balise `<img src="">`.
    ...(c.imageUrl ? { imageSrc: c.imageUrl } : {}),
    // ⚠️ On lit `c.imageAlt` au lieu de poser `""` en dur : le chemin REST demande `_embed`
    // (`fetchPosts`), donc l'`alt_text` est DÉJÀ dans la réponse — le jeter ne faisait économiser
    // aucune requête, ça ne faisait que perdre la seule description honnête qu'on ait de l'image.
    imageAlt: c.imageAlt,
    ...(c.publishedAt ? { publishedAt: c.publishedAt } : {}),
    // Omise plutôt que vide : le schéma la veut absente ou non vide, et une chaîne vide ferait
    // émettre un surtitre creux au-dessus du titre.
    ...(c.categoryNames[0] ? { category: c.categoryNames[0] } : {}),
  };
}

const clip = (v: string, max: number): string =>
  v.length <= max ? v : `${v.slice(0, max - 1).trimEnd()}…`;

/**
 * Ramène un candidat aux bornes du schéma. ⛔ EXPORTÉE PARCE QU'ELLE A DEUX APPELANTS : `resolveFeed`
 * l'applique à sa sélection, et l'enrichissement qui suit un classement par vues doit l'appliquer
 * de nouveau — il REMPLACE l'extrait, l'`alt` et la catégorie par ceux de la réponse complète, qui
 * n'ont jamais été bornés. Sans cela un extrait de 1 200 caractères repasserait sous le radar et
 * ferait échouer la validation du document ENTIER au gel, avec un message Zod désignant
 * `rows[2].columns[0].blocks[3].excerpt`.
 */
export function borner(c: FeedCandidate): FeedCandidate {
  return {
    ...c,
    title: clip(c.title.trim(), MAX_TITLE),
    excerpt: clip(c.excerpt.trim(), MAX_EXCERPT),
    // Borné comme le titre et l'extrait, jamais écrasé : cf. `FeedCandidate.imageAlt`. Ce `.trim()`
    // n'est pas décoratif — un alt fait d'un seul espace passe le `!== ""` du schéma tout en étant
    // muet pour un lecteur d'écran, donc pire qu'un vide qui, lui, se voit.
    imageAlt: clip(c.imageAlt.trim(), MAX_ALT),
    // On ne la repose QUE si elle existe, sinon on écrirait `category: undefined` — une clé
    // présente, que le schéma strict distingue d'une clé absente.
    ...(c.category === undefined ? {} : { category: clip(c.category.trim(), MAX_CATEGORY) }),
  };
}

/** « a, b or c » — la phrase d'échec est lue par un humain, pas parsée. */
function serial(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  const last = parts[parts.length - 1] ?? "";
  const head = parts.slice(0, -1).join(", ");
  return parts.length === 2 ? `${head} or ${last}` : `${head}, or ${last}`;
}

/**
 * La phrase montrée à l'opérateur dans l'écran des occurrences.
 *
 * ⛔ Elle doit TENIR DEBOUT TOUTE SEULE : elle apparaît à côté d'une occurrence retenue, sans le
 * bloc ni la source sous les yeux. Donc elle nomme le flux, dit les deux nombres (ce qu'on a
 * trouvé, ce qu'il faut), dit ce qui a mangé la différence, et nomme les gestes qui la réparent.
 */
function shortfallReason(
  query: FeedQuery,
  floor: number,
  found: number,
  kept: number,
  unusable: number,
  duplicated: number,
  repeated: number,
): string {
  const where = query.label ? `in ${query.label}` : "in this feed";
  const head =
    kept === 0 ? `no fresh articles ${where}` : kept === 1 ? `only 1 fresh article ${where}` : `only ${kept} fresh articles ${where}`;

  const why: string[] = [];
  if (repeated > 0) why.push(`${repeated} of the ${found} found went out in the last ${query.dedupeDays} days`);
  if (unusable > 0) why.push(`${unusable} of the ${found} found had no title or link`);
  if (duplicated > 0) why.push(`${duplicated} of the ${found} found was the same article twice`);
  const detail = why.length > 0 ? ` (${why.join("; ")})` : "";

  const fixes = ["publish more"];
  if (query.categories.length > 0 || query.tags.length > 0) fixes.push("widen the category and tag filters");
  if (repeated > 0) fixes.push("shorten the anti-repeat window");
  fixes.push("lower the minimum");

  return `${head}${detail}, the feed needs at least ${floor} — ${serial(fixes)}.`;
}

/**
 * Recolle les médias sur les articles RETENUS, après un classement fait sur un pool léger.
 *
 * ⛔ POURQUOI CETTE FONCTION EXISTE : classer par vues oblige à récolter toute la fenêtre, et toute
 * la fenêtre avec `_embed` pèse 6,3 Mo pour cent articles chez northwind-sports (mesuré le 03/09) — le garde
 * la refuse, et le site met huit secondes à la produire. On classe donc sur un pool sans médias,
 * puis on ne paie `_embed` que sur la douzaine d'articles qui partent.
 *
 * ⛔ ELLE NE FAIT AUCUN RÉSEAU. L'appelant va chercher `frais` (`fetchPostsByIds`) et le passe ici :
 * la règle d'appariement reste rejouable dans un test, comme tout le reste de ce fichier.
 *
 * ⚠️ Un article introuvable dans `frais` GARDE sa version légère — donc sans vignette. C'est le bon
 * défaut : une carte sans image est visiblement pauvre, là où une image reprise d'un autre article
 * serait plausible et fausse.
 */
export function enrichir(items: FeedCandidate[], frais: FeedCandidate[]): FeedCandidate[] {
  const parId = new Map(frais.map((c) => [c.postId, c]));
  return items.map((item) => {
    const f = parId.get(item.postId);
    if (!f) return item;
    return borner({
      ...item,
      // ⚠️ Seuls les champs que le pool léger ne pouvait PAS porter. Reprendre aussi le titre ou le
      // lien ferait dépendre le résultat de deux réponses du site au lieu d'une, et une correction
      // éditoriale survenue entre les deux appels changerait l'article sous le classement.
      ...(f.imageSrc ? { imageSrc: f.imageSrc } : {}),
      imageAlt: f.imageAlt,
      ...(f.category === undefined ? {} : { category: f.category }),
    });
  });
}

/**
 * Décide quels articles composent un bloc flux à cet instant.
 *
 * L'ordre des opérations n'est pas négociable : on écarte d'abord ce qui ne peut pas faire une
 * carte, puis les doublons du lot, puis ce qui est déjà parti — et on ne coupe à `count` qu'à la
 * toute fin. Couper avant filtrerait des articles valides pour garder des refusés.
 */
export async function resolveFeed(query: FeedQuery, deps: FeedDeps): Promise<FeedVerdict> {
  const count = Math.max(1, Math.trunc(query.count));
  /**
   * ⚠️ Le schéma laisse `minCount` monter au-dessus de `count` (deux champs 1..12 indépendants).
   * Un plancher plus haut que la cible ne peut JAMAIS être atteint : l'occurrence serait retenue
   * à chaque échéance avec une phrase que personne ne peut satisfaire. On le ramène à `count` —
   * le bloc se comporte alors comme il est écrit : « donne-m'en 3, au moins 3 ».
   */
  const floor = Math.min(Math.max(1, Math.trunc(query.minCount)), count);

  const raw = await deps.fetch(feedFetchLimit(query), query);
  const found = raw.length;

  // Un article sans titre ou sans lien ne peut pas faire une carte cliquable. Il est ÉCARTÉ, et
  // compté comme tel : « écarté » et « absent » n'amènent pas l'opérateur au même geste.
  const usable = raw.filter((c) => c.title.trim().length > 0 && c.href.trim().length > 0);
  const unusable = found - usable.length;

  // Le même lien deux fois dans un lot (flux RSS republiant une entrée, article dans deux
  // catégories demandées) donnerait deux cartes identiques dans l'email. On garde la première.
  const seen = new Set<string>();
  const unique = usable.filter((c) => {
    if (seen.has(c.href)) return false;
    seen.add(c.href);
    return true;
  });
  const duplicated = usable.length - unique.length;

  let fresh = unique;
  if (query.dedupeDays > 0) {
    const sinceIso = new Date(deps.now.getTime() - query.dedupeDays * DAY_MS).toISOString();
    const sent = await deps.alreadySent(
      unique.map((c) => c.href),
      sinceIso,
    );
    fresh = unique.filter((c) => !sent.has(c.href));
  }
  const repeated = unique.length - fresh.length;

  const kept = Math.min(fresh.length, count);
  if (kept < floor) {
    return { ok: false, reason: shortfallReason(query, floor, found, fresh.length, unusable, duplicated, repeated), found, kept: fresh.length };
  }

  /**
   * L'ordre de sélection.
   *
   * Par défaut la source rend déjà les plus récents d'abord : on garde les `count` premiers SANS
   * retrier. Un tri local sur `publishedAt` mettrait en tête les articles dont la date est illisible
   * (les flux RSS en produisent), c'est-à-dire les plus douteux.
   */
  let ranked = fresh;
  let composition: FeedComposition | undefined;
  if (query.orderby === "views") {
    // ⛔ PAS DE REPLI SILENCIEUX. Sans lecteur de vues, on ne sert pas « les plus récents » sous
    // l'étiquette « les plus vus » : on refuse, et on nomme la cause.
    if (!deps.views) {
      return {
        ok: false,
        reason: `${query.label ? `${query.label} is` : "this feed is"} set to rank by views, but no analytics source is wired for this brand — pick an analytics property in the settings, or switch the block back to ordering by date.`,
        found,
        kept: fresh.length,
      };
    }

    const views = await deps.views(fresh.map((c) => c.href));

    /**
     * ⛔ LE REFUS QUI DÉCOULE DE LA MESURE. L'entrepôt s'arrête à J−2 et ces sites publient 42 à 53
     * articles par jour : un pool de candidats frais peut être ENTIÈREMENT postérieur à la fenêtre
     * mesurée. Mesuré en production le 01/09/2026 : 0 article sur 8 apparié par défaut, 8 sur 8 pour
     * des articles antérieurs de cinq jours. Trier ce pool-là par vues rendrait l'ordre de la
     * source, sous une étiquette qui promet autre chose. On exige donc d'avoir AU MOINS le plancher
     * en articles réellement mesurés.
     */
    const measured = fresh.filter((c) => views.has(c.href));
    if (measured.length < floor) {
      const manquants = fresh.length - measured.length;
      return {
        ok: false,
        reason: `only ${measured.length} of the ${fresh.length} fresh articles ${query.label ? `in ${query.label}` : "in this feed"} have view counts yet, the feed needs at least ${floor} to rank by views (${manquants} were published too recently — analytics lags by two days) — send later, widen the article window, or switch the block back to ordering by date.`,
        found,
        kept: measured.length,
      };
    }

    // ⚠️ Les non-mesurés descendent SOUS les mesurés à zéro, comme à l'import : « pas de mesure » et
    // « lu par personne » ne sont pas le même fait. `-1` est hors du domaine d'un compteur de vues.
    const vues = (c: FeedCandidate) => views.get(c.href) ?? -1;
    ranked = [...fresh].sort((a, b) => vues(b) - vues(a));
  } else if (query.orderby === "mixed") {
    // ⛔ Même exigence qu'en mode `views` : la moitié « les plus lus » ne se sert pas avec de la
    // fraîcheur déguisée. Sans lecteur de vues, il n'y a pas de moitié à composer.
    if (!deps.views) {
      return {
        ok: false,
        reason: `${query.label ? `${query.label} is` : "this feed is"} set to mix most viewed with latest, but no analytics source is wired for this brand — pick an analytics property in the settings, or switch the block back to ordering by date.`,
        found,
        kept: fresh.length,
      };
    }

    /**
     * ⛔ LA FRONTIÈRE VIENT DE L'APPELANT, ON NE LA RECALCULE PAS. `fenetreClassement` est la seule
     * à décider les bornes de ce chantier ; la déduire une seconde fois ici depuis `deps.now`
     * rouvrirait exactement la divergence qu'elle existe pour fermer. Illisible ou absente, c'est
     * un défaut de câblage de l'application — et la phrase le dit, pour que personne n'aille
     * chercher la panne dans le modèle.
     */
    const frontiereMs = query.freshBoundary ? Date.parse(query.freshBoundary) : Number.NaN;
    if (!Number.isFinite(frontiereMs)) {
      return {
        ok: false,
        reason: `${query.label ? `${query.label} is` : "this feed is"} set to mix most viewed with latest, but the app did not pass a usable analytics cut-off date — this is a wiring bug in the app, not something to change in the template.`,
        found,
        kept: fresh.length,
      };
    }

    const views = await deps.views(fresh.map((c) => c.href));
    const vues = (c: FeedCandidate) => views.get(c.href) ?? -1;

    /**
     * Les deux seaux, départagés par la DATE DE PUBLICATION.
     *
     * ⚠️ Un article dont la date est absente ou illisible (les flux RSS en produisent) n'entre PAS
     * dans les frais : on ne peut pas prouver sa fraîcheur, et une moitié « les derniers » ne vaut
     * que si elle l'est. Il reste candidat au seau mesurable, où l'absence de mesure l'écartera de
     * toute façon — le doute ne devient jamais un argument de vente.
     */
    const estFrais = (c: FeedCandidate) => {
      const t = c.publishedAt ? Date.parse(c.publishedAt) : Number.NaN;
      return Number.isFinite(t) && t > frontiereMs;
    };
    const zoneFraiche = fresh.filter(estFrais);
    const zoneMesurable = fresh.filter((c) => !estFrais(c));

    // ⛔ SEULS LES ARTICLES RÉELLEMENT MESURÉS composent la moitié « les plus lus ». Y glisser un
    // non-mesuré rendrait l'ordre de la source sous une étiquette de popularité — le mensonge
    // précis que le mode `views` refuse déjà quelques lignes plus haut.
    const parVues = zoneMesurable.filter((c) => views.has(c.href)).sort((a, b) => vues(b) - vues(a));
    const parDate = [...zoneFraiche].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));

    /**
     * ⭐ L'ARRONDI IMPAIR VA AUX PLUS LUS (arbitrage d'Alix, 03/09/2026). Sur cinq cartes : trois
     * choisies pour leur audience, deux pour leur fraîcheur. C'est la moitié qui porte la valeur
     * éditoriale ; les récentes comblent l'angle mort de 48 h, elles ne le remplacent pas.
     */
    const voulusVues = Math.ceil(count / 2);
    const voulusFrais = count - voulusVues;

    /**
     * ⭐ UNE MOITIÉ TROP COURTE EST COMBLÉE PAR L'AUTRE, ET LE CHIFFRE LE DIT (arbitrage d'Alix).
     * Une source à l'arrêt — atlas-review n'a rien publié depuis le 21/08, soit zéro article dans
     * la zone fraîche — amputerait sinon la lettre de la moitié de ses cartes en silence.
     *
     * ⚠️ Ça diverge de l'arbitrage du 01/09 (« pas assez de mesurés ⇒ envoyer moins »), qui visait
     * le cas où AUCUNE carte n'était légitime. Ici les deux seaux le sont ; seule leur proportion
     * bouge, et `composition` la rend.
     *
     * ⚠️ Aucun dédoublonnage entre les deux seaux : ils couvrent des périodes DISJOINTES (avant la
     * frontière / après), donc un même article ne peut pas être dans les deux. Ajouter un `Set`
     * « au cas où » ferait croire à un risque que la construction a déjà supprimé.
     */
    const teteVues = parVues.slice(0, voulusVues);
    const teteFrais = parDate.slice(0, voulusFrais);
    const complementFrais = parDate.slice(voulusFrais, voulusFrais + Math.max(0, voulusVues - teteVues.length));
    const complementVues = parVues.slice(voulusVues, voulusVues + Math.max(0, voulusFrais - teteFrais.length));

    const choix = [...teteVues, ...complementVues, ...teteFrais, ...complementFrais];

    /**
     * Le plancher se juge sur ce que la composition a RÉELLEMENT pu réunir, pas sur `fresh`.
     * Un pool de dix articles tous publiés depuis 48 h et tous non mesurés donne dix candidats
     * frais et zéro carte mesurable : `fresh.length` dirait « dix », la lettre n'en aurait que cinq.
     */
    if (choix.length < floor) {
      return {
        ok: false,
        reason: `${query.label ? `${query.label} can` : "this feed can"} only fill ${choix.length} of its ${count} cards right now (${parVues.length} article${parVues.length === 1 ? "" : "s"} with view counts, ${parDate.length} published in the last two days), and it needs at least ${floor} — send later, widen the article window, or switch the block back to ordering by date.`,
        found,
        kept: choix.length,
      };
    }

    composition = {
      mostViewed: teteVues.length + complementVues.length,
      latest: teteFrais.length + complementFrais.length,
      wantedMostViewed: voulusVues,
      wantedLatest: voulusFrais,
    };
    ranked = choix;
  }

  /**
   * ⛔ SÉLECTIONNER PAR VUES, PUIS AFFICHER EN ANTÉCHRONOLOGIQUE. La première carte (`leadCount`)
   * est un emplacement éditorial : y mettre mécaniquement l'article le plus vu de la semaine y
   * installe l'evergreen, et la lettre s'ouvre sur une information que l'abonné a déjà lue. On
   * choisit donc sur la popularité, on présente sur la fraîcheur.
   *
   * ⚠️ EN MODE `mixed`, LA CONSÉQUENCE EST PARTICULIÈRE ET ASSUMÉE : les deux seaux couvrant des
   * périodes disjointes, la moitié fraîche est TOUJOURS entièrement au-dessus de la moitié
   * mesurée. La lettre s'ouvre donc sur l'article le plus récent — ce qui est exactement le but,
   * un abonné hebdomadaire ne l'a pas encore vu — et les plus lus forment la seconde partie.
   * Remonter le plus lu en tête réinstallerait l'evergreen que la règle ci-dessus écarte ; couper
   * en deux sections demanderait un intertitre que le bloc ne sait pas rendre.
   */
  let selection = ranked.slice(0, count);
  if (query.orderby === "views" || query.orderby === "mixed") {
    selection = [...selection].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  }

  const items = selection.map(borner);

  return {
    ok: true,
    items,
    dropped: unusable + duplicated + repeated,
    fetchedAt: deps.now.toISOString(),
    ...(composition ? { composition } : {}),
  };
}

const HOUR_MS = 3_600_000;

/**
 * Âge au-delà duquel un bloc « les derniers » sert des articles qui ne sont plus des nouvelles.
 *
 * ⛔ POURQUOI 24 H, ET POURQUOI CE N'EST QU'UN AVERTISSEMENT. Le 25/09/2026, deux campagnes de test
 * Northwind Sports ont envoyé les 7 MÊMES articles à trois heures d'écart : le bloc filtrait sur les catégories
 * 7101 et 12087, où le site avait cessé de ranger ses articles (0 sur 19 depuis 00:32 UTC). Trié par
 * date, il a servi toute la journée des articles vieux de 12 à 15 h sans le moindre signal. Ces sites
 * publient 42 à 53 articles par jour : une journée entière sans un seul article neuf dans le filtre
 * n'est plus un creux éditorial, c'est un filtre mort. Alix a demandé un AVERTISSEMENT et pas une
 * rétention — une lettre sur un site légitimement calme doit continuer de partir.
 *
 * La borne est STRICTE : pile 24 h ne déclenche rien, 24 h et une milliseconde déclenche.
 */
export const STALE_FEED_HOURS = 24;

/** Ce que l'aperçu affiche et ce que le journal du gel consigne pour un bloc « les derniers » périmé. */
export interface StaleFeedWarning {
  /** Phrase lue par l'auteur dans l'inspecteur (l'admin est en anglais) : l'âge mesuré ET la cause probable. */
  message: string;
  /** Âge de l'article le plus récent, en heures ENTIÈRES (arrondi vers le bas) — le même chiffre que la phrase. */
  ageHours: number;
  /** La date de publication de cet article, telle que la source l'a rendue. */
  newestPublishedAt: string;
}

/**
 * L'article le plus récent d'un bloc « les derniers » a-t-il plus de `STALE_FEED_HOURS` à l'instant
 * `now` ? Rend l'avertissement, sinon `null`. Fonction PURE : `now` est injecté, jamais lu sur
 * l'horloge, pour que l'aperçu, le gel et les tests jugent le même instant.
 *
 * ⛔ SEUL LE MODE SERVI `date` EST JUGÉ — `orderby` est le mode SERVI, pas le mode demandé (une
 * quotidienne réglée sur `mixed` part en `date`, et c'est bien un bloc « les derniers » alors).
 *  - `views` : la récolte s'arrête à J−2 (`fenetreClassement().avant`) parce que l'entrepôt ne mesure
 *    rien de plus frais. L'article le plus récent y a donc TOUJOURS plus de 48 h, par construction :
 *    l'avertissement sonnerait à chaque aperçu et à chaque gel, et un signal qui sonne toujours
 *    n'avertit plus de rien.
 *  - `mixed` : la moitié « les plus lus » est bornée de la même façon (avant la frontière des 48 h),
 *    et la moitié « les derniers » est déjà rapportée par `FeedComposition` (`latest` contre
 *    `wantedLatest`), affichée dans l'inspecteur et journalisée au gel. Juger ici l'âge du plus récent
 *    confondrait un effet de construction avec la panne : avec `count: 1`, `wantedLatest` vaut 0 et,
 *    dès qu'un article mesuré existe, la seule carte est antérieure aux 48 h — sur un site en
 *    parfaite santé.
 *
 * ⚠️ Aucun article, ou aucune date lisible (des flux RSS en produisent) ⇒ `null`. Le flux vide est
 * traité par un autre chemin (`shortfallReason`), et une date qu'on ne sait pas lire ne prouve pas
 * qu'un article est vieux — on n'invente pas un âge.
 */
export function staleFeedWarning(
  orderby: FeedQuery["orderby"],
  items: readonly Pick<FeedCandidate, "publishedAt">[],
  now: Date,
): StaleFeedWarning | null {
  if ((orderby ?? "date") !== "date") return null;

  let newestMs = Number.NEGATIVE_INFINITY;
  let newestPublishedAt: string | null = null;
  for (const item of items) {
    const t = item.publishedAt ? Date.parse(item.publishedAt) : Number.NaN;
    if (Number.isFinite(t) && t > newestMs) {
      newestMs = t;
      newestPublishedAt = item.publishedAt ?? null;
    }
  }
  if (newestPublishedAt === null) return null;

  const ageMs = now.getTime() - newestMs;
  if (ageMs <= STALE_FEED_HOURS * HOUR_MS) return null;

  const ageHours = Math.floor(ageMs / HOUR_MS);
  return {
    message: `The newest article is ${ageHours} h old — this feed may be filtered on categories the site no longer uses.`,
    ageHours,
    newestPublishedAt,
  };
}
