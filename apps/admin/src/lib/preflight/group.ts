import type { PreflightFinding } from "./index";

/**
 * Regroupement des constats de pré-vol PAR CAUSE.
 *
 * Un import de cinq articles sans alt écrivait cinq lignes de blocage rigoureusement semblables, et
 * les constats qui comptaient (footer mal placé, poids) se perdaient dedans. Une cause = une ligne.
 *
 * ⚠️ CETTE RÈGLE VIT DANS UN MODULE PUR, PAS DANS LE PANNEAU. Elle décide ce que l'écran MONTRE et
 * ce qu'il CACHE : un regroupement trop large ferait disparaître un blocage sans que rien ne
 * s'allume. Une règle de ce genre doit pouvoir être mesurée sur les vrais documents, ce qu'une
 * fonction privée d'un composant client interdit.
 */

/**
 * Parties VARIABLES d'un message : ce qui désigne l'occurrence plutôt que la règle — un titre ou un
 * id cité entre guillemets, une URL, un merge tag, une couleur, un nombre avec ou sans unité.
 *
 * ⛔ On ne regroupe JAMAIS sur le message entier. Le compilateur y cite le bloc fautif
 * (« Article image on "Palmeiras x Flamengo" has no alt text — required before publishing. »), donc
 * cinq occurrences d'un seul défaut donnent cinq textes différents : le texte complet ne peut pas
 * être la clé. Ce qui reste une fois ces segments effacés est la phrase de la RÈGLE, identique pour
 * toutes ses occurrences — c'est ça, la cause.
 *
 * ⚠️ Effacer trop fusionnerait deux causes distinctes en une seule ligne, ce qui ferait DISPARAÎTRE
 * un défaut de l'écran — bien pire que du bruit. D'où trois garde-fous : on n'efface que des valeurs
 * (jamais un mot), la clé porte en plus le niveau, la famille et l'origine du constat, et un segment
 * cité SANS espace n'est pas effacé.
 *
 * ⛔ CE DERNIER POINT VIENT D'UN DÉFAUT MESURÉ (26/08). Le schéma cite la clé fautive entre
 * guillemets — « Publishing is refused: Unrecognized key: "cleQuiNExistePas" ». En effaçant tout
 * segment cité, deux clés DIFFÉRENTES prenaient le même squelette : 15 constats de deux natures se
 * repliaient en UNE ligne, et l'auteur devait déplier pour découvrir qu'il y avait deux corrections
 * à faire. Un titre d'article porte des espaces (« Palmeiras x Flamengo »), un nom de clé ou de
 * propriété n'en porte pas : c'est ce qui sépare une VALEUR d'occurrence d'un nom de RÈGLE.
 *
 * Coût assumé : un titre d'un seul mot reste dans le squelette et donne sa propre ligne. C'est du
 * bruit, pas un défaut caché — et le principe est qu'effacer trop est toujours pire.
 */
const VARIABLE_PART =
  /"[^"]*\s[^"]*"|“[^”]*\s[^”]*”|\{\{[^}]*\}\}|\b(?:blk|row|col|b)_[A-Za-z0-9]+|[a-z][a-z0-9+.-]*:\/\/\S+|#[0-9a-fA-F]{3,8}\b|\d+(?:[.,:]\d+)*(?:\s?(?:px|KB|em|%))?/g;

/** Le message réduit à sa règle. Sert de clé de regroupement ET de libellé de la ligne repliée. */
export const skeletonOf = (message: string): string =>
  message
    .replace(VARIABLE_PART, "…")
    // Deux valeurs adjacentes (« … on … ») ne doivent pas laisser une suite de points de suspension.
    .replace(/…(?:\s*[,;:–—-]?\s*…)+/g, "…")
    .replace(/\s+/g, " ")
    .trim();

export interface CauseGroup {
  key: string;
  /** Phrase de la règle, sans les valeurs propres à chaque occurrence. */
  label: string;
  /** Premier constat du lot : il porte le niveau et la famille de tout le lot. */
  head: PreflightFinding;
  findings: PreflightFinding[];
}

export function groupByCause(findings: PreflightFinding[]): CauseGroup[] {
  const out: CauseGroup[] = [];
  const byKey = new Map<string, CauseGroup>();
  for (const finding of findings) {
    const label = skeletonOf(finding.message);
    // `source` fait partie de la cause : un même énoncé venant du compilateur et du schéma ne se
    // corrige pas au même endroit, donc ce n'est pas la même ligne.
    const key = `${finding.level}:${finding.group}:${finding.source}:${label}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.findings.push(finding);
      continue;
    }
    // Ordre de PREMIÈRE APPARITION : le rapport arrive déjà trié (bloquant d'abord, puis famille).
    // Regrouper ne doit pas rebattre cet ordre — la ligne la plus grave reste la plus haute.
    const group: CauseGroup = { key, label, head: finding, findings: [finding] };
    byKey.set(key, group);
    out.push(group);
  }
  return out;
}
