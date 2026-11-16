/**
 * La forme d'un uuid, en un seul endroit.
 *
 * ⛔ POURQUOI CE MODULE EXISTE. `apps/public` reçoit des identifiants de deux dehors différents :
 * le webhook Mailgun (`user-variables.outbox_id`) et le lien de préférences d'une relance
 * (`?ls=`). Les deux doivent refuser ce qui n'est pas un uuid AVANT de le mettre dans une requête.
 * Deux regex recopiées finissent par diverger, et c'est toujours la plus permissive des deux qui
 * décide de ce qui entre.
 */

/** Un uuid v4 canonique, tel que PostgreSQL l'écrit. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Vrai si la valeur — de type inconnu, venue d'un JSON ou d'une query string — est un uuid. */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v.trim());
}

/**
 * La MÊME forme, sans exiger la version ni la variante.
 *
 * ⛔ POURQUOI UNE SECONDE FORME PLUTÔT QU'UN ASSOUPLISSEMENT DE LA PREMIÈRE. `UUID_RE` garde des
 * identifiants que NOUS avons émis (un `outbox_id`, un `?ls=`) : y exiger `[1-5]` et `[89ab]` est
 * une vérification de cohérence gratuite, et l'assouplir affaiblirait un contrôle qui protège une
 * requête. Les identifiants du contrat de capture, eux, viennent d'un GÉNÉRATEUR ÉTRANGER : la
 * colonne d'accueil est un `uuid` PostgreSQL, qui accepte n'importe quelle version — un uuid v7
 * (`…-7xxx-…`, courant chez les générateurs récents) entrerait donc parfaitement en base mais
 * serait refusé en 422 par la forme stricte, et le lead serait perdu pour une raison purement
 * cosmétique. On accepte ce que la colonne accepte, jamais moins, jamais plus.
 */
export const UUID_LOOSE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Vrai si la valeur a la forme d'un uuid, quelle que soit sa version (identifiant venu du dehors). */
export function isUuidLoose(v: unknown): v is string {
  return typeof v === "string" && UUID_LOOSE_RE.test(v.trim());
}
