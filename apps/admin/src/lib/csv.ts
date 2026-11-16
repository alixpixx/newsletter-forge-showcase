/**
 * Écriture de CSV — le format que le destinataire ouvrira dans Excel, Numbers ou Sheets.
 *
 * Deux dangers vivent ici, et aucun des deux ne se voit à la relecture du fichier généré :
 *
 *  1. UN SÉPARATEUR DANS UNE VALEUR DÉCALE TOUTE LA LIGNE. Une virgule dans un nom, un saut de
 *     ligne dans un champ libre, un guillemet dans une adresse — et la colonne « pays » se retrouve
 *     à lire un morceau de prénom. Le fichier reste parfaitement lisible : il est simplement faux.
 *
 *  2. UNE VALEUR PEUT ÊTRE EXÉCUTÉE. Excel, LibreOffice et Google Sheets interprètent un champ qui
 *     commence par `=`, `+`, `-` ou `@` comme une FORMULE. C'est l'injection CSV : le contenu vient
 *     ici d'un formulaire d'inscription public, donc d'un inconnu, et il s'exécute sur le poste de
 *     celui qui ouvre l'export — pas sur le nôtre. La parade retenue est celle de l'OWASP : faire
 *     précéder la valeur d'une apostrophe, que le tableur avale en affichage tout en cessant de
 *     l'évaluer.
 */

/** Les amorces que les tableurs traitent comme le début d'une formule. */
const AMORCES_DE_FORMULE = ["=", "+", "-", "@"];

/**
 * Un champ, prêt à être écrit.
 *
 * ⛔ L'ORDRE COMPTE : on neutralise la formule AVANT d'entourer de guillemets. L'inverse
 * protégerait la citation et laisserait l'apostrophe hors du champ, où elle ne veut plus rien dire.
 */
export function champCsv(valeur: unknown): string {
  if (valeur === null || valeur === undefined) return "";
  let texte = String(valeur);

  // Tabulation et retour chariot en tête comptent aussi : le tableur les saute avant de lire.
  const utile = texte.replace(/^[\t\r\n ]+/, "");
  if (AMORCES_DE_FORMULE.some((a) => utile.startsWith(a))) texte = `'${texte}`;

  // Guillemets doublés, et champ cité dès qu'il porte un séparateur, un guillemet ou un saut de
  // ligne — ou une espace de bordure, qu'un tableur mangerait sinon en silence.
  const doitCiter = /[",\r\n]/.test(texte) || texte !== texte.trim();
  return doitCiter ? `"${texte.replace(/"/g, '""')}"` : texte;
}

/** Une ligne de champs déjà ordonnés. */
export function ligneCsv(champs: unknown[]): string {
  return champs.map(champCsv).join(",");
}

/**
 * Un tableau complet : en-têtes puis lignes.
 *
 * ⚠️ CRLF et non LF (RFC 4180) : c'est ce qu'attendent les tableurs sous Windows, qui affichent
 * sinon tout le fichier sur une seule ligne.
 * ⚠️ Le BOM UTF-8 n'est PAS ajouté ici mais au moment de servir la réponse — c'est une affaire
 * d'encodage du transport, pas de contenu, et l'ajouter ici casserait toute comparaison de tests.
 */
export function tableauCsv(entetes: string[], lignes: unknown[][]): string {
  return [ligneCsv(entetes), ...lignes.map(ligneCsv)].join("\r\n");
}

/**
 * Ce qu'il faut écrire en tête du corps servi pour qu'Excel lise l'UTF-8.
 *
 * Sans lui, un accent ou un caractère cyrillique devient du charabia dans Excel sous Windows — qui
 * suppose l'encodage local tant qu'aucune marque ne le contredit.
 */
export const BOM_UTF8 = "﻿";

/**
 * Un nom de fichier sûr : pas de séparateur de chemin, pas de guillemet, jamais vide.
 *
 * ⛔ LE POINT EST EXCLU, LUI AUSSI. Le garder laissait `../../etc/passwd` devenir `..-..-etc-passwd`
 * : sans danger, puisque plus aucun séparateur ne subsiste, mais un nom de fichier qui exhibe la
 * tentative est un nom de fichier raté. Ne survivent que lettres, chiffres, tiret et souligné — le
 * `.csv` final est ajouté ici, pas repris de l'entrée.
 */
export function nomDeFichierCsv(base: string, jour: string): string {
  const propre = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  return `${propre}-${jour}.csv`;
}
