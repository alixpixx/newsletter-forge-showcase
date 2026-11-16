/**
 * Sérialise une valeur indépendamment de l'ORDRE de ses clés.
 *
 * ⛔ POURQUOI CE N'EST PAS UN DÉTAIL. `JSON.stringify` brut compare aussi l'ordre, et cet ordre
 * change en traversant la base : Postgres range les clés d'un `jsonb` par longueur puis par octets,
 * jamais dans l'ordre d'insertion. Après un enregistrement RÉUSSI, la valeur relue est donc une
 * PERMUTATION de la valeur locale, pas la même chaîne — et l'écran se croyait modifié en permanence :
 * « Saved » ne s'affichait jamais et le bouton Save restait actif, c'est-à-dire que le seul retour
 * dont dispose l'auteur disait l'inverse de ce qui venait de se passer.
 *
 * ⛔ CE QU'ELLE NE RÉPARE PAS, ET QU'IL NE FAUT PAS LUI DEMANDER. Elle égalise l'ORDRE, jamais les
 * VALEURS. `"30"` et `30` restent différents, `"X "` et `"X"` aussi. C'est la normalisation du
 * serveur qui tranche ces cas-là, et l'écran doit ADOPTER la config qu'il renvoie — pas réécrire ici
 * une seconde normalisation qui finirait par ne plus dire la même chose que la première.
 *
 * ⛔ ELLE VIT DANS `lib/`, PAS DANS LE COMPOSANT. Écrite en privé dans un fichier « use client »,
 * elle serait intestable : c'est exactement ce qui a laissé partir en production quatre gardes faux
 * enfermés dans un `route.ts`.
 */
export function canonique(v: unknown): string {
  return JSON.stringify(v, (_cle, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : val,
  );
}
