import { getDb } from "@/lib/supabase";
import type { Group } from "@nf/segments/fields";

/**
 * Accès aux segments enregistrés de la marque courante.
 *
 * La RÈGLE est stockée telle quelle (`rule_json`) et recompilée à chaque lecture de compte : on ne
 * fige jamais une liste d'abonnés. Motif : un segment figé mentirait dès le lendemain, et surtout il
 * contournerait le re-contrôle du consentement — le ciblage est une commodité, le consentement est
 * une barrière (voir `sendable_subscription`).
 *
 * `cached_count` n'est qu'un AFFICHAGE : il date, il est daté à l'écran, et il n'autorise jamais
 * un envoi à lui seul.
 */

export interface SegmentRow {
  id: string;
  name: string;
  kind: "dynamic" | "static";
  rule: Group | null;
  cachedCount: number | null;
  cachedAt: string | null;
  usedByAutomation: boolean;
  updatedAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID_RE.test(v);

function toRow(raw: unknown): SegmentRow {
  const r = raw as Record<string, unknown>;
  const rule = r.rule_json as Group | undefined;
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    kind: (r.kind as SegmentRow["kind"]) ?? "dynamic",
    // Une règle vide (`{}`) est indiscernable d'une absence de règle : on la normalise en null
    // plutôt que de laisser l'appelant deviner.
    rule: rule && (rule as { type?: string }).type === "group" ? rule : null,
    cachedCount: typeof r.cached_count === "number" ? r.cached_count : null,
    cachedAt: r.cached_at ? String(r.cached_at) : null,
    usedByAutomation: Boolean(r.used_by_automation),
    updatedAt: String(r.updated_at ?? ""),
  };
}

/**
 * Segments de la marque. `assetId === null` (base injoignable) → liste vide : mieux vaut un écran
 * vide honnête que l'agrégat des 9 marques.
 */
export async function listSegments(assetId: string | null): Promise<SegmentRow[]> {
  return (await listSegmentsRead(assetId)).value;
}

/**
 * Même lecture, qui dit si elle a ABOUTI. ⛔ `[]` répond à deux questions opposées : « cette marque
 * n'a aucun segment » et « la base n'a pas répondu ». Un écran qui AFFICHE un compte (la page
 * d'accueil d'Automations) ne peut écrire « 0 saved segments » que sur une lecture réussie.
 */
export async function listSegmentsRead(
  assetId: string | null,
): Promise<{ known: boolean; value: SegmentRow[] }> {
  const db = getDb();
  if (!db || !assetId) return { known: false, value: [] };

  const { data, error } = await db
    .from("segment")
    .select("id, name, kind, rule_json, cached_count, cached_at, used_by_automation, updated_at")
    .eq("asset_id", assetId)
    .order("updated_at", { ascending: false });

  if (error || !data) return { known: false, value: [] };
  return { known: true, value: (data as unknown[]).map(toRow) };
}

/** Segment de la marque courante, ou `null` — inexistant ET appartenant à une autre marque. */
export async function findSegment(
  db: NonNullable<ReturnType<typeof getDb>>,
  id: string,
  assetId: string,
): Promise<SegmentRow | null> {
  if (!isUuid(id)) return null;
  const { data } = await db
    .from("segment")
    .select("id, name, kind, rule_json, cached_count, cached_at, used_by_automation, updated_at")
    .eq("id", id)
    .eq("asset_id", assetId)
    .maybeSingle();
  return data ? toRow(data) : null;
}

/**
 * Forme minimale d'une règle acceptable.
 *
 * ⚠️ Le nœud groupe porte ses enfants dans `children`, PAS dans `conditions` — c'est la forme
 * produite par le constructeur de segments (`@nf/segments/fields`). Une première version de ce
 * garde-fou exigeait `conditions` : elle refusait TOUTE règle réelle, et le test d'API ne l'a pas vu
 * parce qu'il fabriquait sa charge utile pour satisfaire le validateur au lieu d'utiliser la vraie
 * forme. La validation profonde reste à la compilation vers SQL, qui a sa propre allowlist de champs
 * et d'opérateurs.
 */
export function isValidRule(rule: unknown): rule is Group {
  if (!rule || typeof rule !== "object") return false;
  const g = rule as { type?: unknown; op?: unknown; children?: unknown };
  if (g.type !== "group") return false;
  if (g.op !== "AND" && g.op !== "OR") return false;
  return Array.isArray(g.children);
}
