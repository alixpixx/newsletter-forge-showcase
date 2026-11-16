import { NextResponse } from "next/server";
import { AUTH, SESSION_COOKIE, hashPassword, requeteEnHttps, signSession, verifyPassword } from "@/lib/auth";
import {
  allAssetIds,
  countUsers,
  createUser,
  findByEmail,
  grantAsset,
  touchLastLogin,
  type AppUserRow,
} from "@/lib/data/app-user";
import { getDb } from "@/lib/supabase";

/**
 * Connexion. Les comptes vivent désormais dans `newsletter.app_user` ; AUTH_EMAIL / AUTH_PASSWORD
 * ne servent plus qu'à l'amorçage du tout premier compte (voir plus bas).
 *
 * ⚠️ Un seul message d'erreur, quelle que soit la cause : compte inexistant, mot de passe faux,
 * compte désactivé ou invitation non consommée. Un message par cause dirait à un inconnu quelles
 * adresses existent.
 */

const MESSAGE_REFUS = "Invalid email or password.";
const TTL_SESSION_SEC = 60 * 60 * 24 * 7;

/**
 * Ralentisseur de force brute, en mémoire.
 *
 * ⚠️ Honnêteté sur ce qu'il vaut : chaque instance serverless a le sien, donc il ne borne pas un
 * attaquant distribué. Il coupe l'essai en boucle depuis une seule connexion, ce qui est le cas
 * réel sur un outil interne, et il ne coûte ni table ni dépendance. La vraie barrière reste le
 * coût de PBKDF2 (210 000 itérations par essai).
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
  // Purge opportuniste : sans elle, la table grossit indéfiniment sur une instance longue.
  if (ESSAIS.size > 500) {
    for (const [k, v] of ESSAIS) if (Date.now() > v.jusqu) ESSAIS.delete(k);
  }
}

/**
 * Amorçage du premier compte, et lui seul.
 *
 * ⚠️ Ce chemin ne s'ouvre QUE si `app_user` est vide. Dès qu'un compte existe, il est
 * définitivement fermé — ce n'est donc pas un repli permanent, c'est une porte qui se condamne
 * derrière elle. Il évite d'avoir à faire transiter un mot de passe : Alix se connecte comme
 * avant, et le compte se crée avec le mot de passe qu'il vient de saisir, haché.
 */
async function amorcerPremierCompte(
  db: NonNullable<ReturnType<typeof getDb>>,
  email: string,
  motDePasse: string,
): Promise<AppUserRow | null> {
  if (!AUTH.seedEmail || !AUTH.seedPassword) return null;
  if (email.trim().toLowerCase() !== AUTH.seedEmail.trim().toLowerCase()) return null;
  if (motDePasse !== AUTH.seedPassword) return null;
  if ((await countUsers(db)) !== 0) return null;

  const compte = await createUser(db, {
    email: AUTH.seedEmail,
    role: "super_admin",
    status: "active",
    passwordHash: await hashPassword(motDePasse),
  });
  // Un super_admin voit toutes les marques de toute façon (lib/session.ts), mais on pose les
  // octrois explicitement : l'écran d'administration doit montrer un état lisible, pas un vide
  // qu'il faudrait interpréter.
  for (const assetId of await allAssetIds(db)) {
    await grantAsset(db, compte.id, assetId, compte.id);
  }
  return compte;
}

export async function POST(req: Request) {
  let body: { email?: string; password?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* body vide */
  }
  const email = (body.email ?? "").trim();
  const motDePasse = body.password ?? "";

  if (!email || !motDePasse) {
    return NextResponse.json({ error: MESSAGE_REFUS }, { status: 401 });
  }

  const cle = `${req.headers.get("x-forwarded-for") ?? "?"}|${email.toLowerCase()}`;
  if (tropDEssais(cle)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const db = getDb();
  if (!db) {
    // ⛔ Fail closed : sans base, on ne peut vérifier aucune identité. Répondre 401 laisserait
    // croire à un mot de passe faux ; 503 dit la vérité et n'ouvre rien.
    return NextResponse.json({ error: "Service unavailable. Try again shortly." }, { status: 503 });
  }

  let compte: AppUserRow | null;
  try {
    compte = await findByEmail(db, email);
    if (!compte) compte = await amorcerPremierCompte(db, email, motDePasse);
  } catch {
    return NextResponse.json({ error: "Service unavailable. Try again shortly." }, { status: 503 });
  }

  const recevable =
    compte !== null && compte.status === "active" && (await verifyPassword(motDePasse, compte.password_hash));

  if (!compte || !recevable) {
    noterEchec(cle);
    return NextResponse.json({ error: MESSAGE_REFUS }, { status: 401 });
  }

  ESSAIS.delete(cle);
  await touchLastLogin(db, compte.id);

  const token = await signSession(
    { uid: compte.id, email: compte.email, role: compte.role },
    TTL_SESSION_SEC,
  );
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
