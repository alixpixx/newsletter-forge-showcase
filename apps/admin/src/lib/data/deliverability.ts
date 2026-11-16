/**
 * Délivrabilité RÉELLE d'une marque — lecture de `newsletter.deliverability_summary` (0069).
 *
 * ⛔ CE QUE CE MODULE NE FAIT JAMAIS : inventer. Pas de placement en boîte de réception, pas de
 * réputation, pas de SPF/DKIM « ✓ » — aucune de ces mesures n'existe dans le produit. Une lecture
 * ratée rend `known: false` avec sa raison, jamais des zéros : l'écran afficherait alors « tout va
 * bien » pendant une panne.
 *
 * Les taux sont calculés ici, pas en SQL : la règle d'arrondi et le seuil de plainte vivent à un
 * seul endroit, testé.
 */

/** Seuil de plainte du projet (règle du projet : kill-switch au-delà de 0,3 %). */
export const COMPLAINT_THRESHOLD = 0.003;
/**
 * En dessous de ce nombre de remises, UNE seule plainte dépasse déjà le seuil (1/333 ≈ 0,300 3 %).
 * Zéro plainte sur moins de remises ne prouve donc rien : on le dit au lieu d'afficher « sain ».
 */
export const MIN_DELIVERED_FOR_VERDICT = Math.ceil(1 / COMPLAINT_THRESHOLD);

export const DAY_WINDOWS = [7, 30, 90] as const;
export type DayWindow = (typeof DAY_WINDOWS)[number];

/** `?days=` → une fenêtre connue ; toute autre valeur retombe sur 30. */
export function parseDayWindow(raw: string | string[] | undefined): DayWindow {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return (DAY_WINDOWS as readonly number[]).includes(n) ? (n as DayWindow) : 30;
}

export interface DeliverabilityTotals {
  sent: number;
  delivered: number;
  bounced: number;
  softFailed: number;
  noOutcome: number;
  complained: number;
  unsubscribed: number;
  opened: number;
  clicked: number;
}

export interface DailyPoint {
  day: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
}

export interface SendGroup {
  campaignId: string | null;
  /** `campaign` pour une campagne, sinon le kind (`confirmation`, `welcome`, `test`…). */
  kind: string;
  name: string | null;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  lastSentAt: string | null;
}

export interface Deliverability {
  days: number;
  since: string;
  measuredAt: string;
  sendingSubdomain: string | null;
  totals: DeliverabilityTotals;
  daily: DailyPoint[];
  bySend: SendGroup[];
  queue: { pending: number; sending: number; oldestPending: string | null };
  notSent: { status: string; reason: string; count: number }[];
  suppressions: { reason: string; count: number }[];
  globalSuppressions: number;
  unlinkedEvents: number;
}

export type DeliverabilityRead = { known: true; value: Deliverability } | { known: false; reason: string };

type Obj = Record<string, unknown>;
const estObjet = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const nombre = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const texte = (v: unknown): string | null => (typeof v === "string" ? v : null);

class Illisible extends Error {}
function n(o: Obj, k: string): number {
  const v = nombre(o[k]);
  if (v === null) throw new Illisible(k);
  return v;
}
function liste(o: Obj, k: string): Obj[] {
  const v = o[k];
  if (!Array.isArray(v) || !v.every(estObjet)) throw new Illisible(k);
  return v;
}
function objet(o: Obj, k: string): Obj {
  const v = o[k];
  if (!estObjet(v)) throw new Illisible(k);
  return v;
}

/**
 * La réponse de la RPC, ou `null` si sa forme n'est pas celle attendue.
 *
 * ⚠️ UN CHAMP MANQUANT REND TOUT ILLISIBLE, il ne devient pas 0. Un `sent` absent lu comme zéro
 * afficherait « aucun envoi » pour une marque qui envoie.
 */
export function parseDeliverability(raw: unknown): Deliverability | null {
  if (!estObjet(raw)) return null;
  try {
    const t = objet(raw, "totals");
    const q = objet(raw, "queue");
    const since = texte(raw.since);
    const measuredAt = texte(raw.measured_at);
    if (!since || !measuredAt) return null;
    return {
      days: n(raw, "days"),
      since,
      measuredAt,
      sendingSubdomain: texte(raw.sending_subdomain),
      totals: {
        sent: n(t, "sent"),
        delivered: n(t, "delivered"),
        bounced: n(t, "bounced"),
        softFailed: n(t, "soft_failed"),
        noOutcome: n(t, "no_outcome"),
        complained: n(t, "complained"),
        unsubscribed: n(t, "unsubscribed"),
        opened: n(t, "opened"),
        clicked: n(t, "clicked"),
      },
      daily: liste(raw, "daily").map((d) => {
        const day = texte(d.day);
        if (!day) throw new Illisible("daily.day");
        return { day, sent: n(d, "sent"), delivered: n(d, "delivered"), bounced: n(d, "bounced"), complained: n(d, "complained") };
      }),
      bySend: liste(raw, "by_send").map((g) => ({
        campaignId: texte(g.campaign_id),
        kind: texte(g.kind) ?? "unknown",
        name: texte(g.name),
        sent: n(g, "sent"),
        delivered: n(g, "delivered"),
        bounced: n(g, "bounced"),
        complained: n(g, "complained"),
        unsubscribed: n(g, "unsubscribed"),
        lastSentAt: texte(g.last_sent_at),
      })),
      queue: { pending: n(q, "pending"), sending: n(q, "sending"), oldestPending: texte(q.oldest_pending) },
      notSent: liste(raw, "not_sent").map((r) => ({
        status: texte(r.status) ?? "unknown",
        reason: texte(r.reason) ?? "other",
        count: n(r, "count"),
      })),
      suppressions: liste(raw, "suppressions").map((s) => ({ reason: texte(s.reason) ?? "other", count: n(s, "count") })),
      globalSuppressions: n(raw, "global_suppressions"),
      unlinkedEvents: n(raw, "unlinked_events"),
    };
  } catch (e) {
    if (e instanceof Illisible) return null;
    throw e;
  }
}

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

export async function getDeliverability(db: Rpc | null, assetId: string | null, days: DayWindow): Promise<DeliverabilityRead> {
  if (!db) return { known: false, reason: "the database is not configured" };
  if (!assetId) return { known: false, reason: "no brand selected" };
  const { data, error } = await db.rpc("deliverability_summary", { p_asset_id: assetId, p_days: days });
  if (error) {
    const absente = /deliverability_summary|could not find the function|schema cache/i.test(error.message);
    return { known: false, reason: absente ? "migration 0069 has not been applied" : error.message };
  }
  const value = parseDeliverability(data);
  return value ? { known: true, value } : { known: false, reason: "the database answered in an unexpected shape" };
}

/** Part d'un total, `null` quand le dénominateur est nul (« — » à l'écran, jamais « 0 % »). */
export const part = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export type ComplaintVerdict = "no-data" | "above" | "thin" | "ok";

/**
 * Verdict de plainte, rapporté aux REMISES (la convention des fournisseurs), pas aux envois.
 * « above » l'emporte même sur un petit volume : une plainte réelle ne se relativise pas.
 */
export function complaintVerdict(t: Pick<DeliverabilityTotals, "delivered" | "complained">): ComplaintVerdict {
  if (t.delivered === 0) return "no-data";
  if (t.complained / t.delivered > COMPLAINT_THRESHOLD) return "above";
  if (t.delivered < MIN_DELIVERED_FOR_VERDICT) return "thin";
  return "ok";
}

/** `0.0123` → `1.2%` ; les très petits taux gardent deux décimales pour ne pas s'écraser à 0.0 %. */
export function pct(v: number | null): string {
  if (v === null) return "—";
  const p = v * 100;
  return `${p > 0 && p < 1 ? p.toFixed(2) : p.toFixed(1)}%`;
}

/** Codes de non-envoi du worker (`gate.ts`, `process.ts`, `render.ts`) en langage d'écran. */
const RAISONS: Record<string, string> = {
  stale_outbox: "Too old when the worker picked it up",
  not_allowlisted: "Recipient not on the sending allowlist",
  suppressed: "Address is on the suppression list",
  no_sending_domain: "Brand has no sending domain",
  missing_context: "Brand or subscription details missing",
  no_footer_context: "Legal footer details missing",
  footer_incomplete: "Legal footer incomplete",
  missing_action_url: "Confirmation link missing",
  missing_prefs_url: "Preferences link missing",
  missing_subject: "Subject missing",
  no_compiled_shell: "No published email to send",
  no_renderer: "No template for this kind of email",
  unknown_kind: "Unknown kind of email",
  doi_token_absent: "Confirmation link was never issued",
  doi_token_expire: "Confirmation link had expired",
  doi_token_deja_confirme: "Subscription was already confirmed",
  other: "Other provider or system error",
};

export const reasonLabel = (code: string): string => RAISONS[code] ?? code.replace(/_/g, " ");

const SUPPRESSIONS: Record<string, string> = {
  hard_bounce: "Hard bounce",
  spam_complaint: "Spam complaint",
  global_optout: "Opted out of every brand",
  erasure: "Erasure request",
  unsubscribe: "Unsubscribed",
  other: "Other",
};

export const suppressionLabel = (code: string): string => SUPPRESSIONS[code] ?? code.replace(/_/g, " ");
