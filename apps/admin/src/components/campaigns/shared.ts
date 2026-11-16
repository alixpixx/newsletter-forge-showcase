import type { Tone } from "@/components/ui";
import { statutDeSerie } from "@/components/campaigns/cadence";

/*
 * Vocabulaire partagé de l'écran Campagnes — AUCUN import serveur.
 *
 * Ce module est importé par des composants client : il ne doit jamais tirer `lib/data/*`
 * (qui charge `getDb()` et la clé service_role). Les types y sont donc REDÉCLARÉS de façon
 * structurelle, même parti pris que `TemplateListRow` dans `templates/template-table.tsx`.
 */

/** Forme minimale affichée d'une campagne — alignée sur `CampaignRow` de `@/lib/data/campaigns`. */
export interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  subject: string;
  preheader: string | null;
  templateVersionId: string | null;
  segmentId: string | null;
  purpose: string | null;
  scheduledAt: string | null;
  lockedAt: string | null;
  sentAt: string | null;
  recipientsPlanned: number | null;
  sizeBytes: number | null;
  updatedAt: string;
  /**
   * Les jours de la cadence, vides pour un envoi unique.
   *
   * ⛔ CE CHAMP DÉCIDE D'UN ÉCRAN ENTIER. Une campagne qui porte une cadence ne se planifie pas à
   * une date : le fan-out ne ramasse les campagnes ponctuelles que si `recurrence_days is null`
   * (`apps/worker/src/fanout-db.ts`). Lui proposer « Schedule » menait à un envoi qui n'était
   * jamais scanné, affiché « Scheduled » pour toujours. Le panneau d'envoi unique se cache donc
   * pour une série, et c'est ce champ qui le lui dit.
   */
  recurrenceDays: number[];
  /**
   * L'INTERRUPTEUR de la série — armée ou seulement enregistrée.
   *
   * ⛔ À NE PAS CONFONDRE AVEC `recurrenceDays`. Les jours disent « c'est une série » ; celui-ci dit
   * « elle tourne ». Une cadence enregistrée mais non armée ne crée AUCUNE occurrence : le
   * planificateur ne ramasse que les campagnes `recurrence_active`. Les deux états se ressemblent à
   * l'écran et produisent des résultats opposés — c'est exactement la confusion qui a fait croire
   * qu'une série enregistrée partirait.
   *
   * ⚠️ La colonne est lue depuis toujours par `CAMPAIGN_SELECT` et mappée par `mapCampaign` : elle
   * arrivait déjà jusqu'ici à l'exécution, seul ce type la masquait.
   */
  recurrenceActive: boolean;
  /**
   * L'INSTANT OÙ LE WORKER A REMPLI LA FILE D'ENVOI — et le seul fait qui distingue « ça va
   * partir » de « ça ne partira jamais ».
   *
   * ⛔ La liste ne lisait QUE le plan : `sentAt ?? scheduledAt`, affiché tel quel. Une campagne dont
   * l'heure était passée depuis quinze minutes sans qu'un seul message soit entré en file affichait
   * donc exactement la même chose qu'une campagne qui partait dans quinze minutes — une date, en
   * gris. C'est ce qu'Alix a vu le 18/09/2026 : « j'ai fait une campagne one shot et rien ne s'est
   * envoyé. » Nul + heure passée = la mise en file n'a jamais eu lieu.
   */
  enqueuedAt: string | null;
  /** Fuseau de la série : les dates qu'archiver annulerait se disent dans CE fuseau, pas celui du navigateur. */
  timezone: string | null;
  /** Rangée dans l'onglet Archived (0077) — `null` pour une campagne active. */
  archivedAt: string | null;
  /** Ce que « Reactivate » rétablira. Redéclaré structurellement (ce module n'importe rien de serveur). */
  archivedResume: {
    previousStatus: string;
    seriesRunning: boolean;
    scheduledAt: string | null;
    editionsCancelled: number | null;
  } | null;
  /** La case « contacts sans finalité » (0088). Optionnelle : absente se lit décochée. */
  contactsIgnorePurpose?: boolean;
}

/**
 * LA PASTILLE D'UNE CAMPAGNE — une seule règle, pour la liste ET la page de campagne.
 *
 * Trois cas, dans cet ordre : une SÉRIE dit « Running » / « Stopped » / « Archived »
 * (`statutDeSerie`) ; un envoi unique ARCHIVÉ dit « Archived » (son statut en base peut être
 * `draft` — l'archivage d'un envoi programmé le remet en brouillon — et « Draft » dans l'onglet
 * Archived laisserait croire qu'on peut encore l'éditer) ; le reste dit son statut.
 *
 * ⛔ Deux écrans qui calculaient chacun leur pastille ont déjà divergé (« Armed », « On »,
 * « Series on » pour le même état) : la règle vit ici, une fois.
 */
export function pastilleDeCampagne(
  c: Pick<CampaignSummary, "status" | "recurrenceDays" | "recurrenceActive" | "archivedAt">,
): { libelle: string; ton: Tone } {
  const serie = statutDeSerie(c);
  if (serie) return { libelle: serie.libelle, ton: serie.arme ? "green" : "grey" };
  if (c.archivedAt) return { libelle: "Archived", ton: "grey" };
  return { libelle: statusLabel(c.status), ton: statusTone(c.status) };
}

/**
 * Une version PUBLIÉE proposable à une campagne. Remplie par `listPublishedVersions()`
 * (`campaign-data.ts`, serveur) et transmise en props — le type vit ici pour qu'un composant
 * client puisse le nommer sans importer le module qui charge `getDb()`.
 */
export interface PublishedVersion {
  versionId: string;
  templateId: string;
  templateName: string;
  version: number;
  subject: string;
  preheader: string;
  sizeBytes: number | null;
  publishedAt: string | null;
}

export interface SegmentOption {
  id: string;
  name: string;
}

/** De quel modèle vient la version référencée par une campagne (affichage seul). */
export interface VersionLabel {
  versionId: string;
  templateId: string;
  templateName: string;
  version: number;
}

/**
 * Seuil au-delà duquel la confirmation tapée est exigée.
 *
 * Il porte sur le compte RÉEL d'audience éligible renvoyé par `/api/campaigns/[id]/audience`,
 * pas sur une estimation d'écran : un garde-fou branché sur un chiffre inventé ne garde rien.
 */
export const LARGE_SEND = 5000;

const TONES: Record<string, Tone> = {
  draft: "grey",
  scheduled: "blue",
  sending: "violet",
  sent: "green",
  paused: "amber",
  cancelled: "amber",
};

export const statusTone = (status: string): Tone => TONES[status] ?? "grey";

export const statusLabel = (status: string): string =>
  status.length === 0 ? "—" : status[0].toUpperCase() + status.slice(1);

/**
 * Libellés des finalités. Les CLÉS viennent de la base (`CAMPAIGN_PURPOSES`, lui-même issu de
 * `ALL_PURPOSES` de `@nf/config`) et transitent en props : cette table ne fait que traduire ce
 * qu'on lui donne, elle n'énumère pas les finalités elle-même. Une finalité inconnue s'affiche
 * telle quelle plutôt que de disparaître de la liste.
 */
const PURPOSE_LABELS: Record<string, string> = {
  content: "Content — newsletter and editorial",
  offers: "Offers and promotions",
  events: "Events and invitations",
  partners: "Partner offers — always a separate opt-in",
};

export const purposeLabel = (purpose: string): string => PURPOSE_LABELS[purpose] ?? purpose;

/** Lit `{ error }` du corps JSON, sinon retombe sur le statut HTTP. Jamais de message inventé. */
export async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* corps non-JSON — on garde le statut */
  }
  return `Request failed (${res.status})`;
}

export const fmtInt = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US");

/* ------------------------------------------------------------------ *
 * Fuseaux — planifier dans le fuseau du LECTEUR, pas dans celui du rédacteur
 * ------------------------------------------------------------------ */

/**
 * ⛔ CE QUI MANQUAIT, ET CE QUE ÇA COÛTAIT. `new Date("2026-08-20T10:00")` (sans décalage) est
 * interprété dans le fuseau du NAVIGATEUR. Une campagne Copper Kettle (Chili) préparée depuis
 * São Paulo partait donc à 10:00 heure brésilienne, soit **09:00 au Chili** — une heure d'écart
 * que rien à l'écran ne signalait, sur le seul chiffre qui décide si l'email arrive au petit
 * déjeuner ou pendant la nuit. Le fuseau du rédacteur n'a aucune raison d'être celui du lecteur.
 *
 * ⛔ `toIso(date, time)` A ÉTÉ SUPPRIMÉE plutôt que gardée « au cas où » : tant qu'elle existait,
 * un appelant pouvait réintroduire le défaut sans qu'aucune porte ne rougisse. Sa disparition
 * force `tsc` à réclamer un fuseau explicite à CHAQUE écran qui planifie.
 */

/** Fuseau du navigateur, pour le proposer par défaut plutôt que de le faire deviner. */
export function browserTimeZone(): string {
  try {
    return zoneCanonique(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  } catch {
    return "UTC";
  }
}

/**
 * Le nom IANA CANONIQUE d'un fuseau : `Europe/Kiev` et `Europe/Kyiv` sont le même endroit.
 *
 * ⛔ SANS ÇA, LE MÊME FUSEAU SE LISTE DEUX FOIS. Les alias historiques (`Europe/Kiev`,
 * `Asia/Calcutta`, `America/Buenos_Aires`) vivent encore dans les réglages système, tandis que
 * `Intl.supportedValuesOf("timeZone")` ne rend que les noms primaires : comparés en tant que
 * CHAÎNES, l'alias et le nom primaire passent pour deux fuseaux différents, et le sélecteur
 * affichait la même ville dans « Where this brand publishes » ET dans « All timezones ». C'est l'un
 * des dédoublements signalés par Alix le 18/09/2026.
 *
 * ⚠️ Un fuseau que CE navigateur ne connaît pas est rendu tel quel, jamais remplacé : inventer un
 * nom canoniserait une erreur de saisie en fuseau plausible. L'appelant le filtre s'il le doit —
 * `zoneOffsetLabel` rend `""` pour un fuseau qui ne se résout pas.
 *
 * ⭐⛔ MESURÉ, PAS SUPPOSÉ — et les deux moteurs ne répondent PAS pareil (18/09/2026) :
 *   · JavaScriptCore (bun, donc le banc de test) : `resolvedOptions()` rend l'alias TEL QUEL
 *     (`Europe/Kiev` → `Europe/Kiev`) et `supportedValuesOf` liste `Europe/Kiev`, pas `Europe/Kyiv` ;
 *   · V8 (Chrome, donc l'écran réel) : `resolvedOptions()` canonicalise et `supportedValuesOf` ne
 *     liste que les noms primaires.
 * Chaque moteur est donc cohérent AVEC LUI-MÊME, et c'est tout ce dont la déduplication a besoin :
 * canoniser les deux côtés avec la même fonction suffit. Ne pas « corriger » ce constat depuis une
 * table d'alias écrite à la main — elle vieillirait sans que rien ne le dise.
 */
export function zoneCanonique(zone: string): string {
  if (zone === "") return zone;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone || zone;
  } catch {
    return zone;
  }
}

/**
 * Décalage d'un fuseau IANA **à un instant donné**, en millisecondes (positif à l'est).
 *
 * ⛔ Un fuseau n'a PAS un décalage : il en a un par instant. `America/Santiago` vaut −04:00 en
 * hiver austral et −03:00 en été ; demander « le » décalage du Chili sans dire quand est une
 * question sans réponse. D'où le paramètre `instant` — et d'où la double passe de `zonedToIso`.
 *
 * Rend `null` pour un fuseau que ce navigateur ne connaît pas, plutôt qu'un 0 silencieux qui
 * ferait passer une heure locale pour de l'UTC.
 */
export function zoneOffsetMs(instant: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
    const at = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const wall = Date.UTC(at("year"), at("month") - 1, at("day"), at("hour"), at("minute"), at("second"));
    return Number.isFinite(wall) ? wall - instant : null;
  } catch {
    return null;
  }
}

/**
 * `<input type="date">` + `<input type="time">` + un fuseau → instant ISO.
 *
 * ⭐ POURQUOI DEUX PASSES. L'instant cherché dépend du décalage, et le décalage dépend de
 * l'instant : le serpent se mord la queue à chaque changement d'heure. La première passe lit
 * l'heure murale comme si elle était UTC et en déduit un décalage approché ; la seconde relit le
 * décalage à l'instant ainsi trouvé, donc du BON côté de la bascule. Une seule passe se trompe
 * d'une heure sur les dates proches d'un passage à l'heure d'été — soit deux week-ends par an,
 * exactement ceux où l'erreur est la plus invisible.
 *
 * ⚠️ Heures qui n'existent pas (l'heure sautée au printemps) : la double passe retombe sur
 * l'instant qui suit le saut. C'est un choix, pas un hasard — refuser la saisie obligerait
 * l'utilisateur à connaître les dates de bascule de son propre pays.
 */
export function zonedToIso(date: string, time: string, timeZone: string): string | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  const hm = /^(\d{2}):(\d{2})/.exec(time || "00:00");
  if (!day || !hm) return null;
  const wall = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), Number(hm[1]), Number(hm[2]));
  if (!Number.isFinite(wall)) return null;
  const approx = zoneOffsetMs(wall, timeZone);
  if (approx === null) return null;
  const exact = zoneOffsetMs(wall - approx, timeZone);
  if (exact === null) return null;
  return new Date(wall - exact).toISOString();
}

/**
 * L'inverse : un instant ISO → les deux champs du formulaire, lus dans `timeZone`.
 *
 * ⛔ Sans elle, rouvrir une campagne planifiée réafficherait l'heure du NAVIGATEUR dans un
 * formulaire étiqueté « Santiago » : l'écran contredirait sa propre étiquette, et un simple
 * aller-retour sur la page déplacerait la campagne d'une heure à chaque passage.
 */
export function isoToZonedFields(iso: string, timeZone: string): { date: string; time: string } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const offset = zoneOffsetMs(ms, timeZone);
  if (offset === null) return null;
  const wall = new Date(ms + offset);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return {
    date: `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`,
    time: `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`,
  };
}

/** `UTC−03`, `UTC+05:30` — le décalage tel qu'il vaut À CETTE DATE, pas « en général ». */
export function zoneOffsetLabel(timeZone: string, instant: number): string {
  const off = zoneOffsetMs(instant, timeZone);
  if (off === null) return "";
  const total = Math.round(Math.abs(off) / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `UTC${off < 0 ? "−" : "+"}${String(h).padStart(2, "0")}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/**
 * Les fuseaux où cette marque publie, mis en tête — puis tous les autres.
 *
 * ⚠️ La liste courte est un CONFORT, jamais une limite : `Intl.supportedValuesOf` fournit la
 * liste IANA complète, et un marché qui n'est pas encore dans `MARKETS` reste sélectionnable.
 * Une liste fermée obligerait à livrer du code pour programmer un envoi dans un nouveau pays.
 */
const MARKETS = ["America/Santiago", "America/Sao_Paulo", "Europe/London", "UTC"];

/**
 * Le fuseau de planification retenu, et la façon de le lire — UNE seule, pour les DEUX écrans.
 *
 * ⛔ L'assistant et le panneau « Lock and schedule » programment la même chose. S'ils choisissaient
 * leur fuseau par défaut chacun de leur côté, une campagne créée dans l'un et replanifiée dans
 * l'autre changerait d'heure sans que personne ne touche au formulaire. La clé et la règle de
 * repli vivent donc ici, pas dans les composants.
 *
 * ⭐ Un fuseau retenu par une version antérieure du navigateur peut ne plus se résoudre : on ne le
 * reprend que s'il donne encore un décalage, sinon on retombe sur celui du navigateur. Et tout
 * passe par un `try` — en navigation privée, `localStorage` lève au lieu de rendre `null`.
 */
export const SCHEDULE_TZ_KEY = "nf:scheduleTimeZone";

export function readScheduleTimeZone(browser: string): string {
  try {
    const saved = localStorage.getItem(SCHEDULE_TZ_KEY);
    // ⛔ Canonicalisé AVANT d'être rendu : la liste du sélecteur ne contient que des noms primaires,
    // et un `value` en alias (`Europe/Kiev`) n'y trouverait aucune option — le champ retomberait en
    // silence sur le premier fuseau de la liste, à des heures du fuseau réellement choisi.
    if (saved && zoneOffsetLabel(saved, Date.now()) !== "") return zoneCanonique(saved);
  } catch {
    /* navigation privée : le réglage ne se retient pas, l'écran fonctionne quand même */
  }
  return browser;
}

export function saveScheduleTimeZone(zone: string): void {
  try {
    localStorage.setItem(SCHEDULE_TZ_KEY, zone);
  } catch {
    /* idem : le choix vaut pour cette page, sans être retenu */
  }
}

/**
 * La déduplication elle-même, séparée de la source — pour qu'elle soit PROUVABLE.
 *
 * ⭐⛔ POURQUOI CETTE SÉPARATION EXISTE. Le défaut ne se reproduit PAS dans le moteur du banc :
 * JavaScriptCore (bun) ne canonicalise rien et liste les alias tels quels, donc alias et nom
 * primaire ne s'y rencontrent jamais. Un test écrit contre `timeZoneOptions()` passait AUSSI avec
 * le code fautif — une suite verte qui ne prouve rien. En injectant la liste et la fonction de
 * canonicalisation, le banc rejoue le moteur où le défaut VIT (V8 : système en `Europe/Kiev`, liste
 * en `Europe/Kyiv`) et la mutation le fait tomber.
 *
 * ⛔ C'EST LA TÊTE DE LISTE QUI SE CANONISE, ET C'EST TOUT CE QUI EST NÉCESSAIRE. Le fuseau du
 * système est le seul à pouvoir arriver sous forme d'alias ; la liste du moteur, elle, est déjà
 * cohérente avec son propre `canon`. Une variante canonisant AUSSI chaque entrée de la liste a été
 * écrite, puis retirée : aucune mutation ne la faisait tomber (455 `Intl.DateTimeFormat` pour un
 * cas qu'aucun moteur ne produit). Contre-épreuve de ce qui reste : remplacer `canon(zone)` par
 * `zone` dans la boucle ci-dessous fait tomber 2 tests.
 */
export function groupesDeFuseaux(
  browser: string,
  tous: string[],
  canon: (zone: string) => string = zoneCanonique,
): { common: string[]; rest: string[] } {
  const vus = new Set<string>();
  const common: string[] = [];
  for (const zone of [browser, ...MARKETS]) {
    const canonique = canon(zone);
    if (canonique.length === 0 || vus.has(canonique)) continue;
    vus.add(canonique);
    common.push(canonique);
  }
  return { common, rest: tous.filter((zone) => !vus.has(zone)) };
}

export function timeZoneOptions(browser: string): { common: string[]; rest: string[] } {
  let all: string[] = [];
  try {
    all = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  return groupesDeFuseaux(browser, all);
}

/**
 * Un instant, tel qu'un humain le vérifie contre son calendrier. Remonté ici parce que deux
 * écrans en ont besoin (la liste des éditions, l'assistant de campagne) : deux copies du même
 * formatage finissent par afficher la même date de deux façons, et c'est l'écran qui a l'air faux.
 */
export function fmtWhen(dt: string | null | undefined): string {
  if (!dt) return "—";
  const d = new Date(dt);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}


/**
 * Un modèle → sa DERNIÈRE version publiée, étiquetée de quoi distinguer deux homonymes.
 *
 * ⛔ ON NE CHOISIT PLUS UNE VERSION, NULLE PART (décision d’Alix, 18/09/2026). Dans la
 * quasi-totalité des cas c’est la plus récente qu’on veut, et proposer les cinq précédentes
 * transformait un choix évident en question piège — avec, au bout, une campagne envoyée sur un
 * contenu périmé que rien à l’écran ne distinguait du contenu à jour.
 *
 * ⛔ LE MAXIMUM EST RECALCULÉ ICI, sur le numéro de version, jamais pris comme « la première ligne
 * du tableau ». L’ordre vient de `listPublishedVersions`, ailleurs : s’y fier ferait partir une
 * campagne sur une version périmée le jour où ce tri changerait, sans que rien ne le signale.
 *
 * ⛔ ET L’ÉTIQUETTE DÉSAMBIGUÏSE. Rien n’impose l’unicité d’un nom de modèle dans une marque : deux
 * modèles homonymes produisaient deux options RIGOUREUSEMENT identiques, dont une seule était la
 * bonne. Constaté sur Copper Kettle (deux « Boletín semanal Colo-Colo »). Le menu des versions
 * portait cette garde ; le menu des modèles, non — elle vit désormais au seul endroit qui construit
 * la liste, donc dans les deux écrans.
 */
/**
 * CE QUE LA COLONNE « Next / sent » DIT D'UN ENVOI UNIQUE.
 *
 * ⛔ ELLE AFFICHAIT `sentAt ?? scheduledAt`, SANS JAMAIS REGARDER SI C'ÉTAIT ARRIVÉ. Une date en
 * gris répondait aussi bien « c'est parti », « ça va partir » que « l'heure est passée et rien n'est
 * parti ». Les deux premiers sont normaux, le troisième est une panne — et c'est celui qu'Alix a
 * signalé le 18/09/2026.
 *
 * ⭐⛔ DES INSTANTS, JAMAIS DES CHAÎNES. PostgREST rend `2026-09-18T20:45:00+00:00`, `toISOString()`
 * rend `…T20:45:00.000Z` : à préfixe égal, '+' (0x2B) < '.' (0x2E), donc un `>` lexicographique
 * classerait « en retard » une campagne exactement à l'heure. Il répondrait juste tant que les deux
 * côtés viennent de la même source — donc en test, et pas en production.
 *
 * ⛔ `bloque` N'EST AFFIRMÉ QUE SUR DEUX FAITS QUI LE PROUVENT : le statut est resté `scheduled` (ni
 * `sending`, ni `paused`, ni `cancelled`) ET rien n'est jamais entré en file. Une campagne en pause
 * ou en cours d'envoi a une date passée elle aussi, et ce n'est pas la même chose ; c'est l'écran de
 * détail qui porte la raison, pas cette colonne.
 */
export type EtatPonctuelle =
  | { quoi: "envoye"; quand: string }
  | { quoi: "prevu"; quand: string }
  | { quoi: "bloque"; quand: string }
  | { quoi: "rien" };

/**
 * ⭐⛔ LE DÉLAI DE GRÂCE, ET IL N'EST PAS DÉCORATIF. À l'heure dite EXACTE, une file encore vide est
 * parfaitement normale : une campagne peut légitimement n'être prise qu'un peu APRÈS son heure.
 * Depuis le 22/09/2026, le drain résident la prend dans les secondes, et le cron `enqueue` (toutes
 * les 5 min, avance ZÉRO) au plus un tick plus tard ; 30 min reste une marge prudente si le
 * résident n'est pas déployé.
 *
 * ⛔ SANS CE DÉLAI, LE BADGE CRIERAIT AU LOUP sur des campagnes saines pendant quelques minutes, à
 * chaque envoi. On apprendrait à l'ignorer en trois jours, et le jour où il dit vrai il ne serait
 * plus lu. Une période de cron entière : passé ce délai, le fan-out a EU sa chance et ne l'a pas
 * prise.
 *
 * ⚠️ La borne haute existe déjà ailleurs : au-delà de 3 h de retard, le worker refuse la campagne
 * (`DEFAULT_MAX_LATE_MINUTES`) et la met en `paused` avec sa raison — elle n'est donc plus
 * `scheduled`, et c'est l'écran de détail qui prend le relais. Cet état ne couvre que l'entre-deux :
 * l'heure est passée, personne n'a rien fait, et rien ne le disait.
 */
export const GRACE_AVANT_ALERTE_MS = 30 * 60_000;

export function etatDUnePonctuelle(
  c: Pick<CampaignSummary, "status" | "scheduledAt" | "sentAt" | "enqueuedAt">,
  maintenantIso: string,
): EtatPonctuelle {
  if (c.sentAt) return { quoi: "envoye", quand: c.sentAt };
  if (!c.scheduledAt) return { quoi: "rien" };

  const prevu = Date.parse(c.scheduledAt);
  const maintenant = Date.parse(maintenantIso);
  // ⛔ Une date illisible n'invente PAS une alerte : on rend le fait brut et rien de plus. Annoncer
  // « bloqué » sur une date qu'on n'a pas su lire ferait chercher une panne qui n'existe pas.
  if (!Number.isFinite(prevu) || !Number.isFinite(maintenant)) return { quoi: "prevu", quand: c.scheduledAt };

  if (maintenant - prevu < GRACE_AVANT_ALERTE_MS) return { quoi: "prevu", quand: c.scheduledAt };
  if (c.status === "scheduled" && !c.enqueuedAt) return { quoi: "bloque", quand: c.scheduledAt };
  return { quoi: "prevu", quand: c.scheduledAt };
}

export function derniereVersionParModele(
  versions: PublishedVersion[],
): (PublishedVersion & { etiquette: string })[] {
  const parModele = new Map<string, PublishedVersion>();
  for (const v of versions) {
    const courant = parModele.get(v.templateId);
    if (!courant || v.version > courant.version) parModele.set(v.templateId, v);
  }
  const retenues = [...parModele.values()];
  return retenues
    .map((v) => {
      const homonyme = retenues.some(
        (autre) => autre.templateId !== v.templateId && autre.templateName === v.templateName,
      );
      return { ...v, etiquette: homonyme ? `${v.templateName} (${v.templateId.slice(0, 8)})` : v.templateName };
    })
    .sort((a, b) => a.etiquette.localeCompare(b.etiquette));
}
