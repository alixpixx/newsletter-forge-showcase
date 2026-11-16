import { NextResponse, type NextRequest } from "next/server";

/**
 * UNE SEULE URI DE DÉSABONNEMENT, DEUX MÉTHODES.
 *
 * ⛔ L'URI QUI FAIT FOI EST `/unsubscribe` — c'est elle, et elle seule, que le worker met dans
 * l'en-tête `List-Unsubscribe` (`apps/worker/src/process.ts`). ⛔ NE PAS repointer le worker vers
 * `/api/v1/unsubscribe` : cette route répond 405 en GET (voulu), or tout client sans RFC 8058
 * (Apple Mail, Thunderbird, RFC 2369) OUVRE le lien en GET — on remplacerait une page de
 * désabonnement qui marche par un message d'erreur JSON.
 *
 * Le problème que ce middleware règle : `/unsubscribe` est une PAGE, et Next la rend aussi sur POST.
 * Mesuré : `POST /unsubscribe` en build de production répond 200 + du HTML et écrit une trace
 * `method='list_unsub'`. Un one-click de Gmail (RFC 8058) était donc servi par le chemin HUMAIN —
 * même acte, deux codes, deux libellés de preuve, et aucune des garanties machine de la route
 * (marqueur `List-Unsubscribe=One-Click` exigé, écriture atomique, réponse JSON).
 *
 * On route donc par MÉTHODE derrière une URI unique : GET reste la page (geste humain), POST est
 * réécrit vers le route handler RFC 8058. La réécriture conserve méthode, corps et query — le jeton
 * signé arrive intact. Aucune redirection : un 30x ferait perdre le corps du POST à certains MTA.
 */
export function middleware(req: NextRequest) {
  // Seul le POST change de destination ; GET/HEAD continuent vers la page.
  if (req.method !== "POST") return NextResponse.next();

  const cible = req.nextUrl.clone();
  cible.pathname = "/api/v1/unsubscribe";
  return NextResponse.rewrite(cible);
}

/** ⛔ Matcher volontairement EXACT : ce middleware ne doit s'exécuter sur aucune autre route. */
export const config = { matcher: ["/unsubscribe"] };
