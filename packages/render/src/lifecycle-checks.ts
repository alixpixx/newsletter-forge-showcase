import { extractTokens, MERGE_VARS, type MergeVarName } from "./hydrate";

/**
 * CE QU'UN TEMPLATE DOIT PORTER POUR SERVIR D'E-MAIL DE CYCLE DE VIE.
 *
 * ⛔ POURQUOI CE CONTRÔLE EXISTE. Depuis 0059, une marque peut désigner un template du builder pour
 * remplacer le HTML en dur d'une `confirmation` ou d'un `reengagement`. Le worker retombe toujours
 * sur le code en dur si le template manque — mais s'il est PRÉSENT et incomplet, il part tel quel.
 * Un e-mail de confirmation sans lien de confirmation est le pire cas du produit : la personne
 * clique dans le vide, ne confirme jamais, et le consentement — que la loi nous demande de prouver —
 * n'existe pas. Le refuser à la publication est le seul moment où l'auteur peut encore corriger.
 *
 * ⛔ ZÉRO DÉPENDANCE au-delà du registre, et surtout AUCUN accès à la base : ce module est appelé
 * par la route de publication (serveur) ET par le pré-vol (navigateur). Une seule implémentation,
 * deux appels — dupliquer la règle ferait diverger le bouton « Publish » et le refus 422, et
 * l'auteur prendrait une erreur surprise sur un écran qui vient de lui dire que tout va bien.
 *
 * ⛔ ON JUGE LE COMPILÉ, JAMAIS LE DOCUMENT. Un jeton peut vivre dans un bloc `html` opaque
 * (invisible d'un parcours de blocs typés) et, à l'inverse, un jeton présent dans le document peut
 * DISPARAÎTRE à la compilation — un CTA dont le lien ne mène nulle part n'est pas émis. Le seul
 * artefact qui dit la vérité est le HTML compilé, complété du texte et du sujet, où un jeton peut
 * aussi vivre.
 */

/** Les kinds d'`email_outbox` qu'un template peut servir (CHECK `lifecycle_template_kind_check`). */
export const LIFECYCLE_KINDS = ["confirmation", "welcome", "unsubscribe_ack", "reengagement"] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export function isLifecycleKind(v: unknown): v is LifecycleKind {
  return typeof v === "string" && (LIFECYCLE_KINDS as readonly string[]).includes(v);
}

/**
 * Les jetons SANS LESQUELS l'e-mail ne fait pas ce pour quoi il existe.
 *
 * ⚠️ La liste est volontairement COURTE. Chaque exigence ajoutée ici est un template refusé, donc un
 * auteur bloqué : on n'y met que ce dont l'absence casse la finalité même de l'envoi, jamais ce qui
 * relève du goût.
 *
 * ⛔ `welcome` et `unsubscribe_ack` n'exigent RIEN de plus. Leur seule obligation — le footer légal,
 * donc la désinscription — est déjà contrôlée pour TOUS les templates par la barrière
 * `{{legal_footer_html}}` de la route de publication. Y ajouter une exigence propre reviendrait à
 * refuser deux fois la même chose, avec deux messages différents.
 */
const REQUIS: Record<LifecycleKind, { token: MergeVarName; pourquoi: string }[]> = {
  confirmation: [
    {
      token: "confirm_url",
      pourquoi:
        "without it the reader has nothing to click, the subscription is never confirmed, and the consent we are required to prove does not exist",
    },
  ],
  reengagement: [
    {
      token: "preferences_url",
      pourquoi:
        "the email asks the reader to act in order to keep receiving it — without a link it asks for something impossible, then stops the sends when nothing happens",
    },
  ],
  welcome: [],
  unsubscribe_ack: [],
};

export interface LifecycleShellInput {
  kind: LifecycleKind;
  /** Le HTML compilé, tel que la publication le figerait. */
  html: string;
  /** La version texte compilée. Un jeton peut n'exister que là. */
  text?: string | null;
  /** Le sujet, qui est hydraté comme le corps. */
  subject?: string | null;
}

export interface LifecycleShellReport {
  kind: LifecycleKind;
  /** Jetons exigés et absents. Vide ⇒ publiable de ce point de vue. */
  missing: { token: string; pourquoi: string }[];
  ok: boolean;
}

/**
 * Rapport, jamais une exception : la décision de refuser appartient à l'appelant, qui sait s'il
 * parle à une route (422) ou à un panneau (constat bloquant).
 */
export function checkLifecycleShell(input: LifecycleShellInput): LifecycleShellReport {
  const exigences = REQUIS[input.kind] ?? [];
  // ⛔ `extractTokens` et JAMAIS `html.includes("{{confirm_url}}")` : la syntaxe autorise un repli
  // inline `{{confirm_url|cliquez ici}}`, que la recherche littérale manquerait. Le résultat serait
  // un faux négatif muet — l'auteur voit son jeton à l'écran, la publication le refuse quand même.
  const presents = new Set([
    ...extractTokens(input.html),
    ...extractTokens(input.text ?? ""),
    ...extractTokens(input.subject ?? ""),
  ]);

  const missing = exigences.filter((e) => !presents.has(e.token)).map((e) => ({ token: e.token, pourquoi: e.pourquoi }));
  return { kind: input.kind, missing, ok: missing.length === 0 };
}

/**
 * Phrase prête à afficher — une seule formulation pour la route et pour le panneau. Deux
 * formulations du même refus se lisent comme deux problèmes différents.
 */
export function lifecycleShellMessage(r: LifecycleShellReport): string | null {
  if (r.ok) return null;
  const items = r.missing
    .map((m) => `{{${m.token}}} (${MERGE_VARS[m.token as MergeVarName]?.label ?? m.token}) — ${m.pourquoi}`)
    .join("; ");
  return `this template is used for the "${r.kind}" lifecycle email, which must contain ${items}.`;
}
