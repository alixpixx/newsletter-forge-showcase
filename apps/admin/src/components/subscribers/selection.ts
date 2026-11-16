/**
 * LA SÉLECTION D'ABONNÉS QUI SURVIT À UNE NAVIGATION.
 *
 * ⛔ POURQUOI CE MODULE EXISTE. Sur l'écran des abonnés, TOUT est un lien : les quatre filtres de
 * niveau, les trois filtres de provenance, « Prev », « Next », et la fiche d'un abonné (`?view=`).
 * Chacun change l'URL, donc Next re-rend la page serveur, démonte la table et remonte un composant
 * neuf — dont le `useState` repart à zéro. Cocher vingt lignes puis passer à la page suivante pour
 * en cocher d'autres était impossible : les vingt premières disparaissaient sans un mot.
 *
 * ⚠️ MODULE PUR, SANS `"use client"` — il ne touche pas `sessionStorage` lui-même. Il ne fait que
 * fabriquer la clé et relire ce qui en sort, pour que ces deux règles soient prouvables sans
 * navigateur. Les effets de bord restent dans le composant, seul endroit qui sait quand ils sont
 * permis.
 */

/** Racine des clés. Nommée pour être reconnaissable dans l'inspecteur du navigateur. */
const RACINE = "nf.subscribers.selection";

/**
 * La clé de stockage, CLOISONNÉE PAR MARQUE.
 *
 * ⛔ SANS CE CLOISONNEMENT, LA SÉLECTION TRAVERSE LES MARQUES. Changer de marque ne démonte pas la
 * table (le sélecteur passe par une server action qui revalide la mise en page) : la sélection
 * survivrait telle quelle, mais porterait des identifiants d'une AUTRE marque. Les trois routes les
 * rejetteraient en `no-match` — après que l'écran a annoncé « 20 selected », et pour l'utilisateur
 * ce serait un bug de l'outil, pas une garde qui a fait son travail.
 *
 * `null` (marque non résolue) a sa propre clé plutôt que d'écrire dans celle d'une vraie marque.
 */
export function cleDeSelection(assetId: string | null): string {
  return `${RACINE}.${assetId ?? "no-asset"}`;
}

/**
 * Ce qui sort du stockage → une liste d'identifiants utilisable.
 *
 * ⛔ TOUT PEUT SORTIR D'ICI. Le contenu a pu être écrit par une version précédente de l'écran,
 * tronqué par un onglet fermé au mauvais moment, ou modifié à la main. Une valeur illisible doit
 * donner une sélection VIDE — jamais une exception qui blanchirait la page des abonnés, et jamais
 * une valeur à moitié lue qui ferait agir sur des lignes qu'on n'a pas choisies.
 *
 * ⚠️ Les entrées non textuelles sont écartées une par une, pas la liste entière : un tableau dont
 * une case est abîmée garde ses autres identifiants, qui sont bien des lignes réellement cochées.
 */
export function lireSelection(brut: string | null): string[] {
  if (brut === null || brut === "") return [];
  let decode: unknown;
  try {
    decode = JSON.parse(brut);
  } catch {
    return [];
  }
  if (!Array.isArray(decode)) return [];
  const vus = new Set<string>();
  for (const v of decode) {
    if (typeof v === "string" && v !== "") vus.add(v);
  }
  return [...vus];
}

/** Ce qu'on écrit dans le stockage. Passe par le même format que `lireSelection` sait relire. */
export function ecrireSelection(ids: Iterable<string>): string {
  return JSON.stringify([...ids]);
}
