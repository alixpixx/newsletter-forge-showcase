/**
 * Statistiques d'envoi par campagne et par édition (0085, features 6 et 7 du 24/09/2026).
 *
 * ⛔ MODULE NEUTRE : ni `getDb`, ni session, ni "use client". Il est importé par les pages serveur,
 * par la route d'export ET par le tableau client — un module client n'exporte vers le serveur que
 * des composants (garde `app/client-imports.test.ts`), et un module serveur ne doit jamais finir
 * dans le paquet du navigateur.
 *
 * Définitions validées par Alix le 24/09 : Sent = acceptés par Mailgun · Bounce = rebonds
 * DÉFINITIFS · Spam = plaintes · Open et Click UNIQUES · Open rate et CTR sur les DÉLIVRÉS SUIVIS.
 */

/** Un envoi : une édition d'une campagne récurrente, ou l'envoi unique d'une one-shot. */
export interface EnvoiStats {
  /** `null` = l'envoi unique d'une campagne one-shot. */
  occurrenceId: string | null;
  seq: number | null;
  localDate: string | null;
  sentAt: string | null;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  /** Délivrés dont le suivi ouverture/clic était ACTIF à l'envoi — le dénominateur des taux. */
  tracked: number;
  /** Délivrés partis avant que le suivi ne soit mémorisé (0085) : on ne sait pas. */
  trackingUnknown: number;
}

export interface CampagneStats {
  id: string;
  name: string;
  status: string;
  archived: boolean;
  /** Masquée des listes d'analytics (0093). Absente d'une base d'avant 0093 : rien n'y est masqué. */
  hidden: boolean;
  recurring: boolean;
  lastSentAt: string;
  /** Les plus récents d'abord. */
  editions: EnvoiStats[];
}

export type StatsCampagnes =
  | { known: true; total: number; campaigns: CampagneStats[] }
  | { known: false; reason: string };

const entier = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const texte = (v: unknown): string | null => (typeof v === "string" ? v : null);

function lireEnvoi(v: unknown): EnvoiStats | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = ["sent", "delivered", "bounced", "complained", "opened", "clicked", "tracked", "tracking_unknown"].map(
    (k) => entier(o[k]),
  );
  if (n.some((x) => x === null)) return null;
  const [sent, delivered, bounced, complained, opened, clicked, tracked, trackingUnknown] = n as number[];
  if (o.occurrence_id !== null && typeof o.occurrence_id !== "string") return null;
  return {
    occurrenceId: (o.occurrence_id as string | null) ?? null,
    seq: entier(o.seq),
    localDate: texte(o.local_date),
    sentAt: texte(o.sent_at),
    sent: sent!,
    delivered: delivered!,
    bounced: bounced!,
    complained: complained!,
    opened: opened!,
    clicked: clicked!,
    tracked: tracked!,
    trackingUnknown: trackingUnknown!,
  };
}

/**
 * Lit la réponse de `campaign_send_stats`. ⛔ Un champ manquant ou mal typé rend `null` — jamais un
 * zéro : un tableau de statistiques rempli de zéros sur une réponse illisible se lirait comme
 * « personne n'a rien reçu ».
 */
export function lireReponse(data: unknown): { total: number; campaigns: CampagneStats[] } | null {
  if (!data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  const total = entier(r.total);
  if (total === null || !Array.isArray(r.campaigns)) return null;
  const campaigns: CampagneStats[] = [];
  for (const c of r.campaigns) {
    if (!c || typeof c !== "object") return null;
    const o = c as Record<string, unknown>;
    const id = texte(o.id);
    const name = texte(o.name);
    const status = texte(o.status);
    const lastSentAt = texte(o.last_sent_at);
    if (!id || name === null || !status || !lastSentAt) return null;
    if (typeof o.archived !== "boolean" || typeof o.recurring !== "boolean" || !Array.isArray(o.editions)) return null;
    // `hidden` : absente avant 0093 (rien n'est masqué), mais PRÉSENTE et mal typée = réponse illisible.
    if (o.hidden !== undefined && typeof o.hidden !== "boolean") return null;
    const editions: EnvoiStats[] = [];
    for (const e of o.editions) {
      const lu = lireEnvoi(e);
      if (!lu) return null;
      editions.push(lu);
    }
    campaigns.push({
      id, name, status, archived: o.archived, hidden: o.hidden === true, recurring: o.recurring, lastSentAt, editions,
    });
  }
  return { total, campaigns };
}

type Compteurs = Omit<EnvoiStats, "occurrenceId" | "seq" | "localDate" | "sentAt">;

/** Les compteurs d'une campagne entière (`cumuler`) : ceux d'un envoi, plus ce qui a été laissé de côté. */
export type Cumul = Compteurs & {
  /** Éditions au suivi inconnu, sorties de l'ouverture et du clic (0 si rien n'est mesuré de toute façon). */
  exclues: number;
  /** Délivrés des éditions au suivi CONNU : la base du « 0 of N allow tracking ». */
  deliveredMesurables: number;
};

/**
 * Les compteurs d'une campagne entière : la somme de ses envois (chaque ligne d'outbox n'est que dans un).
 *
 * ⛔ LES ÉDITIONS AU SUIVI INCONNU (parties avant 0085) SORTENT DE L'OUVERTURE ET DU CLIC, ET SEULEMENT
 * D'EUX. Les additionner rendait toute la campagne « Not measured » — pour TOUJOURS, sur chaque série
 * commencée avant le 24/09/2026 (vu sur le banc : 10 éditions mesurées masquées par 2 anciennes). Les
 * garder dans le dénominateur ferait l'inverse : un taux calculé sur des destinataires dont on ignore
 * s'ils étaient suivis. Sent, Delivered, Bounce et Spam, eux, comptent tout. `exclues` le dit à l'écran.
 */
export function cumuler(editions: EnvoiStats[]): Cumul {
  const t = { sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, tracked: 0, trackingUnknown: 0 };
  let exclues = 0;
  let delivresConnus = 0;
  let delivresInconnus = 0;
  for (const e of editions) {
    t.sent += e.sent;
    t.delivered += e.delivered;
    t.bounced += e.bounced;
    t.complained += e.complained;
    if (e.trackingUnknown > 0) {
      exclues += 1;
      delivresInconnus += e.trackingUnknown;
      continue;
    }
    delivresConnus += e.delivered;
    t.opened += e.opened;
    t.clicked += e.clicked;
    t.tracked += e.tracked;
  }
  // Inconnu SEULEMENT si aucune édition au suivi connu n'a rien délivré : sinon la campagne est
  // mesurée sur ses éditions connues (ou « 0 of N allow tracking » si aucune n'est suivie).
  t.trackingUnknown = delivresConnus === 0 ? delivresInconnus : 0;
  return { ...t, exclues: delivresConnus === 0 ? 0 : exclues, deliveredMesurables: delivresConnus };
}

/**
 * Pourquoi l'ouverture et le clic ne sont PAS mesurés sur ces compteurs — `null` s'ils le sont.
 *
 * ⛔ UN TAUX NON MESURÉ N'EST JAMAIS 0 %. Le 24/09, 1 abonnement sur 1 269 acceptait le suivi : calculer
 * sur tous les délivrés afficherait « 0 % d'ouverture » partout. Et un envoi parti avant 0085 a un
 * suivi INCONNU : le mêler aux autres ferait un taux sur une population qu'on ne connaît pas.
 */
export function raisonNonMesure(c: Compteurs & { deliveredMesurables?: number }): string | null {
  if (c.trackingUnknown > 0) return "Not measured — sent before open and click tracking was recorded (Sep 24, 2026).";
  if (c.delivered === 0) return "Not measured — nothing delivered yet.";
  if (c.tracked === 0) {
    // Sur un cumul, N = les délivrés des éditions au suivi CONNU : les anciennes n'ont rien refusé.
    const n = c.deliveredMesurables ?? c.delivered;
    return `Not measured — 0 of ${n.toLocaleString("en-US")} delivered recipients allow open and click tracking.`;
  }
  return null;
}

/** La phrase qui dit ce que l'ouverture et le clic d'un cumul laissent de côté — `null` si rien. */
export function noteExclues(c: { exclues?: number }): string | null {
  if (!c.exclues) return null;
  return `Open and click leave out ${c.exclues} edition${c.exclues === 1 ? "" : "s"} sent before tracking was recorded (Sep 24, 2026).`;
}

export interface Taux {
  deliveryRate: number | null;
  bounceRate: number | null;
  spamRate: number | null;
  openRate: number | null;
  ctr: number | null;
}

/** Les taux, en fraction (0..1). `null` = non mesurable, jamais 0. */
export function taux(c: Compteurs): Taux {
  const div = (a: number, b: number) => (b > 0 ? a / b : null);
  const suivi = raisonNonMesure(c) === null;
  return {
    deliveryRate: div(c.delivered, c.sent),
    bounceRate: div(c.bounced, c.sent),
    spamRate: div(c.complained, c.delivered),
    openRate: suivi ? div(c.opened, c.tracked) : null,
    ctr: suivi ? div(c.clicked, c.tracked) : null,
  };
}

/** « 12.3% », une décimale. `null` ⇒ « — ». */
export function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

export function nombre(v: number): string {
  return v.toLocaleString("en-US");
}

/** « Sep 23, 2026 » en UTC : une date d'envoi ne doit pas changer de jour selon le fuseau du lecteur. */
export function jour(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Le nom d'un envoi dans une liste : « #3 · Sep 23, 2026 », ou « Single send » pour une one-shot. */
export function nomEnvoi(e: EnvoiStats): string {
  if (e.occurrenceId === null) return "Single send";
  return `${e.seq !== null ? `#${e.seq}` : "Edition"} · ${jour(e.localDate ?? e.sentAt)}`;
}

/* ------------------------------------------------------------------ *
 * Envois EN COURS (0096, demande d'Alix du 09/10/2026)
 * ------------------------------------------------------------------ */

/**
 * Un envoi qui part en ce moment : une one-shot `sending`, ou une édition `sending`.
 *
 * ⛔ Les compteurs d'événements ont les MÊMES définitions que `EnvoiStats` (`campaign_send_stats`) :
 * `taux()` et `raisonNonMesure()` s'y appliquent tels quels, et un chiffre ne change pas de sens quand
 * la campagne passe de l'encart « Sending now » au tableau.
 */
export interface EnvoiEnCours {
  campaignId: string;
  /** `null` = l'envoi unique d'une one-shot. */
  occurrenceId: string | null;
  name: string;
  recurring: boolean;
  seq: number | null;
  localDate: string | null;
  scheduledAt: string | null;
  /** Destinataires prévus au verrouillage ; `null` si la base ne l'a pas écrit. */
  planned: number | null;
  /** Lignes d'outbox créées pour cet envoi, tous statuts. */
  queued: number;
  sent: number;
  pending: number;
  inFlight: number;
  failed: number;
  skipped: number;
  sentLast15m: number;
  firstSentAt: string | null;
  lastSentAt: string | null;
  nextAttemptAt: string | null;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  tracked: number;
  trackingUnknown: number;
}

export type EnvoisEnCours =
  | { known: true; asOf: string; sending: EnvoiEnCours[] }
  | { known: false; reason: string };

const COMPTEURS_EN_COURS = [
  ["queued", "queued"],
  ["sent", "sent"],
  ["pending", "pending"],
  ["in_flight", "inFlight"],
  ["failed", "failed"],
  ["skipped", "skipped"],
  ["sent_last_15m", "sentLast15m"],
  ["delivered", "delivered"],
  ["bounced", "bounced"],
  ["complained", "complained"],
  ["opened", "opened"],
  ["clicked", "clicked"],
  ["tracked", "tracked"],
  ["tracking_unknown", "trackingUnknown"],
] as const;

/**
 * Lit la réponse de `campaign_send_progress`. ⛔ Comme `lireReponse` : un champ manquant ou mal typé
 * rend `null`, jamais un zéro — une barre « 0 of 13,347 sent » sur une réponse illisible ferait croire
 * que l'envoi est bloqué.
 */
export function lireEnCours(data: unknown): { asOf: string; sending: EnvoiEnCours[] } | null {
  if (!data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  const asOf = texte(r.as_of);
  if (!asOf || !Array.isArray(r.sending)) return null;
  const sending: EnvoiEnCours[] = [];
  for (const v of r.sending) {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const campaignId = texte(o.campaign_id);
    const name = texte(o.name);
    if (!campaignId || name === null || typeof o.recurring !== "boolean") return null;
    if (o.occurrence_id !== null && typeof o.occurrence_id !== "string") return null;
    if (o.planned !== null && entier(o.planned) === null) return null;
    const compteurs: Record<string, number> = {};
    for (const [cle, prop] of COMPTEURS_EN_COURS) {
      const n = entier(o[cle]);
      if (n === null) return null;
      compteurs[prop] = n;
    }
    sending.push({
      campaignId,
      occurrenceId: (o.occurrence_id as string | null) ?? null,
      name,
      recurring: o.recurring,
      seq: entier(o.seq),
      localDate: texte(o.local_date),
      scheduledAt: texte(o.scheduled_at),
      planned: o.planned === null ? null : (o.planned as number),
      firstSentAt: texte(o.first_sent_at),
      lastSentAt: texte(o.last_sent_at),
      nextAttemptAt: texte(o.next_attempt_at),
      ...(compteurs as Pick<EnvoiEnCours, (typeof COMPTEURS_EN_COURS)[number][1]>),
    });
  }
  return { asOf, sending };
}

/**
 * Le « sur combien » de la barre : les prévus au verrouillage, sinon ce qui est en file.
 * ⛔ Jamais moins que ce qui est en file : si la base sous-compte les prévus, la barre ne dépasse pas 100 %.
 */
export function cibleEnvoi(e: EnvoiEnCours): number {
  return Math.max(e.planned ?? 0, e.queued);
}

/** Ce qui reste à partir : en attente + en vol, et ce qui n'est pas encore entré en file. */
export function restants(e: EnvoiEnCours): number {
  return e.pending + e.inFlight + Math.max(0, cibleEnvoi(e) - e.queued);
}

/** Le rythme des 15 dernières minutes, en mails par heure. */
export function rythmeParHeure(e: EnvoiEnCours): number {
  return e.sentLast15m * 4;
}

/**
 * L'heure de fin estimée au rythme des 15 dernières minutes (ISO), ou `null` si on ne sait pas.
 * ⛔ Rien parti depuis 15 min = PAS d'estimation : « fin dans ∞ » ou une heure inventée seraient faux.
 */
export function finEstimee(e: EnvoiEnCours, asOf: string): string | null {
  const reste = restants(e);
  const rythme = rythmeParHeure(e);
  const t = Date.parse(asOf);
  if (reste === 0 || rythme === 0 || !Number.isFinite(t)) return null;
  return new Date(t + (reste / rythme) * 3_600_000).toISOString();
}

/** « 14:19 UTC » : l'heure d'un envoi en cours ne doit pas changer selon le fuseau du lecteur. */
export function heure(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return `${new Date(t).toISOString().slice(11, 16)} UTC`;
}

/** « 3 h 05 min », « 12 min », « less than a minute » — une durée positive en millisecondes. */
export function duree(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "less than a minute";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

/** En-têtes et lignes de l'export CSV — les colonnes de l'écran, taux en pourcentage à une décimale. */
export const COLONNES_CSV = [
  "Edition",
  "Date",
  "Sent",
  "Delivered",
  "Bounce",
  "Spam",
  "Open",
  "Open rate",
  "Click",
  "CTR",
  "Tracked recipients",
] as const;

export function lignesCsv(editions: EnvoiStats[]): string[][] {
  return editions.map((e) => {
    const t = taux(e);
    const mesure = raisonNonMesure(e) === null;
    // ⛔ Une cellule VIDE pour ce qui n'est pas mesuré, jamais « 0 » : un tableur additionnerait le zéro.
    return [
      e.occurrenceId === null ? "Single send" : e.seq !== null ? `#${e.seq}` : "",
      (e.localDate ?? e.sentAt ?? "").slice(0, 10),
      String(e.sent),
      String(e.delivered),
      String(e.bounced),
      String(e.complained),
      mesure ? String(e.opened) : "",
      t.openRate === null ? "" : (t.openRate * 100).toFixed(1),
      mesure ? String(e.clicked) : "",
      t.ctr === null ? "" : (t.ctr * 100).toFixed(1),
      e.trackingUnknown > 0 ? "" : String(e.tracked),
    ];
  });
}
