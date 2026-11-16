import { lookup } from "node:dns/promises";

/**
 * PORTE SORTANTE — le seul endroit du produit qui va chercher une URL fournie par un opérateur.
 *
 * Pourquoi ce fichier est plus dur qu'un simple contrôle d'URL :
 * l'admin newsletter tourne sur l'infrastructure qui détient la clé `service_role` de Supabase et
 * la PII des abonnés. Une requête sortante contrôlée par la valeur d'un champ texte y vaut
 * bien plus qu'ailleurs. Valider l'URL de DÉPART puis laisser `fetch` suivre les
 * redirections tout seul ne suffit pas : il suffit qu'un hôte public réponde `302 → http://169.254.169.254/`
 * pour que le garde soit contourné sans jamais avoir menti sur l'URL saisie.
 *
 * Quatre durcissements, tous portés par `safeFetch` :
 *  1. `redirect: "manual"` — chaque saut est ré-examiné par `assertFetchableUrl`, jamais suivi en
 *     aveugle, et l'en-tête `authorization` est LARGUÉ dès que l'origine change.
 *  2. Résolution DNS vérifiée : un nom public qui pointe vers 169.254.169.254 ou 10.x est rejeté.
 *     Le contrôle textuel de l'hôte, seul, ne voit rien de ce cas — c'est le trou classique.
 *  3. Budget de temps EXPLICITE sur toute la chaîne (connexion + redirections + lecture du corps).
 *     Sans lui, un hôte qui accepte la connexion et n'envoie rien immobilise une fonction Vercel.
 *  4. Taille de réponse plafonnée, vérifiée sur les OCTETS reçus et pas seulement sur
 *     `content-length` (qu'un serveur hostile peut mentir ou omettre).
 */

/** Budget de temps pour UNE requête complète, redirections et lecture du corps comprises. */
export const WP_TIMEOUT_MS = 10_000;

/**
 * Budget des LISTES D'ARTICLES (`/wp/v2/posts`, avec `_embed`) — celles qui font une édition et son aperçu.
 *
 * ⛔ MESURÉ LE 25/09/2026 : une édition Northwind Sports a été retenue, et l'aperçu de l'éditeur a échoué, sur
 * « n'a pas répondu en 10000 ms ». Sa requête de gel exacte (16 articles, `_embed=1`, 1,25 Mo), rejouée
 * 19 fois hors cache depuis l'extérieur : premier octet entre 1,7 et 9,8 s, trois fois au-delà de 8 s ;
 * une variante de la même requête (`_embed=wp:featuredmedia,author`) a mis **18,6 s**. C'est la
 * GÉNÉRATION côté site qui traîne, pas le transfert. Dix secondes coupaient donc des réponses qui
 * arrivaient. La sonde de connexion et les taxonomies gardent `WP_TIMEOUT_MS` : un site mort doit
 * s'y dire vite.
 */
export const WP_POSTS_TIMEOUT_MS = 30_000;

/** Plafond de corps. Une page de 100 termes ou 10 articles `_embed` pèse ~1 Mo au pire. */
export const WP_MAX_BYTES = 3_000_000;

/** Au-delà, c'est une boucle ou un site mal configuré — pas une redirection légitime. */
export const WP_MAX_REDIRECTS = 3;

export type WpFetchErrorKind =
  | "url" /** l'URL est invalide ou d'un schéma refusé */
  | "blocked" /** l'URL vise une adresse que nous refusons d'atteindre */
  | "dns" /** l'hôte ne se résout pas */
  | "timeout" /** budget de temps épuisé */
  | "too_large" /** corps au-delà du plafond */
  | "redirect" /** redirection cassée ou trop longue */
  | "network" /** connexion impossible, TLS refusé… */
  | "http" /** le serveur a répondu, avec un statut d'erreur */
  | "parse"; /** 200 mais le corps n'est pas le JSON attendu — mesuré : bluefin-news.example sert du HTML sur /wp-json */

/**
 * Erreur TYPÉE, parce que l'appelant en fait des choses différentes : « blocked » se raconte à
 * l'opérateur (il a saisi une mauvaise URL), « timeout » et « network » décrivent le site distant,
 * « http » porte un statut à afficher tel quel.
 */
export class WpFetchError extends Error {
  readonly kind: WpFetchErrorKind;
  readonly status: number | null;

  constructor(kind: WpFetchErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "WpFetchError";
    this.kind = kind;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * Adresses
 * ------------------------------------------------------------------ */

/**
 * Vrai pour tout ce qui n'a rien à faire au bout d'une requête sortante : boucle locale, réseaux
 * RFC1918, link-local (dont 169.254.169.254 — les métadonnées d'instance cloud), CGNAT.
 *
 * Prend une adresse littérale, jamais un nom : les noms passent par `assertPublicHost`.
 */
export function isPrivateAddress(raw: string): boolean {
  const addr = raw.replace(/^\[|\]$/g, "").toLowerCase();

  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || // 0.0.0.0/8 — « cet hôte »
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT : réseau de l'hébergeur, pas Internet
      (a === 169 && b === 254) || // link-local, dont les métadonnées d'instance
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast + réservé
    );
  }

  if (!addr.includes(":")) return false; // ni IPv4 ni IPv6 : ce n'est pas une adresse

  if (addr === "::" || addr === "::1") return true;
  // IPv4 encapsulée (::ffff:127.0.0.1) : c'est la partie v4 qui décide.
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  // fc00::/7 (unique-local), fe80::/10 (link-local).
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(addr);
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data", // métadonnées EC2 en nom court
]);

/**
 * Garde SYNCHRONE et PURE sur l'URL elle-même : schéma, absence d'identifiants inline, hôte.
 * Testable sans réseau, appelée sur l'URL de départ ET sur chaque `Location` reçu.
 *
 * Renvoie l'URL analysée pour que l'appelant n'ait pas à la reparser (et ne puisse pas partir
 * d'une chaîne différente de celle qu'on vient de valider).
 */
export function assertFetchableUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WpFetchError("url", `"${raw}" n'est pas une URL valide`);
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new WpFetchError("url", "l'URL doit être en http(s)");
  }

  // `http://evil.com@10.0.0.1/` : l'œil lit evil.com, le résolveur lit 10.0.0.1. On refuse la
  // forme entière plutôt que d'arbitrer — un site WordPress n'a jamais d'identifiants dans l'URL.
  if (u.username || u.password) {
    throw new WpFetchError("url", "l'URL ne doit pas contenir d'identifiants (user:pass@)");
  }

  const host = u.hostname.toLowerCase();
  if (!host) throw new WpFetchError("url", "l'URL n'a pas d'hôte");

  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  ) {
    throw new WpFetchError("blocked", `l'hôte "${host}" n'est pas autorisé`);
  }

  // Formes numériques déguisées : `http://2130706433/` et `http://0x7f000001/` sont deux écritures
  // de 127.0.0.1 que la comparaison textuelle en pointillés laisse passer.
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) {
    throw new WpFetchError("blocked", `l'hôte "${host}" est une adresse numérique déguisée`);
  }

  if (isPrivateAddress(host)) {
    throw new WpFetchError("blocked", `l'hôte "${host}" est une adresse privée ou locale`);
  }

  return u;
}

/**
 * Le nom se résout-il vers une adresse publique ?
 *
 * Séparée d'`assertFetchableUrl` parce qu'elle touche le réseau : le garde textuel reste pur et
 * testable, celui-ci s'exécute juste avant chaque saut.
 *
 * ⚠️ Il reste une fenêtre TOCTOU (« DNS rebinding ») : entre notre résolution et celle de la pile
 * TCP, un enregistrement à TTL 0 peut changer de réponse. La fermer demanderait d'épingler l'IP
 * puis de faire la requête dessus en réécrivant le SNI et l'en-tête Host — hors de proportion ici.
 * Ce contrôle élimine le cas réel : un nom public pointé sur 169.254.169.254 ou sur du RFC1918.
 */
export async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.toLowerCase();
  // Littéral : déjà tranché par `assertFetchableUrl`, rien à résoudre.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new WpFetchError("dns", `l'hôte "${host}" ne se résout pas`);
  }

  if (addresses.length === 0) {
    throw new WpFetchError("dns", `l'hôte "${host}" ne se résout vers aucune adresse`);
  }
  // TOUTES les adresses doivent être publiques : un enregistrement mixte (une publique, une
  // privée) laisserait le choix à la pile TCP, donc au hasard.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new WpFetchError("blocked", `l'hôte "${host}" se résout vers une adresse privée (${address})`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Authentification
 * ------------------------------------------------------------------ */

export interface WpAuth {
  kind: "none" | "app_password";
  user?: string | null;
  /** Mot de passe applicatif — vient d'une variable d'environnement, jamais de la base. */
  secret?: string | null;
}

/** En-tête Basic pour un mot de passe applicatif WordPress, ou rien du tout. */
export function authHeader(auth: WpAuth | null | undefined): Record<string, string> {
  if (!auth || auth.kind !== "app_password" || !auth.user || !auth.secret) return {};
  const token = Buffer.from(`${auth.user}:${auth.secret}`).toString("base64");
  return { authorization: `Basic ${token}` };
}

/* ------------------------------------------------------------------ *
 * Requête
 * ------------------------------------------------------------------ */

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface SafeResponseBase {
  /** URL réellement atteinte, redirections comprises. */
  url: string;
  status: number;
  headers: Headers;
  /** Nombre de redirections suivies — la sonde le remonte (un site qui redirige révèle son www/https réel). */
  redirects: number;
}

export interface SafeResponse extends SafeResponseBase {
  /** Corps décodé en UTF-8, plafonné à `maxBytes`. */
  text: string;
}

export interface SafeBytesResponse extends SafeResponseBase {
  /** Corps BRUT, plafonné à `maxBytes`. Une image décodée en UTF-8 serait irrémédiablement corrompue. */
  bytes: Uint8Array;
  /** Type ANNONCÉ par le serveur. Indicatif : le type réel se renifle sur les octets (`sniffImageMime`). */
  contentType: string | null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Lit le corps en plafonnant les OCTETS REÇUS.
 *
 * `content-length` sert de refus rapide quand il est présent et honnête ; il ne peut pas servir de
 * garantie (chunked, ou serveur qui ment). Le vrai plafond se compte pendant la lecture, et on
 * annule le flux dès qu'il est franchi plutôt que de finir de télécharger pour jeter ensuite.
 */
async function readCappedBytes(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const announced = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(announced) && announced > maxBytes) {
    throw new WpFetchError("too_large", `${url} annonce ${announced} octets (plafond ${maxBytes})`);
  }

  if (!res.body) return new Uint8Array(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WpFetchError("too_large", `${url} dépasse le plafond de ${maxBytes} octets`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof WpFetchError) throw e;
    if (isAbort(e)) throw new WpFetchError("timeout", `${url} n'a pas fini de répondre à temps`);
    throw new WpFetchError("network", `lecture interrompue sur ${url}`);
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return joined;
}

/** Même lecture plafonnée, rendue en texte. Le décodage est la SEULE différence entre les deux. */
const readCapped = async (res: Response, maxBytes: number, url: string): Promise<string> =>
  new TextDecoder("utf-8").decode(await readCappedBytes(res, maxBytes, url));

const isAbort = (e: unknown): boolean =>
  e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");

/**
 * GET vers un hôte arbitraire, sous garde.
 *
 * Seul `GET` est exposé : rien dans ce produit n'écrit sur un WordPress, et une redirection qui
 * transformerait un POST en GET (303) est un problème qu'on n'a pas besoin d'avoir.
 *
 * Le budget de temps couvre TOUTE la chaîne, pas chaque saut : trois redirections de 9 s chacune
 * seraient trois fois le budget si on le remettait à zéro à chaque fois.
 */
async function fetchGuarded<T>(
  rawUrl: string,
  opts: SafeFetchOptions,
  read: (res: Response, maxBytes: number, url: string) => Promise<T>,
): Promise<SafeResponseBase & { body: T }> {
  const timeoutMs = opts.timeoutMs ?? WP_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? WP_MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = assertFetchableUrl(rawUrl);
    // Annoté : sans ça TypeScript fige le type sur `{ accept: string }` et le retrait de
    // l'en-tête d'authentification plus bas ne compile pas.
    let headers: Record<string, string> = {
      accept: "application/json, text/xml, */*",
      ...(opts.headers ?? {}),
    };
    let origin = current.origin;

    for (let hop = 0; hop <= WP_MAX_REDIRECTS; hop++) {
      await assertPublicHost(current);

      let res: Response;
      try {
        res = await fetch(current, {
          method: "GET",
          headers,
          redirect: "manual", // ← aucun saut n'échappe au garde
          // ⚠️ `cache` existe dans les types DOM/Node mais PAS dans ceux de Bun, et ce paquet est
          // désormais compilé des DEUX côtés (l'admin sous Node, le worker sous Bun). L'option est
          // gardée — elle a un sens partout à l'exécution — et le cast est là pour que la
          // divergence de TYPES ne fasse pas échouer un build qui n'a rien à se reprocher.
          ...({ cache: "no-store" } as { cache: "no-store" }),
          signal: controller.signal,
        });
      } catch (e) {
        if (isAbort(e)) throw new WpFetchError("timeout", `${current.href} n'a pas répondu en ${timeoutMs} ms`);
        throw new WpFetchError("network", `impossible de joindre ${current.href}`);
      }

      if (!REDIRECT_STATUSES.has(res.status)) {
        const body = await read(res, maxBytes, current.href);
        return { url: current.href, status: res.status, headers: res.headers, body, redirects: hop };
      }

      // Redirection : le corps ne nous intéresse pas, mais laisser le flux ouvert fuit une socket.
      await res.body?.cancel().catch(() => {});

      const location = res.headers.get("location");
      if (!location) {
        throw new WpFetchError("redirect", `${current.href} redirige (${res.status}) sans en-tête Location`);
      }
      if (hop === WP_MAX_REDIRECTS) {
        throw new WpFetchError("redirect", `plus de ${WP_MAX_REDIRECTS} redirections depuis ${rawUrl}`);
      }

      let next: URL;
      try {
        next = new URL(location, current); // Location peut être relatif
      } catch {
        throw new WpFetchError("redirect", `Location illisible depuis ${current.href} : "${location}"`);
      }

      // Le garde s'applique à la destination comme à l'URL saisie — c'est tout l'intérêt du saut manuel.
      current = assertFetchableUrl(next.href);

      if (current.origin !== origin) {
        // On ne présente pas les identifiants d'un site à un autre. Un WordPress qui redirige vers
        // un domaine tiers n'a aucun titre à recevoir le mot de passe applicatif.
        //
        // Le filtre est insensible à la CASSE, et c'est le point qui compte : les noms d'en-tête
        // HTTP le sont (RFC 9110 §5.1). Un appelant qui passe `Authorization` avec une majuscule
        // — l'orthographe la plus courante — aurait traversé une destructuration sur la seule clé
        // en minuscules, et le secret serait parti vers le domaine tiers. Le garde ne doit pas
        // dépendre de la façon dont son appelant a orthographié la clé.
        headers = Object.fromEntries(
          Object.entries(headers).filter(([k]) => k.toLowerCase() !== "authorization"),
        );
        origin = current.origin;
      }
    }

    // Inatteignable : la boucle sort par `return` ou par `throw`.
    throw new WpFetchError("redirect", `redirections non résolues depuis ${rawUrl}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET texte sous garde. Enveloppe de `fetchGuarded` — la chaîne de redirections, le retrait de
 * l'en-tête d'authentification hors-origine et le plafond d'octets sont écrits UNE fois.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const { body, ...rest } = await fetchGuarded(rawUrl, opts, readCapped);
  return { ...rest, text: body };
}

/**
 * GET BINAIRE sous garde — les vignettes d'articles WordPress passent par ici.
 *
 * Exactement les mêmes barrières que `safeFetch` (adresses privées refusées, redirections comptées
 * et re-vérifiées, secret jamais présenté à un autre domaine, plafond d'octets appliqué pendant la
 * lecture). Seule la lecture finale change : décoder une image en UTF-8 la détruirait.
 *
 * ⚠️ `contentType` est ce que le serveur ANNONCE. Il ne décide de rien : le type réel se renifle sur
 * les octets reçus (`sniffImageMime`), sans quoi un SVG annoncé `image/png` deviendrait une XSS
 * stockée servie depuis notre propre domaine.
 */
export async function safeFetchBytes(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeBytesResponse> {
  const { body, ...rest } = await fetchGuarded(
    rawUrl,
    // `accept` n'est PAS une option de haut niveau : c'est un en-tête. Le passer à côté de
    // `headers` l'aurait fait ignorer en silence, et on aurait demandé du JSON à une image.
    { ...opts, headers: { accept: "image/*", ...(opts.headers ?? {}) } },
    readCappedBytes,
  );
  return { ...rest, bytes: body, contentType: rest.headers.get("content-type") };
}

/** `safeFetch` + parse JSON. Un corps non-JSON est une erreur nette, pas un `null` silencieux. */
export async function safeFetchJson<T>(rawUrl: string, opts: SafeFetchOptions = {}): Promise<{ data: T; res: SafeResponse }> {
  const res = await safeFetch(rawUrl, opts);
  if (res.status < 200 || res.status >= 300) {
    throw new WpFetchError("http", `${res.url} a répondu ${res.status}`, res.status);
  }
  try {
    return { data: JSON.parse(res.text) as T, res };
  } catch {
    throw new WpFetchError("http", `${res.url} n'a pas renvoyé du JSON`, res.status);
  }
}
