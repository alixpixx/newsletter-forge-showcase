import { NextResponse } from "next/server";
import { SESSION_COOKIE, hashPassword, hashToken, requeteEnHttps, signSession } from "@/lib/auth";
import { acceptInvite, findByInviteHash } from "@/lib/data/app-user";
import { getDb } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Consommation d'un lien d'invitation : la personne choisit son mot de passe, le compte passe en
 * `active` et la session s'ouvre dans la foulée.
 *
 * ⚠️ Route volontairement hors session (le proxy exclut `api/auth`) : c'est le seul chemin par
 * lequel quelqu'un qui n'a pas encore de compte utilisable peut agir. Ce qui l'autorise, c'est la
 * détention du jeton — dont la base ne connaît que l'empreinte.
 *
 * ⚠️ L'opération n'est pas rejouable : `acceptInvite` filtre sur `status = 'invited'` et efface le
 * jeton. Un lien réutilisé ne touche donc aucune ligne, et rend le même refus qu'un lien inconnu.
 */

const MESSAGE_LIEN = "This invitation link is invalid or has already been used.";
const LONGUEUR_MIN = 12;
const TTL_SESSION_SEC = 60 * 60 * 24 * 7;

export async function POST(req: Request) {
  let body: { token?: string; password?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* body vide */
  }
  const jeton = (body.token ?? "").trim();
  const motDePasse = body.password ?? "";

  if (!jeton) return NextResponse.json({ error: MESSAGE_LIEN }, { status: 400 });
  if (motDePasse.length < LONGUEUR_MIN) {
    return NextResponse.json(
      { error: `Choose a password of at least ${LONGUEUR_MIN} characters.` },
      { status: 400 },
    );
  }

  const db = getDb();
  // Fail closed : sans base on ne peut ni vérifier le lien ni écrire l'empreinte. Un 400 ferait
  // croire à un lien mort et pousserait à en redemander un — alors que rien n'est en cause.
  if (!db) return NextResponse.json({ error: "Service unavailable. Try again shortly." }, { status: 503 });

  try {
    const compte = await findByInviteHash(db, await hashToken(jeton));
    if (!compte || compte.status !== "invited") {
      return NextResponse.json({ error: MESSAGE_LIEN }, { status: 400 });
    }

    const echeance = compte.invite_expires_at ? Date.parse(compte.invite_expires_at) : NaN;
    // Une échéance illisible est traitée comme dépassée : on ne devine pas une date valide.
    if (!Number.isFinite(echeance) || echeance < Date.now()) {
      return NextResponse.json(
        { error: "This invitation has expired. Ask an administrator for a new link." },
        { status: 410 },
      );
    }

    const active = await acceptInvite(db, compte.id, await hashPassword(motDePasse));
    // `null` = aucune ligne ne correspondait plus (lien consommé entre-temps). Sans cette
    // vérification, la course rendrait un succès alors que rien n'a été écrit.
    if (!active) return NextResponse.json({ error: MESSAGE_LIEN }, { status: 400 });

    const token = await signSession(
      { uid: active.id, email: active.email, role: active.role },
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
  } catch {
    return NextResponse.json({ error: "Service unavailable. Try again shortly." }, { status: 503 });
  }
}
