/**
 * Analytics du comportement (0094, demande d'Alix du 07/10/2026 : « le maximum d'info sur tous mes
 * envois ») : engagement d'une campagne, résultats des automations, audience, activité d'un abonné.
 *
 * ⛔ MODULE NEUTRE (comme `campaign-stats.ts`) : ni `getDb`, ni session, ni "use client" — importé par
 * les pages serveur, les routes d'export et les composants client.
 *
 * ⛔ LECTURE STRICTE : un champ manquant ou mal typé rend `null`, et l'appelant affiche « non mesuré »
 * avec sa raison — jamais des zéros, qui se liraient « personne n'a rien ouvert ».
 */

export type Lecture<T> = { known: true; value: T } | { known: false; reason: string };

// ---------------------------------------------------------------------------------------------
// Lecteurs élémentaires
// ---------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const objet = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const entier = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const texte = (v: unknown): string | null => (typeof v === "string" ? v : null);
const texteOuNul = (v: unknown): string | null | undefined => (v === null ? null : typeof v === "string" ? v : undefined);

/** Les entiers `cles` de `o`, ou `null` si un seul manque. */
function entiers<K extends string>(o: Obj, cles: readonly K[]): Record<K, number> | null {
  const r = {} as Record<K, number>;
  for (const k of cles) {
    const n = entier(o[k]);
    if (n === null) return null;
    r[k] = n;
  }
  return r;
}

/** Chaque élément de `v` lu par `lire` ; `null` si `v` n'est pas un tableau ou si UN élément est illisible. */
function tableau<T>(v: unknown, lire: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const r: T[] = [];
  for (const x of v) {
    const lu = lire(x);
    if (lu === null) return null;
    r.push(lu);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// 1. Engagement d'une campagne — `campaign_engagement`
// ---------------------------------------------------------------------------------------------
export const DIMENSIONS = ["device", "client", "os", "country", "city"] as const;
export type NomDimension = (typeof DIMENSIONS)[number];

export interface LigneDimension {
  /** `null` = Mailgun n'a pas su (affiché « Unknown »). */
  value: string | null;
  /** Destinataires distincts. */
  unique: number;
  /** Événements (ouvertures + clics). */
  total: number;
}

export interface EngagementCampagne {
  sent: number;
  tracked: number;
  trackingUnknown: number;
  opens: { unique: number; total: number; uniqueHuman: number; bot: number };
  clicks: { unique: number; total: number };
  links: { url: string; unique: number; total: number }[];
  /** Délai entre l'envoi et la PREMIÈRE ouverture / le PREMIER clic de chaque destinataire ; 72 = « 72 h et plus ». */
  firstActionHours: { hour: number; opens: number; clicks: number }[];
  dimensions: Record<NomDimension, LigneDimension[]>;
}

function lireLigneDimension(v: unknown): LigneDimension | null {
  const o = objet(v);
  if (!o) return null;
  const value = texteOuNul(o.value);
  const n = entiers(o, ["unique", "total"] as const);
  if (value === undefined || !n) return null;
  return { value, ...n };
}

export function lireEngagementCampagne(data: unknown): EngagementCampagne | null {
  const o = objet(data);
  if (!o) return null;
  const tetes = entiers(o, ["sent", "tracked", "tracking_unknown"] as const);
  const ouv = objet(o.opens);
  const cli = objet(o.clicks);
  if (!tetes || !ouv || !cli) return null;
  const opens = entiers(ouv, ["unique", "total", "unique_human", "bot"] as const);
  const clicks = entiers(cli, ["unique", "total"] as const);
  if (!opens || !clicks) return null;
  const links = tableau(o.links, (x) => {
    const l = objet(x);
    const url = l && texte(l.url);
    const n = l && entiers(l, ["unique", "total"] as const);
    return url && n ? { url, ...n } : null;
  });
  const firstActionHours = tableau(o.first_action_hours, (x) => {
    const h = objet(x);
    const n = h && entiers(h, ["hour", "opens", "clicks"] as const);
    return n && n.hour <= 72 ? n : null;
  });
  const dims = objet(o.dimensions);
  if (!links || !firstActionHours || !dims) return null;
  const dimensions = {} as Record<NomDimension, LigneDimension[]>;
  for (const d of DIMENSIONS) {
    // Une dimension sans aucun événement est absente de la réponse : c'est une liste vide, pas une erreur.
    const lu = dims[d] === undefined ? [] : tableau(dims[d], lireLigneDimension);
    if (!lu) return null;
    dimensions[d] = lu;
  }
  return {
    sent: tetes.sent,
    tracked: tetes.tracked,
    trackingUnknown: tetes.tracking_unknown,
    opens: { unique: opens.unique, total: opens.total, uniqueHuman: opens.unique_human, bot: opens.bot },
    clicks,
    links,
    firstActionHours,
    dimensions,
  };
}

// ---------------------------------------------------------------------------------------------
// 2. Résultats des automations — `automation_send_stats`
// ---------------------------------------------------------------------------------------------
const CLES_ETAPE = [
  "step", "real", "simulated", "sent", "failed", "skipped", "queued",
  "delivered", "bounced", "complained", "opened", "clicked", "tracked",
] as const;

export type EtapeAutomation = Record<(typeof CLES_ETAPE)[number], number> & { lastAt: string | null };

export interface ResultatsAutomation {
  id: string;
  name: string;
  status: string;
  trigger: string | null;
  steps: EtapeAutomation[];
}

export function lireResultatsAutomations(data: unknown): ResultatsAutomation[] | null {
  const o = objet(data);
  if (!o) return null;
  return tableau(o.automations, (x) => {
    const a = objet(x);
    if (!a) return null;
    const id = texte(a.id);
    const name = texte(a.name);
    const status = texte(a.status);
    const trigger = texteOuNul(a.trigger);
    const steps = tableau(a.steps, (y) => {
      const s = objet(y);
      const n = s && entiers(s, CLES_ETAPE);
      const lastAt = s ? texteOuNul(s.last_at) : undefined;
      return n && lastAt !== undefined ? { ...n, lastAt } : null;
    });
    if (!id || name === null || !status || trigger === undefined || !steps) return null;
    return { id, name, status, trigger, steps };
  });
}

/** Le cumul de toutes les étapes d'une automation. */
export function cumulAutomation(steps: EtapeAutomation[]): Omit<EtapeAutomation, "step" | "lastAt"> {
  const t = {
    real: 0, simulated: 0, sent: 0, failed: 0, skipped: 0, queued: 0,
    delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, tracked: 0,
  };
  for (const s of steps) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += s[k];
  return t;
}

// ---------------------------------------------------------------------------------------------
// 3. Audience — `audience_engagement`
// ---------------------------------------------------------------------------------------------
export interface CaseCarte {
  /** 1 = lundi … 7 = dimanche (ISO), dans le fuseau de l'édition principale. */
  dow: number;
  hour: number;
  opens: number;
  clicks: number;
}

export interface SourceAudience {
  source: string;
  total: number;
  active: number;
  pending: number;
  contacts: number;
  unsubscribed: number;
  /** Actifs qui ont déjà ouvert ou cliqué. */
  engaged: number;
  /** Score moyen des actifs ; `null` si aucun actif. */
  avgScore: number | null;
}

export const METRIQUES_SEMAINE = ["signups", "imported", "confirmations", "unsubscribes", "readers"] as const;
export type MetriqueSemaine = (typeof METRIQUES_SEMAINE)[number];

export interface Audience {
  timezone: string;
  since: string;
  /** Niveau d'engagement des abonnés ACTIFS → nombre. */
  levels: Record<string, number>;
  heatmap: CaseCarte[];
  sources: SourceAudience[];
  weekly: { week: string; metric: MetriqueSemaine; count: number }[];
}

export function lireAudience(data: unknown): Audience | null {
  const o = objet(data);
  if (!o) return null;
  const timezone = texte(o.timezone);
  const since = texte(o.since);
  const lv = objet(o.levels);
  if (!timezone || !since || !lv) return null;
  const levels: Record<string, number> = {};
  for (const [k, v] of Object.entries(lv)) {
    const n = entier(v);
    if (n === null) return null;
    levels[k] = n;
  }
  const heatmap = tableau(o.heatmap, (x) => {
    const c = objet(x);
    const n = c && entiers(c, ["dow", "hour", "opens", "clicks"] as const);
    return n && n.dow >= 1 && n.dow <= 7 && n.hour <= 23 ? n : null;
  });
  const sources = tableau(o.sources, (x) => {
    const s = objet(x);
    if (!s) return null;
    const source = texte(s.source);
    const n = entiers(s, ["total", "active", "pending", "contacts", "unsubscribed", "engaged"] as const);
    const avgScore = s.avg_score === null ? null : typeof s.avg_score === "number" ? s.avg_score : undefined;
    return source && n && avgScore !== undefined ? { source, ...n, avgScore } : null;
  });
  const weekly = tableau(o.weekly, (x) => {
    const w = objet(x);
    const week = w && texte(w.week);
    const metric = w && texte(w.metric);
    const count = w && entier(w.count);
    if (!week || !metric || count === null || !(METRIQUES_SEMAINE as readonly string[]).includes(metric)) return null;
    return { week, metric: metric as MetriqueSemaine, count };
  });
  if (!heatmap || !sources || !weekly) return null;
  return { timezone, since, levels, heatmap, sources, weekly };
}

// ---------------------------------------------------------------------------------------------
// 4. Activité d'un abonné — `subscriber_activity`
// ---------------------------------------------------------------------------------------------
export interface EvenementActivite {
  type: string;
  occurredAt: string;
  severity: string | null;
  reason: string | null;
  url: string | null;
  deviceType: string | null;
  clientName: string | null;
  clientOs: string | null;
  bot: string | null;
  country: string | null;
  city: string | null;
}

export interface MessageActivite {
  id: string;
  kind: string;
  subject: string | null;
  status: string;
  createdAt: string;
  sentAt: string | null;
  /** `null` = parti avant que le suivi soit mémorisé (0085). */
  tracked: boolean | null;
  campaignId: string | null;
  campaignName: string | null;
  events: EvenementActivite[];
}

export interface AbonnementActivite {
  id: string;
  status: string;
  openCount: number;
  clickCount: number;
  lastOpenAt: string | null;
  lastClickAt: string | null;
  lastEngagementAt: string | null;
  engagementScore: number | null;
  engagementLevel: string | null;
  trackingConsent: boolean | null;
  createdAt: string;
}

export interface ActiviteAbonne {
  subscriptions: AbonnementActivite[];
  totalMessages: number;
  messages: MessageActivite[];
}

function lireEvenement(v: unknown): EvenementActivite | null {
  const e = objet(v);
  if (!e) return null;
  const type = texte(e.type);
  const occurredAt = texte(e.occurred_at);
  const champs = ["severity", "reason", "url", "device_type", "client_name", "client_os", "bot", "country", "city"].map(
    (k) => texteOuNul(e[k]),
  );
  if (!type || !occurredAt || champs.some((c) => c === undefined)) return null;
  const [severity, reason, url, deviceType, clientName, clientOs, bot, country, city] = champs as (string | null)[];
  return { type, occurredAt, severity, reason, url, deviceType, clientName, clientOs, bot, country, city };
}

export function lireActiviteAbonne(data: unknown): ActiviteAbonne | null {
  const o = objet(data);
  if (!o) return null;
  const totalMessages = entier(o.total_messages);
  const subscriptions = tableau(o.subscriptions, (x) => {
    const s = objet(x);
    if (!s) return null;
    const id = texte(s.id);
    const status = texte(s.status);
    const createdAt = texte(s.created_at);
    const openCount = entier(s.open_count ?? 0);
    const clickCount = entier(s.click_count ?? 0);
    const dates = ["last_open_at", "last_click_at", "last_engagement_at", "engagement_level"].map((k) => texteOuNul(s[k] ?? null));
    const score = s.engagement_score === null || s.engagement_score === undefined ? null : entier(s.engagement_score);
    const tc = s.tracking_consent === null || s.tracking_consent === undefined ? null
      : typeof s.tracking_consent === "boolean" ? s.tracking_consent : undefined;
    if (!id || !status || !createdAt || openCount === null || clickCount === null || tc === undefined
      || dates.some((d) => d === undefined) || (s.engagement_score != null && score === null)) return null;
    const [lastOpenAt, lastClickAt, lastEngagementAt, engagementLevel] = dates as (string | null)[];
    return {
      id, status, openCount, clickCount, lastOpenAt, lastClickAt, lastEngagementAt,
      engagementScore: score, engagementLevel, trackingConsent: tc, createdAt,
    };
  });
  const messages = tableau(o.messages, (x) => {
    const m = objet(x);
    if (!m) return null;
    const id = texte(m.id);
    const kind = texte(m.kind);
    const status = texte(m.status);
    const createdAt = texte(m.created_at);
    const subject = texteOuNul(m.subject);
    const sentAt = texteOuNul(m.sent_at);
    const campaignId = texteOuNul(m.campaign_id);
    const campaignName = texteOuNul(m.campaign_name);
    const tracked = m.tracked === null ? null : typeof m.tracked === "boolean" ? m.tracked : undefined;
    const events = tableau(m.events, lireEvenement);
    if (!id || !kind || !status || !createdAt || subject === undefined || sentAt === undefined
      || campaignId === undefined || campaignName === undefined || tracked === undefined || !events) return null;
    return { id, kind, subject, status, createdAt, sentAt, tracked, campaignId, campaignName, events };
  });
  if (totalMessages === null || !subscriptions || !messages) return null;
  return { subscriptions, totalMessages, messages };
}

// ---------------------------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------------------------
/** « Unknown » pour une valeur que Mailgun n'a pas su donner. */
export function valeurDimension(v: string | null): string {
  return v ?? "Unknown";
}

export const JOURS_ISO = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
