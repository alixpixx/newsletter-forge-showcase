/**
 * Catalogue FERMÉ des déclencheurs d'automation — partagé par l'admin et le worker.
 *
 * ⛔ L'ADMIN N'EXPOSE QUE CE CATALOGUE : PAS DE REQUÊTE LIBRE. Une automation choisit un déclencheur
 * de cette liste, règle des filtres et des étapes bornés ici, et c'est tout. La sélection réelle des
 * destinataires vit en SQL (`automation_due`, migration 0082) ; ce fichier en est la SPÉCIFICATION
 * exécutable — chaque garde y porte un nom, une raison, et un banc qui prouve qu'elle mord.
 *
 * ⛔ LA MÊME RÈGLE VIT À DEUX ENDROITS, ET C'EST VOULU ICI COMME DANS `purposeGateFilter`. Le SQL
 * sélectionne (atomiquement, avec la trace d'idempotence) ; ce fichier explique et teste. Toute
 * modification d'une garde ci-dessous se reporte dans 0082, dans la branche du même déclencheur, et
 * inversement. `migration-sync.test.ts` relit 0082 et rougit si la liste des déclencheurs, celle des
 * transactionnels ou celle des variables de payload divergent.
 *
 * ⚠️ POURQUOI DEUX KINDS ET PAS UN PAR AUTOMATION. Chaque kind neuf touche 7 à 9 endroits du dépôt,
 * dont deux oublis silencieux (carte `envoi.md` § 6). `automation` porte le marketing (abonnement
 * actif, finalité, `List-Unsubscribe`) ; `automation_tx` le transactionnel strict, et SEULEMENT pour
 * les déclencheurs de `TX_TRIGGER_STATUS`.
 */
import { purposeAllowed } from "../../config/src/send-policy";
import { legalBasisForRegime, type ConsentPurpose } from "../../config/src/consent";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Fenêtre de lecture des événements, en jours.
 *
 * ⛔ MÊME BORNE QUE L'ÂGE MAXIMAL D'UNE LIGNE DE FILE (`gate.ts` OUTBOX_AGE_MAX_JOURS). Un
 * événement plus vieux ne déclenche plus rien : un « merci pour vos préférences » dix jours après le
 * geste n'est plus rattachable à ce geste. Tout délai d'étape d'un déclencheur événementiel doit donc
 * rester SOUS cette fenêtre, sinon l'étape ne pourrait jamais partir (voir `maxDelayHours`).
 */
export const EVENT_HORIZON_DAYS = 7;
export const EVENT_HORIZON_MS = EVENT_HORIZON_DAYS * DAY_MS;

/** Écart minimal entre deux étapes d'une même séquence, quel que soit le réglage des délais. */
export const MIN_STEP_GAP_HOURS = 12;

export const TRIGGER_IDS = [
  "confirmation_reminder",
  "preferences_updated",
  "welcome_back",
  "reengagement",
  "sunset",
  "anniversary",
  "consent_renewal",
  "soft_bounce_rule",
  "optin_promo",
] as const;
export type TriggerId = (typeof TRIGGER_IDS)[number];

export const AUTOMATION_STATUSES = ["draft", "simulation", "live", "paused"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const PURPOSES = ["content", "offers", "events", "partners"] as const;
export type Purpose = ConsentPurpose;

/**
 * - `marketing`     : kind `automation` — abonnement actif, finalité accordée, `List-Unsubscribe`.
 * - `transactional` : kind `automation_tx` — la SEULE exception à la porte `not_active`, bornée au
 *                     déclencheur et au statut de `TX_TRIGGER_STATUS`, sans suivi ni finalité.
 * - `silent`        : n'envoie RIEN (le sunset écrit `sunset_at`).
 * - `system`        : affiché seulement ; la logique vit ailleurs (rebonds mous : webhook + 0081).
 */
export type Policy = "marketing" | "transactional" | "silent" | "system";

export const AUTOMATION_KINDS = { marketing: "automation", transactional: "automation_tx" } as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[keyof typeof AUTOMATION_KINDS];

/**
 * Déclencheurs transactionnels et le statut de souscription EXIGÉ à l'envoi.
 *
 * ⛔ C'EST LA LISTE QUE LA PORTE DU WORKER (`gate.ts`) ET LA CONTRAINTE `email_outbox_automation_tx_trigger`
 * (0082) APPLIQUENT. Une ligne `automation_tx` dont le déclencheur n'y figure pas ne part pas —
 * l'exception au statut ne s'étend jamais « au suivant qui passe ».
 *  - relance de confirmation : la souscription doit être ENCORE `pending` (confirmée entre-temps =
 *    plus rien à relancer) ;
 *  - renouvellement : la souscription doit être `active` (pas de « renouvelez » à un désinscrit).
 */
export const TX_TRIGGER_STATUS: Readonly<Record<string, "pending" | "active">> = Object.freeze({
  confirmation_reminder: "pending",
  consent_renewal: "active",
});

/* ------------------------------------------------------------------------------------------------
 * Variables
 * ---------------------------------------------------------------------------------------------- */

/**
 * - `ready`          : un jeton du registre `MERGE_VARS` la sert déjà (`token`).
 * - `needs_registry` : 0082 l'écrit dans le payload de la ligne (`payloadKey`), mais le registre ne
 *                      la connaît pas encore — un jeton hors registre est RETIRÉ en silence au rendu.
 *                      Branchement prévu à l'étape 12 (éditeur) ; en attendant, l'éditeur la SIGNALE.
 * - `no_data`        : aucune donnée ni route n'existe ; l'éditeur la SIGNALE et ne la propose pas.
 */
export type VariableStatus = "ready" | "needs_registry" | "no_data";

export interface VariableSpec {
  label: string;
  status: VariableStatus;
  /** Jeton du registre `@nf/render` quand il existe. */
  token?: string;
  /** Clé du payload écrite par `automation_due` (0082). */
  payloadKey?: string;
  note?: string;
}

export const VARIABLES = {
  first_name: {
    label: "First name",
    status: "ready",
    token: "first_name",
    payloadKey: "first_name",
    // ⚠️ Affichée dans l'éditeur : pas de chiffre figé ici (mesuré le 24/09 : 0 sur 58 abonnés réels),
    // un compte d'écran doit venir d'une lecture, pas d'une chaîne qui vieillit.
    note: "Most subscribers have none today (the forms rarely ask for it): guard any greeting with has_first_name.",
  },
  email: { label: "Email address", status: "ready", token: "email" },
  property: { label: "Brand name", status: "ready", token: "asset_name" },
  language: { label: "Language", status: "ready", token: "locale" },
  preferences_link: { label: "Preferences link", status: "ready", token: "preferences_url" },
  unsubscribe_link: { label: "Unsubscribe link", status: "ready", token: "unsubscribe_url" },
  confirmation_link: { label: "Confirmation link", status: "ready", token: "confirm_url" },
  optin_id: { label: "Opt-in ID", status: "needs_registry", payloadKey: "optin_id" },
  optin_source: { label: "Opt-in name", status: "needs_registry", payloadKey: "optin_source" },
  signup_date: { label: "Signup date", status: "needs_registry", payloadKey: "signup_date" },
  days_inactive: { label: "Days without engagement", status: "needs_registry", payloadKey: "days_inactive" },
  token_expiry: { label: "Link expiry", status: "needs_registry", payloadKey: "token_expiry" },
  updated_fields: { label: "Updated preferences", status: "needs_registry", payloadKey: "updated_fields" },
  resubscribe_link: {
    label: "Resubscribe link",
    status: "no_data",
    note: "No resubscribe route exists yet.",
  },
  renew_link: {
    label: "Consent renewal link",
    status: "no_data",
    note: "No signed renewal route exists yet.",
  },
  promo_content: {
    label: "Promotion",
    status: "no_data",
    note: "No promotion data is stored: write the offer in the template itself.",
  },
  club_preference: {
    label: "Club preference",
    status: "no_data",
    note: "Clubs only exist as interests; the forms do not collect a preferred club.",
  },
} as const satisfies Record<string, VariableSpec>;
export type VariableName = keyof typeof VARIABLES;

/* ------------------------------------------------------------------------------------------------
 * Faits, contexte, ancre, garde
 * ---------------------------------------------------------------------------------------------- */

/** Une ligne de `consent_event` de LA souscription évaluée. */
export interface ConsentEventFact {
  id: number;
  type: string;
  method: string | null;
  purpose: string | null;
  at: string;
}

/** Une ligne de `automation_send` qui concerne LA souscription évaluée. */
export interface SendFact {
  automationId: string;
  trigger: TriggerId;
  step: number;
  periodKey: string;
  simulated: boolean;
  at: string;
}

/**
 * Ce que la base sait d'UNE souscription — exactement les colonnes que lit 0082, rien de plus.
 */
export interface SubscriptionFacts {
  status: string;
  isDemo: boolean;
  /** `is_suppressed(email, asset)` : toute suppression, portée marque ou globale. */
  suppressed: boolean;
  sunsetAt: string | null;
  createdAt: string;
  consentAt: string | null;
  lastClickAt: string | null;
  lastResponseAt: string | null;
  trackingConsent: boolean;
  optinId: string | null;
  language: string | null;
  interestIds: readonly number[];
  /** Les labels d'automation portés par les captures de CETTE souscription (`capture_event.automation_label`, 0095). */
  labels: readonly string[];
  grantedPurposes: Record<string, boolean | undefined>;
  /** Régime de l'édition de la souscription (repli : première édition de la marque). */
  regime: string | null;
  events: readonly ConsentEventFact[];
  /** La confirmation d'origine est PARTIE (`email_outbox` kind `confirmation`, `sent`, après la demande). */
  confirmationSent: boolean;
  /** Le DERNIER jeton de confirmation est déjà confirmé. */
  tokenConfirmed: boolean;
  sends: readonly SendFact[];
}

export interface StepSpec {
  delay_hours: number;
  template_version_id?: string | null;
}

export interface AutomationFilters {
  optin_ids?: string[];
  languages?: string[];
  interest_ids?: number[];
  /** Slugs de labels d'automation (0095) : la souscription a au moins une capture portant l'un d'eux. */
  labels?: string[];
}

/**
 * La forme d'un slug de label — celle des contraintes de 0095 et de `apps/public/src/lib/automation-label.ts`.
 * `migration-sync.test.ts` vérifie qu'elle est bien celle de la migration.
 */
export const LABEL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface EvalContext {
  now: Date;
  automationId: string;
  /** Étape évaluée, à partir de 1. */
  step: number;
  steps: readonly StepSpec[];
  settings: Record<string, unknown>;
  filters: AutomationFilters;
  purpose: Purpose | null;
  /** Curseur `consent_event.id` de l'automation (déclencheurs événementiels). */
  eventCursor: number | null;
  /** La passe écrit-elle en simulation ? (l'étape précédente doit l'avoir été DANS LE MÊME MODE) */
  simulated: boolean;
}

/** Le moment à partir duquel on compte le délai, et la clé qui rend l'envoi unique. */
export interface Anchor {
  at: Date;
  periodKey: string;
  eventId?: number;
  info?: Record<string, unknown>;
}

export interface Guard {
  id: string;
  /** Pourquoi la garde existe, en une phrase (affichée dans l'admin : « Guardrails »). */
  why: string;
  check: (f: SubscriptionFacts, c: EvalContext, a: Anchor) => boolean;
}

export interface SettingSpec {
  type: "boolean" | "integer";
  default: boolean | number;
  min?: number;
  max?: number;
  /** Affiché, jamais appliqué par le moteur (voir `soft_bounce_rule`). */
  readOnly?: boolean;
  label: string;
}

export interface TriggerSpec {
  id: TriggerId;
  /** Numéro de la ligne dans le tableau d'Alix (`Automation campaigns - Sheet1.csv`). */
  sheetRow: number;
  label: string;
  description: string;
  policy: Policy;
  kind: AutomationKind | null;
  source: "event" | "date" | "status" | "none";
  /** Le moteur l'exécute-t-il ? (`false` : affichage seul) */
  engine: boolean;
  /** Peut-il passer `live` aujourd'hui ? Sinon, pourquoi. */
  liveBlockedReason: string | null;
  defaultPurpose: Purpose | null;
  steps: { min: number; max: number; minDelayHours: number; maxDelayHours: number; defaultDelaysHours: number[]; requiresTemplate: boolean };
  settings: Record<string, SettingSpec>;
  /**
   * Filtres dont AU MOINS UN est exigé (ex. la promo exige un opt-in ou un label, 0095).
   * ⛔ Même règle que `missing_optin_filter` dans `automation_due`.
   */
  requiredFilter: readonly (keyof AutomationFilters)[] | null;
  variables: readonly VariableName[];
  /** Ordre des candidats quand le plafond coupe : `oldest` = ancre la plus ancienne d'abord. */
  order: "oldest" | "newest";
  anchor: (f: SubscriptionFacts, c: EvalContext) => Anchor | null;
  guards: readonly Guard[];
}

/* ------------------------------------------------------------------------------------------------
 * Aides
 * ---------------------------------------------------------------------------------------------- */

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Date UTC `YYYY-MM-DD` — la clé de période des déclencheurs datés (même format que `to_char` en SQL). */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Le jour anniversaire de `d0` l'année `y`, à 00:00 UTC.
 * ⚠️ Un 29 février tombe le 28 les années non bissextiles — exactement ce que fait Postgres avec
 * `date + interval 'n years'`, que 0082 utilise. `Date.UTC(y, 1, 29)` rendrait le 1er mars.
 */
export function anniversaryOf(d0: Date, y: number): Date {
  const m = d0.getUTCMonth();
  const day = m === 1 && d0.getUTCDate() === 29 && !isLeap(y) ? 28 : d0.getUTCDate();
  return new Date(Date.UTC(y, m, day));
}

/** Ajout de mois à la Postgres : le jour est ramené au dernier jour du mois s'il le dépasse. */
export function addMonthsUtc(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const cible = new Date(Date.UTC(y, m, 1));
  const dernier = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      cible.getUTCFullYear(),
      cible.getUTCMonth(),
      Math.min(d.getUTCDate(), dernier),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
}

function lastEvent(f: SubscriptionFacts, pred: (e: ConsentEventFact) => boolean): ConsentEventFact | null {
  let best: ConsentEventFact | null = null;
  for (const e of f.events) if (pred(e) && (best === null || e.id > best.id)) best = e;
  return best;
}

function delayMs(c: EvalContext): number {
  return (c.steps[c.step - 1]?.delay_hours ?? Number.POSITIVE_INFINITY) * HOUR_MS;
}

function stepGapMs(c: EvalContext): number {
  const cur = c.steps[c.step - 1]?.delay_hours ?? 0;
  const prev = c.steps[c.step - 2]?.delay_hours ?? 0;
  return Math.max(cur - prev, MIN_STEP_GAP_HOURS) * HOUR_MS;
}

function setting<T extends boolean | number>(c: EvalContext, spec: TriggerSpec | null, key: string, fallback: T): T {
  const v = c.settings[key];
  if (typeof v === typeof fallback) return v as T;
  const d = spec?.settings[key]?.default;
  return (typeof d === typeof fallback ? d : fallback) as T;
}

/**
 * La référence d'engagement (décision D4 du plan) : dernier clic SUIVI, dernière visite du centre de
 * préférences, confirmation — l'inscription en plancher. ⛔ Pas l'ouverture : sans consentement de
 * suivi il n'y en a pas, et avec, Apple MPP la fabrique.
 */
export function engagementRef(f: SubscriptionFacts): Date {
  const t = [f.lastClickAt, f.lastResponseAt, f.consentAt, f.createdAt]
    .map(ms)
    .filter((x): x is number => x !== null);
  return new Date(t.length > 0 ? Math.max(...t) : 0);
}

export function filtersMatch(f: SubscriptionFacts, flt: AutomationFilters): boolean {
  const optins = flt.optin_ids ?? [];
  const langs = (flt.languages ?? []).map((l) => l.toLowerCase());
  const ints = flt.interest_ids ?? [];
  // Comme `lower(btrim(x))` dans `automation_due` (0095).
  const labels = (flt.labels ?? []).map((l) => l.trim().toLowerCase());
  if (optins.length > 0 && (f.optinId === null || !optins.includes(f.optinId))) return false;
  if (langs.length > 0 && !langs.includes((f.language ?? "").toLowerCase())) return false;
  if (ints.length > 0 && !f.interestIds.some((i) => ints.includes(i))) return false;
  if (labels.length > 0 && !f.labels.some((l) => labels.includes(l))) return false;
  return true;
}

function guard(id: string, why: string, check: Guard["check"]): Guard {
  return { id, why, check };
}

/* ------------------------------------------------------------------------------------------------
 * Gardes partagées
 * ---------------------------------------------------------------------------------------------- */

const G = {
  active: guard("active", "Only an active (confirmed) subscription may receive it.", (f) => f.status === "active"),
  pending: guard(
    "pending",
    "A reminder only goes to a subscription that is still waiting for its confirmation.",
    (f) => f.status === "pending",
  ),
  notSuppressed: guard(
    "not_suppressed",
    "An address on the do-not-send list (bounce, complaint, erasure, opt-out) never receives it.",
    (f) => !f.suppressed,
  ),
  notDemo: guard("not_demo", "Demo subscribers never receive a real e-mail.", (f) => !f.isDemo),
  notSunset: guard("not_sunset", "A sunsetted subscription is no longer written to.", (f) => f.sunsetAt === null),
  purposeGranted: guard(
    "purpose_granted",
    "Marketing only goes out under a purpose the subscriber granted (same rule as the send gate).",
    (f, c) => c.purpose !== null && purposeAllowed(c.purpose, f.grantedPurposes, legalBasisForRegime(f.regime)),
  ),
  filtersMatch: guard("filters_match", "The author's filters (opt-in, language, interests, labels) must match.", (f, c) =>
    filtersMatch(f, c.filters),
  ),
  delayReached: guard(
    "delay_reached",
    "The step's delay after the trigger has elapsed.",
    (_f, c, a) => a.at.getTime() + delayMs(c) <= c.now.getTime(),
  ),
  afterCursor: guard(
    "after_cursor",
    "Only events recorded after the automation first ran (a simulation counts) are used: nothing is sent retroactively.",
    (_f, c, a) => c.eventCursor !== null && a.eventId !== undefined && a.eventId > c.eventCursor,
  ),
  withinHorizon: guard(
    "within_horizon",
    `An event older than ${EVENT_HORIZON_DAYS} days no longer triggers anything.`,
    (_f, c, a) => a.at.getTime() > c.now.getTime() - EVENT_HORIZON_MS,
  ),
  notAlreadySent: guard(
    "not_already_sent",
    "Never the same step twice for the same period (a simulated pass counts: going live never replays it).",
    (f, c, a) =>
      !f.sends.some((s) => s.automationId === c.automationId && s.step === c.step && s.periodKey === a.periodKey),
  ),
  previousStepDone: guard(
    "previous_step_done",
    `Step N waits for step N-1 of the same period, in the same mode, at least ${MIN_STEP_GAP_HOURS} h earlier.`,
    (f, c, a) =>
      c.step === 1 ||
      f.sends.some(
        (s) =>
          s.automationId === c.automationId &&
          s.step === c.step - 1 &&
          s.periodKey === a.periodKey &&
          s.simulated === c.simulated &&
          Date.parse(s.at) <= c.now.getTime() - stepGapMs(c),
      ),
  ),
  trackingConsented: guard(
    "tracking_consented",
    "Without tracking consent nobody can be measured as inactive: excluded unless the author opts in.",
    (f, c) => f.trackingConsent || setting(c, null, "include_untracked", false),
  ),
};

const SENDABLE: readonly Guard[] = [G.active, G.notSuppressed, G.notDemo, G.notSunset];
const MARKETING: readonly Guard[] = [...SENDABLE, G.purposeGranted, G.filtersMatch];
const CLOSING: readonly Guard[] = [G.notAlreadySent, G.previousStepDone];

/* ------------------------------------------------------------------------------------------------
 * Les déclencheurs
 * ---------------------------------------------------------------------------------------------- */

const COMMON_VARS: readonly VariableName[] = [
  "first_name",
  "email",
  "property",
  "language",
  "preferences_link",
  "unsubscribe_link",
  "optin_id",
  "optin_source",
  "signup_date",
];

const TX_REMINDER_VARS: readonly VariableName[] = [
  "first_name",
  "email",
  "property",
  "language",
  "confirmation_link",
  "token_expiry",
  "optin_source",
  "signup_date",
];

function eventAnchor(e: ConsentEventFact | null, periodKey?: string): Anchor | null {
  if (!e) return null;
  const at = ms(e.at);
  if (at === null) return null;
  return { at: new Date(at), periodKey: periodKey ?? String(e.id), eventId: e.id };
}

const confirmationReminder: TriggerSpec = {
  id: "confirmation_reminder",
  sheetRow: 2,
  label: "Confirmation reminder",
  description:
    "Reminds a pending signup to confirm: +24 h reuses the link still valid, +72 h issues a new one (the first expired at 48 h). Never after 7 days.",
  policy: "transactional",
  kind: "automation_tx",
  source: "status",
  engine: true,
  liveBlockedReason: null,
  defaultPurpose: null,
  steps: { min: 1, max: 2, minDelayHours: 1, maxDelayHours: EVENT_HORIZON_DAYS * 24 - 1, defaultDelaysHours: [24, 72], requiresTemplate: true },
  settings: {},
  requiredFilter: null,
  variables: TX_REMINDER_VARS,
  order: "oldest",
  // L'ancre est la DERNIÈRE demande d'inscription : une réinscription relance une période neuve.
  anchor: (f) => eventAnchor(lastEvent(f, (e) => e.type === "optin_request")),
  guards: [
    G.pending,
    G.notSuppressed,
    G.notDemo,
    G.filtersMatch,
    guard(
      "confirmation_sent",
      "The original confirmation e-mail actually left: never remind someone of a message they never got.",
      (f) => f.confirmationSent,
    ),
    guard("not_confirmed", "The latest confirmation link is still unconfirmed.", (f) => !f.tokenConfirmed),
    guard(
      "within_7_days",
      "Never more than 7 days after the signup request.",
      (_f, c, a) => a.at.getTime() > c.now.getTime() - 7 * DAY_MS,
    ),
    G.delayReached,
    ...CLOSING,
  ],
};

const PREF_METHOD = "preference_center";

const preferencesUpdated: TriggerSpec = {
  id: "preferences_updated",
  sheetRow: 4,
  label: "Preferences updated",
  description:
    "Confirms a change made in the preference center, once the changes have settled (several clicks = one e-mail).",
  policy: "marketing",
  kind: "automation",
  source: "event",
  engine: true,
  liveBlockedReason: null,
  defaultPurpose: "content",
  steps: { min: 1, max: 1, minDelayHours: 0, maxDelayHours: 72, defaultDelaysHours: [1], requiresTemplate: true },
  settings: {},
  requiredFilter: null,
  variables: [...COMMON_VARS, "updated_fields"],
  order: "oldest",
  anchor: (f, c) => {
    const estPref = (e: ConsentEventFact) =>
      e.method === PREF_METHOD && (e.type === "granted" || e.type === "withdrawn");
    const a = eventAnchor(lastEvent(f, estPref));
    if (!a) return null;
    // ⚠️ `updated_fields` ne raconte que ce qui n'a pas déjà été confirmé par un envoi précédent.
    const deja = f.sends
      .filter((s) => s.automationId === c.automationId && s.step === 1)
      .map((s) => Number(s.periodKey))
      .filter(Number.isFinite);
    const plancher = Math.max(c.eventCursor ?? 0, ...deja);
    a.info = {
      updated_fields: f.events
        .filter((e) => estPref(e) && e.id > plancher)
        .sort((x, y) => x.id - y.id)
        .map((e) => ({ field: e.purpose ?? "tracking", value: e.type === "granted" })),
    };
    return a;
  },
  // Une seule étape : `previous_step_done` n'aurait rien à garder.
  guards: [...MARKETING, G.afterCursor, G.withinHorizon, G.delayReached, G.notAlreadySent],
};

const welcomeBack: TriggerSpec = {
  id: "welcome_back",
  sheetRow: 6,
  label: "Welcome back",
  description:
    "Greets a returning subscriber AFTER the new confirmation: never an e-mail to someone still unsubscribed.",
  policy: "marketing",
  kind: "automation",
  source: "event",
  engine: true,
  liveBlockedReason: null,
  defaultPurpose: "content",
  steps: { min: 1, max: 3, minDelayHours: 0, maxDelayHours: EVENT_HORIZON_DAYS * 24 - 1, defaultDelaysHours: [1], requiresTemplate: true },
  settings: {},
  requiredFilter: null,
  variables: COMMON_VARS,
  order: "oldest",
  anchor: (f) =>
    eventAnchor(
      lastEvent(f, (e) => e.type === "optin_confirm" || (e.type === "resubscribe" && e.method === PREF_METHOD)),
    ),
  guards: [
    ...MARKETING,
    guard(
      "returning",
      "Only a real return: a new confirmation after an unsubscribe, an erasure or the newsletter switched off in the preference center, or a resubscribe in the preference center.",
      (f, _c, a) => {
        const ev = f.events.find((e) => e.id === a.eventId);
        if (!ev) return false;
        if (ev.type === "resubscribe") return true;
        // Le `withdrawn` de `content` est ce qu'écrit l'interrupteur « Newsletter » du centre de préférences
        // (il ne trace pas `unsubscribe`) : même règle que `subscription_note_return` (0087) et 0090.
        return f.events.some(
          (e) =>
            e.id < ev.id &&
            (e.type === "unsubscribe" || e.type === "deletion_request" || (e.type === "withdrawn" && e.purpose === "content")),
        );
      },
    ),
    G.afterCursor,
    G.withinHorizon,
    G.delayReached,
    ...CLOSING,
  ],
};

const reengagement: TriggerSpec = {
  id: "reengagement",
  sheetRow: 7,
  label: "Re-engagement",
  description:
    "Writes to a subscriber whose last engagement (tracked click, preference-center visit, confirmation) is older than the step delay. Subscribers who refused tracking are excluded by default.",
  policy: "marketing",
  kind: "automation",
  source: "date",
  engine: true,
  liveBlockedReason: null,
  defaultPurpose: "content",
  steps: { min: 1, max: 3, minDelayHours: 30 * 24, maxDelayHours: 730 * 24, defaultDelaysHours: [60 * 24, 120 * 24], requiresTemplate: true },
  settings: {
    include_untracked: { type: "boolean", default: false, label: "Include subscribers who refused tracking" },
  },
  requiredFilter: null,
  variables: [...COMMON_VARS, "days_inactive"],
  // Les dormants les PLUS RÉCENTS d'abord (même raisonnement que 0058) : ceux qui reviennent le plus.
  order: "newest",
  anchor: (f, c) => {
    const ref = engagementRef(f);
    return {
      at: ref,
      periodKey: utcDay(ref),
      info: { days_inactive: Math.floor((c.now.getTime() - ref.getTime()) / DAY_MS) },
    };
  },
  guards: [...MARKETING, G.trackingConsented, G.delayReached, ...CLOSING],
};

const sunset: TriggerSpec = {
  id: "sunset",
  sheetRow: 8,
  label: "Sunset (silent)",
  description:
    "Stops writing to a subscriber inactive for the delay, after a re-engagement went unanswered: sets sunset_at, sends nothing, keeps the consent intact.",
  policy: "silent",
  kind: null,
  source: "date",
  engine: true,
  liveBlockedReason: null,
  defaultPurpose: null,
  steps: { min: 1, max: 1, minDelayHours: 90 * 24, maxDelayHours: 1095 * 24, defaultDelaysHours: [180 * 24], requiresTemplate: false },
  settings: {
    include_untracked: { type: "boolean", default: false, label: "Include subscribers who refused tracking" },
    require_reengagement: { type: "boolean", default: true, label: "Only after an unanswered re-engagement" },
    grace_days: { type: "integer", default: 14, min: 1, max: 90, label: "Days to answer the re-engagement" },
  },
  requiredFilter: null,
  variables: [],
  order: "oldest",
  anchor: (f) => {
    const ref = engagementRef(f);
    return { at: ref, periodKey: utcDay(ref) };
  },
  guards: [
    ...SENDABLE,
    G.filtersMatch,
    G.trackingConsented,
    G.delayReached,
    guard(
      "reengaged_without_answer",
      "A re-engagement was sent after the last engagement and stayed unanswered for the grace period.",
      (f, c, a) => {
        if (!setting(c, sunset, "require_reengagement", true)) return true;
        const grace = setting(c, sunset, "grace_days", 14) * DAY_MS;
        return f.sends.some(
          (s) =>
            s.trigger === "reengagement" &&
            s.simulated === c.simulated &&
            Date.parse(s.at) > a.at.getTime() &&
            Date.parse(s.at) <= c.now.getTime() - grace,
        );
      },
    ),
    G.notAlreadySent,
  ],
};

const anniversary: TriggerSpec = {
  id: "anniversary",
  sheetRow: 9,
  label: "Signup anniversary",
  description: "Once a year on the signup date (catch-up of a few days if a pass was missed). The period is the year.",
  policy: "marketing",
  kind: "automation",
  source: "date",
  engine: true,
  liveBlockedReason: null,
  defaultPurpose: "content",
  steps: { min: 1, max: 1, minDelayHours: 0, maxDelayHours: 72, defaultDelaysHours: [0], requiresTemplate: true },
  settings: {
    catchup_days: { type: "integer", default: 3, min: 0, max: 14, label: "Catch-up days after the date" },
  },
  requiredFilter: null,
  variables: COMMON_VARS,
  order: "oldest",
  anchor: (f, c) => {
    const t0 = ms(f.createdAt);
    if (t0 === null) return null;
    const d0 = new Date(t0);
    const annee = c.now.getUTCFullYear();
    const cetteAnnee = anniversaryOf(d0, annee);
    // Le dernier anniversaire PASSÉ (ou du jour) : celui de cette année s'il est atteint, sinon celui
    // de l'an dernier — sans quoi le 31/12 serait perdu par une passe manquée qui retombe le 1er janvier.
    const d = cetteAnnee.getTime() <= c.now.getTime() ? cetteAnnee : anniversaryOf(d0, annee - 1);
    return { at: d, periodKey: String(d.getUTCFullYear()) };
  },
  guards: [
    ...MARKETING,
    guard("one_year_old", "At least one full year since the signup.", (f, _c, a) => {
      const t0 = ms(f.createdAt);
      return t0 !== null && a.at.getTime() > Date.UTC(new Date(t0).getUTCFullYear(), new Date(t0).getUTCMonth(), new Date(t0).getUTCDate());
    }),
    G.delayReached,
    guard(
      "within_catchup",
      "A missed anniversary is only caught up for a few days, never weeks later.",
      (_f, c, a) =>
        c.now.getTime() < a.at.getTime() + delayMs(c) + (setting(c, anniversary, "catchup_days", 3) + 1) * DAY_MS,
    ),
    // Une seule étape par an : la période (l'année) suffit à l'unicité.
    G.notAlreadySent,
  ],
};

const consentRenewal: TriggerSpec = {
  id: "consent_renewal",
  sheetRow: 11,
  label: "Consent renewal",
  description:
    "Asks once, strictly transactionally, to renew a consent older than the threshold (24 months by default). Disabled for live until a signed renewal route exists.",
  policy: "transactional",
  kind: "automation_tx",
  source: "date",
  engine: true,
  liveBlockedReason: "No signed renewal route (renew_link) exists yet: the e-mail would ask for a gesture nobody can make.",
  defaultPurpose: null,
  steps: { min: 1, max: 1, minDelayHours: 0, maxDelayHours: 720, defaultDelaysHours: [0], requiresTemplate: true },
  settings: {
    months: { type: "integer", default: 24, min: 6, max: 60, label: "Consent age threshold (months)" },
  },
  requiredFilter: null,
  variables: ["first_name", "email", "property", "language", "signup_date", "renew_link"],
  order: "oldest",
  anchor: (f, c) => {
    const t = ms(f.consentAt);
    if (t === null) return null;
    const consent = new Date(t);
    return { at: addMonthsUtc(consent, setting(c, consentRenewal, "months", 24)), periodKey: utcDay(consent) };
  },
  guards: [...SENDABLE, G.filtersMatch, G.delayReached, G.notAlreadySent],
};

const softBounceRule: TriggerSpec = {
  id: "soft_bounce_rule",
  sheetRow: 13,
  label: "Soft bounce rule",
  description:
    "Displays the soft-bounce threshold. The counting and the suppression are done by the Mailgun webhook (migration 0081), not by this engine.",
  policy: "system",
  kind: null,
  source: "none",
  engine: false,
  liveBlockedReason: "System rule: enforced by the webhook, nothing to switch on here.",
  defaultPurpose: null,
  steps: { min: 0, max: 0, minDelayHours: 0, maxDelayHours: 0, defaultDelaysHours: [], requiresTemplate: false },
  settings: {
    threshold: { type: "integer", default: 4, min: 3, max: 5, readOnly: true, label: "Soft bounces before suppression" },
  },
  requiredFilter: null,
  variables: [],
  order: "oldest",
  anchor: () => null,
  guards: [],
};

const optinPromo: TriggerSpec = {
  id: "optin_promo",
  sheetRow: 15,
  label: "Opt-in promotion",
  description:
    "Sends up to 3 e-mails to people who signed up through one of the chosen opt-ins, or through a creative carrying one of the chosen automation labels — only AFTER the confirmation, once per subscriber.",
  policy: "marketing",
  kind: "automation",
  source: "event",
  engine: true,
  liveBlockedReason: null,
  defaultPurpose: "offers",
  steps: { min: 1, max: 3, minDelayHours: 0, maxDelayHours: EVENT_HORIZON_DAYS * 24 - 1, defaultDelaysHours: [1], requiresTemplate: true },
  settings: {},
  requiredFilter: ["optin_ids", "labels"],
  variables: [...COMMON_VARS, "promo_content"],
  order: "oldest",
  anchor: (f) => eventAnchor(lastEvent(f, (e) => e.type === "optin_confirm"), f.optinId ?? ""),
  guards: [
    ...MARKETING,
    guard(
      "optin_matches",
      "The subscription came in through one of the chosen opt-ins, or carries one of the chosen labels (at least one opt-in or label is required).",
      (f, c) => {
        const optins = c.filters.optin_ids ?? [];
        // 0095 : un label peut tenir lieu d'opt-in ; son appartenance est vérifiée par `filters_match`.
        if (optins.length === 0) return (c.filters.labels ?? []).length > 0;
        return f.optinId !== null && optins.includes(f.optinId);
      },
    ),
    G.afterCursor,
    G.withinHorizon,
    G.delayReached,
    ...CLOSING,
  ],
};

export const TRIGGERS: Readonly<Record<TriggerId, TriggerSpec>> = Object.freeze({
  confirmation_reminder: confirmationReminder,
  preferences_updated: preferencesUpdated,
  welcome_back: welcomeBack,
  reengagement,
  sunset,
  anniversary,
  consent_renewal: consentRenewal,
  soft_bounce_rule: softBounceRule,
  optin_promo: optinPromo,
});

export function isTriggerId(v: unknown): v is TriggerId {
  return typeof v === "string" && (TRIGGER_IDS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------------------------------------
 * Évaluation
 * ---------------------------------------------------------------------------------------------- */

export type Evaluation = { eligible: true; anchor: Anchor } | { eligible: false; reason: string };

/**
 * Évalue une souscription avec une liste de gardes EXPLICITE. Le banc s'en sert pour les mutants :
 * retirer une garde doit rendre éligible le témoin qu'elle seule refusait.
 */
export function evaluateWith(
  spec: TriggerSpec,
  guards: readonly Guard[],
  facts: SubscriptionFacts,
  ctx: EvalContext,
): Evaluation {
  if (!spec.engine) return { eligible: false, reason: "no_engine" };
  const anchor = spec.anchor(facts, ctx);
  if (!anchor) return { eligible: false, reason: "no_anchor" };
  for (const g of guards) if (!g.check(facts, ctx, anchor)) return { eligible: false, reason: g.id };
  return { eligible: true, anchor };
}

/** Qui est éligible à l'étape `ctx.step` de ce déclencheur — et sinon, quelle garde refuse. */
export function evaluate(trigger: TriggerId, facts: SubscriptionFacts, ctx: EvalContext): Evaluation {
  const spec = TRIGGERS[trigger];
  return evaluateWith(spec, spec.guards, facts, ctx);
}
