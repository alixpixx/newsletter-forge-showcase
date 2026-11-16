/**
 * Déclaration ambiante minimale de `mjml`.
 *
 * Raison d'être : MJML 5 n'expose pas de types pour son API JSON (`mjml2html(objet)`), seulement
 * pour la variante string. On déclare donc ici la SEULE surface qu'on utilise.
 *
 * ⚠️ Ce fichier ne doit contenir NI import NI export au niveau racine : c'est ce qui en fait une
 * déclaration ambiante et non une augmentation de module.
 */
declare module "mjml" {
  interface MjmlJsonNode {
    tagName: string;
    /**
     * ⚠️ Les attributs BOOLÉENS (`fluid-on-mobile`, `full-width`…) sont validés par TYPE :
     * MJML 5 rejette la chaîne `"true"` et n'accepte que le booléen natif.
     */
    attributes: Record<string, string | number | boolean>;
    children?: MjmlJsonNode[];
    content?: string;
  }

  interface Mjml2HtmlOptions {
    /** "soft" = les erreurs de validation sont remontées, pas levées. */
    validationLevel?: "strict" | "soft" | "skip";
    /** ⚠️ Doit rester true : les marqueurs `<!--nf:if-->` sont des commentaires HTML. */
    keepComments?: boolean;
    minify?: boolean;
    beautify?: boolean;
    fonts?: Record<string, string>;
    filePath?: string;
  }

  interface MjmlError {
    line: number;
    message: string;
    tagName?: string;
    formattedMessage?: string;
  }

  interface Mjml2HtmlResult {
    html: string;
    json: MjmlJsonNode;
    errors: MjmlError[];
  }

  /**
   * ⚠️ MJML **5** est ASYNCHRONE : contrairement à la v4, `mjml2html` renvoie une Promise.
   * C'est ce qui force `compileDoc()` à être `async` (vérifié sur mjml@5.4.0).
   */
  export default function mjml2html(
    input: string | MjmlJsonNode,
    options?: Mjml2HtmlOptions,
  ): Promise<Mjml2HtmlResult>;
}
