/**
 * `@nf/automations` — le catalogue fermé des déclencheurs, leurs gardes, leurs variables et la
 * validation des réglages. Partagé par le worker (moteur) et l'admin (écrans, vague 3).
 *
 * ⚠️ CE PAQUET N'EST PAS DÉCLARÉ DANS LE WORKSPACE (pas de `package.json`) : le déclarer ajoute une
 * entrée à `bun.lock`, et `bun install --frozen-lockfile` — celui du `Dockerfile.worker` — refuse
 * alors de construire l'image (mesuré le 24/09/2026 : « lockfile had changes, but lockfile is
 * frozen »). Il se résout par l'alias `paths` du tsconfig de chaque consommateur, que bun honore à
 * l'exécution comme tsc au typecheck. Il n'importe AUCUNE dépendance externe.
 */
export * from "./catalog";
export * from "./mask";
export * from "./validate";
