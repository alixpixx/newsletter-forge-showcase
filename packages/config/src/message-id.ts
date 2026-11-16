/**
 * L'IDENTIFIANT DE MESSAGE, sous UNE seule forme.
 *
 * ⛔ POURQUOI CE FICHIER EXISTE. Le worker pose l'en-tête `Message-Id: <id@host>` avec chevrons,
 * puis stocke dans `email_outbox.provider_message_id` ce que l'API Mailgun lui rend — avec
 * chevrons — sauf quand la réponse n'est pas du JSON, auquel cas il retombe sur son identifiant nu,
 * sans chevrons ni hôte. Le webhook, lui, retire les chevrons avant de chercher la ligne d'origine.
 * Les deux bouts ne se normalisaient donc pas de la même façon, et l'égalité pouvait ne jamais
 * mordre.
 *
 * ⛔ CE QUE COÛTE CE DÉSACCORD. La recherche ne rend rien, `email_event` est quand même écrit — avec
 * `subscription_id`, `asset_id` et `campaign_id` à NULL. Aucune erreur, aucun rejeu, un 200 rendu à
 * Mailgun. Tout un historique d'ouvertures et de clics rattaché à personne, et un futur calcul
 * d'engagement qui rendrait ZÉRO pour tout le monde avec un journal parfaitement vert. C'est aussi
 * ce qui empêcherait la suppression sur rebond dur, qui a besoin de l'adresse de la ligne d'origine.
 *
 * La règle : **on normalise à l'écriture ET à la lecture**, par cette fonction, des deux côtés.
 * Normaliser d'un seul côté marcherait tant que l'autre ne change pas — c'est exactement le pari
 * qui a produit le défaut.
 */

/**
 * Retire les chevrons d'un `Message-Id` et le met en minuscules.
 *
 * Rend `""` pour une valeur absente : l'appelant doit traiter la chaîne vide comme « pas
 * d'identifiant », jamais comme une valeur à chercher en base — `provider_message_id = ''` ne
 * correspondrait à rien tout en ayant l'air d'une requête légitime.
 *
 * ⚠️ Minuscules parce que la partie domaine d'un Message-Id est insensible à la casse et que
 * certains relais la réécrivent. La partie locale ne l'est pas formellement, mais nos identifiants
 * sont des uuid v4 en minuscules : normaliser ne peut donc rien confondre ici, et protège d'un
 * relais qui remonterait l'hôte en capitales.
 */
export function canonicalMessageId(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (s === "") return "";
  return s.replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
}
