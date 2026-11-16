/**
 * LES ADRESSES QUI ONT DÉMÉNAGÉ SOUS « AUTOMATIONS » (24/09/2026, demande d'Alix : « tout ce qui est
 * custom newsletter targeting sera dans cette nouvelle section », lifecycle emails compris).
 *
 * ⛔ POURQUOI UNE REDIRECTION ET PAS SEULEMENT DES LIENS À JOUR. Les liens internes sont réécrits,
 * mais une adresse vit aussi hors du code : favoris, historique du navigateur, messages échangés
 * dans l'équipe, documentation. Une ancienne adresse qui répond 404 casse un geste que la personne
 * savait faire ; une 308 l'emmène au même écran, à sa nouvelle place.
 *
 * ⛔ POURQUOI UNE FONCTION PURE, APPELÉE PAR `proxy.ts`. La redirection `/templates?lifecycle=1`
 * dépend d'un paramètre de requête — ce que `redirects()` de `next.config` sait filtrer, mais pas
 * RETIRER : il recopie la requête entière vers la destination, et `lifecycle=1` y survivrait sans
 * plus rien vouloir dire. Ici chaque règle décide de ce qu'elle garde, et la table se mesure sans
 * serveur (`adresses-demenagees.test.ts`).
 *
 * ⚠️ `/api/segments/*` NE BOUGE PAS : ce sont les routes de données, appelées par `fetch`. Seuls les
 * ÉCRANS ont changé d'adresse ; les règles ci-dessous ne regardent donc que des chemins d'écran.
 */

/** Préfixe d'écran déplacé tel quel : ses sous-chemins suivent (`/segments/x` → `…/targeting/x`). */
export const PREFIXES_DEMENAGES: ReadonlyArray<{ avant: string; apres: string }> = [
  { avant: "/segments", apres: "/automations/targeting" },
];

/**
 * Là où vivent désormais les e-mails de cycle de vie : la carte « System » de `/automations` (24/09/2026,
 * feature 3 — Alix : « je veux pas séparer lifecycle email de system »). Chaque e-mail y a son « Edit ».
 * L'ancienne page `/automations/lifecycle` (une journée d'existence) redirige ici.
 */
export const ADRESSE_LIFECYCLE = "/automations";

export interface Destination {
  pathname: string;
  /** Chaîne de requête À POSER, `?` compris, ou "" pour n'en garder aucune. */
  search: string;
}

/**
 * La nouvelle adresse d'un écran déplacé, ou `null` si l'adresse n'a pas bougé.
 *
 * ⛔ `lifecycle` EST COMPARÉ FERMÉ, comme le faisait la page des modèles : `?lifecycle=0` ne
 * voulait pas dire « montre-moi le cycle de vie », et une comparaison de vérité (`if (lifecycle)`)
 * le déménagerait quand même.
 */
export function adresseDemenagee(pathname: string, search: URLSearchParams): Destination | null {
  for (const { avant, apres } of PREFIXES_DEMENAGES) {
    // Frontière de segment exigée : `/segmentsX` n'est pas un sous-chemin de `/segments`.
    if (pathname === avant || pathname.startsWith(`${avant}/`)) {
      const requete = search.toString();
      return { pathname: apres + pathname.slice(avant.length), search: requete ? `?${requete}` : "" };
    }
  }
  // Le filtre « Lifecycle emails » de la liste des modèles était un aller simple vers ce réglage :
  // il mène maintenant à sa page, sans emporter les paramètres de la liste (`tab`, `lifecycle`).
  if (pathname === "/templates" && search.get("lifecycle") === "1") {
    return { pathname: ADRESSE_LIFECYCLE, search: "" };
  }
  // La page « Lifecycle emails » a fondu dans la carte System (feature 3) : chemin EXACT, sans requête.
  if (pathname === "/automations/lifecycle") {
    return { pathname: ADRESSE_LIFECYCLE, search: "" };
  }
  return null;
}
