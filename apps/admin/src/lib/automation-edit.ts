/**
 * AUTOMATIONS — les décisions PURES de l'édition (plan AUTO-EDIT du 25/09/2026, étapes 3 à 6).
 *
 * ⭐ ALIX (25/09) : « toutes les automations éditables et modifiables, et qu'on puisse en créer de
 * nouvelles avec ces mêmes fonctions ; un outil très simple côté UX/UI pour créer / éditer / modifier ».
 * L'édition existait mais restait CACHÉE (aucune action sur les lignes, fiche en lecture seule, formulaire
 * à trois clics). Ce module décide, sans base ni session, ce que chaque écran propose :
 *  - `actionsFor` : quels gestes pour quel statut (liste et fiche) ;
 *  - `etatVersionEtape` : ce qu'une étape dit de sa version de modèle (dernière, dépassée, introuvable) ;
 *  - `trierEtapes` / `erreursEtapes` : les étapes rangées par délai, deux délais égaux NOMMÉS ;
 *  - `optionsFuseau` : la liste des fuseaux proposés, la valeur courante toujours conservée.
 *
 * ⛔ L'ÉCRAN N'EST PAS LA GARDE. Chaque geste proposé ici est REFAIT par sa route (PUT en `draft`
 * seulement, DELETE refusé 409 hors `draft`/`paused` ou après un envoi, transitions par `/status`) :
 * ce module évite de montrer un bouton voué à l'échec, il n'autorise rien.
 *
 * ⛔ PAS DE `"use client"` : les pages serveur ET le formulaire client l'importent.
 */
import type { AutomationStatus } from "@nf/automations";
import { formatDelay, isCreatableTrigger } from "@/lib/automations";

/* ------------------------------------------------------------------------------------------------
 * Les gestes par statut (étapes 3 et 4)
 * ---------------------------------------------------------------------------------------------- */

export interface AutomationActions {
  /**
   * `form` : ouvrir le formulaire (un brouillon se modifie tel quel) ; `stop-and-edit` : le ramener
   * d'abord au brouillon, ce qui l'ARRÊTE (confirmation) ; `null` : déclencheur non modifiable ici.
   */
  edit: "form" | "stop-and-edit" | null;
  /** Dupliquer : la copie naît `draft`, revalidée par la route. */
  duplicate: boolean;
  /**
   * Supprimer : seulement `draft` ou `paused`. ⚠️ La route refuse AUSSI une automation qui a déjà
   * sélectionné quelqu'un (409, phrase affichée telle quelle) : l'historique d'envoi ne se détruit pas.
   */
  delete: boolean;
  /** Ce que montre `/automations/[id]` : le formulaire (brouillon modifiable) ou la fiche. */
  page: "form" | "view";
}

export function actionsFor(status: AutomationStatus, trigger: string): AutomationActions {
  const modifiable = isCreatableTrigger(trigger);
  return {
    edit: !modifiable ? null : status === "draft" ? "form" : "stop-and-edit",
    duplicate: modifiable,
    delete: status === "draft" || status === "paused",
    page: status === "draft" && modifiable ? "form" : "view",
  };
}

/* ------------------------------------------------------------------------------------------------
 * La version de modèle d'une étape (étape 5)
 * ---------------------------------------------------------------------------------------------- */

/** Une version citée par une étape, telle que `describeVersions` la lit. */
export interface VersionEpinglee {
  /** `null` = modèle que la personne ne peut pas ouvrir : ni son nom, ni son sujet, ni son lien. */
  templateId: string | null;
  templateName: string | null;
  version: number;
  subject: string | null;
  published: boolean;
}

/** La DERNIÈRE version publiée d'un modèle ouvrable (`listStepTemplates`). */
export interface VersionPubliee {
  versionId: string;
  templateId: string;
  templateName: string;
  version: number;
  subject: string | null;
}

export interface EtatVersion {
  /**
   * `none` : aucune version choisie ; `latest` : la dernière publiée ; `outdated` : une plus récente
   * existe ; `pinned` : épinglée, sans plus récente connue ; `unknown` : introuvable.
   */
  kind: "none" | "latest" | "outdated" | "pinned" | "unknown";
  /** Libellé de l'option du sélecteur quand la version n'est PAS dans la liste des dernières. */
  optionLabel: string | null;
  templateId: string | null;
  subject: string | null;
  version: number | null;
  /** La dernière version publiée du même modèle, quand l'étape en épingle une plus ancienne. */
  newer: { versionId: string; version: number; action: string } | null;
  /** Avertissement à afficher sous l'étape. */
  note: string | null;
}

export const VERSION_INTROUVABLE_NOTE = "This template version could not be found: pick a template again.";
export const VERSION_DEPUBLIEE_NOTE = "This version is no longer published: the step cannot send.";

export function libelleVersion(nom: string, version: number, sujet: string | null): string {
  return `${nom} · v${version}${sujet ? ` — ${sujet}` : ""}`;
}

/**
 * Ce qu'une étape dit de sa version. ⛔ Le « v{N} available — Use v{N} » remplace l'ancien
 * « Current version (not in your published templates) », qui laissait croire à une version perdue
 * alors qu'elle était seulement plus ancienne que la dernière publiée.
 */
export function etatVersionEtape(
  versionId: string | null,
  epinglees: Readonly<Record<string, VersionEpinglee | undefined>>,
  dernieres: readonly VersionPubliee[],
): EtatVersion {
  const vide = { optionLabel: null, templateId: null, subject: null, version: null, newer: null, note: null };
  if (!versionId) return { kind: "none", ...vide };
  const derniere = dernieres.find((d) => d.versionId === versionId);
  if (derniere) {
    return { ...vide, kind: "latest", templateId: derniere.templateId, subject: derniere.subject, version: derniere.version };
  }
  const e = epinglees[versionId];
  if (!e) return { ...vide, kind: "unknown", optionLabel: "Template version not found", note: VERSION_INTROUVABLE_NOTE };
  const note = e.published ? null : VERSION_DEPUBLIEE_NOTE;
  // ⛔ Modèle non ouvrable : ni nom, ni sujet, ni lien — même règle que la bibliothèque.
  if (e.templateId === null || e.templateName === null) {
    return { ...vide, kind: "pinned", optionLabel: `A template you cannot open · v${e.version}`, version: e.version, note };
  }
  const plusRecente = dernieres.find((d) => d.templateId === e.templateId && d.version > e.version);
  const base = {
    optionLabel: libelleVersion(e.templateName, e.version, e.subject),
    templateId: e.templateId,
    subject: e.subject,
    version: e.version,
    note,
  };
  if (!plusRecente) return { ...base, kind: "pinned", newer: null };
  return {
    ...base,
    kind: "outdated",
    newer: {
      versionId: plusRecente.versionId,
      version: plusRecente.version,
      action: `v${plusRecente.version} available — Use v${plusRecente.version}`,
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Les étapes rangées par délai (étape 6)
 * ---------------------------------------------------------------------------------------------- */

/**
 * L'ordre des étapes par délai croissant — STABLE (deux délais égaux gardent leur ordre) — et une
 * erreur NOMMÉE par paire de délais égaux. Un délai illisible (NaN) part en dernier : la validation le
 * signale elle-même.
 *
 * ⭐ Pourquoi : le catalogue exige des délais strictement croissants (`validate.ts`) et l'écran
 * affichait « step 3: delay must be longer than step 2's » à corriger à la main. L'ordre des étapes
 * EST l'ordre de leurs délais : le formulaire le range lui-même. Deux délais ÉGAUX restent une erreur
 * (deux e-mails dans le même souffle), dite avec les numéros des étapes et le délai.
 *
 * Les numéros cités sont ceux AFFICHÉS au moment de l'appel (position d'origine + 1).
 */
export function trierEtapes(delais: readonly number[]): { ordre: number[]; erreurs: string[] } {
  const cle = (i: number) => (Number.isFinite(delais[i]) ? (delais[i] as number) : Number.POSITIVE_INFINITY);
  const ordre = delais.map((_, i) => i).sort((a, b) => cle(a) - cle(b) || a - b);
  const erreurs: string[] = [];
  for (let k = 1; k < ordre.length; k++) {
    const a = ordre[k - 1] as number;
    const b = ordre[k] as number;
    if (Number.isFinite(delais[a]) && delais[a] === delais[b]) {
      erreurs.push(
        `Steps ${a + 1} and ${b + 1} have the same delay (${formatDelay(delais[a] as number)}): give each step a different delay.`,
      );
    }
  }
  return { ordre, erreurs };
}

/** Le message du catalogue pour deux délais qui ne croissent pas (`validate.ts`). */
const PAS_CROISSANT = /^step \d+: delay must be longer than step \d+'s$/;

/**
 * Les erreurs affichées : celles de `validateAutomation` (sur les étapes RANGÉES), où le message
 * « must be longer than » est remplacé par l'erreur nommée des délais égaux. ⛔ Remplacé seulement
 * quand une égalité est détectée : sinon il reste affiché tel quel (rien n'est avalé en silence).
 */
export function erreursEtapes(validation: readonly string[], egaux: readonly string[]): string[] {
  if (egaux.length === 0) return [...validation];
  return [...validation.filter((e) => !PAS_CROISSANT.test(e)), ...egaux];
}

/* ------------------------------------------------------------------------------------------------
 * Les fuseaux proposés (étape 6)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Les fuseaux du sélecteur : ceux des éditions des marques, UTC, et la valeur COURANTE si elle n'y est
 * pas — ⛔ une automation réglée sur un fuseau absent de la liste ne doit pas le perdre en s'ouvrant.
 * Sans doublon, UTC en tête, le reste par ordre alphabétique.
 */
export function optionsFuseau(fuseauxMarques: readonly (string | null | undefined)[], courant: string): string[] {
  const vus = new Set<string>();
  for (const f of [...fuseauxMarques, "UTC", courant]) {
    const t = typeof f === "string" ? f.trim() : "";
    if (t) vus.add(t);
  }
  return [...vus].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));
}
