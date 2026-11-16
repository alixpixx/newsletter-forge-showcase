/**
 * WordPress → candidat de newsletter. **Fonctions PURES** : aucune I/O, aucun import réseau.
 *
 * C'est volontaire et structurant. Tout ce qui peut mal tourner dans la lecture d'un WordPress se
 * range en deux tas bien distincts : les pannes de transport (`guard.ts`) et les formes bizarres
 * du contenu (ici). Le second tas est le plus fréquent — un `_embed` absent, une image en AVIF, un
 * extrait qui finit par « Continue lendo → », une date sans fuseau — et c'est celui qu'on veut
 * pouvoir rejouer sur un échantillon enregistré, sans rien appeler.
 */

/* ------------------------------------------------------------------ *
 * Formes reçues
 * ------------------------------------------------------------------ */

export interface WpEmbeddedMedia {
  source_url?: string;
  alt_text?: string;
  mime_type?: string;
  media_details?: {
    width?: number;
    height?: number;
    sizes?: Record<string, { source_url?: string; mime_type?: string; width?: number; height?: number }>;
  };
  /** Présent quand l'embed est une ERREUR (`rest_forbidden`, article sans image à la une). */
  code?: string;
}

export interface WpEmbeddedTerm {
  id?: number;
  taxonomy?: string;
  slug?: string;
  name?: string;
}

export interface WpPost {
  id: number;
  date_gmt?: string;
  modified_gmt?: string;
  link?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
  categories?: number[];
  tags?: number[];
  featured_media?: number;
  _embedded?: {
    "wp:featuredmedia"?: WpEmbeddedMedia[];
    "wp:term"?: WpEmbeddedTerm[][];
  };
}

/* ------------------------------------------------------------------ *
 * Forme produite
 * ------------------------------------------------------------------ */

/** Un article, ramené à ce qu'un bloc de newsletter sait poser. */
export interface WpCandidate {
  /** Id WordPress, en texte : c'est une clé, pas un nombre sur lequel on compte. */
  id: string;
  title: string;
  /** Extrait débarrassé du HTML ET de la queue « Lire la suite » que WP colle automatiquement. */
  excerpt: string;
  permalink: string;
  /** ISO 8601 avec fuseau explicite, ou `null` si la date reçue est inexploitable. */
  publishedAt: string | null;
  imageUrl: string | null;
  /**
   * `alt_text` de la médiathèque WordPress. Souvent VIDE : dans ce cas le bloc image doit réclamer
   * une saisie, pas recopier le titre — un alt qui répète le titre juste à côté est du bruit pour
   * un lecteur d'écran, pas de l'accessibilité.
   */
  imageAlt: string;
  /**
   * Type ANNONCÉ par WordPress (`mime_type`), jamais reniflé : on n'a pas les octets à ce stade.
   * Sert à écarter tout de suite ce que nos e-mails ne savent pas afficher (AVIF, SVG) — la
   * vérification par signature reste celle de `lib/data/media.ts`, au téléversement.
   */
  imageMime: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  /** Ids numériques (jamais les slugs) : c'est ce que `?categories=` accepte. */
  categoryIds: number[];
  tagIds: number[];
  /** Noms lisibles des catégories, pour l'affichage dans le sélecteur. */
  categoryNames: string[];
}

/* ------------------------------------------------------------------ *
 * Texte
 * ------------------------------------------------------------------ */

/**
 * Les 96 entités nommées latin-1, dans l'ordre U+00A0 → U+00FF.
 *
 * Écrites comme une liste ordonnée plutôt qu'en table clé/valeur : la correspondance nom → point de
 * code est POSITIONNELLE dans la norme, et une table recopiée à la main aurait fini avec un
 * décalage d'une ligne que personne n'aurait vu passer.
 */
const LATIN1_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");

/** Entités nommées, casse EXACTE. Latin-1 d'abord, puis les usuelles hors latin-1. */
const NAMED: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  LATIN1_NAMES.forEach((name, i) => {
    map[name] = String.fromCodePoint(0xa0 + i);
  });
  return map;
})();

/**
 * Entités tolérées quelle que soit la casse — celles qui n'ont pas de jumelle majuscule, donc
 * qu'aucune confusion ne menace. `&AMP;` sort d'un CMS mal configuré et doit se lire « & ».
 */
const LOOSE: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "'",
  rsquo: "'",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  dagger: "†",
  permil: "‰",
  lsaquo: "‹",
  rsaquo: "›",
  euro: "€",
  trade: "™",
  minus: "−",
  prime: "′",
  Prime: "″",
};

/**
 * Entités HTML → caractères.
 *
 * WordPress renvoie du `rendered`, donc de l'entité partout, y compris dans des titres brésiliens
 * pleins d'apostrophes typographiques. Un titre qui arrive « Riverside n&#8217;a pas… » dans un e-mail
 * est un défaut visible par l'abonné, pas un détail d'encodage.
 */
export function decodeEntities(input: string): string {
  return (
    input
      // Toute entité NOMMÉE, en une passe. La table couvre les entités communes ET tout le
      // latin-1 : c'est la moitié qui manquait, et elle manquait exactement là où ça se voit.
      // Mesuré le 20/08 sur atlas-review.example : « A surpreendente vit&oacute;ria do San Antonio
      // Spurs » — l'extrait partait tel quel dans l'e-mail d'un lecteur brésilien. `&oacute;`,
      // `&ccedil;`, `&atilde;` sont le quotidien du portugais et de l'espagnol, soit huit des neuf
      // marques. Une entité inconnue est laissée INTACTE : « &foo; » à l'écran est un défaut
      // visible qu'on corrige, une chaîne vide est une phrase amputée que personne ne remarque.
      .replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, name: string) => {
        const exact = NAMED[name];
        if (exact !== undefined) return exact;
        // Repli insensible à la casse UNIQUEMENT hors latin-1 : `&Eacute;` et `&eacute;` sont deux
        // lettres différentes, les confondre remplacerait un É par un é en début de phrase.
        const lower = LOOSE[name.toLowerCase()];
        return lower !== undefined ? lower : m;
      })
      // Numériques : décimal et hexadécimal.
      .replace(/&#(\d{1,7});/g, (_, d: string) => codePoint(Number(d)))
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => codePoint(parseInt(h, 16)))
  );
}

/** Un point de code hors plage produirait un `RangeError` : on préfère laisser le texte tel quel. */
function codePoint(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** HTML → texte. Les balises de bloc deviennent des sauts de ligne, pas des mots collés. */
export function stripHtml(html: string | undefined | null): string {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Queues que WordPress (ou son thème) accroche à l'extrait automatique. On les coupe parce que le
 * lien « lire la suite » d'une newsletter, c'est le bouton du bloc — pas une phrase orpheline
 * recopiée du site, souvent dans la mauvaise langue et sans lien cliquable.
 */
const READ_MORE_TAIL =
  /(?:\s*[[(]?…?[\])]?\s*)?(?:continue\s+(?:lendo|reading)|leia\s+mais|ler\s+mais|read\s+more|seguir\s+leyendo|leer\s+m[áa]s|lire\s+la\s+suite|the\s+post\s+.+\s+appeared\s+first\s+on\s+.+)\s*[→»>.…]*\s*$/i;

/** Extrait présentable : HTML retiré, queue « lire la suite » coupée, longueur bornée. */
export function cleanExcerpt(rendered: string | undefined | null, maxChars = 400): string {
  let text = stripHtml(rendered).replace(/\s*\[[…\.]+\]\s*$/, "…").replace(READ_MORE_TAIL, "").trim();
  // Un extrait vidé par la coupe vaut mieux qu'un extrait réduit à « … ».
  if (/^[…\.\s→»]*$/.test(text)) return "";
  if (text.length > maxChars) {
    // Coupe au dernier espace pour ne pas trancher un mot en deux.
    const cut = text.slice(0, maxChars);
    const at = cut.lastIndexOf(" ");
    text = `${(at > maxChars * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Image à la une
 * ------------------------------------------------------------------ */

interface PickedImage {
  url: string | null;
  alt: string;
  mime: string | null;
  width: number | null;
  height: number | null;
}

const NO_IMAGE: PickedImage = { url: null, alt: "", mime: null, width: null, height: null };

/**
 * Image à la une depuis `_embedded["wp:featuredmedia"]`.
 *
 * On prend `source_url` — l'ORIGINAL, l'image exactement telle que la rédaction l'a posée. Les
 * `sizes` sont des recadrages générés par le thème : `medium_large` fait 768 px de large et se
 * retrouvait choisi sur les sites qui n'ont pas de taille `large`, donnant une image molle dans
 * l'e-mail. On ne descend dans les `sizes` que si l'original manque.
 *
 * ⚠️ `_embedded` peut contenir un OBJET D'ERREUR à la place du média (`code: "rest_forbidden"`,
 * ou article sans image à la une) : c'est une réponse 200 qui ne contient rien d'utilisable.
 */
export function pickFeaturedImage(post: WpPost): PickedImage {
  const media = post._embedded?.["wp:featuredmedia"]?.[0];
  if (!media || media.code) return NO_IMAGE;

  const sizes = media.media_details?.sizes ?? {};
  const fallback =
    sizes.full ?? sizes.large ?? sizes.medium_large ?? sizes.medium ?? undefined;

  const url = media.source_url ?? fallback?.source_url ?? null;
  if (!url) return NO_IMAGE;

  const fromOriginal = Boolean(media.source_url);
  return {
    url,
    alt: decodeEntities(media.alt_text ?? "").trim(),
    mime: media.mime_type ?? fallback?.mime_type ?? null,
    // Les dimensions doivent décrire l'URL RETENUE : servir la largeur de l'original avec l'URL
    // d'un recadrage produirait un bloc image déformé.
    width: (fromOriginal ? media.media_details?.width : fallback?.width) ?? null,
    height: (fromOriginal ? media.media_details?.height : fallback?.height) ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Taxonomies
 * ------------------------------------------------------------------ */

/** Termes embarqués d'une taxonomie donnée (`category`, `post_tag`). */
export function embeddedTerms(post: WpPost, taxonomy: "category" | "post_tag"): WpEmbeddedTerm[] {
  const groups = post._embedded?.["wp:term"] ?? [];
  return groups.flat().filter((t) => t?.taxonomy === taxonomy);
}

/* ------------------------------------------------------------------ *
 * Date
 * ------------------------------------------------------------------ */

/**
 * `date_gmt` de WordPress → ISO avec fuseau.
 *
 * WP renvoie « 2026-08-20T11:04:32 » SANS suffixe alors que la valeur est en UTC. Interprétée
 * telle quelle par `new Date()`, elle devient une heure LOCALE : jusqu'à 3 h d'écart pour une
 * édition brésilienne, ce qui suffit à faire basculer un article d'un jour à l'autre dans un
 * filtre « depuis hier ».
 */
export function toIsoUtc(dateGmt: string | undefined | null): string | null {
  if (!dateGmt) return null;
  const raw = dateGmt.trim();
  const stamped = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(stamped);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/* ------------------------------------------------------------------ *
 * Assemblage
 * ------------------------------------------------------------------ */

/** Un article WordPress → un candidat. Pure : mêmes entrées, même sortie, sans réseau. */
export function toCandidate(post: WpPost): WpCandidate {
  const image = pickFeaturedImage(post);
  const categories = embeddedTerms(post, "category");

  return {
    id: String(post.id ?? ""),
    title: stripHtml(post.title?.rendered),
    excerpt: cleanExcerpt(post.excerpt?.rendered),
    permalink: post.link ?? "",
    publishedAt: toIsoUtc(post.date_gmt),
    imageUrl: image.url,
    imageAlt: image.alt,
    imageMime: image.mime,
    imageWidth: image.width,
    imageHeight: image.height,
    // `post.categories` est la liste complète ; `_embedded` peut être tronqué ou absent. On prend
    // la liste plate quand elle est là, et on retombe sur les termes embarqués sinon.
    categoryIds: numericIds(post.categories, categories),
    tagIds: numericIds(post.tags, embeddedTerms(post, "post_tag")),
    categoryNames: categories.map((t) => decodeEntities(t.name ?? "").trim()).filter(Boolean),
  };
}

function numericIds(flat: number[] | undefined, embedded: WpEmbeddedTerm[]): number[] {
  const source = Array.isArray(flat) && flat.length > 0 ? flat : embedded.map((t) => t.id);
  return [...new Set(source.filter((n): n is number => typeof n === "number" && Number.isFinite(n)))];
}

/** Plusieurs articles → candidats. Ceux sans id ni permalien sont écartés : ils ne sont pas posables. */
export function toCandidates(posts: readonly WpPost[]): WpCandidate[] {
  return posts.map(toCandidate).filter((c) => c.id && c.permalink);
}
