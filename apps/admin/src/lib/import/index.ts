/**
 * Surface publique de l'import HTML. Le composant client n'importe QUE des types depuis ici :
 * `import type` est effacé à la compilation, donc l'analyseur ne part jamais dans le bundle
 * navigateur — il n'a rien à y faire.
 */
export { MAX_HTML_BYTES, htmlToDoc } from "./html-to-doc";
export type { HtmlImportOptions, ImportReport, ImportResult } from "./html-to-doc";
