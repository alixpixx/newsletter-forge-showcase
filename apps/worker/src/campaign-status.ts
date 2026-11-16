/**
 * LE STATUT DE CAMPAGNE QUI AUTORISE UN ENVOI — une seule définition, deux lecteurs.
 *
 * ⛔ POURQUOI CE MODULE EXISTE. Le fan-out refusait déjà les occurrences d'une campagne `cancelled`
 * ou `paused` (`fanout-db.ts`), mais le GEL, lui, ne regardait que le statut de l'occurrence. Les
 * deux passes jugeaient donc la même question — « cette édition peut-elle encore partir ? » — par
 * deux chemins différents, et il existait une bande où elles se contredisaient : le gel produisait
 * du contenu et MÉMORISAIT les articles retenus (`feed_article_sent`) pour des éditions que le
 * fan-out allait refuser. Ces articles étaient alors « brûlés » — exclus de l'anti-répétition des
 * éditions suivantes — au profit d'un email qui ne partait jamais. Une campagne laissée en pause
 * appauvrissait silencieusement la newsletter, jour après jour.
 *
 * Deux mesures d'une même grandeur finissent toujours par diverger : la seule réponse durable est
 * qu'il n'y en ait plus qu'une. Tout nouveau lecteur de cette question passe par ici.
 */

/** Statuts d'une campagne, tels que la contrainte de `0018_builder_media_campaigns_ai.sql` les fixe. */
export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled";

/**
 * Cette campagne peut-elle encore voir une de ses éditions partir ?
 *
 * `cancelled` et `paused` sont les deux refus : dans les deux cas un humain a explicitement arrêté
 * la campagne, et ni le gel ni le fan-out n'ont le droit de passer outre. Tous les autres statuts
 * passent — y compris `draft` et `sending`, que le matérialiseur accepte déjà : les restreindre ici
 * serait un durcissement silencieux, décidé au mauvais endroit.
 *
 * ⚠️ Un statut ABSENT (jointure vide, colonne nulle) est traité comme envoyable. Refuser sur une
 * absence de signal transformerait une jointure ratée en arrêt de toute la série, sans rien dire.
 *
 * ⛔ UNE CAMPAGNE ARCHIVÉE (0077) NE PART PLUS NON PLUS — troisième refus, même raison : un humain
 * l'a rangée. La route d'archivage arrête déjà la série et annule ses éditions à venir, ou retire du
 * calendrier un envoi unique ; ce refus-ci est la CEINTURE, pour ce que la route n'a pas pu annuler
 * (annulation en échec, édition gelée entre la lecture et l'écriture). Il vit ICI et pas dans chaque
 * lecteur : le gel et le fan-out doivent refuser exactement la même chose, sinon le gel brûle les
 * articles d'une édition que le fan-out n'enverra pas. `archivedAt` absent (colonne pas encore
 * demandée par un lecteur) se lit « non archivée », pour la même raison que le statut absent.
 */
export function campaignCanStillSend(
  status: string | null | undefined,
  archivedAt?: string | null,
): boolean {
  if (typeof archivedAt === "string" && archivedAt !== "") return false;
  return status !== "cancelled" && status !== "paused";
}
