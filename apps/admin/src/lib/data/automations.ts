import { maskEmail, type AutomationRecord, type AutomationStatus } from "@nf/automations";
import { getDb } from "@/lib/supabase";
import { listTemplatesRead } from "@/lib/data/templates";
import { isAutomationStatus } from "@/lib/automations";

/**
 * Lectures des automations sur mesure (tables `automation` et `automation_send`, migration 0082).
 *
 * ⛔ CHAQUE LECTURE DIT SI ELLE A ABOUTI. Trois issues distinctes, jamais confondues :
 *  - `ok`            : la base a répondu ;
 *  - `not-installed` : la table ou la fonction n'existe pas (0082 non appliquée — `PGRST205`,
 *                      `42P01`, `PGRST202`, `42883`) — l'écran le DIT, sans aucun zéro ;
 *  - `error`         : toute autre panne, affichée telle quelle.
 * Un compte non lu n'est pas zéro : il est `null`, et l'écran écrit qu'il ne sait pas.
 *
 * ⛔ AUCUNE ADRESSE ENTIÈRE NE SORT D'ICI. L'aperçu d'audience les reçoit déjà masquées de la base
 * (`automation_due`, colonne `sample`) ; les journaux les masquent ICI, dans la fonction qui les lit,
 * avec la même règle (`maskEmail`). Le composant n'a jamais rien à cacher.
 */

type Db = NonNullable<ReturnType<typeof getDb>>;

export type Lecture<T> =
  | { state: "ok"; value: T }
  | { state: "not-installed"; detail: string }
  | { state: "error"; message: string };

export const NOT_INSTALLED = "Custom automations are not installed on this database yet";

/** Codes d'un objet absent : table (`PGRST205`, `42P01`), fonction (`PGRST202`, `42883`). Même liste que le worker. */
const ABSENT = new Set(["PGRST205", "42P01", "PGRST202", "42883"]);

export function estAbsente(error: { code?: string | null } | null | undefined): boolean {
  return !!error?.code && ABSENT.has(error.code);
}

function echec<T>(error: { code?: string | null; message?: string | null }): Lecture<T> {
  if (estAbsente(error)) return { state: "not-installed", detail: `${error.code} ${error.message ?? ""}`.trim() };
  return { state: "error", message: error.message ?? "unknown error" };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AUTOMATION_COLUMNS =
  "id, asset_id, name, trigger, filters, settings, steps, status, purpose, daily_cap, window_start_hour, " +
  "window_end_hour, timezone, event_cursor, last_run_at, status_changed_at, armed_by, armed_at, created_by, " +
  "updated_by, created_at, updated_at";

export interface AutomationRow {
  id: string;
  assetId: string;
  name: string;
  trigger: string;
  filters: unknown;
  settings: unknown;
  steps: unknown;
  status: AutomationStatus;
  purpose: string | null;
  dailyCap: number;
  windowStartHour: number;
  windowEndHour: number;
  timezone: string;
  eventCursor: number | null;
  lastRunAt: string | null;
  statusChangedAt: string | null;
  armedBy: string | null;
  armedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function mapAutomation(raw: unknown): AutomationRow {
  const r = raw as Record<string, unknown>;
  const cur = r.event_cursor;
  return {
    id: String(r.id ?? ""),
    assetId: String(r.asset_id ?? ""),
    name: String(r.name ?? ""),
    trigger: String(r.trigger ?? ""),
    filters: r.filters ?? {},
    settings: r.settings ?? {},
    steps: r.steps ?? [],
    // Un statut illisible est traité comme un brouillon : l'état qui n'écrit RIEN.
    status: isAutomationStatus(r.status) ? r.status : "draft",
    purpose: str(r.purpose),
    dailyCap: Number(r.daily_cap ?? 0),
    windowStartHour: Number(r.window_start_hour ?? 0),
    windowEndHour: Number(r.window_end_hour ?? 0),
    timezone: String(r.timezone ?? ""),
    eventCursor: cur === null || cur === undefined ? null : Number(cur),
    lastRunAt: str(r.last_run_at),
    statusChangedAt: str(r.status_changed_at),
    armedBy: str(r.armed_by),
    armedAt: str(r.armed_at),
    createdBy: str(r.created_by),
    updatedBy: str(r.updated_by),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

/** La ligne telle que `validateAutomation` la lit — avec, au besoin, le statut VISÉ. */
export function toRecord(a: AutomationRow, status: AutomationStatus = a.status): AutomationRecord {
  return {
    id: a.id,
    asset_id: a.assetId,
    name: a.name,
    trigger: a.trigger,
    filters: a.filters,
    settings: a.settings,
    steps: a.steps,
    status,
    purpose: a.purpose,
    daily_cap: a.dailyCap,
    window_start_hour: a.windowStartHour,
    window_end_hour: a.windowEndHour,
    timezone: a.timezone,
    event_cursor: a.eventCursor,
  };
}

/** Les étapes lisibles d'une ligne, sans jamais lever (jsonb écrit par un autre chemin). */
export function stepsOf(a: Pick<AutomationRow, "steps">): { delayHours: number | null; templateVersionId: string | null }[] {
  if (!Array.isArray(a.steps)) return [];
  return a.steps.map((s) => {
    const o = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    return {
      delayHours: Number.isInteger(o.delay_hours) ? (o.delay_hours as number) : null,
      templateVersionId: typeof o.template_version_id === "string" ? o.template_version_id : null,
    };
  });
}

/* ------------------------------------------------------------------------------------------------
 * Lire
 * ---------------------------------------------------------------------------------------------- */

/** La table est-elle là ? (compte d'en-tête, rien ne voyage) — avant d'offrir un formulaire de création. */
export async function automationsInstalled(db: Db, assetId: string): Promise<Lecture<true>> {
  const { error } = await db.from("automation").select("id", { count: "exact", head: true }).eq("asset_id", assetId);
  if (error) return echec(error);
  return { state: "ok", value: true };
}

/** Une automation de CETTE marque, ou `null` (inexistante OU d'une autre marque : même réponse). */
export async function findAutomation(db: Db, id: string, assetId: string): Promise<Lecture<AutomationRow | null>> {
  if (!UUID_RE.test(id)) return { state: "ok", value: null };
  const { data, error } = await db
    .from("automation")
    .select(AUTOMATION_COLUMNS)
    .eq("id", id)
    .eq("asset_id", assetId)
    .maybeSingle();
  if (error) return echec(error);
  return { state: "ok", value: data ? mapAutomation(data) : null };
}

/**
 * Nombre de traces d'une automation depuis `since`, dans UN mode (réel ou simulé). `null` = non lu.
 * ⚠️ Compte d'en-tête (`head: true`) : aucune ligne ne voyage, aucune adresse non plus.
 */
export async function countSends(
  db: Db,
  automationId: string,
  assetId: string,
  simulated: boolean,
  sinceIso: string,
): Promise<number | null> {
  const { count, error } = await db
    .from("automation_send")
    .select("id", { count: "exact", head: true })
    .eq("automation_id", automationId)
    .eq("asset_id", assetId)
    .eq("simulated", simulated)
    .gte("created_at", sinceIso);
  if (error || typeof count !== "number") return null;
  return count;
}

/**
 * TOUTES les lignes `automation_send` d'une automation, simulées ET réelles, depuis toujours — `null` si
 * non lu. Zéro = elle n'a jamais sélectionné personne : son déclencheur peut encore changer (feature 3).
 */
export async function countAllSends(db: Db, automationId: string, assetId: string): Promise<number | null> {
  const { count, error } = await db
    .from("automation_send")
    .select("id", { count: "exact", head: true })
    .eq("automation_id", automationId)
    .eq("asset_id", assetId);
  if (error || typeof count !== "number") return null;
  return count;
}

export interface AutomationListItem extends AutomationRow {
  /** Envois RÉELS sur 7 jours (`automation_send.simulated = false`) — `null` si non lu. */
  sent7d: number | null;
  /** Envois SIMULÉS sur 7 jours — `null` si non lu. */
  simulated7d: number | null;
}

export const SEPT_JOURS_MS = 7 * 24 * 3_600_000;

/** Les automations sur mesure d'une marque, avec leurs deux compteurs sur 7 jours. */
export async function listAutomations(db: Db, assetId: string, now: Date): Promise<Lecture<AutomationListItem[]>> {
  const { data, error } = await db
    .from("automation")
    .select(AUTOMATION_COLUMNS)
    .eq("asset_id", assetId)
    .order("created_at", { ascending: false });
  if (error) return echec(error);
  const rows = ((data as unknown[]) ?? []).map(mapAutomation);
  const since = new Date(now.getTime() - SEPT_JOURS_MS).toISOString();
  const items = await Promise.all(
    rows.map(async (a) => {
      const [sent7d, simulated7d] = await Promise.all([
        countSends(db, a.id, assetId, false, since),
        countSends(db, a.id, assetId, true, since),
      ]);
      return { ...a, sent7d, simulated7d };
    }),
  );
  return { state: "ok", value: items };
}

export interface SendLogRow {
  id: string;
  step: number;
  periodKey: string;
  simulated: boolean;
  reason: string;
  createdAt: string;
  /** `abc…@domaine` — jamais l'adresse entière. `null` si la souscription n'est plus lisible. */
  who: string | null;
  /** Statut de la ligne de file (envois réels) : `queued`, `sent`, `failed`, `skipped`… */
  outboxStatus: string | null;
  sentAt: string | null;
}

/**
 * Le journal d'une automation, dans UN mode : `simulated = true` = « qui AURAIT reçu quoi » ;
 * `false` = l'historique des envois réels, avec l'état de leur ligne de file.
 */
export async function readSendLog(
  db: Db,
  automationId: string,
  assetId: string,
  simulated: boolean,
  limit = 50,
): Promise<Lecture<SendLogRow[]>> {
  const { data, error } = await db
    .from("automation_send")
    .select(
      "id, step, period_key, simulated, reason, created_at, " +
        "subscription:subscription_id(subscriber:subscriber_id(email)), outbox:outbox_id(status, sent_at)",
    )
    .eq("automation_id", automationId)
    .eq("asset_id", assetId)
    .eq("simulated", simulated)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return echec(error);
  return {
    state: "ok",
    value: ((data as unknown[]) ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      const sub = r.subscription as { subscriber?: { email?: unknown } | null } | null;
      const email = typeof sub?.subscriber?.email === "string" ? sub.subscriber.email : null;
      const ob = r.outbox as { status?: unknown; sent_at?: unknown } | null;
      return {
        id: String(r.id ?? ""),
        step: Number(r.step ?? 0),
        periodKey: String(r.period_key ?? ""),
        simulated: r.simulated === true,
        reason: String(r.reason ?? ""),
        createdAt: String(r.created_at ?? ""),
        // ⛔ Masquée ICI : l'adresse entière ne quitte pas cette fonction.
        who: email ? maskEmail(email) : null,
        outboxStatus: typeof ob?.status === "string" ? ob.status : null,
        sentAt: typeof ob?.sent_at === "string" ? ob.sent_at : null,
      };
    }),
  };
}

export interface ProbeStep {
  step: number;
  /** Candidats après TOUTES les gardes, avant plafond — `null` si la sonde n'a pas abouti. */
  eligible: number | null;
  /** Ce que le plafond du jour laisserait partir. */
  allowed: number | null;
  /** 5 adresses au plus, masquées par la base (et re-masquées ici, sans effet sur une adresse masquée). */
  sample: string[];
  /** `probe` quand la sonde a compté ; sinon la raison nommée par 0082 (`busy`, `bad_filters`…). */
  reason: string | null;
}

/**
 * L'aperçu d'audience : `automation_due(p_probe := true)` pour chaque étape. ⛔ La sonde n'écrit
 * RIEN (ni trace, ni curseur, ni file) et accepte une automation `draft` — c'est la fonction du
 * moteur elle-même, donc les mêmes gardes que ce qui partira.
 * ⚠️ Sans l'allowlist du worker (réglée sur le serveur, jamais lue ici) : l'aperçu montre la
 * population réelle ; en `live`, l'allowlist peut encore la restreindre.
 */
export async function probeAudience(db: Db, automationId: string, stepCount: number): Promise<Lecture<ProbeStep[]>> {
  const out: ProbeStep[] = [];
  for (let step = 1; step <= Math.max(1, Math.min(stepCount, 5)); step++) {
    const { data, error } = await db.rpc("automation_due", {
      p_automation_id: automationId,
      p_step: step,
      p_batch: 100,
      p_allowlist: null,
      p_live_allowed: false,
      p_confirm_base_url: null,
      p_probe: true,
    });
    if (error) return echec(error);
    const l = (((data as unknown[]) ?? [])[0] ?? {}) as Record<string, unknown>;
    const reason = typeof l.reason === "string" ? l.reason : null;
    const compte = reason === "probe";
    out.push({
      step,
      eligible: compte ? Number(l.eligible ?? 0) : null,
      allowed: compte ? Number(l.allowed ?? 0) : null,
      sample: compte && Array.isArray(l.sample) ? l.sample.map((e) => maskEmail(String(e))) : [],
      reason,
    });
  }
  return { state: "ok", value: out };
}

/* ------------------------------------------------------------------------------------------------
 * Ce que le formulaire propose
 * ---------------------------------------------------------------------------------------------- */

export interface StepTemplateOption {
  versionId: string;
  templateId: string;
  templateName: string;
  version: number;
  subject: string | null;
}

/**
 * Les modèles utilisables par une étape : pour chaque modèle de la marque que CETTE personne peut
 * ouvrir (`listTemplatesRead`, octrois compris), sa DERNIÈRE version publiée. ⛔ L'étape fige une
 * VERSION : ce qu'on simule est ce qui part, pas « la dernière version » du jour de l'envoi.
 */
export async function listStepTemplates(assetId: string | null): Promise<{ known: boolean; value: StepTemplateOption[] }> {
  const db = getDb();
  if (!db || !assetId) return { known: false, value: [] };
  const lus = await listTemplatesRead(assetId);
  if (!lus.known) return { known: false, value: [] };
  const publies = lus.value.filter((t) => t.publishedVersion !== null);
  if (publies.length === 0) return { known: true, value: [] };
  const noms = new Map(publies.map((t) => [t.id, t.name]));
  const { data, error } = await db
    .from("template_version")
    .select("id, template_id, version, subject")
    .in("template_id", [...noms.keys()])
    .eq("status", "published");
  if (error) return { known: false, value: [] };
  const derniere = new Map<string, StepTemplateOption>();
  for (const raw of (data as unknown[]) ?? []) {
    const r = raw as Record<string, unknown>;
    const templateId = String(r.template_id ?? "");
    const version = Number(r.version ?? 0);
    const cur = derniere.get(templateId);
    if (cur && cur.version >= version) continue;
    derniere.set(templateId, {
      versionId: String(r.id ?? ""),
      templateId,
      templateName: noms.get(templateId) ?? "",
      version,
      subject: str(r.subject),
    });
  }
  return { known: true, value: [...derniere.values()].sort((a, b) => a.templateName.localeCompare(b.templateName)) };
}

export interface VersionDescription {
  /** `null` quand la personne ne peut pas ouvrir le modèle : pas de lien vers son builder. */
  templateId: string | null;
  templateName: string | null;
  version: number;
  subject: string | null;
  published: boolean;
}

/**
 * Nom et numéro des versions citées par des étapes — seulement pour les modèles que la personne peut
 * ouvrir (même règle que la bibliothèque : le nom d'un modèle non octroyé n'est pas montré, son id non
 * plus — il ne servirait qu'à un lien vers un builder qui répondrait 404).
 */
export async function describeVersions(assetId: string, versionIds: string[]): Promise<Map<string, VersionDescription>> {
  const out = new Map<string, VersionDescription>();
  const db = getDb();
  const ids = versionIds.filter((v) => UUID_RE.test(v));
  if (!db || ids.length === 0) return out;
  const [{ data }, visibles] = await Promise.all([
    db.from("template_version").select("id, template_id, version, subject, status").in("id", ids),
    listTemplatesRead(assetId),
  ]);
  const noms = new Map(visibles.value.map((t) => [t.id, t.name]));
  for (const raw of (data as unknown[]) ?? []) {
    const r = raw as Record<string, unknown>;
    const templateId = String(r.template_id ?? "");
    const templateName = noms.get(templateId) ?? null;
    out.set(String(r.id ?? ""), {
      templateId: templateName === null ? null : templateId,
      templateName,
      version: Number(r.version ?? 0),
      subject: str(r.subject),
      published: r.status === "published",
    });
  }
  return out;
}

export interface FilterOptions {
  known: boolean;
  optins: { id: string; name: string; archived: boolean }[];
  interests: { id: number; label: string }[];
  /** Les labels d'automation enregistrés pour la marque (0095, `automation_label`). */
  labels: { slug: string; name: string }[];
}

/** Les opt-ins, les intérêts et les labels de la marque — les listes que les filtres du catalogue connaissent. */
export async function listFilterOptions(assetId: string | null): Promise<FilterOptions> {
  const db = getDb();
  if (!db || !assetId) return { known: false, optins: [], interests: [], labels: [] };
  const [optins, tags, labels] = await Promise.all([
    db.from("optin").select("id, name, slug, archived_at").eq("asset_id", assetId).order("name"),
    // ⛔ `kind`, jamais un LIKE sur le slug : même règle que `/api/segments/options`.
    db.from("tag").select("id, slug, label, kind").eq("asset_id", assetId).eq("kind", "interest").order("slug"),
    db.from("automation_label").select("slug, name").eq("asset_id", assetId).order("name"),
  ]);
  if (optins.error || tags.error) return { known: false, optins: [], interests: [], labels: [] };
  // ⚠️ Un registre illisible ne coûte que la liste des labels : opt-ins et intérêts restent proposés.
  if (labels.error) console.error(JSON.stringify({ event: "automation-labels-read-failed", message: labels.error.message }));
  return {
    known: true,
    labels: labels.error
      ? []
      : ((labels.data as unknown[]) ?? []).map((raw) => {
          const r = raw as Record<string, unknown>;
          return { slug: String(r.slug ?? ""), name: String(r.name || r.slug || "") };
        }),
    optins: ((optins.data as unknown[]) ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: String(r.id ?? ""), name: String(r.name || r.slug || "Untitled opt-in"), archived: !!r.archived_at };
    }),
    interests: ((tags.data as unknown[]) ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: Number(r.id), label: String(r.label || r.slug || r.id) };
    }),
  };
}

/**
 * Les fuseaux des éditions de TOUTES les marques — la liste proposée pour la fenêtre d'envoi (plan
 * AUTO-EDIT, étape 6). Seulement la colonne `timezone` : aucun nom ni id de marque ne voyage. Lecture
 * ratée ⇒ liste vide : le sélecteur garde UTC, la valeur courante et le champ libre.
 */
export async function listTimezonesInUse(): Promise<string[]> {
  const db = getDb();
  if (!db) return [];
  const { data, error } = await db.from("asset_edition").select("timezone");
  if (error) return [];
  const vus = new Set<string>();
  for (const raw of (data as unknown[]) ?? []) {
    const tz = str((raw as Record<string, unknown>).timezone);
    if (tz) vus.add(tz);
  }
  return [...vus];
}

/** Le fuseau de l'édition principale de la marque — le défaut de la fenêtre d'envoi. */
export async function brandTimezone(assetId: string | null): Promise<string | null> {
  const db = getDb();
  if (!db || !assetId) return null;
  const { data } = await db
    .from("asset_edition")
    .select("timezone, is_primary")
    .eq("asset_id", assetId)
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle();
  return str((data as Record<string, unknown> | null)?.timezone);
}
