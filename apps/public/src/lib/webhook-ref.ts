import { UUID_RE } from "./uuid";

/**
 * Retrouver la ligne d'`email_outbox` à l'origine d'un événement Mailgun.
 *
 * ⛔ POURQUOI CE FICHIER EXISTE, ET POURQUOI IL EST SÉPARÉ DE LA ROUTE.
 * Aucune route de ce dépôt n'est testable (elles ouvrent une session, une base et un client
 * Supabase au premier import). La règle de résolution — la seule chose qui peut se tromper ici —
 * est donc extraite en fonction PURE, pour qu'un banc puisse l'exercer.
 *
 * ⛔ LE FAIT QUI COMMANDE CE CODE. Au 09/09/2026, `email_event` contient exactement une ligne :
 * un `delivered` réel, ORPHELIN — `outbox_id`, `subscription_id` et `asset_id` à NULL. La jointure
 * webhook → outbox n'a donc jamais mordu une seule fois, et son premier essai en conditions
 * réelles a échoué en silence : l'événement s'écrit quand même, la route rend 200, et tout l'aval
 * (recompute_engagement, la mesure du réengagement) lit zéro avec un journal vert.
 *
 * La cause : on ne cherchait que par `provider_message_id`, alors que le worker envoie DÉJÀ
 * l'identifiant de la ligne à Mailgun (`process.ts`, `vars.outbox_id` → `mailgun.ts`, champ
 * `v:outbox_id`), et que Mailgun le renvoie tel quel dans `user-variables`. Le lien le plus sûr
 * était transmis et n'était pas lu.
 *
 * ⛔ L'ORDRE N'EST PAS INTERCHANGEABLE. La variable utilisateur est une clé primaire que NOUS avons
 * posée ; le message-id est une chaîne recopiée par un tiers, qui a déjà deux formes en base (avec
 * et sans chevrons) et dont `mailgun.ts` peut stocker une variante nue quand la réponse du
 * fournisseur n'est pas du JSON. On cherche donc d'abord ce qu'on a écrit, ensuite ce qu'on a lu.
 */

/**
 * Un uuid v4 canonique, tel que Postgres l'écrit.
 *
 * ⚠️ La forme vit dans `lib/uuid.ts` : deux endroits reçoivent désormais un identifiant venu du
 * dehors — ce webhook, et le paramètre `?ls=` de la page de préférences. Deux regex recopiées
 * auraient fini par diverger, et c'est celle des deux qui est trop permissive qui décide.
 */
const UUID = UUID_RE;

export type OutboxRef =
  | { by: "user_variable"; outboxId: string }
  | { by: "message_id"; messageId: string }
  | null;

/**
 * Les variables utilisateur, telles que Mailgun les rend. Selon la version du webhook, c'est un
 * objet ou la chaîne JSON de cet objet — les deux formes se voient en production.
 */
function userVariables(data: unknown): Record<string, unknown> {
  const raw = (data as { "user-variables"?: unknown } | null)?.["user-variables"];
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // Une variable illisible n'est pas une erreur d'événement : on retombe sur le message-id.
    }
  }
  return {};
}

/**
 * Décide PAR QUOI chercher la ligne d'origine. Ne cherche rien elle-même : c'est la route qui
 * interroge la base.
 *
 * @param data      le bloc `event-data` du webhook, tel quel
 * @param messageId le message-id DÉJÀ normalisé par `canonicalMessageId` — jamais la valeur brute,
 *                  sinon les deux bouts de la chaîne ne normalisent pas pareil
 */
export function outboxRefFromEvent(data: unknown, messageId: string): OutboxRef {
  const candidate = userVariables(data).outbox_id;
  // ⛔ On valide la forme avant de s'en servir. `user-variables` est recopié par un tiers : une
  // valeur qui n'est pas un uuid ne doit pas partir dans une requête, et surtout ne doit pas faire
  // renoncer au repli. Une chaîne vide est le cas qui compte : elle a l'air d'une valeur.
  if (typeof candidate === "string" && UUID.test(candidate.trim())) {
    return { by: "user_variable", outboxId: candidate.trim().toLowerCase() };
  }
  // ⛔ On ne cherche RIEN si l'identifiant est vide : `provider_message_id = ''` a l'air d'une
  // requête légitime et ramènerait n'importe quelle ligne future dont la colonne serait vide.
  if (messageId) return { by: "message_id", messageId };
  return null;
}
