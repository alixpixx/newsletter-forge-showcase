/**
 * L'ORDRE DE LA LISTE DES ABONNÉS — le bouton « Sort » qui annonçait « Coming soon ».
 *
 * ⚠️ MODULE PUR : la page (composant serveur) en a besoin pour fabriquer ses liens, et
 * `getSubscribers` pour construire sa requête. Les deux doivent lire LA MÊME table, sinon l'ordre
 * proposé à l'écran et l'ordre appliqué en base finissent par diverger — et personne ne le voit,
 * puisque les deux affichent des lignes plausibles.
 *
 * ⛔ AUCUNE DE CES COLONNES N'EST SUR UNE TABLE JOINTE. Trier par adresse e-mail obligerait à
 * ordonner sur `subscriber.email`, que PostgREST ne trie qu'au prix d'une jointure imbriquée dont
 * la pagination devient fausse : la page 2 ne serait plus la suite de la page 1. On ne propose donc
 * que des colonnes de `subscription`, quitte à proposer moins.
 */

export type TriAbonnes = "engagement" | "newest" | "oldest";

/**
 * Les ordres proposés, dans l'ordre du menu.
 *
 * `engagement` est le premier ET le défaut : c'est l'ordre qui existait avant que ce menu n'existe.
 * Changer le défaut en même temps qu'on ouvre le menu ferait croire à un bug d'affichage à tous
 * ceux qui connaissaient la liste.
 */
export const TRIS_ABONNES: {
  cle: TriAbonnes;
  label: string;
  colonne: string;
  ascendant: boolean;
}[] = [
  { cle: "engagement", label: "Most engaged", colonne: "engagement_score", ascendant: false },
  { cle: "newest", label: "Newest first", colonne: "created_at", ascendant: false },
  { cle: "oldest", label: "Oldest first", colonne: "created_at", ascendant: true },
];

export const TRI_PAR_DEFAUT: TriAbonnes = "engagement";

/**
 * Ce qui arrive dans `?sort=` → un tri connu.
 *
 * ⛔ UNE VALEUR INCONNUE RETOMBE SUR LE DÉFAUT, ELLE NE PASSE JAMAIS EN BASE. Un `?sort=` recopié
 * de travers deviendrait sinon un nom de colonne dans un `.order()` : PostgREST répondrait en
 * erreur, et le composant serveur planterait sur un chemin qu'aucun clic normal n'emprunte — donc
 * invisible jusqu'à ce qu'un lien traîne dans un e-mail interne.
 */
export function triDemande(brut: string | undefined | null): TriAbonnes {
  return TRIS_ABONNES.some((t) => t.cle === brut) ? (brut as TriAbonnes) : TRI_PAR_DEFAUT;
}

/** La colonne et le sens à poser sur la requête. Jamais appelé avec autre chose qu'un tri connu. */
export function ordreDuTri(tri: TriAbonnes): { colonne: string; ascendant: boolean } {
  const t = TRIS_ABONNES.find((x) => x.cle === tri) ?? TRIS_ABONNES[0]!;
  return { colonne: t.colonne, ascendant: t.ascendant };
}

/** Le libellé à afficher sur le bouton. */
export function libelleDuTri(tri: TriAbonnes): string {
  return (TRIS_ABONNES.find((x) => x.cle === tri) ?? TRIS_ABONNES[0]!).label;
}
