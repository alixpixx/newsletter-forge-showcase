/**
 * @nf/render — point d'entrée par défaut : LE CONTRAT, rien que le contrat.
 *
 * On y ré-exporte le schéma EmailDoc et ses types, ainsi que le registre des merge tags.
 * ⛔ On n'y ré-exporte PAS le compilateur : `import { ... } from "@nf/render"` ne doit jamais
 * tirer MJML dans un bundle. Les deux consommateurs lourds/légers passent par leurs sous-chemins :
 *   • admin  → `@nf/render/compile`  (compileDoc, MJML)
 *   • worker → `@nf/render/hydrate`  (hydrate, zéro dépendance)
 */
export * from "./schema";
// Le manifeste des réglages du 22/09/2026 fait partie du contrat : c'est lui que l'inspecteur lit
// pour savoir quoi câbler (chemin, bornes, défaut). Donnée pure, aucune dépendance.
export * from "./new-props-2026-09-22";
