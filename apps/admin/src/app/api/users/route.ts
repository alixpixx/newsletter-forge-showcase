import { NextResponse } from "next/server";
import { hashToken, nouveauJeton } from "@/lib/auth";
import { lireBooleenOptionnel } from "@/lib/acces";
import { createUser, findByEmail, replaceInvite, setAssets } from "@/lib/data/app-user";
import { isEmail, jsonError, readJson, requireSuperAdmin } from "@/app/api/builder/_shared";

/**
 * Invitation d'un compte. Réservé aux administrateurs.
 *
 * ⚠️ Le jeton n'est montré QU'ICI, une seule fois, dans la réponse. La base n'en garde que
 * l'empreinte : personne — pas même un administrateur relisant la table — ne peut reconstituer un
 * lien déjà émis. Perdre le lien avant de l'avoir transmis oblige donc à ré-inviter, et c'est
 * volontaire.
 *
 * ⛔ Aucun e-mail n'est envoyé. Le worker d'envoi est armé sur de vrais abonnés et son passage en
 * mode réel est une décision d'Alix : une route d'administration ne va pas lui donner un premier
 * client par effet de bord. Le lien se transmet à la main.
 */

const DUREE_INVITATION_MS = 7 * 24 * 60 * 60 * 1000;

/** L'origine vue par le navigateur — derrière Vercel, `req.url` porte l'hôte interne. */
function origine(req: Request): string {
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  const garde = await requireSuperAdmin();
  if (!garde.ok) return garde.res;
  const { db, user } = garde.ctx;

  const body =
    (await readJson<{
      email?: string;
      role?: string;
      assetIds?: unknown;
      allAssets?: unknown;
      allTemplates?: unknown;
    }>(req)) ?? {};
  const email = (body.email ?? "").trim();
  if (!isEmail(email)) return jsonError("A valid email address is required.", 400);

  const role = body.role === "super_admin" ? "super_admin" : "member";
  const assetIds = Array.isArray(body.assetIds)
    ? [...new Set(body.assetIds.map(String).filter(Boolean))]
    : [];
  // « All brands » et « All templates » (0075), validés SÉPARÉMENT : ce sont deux droits distincts,
  // et l'un mal typé ne doit pas se glisser derrière l'autre. Refusés s'ils ne sont pas de vrais
  // booléens — voir lib/acces.ts, où `"false"` serait « truthy ».
  const marques = lireBooleenOptionnel(body.allAssets);
  if (!marques.ok) return jsonError("allAssets must be true or false.", 400);
  const modeles = lireBooleenOptionnel(body.allTemplates);
  if (!modeles.ok) return jsonError("allTemplates must be true or false.", 400);

  const jeton = nouveauJeton();
  const empreinte = await hashToken(jeton);
  const expire = new Date(Date.now() + DUREE_INVITATION_MS).toISOString();

  try {
    const existant = await findByEmail(db, email);

    if (existant) {
      // Ré-inviter quelqu'un dont le lien a expiré est le geste attendu ; réécrire l'invitation
      // d'un compte déjà actif serait un moyen détourné de lui reprendre son mot de passe.
      if (existant.status !== "invited") {
        return jsonError("This email already has an account.", 409);
      }
      await replaceInvite(db, existant.id, empreinte, expire);
      return NextResponse.json({
        ok: true,
        reinvited: true,
        id: existant.id,
        inviteUrl: `${origine(req)}/invite/${jeton}`,
        expiresAt: expire,
      });
    }

    const compte = await createUser(db, {
      email,
      role,
      status: "invited",
      allAssets: marques.valeur === true,
      allTemplates: modeles.valeur === true,
      inviteTokenHash: empreinte,
      inviteExpiresAt: expire,
      invitedBy: user.id,
    });

    // Les marques sont posées dès l'invitation : un compte activé qui n'aurait accès à rien
    // afficherait un écran vide sans dire pourquoi.
    if (assetIds.length > 0) await setAssets(db, compte.id, assetIds, user.id);

    return NextResponse.json({
      ok: true,
      id: compte.id,
      inviteUrl: `${origine(req)}/invite/${jeton}`,
      expiresAt: expire,
    });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "invite failed", 500);
  }
}
