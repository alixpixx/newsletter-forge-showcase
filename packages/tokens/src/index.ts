/**
 * Signature/vérification des tokens — SOURCE UNIQUE partagée par apps/public ET apps/worker.
 *
 * ⚠️ Contrat compliance-load-bearing : le format (base64url + préfixe de scope + parse
 * `lastIndexOf('.')`) et le `TOKEN_SECRET` DOIVENT être identiques des deux côtés. Si le
 * worker signait des liens unsub/prefs différents de ce que le site public vérifie, AUCUN
 * abonné ne pourrait se désinscrire → violation CAN-SPAM/LGPD/GDPR, invisible jusqu'à plainte.
 * D'où l'extraction en package partagé (jamais dupliquer cette logique).
 *
 * Pur `node:crypto`, zéro dépendance — fonctionne en Node (routes Next) et en Bun (worker).
 */
import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Repli de DÉVELOPPEMENT. Exporté (au lieu d'être recopié dans chaque garde de boot) parce que
 * les deux côtés doivent reconnaître EXACTEMENT la même valeur : une garde qui compare à un
 * littéral divergent laisserait passer le secret de dev en croyant refuser.
 * ⛔ Aucun environnement de production ne doit jamais tourner avec cette valeur.
 */
export const DEV_TOKEN_SECRET = "nf-public-dev-secret-change-in-prod";

/**
 * Témoin d'EMPREINTE du secret, journalisé au boot des DEUX côtés (site public + worker).
 *
 * ⛔ Le défaut que ça, et rien d'autre, rend visible : un TOKEN_SECRET RÉEL mais DIFFÉRENT de
 * celui d'en face. Aucune garde locale ne peut le voir — chaque côté ne connaît que sa propre
 * valeur — et le symptôme est MUET : le serveur démarre, la page répond 200 « Invalid link », et
 * personne n'apprend que la désinscription est cassée (CAN-SPAM/LGPD). Deux lignes de log de
 * déploiement comparées à l'œil le tranchent en une seconde.
 *
 * Pourquoi 8 caractères hexa et jamais le secret : sha256 est à sens unique et 8 hexa n'en gardent
 * que 32 bits. Mesuré plutôt que supposé : sur 400 000 secrets aléatoires de 48 caractères,
 * 18 PAIRES de secrets DIFFÉRENTS partagent déjà la même empreinte — une empreinte ne désigne donc
 * aucun secret en particulier. La sortie est de longueur FIXE : elle ne trahit même pas la
 * longueur du secret, et un caractère de plus la change entièrement (avalanche).
 * ⛔ Ne JAMAIS élargir cette troncature, ni journaliser la longueur, un préfixe ou quoi que ce soit
 * d'autre du secret : c'est ce qui ferait de ce témoin une fuite.
 */
export function tokenSecretFingerprint(secret: string | undefined | null): string {
  if (!secret) return "absent";
  return sha256(secret).slice(0, 8);
}

const SECRET = process.env.TOKEN_SECRET ?? DEV_TOKEN_SECRET;

/* ---------- Double opt-in : token aléatoire, stocké HASHÉ ---------- */

export function newDoiToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha256(raw) };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/* ---------- Jeton de formulaire signé (anti-spam, horloge SERVEUR) ---------- */

/** Émis au rendu du form. `<ts>.<hmac>`. Robuste : une seule horloge, inviolable. */
export function signForm(ts: number = Date.now()): string {
  const sig = createHmac("sha256", SECRET).update(`form:${ts}`).digest("base64url");
  return `${ts}.${sig}`;
}

/** Renvoie le timestamp d'émission si le jeton est valide, sinon null. */
export function verifyForm(token: string | undefined | null): number | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const ts = Number(token.slice(0, dot));
  if (!Number.isFinite(ts)) return null;
  const expected = createHmac("sha256", SECRET).update(`form:${ts}`).digest("base64url");
  try {
    const a = Buffer.from(token.slice(dot + 1));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return ts;
  } catch {
    return null;
  }
}

/* ---------- Désinscription : lien signé HMAC (sans état) ---------- */

/** Token = `<subscriptionId>.<hmac>`. Pas besoin de le stocker. */
export function signUnsub(subscriptionId: string): string {
  const sig = createHmac("sha256", SECRET).update(`unsub:${subscriptionId}`).digest("base64url");
  return `${subscriptionId}.${sig}`;
}

export function verifyUnsub(token: string | undefined | null): string | null {
  return verifyScoped("unsub", token);
}

/* ---------- Centre de préférences / DSAR : lien signé par ABONNÉ ---------- */

/** Token = `<subscriberId>.<hmac>`. Donne accès à TOUTES les souscriptions de l'abonné. */
export function signPrefs(subscriberId: string): string {
  const sig = createHmac("sha256", SECRET).update(`prefs:${subscriberId}`).digest("base64url");
  return `${subscriberId}.${sig}`;
}

export function verifyPrefs(token: string | undefined | null): string | null {
  return verifyScoped("prefs", token);
}

/** Vérifie un token `<id>.<hmac>` pour un préfixe donné. Renvoie l'id ou null. */
function verifyScoped(scope: string, token: string | undefined | null): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", SECRET).update(`${scope}:${id}`).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return id;
  } catch {
    return null;
  }
}
