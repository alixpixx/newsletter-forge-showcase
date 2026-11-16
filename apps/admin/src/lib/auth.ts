/**
 * Auth maison : hachage des mots de passe, signature et vérification des sessions.
 *
 * ⚠️ Tout passe par Web Crypto (`crypto.subtle`), et c'est délibéré : c'est le seul modèle
 * disponible À LA FOIS dans le proxy (runtime Edge) et dans les route handlers (Node).
 * ⛔ Ni bcrypt ni argon2 (dépendances natives, absentes du runtime Edge), ni `Bun.password` —
 * Vercel exécute du Node, pas du Bun. Le hachage est donc PBKDF2-SHA256.
 *
 * ⚠️ Aucun identifiant de repli n'existe, dans AUCUN environnement : si AUTH_SECRET manque,
 * le module refuse de démarrer (fail-fast). Un repli était écrit en dur ici jusqu'au
 * 31/08/2026 ; il vivait dans l'historique git, donc il ne protégeait rien — et la mesure a
 * montré qu'il ouvrait réellement la production.
 *
 * La session ne fait qu'IDENTIFIER. Elle ne fait pas autorité sur les droits : `role` y est
 * embarqué pour que le proxy (Edge, sans accès à la base) puisse filtrer les pages réservées,
 * mais toute décision sur des données relit le compte en base — voir lib/session.ts.
 */

const enc = new TextEncoder();

export const SESSION_COOKIE = "nf_session";

/**
 * La requête est-elle arrivée en HTTPS — du point de vue du NAVIGATEUR ?
 *
 * ⛔ `new URL(req.url).protocol` NE RÉPOND PAS À CETTE QUESTION DERRIÈRE UN PROXY. Vercel comme
 * un reverse proxy auto-hébergé terminent TLS et reparlent à l'application EN CLAIR : `req.url` porte alors
 * l'hôte interne et le protocole `http:`. Le cookie de session partait donc **sans `Secure`** en
 * production — précisément ce que la mesure était censée éviter.
 *
 * ⚠️ LE COMMENTAIRE D'ORIGINE DISAIT « mesuré sur la requête réelle plutôt que sur NODE_ENV ».
 * L'intention était juste, la source était fausse — et le commentaire, en affirmant qu'une mesure
 * avait eu lieu, a endormi deux relectures. `api/users/route.ts` lisait déjà `x-forwarded-proto`
 * correctement, dans le même dossier.
 */
export function requeteEnHttps(req: Request): boolean {
  const transmis = req.headers.get("x-forwarded-proto");
  if (transmis) {
    // ⛔ L'en-tête peut porter une CHAÎNE de mandataires : « https,http ». Le premier maillon est
    // celui qu'a vu le navigateur ; comparer la chaîne entière à "https" rendrait false, et on
    // reviendrait exactement au défaut qu'on corrige.
    return transmis.split(",")[0].trim().toLowerCase() === "https";
  }
  return new URL(req.url).protocol === "https:";
}

/* `next build` évalue ce module sans forcément disposer des variables runtime :
   on ne veut pas casser le build, seulement refuser de SERVIR sans secret. */
const IS_BUILD = process.env.NEXT_PHASE === "phase-production-build";

function requireEnv(name: "AUTH_SECRET"): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;

  // Seule exception : la phase de build, qui n'a pas les variables runtime et ne sert rien.
  // La valeur vide est ensuite rejetée par signSession/verifySession — aucune session valide.
  if (IS_BUILD) return "";

  throw new Error(
    `[auth] ${name} is missing. Set it in the environment ` +
      `(apps/admin/.env.local in development) and restart — there is no built-in default.`,
  );
}

export const AUTH = {
  secret: requireEnv("AUTH_SECRET"),
  /* AUTH_EMAIL / AUTH_PASSWORD ne sont plus le moyen de se connecter : les comptes vivent dans
     newsletter.app_user. Ils ne servent QU'À l'amorçage du tout premier super_admin, tant que la
     table est vide (voir api/auth/login/route.ts). Optionnels, donc : leur absence n'empêche
     plus l'application de démarrer, elle rend seulement l'amorçage indisponible. */
  seedEmail: process.env.AUTH_EMAIL ?? "",
  seedPassword: process.env.AUTH_PASSWORD ?? "",
};

export type AppRole = "super_admin" | "member";

export type SessionPayload = {
  uid: string;
  email: string;
  role: AppRole;
  exp: number;
  /** Instant d'émission (ms). Absent des cookies signés avant le 01/10/2026 — voir `sessionPerimee`. */
  iat?: number;
};

// ---------------------------------------------------------------------------- base64url

function b64url(bytes: Uint8Array<ArrayBuffer>): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(str: string) {
  const norm = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  // Uint8Array adossé à un vrai ArrayBuffer : requis par BufferSource (Web Crypto) en TS 5.7+.
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function octetsAleatoires(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
}

/** Comparaison à temps constant : une comparaison qui s'arrête au premier octet différent
 *  laisse mesurer, essai après essai, combien d'octets sont déjà bons. */
function egalConstant(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------- mots de passe

/** Recommandation OWASP pour PBKDF2-HMAC-SHA256. Stocké dans l'empreinte : une valeur plus
 *  élevée pourra être adoptée plus tard sans invalider les empreintes déjà écrites. */
const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_LONGUEUR_BITS = 256;
const SEL_OCTETS = 16;

// `Uint8Array<ArrayBuffer>` et non `Uint8Array` nu : depuis TS 5.7 le type nu couvre aussi
// SharedArrayBuffer, que BufferSource (Web Crypto) refuse.
async function deriver(
  motDePasse: string,
  sel: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const cle = await crypto.subtle.importKey("raw", enc.encode(motDePasse), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: sel, iterations, hash: "SHA-256" },
    cle,
    PBKDF2_LONGUEUR_BITS,
  );
  return new Uint8Array(bits);
}

/** Format : `pbkdf2$<itérations>$<sel_b64url>$<empreinte_b64url>`. Le sel est tiré au hasard à
 *  chaque appel : deux hachages du même mot de passe ne se ressemblent pas, et les deux se
 *  vérifient. */
export async function hashPassword(motDePasse: string): Promise<string> {
  const sel = octetsAleatoires(SEL_OCTETS);
  const empreinte = await deriver(motDePasse, sel, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(sel)}$${b64url(empreinte)}`;
}

/** Rend `false` sur toute empreinte illisible plutôt que de lever : une ligne corrompue en base
 *  doit refuser la connexion, pas faire tomber la route (fail closed). */
export async function verifyPassword(motDePasse: string, stocke: string | null): Promise<boolean> {
  if (!stocke) return false;
  const parts = stocke.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iterations = Number(parts[1]);
  // Un nombre d'itérations trop bas rendrait l'empreinte cassable : on refuse plutôt que de
  // valider une empreinte affaiblie qui aurait été écrite par erreur ou par un tiers.
  if (!Number.isInteger(iterations) || iterations < 1_000 || iterations > 10_000_000) return false;

  try {
    const sel = unb64url(parts[2]);
    const attendu = unb64url(parts[3]);
    const calcule = await deriver(motDePasse, sel, iterations);
    return egalConstant(calcule, attendu);
  } catch {
    return false;
  }
}

/** Même seuil que le choix du mot de passe à l'invitation (api/auth/accept-invite). */
export const MOT_DE_PASSE_MIN = 12;
/** PBKDF2 hache l'entrée entière : un plafond évite qu'un corps de plusieurs mégaoctets coûte
 *  210 000 tours sur autant d'octets. Aucun gestionnaire de mots de passe n'approche ce seuil. */
export const MOT_DE_PASSE_MAX = 256;

/** Le motif de refus d'un nouveau mot de passe, ou `null` s'il est recevable. ⚠️ Ni `trim()` ni
 *  normalisation : un espace fait partie du mot de passe que la personne a choisi. */
export function refusMotDePasse(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return "Enter a password.";
  if (v.length < MOT_DE_PASSE_MIN) return `Choose a password of at least ${MOT_DE_PASSE_MIN} characters.`;
  if (v.length > MOT_DE_PASSE_MAX) return `Choose a password of at most ${MOT_DE_PASSE_MAX} characters.`;
  return null;
}

/** Empreinte d'un jeton d'invitation. On ne stocke jamais le jeton : une fuite de la table ne
 *  doit pas permettre d'activer les comptes en attente. */
export async function hashToken(jeton: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(jeton));
  return b64url(new Uint8Array(digest));
}

/** Jeton d'invitation : 32 octets d'entropie, transportables dans une URL. */
export function nouveauJeton(): string {
  return b64url(octetsAleatoires(32));
}

// ---------------------------------------------------------------------------- sessions

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(AUTH.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSession(
  identite: { uid: string; email: string; role: AppRole },
  ttlSec = 60 * 60 * 24 * 7,
): Promise<string> {
  const maintenant = Date.now();
  const payload: SessionPayload = {
    uid: identite.uid,
    email: identite.email,
    role: identite.role,
    exp: maintenant + ttlSec * 1000,
    iat: maintenant,
  };
  const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(payloadB64)));
  return `${payloadB64}.${b64url(sig)}`;
}

/**
 * ⛔ Une session au format d'avant le 31/08/2026 — `{email, exp}` sans `uid` — est REFUSÉE.
 * Un repli qui l'accepterait devrait deviner à quel compte elle appartient ; ce chemin de
 * secours resterait ouvert pour toujours. Les sessions en cours retombent sur /login, une fois.
 */
export async function verifySession(token?: string): Promise<SessionPayload | null> {
  if (!token || !AUTH.secret) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), unb64url(sigB64), enc.encode(payloadB64));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64url(payloadB64))) as Partial<SessionPayload>;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    if (typeof payload.uid !== "string" || payload.uid.length === 0) return null;
    if (typeof payload.email !== "string" || payload.email.length === 0) return null;
    if (payload.role !== "super_admin" && payload.role !== "member") return null;
    // `iat` absent est un cookie d'avant le 01/10/2026, recevable ; `iat` présent mais pas un
    // nombre n'a été écrit par aucune version de ce code.
    if (payload.iat !== undefined && typeof payload.iat !== "number") return null;
    return { uid: payload.uid, email: payload.email, role: payload.role, exp: payload.exp, iat: payload.iat };
  } catch {
    return null;
  }
}

/**
 * Cette session a-t-elle été émise AVANT le dernier changement de mot de passe du compte (0091) ?
 * Si oui, elle ne vaut plus rien : c'est ce qui fait qu'un nouveau mot de passe coupe toutes les
 * sessions ouvertes avec l'ancien, alors que la base ne tient aucune liste de sessions.
 *
 * ⛔ Un cookie SANS `iat` compte comme émis à l'instant 0. Il a forcément été signé avant la mise
 * en ligne de `iat`, donc avant tout changement que ce code a pu dater : le laisser passer
 * rouvrirait, pendant sept jours, l'accès qu'on vient de fermer.
 * ⛔ Une date illisible ferme la session (fail closed) : on ne devine pas une date valide.
 */
export function sessionPerimee(iat: number | undefined, motDePasseChangeLe: string | null): boolean {
  if (!motDePasseChangeLe) return false;
  const change = Date.parse(motDePasseChangeLe);
  if (!Number.isFinite(change)) return true;
  return (iat ?? 0) < change;
}
