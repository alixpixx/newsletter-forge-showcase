import { NextResponse, after } from "next/server";
import { getDb } from "@/lib/supabase";
import { signUnsub } from "@/lib/tokens";
import { handleConfirmation } from "./handler";

/**
 * Confirmation d'un double opt-in PAR UN HUMAIN, depuis le bouton de la page `/confirm?token=…`.
 *
 * ⛔ POURQUOI CETTE ROUTE EXISTE (24/09/2026). Jusqu'à ce jour, la page `/confirm` confirmait **au
 * rendu d'un GET** : souscription `active`, preuve `optin_confirm`, bienvenue en file, dès que l'URL
 * était ouverte. Tout ce qui PRÉ-CHARGE un lien l'ouvre — antivirus de messagerie, proxy
 * d'entreprise, aperçu de client mail — et confirmait donc à la place de la personne, en écrivant
 * dans le journal légal qu'ELLE l'avait fait. Le double opt-in est la preuve du consentement : une
 * preuve fabriquée par un robot n'en est pas une. Et demain, une relance ou une promo « à la
 * confirmation » partiraient sur ce faux signal.
 *
 * Même motif que `/unsubscribe` depuis le 18/09 : **le rendu montre, le navigateur écrit.**
 *
 * ⚠️ Le lien envoyé par e-mail ne change pas (`/confirm?token=…&lang=…`) : c'est la PAGE, qui reste
 * en GET. Cette URI-ci n'est jamais mise dans un e-mail : seule la page l'appelle, depuis le
 * navigateur.
 */

/**
 * ⛔ 405 VOULU. Un GET sur cette URI ne peut venir que d'un scanner de liens — exactement ce que
 * cette route a été créée pour empêcher. Elle refuserait sa propre raison d'être en y répondant.
 */
export function GET() {
  return NextResponse.json(
    { error: "methode-non-autorisee", hint: "Confirming requires POST." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

/** La logique vit dans `handler.ts`, sous banc ; ici on ne fait que brancher le réel. */
export async function POST(req: Request) {
  return handleConfirmation(req, {
    getDb,
    signUnsub,
    apres: (tache) => after(tache),
    env: {
      OPTINFORGE_VERIFY_URL: process.env.OPTINFORGE_VERIFY_URL,
      OPTINFORGE_VERIFY_SECRET: process.env.OPTINFORGE_VERIFY_SECRET,
    },
  });
}
