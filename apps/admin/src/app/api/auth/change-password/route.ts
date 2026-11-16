import { NextResponse } from "next/server";
import { SESSION_COOKIE, requeteEnHttps, signSession } from "@/lib/auth";
import { findById } from "@/lib/data/app-user";
import { getSessionUser } from "@/lib/session";
import { getDb } from "@/lib/supabase";
import { jsonError, readJson } from "@/app/api/builder/_shared";
import { changerSonMotDePasse } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * « Change password » — la personne connectée change SON mot de passe (pied de la barre latérale).
 *
 * ⛔ LE PROXY NE PROTÈGE PAS CETTE ROUTE : son matcher exclut tout `api/auth`. La session est donc
 * vérifiée ici, par `getSessionUser`, qui relit le compte en base (actif, et session pas antérieure
 * au dernier changement de mot de passe).
 *
 * Le changement date le compte (0091) : toutes les sessions ouvertes ailleurs tombent à leur
 * requête suivante. Celle-ci reçoit un cookie neuf, signé APRÈS l'écriture — la personne reste
 * connectée ici, et seulement ici.
 */

const TTL_SESSION_SEC = 60 * 60 * 24 * 7;

/**
 * Ralentisseur des mauvais mots de passe ACTUELS, en mémoire — même forme et même honnêteté que
 * celui de api/auth/login : il ne borne pas un attaquant distribué, il coupe l'essai en boucle
 * depuis une session volée. La clé est le compte, pas l'adresse IP : c'est le compte qu'on protège.
 */
const ESSAIS = new Map<string, { n: number; jusqu: number }>();
const FENETRE_MS = 15 * 60 * 1000;
const MAX_ESSAIS = 10;

function tropDEssais(cle: string): boolean {
  const e = ESSAIS.get(cle);
  if (!e || Date.now() > e.jusqu) return false;
  return e.n >= MAX_ESSAIS;
}

function noterEchec(cle: string): void {
  const e = ESSAIS.get(cle);
  if (!e || Date.now() > e.jusqu) ESSAIS.set(cle, { n: 1, jusqu: Date.now() + FENETRE_MS });
  else e.n += 1;
  if (ESSAIS.size > 500) {
    for (const [k, v] of ESSAIS) if (Date.now() > v.jusqu) ESSAIS.delete(k);
  }
}

export async function POST(req: Request) {
  const db = getDb();
  if (!db) return jsonError("Service unavailable. Try again shortly.", 503);

  const user = await getSessionUser();
  if (!user) return jsonError("unauthenticated", 401);

  if (tropDEssais(user.id)) return jsonError("Too many attempts. Try again later.", 429);

  let resultat: Awaited<ReturnType<typeof changerSonMotDePasse>>;
  try {
    const compte = await findById(db, user.id);
    if (!compte) return jsonError("unauthenticated", 401);
    resultat = await changerSonMotDePasse(await readJson<unknown>(req), compte, db);
  } catch {
    return jsonError("Service unavailable. Try again shortly.", 503);
  }

  if (!resultat.ok) {
    if (resultat.motDePasseFaux) noterEchec(user.id);
    return jsonError(resultat.erreur, resultat.statut);
  }
  ESSAIS.delete(user.id);

  const { compte } = resultat;
  const token = await signSession({ uid: compte.id, email: compte.email, role: compte.role }, TTL_SESSION_SEC);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: requeteEnHttps(req),
    path: "/",
    maxAge: TTL_SESSION_SEC,
  });
  return res;
}
