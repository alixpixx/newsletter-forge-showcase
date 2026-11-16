import type { SubscriberRow, TagInfo } from "@/lib/data/subscribers";

/**
 * La part PURE des actions groupées sur les abonnés — tout ce qui peut se prouver sans base.
 *
 * ⛔ POURQUOI CE MODULE EXISTE À PART. Les trois gestes (taguer, exporter, effacer) portent chacun
 * une règle qu'une suite verte sur la route ne vérifierait pas : l'union des tags plutôt que leur
 * remplacement, la colonne exportée qui correspond bien à son en-tête, et surtout le passage d'un
 * identifiant de SOUSCRIPTION à un identifiant de PERSONNE. Cette dernière conversion est
 * silencieuse quand elle rate — voir `personnesDistinctes`.
 */

/**
 * LE PLAFOND D'UNE ACTION GROUPÉE, écrit UNE fois.
 *
 * ⛔ Il vivait dans `export/route.ts` seul. Dès qu'un second chemin peut constituer une sélection —
 * « tout sélectionner » va en fabriquer jusqu'à ce nombre — deux plafonds qui doivent s'accorder
 * finissent par diverger : l'un laisserait choisir 8 000 lignes que l'autre refuserait d'exporter,
 * et l'utilisateur découvrirait la limite APRÈS avoir composé sa sélection.
 *
 * ⚠️ Ce n'est pas une limite technique mais un garde-fou : au-delà, ce n'est plus une sélection,
 * c'est un export de base — et l'effacement d'une telle sélection ne devrait jamais tenir en un
 * clic.
 */
export const MAX_LIGNES = 5000;

/**
 * Ajoute un tag à ceux d'une souscription, SANS perdre les autres.
 *
 * ⛔ `tag_ids` est une colonne tableau : l'écrire, c'est la remplacer. Un `update` qui poserait
 * `[nouveau]` effacerait les intérêts projetés par le trigger de capture et les tags posés à la
 * main — une perte de données invisible, puisque l'écran afficherait simplement « un tag ».
 */
export function fusionnerTags(actuels: number[] | null | undefined, ajout: number): number[] {
  const set = new Set(actuels ?? []);
  set.add(ajout);
  // Trié : deux lignes qui portent les mêmes tags doivent produire la même valeur en base, sinon
  // toute comparaison ultérieure (diff, test, export) signale une différence qui n'existe pas.
  return [...set].sort((a, b) => a - b);
}

/** `true` quand le tag est DÉJÀ là : la route n'écrit alors rien et ne compte pas la ligne. */
export function dejaTague(actuels: number[] | null | undefined, ajout: number): boolean {
  return (actuels ?? []).includes(ajout);
}

/**
 * Les identifiants de PERSONNE derrière des souscriptions, dédoublonnés.
 *
 * ⛔⛔ LE PIÈGE CENTRAL DE CET ÉCRAN. La liste des abonnés lit la table `subscription` : ce que
 * l'interface appelle « id » est un identifiant de SOUSCRIPTION. La fonction d'effacement
 * `newsletter.erase_subscriber(uuid)`, elle, attend un identifiant de PERSONNE. Lui passer l'un
 * pour l'autre ne lève AUCUNE erreur : elle cherche l'adresse, ne trouve rien, et sort. L'écran
 * annoncerait un effacement qui n'a pas eu lieu.
 *
 * ⚠️ Une personne peut porter plusieurs souscriptions : N lignes cochées ne font pas N effacements.
 * C'est ce nombre-ci — les personnes — que la confirmation doit annoncer.
 */
export function personnesDistinctes(lignes: { subscriber_id?: string | null }[]): string[] {
  const vues = new Set<string>();
  for (const l of lignes) {
    const id = l.subscriber_id;
    if (typeof id === "string" && id !== "") vues.add(id);
  }
  return [...vues];
}

/**
 * Les colonnes de l'export, dans l'ordre.
 *
 * ⚠️ Ce fichier contient des données personnelles : il sort de l'outil pour vivre dans la
 * messagerie de quelqu'un. On n'y met que ce qui sert à travailler la liste — aucune adresse IP,
 * aucun agent utilisateur, aucune preuve de consentement, qui restent dans la base.
 */
export const ENTETES_EXPORT = [
  "email",
  "first_name",
  "consent_status",
  "country",
  "engagement_level",
  "engagement_score",
  "joined_at",
  "tags",
  "subscription_options",
  "signups_recorded",
] as const;

/**
 * Une souscription, en ligne de tableau.
 *
 * ⛔ Les libellés, pas les identifiants : un export qui rendrait `tag_ids = [3,7]` obligerait son
 * lecteur à revenir dans l'outil pour savoir de quoi il parle — ce qui lui retire sa raison d'être.
 * ⛔ Et seulement les finalités ACCORDÉES : une clé absente veut dire « on ne lui a jamais posé la
 * question », pas « elle a refusé ». Exporter les deux sous la même colonne ferait passer l'un pour
 * l'autre, cette fois hors de tout écran capable de nuancer.
 */
export function ligneExport(row: SubscriberRow, tags: Record<number, TagInfo>): unknown[] {
  /*
   * ⛔ TRIÉ PAR LIBELLÉ, pas par identifiant. L'ordre des identifiants est celui des écritures
   * successives : la même personne, exportée deux fois, ressortirait avec ses tags dans un ordre
   * différent selon l'ordre où ils lui ont été posés. Comparer deux exports deviendrait
   * impossible — et c'est précisément ce qu'on fait d'un export.
   */
  const libelles = [...new Set([...row.tag_ids, ...row.interest_ids])]
    .map((id) => tags[id]?.label)
    .filter((l): l is string => Boolean(l))
    .sort((a, b) => a.localeCompare(b));
  const accordees = Object.keys(row.purposes).filter((p) => row.purposes[p] === true);
  return [
    row.email,
    row.first_name ?? "",
    row.status,
    row.country ?? "",
    row.engagement_level,
    row.engagement_score,
    row.created_at,
    libelles.join(" | "),
    accordees.join(" | "),
    row.capture_event_count,
  ];
}
