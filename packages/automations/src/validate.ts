/**
 * Validation des réglages d'une automation — la même fonction pour l'admin (avant d'écrire) et pour
 * le worker (avant d'exécuter).
 *
 * ⛔ LE WORKER REVALIDE CE QUE L'ADMIN A DÉJÀ VALIDÉ, ET CE N'EST PAS UNE REDONDANCE. Une ligne
 * `automation` peut être écrite par un autre chemin que l'écran (SQL à la main, migration, version
 * antérieure de l'admin). Le moteur n'exécute que ce qui passe ICI ; le reste est écarté avec sa
 * raison, jamais « interprété au mieux ».
 *
 * ⚠️ `filters`, `settings` et `steps` sont en jsonb côté base : la contrainte SQL ne vérifie que leur
 * FORME (objet / tableau, taille). Leur CONTENU est vérifié ici, clé par clé — une clé inconnue est
 * refusée plutôt qu'ignorée, sinon une faute de frappe (`optin_id` au lieu de `optin_ids`) ferait
 * silencieusement tomber le filtre, et l'automation viserait toute la marque.
 */
import {
  AUTOMATION_STATUSES,
  LABEL_SLUG_RE,
  PURPOSES,
  TRIGGERS,
  isTriggerId,
  type AutomationFilters,
  type AutomationStatus,
  type Purpose,
  type StepSpec,
  type TriggerId,
  type TriggerSpec,
} from "./catalog";

/** Ce que la table `automation` porte (0082), tel que lu par PostgREST. */
export interface AutomationRecord {
  id?: string;
  asset_id: string;
  name: string;
  trigger: string;
  filters: unknown;
  settings: unknown;
  steps: unknown;
  status: string;
  purpose: string | null;
  daily_cap: number;
  window_start_hour: number;
  window_end_hour: number;
  timezone: string;
  event_cursor?: number | string | null;
}

export interface ValidAutomation {
  id?: string;
  assetId: string;
  name: string;
  trigger: TriggerId;
  spec: TriggerSpec;
  filters: AutomationFilters;
  settings: Record<string, unknown>;
  steps: StepSpec[];
  status: AutomationStatus;
  purpose: Purpose | null;
  dailyCap: number;
  windowStartHour: number;
  windowEndHour: number;
  timezone: string;
  eventCursor: number | null;
}

export type Validation = { ok: true; automation: ValidAutomation } | { ok: false; errors: string[] };

export const DAILY_CAP_MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** Un fuseau IANA que le moteur ET Postgres comprennent (`now() at time zone …`). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.trim() === "" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** L'heure locale (0-23) de `now` dans `tz`. */
export function localHour(now: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now);
  return Number.parseInt(h, 10) % 24;
}

/**
 * La passe tombe-t-elle dans la fenêtre d'envoi `[start, end[` (heures locales) ?
 * ⚠️ Fenêtre DANS la journée seulement (`start < end`, contrainte 0082) : une fenêtre qui
 * enjamberait minuit se règle en deux automations, pas en une exception ici.
 */
export function inSendWindow(now: Date, tz: string, startHour: number, endHour: number): boolean {
  const h = localHour(now, tz);
  return h >= startHour && h < endHour;
}

/**
 * Transitions d'état permises — la table de l'écran d'armement (vague 3, étape 13), et la seule.
 *
 * ⛔ `draft → live` N'EXISTE PAS : le premier état armé est TOUJOURS la simulation (elle calcule,
 * journalise, n'écrit rien dans `email_outbox`). `live` ne s'atteint que depuis `simulation` (armer)
 * ou depuis `paused` (reprendre) ; `paused` ne s'atteint que depuis `live`.
 *
 * ⛔ `simulation → paused → live` N'EXISTE PLUS (24/09/2026). Il laissait armer par « Resume » une
 * automation dont la simulation n'avait jamais tourné : la condition d'armement (« la simulation a
 * tourné ») ne se vérifie que sur `simulation → live`, et `paused` doit donc toujours venir de `live`.
 *
 * ⚠️ Tout statut revient à `draft`, `live` compris : revenir au brouillon ARRÊTE l'automation (un
 * brouillon n'écrit rien, ni file ni simulation), c'est le seul état où elle se modifie, et en
 * repartir oblige à resimuler avant de réarmer. Ce n'est donc pas « ajuster en marche ».
 */
const TRANSITIONS: Readonly<Record<AutomationStatus, readonly AutomationStatus[]>> = {
  draft: ["simulation"],
  simulation: ["draft", "live"],
  live: ["paused", "draft"],
  paused: ["live", "draft"],
};

export function canTransition(from: AutomationStatus, to: AutomationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

function validateFilters(raw: unknown, spec: TriggerSpec, errors: string[]): AutomationFilters {
  if (raw === null || raw === undefined) raw = {};
  if (!isObject(raw)) {
    errors.push("filters must be an object");
    return {};
  }
  const out: AutomationFilters = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "optin_ids") {
      if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === "string" && UUID.test(x))) {
        errors.push("filters.optin_ids must be a list of opt-in ids (at most 50)");
      } else out.optin_ids = v.map((x) => String(x).toLowerCase());
    } else if (k === "languages") {
      if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === "string" && LANG.test(x))) {
        errors.push("filters.languages must be a list of language codes (at most 20)");
      } else out.languages = v.map((x) => String(x).toLowerCase());
    } else if (k === "interest_ids") {
      if (!Array.isArray(v) || v.length > 50 || !v.every((x) => isInt(x) && x > 0)) {
        errors.push("filters.interest_ids must be a list of interest ids (at most 50)");
      } else out.interest_ids = v as number[];
    } else if (k === "labels") {
      // Des SLUGS (0095), pas des noms : c'est l'admin qui les propose depuis le registre.
      const lus = Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim().toLowerCase() : "")) : [];
      if (!Array.isArray(v) || v.length > 20 || !lus.every((x) => LABEL_SLUG_RE.test(x))) {
        errors.push("filters.labels must be a list of automation label slugs (at most 20)");
      } else out.labels = lus;
    } else {
      errors.push(`filters.${k} is not a known filter`);
    }
  }
  const exiges = spec.requiredFilter ?? [];
  if (exiges.length > 0 && exiges.every((cle) => (out[cle]?.length ?? 0) === 0)) {
    errors.push(`${exiges.map((cle) => `filters.${cle}`).join(" or ")} is required for ${spec.label}`);
  }
  return out;
}

function validateSettings(raw: unknown, spec: TriggerSpec, errors: string[]): Record<string, unknown> {
  if (raw === null || raw === undefined) raw = {};
  if (!isObject(raw)) {
    errors.push("settings must be an object");
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(spec.settings)) out[k] = def.default;
  for (const [k, v] of Object.entries(raw)) {
    const def = spec.settings[k];
    if (!def) {
      errors.push(`settings.${k} is not a setting of ${spec.label}`);
      continue;
    }
    if (def.readOnly) {
      // Affiché, jamais appliqué : accepter une autre valeur laisserait croire qu'elle agit.
      if (v !== def.default) errors.push(`settings.${k} is read-only (enforced elsewhere)`);
      continue;
    }
    if (def.type === "boolean") {
      if (typeof v !== "boolean") errors.push(`settings.${k} must be true or false`);
      else out[k] = v;
    } else if (!isInt(v) || (def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)) {
      errors.push(`settings.${k} must be an integer between ${def.min} and ${def.max}`);
    } else out[k] = v;
  }
  return out;
}

function validateSteps(raw: unknown, spec: TriggerSpec, errors: string[]): StepSpec[] {
  if (!Array.isArray(raw)) {
    errors.push("steps must be a list");
    return [];
  }
  const { min, max, minDelayHours, maxDelayHours, requiresTemplate } = spec.steps;
  if (raw.length < min || raw.length > max) {
    errors.push(
      min === max ? `${spec.label} takes exactly ${min} step(s)` : `${spec.label} takes ${min} to ${max} steps`,
    );
  }
  const out: StepSpec[] = [];
  let previous = -1;
  raw.forEach((s, i) => {
    const n = i + 1;
    if (!isObject(s)) {
      errors.push(`step ${n} must be an object`);
      return;
    }
    for (const k of Object.keys(s)) {
      if (k !== "delay_hours" && k !== "template_version_id") errors.push(`step ${n}: ${k} is not a step field`);
    }
    const d = s.delay_hours;
    if (!isInt(d) || d < minDelayHours || d > maxDelayHours) {
      errors.push(`step ${n}: delay must be between ${minDelayHours} and ${maxDelayHours} hours`);
    } else if (d <= previous) {
      // Les délais comptent tous depuis le déclencheur : une étape qui ne vient pas APRÈS la
      // précédente ne partirait jamais (elle attend la précédente) ou partirait dans le même souffle.
      errors.push(`step ${n}: delay must be longer than step ${n - 1}'s`);
    }
    if (isInt(d)) previous = d;
    const tv = s.template_version_id;
    if (requiresTemplate) {
      if (typeof tv !== "string" || !UUID.test(tv)) errors.push(`step ${n}: a published template version is required`);
    } else if (tv !== undefined && tv !== null) {
      // ⛔ Un déclencheur silencieux n'envoie rien : un modèle attaché ferait croire le contraire.
      errors.push(`step ${n}: ${spec.label} sends nothing, it takes no template`);
    }
    out.push({ delay_hours: isInt(d) ? d : 0, template_version_id: typeof tv === "string" ? tv.toLowerCase() : null });
  });
  return out;
}

/**
 * Valide une ligne `automation`. Les messages sont en anglais : ils remontent tels quels dans l'admin.
 */
export function validateAutomation(rec: AutomationRecord): Validation {
  const errors: string[] = [];
  if (!isTriggerId(rec.trigger)) {
    return { ok: false, errors: [`unknown trigger: ${String(rec.trigger)}`] };
  }
  const spec = TRIGGERS[rec.trigger];

  if (typeof rec.asset_id !== "string" || !UUID.test(rec.asset_id)) errors.push("a brand is required");
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (name.length < 1 || name.length > 120) errors.push("name must be 1 to 120 characters");

  if (!(AUTOMATION_STATUSES as readonly string[]).includes(rec.status)) errors.push(`unknown status: ${rec.status}`);
  const status = rec.status as AutomationStatus;

  // ⛔ LA FINALITÉ SUIT LA POLITIQUE, JAMAIS L'INVERSE. Un marketing sans finalité partirait sans
  // dire au titre de quel consentement on écrit ; un transactionnel AVEC finalité serait un
  // marketing qui s'ignore — la porte le traiterait en transactionnel et ne vérifierait rien.
  let purpose: Purpose | null = null;
  if (spec.policy === "marketing") {
    if (typeof rec.purpose !== "string" || !(PURPOSES as readonly string[]).includes(rec.purpose)) {
      errors.push("a marketing automation needs a purpose (content, offers, events or partners)");
    } else purpose = rec.purpose as Purpose;
  } else if (rec.purpose !== null && rec.purpose !== undefined) {
    errors.push(`${spec.label} is not marketing: it carries no purpose`);
  }

  if (!isInt(rec.daily_cap) || rec.daily_cap < 1 || rec.daily_cap > DAILY_CAP_MAX) {
    errors.push(`daily cap must be between 1 and ${DAILY_CAP_MAX}`);
  }
  if (
    !isInt(rec.window_start_hour) ||
    !isInt(rec.window_end_hour) ||
    rec.window_start_hour < 0 ||
    rec.window_end_hour > 24 ||
    rec.window_start_hour >= rec.window_end_hour
  ) {
    errors.push("send window must be start < end, within 0-24 h");
  }
  if (!isValidTimeZone(rec.timezone)) errors.push(`unknown time zone: ${String(rec.timezone)}`);

  const filters = validateFilters(rec.filters, spec, errors);
  const settings = validateSettings(rec.settings, spec, errors);
  const steps = validateSteps(rec.steps, spec, errors);

  // ⛔ ARMÉ = EXÉCUTABLE. Un déclencheur que le moteur n'exécute pas (règle système) ne s'arme pas,
  // et un déclencheur bloqué pour le réel (route manquante) ne passe pas `live`.
  if (!spec.engine && status !== "draft") errors.push(`${spec.label} is a system rule: it cannot be simulated or switched on`);
  if (status === "live" && spec.liveBlockedReason) errors.push(`${spec.label} cannot go live: ${spec.liveBlockedReason}`);

  const cur = rec.event_cursor;
  const eventCursor = cur === null || cur === undefined || cur === "" ? null : Number(cur);
  if (eventCursor !== null && (!Number.isSafeInteger(eventCursor) || eventCursor < 0)) errors.push("invalid event cursor");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    automation: {
      ...(rec.id ? { id: rec.id } : {}),
      assetId: rec.asset_id,
      name,
      trigger: rec.trigger,
      spec,
      filters,
      settings,
      steps,
      status,
      purpose,
      dailyCap: rec.daily_cap,
      windowStartHour: rec.window_start_hour,
      windowEndHour: rec.window_end_hour,
      timezone: rec.timezone,
      eventCursor,
    },
  };
}
