/**
 * L'ORIGINE À IMPRIMER DANS UN LIEN QUI PART PAR E-MAIL.
 *
 * ⛔ CE QUE CE MODULE EXISTE POUR EMPÊCHER, et c'est mesuré, pas supposé. Le lien de confirmation
 * était bâti sur `new URL(req.url).origin`. Sur Vercel, cette origine portait le domaine public et
 * personne n'a rien vu. Dans un conteneur, le serveur Next écoute sur `HOSTNAME=0.0.0.0` et
 * `PORT=3000` (Dockerfile.public) : l'origine devient `https://0.0.0.0:3000`, et le lien envoyé à
 * une vraie personne ouvre « This site can't be reached ». Constaté le 18/09/2026 sur la
 * confirmation Copper Kettle, après le passage de Vercel à un hébergement auto-géré — un e-mail qui demande un
 * geste, puis qui rend ce geste impossible.
 *
 * L'ORDRE DES SOURCES EST PORTEUR DE SENS :
 *  1. la variable d'environnement, parce qu'elle est la seule VOULUE, et la seule qu'un en-tête
 *     falsifié ne peut pas déplacer (un `x-forwarded-host` forgé ferait pointer le lien de
 *     confirmation ailleurs — c'est un lien qu'on signe de notre marque) ;
 *  2. l'en-tête posé par le proxy, qui dit par quel nom l'appel est réellement entré ;
 *  3. l'URL de la requête, qui est juste en développement et fausse derrière un proxy.
 *
 * Et s'il n'en sort qu'une adresse d'écoute, on REFUSE. Un lien mort est pire que pas de lien :
 * l'inscription est perdue en silence, et la personne garde la preuve écrite qu'on l'a envoyée
 * nulle part.
 *
 * Fonction PURE : elle ne lit ni `process.env` ni `Request` d'elle-même — on lui passe ce qu'elle
 * doit trancher, pour qu'un banc puisse jouer les six cas sans serveur.
 */

/**
 * Adresses d'écoute : « toutes les interfaces ». Elles ne mènent NULLE PART, pas même sur la
 * machine qui écoute — c'est le cas du 18/09. Refusées en production comme en développement.
 */
const ADRESSES_D_ECOUTE = new Set(["0.0.0.0", "::", "[::]"]);

/** La machine elle-même : légitime quand on développe, jamais dans un e-mail qui part. */
const BOUCLE_LOCALE = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export interface SourcesOrigine {
  /** `req.url` — juste en développement, faux derrière un proxy. */
  urlRequete: string;
  /** Les en-têtes de la requête (`req.headers`). */
  enTetes: { get(nom: string): string | null };
  /** `PUBLIC_BASE_URL` puis `NEXT_PUBLIC_PUBLIC_BASE_URL`, dans cet ordre. */
  env: { PUBLIC_BASE_URL?: string | undefined; NEXT_PUBLIC_PUBLIC_BASE_URL?: string | undefined };
  /** En production, un hôte sans point (`public`, `web` : des noms de service Docker) est refusé. */
  production: boolean;
}

export type Origine = { ok: true; origine: string; source: "env" | "proxy" | "requete" } | { ok: false; raison: string };

/** `https://exemple.test/` → `https://exemple.test` ; `null` si la chaîne n'est pas une URL absolue. */
function normaliser(brut: string | null | undefined): URL | null {
  if (!brut) return null;
  try {
    return new URL(brut.trim());
  } catch {
    return null;
  }
}

/** Cette origine mène-t-elle quelque part depuis l'extérieur ? */
export function origineJoignable(u: URL, production: boolean): boolean {
  const hote = u.hostname.toLowerCase();
  if (ADRESSES_D_ECOUTE.has(hote)) return false;
  if (BOUCLE_LOCALE.has(hote)) return !production;
  // Un nom de service Docker (`public`, `worker`) résout dans le réseau du conteneur et nulle part
  // ailleurs. En développement on laisse passer : c'est là qu'on travaille sans domaine.
  if (production && !hote.includes(".")) return false;
  return u.protocol === "http:" || u.protocol === "https:";
}

export function origineEmail(s: SourcesOrigine): Origine {
  const candidates: Array<[URL | null, "env" | "proxy" | "requete"]> = [];

  candidates.push([normaliser(s.env.PUBLIC_BASE_URL ?? s.env.NEXT_PUBLIC_PUBLIC_BASE_URL), "env"]);

  const hoteProxy = s.enTetes.get("x-forwarded-host") ?? s.enTetes.get("host");
  if (hoteProxy) {
    // Le proxy peut annoncer plusieurs sauts : « a.test, b.test » — le premier est l'entrée publique.
    const premier = hoteProxy.split(",")[0]!.trim();
    const schema = (s.enTetes.get("x-forwarded-proto") ?? "https").split(",")[0]!.trim();
    candidates.push([normaliser(`${schema}://${premier}`), "proxy"]);
  }

  candidates.push([normaliser(s.urlRequete), "requete"]);

  for (const [u, source] of candidates) {
    if (u && origineJoignable(u, s.production)) return { ok: true, origine: u.origin, source };
  }

  const vu = candidates.find(([u]) => u !== null)?.[0]?.host ?? "(aucune)";
  return { ok: false, raison: `origine-non-publique:${vu}` };
}
