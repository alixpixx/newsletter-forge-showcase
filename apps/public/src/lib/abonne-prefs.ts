import type { Db } from "@/lib/supabase";

/**
 * Qui tient ce lien de préférences — résolu en UN seul endroit, pour la page ET pour la route.
 *
 * ⛔ UN ABONNÉ EFFACÉ A UN JETON MORT (décision du 22/09/2026). Le jeton de préférences est un HMAC
 * sans état ni date (`packages/tokens/src/index.ts`, `signPrefs`/`verifyScoped`) : rien ne le révoque,
 * et il dort dans le pied de chaque e-mail déjà reçu. `erase_subscriber` (0006) GARDE la ligne
 * `subscriber` — pseudonymisée, `deleted_at = now()` — au lieu de la supprimer. Sans ce contrôle, un
 * vieux lien rouvrait l'écran sur l'adresse `erased+…@deleted.invalid`, et chaque action de la route
 * écrivait encore dans le dossier d'une personne qui a demandé l'oubli : statut, finalités, suivi,
 * dates de réaction, traces avec IP et user-agent, une suppression au nom de l'adresse
 * pseudonymisée, une demande DSAR de plus.
 *
 * ⛔ LE MARQUEUR EST `deleted_at`, et lui seul. C'est ce que `erase_subscriber` pose, dans la MÊME
 * instruction qui remplace l'adresse (0006, `update newsletter.subscriber set email = …, deleted_at =
 * now()`), et rien d'autre ne l'écrit. Mesuré le 22/09 : 2 abonnés portent `deleted_at`, les 2 mêmes
 * portent l'adresse pseudonymisée, aucun écart.
 *
 * ⛔ UN EFFACÉ REND « invalide », PAS UN ÉTAT À LUI. Le jeton est mort : la réponse est celle d'un
 * jeton faux, au caractère près. Un état distinct apprendrait à qui tient le lien qu'un effacement a
 * eu lieu — et l'appelant ne peut pas se tromper de branche, puisqu'il n'en existe pas.
 *
 * Qui veut revenir passe par le formulaire public : il cherche l'abonné par ADRESSE, l'adresse
 * pseudonymisée ne correspond plus à rien, un NOUVEL abonné est créé (0073).
 */
export type AbonnePrefs =
  /** Jeton faux, absent — ou abonné effacé. */
  | { etat: "invalide" }
  /** Jeton bien signé, mais aucune ligne `subscriber` (ou lecture impossible). */
  | { etat: "inconnu" }
  | { etat: "ok"; abonne: Record<string, unknown> & { id: string } };

export async function resoudreAbonnePrefs(
  db: Db,
  token: string | undefined | null,
  verifyPrefs: (token: string | undefined | null) => string | null,
  /** Colonnes voulues par l'appelant ; `id` et `deleted_at` sont toujours lus en plus. */
  colonnes: string,
): Promise<AbonnePrefs> {
  const subscriberId = verifyPrefs(token);
  if (!subscriberId) return { etat: "invalide" };

  const { data } = await db
    .from("subscriber")
    .select(`id, deleted_at, ${colonnes}`)
    .eq("id", subscriberId)
    .maybeSingle();
  const ligne = data as (Record<string, unknown> & { id: string; deleted_at?: unknown }) | null;
  if (!ligne) return { etat: "inconnu" };
  // ⛔ Seul un `deleted_at` LU À NULL prouve que l'abonné est vivant : absent ou illisible, on ne
  // sait pas, et dans le doute le jeton est mort.
  if (ligne.deleted_at !== null) return { etat: "invalide" };
  return { etat: "ok", abonne: ligne };
}
