/**
 * OÙ UN ÉLÉMENT DE LA BIBLIOTHÈQUE DE MARQUE ENTRE DANS LE DOCUMENT — header, footer ou bloc.
 *
 * Une seule définition pour les deux gestes qui importent : la modale « Import template » (onglets
 * Header, Footer, Blocks) et la section « Saved blocks » de la palette. Écrites deux fois, les deux
 * finiraient par ne pas poser le même bloc au même endroit — et l'auteur ne saurait pas lequel croire.
 *
 * ⚠️ Fonctions PURES, sans React : elles décident de ce qui est écrit dans le DOCUMENT, donc elles se
 * mesurent hors navigateur (même règle que `resoudreCible` et `actionsForFix` dans le réducteur).
 */
import type { EmailDoc, Row } from "@nf/render/schema";
import type { PartialEntry, PartialSlot } from "@/components/templates/library-client";
import { debutDuPied, type BuilderAction } from "./reducer";

/** La colonne sélectionnée sur le canevas — seule sa row compte ici. */
export interface Selectionnee {
  rowId: string;
}

/**
 * Index d'insertion d'un BLOC : juste APRÈS la row de la colonne sélectionnée. `undefined` = pas de
 * sélection utilisable, et le réducteur pose alors le bloc juste au-dessus du pied (footer importé,
 * sinon ligne légale), ou à la fin d'un document qui n'en a pas.
 *
 * ⛔ JAMAIS DANS LE PIED, JAMAIS SOUS LE LÉGAL. « Après la row sélectionnée » pris au pied de la lettre
 * posait le bloc entre le footer importé et le pied légal, voire SOUS les mentions légales, dès que la
 * sélection était dans le pied — sur un modèle neuf, le texte et le légal partagent la même row, donc
 * c'est la sélection par défaut. Le pré-vol criait ensuite « le pied légal n'est pas le dernier bloc ».
 * Une sélection dans le pied vaut donc « pas de sélection » : au-dessus du pied, comme un clic de
 * palette (`resoudreCible`, règle 1).
 */
export function indexInsertionBloc(doc: EmailDoc, active: Selectionnee | null): number | undefined {
  if (!active) return undefined;
  const i = doc.rows.findIndex((r) => r.id === active.rowId);
  if (i === -1) return undefined;
  const pied = debutDuPied(doc);
  if (pied !== -1 && i >= pied) return undefined;
  return i + 1;
}

/**
 * L'action qui verse les rows RELUES (ids neufs) d'un élément de la bibliothèque.
 *
 *  - header : tout en haut (index 0) ;
 *  - footer : sans index, le réducteur le pose juste avant le pied légal ;
 *  - block  : après la row sélectionnée, sinon au-dessus du pied (`indexInsertionBloc`).
 *
 * ⛔ UNE SEULE ACTION `insertRows`, JAMAIS N × `insertRow` : un bloc de deux rows est UN geste, donc
 * un seul Ctrl+Z, et tout ou rien si le plafond de rows ou une collision d'id le refuse.
 */
export function actionImport(
  fente: PartialSlot,
  rows: Row[],
  doc: EmailDoc,
  active: Selectionnee | null,
): BuilderAction {
  if (fente === "header") return { type: "insertRows", rows, index: 0 };
  if (fente === "footer") return { type: "insertRows", rows };
  const index = indexInsertionBloc(doc, active);
  return index === undefined ? { type: "insertRows", rows } : { type: "insertRows", rows, index };
}

/** Où un bloc va atterrir, en clair — affiché AVANT le clic, pour que le geste ne soit pas un coup de dé. */
export function ouInsererBloc(doc: EmailDoc, active: Selectionnee | null): string {
  const index = indexInsertionBloc(doc, active);
  if (index === undefined) return debutDuPied(doc) === -1 ? "at the end of the email" : "just above the footer";
  if (index >= doc.rows.length) return "at the end of the email";
  return `after row ${index}`;
}

/**
 * Le corps que « Save this row » (barre d'une row du canevas) envoie à `POST /api/builder/brand-partials`.
 *
 * ⛔ UNE SEULE BIBLIOTHÈQUE (23/09). La row devient un BLOC d'une row : elle apparaît aussitôt dans
 * « Saved blocks » et dans l'onglet Blocks de la modale. Elle partait avant dans `saved_row`, que ni la
 * modale ni l'écran Templates ne lisaient — enregistrer à un endroit et chercher à l'autre ne donnait
 * rien.
 */
export function corpsSaveThisRow(name: string, row: Row): { slot: "block"; name: string; rows: Row[] } {
  return { slot: "block", name, rows: [row] };
}

/**
 * Ce que la section « Saved blocks » de la palette liste : les BLOCS de la bibliothèque, et eux seuls.
 *
 * ⛔ PAS LES HEADERS NI LES FOOTERS. Ils ont une place fixe (en haut, au-dessus du légal) que seule la
 * modale « Import template » sait respecter ; listés ici, un clic poserait un en-tête après la row
 * sélectionnée, au milieu de l'e-mail.
 */
export function blocsDeLaBibliotheque(entries: readonly PartialEntry[]): PartialEntry[] {
  return entries.filter((e) => e.slot === "block");
}
