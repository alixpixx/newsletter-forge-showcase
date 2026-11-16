/**
 * ---------------------------------------------------------------------------
 * Libellés par DÉFAUT du CTA d'un article, par langue.
 * ---------------------------------------------------------------------------
 *
 * ⛔ ZÉRO DÉPENDANCE D'EXÉCUTION, comme `feed.ts` : ce fichier est tiré par le chemin d'envoi du
 * worker. La table ne peut donc PAS vivre dans `@nf/email` (i18n), qui est pourtant l'endroit
 * naturel des traductions : l'importer casserait l'invariant. Constante locale, assumée.
 *
 * ⚠️ Ces libellés ne sont pas décoratifs. Dans le rendu d'un article, seuls l'image et le CTA
 * portent un `<a>` — le titre est un `<div>` nu. Un article sans CTA ni image n'a donc AUCUN lien
 * cliquable en HTML. C'est pourquoi rien ici ne rend `undefined` ni chaîne vide.
 */
import { MAX_BUTTON_LABEL } from "./limits";

/**
 * Repli. `sv` est déclaré en base par une marque mais n'existe pas dans le `Locale` de `@nf/email` :
 * c'est la raison d'un repli EXPLICITE plutôt qu'un accès de table qui rendrait `undefined`.
 */
const FALLBACK_LABEL = "Read more";

/**
 * ⚠️ Indexée par la LANGUE seule, pas par le tag complet. `pt-BR` et `pt-PT` partagent le libellé ;
 * indexer sur `pt-BR` ferait retomber `pt-PT` sur l'anglais — exactement le défaut qu'on corrige.
 * Le jour où une région mérite son propre libellé, elle méritera aussi sa propre entrée.
 *
 * ⛔ UNE `Map`, PAS UN LITTÉRAL OBJET. Le tag de langue vient de la base (`schema.ts` ne contraint
 * que `min(2).max(12)`, recopié depuis `asset.languages`) : c'est une entrée non fiable. Sur un
 * littéral, `ARTICLE_CTA["constructor"]` rend une FONCTION et `["__proto__"]` l'objet racine — que
 * `??` laisse passer, puisqu'il ne filtre que `null` et `undefined`. La promesse de l'en-tête
 * (« rien ici ne rend `undefined` ni chaîne vide ») serait alors fausse, et pire : le CTA d'un
 * bouton d'email deviendrait le code source d'une fonction. Une `Map` ne répond que pour ses
 * propres clés, sans avoir à se souvenir de s'en défendre au point d'appel.
 */
const ARTICLE_CTA: ReadonlyMap<string, string> = new Map([
  ["en", FALLBACK_LABEL],
  ["es", "Leer la nota"],
  ["pt", "Ler a matéria"],
  ["fr", "Lire l'article"],
  ["it", "Leggi l'articolo"],
  ["sv", "Läs artikeln"],
  // Ajouté le 22/09/2026 : `de` fait partie des langues de `@nf/email` (pied légal, Impressum) mais
  // retombait sur « Read more ». Aucun modèle en base n'est en allemand ce jour-là : rien ne change.
  ["de", "Weiterlesen"],
]);

// Un libellé trop long ne se tronque pas en silence : la troncature livrerait un bouton mutilé aux
// 9 marques d'un coup. Un débordement est une faute d'écriture de CETTE table, pas une donnée
// d'exécution — il doit donc crever au chargement (typecheck, test, démarrage), jamais à l'envoi.
for (const [lang, label] of ARTICLE_CTA) {
  if (label.length > MAX_BUTTON_LABEL) {
    throw new Error(
      `ARTICLE_CTA[${lang}] = ${JSON.stringify(label)} fait ${label.length} caractères, ` +
        `au-delà de MAX_BUTTON_LABEL (${MAX_BUTTON_LABEL}).`,
    );
  }
}

/**
 * Le libellé à poser quand personne n'en a saisi. Ne rend JAMAIS `undefined` ni chaîne vide.
 *
 * `locale` est le tag BCP-47 du document (`meta.locale`), pas une langue : `en-GB` doit rendre
 * l'anglais et `pt-BR` le portugais. Locale inconnue, absente ou vide ⇒ anglais.
 *
 * `override` est le libellé choisi POUR CE MODÈLE (`meta.defaultCtaLabel`) : non vide, il l'emporte
 * sur la table. Vide ou blanc = pas de choix, la langue décide — la promesse « jamais vide » tient.
 */
export function defaultArticleCta(locale?: string, override?: string): string {
  if (override !== undefined && override.trim() !== "") return override;
  const lang = (locale ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return ARTICLE_CTA.get(lang) ?? FALLBACK_LABEL;
}
