/**
 * LE FILTRE PAR ÉTAT DE CONSENTEMENT — le bouton « Filters » qui annonçait « Coming soon ».
 *
 * ⛔ UN CHOIX DE MENU N'EST PAS UN STATUT, C'EST UN GROUPE. La base distingue `suppressed_soft` de
 * `suppressed_hard` ; l'écran les affiche tous deux « Suppressed » depuis toujours. Proposer un
 * filtre « Suppressed » qui ne ramènerait qu'une des deux moitiés rendrait une liste plus courte
 * que la colonne qu'elle prétend filtrer — et le manque serait invisible, puisque les lignes
 * rendues portent exactement le libellé demandé. Chaque entrée porte donc SES statuts, au pluriel.
 *
 * ⚠️ MODULE PUR : la page fabrique ses liens avec, `getSubscribers` construit sa requête avec. Deux
 * tables séparées finiraient par proposer un filtre qui ne filtre pas ce qu'il annonce.
 */

export type FiltreStatut =
  | "subscribed"
  | "pending"
  | "contact"
  | "unsubscribed"
  | "suppressed"
  | "complained"
  | "erased";

/**
 * Les états proposés, dans l'ordre du menu — du plus vivant au plus terminal.
 *
 * ⛔ LA LISTE DES `statuts` DOIT COUVRIR `CONSENT_PILL` (`bulk-actions.tsx`). Un statut présent en
 * base mais absent d'ici devient infiltrable : ses lignes s'affichent dans la liste complète et
 * ne ressortent d'aucun filtre, ce qui se lit comme « il n'y en a pas ».
 */
export const FILTRES_STATUT: { cle: FiltreStatut; label: string; statuts: string[] }[] = [
  { cle: "subscribed", label: "Subscribed", statuts: ["active"] },
  { cle: "pending", label: "Pending", statuts: ["pending"] },
  // Contact hors newsletter (0088) : entré sans double opt-in, pas un abonné.
  { cle: "contact", label: "Contact", statuts: ["contact"] },
  { cle: "unsubscribed", label: "Unsubscribed", statuts: ["unsubscribed"] },
  { cle: "suppressed", label: "Suppressed", statuts: ["suppressed_soft", "suppressed_hard"] },
  { cle: "complained", label: "Complained", statuts: ["complained"] },
  { cle: "erased", label: "Erased", statuts: ["deleted"] },
];

/**
 * Ce qui arrive dans `?status=` → un groupe connu, ou `null` pour « pas de filtre ».
 *
 * ⛔ UNE VALEUR INCONNUE VAUT « PAS DE FILTRE », ET C'EST UN CHOIX ASSUMÉ — contrairement aux
 * filtres de provenance, qui rendent volontairement une liste VIDE quand l'identifiant demandé
 * n'existe pas. La différence tient à ce que désigne la valeur : un identifiant de campagne absent
 * veut dire « cette campagne n'existe pas ici », et montrer toute la marque serait mentir ; un
 * `?status=` mal orthographié ne désigne aucune population, et rendre zéro ligne ferait croire que
 * la marque est vide. L'écran n'allume alors aucune pastille : rien ne prétend filtrer.
 */
export function statutDemande(brut: string | undefined | null): FiltreStatut | null {
  return FILTRES_STATUT.some((f) => f.cle === brut) ? (brut as FiltreStatut) : null;
}

/** Les statuts de base à poser dans un `.in()`. Liste vide = aucun filtre à appliquer. */
export function statutsDuGroupe(cle: FiltreStatut | null): string[] {
  if (cle === null) return [];
  return FILTRES_STATUT.find((f) => f.cle === cle)?.statuts ?? [];
}

/** Le libellé à afficher sur le bouton quand un filtre est actif. */
export function libelleDuStatut(cle: FiltreStatut): string {
  return FILTRES_STATUT.find((f) => f.cle === cle)?.label ?? cle;
}
