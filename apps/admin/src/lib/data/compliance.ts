import { getDb } from "@/lib/supabase";

/** Données de conformité (audit consentement + DSAR + suppression), lues depuis `newsletter` (service_role). */

export interface AuditRow {
  email: string;
  asset: string;
  event_type: string;
  purpose: string | null;
  method: string | null;
  legal_basis: string | null;
  country: string | null;
  occurred_at: string;
}

export interface DsarRow {
  email: string;
  type: string;
  status: string;
  requested_at: string;
  due_at: string | null;
}

export interface SuppressionRow {
  email: string | null;
  scope: string;
  reason: string | null;
  created_at: string;
}

export interface ComplianceData {
  source: "db" | "none";
  /**
   * `dsarOpen` reste TOUTES MARQUES : `newsletter.dsar_request` n'a pas de colonne asset
   * (une demande DSAR porte sur une personne, pas sur une marque). L'UI doit l'étiqueter.
   */
  kpis: { consentEvents: number; suppressions: number; dsarOpen: number };
  audit: AuditRow[];
  dsar: DsarRow[];
  suppressions: SuppressionRow[];
  /** false = aucun filtre marque appliqué → tout est un agrégat toutes marques. */
  scoped: boolean;
}

const EMPTY: ComplianceData = {
  source: "none",
  kpis: { consentEvents: 0, suppressions: 0, dsarOpen: 0 },
  audit: [],
  dsar: [],
  suppressions: [],
  scoped: false,
};

/**
 * `assetId` = marque courante (`getCurrentAsset().id`), `null` → aucun filtre (`scoped: false`).
 *
 * Portée par table :
 *  • `consent_event`  → PAS de colonne asset. On filtre par la RELATION imbriquée
 *    `subscription:subscription_id!inner(asset_id)` + `.eq("subscription.asset_id", …)`,
 *    c'est-à-dire une vraie jointure exécutée par PostgREST côté serveur. C'est la voie
 *    SÛRE : l'alternative (lire tous les `subscription.id` de la marque puis `.in(ids)`)
 *    explose dès quelques milliers d'abonnés — URL trop longue, résultat tronqué en
 *    silence, donc un journal d'audit FAUX. Sur un log de conformité c'est inacceptable.
 *  • `suppression`    → `asset_id` nullable : on garde le global (`asset_id is null`) ET
 *    la marque, parce qu'une suppression globale s'applique bien à cette marque.
 *  • `dsar_request`   → aucune notion de marque : reste global, à étiqueter dans l'UI.
 */
export async function getComplianceData(assetId: string | null): Promise<ComplianceData> {
  const db = getDb();
  if (!db) return EMPTY;
  // ⛔ Voir subscribers.ts : sans marque courante on rend VIDE, jamais l'agrégat de toutes.
  if (!assetId) return EMPTY;

  // --- consent_event : compteur ---
  // `: string` volontaire : évite que TS infère un type littéral union sur `select()`.
  const ceSelect: string = assetId ? "subscription:subscription_id!inner(asset_id)" : "*";
  let ceCountQ = db.from("consent_event").select(ceSelect, { count: "exact", head: true });
  if (assetId) ceCountQ = ceCountQ.eq("subscription.asset_id", assetId);

  // --- consent_event : 60 derniers événements ---
  // `!inner` seulement quand on filtre : sans filtre on garde le left join (on ne veut
  // pas perdre d'événements dont la souscription aurait été purgée).
  const auditSelect =
    "event_type, purpose, method, legal_basis, country, occurred_at, " +
    `subscription:subscription_id${assetId ? "!inner" : ""}(asset:asset_id(name), subscriber:subscriber_id(email))`;
  let auditFilter = db.from("consent_event").select(auditSelect);
  if (assetId) auditFilter = auditFilter.eq("subscription.asset_id", assetId);
  const auditQ = auditFilter.order("occurred_at", { ascending: false }).limit(60);

  // --- suppression : global + marque ---
  // `asset_id is null` = suppression globale : elle s'applique AUSSI à la marque courante,
  // donc on l'inclut — l'omettre laisserait croire qu'on peut réécrire à ces adresses.
  const supScope = `asset_id.is.null,asset_id.eq.${assetId}`;

  let supCountQ = db.from("suppression").select("*", { count: "exact", head: true });
  if (assetId) supCountQ = supCountQ.or(supScope);

  let supFilter = db.from("suppression").select("email, scope, reason, created_at");
  if (assetId) supFilter = supFilter.or(supScope);
  const supQ = supFilter.order("created_at", { ascending: false }).limit(40);

  const [ceCount, supCount, dsarOpen, auditRes, dsarQ, supRes] = await Promise.all([
    ceCountQ,
    supCountQ,
    // dsar_request : pas de colonne asset → volontairement global.
    db.from("dsar_request").select("*", { count: "exact", head: true }).in("status", ["pending", "processing"]),
    auditQ,
    db
      .from("dsar_request")
      .select("email, type, status, requested_at, due_at")
      .order("requested_at", { ascending: false })
      .limit(40),
    supQ,
  ]);

  const audit: AuditRow[] = ((auditRes.data as unknown[]) ?? []).map((raw) => {
    const r = raw as Record<string, unknown> & {
      subscription?: { asset?: { name?: string }; subscriber?: { email?: string } };
    };
    return {
      email: r.subscription?.subscriber?.email ?? "—",
      asset: r.subscription?.asset?.name ?? "—",
      event_type: String(r.event_type ?? ""),
      purpose: (r.purpose as string | null) ?? null,
      method: (r.method as string | null) ?? null,
      legal_basis: (r.legal_basis as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      occurred_at: String(r.occurred_at ?? ""),
    };
  });

  const dsar: DsarRow[] = ((dsarQ.data as unknown[]) ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      email: (r.email as string | null) ?? "—",
      type: String(r.type ?? ""),
      status: String(r.status ?? ""),
      requested_at: String(r.requested_at ?? ""),
      due_at: (r.due_at as string | null) ?? null,
    };
  });

  const suppressions: SuppressionRow[] = ((supRes.data as unknown[]) ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      email: (r.email as string | null) ?? null,
      scope: String(r.scope ?? ""),
      reason: (r.reason as string | null) ?? null,
      created_at: String(r.created_at ?? ""),
    };
  });

  return {
    source: "db",
    kpis: {
      consentEvents: ceCount.count ?? 0,
      suppressions: supCount.count ?? 0,
      dsarOpen: dsarOpen.count ?? 0,
    },
    audit,
    dsar,
    suppressions,
    scoped: assetId !== null,
  };
}
