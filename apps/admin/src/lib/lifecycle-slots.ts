import { LIFECYCLE_KINDS, type LifecycleKind } from "@nf/render/lifecycle-checks";
import type { LifecycleBinding } from "@/lib/data/lifecycle-templates";

/*
 * Les QUATRE fentes de cycle de vie d'une marque, telles qu'un écran doit les montrer.
 *
 * ⛔ POURQUOI QUATRE LIGNES ET NON « LA LISTE DES RATTACHEMENTS ». Un écran qui n'affiche que ce qui
 * existe n'affiche rien tant que rien n'existe : la fonctionnalité reste introuvable pour qui ne la
 * connaît pas déjà, ce qui est précisément l'état d'une marque neuve. Les quatre e-mails partent de
 * toute façon ; l'écran les montre donc toujours, et dit pour chacun QUI les écrit.
 *
 * ⛔ « AUCUN RATTACHEMENT » N'EST PAS UNE PANNE. Sans rattachement, le worker sert le texte livré
 * avec le produit — l'e-mail part, correct. C'est un état de repos, pas un trou à combler, et le
 * vocabulaire doit l'affirmer (« Built-in email »), sinon l'écran invente une urgence.
 *
 * ⛔ ON NOMME LE MODÈLE DEPUIS LA LISTE AUTORISÉE, JAMAIS DEPUIS LE RATTACHEMENT. `listLifecycleBindings`
 * n'écarte ni les modèles archivés ni ceux que la personne n'a pas le droit d'ouvrir ; `listTemplates`
 * écarte les deux. Afficher `binding.templateName` divulguerait le nom d'un modèle inaccessible.
 * D'où l'état `bound-hidden` : on dit qu'une fente est occupée sans dire par quoi.
 *
 * ⛔ ARCHIVÉ N'EST PAS « HORS DE MA PORTÉE ». Les deux se ressemblent ici — le modèle manque à la
 * liste dans les deux cas — mais ils ont des conséquences OPPOSÉES à l'envoi : la vue `outbox_context`
 * joint le template `on lft.archived_at is null`, donc sur un rattachement archivé c'est l'e-mail
 * intégré qui part, tandis qu'un modèle simplement non octroyé part bel et bien. Le rattachement
 * porte donc `templateArchived`, et l'archivé rend l'état `built-in` — la vérité de l'envoi —
 * signalé par `staleBinding`.
 */

/** Une ligne de `listTemplates()` — forme minimale nécessaire ici, à dessein structurelle. */
export interface LifecycleSlotTemplate {
  id: string;
  name: string;
  /** null tant que le modèle n'a jamais été publié. Seule définition de « publié » de cet écran. */
  publishedVersion: number | null;
}

export type LifecycleSlotState =
  /** C'est l'e-mail livré avec le produit qui part : aucun rattachement, ou un rattachement mort. */
  | "built-in"
  /** Rattaché à un modèle que la personne peut ouvrir. */
  | "bound"
  /** Rattaché à un modèle vivant mais non octroyé : occupé, il part, mais on ne peut pas le nommer. */
  | "bound-hidden";

export interface LifecycleSlot {
  kind: LifecycleKind;
  state: LifecycleSlotState;
  /** Renseigné seulement en `bound` : c'est aussi l'identifiant sur lequel se fait le détachement. */
  templateId: string | null;
  templateName: string | null;
  /** Vrai seulement si le modèle rattaché est visible ET publié — sinon le texte livré part encore. */
  published: boolean;
  /**
   * `built-in` alors qu'une ligne de rattachement EXISTE : elle pointe un modèle archivé (ou
   * disparu), que la vue du worker n'a pas le droit de servir. L'état d'envoi est bien « e-mail
   * intégré » ; le drapeau existe pour que l'écran puisse expliquer pourquoi, au lieu de laisser
   * croire qu'on n'a jamais rien réglé.
   */
  staleBinding: boolean;
}

/**
 * Croise les rattachements bruts avec les modèles réellement listables, et rend toujours quatre
 * fentes, dans l'ordre de `LIFECYCLE_KINDS` (le même que les badges de la liste : deux écrans ne
 * doivent pas énumérer les mêmes e-mails dans deux ordres).
 */
export function lifecycleSlots(
  bindings: LifecycleBinding[],
  templates: LifecycleSlotTemplate[],
): LifecycleSlot[] {
  const parId = new Map(templates.map((t) => [t.id, t] as const));

  return LIFECYCLE_KINDS.map((kind): LifecycleSlot => {
    const lien = bindings.find((b) => b.kind === kind) ?? null;
    if (!lien) {
      return { kind, state: "built-in", templateId: null, templateName: null, published: false, staleBinding: false };
    }

    if (lien.templateArchived) {
      // La vue du worker exclut l'archivé : c'est l'e-mail intégré qui part. On l'affirme donc, et
      // on ne prétend pas que la fente est « occupée » — elle l'est en base, pas à l'envoi.
      return { kind, state: "built-in", templateId: null, templateName: null, published: false, staleBinding: true };
    }

    const modele = parId.get(lien.templateId);
    if (!modele) {
      // Vivant mais absent de MA liste : non octroyé. Il part vraiment ; je ne peux ni le nommer ni
      // le détacher (la route exige un droit sur LE modèle porteur), mais je peux poser le mien.
      return { kind, state: "bound-hidden", templateId: null, templateName: null, published: false, staleBinding: false };
    }

    return {
      kind,
      state: "bound",
      templateId: modele.id,
      templateName: modele.name,
      published: modele.publishedVersion !== null,
      staleBinding: false,
    };
  });
}

/**
 * Quels e-mails de cycle de vie chaque modèle LISTABLE sert — la carte des badges de la liste des
 * modèles, et la liste filtrée de la page « Lifecycle emails ». Une seule fonction pour les deux
 * écrans depuis que le panneau a quitté `/templates` (24/09) : deux copies de ce croisement
 * finiraient par ne plus compter la même chose.
 *
 * ⛔ L'INTERSECTION, JAMAIS LES RATTACHEMENTS BRUTS. `listTemplates` écarte les modèles archivés et
 * ceux que la personne n'a pas le droit de voir ; `listLifecycleBindings` n'écarte ni les uns ni les
 * autres. Compter le brut annoncerait plus de modèles que la liste n'en montre, et le nombre
 * révélerait l'existence d'un modèle qu'on n'a pas le droit d'ouvrir.
 *
 * ⚠️ `push`, pas `set` : la clé primaire est (asset_id, kind), donc un même modèle peut servir
 * plusieurs e-mails. L'ordre rendu par `listLifecycleBindings` (celui de LIFECYCLE_KINDS) est
 * conservé tel quel, pour que la liste et la fiche n'annoncent pas les mêmes badges dans deux ordres.
 */
export function lifecycleParModele(
  bindings: LifecycleBinding[],
  templates: Pick<LifecycleSlotTemplate, "id">[],
): Map<string, LifecycleKind[]> {
  const listables = new Set(templates.map((t) => t.id));
  const parModele = new Map<string, LifecycleKind[]>();
  for (const lien of bindings) {
    if (!listables.has(lien.templateId)) continue;
    const deja = parModele.get(lien.templateId);
    if (deja) deja.push(lien.kind);
    else parModele.set(lien.templateId, [lien.kind]);
  }
  return parModele;
}

/** Une entrée du sélecteur : `value` est ce que le panneau renverra à `apply`. */
export interface LifecycleSlotChoice {
  value: string;
  label: string;
}

/**
 * Ce que le sélecteur d'une fente a le droit de proposer, et s'il doit être verrouillé.
 *
 * ⛔ POURQUOI CE CALCUL VIT ICI ET NON DANS LE JSX. Il ne décrit pas une mise en page : il décide de
 * ce que l'écran AFFIRME. Trois pièges, tous silencieux, que seule une fonction mesurable tient :
 *  1. état inconnu : la liste ne doit PAS commencer par « Built-in email », sinon le champ — qu'un
 *     formulaire fait lire comme l'état courant — affirme le repli au moment même où la pastille
 *     dit qu'on ne sait rien ;
 *  2. fente occupée par un modèle non octroyé : « Built-in email » y serait une option MORTE (le
 *     détachement exige un droit sur le modèle porteur, la route répondrait 404) ; une option qui ne
 *     fait rien sans le dire vaut moins que pas d'option ;
 *  3. verrouiller pour autre chose que l'ignorance : désigner MON modèle sur une fente occupée est
 *     un geste légitime, que la fiche d'un modèle autorise déjà (`PUT {kind}` fait un upsert sur
 *     (asset_id, kind)). Le refuser ici seulement ferait dire deux choses à deux écrans.
 */
export function lifecycleSlotChoices(
  slot: LifecycleSlot,
  templates: LifecycleSlotTemplate[],
  known: boolean,
): { locked: boolean; value: string; options: LifecycleSlotChoice[] } {
  const proposables = templates.map((t) => ({
    value: t.id,
    label: t.publishedVersion === null ? `${t.name} (draft only)` : t.name,
  }));

  if (!known) {
    return { locked: true, value: "", options: [{ value: "", label: "Unknown" }] };
  }

  if (slot.state === "bound-hidden") {
    return {
      locked: false,
      value: "hidden",
      options: [{ value: "hidden", label: "A template that is not in your library" }, ...proposables],
    };
  }

  return {
    locked: false,
    value: slot.templateId ?? "",
    options: [{ value: "", label: "Built-in email" }, ...proposables],
  };
}
