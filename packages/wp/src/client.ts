import {
  WP_POSTS_TIMEOUT_MS,
  WP_TIMEOUT_MS,
  WpFetchError,
  authHeader,
  safeFetch,
  type SafeResponse,
  type WpAuth,
} from "./guard";
import { toCandidate, toCandidates, type WpCandidate, type WpPost } from "./normalize";

/**
 * CLIENT WordPress REST — au-dessus de `guard.ts`, jamais de `fetch` nu.
 *
 * Ce fichier ne sait rien de la base : il reçoit une racine de site et rend des objets propres.
 * C'est ce qui permet de le faire tourner sur une URL qu'un opérateur vient de taper, avant même
 * qu'une source existe.
 *
 * TROIS CHOIX QUI VIENNENT DU SONDAGE RÉEL DES 9 DOMAINES, PAR CETTE SONDE (20/08/2026) :
 *
 *  1. **La sonde MESURE, elle ne suppose pas** — et elle a démenti l'estimation initiale. Verdicts
 *     obtenus, quatre familles distinctes :
 *       · lisibles : `atlas-review.example` (40 889 articles, 147 catégories), `northwind-sports.example`
 *         (203 980 / 222), `copper-kettle.example` (26 411 / 125), `harbor-tech.example` (494 / 122) ;
 *       · `pixel-daily.example` → 403 `rest_disabled` (débloqué par mot de passe applicatif) ;
 *       · `lumen-living.example` et `bluefin-news.example` → 404 sur `/wp-json` (relèvent du lecteur RSS, lot WP-4) ;
 *       · `quartz-tips-parked.example` et `goalpost-weekly-parked.example` → 200 mais pas de JSON : pas de WordPress.
 *     Quatre marques sur neuf sont donc servables tout de suite. Une source « configurée » sans
 *     sonde resterait pourtant un écran qui ment jusqu'au premier envoi.
 *
 *  2. **« Les plus lus » n'est PAS livrable et doit le DIRE.** `wordpress-popular-posts` est absent
 *     des namespaces des QUATRE sites lisibles — vérifié un par un, pas déduit. On expose la
 *     capacité mesurée (`popularPosts: false`) pour que l'UI grise l'option AVEC sa raison. Un repli
 *     muet sur « les derniers » livrerait une newsletter dont le titre promet autre chose que son
 *     contenu.
 *
 *  3. **La racine peut porter un chemin.** `atlas-review.example` expose trois racines REST — `/`,
 *     `/en/`, `/fr/`. C'est le mécanisme par lequel une même marque aura une newsletter par langue
 *     (décision d'Alix du 20/08 : la granularité est l'ÉDITION). `normalizeRestRoot` conserve donc
 *     le chemin et ne retire que le suffixe `/wp-json`.
 */

/* ------------------------------------------------------------------ *
 * Racine
 * ------------------------------------------------------------------ */

/**
 * Ce que l'opérateur tape → racine de SITE canonique, sans `/wp-json`, sans slash final.
 *
 * On accepte les quatre saisies observées en vrai : `site.com`, `https://site.com/`,
 * `https://site.com/wp-json`, `https://site.com/en/`. Refuser la troisième serait pédant — c'est
 * l'URL que les gens copient depuis leur navigateur — mais la STOCKER telle quelle produirait
 * `…/wp-json/wp-json/wp/v2/posts`.
 */
export function normalizeRestRoot(raw: string): string {
  let v = raw.trim();
  if (v === "") return "";
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;

  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "";
  }
  // Query et fragment n'ont aucun sens sur une racine et se propageraient à chaque appel.
  u.search = "";
  u.hash = "";

  u.pathname = u.pathname.replace(/\/+$/, "").replace(/\/wp-json$/i, "");

  return u.toString().replace(/\/+$/, "");
}

/** URL d'un point d'entrée REST. `path` est relatif à `/wp-json` (« /wp/v2/posts »). */
export function restUrl(
  root: string,
  path: string,
  params?: Record<string, string | number | undefined>,
): string {
  const u = new URL(`${normalizeRestRoot(root)}/wp-json${path}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/* ------------------------------------------------------------------ *
 * Authentification
 * ------------------------------------------------------------------ */

/**
 * Nom de la variable d'environnement qui porte le mot de passe applicatif d'un hôte.
 *
 * ⛔ DÉCISION D4 (Alix, 20/08) : le secret ne descend JAMAIS en base. `wp_source` porte
 * `auth_user`, jamais le mot de passe : stocker ce secret en clair dans la base qui détient la PII
 * des abonnés est précisément ce qu'on s'interdit ici.
 *
 * La clé est dérivée de l'HÔTE et pas d'un identifiant de ligne : une source recréée, renommée ou
 * dupliquée continue de trouver son secret, et deux éditions du même site (`/en/`, `/fr/`) le
 * partagent sans double saisie.
 */
export function authEnvVarFor(root: string): string {
  let host = "";
  try {
    host = new URL(normalizeRestRoot(root)).hostname;
  } catch {
    return "";
  }
  return `WP_APP_PASSWORD_${host.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * Résout l'authentification à l'EXÉCUTION. Renvoie `kind: "none"` quand la variable est absente :
 * un site public reste lisible, et un site protégé échouera avec son vrai 401 plutôt qu'avec une
 * erreur de configuration inventée ici.
 */
export function resolveAuth(root: string, authKind: string, authUser: string | null): WpAuth {
  if (authKind !== "app_password" || !authUser) return { kind: "none" };
  const secret = process.env[authEnvVarFor(root)];
  if (!secret) return { kind: "none" };
  return { kind: "app_password", user: authUser, secret };
}

/** La variable est-elle posée ? Exposé à l'UI pour afficher « secret manquant » — jamais sa valeur. */
export function hasAuthSecret(root: string): boolean {
  const name = authEnvVarFor(root);
  return name !== "" && Boolean(process.env[name]);
}

/* ------------------------------------------------------------------ *
 * Lecture JSON
 * ------------------------------------------------------------------ */

export interface WpJson<T> {
  data: T;
  /** `x-wp-total` / `x-wp-totalpages` : WordPress les met dans les en-têtes, pas dans le corps. */
  total: number | null;
  totalPages: number | null;
  res: SafeResponse;
}

const num = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * GET + JSON, avec les deux erreurs que WordPress rend et qu'il faut savoir raconter :
 * `rest_disabled` (403 posé par un plugin de sécurité — mesuré sur pixel-daily.example) et
 * `rest_no_route` (404 sur un point d'entrée absent — c'est ainsi qu'on découvre qu'un plugin
 * n'est pas installé).
 */
export async function getJson<T>(url: string, auth: WpAuth, timeoutMs = WP_TIMEOUT_MS): Promise<WpJson<T>> {
  const res = await safeFetch(url, { headers: authHeader(auth), timeoutMs });

  if (res.status >= 400) {
    let code = "";
    let message = "";
    try {
      const body = JSON.parse(res.text) as { code?: unknown; message?: unknown };
      code = typeof body.code === "string" ? body.code : "";
      message = typeof body.message === "string" ? body.message : "";
    } catch {
      /* corps non-JSON : le statut suffit à raconter l'échec */
    }
    throw new WpFetchError(
      "http",
      code === "rest_disabled"
        ? "l'API REST est désactivée sur ce site (403 rest_disabled) — un mot de passe applicatif est nécessaire"
        : code === "rest_no_route"
          ? "ce point d'entrée n'existe pas sur ce site (404 rest_no_route)"
          : message || `le site a répondu ${res.status}`,
      res.status,
    );
  }

  let data: T;
  try {
    data = JSON.parse(res.text) as T;
  } catch {
    // Le cas « pas WordPress » : une page HTML répond 200 à /wp-json. Mesuré sur bluefin-news.example.
    throw new WpFetchError("parse", "la réponse n'est pas du JSON — ce site n'expose pas d'API WordPress");
  }

  return {
    data,
    total: num(res.headers.get("x-wp-total")),
    totalPages: num(res.headers.get("x-wp-totalpages")),
    res,
  };
}

/* ------------------------------------------------------------------ *
 * Sonde
 * ------------------------------------------------------------------ */

export interface WpCapabilities {
  /** Namespaces annoncés par `/wp-json` — c'est là qu'on lit quels plugins exposent une API. */
  namespaces: string[];
  wpV2: boolean;
  /** `_embed` rend-il vraiment la vignette ? Mesuré sur un article réel, pas déduit du namespace. */
  embed: boolean;
  /** Le filtre `after=` est-il honoré ? Il porte toute la fraîcheur d'une occurrence de série. */
  dateFilter: boolean;
  /** ⛔ Faux sur les 5 sites sondés : l'UI doit griser « les plus lus » AVEC cette raison. */
  popularPosts: boolean;
  categories: number | null;
  tags: number | null;
  /**
   * Total rapporte par le site pour une requete sans filtre. ORDRE DE GRANDEUR, pas inventaire :
   * mesure le 20/08, la meme racine annonce 40 889 articles sans filtre et 95 141 avec un
   * `after=` large — des plugins de langue et de SEO changent le perimetre selon les parametres.
   * Ne jamais s en servir pour affirmer combien d articles une requete rendra.
   */
  posts: number | null;
  /** Un site qui redirige révèle son www/https réel — utile à montrer à l'opérateur. */
  redirects: number;
  siteName: string | null;
  probedAt: string;
}

export interface ProbeResult {
  ok: boolean;
  /** Racine réellement atteinte, redirections comprises — à proposer en remplacement de la saisie. */
  resolvedRoot: string;
  detail: string | null;
  capabilities: WpCapabilities;
}

const NS_POPULAR = "wordpress-popular-posts/v1";

/**
 * Date de contrôle du filtre `after`. Volontairement récente et bien formée : une date hors plage
 * (1970) est refusée par certains WordPress pour de mauvaises raisons, et on mesurerait alors la
 * validation de la date au lieu de la présence du filtre.
 */
const SONDE_AFTER = "2020-01-01T00:00:00";

/**
 * Interroge un site et rend ce qu'il sait faire.
 *
 * Ne lance JAMAIS : une sonde qui jette obligerait chaque appelant à traduire l'échec, et l'échec
 * EST le résultat intéressant (c'est le cas de 7 domaines sur 8). Il est rendu dans `detail`.
 */
export async function probe(root: string, auth: WpAuth): Promise<ProbeResult> {
  const vide: WpCapabilities = {
    namespaces: [],
    wpV2: false,
    embed: false,
    dateFilter: false,
    popularPosts: false,
    categories: null,
    tags: null,
    posts: null,
    redirects: 0,
    siteName: null,
    probedAt: new Date().toISOString(),
  };

  const normalized = normalizeRestRoot(root);
  if (normalized === "") {
    return { ok: false, resolvedRoot: root, detail: "URL invalide", capabilities: vide };
  }

  // 1. La racine : c'est elle qui annonce les namespaces, donc les plugins.
  let index: WpJson<{ name?: unknown; namespaces?: unknown }>;
  try {
    index = await getJson(restUrl(normalized, "/"), auth);
  } catch (e) {
    return {
      ok: false,
      resolvedRoot: normalized,
      detail: e instanceof Error ? e.message : "sonde impossible",
      capabilities: vide,
    };
  }

  const namespaces = Array.isArray(index.data.namespaces)
    ? index.data.namespaces.filter((n): n is string => typeof n === "string")
    : [];
  const caps: WpCapabilities = {
    ...vide,
    namespaces,
    wpV2: namespaces.includes("wp/v2"),
    popularPosts: namespaces.includes(NS_POPULAR),
    redirects: index.res.redirects,
    siteName: typeof index.data.name === "string" ? index.data.name : null,
  };

  // `/wp-json` a répondu, mais sans `wp/v2` il n'y a ni articles ni taxonomies à lire.
  if (!caps.wpV2) {
    return {
      ok: false,
      resolvedRoot: normalized,
      detail: "ce site expose une API REST mais pas le namespace wp/v2",
      capabilities: caps,
    };
  }

  // 2. Un article réel avec `_embed`. C'est LA capacité vitale : sans articles lisibles, la source
  //    ne sert à rien. Un échec ici condamne la source, et lui seul.
  try {
    const posts = await getJson<WpPost[]>(
      restUrl(normalized, "/wp/v2/posts", { per_page: 1, _embed: 1 }),
      auth,
    );
    caps.posts = posts.total;
    const first = Array.isArray(posts.data) ? posts.data[0] : undefined;
    // `_embed` peut être accepté sans rien rendre (article sans vignette) : on ne conclut « non »
    // que si le site n'a pas renvoyé la clé du tout.
    caps.embed = Boolean(first && first._embedded !== undefined);
  } catch (e) {
    return {
      ok: false,
      resolvedRoot: normalized,
      detail: e instanceof Error ? e.message : "lecture des articles impossible",
      capabilities: caps,
    };
  }

  // 3. Le filtre de date, DANS SA PROPRE REQUÊTE.
  //
  //    ⚠️ Mesuré le 20/08 : `atlas-review.example/en/` répond `Invalid parameter(s): after` alors que
  //    ses articles se lisent parfaitement. Tester `after` en même temps que `_embed` faisait donc
  //    échouer une source utilisable — l'option condamnait la capacité de base. Une sonde ne doit
  //    jamais laisser un supplément décider du verdict principal.
  //
  //    CONSÉQUENCE POUR LA RÉCURRENCE : `dateFilter: false` n'interdit pas la série, il déplace la
  //    borne de fraîcheur côté client (les dates sont dans chaque article). Ce qu'on perd, c'est de
  //    ne rapatrier QUE la fenêtre voulue — pas la fenêtre elle-même.
  try {
    await getJson<WpPost[]>(
      restUrl(normalized, "/wp/v2/posts", { per_page: 1, after: SONDE_AFTER }),
      auth,
    );
    caps.dateFilter = true;
  } catch {
    caps.dateFilter = false;
  }

  // 4. Taxonomies : leurs totaux disent à l'opérateur que le sélecteur aura du grain.
  for (const [path, key] of [
    ["/wp/v2/categories", "categories"],
    ["/wp/v2/tags", "tags"],
  ] as const) {
    try {
      const t = await getJson<unknown[]>(restUrl(normalized, path, { per_page: 1 }), auth);
      caps[key] = t.total;
    } catch {
      // Une taxonomie fermée ne condamne pas la source : on la laisse à `null` et l'UI le montre.
    }
  }

  return { ok: true, resolvedRoot: normalized, detail: null, capabilities: caps };
}

/* ------------------------------------------------------------------ *
 * Taxonomies
 * ------------------------------------------------------------------ */

export interface WpTerm {
  id: number;
  name: string;
  slug: string;
  count: number;
  parent: number;
}

/** Plafond de pagination : 3 pages × 100. Au-delà, un sélecteur n'est plus utilisable de toute façon. */
const TERM_PAGES = 3;

/**
 * Catégories ou étiquettes, triées par nombre d'articles décroissant.
 *
 * L'ordre est un choix d'usage : dans un site de presse, les trois catégories qui portent 90 % des
 * publications doivent être en haut du sélecteur, pas noyées dans l'ordre alphabétique.
 *
 * `truncated` remonte à l'UI quand la liste a été coupée. ⛔ Ne jamais taire une troncature : un
 * sélecteur incomplet et muet se lit comme « cette catégorie n'existe pas sur ce site ».
 *
 * ⚠️ `search` N'EST PAS UNE COMMODITÉ, c'est ce qui rend le sélecteur d'étiquettes utilisable.
 * atlas-review.example déclare 43 857 étiquettes (mesuré le 20/08) : sans recherche CÔTÉ SERVEUR, on
 * n'en aurait jamais que les 300 plus grosses, et filtrer cette liste localement répondrait
 * « aucun résultat » pour la quasi-totalité des étiquettes réelles du site. Un filtre local sur une
 * liste tronquée ne cherche pas, il ment. Avec `search`, WordPress cherche dans TOUT le site et on
 * ne demande qu'une page.
 */
export async function listTerms(
  root: string,
  auth: WpAuth,
  taxonomy: "categories" | "tags",
  search?: string,
): Promise<{ terms: WpTerm[]; truncated: boolean }> {
  const out: WpTerm[] = [];
  let truncated = false;

  const term = (search ?? "").trim().slice(0, 80);
  // Une recherche n'a pas besoin de trois pages : au-delà de 100 correspondances, l'utilisateur
  // affine sa saisie — c'est plus rapide pour lui que de faire défiler, et deux fois moins d'appels
  // vers un site qu'on ne contrôle pas.
  const pages = term ? 1 : TERM_PAGES;

  for (let page = 1; page <= pages; page++) {
    const r = await getJson<Record<string, unknown>[]>(
      restUrl(root, `/wp/v2/${taxonomy}`, {
        per_page: 100,
        page,
        orderby: "count",
        order: "desc",
        search: term || undefined,
      }),
      auth,
    );
    if (!Array.isArray(r.data)) break;

    for (const t of r.data) {
      const id = Number(t.id);
      if (!Number.isFinite(id)) continue;
      out.push({
        id,
        name: typeof t.name === "string" ? t.name : `#${id}`,
        slug: typeof t.slug === "string" ? t.slug : "",
        count: typeof t.count === "number" ? t.count : 0,
        parent: typeof t.parent === "number" ? t.parent : 0,
      });
    }

    if (r.data.length < 100) break;
    if (page === pages && (r.totalPages ?? page) > page) truncated = true;
  }

  return { terms: out, truncated };
}

/* ------------------------------------------------------------------ *
 * Articles
 * ------------------------------------------------------------------ */

export interface WpQuery {
  /** Ids NUMÉRIQUES. Plusieurs ids = OU (WordPress fait un `IN` sur la taxonomie). */
  categories?: number[];
  tags?: number[];
  /** Nombre d'articles voulus. Plafonné à `MAX_POOL`, et paginé au-delà de `PAGE_SIZE`. */
  limit?: number;
  /** Borne basse de publication, ISO. C'est la barrière de fraîcheur d'une occurrence de série. */
  after?: string;
  /** Borne haute — indispensable pour REJOUER une occurrence passée à l'identique. */
  before?: string;
  /** `date` (les derniers). « Les plus lus » n'est pas ici : aucun site sondé ne l'expose. */
  orderby?: "date";
  /**
   * Récolte SANS les médias — pour un pool qu'on va classer avant de choisir.
   *
   * ⛔ MESURÉ LE 03/09/2026, ET C'EST CE QUI REND LE CLASSEMENT POSSIBLE. Une page de 100 articles
   * avec `_embed` pèse 6,3 Mo chez northwind-sports et met 7,9 s — au-delà du plafond de 3 Mo du garde et du
   * budget de 10 s. La MÊME page en `_fields` pèse **33 Ko** et revient en **148 ms** : 190 fois
   * plus légère, 54 fois plus rapide. `_embed` embarque l'objet média complet, l'auteur et les
   * termes de CHAQUE article — tout ce dont un pool de classement n'a aucun besoin.
   *
   * ⚠️ Les candidats rendus n'ont donc ni image ni nom de catégorie. L'appelant doit ré-enrichir
   * ceux qu'il retient (`fetchPostsByIds`), sinon les cartes partiraient sans vignette.
   */
  sansMedia?: boolean;
}

/**
 * Les seuls champs dont un pool de classement a besoin : de quoi faire une carte identifiable
 * (titre, lien, date) et apparier l'audience (le lien). Le reste s'ajoute après la sélection.
 */
const POOL_FIELDS = "id,link,date,date_gmt,title,excerpt";

/** Cf. `GMAIL_CLIP_BYTES` (102 400 o) : au-delà d'une vingtaine d'articles, la fin de l'email — donc
 * le lien de désabonnement — est tronquée par Gmail. Le plafond est une règle de conformité. */
export const MAX_ARTICLES = 20;

/**
 * Combien d'articles on accepte de RAPATRIER pour en classer — à ne pas confondre avec
 * `MAX_ARTICLES`, qui borne ce qu'on RENDRA dans l'email.
 *
 * ⛔ LES DEUX PLAFONDS NE MESURENT PAS LA MÊME CHOSE, et les confondre produit une étiquette
 * fausse. Mesuré le 02/09/2026 par `X-WP-Total` sur la fenêtre 26/08 → 01/09 : northwind-sports publie 370
 * articles en sept jours, copper-kettle 304. Classer « les plus lus des sept derniers jours » sur
 * un pool de vingt reviendrait à classer **cinq heures** de publication sous une étiquette qui en
 * promet sept jours — le lecteur n'aurait aucun moyen de s'en apercevoir.
 *
 * 500 couvre la semaine entière de la source la plus prolifique avec de la marge, et vaut cinq
 * appels au pire. En pratique il en faut UN SEUL dès qu'une catégorie est choisie (mesuré :
 * northwind-sports/Futebol 83 articles sur sept jours, copper-kettle/Pronósticos 92) — et la boucle
 * s'arrête d'elle-même à la première page incomplète.
 */
export const MAX_POOL = 500;

/**
 * Taille de page. 100 est le maximum accepté par `wp/v2` (au-delà, WordPress rend un 400
 * `rest_invalid_param`).
 *
 * ⛔ ELLE DOIT RESTER CONSTANTE PENDANT UNE PAGINATION. `page` est un numéro de page, pas un
 * décalage : réduire `per_page` sur la dernière page pour ne demander que le reste ferait repartir
 * le curseur au début (`per_page=50&page=3` = articles 101-150, alors que 200 sont déjà lus). On
 * pagine donc à taille fixe et on coupe le surplus à la fin.
 */
const PAGE_SIZE = 100;

/** Ce que rend une récolte d'articles — la forme du jumeau RSS `fetchFeedPosts`. */
export interface WpPostsResult {
  candidates: WpCandidate[];
  /**
   * `x-wp-total` de la première page : combien d'articles la requête désigne côté site.
   *
   * ⚠️ Ordre de grandeur, pas inventaire — cf. `WpCapabilities.posts`. Il sert ici à dire « il y
   * en avait plus », jamais à affirmer un compte.
   */
  total: number | null;
  /**
   * Le site en avait plus que le plafond n'autorisait à rapatrier.
   *
   * ⛔ Ne jamais taire une troncature : un classement calculé sur un pool coupé et muet se lit
   * comme un classement sur la fenêtre entière.
   */
  truncated: boolean;
}

/**
 * SÉMANTIQUE DE FILTRAGE (décision D1, Alix 20/08) : **OU entre catégories, OU entre étiquettes,
 * ET entre les deux groupes**.
 *
 * Ce n'est pas une invention : c'est exactement ce que fait `wp/v2/posts` quand on lui passe
 * `categories=1,2` et `tags=7` — chaque paramètre devient une `tax_query` en `IN`, et les deux sont
 * combinées en `AND`. On documente la règle parce qu'elle est INVISIBLE dans l'URL et qu'un
 * relecteur pourrait légitimement supposer l'inverse.
 *
 * Le multi-catégories est une demande explicite, et l'API le permet sans surcoût.
 */
export async function fetchPosts(root: string, auth: WpAuth, query: WpQuery = {}): Promise<WpPostsResult> {
  const limit = Math.min(Math.max(query.limit ?? 5, 1), MAX_POOL);
  const taille = Math.min(limit, PAGE_SIZE);

  const candidates: WpCandidate[] = [];
  let total: number | null = null;

  // Un `limit` sous la taille de page ne fait qu'un tour — le chemin nominal du mode `date` ne
  // change donc pas de comportement, et ne paie aucun appel de plus.
  for (let page = 1; candidates.length < limit; page++) {
    const r = await getJson<WpPost[]>(
      restUrl(root, "/wp/v2/posts", {
        per_page: taille,
        page,
        // ⛔ L'un OU l'autre, jamais les deux : `_embed` est ce qui pèse, et le demander avec
        // `_fields` restreints le ferait payer sans que rien ne l'utilise.
        ...(query.sansMedia ? { _fields: POOL_FIELDS } : { _embed: 1 }),
        status: "publish",
        orderby: query.orderby ?? "date",
        order: "desc",
        categories: query.categories?.length ? query.categories.join(",") : undefined,
        tags: query.tags?.length ? query.tags.join(",") : undefined,
        after: query.after,
        before: query.before,
      }),
      auth,
      // Le budget des listes d'articles, pas celui de la sonde : cf. `WP_POSTS_TIMEOUT_MS` (mesuré).
      WP_POSTS_TIMEOUT_MS,
    );

    // Lu sur la PREMIÈRE page seulement : c'est la seule dont on sait qu'elle a été servie sans
    // que le curseur ait pu bouger sous nos pieds (un article publié entre deux pages décale tout).
    if (page === 1) total = r.total;

    if (!Array.isArray(r.data) || r.data.length === 0) break;
    candidates.push(...toCandidates(r.data));

    // Page incomplète = le site n'a plus rien à donner. C'est l'arrêt le plus sûr : il ne dépend
    // ni de `x-wp-totalpages` (absent sur certains plugins de cache) ni du total annoncé.
    if (r.data.length < taille) break;
  }

  const coupes = candidates.slice(0, limit);
  return {
    candidates: coupes,
    total,
    // On a rapatrié tout ce qu'on pouvait ET le site en annonçait davantage.
    truncated: coupes.length >= limit && total !== null && total > coupes.length,
  };
}

/**
 * Les articles d'une liste d'ids, AVEC leurs médias — le second temps d'un classement.
 *
 * ⛔ POURQUOI DEUX TEMPS. Le pool se récolte léger (cf. `WpQuery.sansMedia`) parce que `_embed` sur
 * cent articles pèse 6,3 Mo ; mais les articles RETENUS, eux, ont besoin de leur vignette et de
 * leur catégorie. On ne paie donc `_embed` que sur la douzaine qui part vraiment — un appel, une
 * centaine de kilo-octets.
 *
 * ⚠️ Ici `include` est légitime là où `fetchPost` le refuse : on demande un LOT et on apparie par
 * id. Un article disparu entre les deux appels est simplement absent de la réponse, et l'appelant
 * garde sa version légère — ce qui est le bon comportement, alors que pour un article unique une
 * liste vide serait indiscernable d'un filtre refusé.
 *
 * ⚠️ `orderby: "include"` conserve l'ordre demandé. L'appelant apparie quand même par id : deux
 * façons de se tromper valent mieux qu'une seule, et WordPress ignore silencieusement cet ordre
 * quand un plugin de tri s'en mêle.
 */
export async function fetchPostsByIds(root: string, auth: WpAuth, ids: string[]): Promise<WpCandidate[]> {
  const propres = ids
    .map((v) => Number(v))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, PAGE_SIZE);
  if (propres.length === 0) return [];

  const r = await getJson<WpPost[]>(
    restUrl(root, "/wp/v2/posts", {
      include: propres.join(","),
      per_page: propres.length,
      _embed: 1,
      orderby: "include",
    }),
    auth,
    WP_POSTS_TIMEOUT_MS,
  );
  return Array.isArray(r.data) ? toCandidates(r.data) : [];
}

/**
 * UN article, par son id WordPress — ce que demande le rafraîchissement d'un bloc déjà inséré.
 *
 * ⚠️ On interroge `/wp/v2/posts/{id}` et non `/wp/v2/posts?include={id}` : la seconde forme renvoie
 * une LISTE, et une liste vide (article dépublié, supprimé, passé en privé) est indiscernable
 * d'une liste que le site a refusé de filtrer. Ici, un article disparu répond 404, et 404 est une
 * information qu'on peut montrer à l'auteur.
 *
 * `null` = l'article n'existe plus sous cet id. L'appelant le DIT ; il ne remplace pas le bloc par
 * du vide, et il ne le laisse pas non plus croire qu'il est à jour.
 */
export async function fetchPost(root: string, auth: WpAuth, postId: string): Promise<WpCandidate | null> {
  const id = Number(postId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  try {
    const r = await getJson<WpPost>(restUrl(root, `/wp/v2/posts/${id}`, { _embed: 1 }), auth, WP_POSTS_TIMEOUT_MS);
    // Un post sans `id` exploitable n'est pas un post : mieux vaut « disparu » qu'un bloc rempli
    // de valeurs par défaut.
    return r.data && typeof r.data === "object" ? toCandidate(r.data) : null;
  } catch (e) {
    if (e instanceof WpFetchError && e.status === 404) return null;
    throw e;
  }
}
