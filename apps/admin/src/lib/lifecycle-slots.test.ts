import { describe, expect, test } from "bun:test";
import { LIFECYCLE_KINDS } from "@nf/render/lifecycle-checks";
import { lifecycleSlots, lifecycleSlotChoices, type LifecycleSlotTemplate } from "./lifecycle-slots";
import type { LifecycleBinding } from "./data/lifecycle-templates";

/**
 * ⛔ CE QUE CE BANC EXISTE POUR EMPÊCHER. Cinq mensonges, tous silencieux à l'écran :
 *  1. ne rien montrer quand rien n'est rattaché — l'état de DÉPART de chaque marque, donc celui où
 *     la personne cherche le réglage ;
 *  2. nommer un modèle qu'elle n'a pas le droit d'ouvrir, parce que le rattachement, lui, ne filtre
 *     ni l'archivage ni les octrois ;
 *  3. dire « votre modèle part » d'un modèle jamais publié, alors que c'est le texte livré avec le
 *     produit qui part ;
 *  4. dire qu'un modèle sert cet e-mail alors qu'il est ARCHIVÉ — la vue `outbox_context` l'écarte
 *     (`lft.archived_at is null`), c'est l'e-mail intégré qui part, et les deux causes de « je ne
 *     vois pas ce modèle » ont donc des conséquences opposées à l'envoi ;
 *  5. proposer, dans le sélecteur, une option qui affirme un état qu'on ne connaît pas, ou qui ne
 *     ferait rien si on la choisissait.
 */

const modele = (id: string, name: string, publishedVersion: number | null): LifecycleSlotTemplate => ({
  id,
  name,
  publishedVersion,
});

const lien = (
  kind: LifecycleBinding["kind"],
  templateId: string,
  templateArchived = false,
): LifecycleBinding => ({
  kind,
  templateId,
  templateName: "nom brut, non autorisé",
  hasPublishedVersion: true,
  templateArchived,
});

describe("lifecycleSlots", () => {
  test("rend les quatre e-mails même sans aucun rattachement, et les dit intégrés", () => {
    const fentes = lifecycleSlots([], [modele("t1", "Newsletter", 3)]);
    expect(fentes.map((f) => f.kind)).toEqual([...LIFECYCLE_KINDS]);
    expect(fentes.every((f) => f.state === "built-in")).toBe(true);
    expect(fentes.every((f) => f.templateName === null)).toBe(true);
  });

  test("un modèle listable est nommé, et « publié » se lit sur la liste, pas sur le rattachement", () => {
    const fentes = lifecycleSlots(
      [lien("confirmation", "t1"), lien("welcome", "t2")],
      [modele("t1", "Confirm your email", 2), modele("t2", "Hello", null)],
    );
    const confirmation = fentes.find((f) => f.kind === "confirmation")!;
    const welcome = fentes.find((f) => f.kind === "welcome")!;

    expect(confirmation.state).toBe("bound");
    expect(confirmation.templateName).toBe("Confirm your email");
    expect(confirmation.published).toBe(true);

    // `hasPublishedVersion` du rattachement vaut `true` ci-dessus : c'est bien la liste qui tranche.
    expect(welcome.state).toBe("bound");
    expect(welcome.published).toBe(false);
  });

  test("un rattachement hors de portée est signalé occupé, jamais nommé, et sans identifiant", () => {
    const fentes = lifecycleSlots([lien("reengagement", "archive-ou-non-octroye")], [modele("t1", "Newsletter", 1)]);
    const reengagement = fentes.find((f) => f.kind === "reengagement")!;

    expect(reengagement.state).toBe("bound-hidden");
    expect(reengagement.templateName).toBeNull();
    // Pas d'identifiant = pas de bouton de détachement : la route répondrait 404 de toute façon.
    expect(reengagement.templateId).toBeNull();
  });

  /**
   * ⛔ LE TEST CENTRAL DU CORRECTIF « ARCHIVÉ ≠ HORS DE PORTÉE ».
   * MUTATION QUI DOIT LE TUER : retirer la branche `lien.templateArchived` de `lifecycleSlots`, le
   * modèle archivé retombant alors sur `bound-hidden` comme avant.
   * Symptôme en production : quelqu'un archive le modèle de confirmation depuis la liste ; l'écran
   * affiche « occupé par un modèle hors de votre portée » alors que le worker sert désormais
   * l'e-mail de confirmation INTÉGRÉ — sur le seul e-mail dont on doit prouver le consentement.
   */
  test("un rattachement vers un modèle ARCHIVÉ dit que l'e-mail intégré part", () => {
    const fentes = lifecycleSlots(
      [lien("confirmation", "t-archive", true)],
      [modele("t1", "Newsletter", 1)],
    );
    const confirmation = fentes.find((f) => f.kind === "confirmation")!;

    // L'état d'ENVOI fait foi : la vue du worker n'a pas le droit de servir un modèle archivé.
    expect(confirmation.state).toBe("built-in");
    // …mais une ligne existe bien en base, et l'écran doit pouvoir l'expliquer.
    expect(confirmation.staleBinding).toBe(true);
    expect(confirmation.published).toBe(false);
  });

  test("un modèle vivant mais non octroyé reste « occupé », et n'est pas confondu avec l'archivé", () => {
    const fentes = lifecycleSlots([lien("welcome", "t-non-octroye", false)], []);
    const welcome = fentes.find((f) => f.kind === "welcome")!;

    expect(welcome.state).toBe("bound-hidden");
    expect(welcome.staleBinding).toBe(false);
  });

  test("sans aucun rattachement, rien n'est signalé comme mort", () => {
    expect(lifecycleSlots([], []).every((f) => f.staleBinding === false)).toBe(true);
  });

  test("un même modèle sur deux fentes occupe bien les deux", () => {
    const fentes = lifecycleSlots(
      [lien("welcome", "t1"), lien("unsubscribe_ack", "t1")],
      [modele("t1", "One template", 1)],
    );
    expect(fentes.filter((f) => f.templateId === "t1").map((f) => f.kind)).toEqual([
      "welcome",
      "unsubscribe_ack",
    ]);
  });
});

/**
 * Ce que le SÉLECTEUR a le droit de dire. Dans un formulaire, la valeur affichée dans le champ se
 * lit comme l'état courant — plus fort que la pastille d'à côté.
 */
describe("lifecycleSlotChoices", () => {
  const dispo = [modele("t1", "Hello", 2), modele("t2", "Brouillon", null)];

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : rendre la liste ordinaire quand `known` est faux (l'option
   * sélectionnée redevient alors « Built-in email »).
   * Symptôme en production : les quatre lignes affichent la pastille « Status unavailable » ET, dans
   * le champ, « Built-in email ». Une capture d'écran se lit « les quatre e-mails partent en texte
   * livré » — l'affirmation exacte que la page vient de déclarer impossible.
   */
  test("état inconnu : une seule option, neutre, et le champ verrouillé", () => {
    const fente = lifecycleSlots([], dispo)[0]!;
    const choix = lifecycleSlotChoices(fente, dispo, false);

    expect(choix.locked).toBe(true);
    expect(choix.options).toEqual([{ value: "", label: "Unknown" }]);
    expect(choix.value).toBe("");
    // Aucune option ne doit nommer le repli : on ne sait pas si c'est lui qui part.
    expect(choix.options.some((o) => o.label === "Built-in email")).toBe(false);
  });

  /**
   * ⛔ MUTATION QUI DOIT LE TUER : remettre « Built-in email » en tête des options d'une fente
   * `bound-hidden`, ou remettre `locked: true` dessus.
   * Symptôme en production : l'option « Built-in email » ne fait RIEN (le détachement passe par le
   * modèle porteur, sur lequel la personne n'a aucun droit — la route répondrait 404), et le champ
   * verrouillé interdit de désigner son propre modèle alors que la fiche d'un modèle, elle,
   * l'autorise encore. Deux écrans, deux verdicts sur le même geste.
   */
  test("fente occupée par le modèle d'un autre : pas d'option morte, et le champ reste réglable", () => {
    const fente = lifecycleSlots([lien("confirmation", "t-non-octroye")], dispo).find(
      (f) => f.kind === "confirmation",
    )!;
    const choix = lifecycleSlotChoices(fente, dispo, true);

    expect(fente.state).toBe("bound-hidden");
    expect(choix.locked).toBe(false);
    expect(choix.options.some((o) => o.label === "Built-in email")).toBe(false);
    // Ses propres modèles restent proposables : poser le sien est un upsert sur (asset_id, kind).
    expect(choix.options.map((o) => o.value)).toEqual(["hidden", "t1", "t2"]);
    expect(choix.value).toBe("hidden");
  });

  test("fente au repos : le repli est nommé, et les brouillons sont annoncés comme tels", () => {
    const fente = lifecycleSlots([], dispo)[0]!;
    const choix = lifecycleSlotChoices(fente, dispo, true);

    expect(choix.locked).toBe(false);
    expect(choix.options[0]).toEqual({ value: "", label: "Built-in email" });
    expect(choix.options.map((o) => o.label)).toContain("Brouillon (draft only)");
  });

  test("fente rattachée : le champ pointe le modèle rattaché, jamais le repli", () => {
    const fente = lifecycleSlots([lien("welcome", "t1")], dispo).find((f) => f.kind === "welcome")!;
    expect(lifecycleSlotChoices(fente, dispo, true).value).toBe("t1");
  });
});
