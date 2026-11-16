/**
 * DIRE UNE CADENCE À VOIX HAUTE — le pendant lecture de `RecurrencePicker`.
 *
 * ⛔ POURQUOI CE FICHIER EXISTE. Les colonnes `recurrence_*` étaient écrites par
 * `/api/campaigns/[id]/recurrence` depuis les migrations 0027/0067 et relues par AUCUN écran : une
 * série enregistrée avec succès n'apparaissait nulle part, et Alix l'a vécu comme « quand je crée
 * une repeating stories rien ne se sauvegarde » (18/09/2026). Écrire sans relire, c'est écrire dans
 * le vide.
 *
 * ⚠️ MODULE PUR, SANS `"use client"`, ET C'EST VOULU : la page de campagne est un composant
 * SERVEUR. Next transforme tout module marqué `"use client"` en références client — ses fonctions
 * ne sont alors plus appelables côté serveur. Ces fonctions doivent l'être des deux côtés.
 */

/** ISO 8601 : 1 = lundi … 7 = dimanche, comme `extract(isodow)` en base. */
const NOMS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** La forme d'une cadence, telle que `mapCampaign` la rend. */
export interface CadenceLue {
  recurrenceDays: number[];
  recurrenceTime: string | null;
  recurrenceEveryWeeks: number | null;
  recurrenceUntil: string | null;
  recurrenceActive: boolean;
  timezone: string | null;
  freezeLeadMinutes: number | null;
  editionStart: number | null;
}

/**
 * Cette campagne est-elle une SÉRIE ?
 *
 * ⛔ Les jours font foi, pas `recurrenceActive` : une cadence enregistrée mais jamais démarrée est
 * une série — arrêtée (« Stopped »), et c'est même exactement l'état qu'il fallait rendre visible.
 */
export function estUneSerie(c: Pick<CadenceLue, "recurrenceDays">): boolean {
  return c.recurrenceDays.length > 0;
}

/** `[5, 1]` → « Mon and Fri » (toujours dans l'ordre de la semaine, pas celui de la saisie). */
export function nomsDesJours(jours: number[]): string {
  const propres = [...new Set(jours)].filter((j) => j >= 1 && j <= 7).sort((a, b) => a - b).map((j) => NOMS[j]!);
  if (propres.length === 0) return "";
  if (propres.length === 1) return propres[0]!;
  return `${propres.slice(0, -1).join(", ")} and ${propres.at(-1)}`;
}

/**
 * « 10:00 » moins N minutes → « 08:30 ». `null` si l'heure n'est pas lisible.
 *
 * Un gel qui passe avant minuit tombe LA VEILLE : on le dit, plutôt que d'afficher une heure
 * négative ou de faire semblant que tout se passe le même jour.
 */
export function heureDeGel(time: string | null, minutes: number | null): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)/.exec(time ?? "");
  if (!m || minutes === null || !Number.isFinite(minutes)) return null;
  const total = Number(m[1]) * 60 + Number(m[2]) - minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const label = `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
  return total < 0 ? `${label} the day before` : label;
}

/**
 * La cadence en une phrase : « Every 2 weeks on Mon and Fri at 07:30 (America/Santiago) ».
 *
 * L'intervalle n'est dit que s'il vaut plus d'une semaine : « Every week » est le cas de 99 % des
 * séries, et le répéter noie le reste.
 */
export function phraseCadence(c: CadenceLue): string {
  const jours = nomsDesJours(c.recurrenceDays);
  if (jours === "") return "No cadence set";
  const toutes = (c.recurrenceEveryWeeks ?? 1) > 1 ? `Every ${c.recurrenceEveryWeeks} weeks` : "Every week";
  const heure = c.recurrenceTime ? ` at ${c.recurrenceTime}` : "";
  const zone = c.timezone ? ` (${c.timezone})` : "";
  return `${toutes} on ${jours}${heure}${zone}`;
}

/**
 * LES JETONS DE SUJET QUI N'ONT DE VALEUR QUE SUR UNE OCCURRENCE DE SÉRIE.
 *
 * ⛔ LA LISTE VIENT DE `apps/worker/src/render.ts` (l. 158-173) ET DOIT LA SUIVRE. Les trois y sont
 * lues sur l'occurrence et nulle part ailleurs :
 *   `first_article` ← `ctx.occurrence_first_article ?? ""`
 *   `article_count` ← `ctx.occurrence_article_count`
 *   `edition_number` ← `ctx.occurrence_seq` (« Hors série, il n'y a AUCUN numéro à imprimer »)
 * `ai_intro` et `ai_preheader` N'Y SONT PAS, et c'est la distinction qui compte : elles ont un repli
 * sur la campagne (`ctx.campaign_ai_intro`), donc elles se remplissent pour un envoi ponctuel.
 *
 * Sur une campagne sans cadence, ces trois-là s'hydratent en chaîne vide, toujours. Le sujet part
 * troué — ou vide, et le gate d'envoi le refuse alors en `missing_subject`, après le verrou, après
 * la planification, après que tout a été validé.
 */
export const JETONS_DE_SERIE = ["first_article", "article_count", "edition_number"] as const;

/**
 * Parmi ces jetons, lesquels ne seront JAMAIS remplis pour cette campagne ?
 *
 * ⚠️ La question est « y a-t-il une cadence ? », pas « est-elle armée ? » : une série enregistrée
 * mais pas encore armée finira par geler des occurrences, et son sujet est parfaitement légitime.
 *
 * Prend les jetons DÉJÀ EXTRAITS, et pas le sujet : ce module est importé par un composant client,
 * et `@nf/render/hydrate` n'a rien à faire dans le bundle du navigateur.
 */
export function jetonsSansValeurHorsSerie(jetons: string[], serie: boolean): string[] {
  if (serie) return [];
  return JETONS_DE_SERIE.filter((j) => jetons.includes(j));
}

/**
 * EN MARCHE ou ARRÊTÉE — la distinction que l'écran doit pouvoir dire, avec UN SEUL jeu de mots.
 *
 * ⛔ Une série arrêtée ne crée AUCUNE occurrence : le planificateur ne lit que les campagnes
 * `recurrence_active`. Confondre les deux, c'est promettre des envois qui ne partiront jamais —
 * mesuré en production le 22/09/2026 : une campagne « Test » avait sa cadence enregistrée, n'avait
 * jamais été démarrée, et personne ne comprenait pourquoi rien ne partait.
 *
 * ⛔ « ARMED » / « SAVED, NOT ARMED » ONT DISPARU (Alix, 22/09/2026 : « c'est tjr pas
 * comprehensible a quoi ca sert »). Le mot décrivait la colonne, pas l'effet. Une série est
 * désormais « Running » ou « Stopped », et ces deux mots vivent ICI, une fois : la liste, la page
 * de campagne et le panneau de série les lisent tous les trois. Trois écrans qui nomment le même
 * état chacun à leur façon obligent à l'apprendre trois fois — c'était le cas jusqu'ici (« Armed »,
 * « On », « Series on »).
 */
export function etatDeLaSerie(c: Pick<CadenceLue, "recurrenceActive">): {
  arme: boolean;
  libelle: "Running" | "Stopped";
} {
  return c.recurrenceActive ? { arme: true, libelle: "Running" } : { arme: false, libelle: "Stopped" };
}

/**
 * Le statut à afficher À LA PLACE de « Draft » — ou `null` quand le statut ordinaire dit vrai.
 *
 * ⛔ UNE SÉRIE RESTE `draft` EN BASE POUR TOUJOURS : elle ne se verrouille ni ne se planifie, ce
 * sont ses éditions qui le font (la route `/arm` refuse d'ailleurs une campagne verrouillée).
 * Afficher « Draft » sur une série qui envoie chaque semaine se lisait « rien n'est lancé » — le
 * contraire de la vérité, dans la pastille qu'on lit en premier.
 *
 * ⚠️ Seul `draft` est remplacé : une série annulée doit continuer de dire « Cancelled ».
 *
 * ⛔ SAUF UNE SÉRIE ARCHIVÉE (0077), qui dit « Archived » quel que soit son statut : c'est l'état qui
 * décide de ce qu'on peut en faire (la réactiver, rien d'autre). « Stopped » sur une série rangée
 * inviterait à la redémarrer depuis sa page — geste que `/arm` refuse tant qu'elle est archivée.
 */
export function statutDeSerie(
  c: Pick<CadenceLue, "recurrenceDays" | "recurrenceActive"> & { status: string; archivedAt?: string | null },
): { arme: boolean; libelle: "Running" | "Stopped" | "Archived" } | null {
  if (!estUneSerie(c)) return null;
  if (c.archivedAt) return { arme: false, libelle: "Archived" };
  if (c.status !== "draft") return null;
  return etatDeLaSerie(c);
}

const MOIS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const JOURS_UTC = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Un instant, dit dans le fuseau DE LA SÉRIE : « Tue 29 Sep 2026, 10:00 (America/Santiago) ».
 *
 * ⛔ PAS `fmtWhen`, qui parle dans le fuseau du NAVIGATEUR et sans le nommer : une série chilienne
 * relue depuis Paris afficherait 15:00 pour un envoi promis à 10:00 aux abonnés — la même heure
 * d'écart que le sélecteur de cadence existe pour empêcher.
 *
 * ⚠️ Les noms de mois et de jours sont écrits ICI, pas demandés à `Intl` : selon la version d'ICU,
 * « en-GB » rend « Sep » ou « Sept ». Le panneau de série est rendu côté serveur PUIS côté client ;
 * deux ICU différentes produiraient deux textes, donc une erreur d'hydratation. Seuls les NOMBRES
 * viennent d'`Intl`, et eux ne varient pas.
 */
export function quandDansLeFuseau(iso: string | null | undefined, tz: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  let zone = tz && tz.trim() !== "" ? tz : "UTC";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(t));
  } catch {
    // Fuseau illisible : on le DIT en rendant l'heure UTC nommée comme telle, plutôt que de
    // présenter une heure locale fausse.
    zone = "UTC";
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(t));
  }
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const [an, mois, jour, h, m] = [n("year"), n("month"), n("day"), n("hour"), n("minute")];
  if (![an, mois, jour, h, m].every(Number.isFinite)) return "—";
  // Le jour de la semaine d'une date CIVILE ne dépend d'aucun fuseau : on le calcule en UTC.
  const jds = JOURS_UTC[new Date(Date.UTC(an, mois - 1, jour)).getUTCDay()]!;
  const hh = String(h % 24).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${jds} ${jour} ${MOIS[mois - 1]} ${an}, ${hh}:${mm} (${zone})`;
}
