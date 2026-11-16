/**
 * Les articles d'un document, réduits à ce qu'un résumé a besoin de savoir.
 *
 * ⛔ POURQUOI ICI ET PAS DANS LE WORKER. Deux appelants ont besoin de cette liste : le gel d'une
 * occurrence (série récurrente, après dépliage des flux) et le verrouillage d'une campagne
 * ponctuelle, côté admin. Une copie de chaque côté finirait par diverger — et la divergence ne se
 * verrait que dans la boîte du lecteur, sous la forme d'une introduction qui annonce des articles
 * que l'édition ne contient pas.
 *
 * ⚠️ Le worker garde `firstArticleTitle` et `countArticles` (planner.ts) : ils répondent à d'autres
 * questions (« quel titre imprimer » exige un titre, « combien d'articles » compte aussi ceux qui
 * n'en ont pas) et sont couverts par leurs propres bancs. Les fusionner reviendrait à faire porter
 * une seule fonction trois contrats différents.
 */

export interface DocArticle {
  title: string;
  excerpt: string;
}

/**
 * Tous les blocs `article` PORTANT UN TITRE, dans l'ordre du document.
 *
 * ⛔ Un bloc sans titre est écarté : il n'apporte rien à un résumé et gonflerait le nombre annoncé
 * au modèle, qui promettrait alors un article de plus que l'édition n'en contient.
 */
export function articlesOf(doc: unknown, max = 20): DocArticle[] {
  const out: DocArticle[] = [];
  const visit = (node: unknown): void => {
    if (out.length >= max) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const o = node as Record<string, unknown>;
    if (o.type === "article" && typeof o.title === "string" && o.title.trim() !== "") {
      out.push({
        title: o.title.trim(),
        excerpt: typeof o.excerpt === "string" ? o.excerpt.trim() : "",
      });
      // Pas de descente sous un bloc article : il ne contient pas d'autre article, et s'arrêter
      // évite de reparcourir ses champs pour rien.
      return;
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(doc);
  return out;
}
