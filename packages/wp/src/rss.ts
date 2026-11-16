import {
  WP_TIMEOUT_MS,
  WpFetchError,
  authHeader,
  safeFetchBytes,
  type SafeResponse,
  type WpAuth,
} from "./guard";
import { MAX_ARTICLES, type ProbeResult, type WpCapabilities } from "./client";
import { cleanExcerpt, decodeEntities, stripHtml, type WpCandidate } from "./normalize";

/**
 * LECTEUR RSS — le tiers du parc que l'API REST ne rend pas lisible.
 *
 * POURQUOI CE FICHIER EXISTE. La sonde du 20/08 a rangé les 9 domaines en quatre familles ; deux
 * marques — `lumen-living.example` et `bluefin-news.example` — répondent 404 sur `/wp-json`. Sans lecteur de flux,
 * un tiers du parc reste invisible pour l'assistant d'insertion, et la collègue continue de copier
 * des titres à la main pour ces deux marques-là.
 *
 * ⛔ INVARIANT QUI COMMANDE TOUT LE RESTE : **la sortie est un `WpCandidate`, exactement celui du
 * chemin REST**. Pas un cousin, pas un sur-ensemble. Deux formes de sortie, ce serait deux façons
 * de composer une newsletter : `insert/route.ts` réhéberge `imageUrl` et pose `source.publishedAt`,
 * et le bandeau de provenance/fraîcheur lit ces champs-là. Un second format le rendrait aveugle sur
 * la moitié des blocs — donc incapable de dire « ces articles datent de quand ? » au moment où
 * cette question décide d'un envoi.
 *
 * ⛔ ET UNE SEULE PORTE SORTANTE : tout part de `safeFetchBytes` (guard.ts). Aucun `fetch` nu ici.
 * L'URL du flux vient de la base, donc d'un champ texte : c'est exactement le cas que la garde
 * anti-SSRF existe pour couvrir, et elle vaut sur l'admin qui détient la clé `service_role` et la
 * PII de 1 200 abonnés. Écrire une seconde garde « juste pour le RSS » serait en écrire une moins
 * bonne, et personne ne saurait plus laquelle protège quoi.
 *
 * CE QU'UN FLUX NE DONNE PAS, ET QU'ON REFUSE D'INVENTER (mesuré le 25/08 sur les deux vrais sites) :
 *
 *  · **Pas d'ids de taxonomie.** lumen-living n'a aucune balise `<category>`. Rendre `categoryIds: []`
 *    sans le dire se lirait « ce site n'a pas de catégories » — un mensonge sur un site de presse.
 *    D'où `hasCategories` dans `RssFeedInfo` : l'écran doit dire « ce flux ne porte pas de
 *    catégories », pas afficher un sélecteur vide.
 *
 *  · **Des dates de formats variés.** lumen-living sert du RFC 822 propre
 *    (`Tue, 25 Aug 2026 14:38:00 -0300`) ; bluefin-news.example sert `2026-08-25 14:39:30`, **sans le moindre
 *    fuseau**. Une date illisible rend `publishedAt: null` et vaut PÉRIMÉ — le doute tombe du côté
 *    qui retient l'envoi (cf. `filterFreshness`).
 *
 *  · **Un résumé, pas l'article.** bluefin-news.example met une accroche d'un mot dans `<description>`
 *    (« NOSTALGIA », « ECONOMIA »). C'est ce que l'auteur verra dans la carte : `fullContent`
 *    l'annonce plutôt que de laisser croire à un extrait tronqué par nous.
 */

/* ------------------------------------------------------------------ *
 * Budgets
 * ------------------------------------------------------------------ */

/**
 * Budget de temps pour TOUTE la découverte du flux, pas par tentative.
 *
 * La découverte enchaîne jusqu'à cinq requêtes vers un site qu'on ne contrôle pas. Un budget par
 * tentative les multiplierait : cinq fois dix secondes, c'est une fonction serverless qui meurt
 * sans rien dire à l'opérateur. Ici l'échec arrive AVANT le couperet de la plateforme, avec une
 * phrase qui nomme le geste à faire.
 */
export const RSS_DISCOVERY_BUDGET_MS = 12_000;

/** Plafond par tentative, dans la limite du budget restant. */
const RSS_ATTEMPT_MS = 6_000;

/**
 * Chemins conventionnels, dans l'ordre de leur probabilité RÉELLE.
 *
 * `/feed` d'abord parce que c'est le défaut WordPress et que c'est ce qui sert bluefin-news.example. Les
 * suivants couvrent les CMS maison. ⚠️ `?feed=rss2` n'est atteignable que par cette liste : une
 * racine stockée en base passe par `normalizeRestRoot`, qui SUPPRIME la query — un site dont le
 * seul flux est en query string ne peut donc pas être saisi tel quel, il faut le découvrir ici.
 */
const FEED_PATHS = ["/feed", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/?feed=rss2"];

/** Au-delà, on ne cherche plus un flux : on scanne un site. */
const MAX_FEED_ATTEMPTS = 5;

/* ------------------------------------------------------------------ *
 * Forme produite
 * ------------------------------------------------------------------ */

/**
 * Ce que le flux a VRAIMENT donné — les chiffres que l'écran doit montrer pour ne pas laisser
 * croire qu'un flux vaut une API REST.
 *
 * ⛔ Aucun de ces champs n'est décoratif : chacun corrige une phrase que l'écran dirait de travers
 * s'il ne l'avait pas.
 */
export interface RssFeedInfo {
  /** URL réellement lue — souvent PAS celle saisie (découverte ou redirection). À afficher. */
  feedUrl: string;
  format: "rss" | "atom";
  /** Titre du canal, jamais celui du premier article : cf. `sliceChannelHead`. */
  title: string | null;
  /** Entrées présentes dans le flux, AVANT filtre de fraîcheur et avant le plafond `limit`. */
  itemsInFeed: number;
  /**
   * Le flux porte-t-il des catégories exploitables ? ⛔ `false` ne veut pas dire « ce site n'a pas
   * de catégories » : il veut dire « ce flux ne les transporte pas ». La nuance décide de ce que
   * l'écran affiche — une explication, ou un sélecteur vide qui ressemble à une panne.
   */
  hasCategories: boolean;
  /** `content:encoded` présent : l'extrait vient de l'article. Sinon c'est un résumé du flux. */
  fullContent: boolean;
  /** Entrées dont la date est ILLISIBLE. Elles comptent comme périmées, jamais comme fraîches. */
  undatedItems: number;
  /**
   * Entrées datées SANS fuseau (mesuré sur bluefin-news.example). Lues comme UTC, faute de mieux : c'est la
   * convention déjà retenue pour `date_gmt` côté REST. L'écart possible va jusqu'à ±14 h, et il
   * penche du bon côté pour une édition brésilienne — une heure locale lue en UTC paraît plus
   * VIEILLE qu'elle n'est, donc un article limite sort de la fenêtre au lieu d'y entrer.
   */
  datesWithoutTimezone: number;
  itemsWithImage: number;
  /** Redirections suivies pour atteindre le flux — un site qui redirige révèle son www/https réel. */
  redirects: number;
  /**
   * Des filtres par id de catégorie/étiquette ont été demandés et IGNORÉS : un flux n'a pas d'ids.
   * ⛔ Ne jamais le taire — une grille non filtrée qui se présente comme filtrée fait insérer des
   * articles que personne n'a demandés.
   */
  filtersIgnored: boolean;
  /**
   * Caractères que le décodage n'a PAS su rendre (U+FFFD), titres et extraits confondus.
   *
   * ⛔ Un compteur, pas une décoration : un flux mal étiqueté sort en mojibake sans lever la
   * moindre erreur — « Ação » devient « A��o » et part tel quel dans l'e-mail. `decodeFeedBody`
   * supprime le cas déclaré ; ce chiffre attrape celui qui MENT sur son encodage, et l'écran le dit
   * avant l'envoi au lieu de laisser l'abonné le découvrir.
   */
  replacementChars: number;
  fetchedAt: string;
}

export interface RssFetchResult {
  /** ⛔ Le MÊME type que `fetchPosts`. C'est tout l'objet de ce fichier. */
  candidates: WpCandidate[];
  feed: RssFeedInfo;
}

/** Ce qu'on sait demander à un flux. Volontairement plus court que `WpQuery` : cf. `filtersIgnored`. */
export interface RssQuery {
  limit?: number;
  /** Borne basse de publication, ISO. Appliquée ICI : un flux n'a pas de `?after=`. */
  after?: string;
  /** Borne haute, ISO — pour rejouer une occurrence passée à l'identique. */
  before?: string;
  /** Passés seulement pour être signalés comme ignorés (cf. `filtersIgnored`). */
  categories?: number[];
  tags?: number[];
}

/* ------------------------------------------------------------------ *
 * XML — extraction tolérante
 * ------------------------------------------------------------------ */

/**
 * POURQUOI PAS UN VRAI PARSEUR XML. Le package n'a aucune dépendance d'exécution, et c'est un
 * choix : il tourne dans le worker comme dans l'admin. Surtout, un parseur strict REFUSE les flux
 * réels — celui de lumen-living n'échappe pas ses `&`, ce qui suffit à faire échouer un DOMParser. On
 * extrait donc à la regex, en tolérant ce qui se tolère, parce qu'un flux à moitié lisible vaut
 * mieux qu'une erreur de syntaxe que personne ne peut corriger chez le voisin.
 *
 * Le prix est connu et borné : on ne lit que des éléments de premier niveau connus (`item`,
 * `title`, `link`…), jamais une structure arbitraire.
 */
interface XmlElement {
  /** Le texte des attributs, brut. Interrogé par `attrOf`. */
  attrs: string;
  /** Contenu, CDATA déballé et entités XML décodées. */
  text: string;
}

/**
 * `(?:[\w-]+:)?` accepte le préfixe de namespace : `dc:date`, `content:encoded`, `media:content`
 * sont le quotidien des flux WordPress, et un flux les préfixe ou non selon son générateur.
 *
 * Le lookahead `(?=[\s/>])` empêche `<title>` de se faire attraper par une recherche de `<ti`.
 */
function elementRegex(name: string, all: boolean): RegExp {
  const n = name.replace(/[^\w-]/g, "");
  return new RegExp(
    `<(?:[\\w-]+:)?${n}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${n}\\s*>)`,
    all ? "gi" : "i",
  );
}

/** CDATA déballé, entités XML décodées UNE fois. Le contenu reste du HTML : c'est voulu. */
function xmlText(raw: string | undefined): string {
  if (!raw) return "";
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  // Dans un CDATA, `&amp;` est déjà le texte final : le décoder l'abîmerait. Hors CDATA, le XML
  // est échappé et il FAUT le décoder pour retrouver le HTML que `stripHtml` sait traiter — sans
  // ça, `&lt;p&gt;` traverse la suppression des balises et finit à l'écran.
  return cdata?.[1] !== undefined ? cdata[1] : decodeEntities(raw);
}

function findElement(xml: string, name: string): XmlElement | null {
  const m = elementRegex(name, false).exec(xml);
  if (!m) return null;
  return { attrs: m[1] ?? "", text: xmlText(m[2]).trim() };
}

function findElements(xml: string, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const re = elementRegex(name, true);
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    out.push({ attrs: m[1] ?? "", text: xmlText(m[2]).trim() });
  }
  return out;
}

/**
 * Valeur d'un attribut, guillemets simples ou doubles.
 *
 * ⚠️ La frontière est `(?:^|[\s/])` et NON `\b` : un `-` est une frontière de mot, donc `\bsrc`
 * attraperait le `data-src` d'une image en chargement paresseux — c'est-à-dire un placeholder
 * transparent à la place de la photo de l'article.
 */
function attrOf(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|[\\s/])${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  const raw = m?.[2] ?? m?.[3];
  return raw ? decodeEntities(raw).trim() : null;
}

/* ------------------------------------------------------------------ *
 * Reconnaissance d'un flux
 * ------------------------------------------------------------------ */

/**
 * Ce corps est-il un flux ?
 *
 * ⛔ ON RENIFLE LE CORPS, ON NE CROIT PAS L'EN-TÊTE. Mesuré le 25/08 : `www.bluefin-news.example/feed` répond
 * `content-type: text/html` en servant du RSS 2.0 parfaitement valide. Un lecteur qui filtre sur
 * le type annoncé déclarerait « pas de flux » sur une des deux marques que ce lot existe pour
 * servir. Le corps, lui, ne ment pas.
 */
export function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 2000);
  return /<(?:[\w-]+:)?(?:rss|feed|rdf)\b/i.test(head);
}

/** RSS 2.0 / RDF portent des `<item>` ; Atom des `<entry>`. C'est la seule différence qui compte ici. */
function feedFormat(body: string): "rss" | "atom" {
  return /<(?:[\w-]+:)?feed\b/i.test(body.slice(0, 2000)) ? "atom" : "rss";
}

/**
 * Le début du document, coupé avant la première entrée.
 *
 * Sans cette coupe, le titre du canal serait celui du premier article : `<channel><title>` et
 * `<item><title>` sont le même motif, et la première occurrence gagne. On coupe donc AVANT d'aller
 * chercher quoi que ce soit au niveau du canal.
 */
function sliceChannelHead(body: string): string {
  const first = /<(?:[\w-]+:)?(?:item|entry)(?=[\s/>])/i.exec(body);
  return first ? body.slice(0, first.index) : body;
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

export interface FeedDate {
  /** ISO 8601 avec fuseau explicite, ou `null` si la date est inexploitable → PÉRIMÉ. */
  iso: string | null;
  /** La date n'avait pas de fuseau : lue comme UTC. À compter, et à dire. */
  assumedUtc: boolean;
}

/** `YYYY-MM-DD`, éventuellement suivi d'une heure, SANS aucun fuseau derrière. */
const NAIVE_DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?)?$/;

/**
 * Date d'entrée de flux → ISO, ou `null`.
 *
 * TROIS FORMES, TROIS TRAITEMENTS, ET SURTOUT PAS `Date.parse` EN PREMIER :
 *
 *  1. **Naïve** (`2026-08-25 14:39:30`, mesuré sur bluefin-news.example). `Date.parse` la lit comme une heure
 *     LOCALE DU SERVEUR : la même entrée donnerait un instant différent sur une machine de dev
 *     française et sur Vercel en UTC. On la stampe donc explicitement en UTC — la convention déjà
 *     retenue pour `date_gmt` côté REST — et l'appelant compte l'approximation (`assumedUtc`).
 *  2. **RFC 822** (`Tue, 25 Aug 2026 14:38:00 -0300`, mesuré sur lumen-living) et **RFC 3339** : les
 *     deux portent leur fuseau, `Date.parse` les lit correctement.
 *  3. **Tout le reste** → `null`, c'est-à-dire PÉRIMÉ. Une date qu'on ne sait pas lire ne doit pas
 *     devenir « aujourd'hui » par défaut : ce serait la seule erreur capable de faire partir un
 *     article vieux de six mois dans une newsletter qui promet l'actualité de la semaine.
 */
export function parseFeedDate(raw: string | undefined | null): FeedDate {
  const v = (raw ?? "").trim();
  if (!v) return { iso: null, assumedUtc: false };

  // Certains générateurs préfixent le jour EN TOUTES LETTRES devant une date naïve
  // (`Tuesday, 2026-08-25 14:44:30` — le `<pubDate>` de canal d'bluefin-news.example). Le RFC 822 a aussi un
  // jour devant, mais abrégé et suivi d'une date en lettres : les deux motifs ne se confondent pas.
  const naive = NAIVE_DATE.exec(v) ?? NAIVE_DATE.exec(v.replace(/^[a-zA-Z]+,\s*/, ""));
  if (naive) {
    const ms = Date.parse(`${naive[1]}T${naive[2] ?? "00:00:00"}Z`);
    return Number.isFinite(ms)
      ? { iso: new Date(ms).toISOString(), assumedUtc: true }
      : { iso: null, assumedUtc: false };
  }

  const ms = Date.parse(v);
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), assumedUtc: false } : { iso: null, assumedUtc: false };
}

/* ------------------------------------------------------------------ *
 * Vignette
 * ------------------------------------------------------------------ */

interface FeedImage {
  url: string | null;
  /**
   * Description de CETTE image, quand la balise qui l'a fournie en portait une.
   *
   * ⚠️ Seule la piste `<img>` peut en avoir : `media:content`, `media:thumbnail` et `enclosure`
   * n'ont pas d'attribut de description dans leurs normes respectives. Vide ailleurs, donc — et
   * vide veut dire « la source n'a rien dit », jamais « mets le titre ».
   */
  alt: string;
  mime: string | null;
  width: number | null;
  height: number | null;
}

const NO_IMAGE: FeedImage = { url: null, alt: "", mime: null, width: null, height: null };

const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?)(?:[?#]|$)/i;

/**
 * En dessous, une `<img>` du corps de l'article n'est pas une vignette : c'est un écusson, un logo
 * de sponsor ou un pixel de suivi. 200 px est le seuil sous lequel une image ne remplit plus une
 * carte d'e-mail sans être étirée jusqu'à la bouillie.
 */
const MIN_HTML_IMAGE_PX = 200;

/**
 * Chemins d'images qui ne sont pas la photo de l'article, quelle que soit leur taille annoncée.
 *
 * ⛔ CECI N'EST PAS UNE PRÉCAUTION THÉORIQUE. Mesuré le 25/08 sur le flux Atom de northwind-sports : une
 * entrée n'offrait, comme seule `<img>` sans dimensions déclarées, un logo de BOOKMAKER
 * (`/logos/bookmakers/betano…png`). Sans ce filtre, une marque de paris serait devenue la vignette
 * d'un article de foot dans un e-mail envoyé à 1 200 personnes réparties sur 18 marchés dont
 * plusieurs encadrent la publicité pour les jeux d'argent. Le même motif attrape au passage le
 * `blank.gif` que les images en chargement paresseux laissent dans `src`.
 *
 * Le prix d'un faux positif est connu et petit : l'article entre sans vignette et l'insertion le
 * dit. Le prix d'un faux négatif est un logo de sponsor dans une newsletter. Le doute tombe du côté
 * qui retient.
 */
const DECOR_IMAGE_PATH =
  /(?:^|[/_-])(?:logos?|icons?|avatars?|badges?|sprites?|pixels?|spacer|blank|placeholder)(?:[/_.-]|$)/i;

/** Le chemin d'une URL, pour n'appliquer `DECOR_IMAGE_PATH` ni au domaine ni à la query. */
function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Seuls `http`/`https` absolus : un `data:` ou un chemin relatif n'a rien à faire dans un bloc. */
function httpUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const intOrNull = (v: string | null): number | null => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Vignette d'une entrée, dans l'ordre du plus explicite au plus incertain.
 *
 * LES TROIS PORTES OBSERVÉES EN VRAI, plus un piège :
 *  1. `<media:content>` — porte type et dimensions, donc la plus sûre.
 *  2. `<media:thumbnail>` — ⚠️ bluefin-news.example met l'URL dans le **texte** de la balise, là où la norme
 *     MRSS attend un attribut `url`. Un lecteur qui ne regarde que l'attribut perd toutes les
 *     vignettes d'une des deux marques du lot. On accepte les deux écritures.
 *  3. `<enclosure>` — ⛔ c'est aussi le véhicule des podcasts. Sans le filtre `image/`, un MP3 de
 *     40 Mo partirait au réhébergement comme s'il s'agissait d'une photo.
 *  4. `<img src>` dans le HTML du résumé, en dernier recours : c'est souvent un pixel de suivi ou
 *     un logo de pied de page, d'où sa place en fin de liste.
 */
export function pickFeedImage(itemXml: string, html: string): FeedImage {
  for (const el of findElements(itemXml, "content")) {
    const url = httpUrl(attrOf(el.attrs, "url"));
    if (!url) continue;
    const type = attrOf(el.attrs, "type");
    const medium = attrOf(el.attrs, "medium");
    // Un `<media:content>` de vidéo existe et ne doit surtout pas devenir la vignette.
    const isImage = medium === "image" || (type?.startsWith("image/") ?? false) || IMAGE_EXT.test(url);
    if (!isImage) continue;
    return {
      url,
      alt: "",
      mime: type?.startsWith("image/") ? type : null,
      width: intOrNull(attrOf(el.attrs, "width")),
      height: intOrNull(attrOf(el.attrs, "height")),
    };
  }

  for (const el of findElements(itemXml, "thumbnail")) {
    const url = httpUrl(attrOf(el.attrs, "url") ?? el.text);
    if (!url) continue;
    return {
      ...NO_IMAGE,
      url,
      width: intOrNull(attrOf(el.attrs, "width")),
      height: intOrNull(attrOf(el.attrs, "height")),
    };
  }

  for (const el of findElements(itemXml, "enclosure")) {
    const url = httpUrl(attrOf(el.attrs, "url"));
    const type = attrOf(el.attrs, "type");
    if (!url) continue;
    if (!type?.startsWith("image/") && !IMAGE_EXT.test(url)) continue;
    return { ...NO_IMAGE, url, mime: type?.startsWith("image/") ? type : null };
  }

  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1] ?? "";
    const url = httpUrl(attrOf(attrs, "src"));
    if (!url || DECOR_IMAGE_PATH.test(urlPath(url))) continue;
    const width = intOrNull(attrOf(attrs, "width"));
    const height = intOrNull(attrOf(attrs, "height"));
    // ⛔ LE PIÈGE, MESURÉ (northwind-sports, flux Atom, 25/08) : les seules `<img>` du corps d'un article
    // étaient un logo de compétition 18×18, deux écussons 68×68 et un logo de bookmaker. Prendre
    // la première aurait mis un logo de PARI en vignette d'un article de foot, dans un e-mail
    // envoyé à 1 200 personnes. On écarte donc tout ce qui ANNONCE une petite taille — et si tout
    // est petit, on rend PAS D'IMAGE : le bloc article sait s'afficher sans, une vignette de
    // travers ne se rattrape plus une fois partie.
    if ((width !== null && width < MIN_HTML_IMAGE_PX) || (height !== null && height < MIN_HTML_IMAGE_PX)) {
      continue;
    }
    // ⚠️ L'`alt` se lit sur la MÊME balise que le `src` retenu, jamais sur une autre `<img>` du
    // corps : deux images d'un article ont deux descriptions, et les apparier au hasard mettrait
    // sous la photo une phrase qui décrit l'écusson d'à côté. `attrOf` rend `null` quand
    // l'attribut est absent ET quand il est vide — les deux veulent dire la même chose ici.
    return { ...NO_IMAGE, url, alt: attrOf(attrs, "alt") ?? "", width, height };
  }
  return NO_IMAGE;
}

/* ------------------------------------------------------------------ *
 * Identité d'une entrée
 * ------------------------------------------------------------------ */

/**
 * FNV-1a 32 bits. Sert UNIQUEMENT à raccourcir une clé, jamais à sécuriser quoi que ce soit.
 * Écrit ici plutôt qu'importé de `node:crypto` : ce package doit rester lisible depuis le worker
 * comme depuis une route Next, sans supposer l'environnement.
 */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Clé stable d'une entrée.
 *
 * ⚠️ LA CONTRAINTE VIENT D'EN FACE : `insert/route.ts` écrit `postId: str(a.id, 40)` — la clé est
 * TRONQUÉE À 40 CARACTÈRES dans le document. Recopier un `<guid>` qui est une URL complète y
 * perdrait sa fin, c'est-à-dire précisément le slug qui distingue deux articles du même jour :
 * deux blocs se retrouveraient avec la même provenance.
 *
 * Trois cas, dans l'ordre :
 *  1. Un PERMALIEN WordPress `?p=123` → l'id WordPress lui-même. Une source qui passerait un jour
 *     du RSS au REST garderait alors exactement les mêmes clés.
 *  2. Un guid assez court → tel quel, c'est ce qu'il y a de plus lisible à l'écran.
 *  3. Sinon un condensé — court, stable, et qui ne peut pas collisionner par troncature.
 */
export function feedItemId(guid: string, link: string): string {
  const key = guid || link;
  if (!key) return "";

  const p = wpPermalinkPostId(guid) ?? wpPermalinkPostId(link);
  if (p) return p;

  return key.length <= 40 ? key : `rss_${shortHash(key)}`;
}

/**
 * L'id WordPress d'un PERMALIEN `?p=123`, ou `null`.
 *
 * ⛔ POURQUOI PAS UN SIMPLE `/[?&]p=(\d+)/`. Ce motif attrapait n'importe quel paramètre nommé `p`
 * dans la query : `…/x?page=1&p=2` et `…/y?page=9&p=2` sont DEUX articles différents et rendaient
 * tous deux l'id « 2 ». `insert/route.ts` écrit cet id comme provenance du bloc — deux blocs avec
 * la même clé, c'est un rafraîchissement qui relit le mauvais article et une déduplication qui peut
 * en avaler un. Le condensé FNV de repli, lui, ne collisionne pas.
 *
 * Un vrai permalien par défaut de WordPress n'a AUCUN chemin et `p` pour seul paramètre : c'est
 * exactement ce qu'on exige ici, et rien de plus.
 */
function wpPermalinkPostId(raw: string): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.pathname !== "" && u.pathname !== "/") return null;
  const p = u.searchParams.get("p");
  if (p === null || !/^\d{1,12}$/.test(p)) return null;
  for (const k of u.searchParams.keys()) if (k !== "p") return null;
  return p;
}

/* ------------------------------------------------------------------ *
 * Entrée → candidat
 * ------------------------------------------------------------------ */

/**
 * Le lien de l'article.
 *
 * ⚠️ Atom écrit `<link href="…"/>`, RSS écrit `<link>…</link>` : deux endroits différents pour la
 * même information. Et Atom pose PLUSIEURS `<link>` par entrée — `rel="self"`, `rel="replies"`,
 * `rel="enclosure"`… Prendre le premier venu enverrait l'abonné sur le flux de commentaires.
 */
function pickLink(itemXml: string): string {
  const links = findElements(itemXml, "link");
  const alternates = links.filter((l) => {
    const rel = attrOf(l.attrs, "rel");
    return rel === null || rel === "alternate";
  });
  for (const l of alternates.length > 0 ? alternates : links) {
    const url = httpUrl(attrOf(l.attrs, "href") ?? l.text);
    if (url) return url;
  }
  return "";
}

/** Catégories lisibles. RSS les met dans le texte, Atom dans `term`/`label`. */
function pickCategoryNames(itemXml: string): string[] {
  const names = findElements(itemXml, "category")
    .map((c) => stripHtml(attrOf(c.attrs, "label") ?? attrOf(c.attrs, "term") ?? c.text))
    .filter(Boolean);
  return [...new Set(names)];
}

/** Ce qu'une entrée a donné, en plus du candidat : de quoi remplir `RssFeedInfo` honnêtement. */
interface ItemReading {
  candidate: WpCandidate;
  assumedUtc: boolean;
  hadCategories: boolean;
  hadFullContent: boolean;
}

/**
 * Une entrée de flux → un `WpCandidate`. **Pure** : aucune I/O, rejouable sur un flux enregistré,
 * comme les fonctions de `normalize.ts` — et pour la même raison, les formes bizarres du contenu
 * sont le tas d'ennuis le plus fréquent et le seul qu'on puisse tester sans réseau.
 *
 * ⛔ `categoryIds` et `tagIds` sortent VIDES et le resteront : un flux ne transporte pas d'ids de
 * taxonomie, et en fabriquer (un hash du nom, par exemple) produirait des ids qui ne désignent rien
 * chez la source — donc un filtre `?categories=` qui ne rendrait jamais rien le jour où la source
 * passerait au REST.
 */
export function feedItemToCandidate(itemXml: string): ItemReading {
  // ⚠️ `<content>` est AMBIGU : c'est le corps de l'article en Atom, mais aussi la vignette en
  // MRSS (`<media:content url="…"/>`). Les deux tombent dans la même recherche, préfixe de
  // namespace compris. Un `url=` tranche : une balise qui porte une URL de média n'est pas un
  // corps d'article, et la prendre pour tel remplirait l'extrait de balises vides.
  const rawContent =
    findElement(itemXml, "encoded")?.text ??
    findElements(itemXml, "content").find((el) => attrOf(el.attrs, "url") === null)?.text ??
    "";
  const rawSummary = findElement(itemXml, "description")?.text ?? findElement(itemXml, "summary")?.text ?? "";
  // Le contenu complet quand il est là, le résumé sinon : c'est l'ordre qui donne le meilleur
  // extrait, et `cleanExcerpt` borne les deux de la même façon.
  const html = rawContent || rawSummary;

  const link = pickLink(itemXml);
  const guid = findElement(itemXml, "guid")?.text ?? findElement(itemXml, "id")?.text ?? "";
  // Atom sépare `published` (la parution) et `updated` (la dernière retouche). On veut la parution :
  // une coquille corrigée hier ne rajeunit pas un article de la semaine dernière.
  const date = parseFeedDate(
    findElement(itemXml, "pubDate")?.text ||
      findElement(itemXml, "published")?.text ||
      findElement(itemXml, "date")?.text ||
      findElement(itemXml, "updated")?.text,
  );

  const image = pickFeedImage(itemXml, html);
  const categoryNames = pickCategoryNames(itemXml);

  return {
    candidate: {
      id: feedItemId(guid, link),
      title: stripHtml(findElement(itemXml, "title")?.text),
      excerpt: cleanExcerpt(html),
      permalink: link,
      publishedAt: date.iso,
      imageUrl: image.url,
      // ⚠️ Un flux ne porte pas l'`alt_text` de la médiathèque, mais quand la vignette a été
      // trouvée dans une `<img>` du corps, cette balise porte son propre `alt` — écrit par la
      // rédaction, dans la langue du site, et il décrit exactement l'image retenue. Il ne coûte
      // AUCUNE requête de plus : le HTML est déjà là, `pickFeedImage` le parcourait déjà en
      // relevant tous les autres attributs. Vide partout ailleurs, et vide reste vide : c'est ce
      // qui déclenche l'avertissement de l'inspecteur, et recopier le titre à la place ferait
      // entendre deux fois la même phrase à un lecteur d'écran en se donnant l'air accessible.
      imageAlt: image.alt,
      // Rien n'annonce le type dans la plupart des flux, et on n'a pas les octets ici. `null` = « on
      // ne sait pas » ; le reniflage par signature reste celui de l'import.
      imageMime: image.mime,
      imageWidth: image.width,
      imageHeight: image.height,
      categoryIds: [],
      tagIds: [],
      categoryNames,
    },
    assumedUtc: date.assumedUtc,
    hadCategories: categoryNames.length > 0,
    hadFullContent: rawContent !== "",
  };
}

/* ------------------------------------------------------------------ *
 * Fraîcheur
 * ------------------------------------------------------------------ */

/**
 * Bornes de publication, appliquées CÔTÉ CLIENT parce qu'un flux n'a pas de `?after=`.
 *
 * ⛔ DOCTRINE : un article sans date lisible est écarté dès qu'une borne est posée. Le doute tombe
 * du côté qui retient l'envoi — un article dont on ignore l'âge n'a rien à faire dans une
 * newsletter qui promet « cette semaine », et il n'a pas davantage sa place dans le rejeu d'une
 * occurrence passée. Sans borne, en revanche, on le garde : l'auteur voit la carte, voit qu'elle
 * n'a pas de date, et tranche lui-même.
 *
 * ⛔ UNE BORNE ILLISIBLE N'EST PAS UNE ABSENCE DE BORNE. `Date.parse("hier")` rend `NaN` : le
 * traiter comme « pas de borne » rendait les 20 articles du flux ET y RÉINTÉGRAIT les non datés —
 * l'inverse exact de la doctrine ci-dessus, en silence. Le chemin REST, lui, fait refuser la borne
 * par WordPress. Deux chemins, deux réponses opposées à la même saisie fautive : ici on lève, pour
 * que le doute retienne des deux côtés.
 */
export function filterFreshness(
  candidates: readonly WpCandidate[],
  after?: string,
  before?: string,
): WpCandidate[] {
  const lo = freshnessBound(after, "after");
  const hi = freshnessBound(before, "before");
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return [...candidates];

  return candidates.filter((c) => {
    if (!c.publishedAt) return false;
    const at = Date.parse(c.publishedAt);
    if (!Number.isFinite(at)) return false;
    if (Number.isFinite(lo) && at < lo) return false;
    if (Number.isFinite(hi) && at > hi) return false;
    return true;
  });
}

/**
 * Une borne, ou `NaN` quand il n'y en a pas. Une borne PRÉSENTE mais illisible LÈVE.
 *
 * Le message nomme le paramètre fautif ET la forme attendue : « borne invalide » obligerait
 * l'opérateur à deviner laquelle des deux, et à quoi doit ressembler la bonne.
 */
export function freshnessBound(raw: string | undefined | null, name: "after" | "before"): number {
  if (raw === undefined || raw === null || raw.trim() === "") return NaN;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    throw new WpFetchError(
      "url",
      `\`${name}\` vaut "${raw}", qui n'est pas une date lisible — utilisez la forme ISO 2026-08-25T00:00:00Z`,
    );
  }
  return at;
}

/**
 * Ce qu'on répond quand on demande des taxonomies à un flux — en anglais, c'est de l'interface.
 *
 * ⛔ ÉCRIT UNE SEULE FOIS parce qu'il est dit à DEUX endroits (`/posts` sous la grille, `/terms`
 * quand le sélecteur interroge une source RSS). Deux formulations pour la même absence se liraient
 * comme deux causes différentes — et l'une des deux finirait par dire « panne » là où il n'y a
 * qu'une capacité que le format ne transporte pas.
 */
export const RSS_NO_TAXONOMY_NOTICE =
  "This feed carries no categories. That does not mean the site has none — RSS simply does not transport them.";

/**
 * Tri par date décroissante, les non datés EN DERNIER.
 *
 * Les intercaler demanderait de leur inventer une place dans le temps. En queue, ils restent
 * visibles — donc choisissables en connaissance de cause — sans prétendre à une fraîcheur.
 */
function byDateDesc(a: WpCandidate, b: WpCandidate): number {
  if (!a.publishedAt && !b.publishedAt) return 0;
  if (!a.publishedAt) return 1;
  if (!b.publishedAt) return -1;
  return b.publishedAt.localeCompare(a.publishedAt);
}

/* ------------------------------------------------------------------ *
 * Découverte du flux
 * ------------------------------------------------------------------ */

/** Une réponse qui est un flux, avec l'URL qui l'a rendue. */
interface FoundFeed {
  url: string;
  body: string;
  redirects: number;
}

/**
 * L'encodage RÉEL du document, dans l'ordre où il fait autorité.
 *
 * ⛔ POURQUOI CE N'EST PAS UN DÉTAIL. `safeFetch` décode en dur en UTF-8 — c'est juste pour du JSON
 * REST (qui EST de l'UTF-8 par spécification), c'est faux pour du XML. Un flux qui déclare
 * `<?xml encoding="ISO-8859-1"?>` — encore courant chez les CMS brésiliens, et deux des marques du
 * lot sont brésiliennes — sortait alors en mojibake SILENCIEUX : « Ação do Grêmio » devenait
 * « A��o do Gr�mio », et rien n'arrêtait ce titre avant l'e-mail.
 *
 * L'ordre suit RFC 3023 : le `charset` du `content-type` HTTP fait foi quand il est là, la
 * déclaration XML sert quand le serveur n'a rien dit (le cas le plus fréquent), UTF-8 en dernier.
 * La déclaration se lit sur les 200 premiers octets en latin-1 : tout jeu de caractères candidat
 * y est compatible ASCII, donc le nom du charset s'y lit toujours correctement.
 */
/**
 * ⚠️ `TextDecoder` accepte à l'exécution TOUTE étiquette du registre WHATWG (des centaines), mais
 * les types de Bun n'en déclarent qu'une poignée. Ce paquet est compilé des deux côtés — l'admin
 * sous Node, le worker sous Bun — et un charset lu dans un flux distant est de toute façon une
 * chaîne inconnue à la compilation. Le cast est donc honnête : c'est le `try/catch` de l'appelant
 * qui fait foi, pas le type.
 */
const decoderFor = (label: string): TextDecoder => new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0]);

function decodeFeedBody(bytes: Uint8Array, contentType: string | null): string {
  const fromHeader = /charset\s*=\s*"?([\w.:+-]+)"?/i.exec(contentType ?? "")?.[1];
  const head = decoderFor("latin1").decode(bytes.subarray(0, 200));
  const fromXml = /<\?xml[^>]*\bencoding\s*=\s*["']([\w.:+-]+)["']/i.exec(head)?.[1];

  for (const label of [fromHeader, fromXml, "utf-8"]) {
    if (!label) continue;
    try {
      // ⛔ `fatal: false` : un octet isolément invalide donne un U+FFFD, pas une exception. Un flux
      // à moitié lisible vaut mieux qu'un refus — et `replacementChars` (parseFeed) COMPTE ces
      // U+FFFD pour que le défaut se voie à l'écran au lieu de partir dans un envoi.
      return decoderFor(label).decode(bytes);
    } catch {
      /* étiquette inconnue de la plateforme : on essaie la suivante, jamais un plantage */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Le corps d'une URL, sous garde. `null` = ce n'est pas un flux ici, on continue à chercher. */
async function tryFeedUrl(url: string, auth: WpAuth, timeoutMs: number): Promise<SafeResponse | null> {
  let res: SafeResponse;
  try {
    // Octets puis décodage explicite : cf. `decodeFeedBody`. `safeFetch` aurait imposé UTF-8.
    const raw = await safeFetchBytes(url, {
      headers: {
        // ⛔ `safeFetchBytes` pose `accept: image/*` par défaut — c'est son usage nominal (les
        // vignettes). Un flux demandé en `image/*` peut se voir répondre 406 par un serveur
        // pointilleux : on annonce ce qu'on veut vraiment lire.
        accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5",
        ...authHeader(auth),
      },
      timeoutMs,
    });
    const { bytes, contentType, ...rest } = raw;
    res = { ...rest, text: decodeFeedBody(bytes, contentType) };
  } catch (e) {
    // ⛔ UNE ERREUR DE GARDE NE SE MANGE PAS. « adresse privée », « hôte non résolu », « URL
    // invalide » sont des verdicts sur la saisie de l'opérateur : les avaler ici les
    // transformerait en « aucun flux trouvé sur ce site », et le refus anti-SSRF disparaîtrait
    // de l'écran — une garde qu'on n'entend pas est une garde qu'on croit absente.
    if (e instanceof WpFetchError && (e.kind === "blocked" || e.kind === "dns" || e.kind === "url")) throw e;
    // Le reste (404 déguisé en panne réseau, hôte lent, corps trop gros) ne condamne que CETTE
    // tentative : le flux est peut-être au chemin suivant.
    return null;
  }
  if (res.status >= 400) return null;
  return res;
}

/** Les `<link rel="alternate" type="application/rss+xml">` d'une page HTML, absolutisés. */
export function autodiscoverFeedLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /<link\b[^>]*>/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const tag = m[0];
    const rel = attrOf(tag, "rel");
    const type = attrOf(tag, "type");
    if (rel?.toLowerCase() !== "alternate") continue;
    if (!/^application\/(?:rss|atom)\+xml$/i.test(type ?? "")) continue;
    const href = attrOf(tag, "href");
    if (!href) continue;
    try {
      // `href` est souvent relatif (`/feed`). Absolutiser ici évite de le faire à trois endroits.
      out.push(new URL(href, baseUrl).href);
    } catch {
      /* href illisible : ce n'est pas une piste, ce n'est pas une erreur non plus */
    }
  }
  return [...new Set(out)];
}

/**
 * Trouve le flux d'une racine de site.
 *
 * L'ORDRE EST MESURÉ, PAS DEVINÉ (25/08/2026, sur les deux vrais sites du lot) :
 *  · si la saisie ressemble déjà à un flux, on l'essaie d'abord — l'opérateur a le droit de coller
 *    directement l'URL du flux, et lui refaire découvrir ce qu'il a sous les yeux serait absurde ;
 *  · puis `/feed`, défaut WordPress : c'est ce qui sert `bluefin-news.example` en UNE requête ;
 *  · puis la page d'accueil, pour son `<link rel="alternate">` : c'est la SEULE façon de trouver
 *    `lumen-living.example`, dont le flux est à `/news/rss.xml` — aucune liste de chemins conventionnels
 *    ne l'aurait deviné ;
 *  · puis les chemins restants.
 *
 * ⚠️ Le flux découvert peut être sur un autre hôte (lumen-living annonce `www.` depuis une racine sans
 * `www.`). On l'accepte — le refuser casserait le cas nominal — mais il repasse par la garde
 * complète, adresses privées comprises : la découverte ne crée aucun raccourci vers le réseau.
 */
export async function discoverFeed(
  root: string,
  auth: WpAuth = { kind: "none" },
  budgetMs = RSS_DISCOVERY_BUDGET_MS,
): Promise<FoundFeed> {
  const base = root.trim().replace(/\/+$/, "");
  if (base === "") throw new WpFetchError("url", "aucune URL de site à interroger");

  const deadline = Date.now() + budgetMs;
  const budget = (): number => Math.min(RSS_ATTEMPT_MS, deadline - Date.now());

  const looksLikeFeedUrl = /(?:\.(?:xml|rss)(?:[?#]|$))|(?:\b(?:feed|rss|atom)\b)/i.test(base);
  const queue: string[] = looksLikeFeedUrl ? [base] : [];
  queue.push(`${base}/feed`, base);
  for (const p of FEED_PATHS) {
    const u = p.startsWith("/?") ? `${base}/${p.slice(1)}` : `${base}${p}`;
    if (!queue.includes(u)) queue.push(u);
  }

  const tried = new Set<string>();
  let attempts = 0;
  let discovered: string[] = [];

  for (const url of queue) {
    if (attempts >= MAX_FEED_ATTEMPTS) break;
    if (tried.has(url)) continue;
    tried.add(url);
    if (budget() <= 0) break;
    attempts++;

    const res = await tryFeedUrl(url, auth, budget());
    if (!res) continue;

    if (looksLikeFeed(res.text)) {
      // `res.url` et non `url` : c'est l'URL réellement atteinte, redirections comprises. C'est
      // celle qu'il faut montrer à l'opérateur, et celle qu'il pourra coller la prochaine fois.
      return { url: res.url, body: res.text, redirects: res.redirects };
    }

    // Pas un flux : c'est peut-être la page d'accueil, qui SAIT où est le flux.
    const links = autodiscoverFeedLinks(res.text, res.url);
    if (links.length > 0) discovered = [...discovered, ...links.filter((l) => !tried.has(l))];

    // Une piste annoncée par le site vaut mieux que la suite d'une liste devinée : on la passe
    // devant. C'est ce qui fait tomber lumen-living en trois requêtes au lieu de cinq échecs.
    for (const link of discovered.splice(0)) {
      if (attempts >= MAX_FEED_ATTEMPTS || budget() <= 0) break;
      if (tried.has(link)) continue;
      tried.add(link);
      attempts++;
      const alt = await tryFeedUrl(link, auth, budget());
      if (alt && looksLikeFeed(alt.text)) {
        return { url: alt.url, body: alt.text, redirects: alt.redirects };
      }
    }
  }

  throw new WpFetchError(
    "parse",
    `aucun flux RSS ou Atom trouvé sous ${base} — collez directement l'URL du flux (souvent .../feed ou .../rss.xml) comme racine de la source`,
  );
}

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

/**
 * Un flux déjà téléchargé → des candidats. **Pure** : c'est la moitié testable sans réseau, et
 * c'est celle où vivent tous les pièges de forme.
 */
/** U+FFFD dans ce que l'abonné VERRA — titre et extrait. Cf. `RssFeedInfo.replacementChars`. */
function countReplacements(readings: readonly { candidate: WpCandidate }[]): number {
  let n = 0;
  for (const r of readings) {
    for (const ch of `${r.candidate.title}${r.candidate.excerpt}`) if (ch === "�") n++;
  }
  return n;
}

export function parseFeed(body: string, feedUrl: string, redirects = 0): RssFetchResult {
  const format = feedFormat(body);
  const head = sliceChannelHead(body);

  const blocks = [
    ...body.matchAll(
      /<(?:[\w-]+:)?(item|entry)(?=[\s/>])[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?\1\s*>/gi,
    ),
  ].map((m) => m[2] ?? "");

  const readings = blocks.map(feedItemToCandidate);
  // Même règle qu'en REST (`toCandidates`) : sans clé ni permalien, ce n'est pas posable. Une carte
  // sans lien serait un pavé de texte qui ressemble à un article.
  const kept = readings.filter((r) => r.candidate.id !== "" && r.candidate.permalink !== "");

  return {
    candidates: kept.map((r) => r.candidate).sort(byDateDesc),
    feed: {
      feedUrl,
      format,
      title: stripHtml(findElement(head, "title")?.text) || null,
      itemsInFeed: kept.length,
      hasCategories: kept.some((r) => r.hadCategories),
      fullContent: kept.some((r) => r.hadFullContent),
      undatedItems: kept.filter((r) => r.candidate.publishedAt === null).length,
      datesWithoutTimezone: kept.filter((r) => r.assumedUtc).length,
      itemsWithImage: kept.filter((r) => r.candidate.imageUrl !== null).length,
      redirects,
      filtersIgnored: false,
      // Compté sur le TEXTE RENDU, pas sur le document brut : un U+FFFD perdu dans une balise que
      // personne ne lit n'a aucune conséquence, celui qui atterrit dans un titre en a une.
      replacementChars: countReplacements(kept),
      fetchedAt: new Date().toISOString(),
    },
  };
}

/**
 * LE POINT D'ENTRÉE — le jumeau exact de `fetchPosts` pour un site sans API REST.
 *
 * Même signature (racine, auth, requête), même type de sortie (`WpCandidate[]`), donc même chemin
 * d'insertion et même réhébergement de vignettes. La seule différence visible pour l'appelant est
 * `feed`, qui porte ce que le flux n'a PAS pu donner — et qu'il faut afficher.
 *
 * `auth` est accepté et transmis parce qu'un flux peut être protégé par le même mot de passe
 * applicatif que l'API : la garde le largue d'elle-même si une redirection change d'origine.
 */
export async function fetchFeedPosts(
  root: string,
  auth: WpAuth = { kind: "none" },
  query: RssQuery = {},
): Promise<RssFetchResult> {
  const limit = Math.min(Math.max(query.limit ?? 5, 1), MAX_ARTICLES);

  const found = await discoverFeed(root, auth);
  const parsed = parseFeed(found.body, found.url, found.redirects);

  const fresh = filterFreshness(parsed.candidates, query.after, query.before);

  return {
    candidates: fresh.slice(0, limit),
    feed: {
      ...parsed.feed,
      // ⛔ Dit, jamais tu : une grille non filtrée qui se présente comme filtrée fait insérer des
      // articles que personne n'a demandés.
      filtersIgnored: (query.categories?.length ?? 0) > 0 || (query.tags?.length ?? 0) > 0,
    },
  };
}

/**
 * Sonde d'une source RSS — le pendant de `probe()` pour un site sans API REST.
 *
 * Ne lance JAMAIS, exactement pour la même raison que `probe()` : l'échec EST le résultat
 * intéressant, et un appelant qui doit traduire une exception finit par écrire un message plus
 * vague que celui qu'on lui donne ici.
 */
export interface RssProbeResult {
  ok: boolean;
  /** URL du flux réellement atteinte — à proposer en remplacement de la saisie. */
  resolvedFeedUrl: string;
  detail: string | null;
  feed: RssFeedInfo | null;
}

/**
 * La même sonde, rendue DANS LA FORME DE `probe()`.
 *
 * POURQUOI CETTE FORME PLUTÔT QU'UNE AUTRE. `recordProbe` écrit `capabilities`, `status` et
 * `status_detail` pour toutes les sources, et l'écran de réglages lit ces trois colonnes-là. Un
 * second format d'état donnerait une source RSS affichée « inconnue » alors qu'elle vient de rendre
 * 43 articles — ou pire, « error », parce qu'on l'aurait sondée avec un lecteur REST.
 *
 * ⛔ AUCUN CHAMP N'EST FLATTÉ POUR FAIRE JOLI. `wpV2: false` et `dateFilter: false` sont VRAIS d'un
 * flux : il n'a ni namespace ni `?after=`. Et `dateFilter: false` dit déjà exactement la bonne
 * chose au reste du produit — « la borne de fraîcheur se pose côté client », ce que fait
 * `filterFreshness`. Les mesures propres au flux vivent sous `rss`, jamais mélangées aux capacités
 * REST qu'on n'a pas mesurées.
 */
export async function probeFeedSource(
  root: string,
  auth: WpAuth = { kind: "none" },
): Promise<ProbeResult & { feed: RssFeedInfo | null }> {
  const r = await probeFeed(root, auth);

  const capabilities: WpCapabilities & { rss: RssFeedInfo | null } = {
    namespaces: [],
    wpV2: false,
    embed: false,
    dateFilter: false,
    popularPosts: false,
    // `null` = « pas mesuré », et c'est la vérité : un flux ne dit pas combien de catégories a le
    // site. Zéro se lirait « il n'y en a aucune ».
    categories: null,
    tags: null,
    posts: r.feed?.itemsInFeed ?? null,
    redirects: r.feed?.redirects ?? 0,
    siteName: r.feed?.title ?? null,
    probedAt: r.feed?.fetchedAt ?? new Date().toISOString(),
    rss: r.feed,
  };

  return {
    ok: r.ok,
    resolvedRoot: r.resolvedFeedUrl || root,
    detail: r.detail,
    capabilities,
    feed: r.feed,
  };
}

export async function probeFeed(root: string, auth: WpAuth = { kind: "none" }): Promise<RssProbeResult> {
  try {
    const { feed, candidates } = await fetchFeedPosts(root, auth, { limit: MAX_ARTICLES });
    return {
      // Un flux qui répond mais ne contient aucune entrée exploitable n'est pas une source : la
      // composition n'aurait rien à proposer, et un « ok » l'aurait fait croire le contraire.
      ok: candidates.length > 0,
      resolvedFeedUrl: feed.feedUrl,
      detail: candidates.length > 0 ? null : "le flux répond mais ne contient aucun article exploitable",
      feed,
    };
  } catch (e) {
    return {
      ok: false,
      resolvedFeedUrl: "",
      detail: e instanceof Error ? e.message : "flux illisible",
      feed: null,
    };
  }
}
