import type { AppRole } from "@/lib/auth";

/**
 * « Tout voir » — les DEUX décisions, sans base ni session, pour pouvoir être éprouvées seules.
 *
 * ⭐ POURQUOI DEUX ET PLUS UNE. 0074 n'avait qu'un drapeau, `all_access` : tout ou rien. Demande
 * d'Alix (22/09/2026) : « faut que brands et template soient séparés ; par exemple je veux qu'un
 * user ait accès qu'à un domaine mais à tous les templates automatiquement ». Avec un seul booléen,
 * ce cas ne s'écrit pas — cocher « tous les templates » ouvrait du même geste toutes les marques.
 * Les quatre combinaisons ont donc un sens : ni l'un ni l'autre, marques seules, templates seuls,
 * les deux. Migration 0075 (`all_assets`, `all_templates`), cases « All brands » et « All
 * templates » de l'écran des comptes.
 *
 * Dans les deux cas le périmètre est RECALCULÉ à chaque requête (lib/session.ts) : c'est ce qui
 * inclut d'office une marque ou un template créé plus tard, là où une liste de lignes d'octroi
 * resterait figée.
 *
 * ⛔ « Tous les templates » N'EST PAS UN CHEMIN VERS UNE AUTRE MARQUE. Ce drapeau lève le filtre
 * PAR TEMPLATE, jamais le filtre PAR MARQUE : toute lecture de template porte `asset_id = <marque
 * courante>` (lib/data/templates.ts), et la marque courante est choisie dans `assetIds` du compte
 * (lib/asset-context.ts). Un membre qui a la marque A et « All templates » voit tous les templates
 * de A, présents et futurs, et RIEN de B.
 *
 * ⛔ « Tout voir » n'est PAS « administrer ». Ni l'un ni l'autre ne rend super_admin : l'écran des
 * comptes et les routes réservées continuent de lire `isSuperAdmin`, jamais ces résultats.
 *
 * ⛔ « Tout » ne se code JAMAIS comme une liste vide ni comme un marqueur glissé dans `assetIds` :
 * une liste vide veut dire « aucune marque », et c'est un 403 partout. Le « tout » est ce booléen.
 */

/** Toutes les MARQUES, présentes et futures : super_admin, ou membre coché « All brands ». */
export function voitToutesLesMarques(role: AppRole, allAssets: boolean): boolean {
  // ⛔ `=== true` et non « truthy » : une valeur venue d'ailleurs que la base (chaîne "false",
  // objet) ne doit pas ouvrir tout le périmètre par accident.
  return role === "super_admin" || allAssets === true;
}

/**
 * Tous les TEMPLATES DES MARQUES QUE CE COMPTE VOIT, présents et futurs : super_admin, ou membre
 * coché « All templates ». ⛔ Indépendant des marques : un membre peut avoir celui-ci sans celui-là.
 */
export function voitTousLesTemplates(role: AppRole, allTemplates: boolean): boolean {
  // ⛔ Même raison qu'au-dessus : `=== true`, jamais « truthy ».
  return role === "super_admin" || allTemplates === true;
}

/**
 * Un booléen FACULTATIF lu dans un corps JSON : absent → `undefined` (on ne change rien), vrai ou
 * faux → lui-même, TOUT LE RESTE → refusé.
 *
 * ⛔ Refuser plutôt que convertir : `"false"` est une chaîne non vide, donc « truthy » — une
 * conversion naïve donnerait TOUT l'accès à qui a voulu le retirer. `null` est refusé aussi : ce
 * n'est ni « ne change rien » ni « faux », et deviner serait choisir à la place de l'appelant.
 */
export function lireBooleenOptionnel(v: unknown): { ok: true; valeur: boolean | undefined } | { ok: false } {
  if (v === undefined) return { ok: true, valeur: undefined };
  if (typeof v === "boolean") return { ok: true, valeur: v };
  return { ok: false };
}
