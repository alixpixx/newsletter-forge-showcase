/**
 * CE QUE L'ÉCRAN DIT APRÈS L'ENREGISTREMENT D'UNE CAMPAGNE QUI REPOINTE SES ÉDITIONS — module NEUTRE
 * (ni « use client » ni serveur), pour être mesuré hors navigateur.
 *
 * Le PATCH d'une campagne repointe ses éditions `planned` à venir quand la version, le sujet, le
 * preheader ou le segment change (décisions d'Alix du 25/09/2026 : « A », puis « même règle ») et rend
 * un bilan : `occurrences` (200) ou `occurrencesError` (207), avec `occurrencesFields`, les champs qui
 * ont suivi. Ce bilan doit atteindre l'écran — une édition qui garde l'ancien contenu sans que personne
 * ne le lise est exactement le défaut que le repointage ferme.
 */

export interface AvisDeRepointage {
  ton: "info" | "warn";
  texte: string;
}

const pluriel = (n: number, un: string, plusieurs: string) => (n === 1 ? un : plusieurs);

/** Le mot de chaque champ, tel que l'écran l'écrit. Les noms sont ceux du corps du PATCH. */
const MOTS: Record<string, string> = {
  templateVersionId: "version",
  subject: "subject",
  preheader: "preheader",
  segmentId: "segment",
};

/** « subject », « subject and segment », « version, subject and segment ». */
const enumeration = (mots: string[]) =>
  mots.length <= 1 ? (mots[0] ?? "") : `${mots.slice(0, -1).join(", ")} and ${mots[mots.length - 1]}`;

/**
 * Les champs annoncés par la réponse. `null` = la réponse ne les nomme pas (route d'avant le 25/09 au
 * soir) : c'est alors la version seule, la seule chose qu'elle savait repointer.
 */
function champsLus(brut: unknown): string[] | null {
  if (!Array.isArray(brut)) return null;
  const lus = brut.filter((n): n is string => typeof n === "string" && n in MOTS);
  return lus.length > 0 ? lus : null;
}

/**
 * `null` = rien à dire (aucun champ d'édition n'a changé : le PATCH n'a rien repointé et ne rend pas de
 * bilan). `version` = le numéro enregistré, pour que la phrase nomme ce qui part.
 */
export function avisDeRepointage(body: unknown, version: number | null): AvisDeRepointage | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { occurrences?: unknown; occurrencesError?: unknown; occurrencesFields?: unknown };
  const v = version !== null ? `v${version}` : "the new version";
  const champs = champsLus(b.occurrencesFields);
  // La version seule garde ses phrases d'origine : « moved to v10 » dit plus que « updated (version) ».
  const versionSeule = champs === null || (champs.length === 1 && champs[0] === "templateVersionId");
  const mots = (champs ?? ["templateVersionId"]).map((n) => MOTS[n]!);
  /** « (version v10, subject) » — ce qui a suivi, la version avec son numéro. */
  const quoi = (champs ?? []).map((n) => (n === "templateVersionId" ? `version ${v}` : MOTS[n]!)).join(", ");

  if (typeof b.occurrencesError === "string") {
    return {
      ton: "warn",
      texte: versionSeule
        ? `The campaign is saved on ${v}, but its upcoming editions could not be moved (${b.occurrencesError}). They still send the version they had.`
        : `The campaign is saved (${quoi}), but its upcoming editions could not be updated (${b.occurrencesError}). They still send the ${enumeration(mots)} they had.`,
    };
  }

  const o = b.occurrences as { moved?: unknown; skippedInFreezeWindow?: unknown; held?: unknown } | null | undefined;
  if (!o || typeof o !== "object") return null;
  const moved = Number(o.moved) || 0;
  const skipped = Number(o.skippedInFreezeWindow) || 0;
  const held = Number(o.held) || 0;
  const liste = enumeration(mots);

  const phrases: string[] = [];
  if (versionSeule) {
    phrases.push(
      moved > 0
        ? `${moved} upcoming ${pluriel(moved, "edition", "editions")} moved to ${v}.`
        : `No upcoming edition had to move to ${v}.`,
    );
  } else {
    phrases.push(
      moved > 0
        ? `${moved} upcoming ${pluriel(moved, "edition", "editions")} updated (${quoi}).`
        : `No upcoming edition had to be updated (${quoi}).`,
    );
  }
  if (skipped > 0) {
    phrases.push(
      `${skipped} already in preparation ${pluriel(skipped, `keeps the ${liste} it`, `keep the ${liste} they`)} started with.`,
    );
  }
  if (held > 0) {
    phrases.push(
      `${held} held ${pluriel(held, "edition keeps its", "editions keep their")} previous ${liste} — sent anyway, ${pluriel(held, "it goes", "they go")} out with ${mots.length === 1 ? "it" : "them"}.`,
    );
  }
  return { ton: skipped > 0 || held > 0 ? "warn" : "info", texte: phrases.join(" ") };
}
