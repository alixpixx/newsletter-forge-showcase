/**
 * Le filtre par PAYS de l'écran des abonnés.
 *
 * `subscription.country` est écrit par la route d'inscription (mode serveur uniquement : le
 * formulaire public ne le transporte pas). La colonne est donc creuse — beaucoup de `null` — et
 * c'est une information sur la donnée, pas un défaut à masquer.
 *
 * ⛔ CE FILTRE N'EST PAS DU MÊME TYPE QUE LES AUTRES. Les trois filtres de provenance portent sur
 * des colonnes TABLEAU et passent par `.contains()` ; le statut passe par `.in()`. Le pays est une
 * colonne scalaire et passe par `.eq()`. Les mélanger lève une 42883 (`text = text[]`) qui fait
 * planter le composant serveur au lieu de rendre une liste vide.
 */

/** Deux lettres, rien d'autre : la forme d'un code ISO 3166-1 alpha-2. */
const FORME_ISO2 = /^[A-Za-z]{2}$/;

/**
 * Le pays demandé par l'URL, ou `null` s'il n'en désigne aucun.
 *
 * ⛔ LA RÈGLE N'EST PAS CELLE DU STATUT, ET C'EST VOULU. Un `?status=` inconnu ne désigne AUCUNE
 * population (le vocabulaire est fermé) : on n'applique alors pas de filtre, sinon un écran vide
 * ferait croire la marque vide. Un `?pays=ZZ` bien formé, lui, désigne une population parfaitement
 * définie — « les abonnés dont le pays est ZZ » — qui se trouve être vide. La rendre vide est la
 * vérité, comme pour un identifiant de provenance introuvable.
 *
 * On valide donc la FORME, pas l'appartenance à une liste : « united kingdom », « 1 » ou une
 * chaîne de cinquante caractères ne désignent rien et ne doivent jamais atteindre un `.eq()`.
 */
export function paysDemande(brut: string | undefined | null): string | null {
  if (typeof brut !== "string") return null;
  const propre = brut.trim();
  return FORME_ISO2.test(propre) ? propre.toUpperCase() : null;
}

/**
 * Le nom lisible d'un code pays.
 *
 * ⛔ `Intl.DisplayNames.of("")` LÈVE UNE `RangeError` — mesuré sous Bun le 18/09. Un code vide
 * arrive dès qu'une ligne porte une chaîne vide au lieu d'un `null`, et l'exception remonterait
 * jusqu'au rendu du composant serveur : l'écran entier tomberait à cause d'une cellule vide.
 * ⚠️ LES CODES INCONNUS NE SE COMPORTENT PAS TOUS PAREIL, et une seule mesure le cachait :
 * `of("XX")` rend « XX » (le code lui-même) tandis que `of("ZZ")` rend « Unknown Region », parce
 * que CLDR RÉSERVE `ZZ`. On ne promet donc PAS lequel des deux sort — seulement que la fonction ne
 * lève jamais et ne rend jamais une chaîne vide pour un code bien formé.
 */
export function libelleDuPays(code: string): string {
  const propre = (code ?? "").trim();
  if (!FORME_ISO2.test(propre)) return propre;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(propre.toUpperCase()) ?? propre.toUpperCase();
  } catch {
    return propre.toUpperCase();
  }
}

/**
 * Les pays présents dans un échantillon de lignes, dédoublonnés et ordonnés par NOM affiché.
 *
 * ⛔ ORDONNÉ PAR NOM, PAS PAR CODE. Trier sur le code mettrait « DE » (Germany) avant « ES »
 * (Spain) mais aussi « GB » avant « FR » à l'affichage : un menu qui n'est pas dans l'ordre qu'il
 * montre se lit comme un menu non trié.
 * ⛔ Les valeurs nulles, vides et mal formées sont écartées : ce menu sert à construire un `.eq()`,
 * et une entrée qui ne peut pas filtrer n'a rien à y faire.
 */
export function paysDesLignes(lignes: { country?: unknown }[]): string[] {
  const vus = new Set<string>();
  for (const l of lignes) {
    const code = paysDemande(typeof l.country === "string" ? l.country : null);
    if (code !== null) vus.add(code);
  }
  return [...vus].sort((a, b) => libelleDuPays(a).localeCompare(libelleDuPays(b)));
}

/**
 * Le plafond de l'échantillon lu pour construire le menu.
 *
 * ⛔ POSTGREST N'A PAS DE `SELECT DISTINCT`. Le menu se construit donc en lisant une colonne sur un
 * échantillon borné, pas en interrogeant un ensemble de valeurs. Conséquence assumée et à DIRE :
 * si une marque dépasse ce plafond, un pays rare peut manquer du menu — il reste atteignable par
 * l'URL, puisque `paysDemande` accepte toute forme valide sans consulter le menu.
 */
export const MAX_ECHANTILLON_PAYS = 5000;
