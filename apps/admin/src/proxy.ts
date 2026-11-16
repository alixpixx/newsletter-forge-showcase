import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { adresseDemenagee } from "@/lib/adresses-demenagees";

/**
 * Next 16 : convention "proxy" (ex-"middleware"). Protège toutes les routes.
 *
 * ⚠️ Ce fichier tourne en runtime Edge : il n'a PAS accès à la base. Il ne peut donc juger que
 * sur le contenu du cookie, qui peut avoir sept jours. C'est un premier filtre, pas la décision
 * finale : un rôle rétrogradé il y a une heure passera encore ici, et sera refusé par
 * `requireContext()` / les pages, qui relisent le compte en base à chaque requête.
 *
 * Autrement dit : ce garde évite d'afficher des écrans qui ne serviraient à rien ; il n'est pas
 * ce qui protège les données.
 */

/** Chemins réservés aux administrateurs. Un préfixe couvre ses sous-chemins (/settings/wordpress). */
const RESERVE_SUPER_ADMIN = ["/users", "/settings", "/deliverability"];

const estReserve = (pathname: string) =>
  RESERVE_SUPER_ADMIN.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export async function proxy(req: NextRequest) {
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  const { pathname } = req.nextUrl;
  const isLogin = pathname === "/login";
  // ⚠️ /invite/<jeton> DOIT rester atteignable sans session : c'est la page où quelqu'un qui n'a
  // pas encore de compte utilisable choisit son mot de passe. Sans cette exception, le lien
  // d'invitation renvoyait vers /login, c'est-à-dire vers un formulaire que le destinataire ne
  // peut par définition pas remplir. Ce qui l'autorise ici, c'est le jeton, vérifié par la route.
  const isInvite = pathname === "/invite" || pathname.startsWith("/invite/");
  const isPublic = isLogin || isInvite;
  // Les routes /api/* sont consommées par fetch() : une redirection 307 vers /login
  // leur renvoyait du HTML et faisait exploser res.json() à session expirée.
  const isApi = pathname.startsWith("/api/");

  if (!session && !isPublic) {
    if (isApi) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (session && isLogin) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  // ⚠️ Masquer un lien dans la barre latérale ne protège rien : sans ce contrôle, un membre
  // atteint /users en tapant l'URL. Les deux sont nécessaires, aucun ne remplace l'autre.
  if (session && session.role !== "super_admin" && estReserve(pathname)) {
    if (isApi) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Écrans déplacés sous « Automations » (24/09) : 308, permanente et qui garde la méthode. Placée
  // APRÈS les contrôles de session : sans session, la règle reste « /login d'abord », et aucune
  // adresse déplacée ne mène à un écran réservé — l'ordre ne donne donc rien à personne.
  const demenagee = adresseDemenagee(pathname, req.nextUrl.searchParams);
  if (demenagee) {
    const url = req.nextUrl.clone();
    url.pathname = demenagee.pathname;
    url.search = demenagee.search;
    return NextResponse.redirect(url, 308);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
