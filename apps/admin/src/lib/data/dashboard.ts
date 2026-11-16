import { getDb } from "@/lib/supabase";

export interface DashboardStats {
  activeSubs: number;
  totalSubs: number;
  new30: number;
  engActive: number;
  engDormant: number;
  engChurned: number;
  /** Nouveaux abonnés par semaine, 8 dernières semaines (ancien → récent). Scopé comme les KPI. */
  weekly: number[];
  /**
   * false = aucun filtre marque appliqué (base injoignable ou marque inconnue) → les KPI
   * sont un AGRÉGAT toutes marques. L'appelant DOIT le dire à l'utilisateur.
   */
  scoped: boolean;
  source: "db" | "none";
}

const EMPTY: DashboardStats = {
  activeSubs: 0, totalSubs: 0, new30: 0, engActive: 0, engDormant: 0, engChurned: 0,
  weekly: [], scoped: false, source: "none",
};

/**
 * Tous les chiffres du dashboard, lus en base (aucune donnée inventée), pour LA marque courante.
 *
 * `assetId` = marque courante (`getCurrentAsset().id`). ⛔ `null` rend VIDE : le filtre était
 * auparavant omis, et les compteurs redevenaient un agrégat de toutes les marques.
 *
 * ⛔ PLUS DE COMPARAISON ENTRE MARQUES (décision d'Alix du 24/09/2026, feature 6) : l'Overview ne
 * montre que le domaine sélectionné en haut. On change de marque par le sélecteur, comme partout.
 */
export async function getDashboardStats(assetId: string | null): Promise<DashboardStats> {
  const db = getDb();
  if (!db) return EMPTY;
  if (!assetId) return EMPTY;

  // Compteur scopé sur la marque courante (`subscription.asset_id` est NOT NULL en base).
  // ⛔ Sans les contacts hors newsletter (0088) : ce ne sont pas des abonnés, et les additionner
  //    gonflerait « total » et les inscriptions de la semaine de gens qui n'ont rien demandé.
  const cnt = () =>
    db.from("subscription").select("*", { count: "exact", head: true }).eq("asset_id", assetId)
      .neq("status", "contact");
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

  // 8 fenêtres hebdo (la plus ancienne d'abord)
  const weekQueries = Array.from({ length: 8 }, (_, k) =>
    cnt().gte("created_at", iso((8 - k) * 7)).lt("created_at", iso((7 - k) * 7)),
  );

  const results = await Promise.all([
    cnt().eq("status", "active"),
    cnt(),
    cnt().gte("created_at", iso(30)),
    cnt().eq("engagement_level", "active"),
    cnt().eq("engagement_level", "dormant"),
    cnt().eq("engagement_level", "churned"),
    ...weekQueries,
  ]);

  const [active, total, new30, ea, ed, ec, ...rest] = results;
  const weekly = rest.slice(0, 8).map((r) => r.count ?? 0);

  return {
    activeSubs: active.count ?? 0,
    totalSubs: total.count ?? 0,
    new30: new30.count ?? 0,
    engActive: ea.count ?? 0,
    engDormant: ed.count ?? 0,
    engChurned: ec.count ?? 0,
    weekly,
    scoped: assetId !== null,
    source: "db",
  };
}
