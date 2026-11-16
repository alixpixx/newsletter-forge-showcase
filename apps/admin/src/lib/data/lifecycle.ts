import { getDb } from "@/lib/supabase";

/**
 * CE QU'UNE VAGUE DE RÉENGAGEMENT A PRODUIT.
 *
 * La source est la vue `newsletter.reengagement_result` (0060), alimentée par
 * `sync_lifecycle_outcomes` que le worker appelle AVANT chaque passe.
 *
 * ⛔ CE QUE CET ÉCRAN NE DOIT SURTOUT PAS FAIRE CROIRE. Il n'y a ni ouverture ni clic à afficher, et
 * ce n'est pas une panne : Mailgun ne pose ni pixel ni réécriture de lien sans `tracking_consent`,
 * refusé par 1 202 abonnements sur 1 203 (mesuré le 09/09/2026). Une carte « taux d'ouverture »
 * afficherait donc 0 % pour toujours, et quelqu'un finirait par en conclure que la relance ne
 * fonctionne pas — alors qu'elle n'aurait jamais été mesurée. Les deux colonnes existent quand
 * même : le jour où ce consentement change, l'écran suit tout seul.
 *
 * ⛔ TOUT EST SCOPÉ MARQUE, comme `optins.ts`. Deux marques n'ont ni la même liste, ni la même
 * tolérance au désabonnement ; additionner leurs vagues laisserait une grosse liste saine masquer
 * une petite qu'on est en train de détruire.
 */

export interface ReengagementRow {
  assetId: string | null;
  assetSlug: string | null;
  step: number;
  /** Relances mises en file. Ce n'est PAS le dénominateur — une ligne peut rester pending. */
  enqueued: number;
  /** Le dénominateur honnête : remises CONFIRMÉES par le fournisseur. */
  delivered: number;
  /** Réactions de première partie : la page de préférences ouverte depuis la relance. */
  responded: number;
  /** ⚠️ Structurellement nuls tant que le consentement de suivi est refusé (voir en-tête). */
  opened: number;
  clicked: number;
  unsubscribed: number;
  complained: number;
  bounced: number;
  firstSentAt: string | null;
  lastSentAt: string | null;
  /**
   * Événements reçus sans ligne d'origine rattachable.
   *
   * ⛔ LA COLONNE LA PLUS IMPORTANTE DE CET ÉCRAN. Non nulle, elle dit que des événements arrivent
   * sans qu'on sache à quoi les rattacher : tous les autres chiffres deviennent des PLANCHERS.
   * Sans elle, « 0 réaction » et « la mesure ne mord pas » s'affichent exactement pareil.
   */
  orphanEvents: number;
}

export interface ReengagementResult {
  rows: ReengagementRow[];
  source: "db" | "none";
  /** Motif quand la lecture a échoué — distinct d'une marque qui n'a simplement rien relancé. */
  reason: string | null;
}

const VIDE: ReengagementResult = { rows: [], source: "none", reason: null };

export async function getReengagementResult(assetId: string | null): Promise<ReengagementResult> {
  const db = getDb();
  if (!db) return { ...VIDE, reason: "no-db" };
  if (!assetId) return { ...VIDE, reason: "no-asset" };

  const { data, error } = await db
    .from("reengagement_result")
    .select("*")
    .eq("asset_id", assetId)
    .order("step");

  if (error) return { ...VIDE, reason: error.message };

  const rows: ReengagementRow[] = ((data as unknown[]) ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      assetId: (r.asset_id as string | null) ?? null,
      assetSlug: (r.asset_slug as string | null) ?? null,
      step: Number(r.step ?? 1),
      enqueued: Number(r.enqueued ?? 0),
      delivered: Number(r.delivered ?? 0),
      responded: Number(r.responded ?? 0),
      opened: Number(r.opened ?? 0),
      clicked: Number(r.clicked ?? 0),
      unsubscribed: Number(r.unsubscribed ?? 0),
      complained: Number(r.complained ?? 0),
      bounced: Number(r.bounced ?? 0),
      firstSentAt: (r.first_sent_at as string | null) ?? null,
      lastSentAt: (r.last_sent_at as string | null) ?? null,
      orphanEvents: Number(r.orphan_events ?? 0),
    };
  });

  return { rows, source: "db", reason: null };
}

/** Les totaux d'un écran, tous pas confondus. */
export interface ReengagementTotals {
  enqueued: number;
  delivered: number;
  responded: number;
  unsubscribed: number;
  complained: number;
  bounced: number;
  orphanEvents: number;
  /** `responded / delivered`, ou `null` quand rien n'a été remis — jamais 0 %. */
  responseRate: number | null;
  /** `(unsubscribed + complained) / delivered`, ou `null` pour la même raison. */
  costRate: number | null;
}

/**
 * ⛔ UN TAUX SANS DÉNOMINATEUR EST `null`, JAMAIS ZÉRO. « 0 % de réponses » et « aucun e-mail
 * remis » sont deux phrases opposées : la première accuse la relance, la seconde dit qu'il n'y a
 * rien à juger. Les afficher pareil est la façon la plus simple de condamner une mécanique qui n'a
 * jamais tourné.
 *
 * ⛔ `orphanEvents` EST UN MAXIMUM, PAS UNE SOMME. La vue ajoute à chaque ligne les événements sans
 * marque : les additionner les compterait une fois par pas.
 */
export function totalReengagement(rows: ReengagementRow[]): ReengagementTotals {
  const s = (f: (r: ReengagementRow) => number) => rows.reduce((t, r) => t + f(r), 0);
  const delivered = s((r) => r.delivered);
  const responded = s((r) => r.responded);
  const unsubscribed = s((r) => r.unsubscribed);
  const complained = s((r) => r.complained);

  return {
    enqueued: s((r) => r.enqueued),
    delivered,
    responded,
    unsubscribed,
    complained,
    bounced: s((r) => r.bounced),
    orphanEvents: rows.reduce((m, r) => Math.max(m, r.orphanEvents), 0),
    responseRate: delivered > 0 ? responded / delivered : null,
    costRate: delivered > 0 ? (unsubscribed + complained) / delivered : null,
  };
}
