import { NextResponse } from "next/server";
import { getDb } from "@/lib/supabase";
import { verifyUnsub } from "@/lib/tokens";
import { handleDesinscriptionHumaine } from "./handler";

/**
 * Désabonnement demandé PAR UN HUMAIN, depuis la page `/unsubscribe?token=…`.
 *
 * ⛔ POURQUOI CETTE ROUTE EXISTE. Jusqu'au 18/09/2026, la page écrivait **au rendu d'un GET** :
 * `status = 'unsubscribed'` plus un `consent_event`, dès que l'URL était ouverte. Or tout ce qui
 * PRÉ-CHARGE une URL ouvre ce lien — antivirus de messagerie, proxy d'entreprise, aperçu de client
 * mail, robot antispam. Chacun désabonnait quelqu'un qui n'avait rien cliqué, et la trace écrivait
 * `method: 'list_unsub'` : l'historique AFFIRMAIT ensuite que la personne l'avait demandé. Ce n'est
 * pas seulement une donnée perdue, c'est une **fausse preuve de volonté**.
 *
 * Le risque était théorique tant que rien ne partait. Il a cessé de l'être le 18/09 à 12:58, quand
 * l'envoi a été armé et que ces liens sont entrés dans de vrais e-mails.
 *
 * ⛔ NE PAS FUSIONNER AVEC `api/v1/unsubscribe`. Celle-là est la cible RFC 8058 : elle EXIGE le
 * marqueur `List-Unsubscribe=One-Click` et trace `list_unsub_one_click`, parce qu'un audit doit
 * pouvoir distinguer un désabonnement machine d'un geste humain. L'écriture, elle, est commune —
 * `lib/desabonnement.ts` — et c'est là le seul endroit où elle doit vivre.
 *
 * ⛔ SECOND ÉCART, VOULU (22/09/2026) : l'ACCUSÉ de désinscription part d'ici, JAMAIS du one-click.
 * Gmail et Yahoo confirment déjà dans leur interface ; y ajouter un e-mail répondrait à un geste
 * fait dans la messagerie par un message de plus — ce que les filtres notent.
 *
 * ⚠️ Le middleware ne réécrit que `/unsubscribe`. Cette URI-ci n'est pas concernée, et n'est
 * jamais mise dans un e-mail : seule la page l'appelle, depuis le navigateur.
 */

/**
 * ⛔ 405 VOULU. Un GET sur cette URI ne peut venir que d'un scanner de liens — exactement ce que
 * cette route a été créée pour empêcher. Elle refuserait sa propre raison d'être en y répondant.
 */
export function GET() {
  return NextResponse.json(
    { error: "methode-non-autorisee", hint: "Unsubscribing requires POST." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

/**
 * Le geste humain, et l'accusé de désinscription qui le suit quand il a changé quelque chose
 * (22/09/2026). La logique vit dans `handler.ts`, sous banc ; ici on ne fait que brancher la vraie
 * base et la vraie vérification du jeton.
 */
export async function POST(req: Request) {
  return handleDesinscriptionHumaine(req, { getDb, verifyUnsub });
}
