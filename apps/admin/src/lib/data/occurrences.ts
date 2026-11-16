/**
 * Lecture des OCCURRENCES d'une campagne récurrente.
 *
 * ⛔ LECTURE SEULE, ET SCOPÉE MARQUE. Une occurrence appartient à une marque ; sans le filtre
 * `asset_id`, l'écran d'une marque afficherait — et laisserait débloquer — les envois d'une autre.
 * Le filtre est posé ici, dans la seule fonction qui lit cette table, plutôt que dans chaque
 * appelant : c'est le point de passage, c'est là que la garde tient.
 */
import { revisionEnAttente } from "@nf/edition/regles";
import { getDb } from "@/lib/supabase";

type Db = NonNullable<ReturnType<typeof getDb>>;

export interface OccurrenceRow {
  id: string;
  seq: number;
  localDate: string | null;
  scheduledAt: string | null;
  status: string;
  holdReason: string | null;
  subject: string;
  sizeBytes: number | null;
  frozenAt: string | null;
  enqueuedAt: string | null;
  sentAt: string | null;
  recipientsPlanned: number | null;
  recipientsSent: number | null;
  recipientsFailed: number | null;
  recipientsSkipped: number | null;
  duplicateOf: string | null;
  duplicateAckAt: string | null;
  duplicateAckBy: string | null;
  /**
   * Les articles que CETTE échéance a réellement retenus, quand son modèle porte un flux.
   *
   * ⛔ C'est la seule preuve lisible de ce qui est parti. Sans elle, une série dynamique n'offre
   * qu'une empreinte de 64 caractères : personne ne peut répondre à « qu'est-ce qui est parti
   * mardi soir ? » sans rouvrir l'email dans sa propre boîte — et donc personne ne le vérifie.
   */
  articles: { url: string; title: string }[];
  /**
   * L'introduction et l'accroche écrites par le modèle au gel (0055).
   *
   * ⛔ `aiStatus` = 'failed' DOIT REMONTER À L'ÉCRAN. Sans lui, une génération ratée est
   * strictement invisible : l'édition part quand même — c'est voulu, un service tiers ne doit pas
   * empêcher un envoi — mais avec un trou à la place de son introduction, et personne ne l'apprend
   * avant de recevoir l'e-mail. NULL = le modèle ne porte aucun jeton IA, aucun appel n'a eu lieu.
   */
  aiStatus: string | null;
  aiReason: string | null;
  aiIntro: string | null;
  aiPreheader: string | null;
  /**
   * Relecture d'édition (0079). `reviewPending` = une relecture est enregistrée et le worker ne l'a
   * pas encore reconstruite : le fan-out SAUTE l'édition tant que c'est vrai. `reviewError` = pourquoi
   * elle ne s'applique pas. `reviewed` = quelqu'un a relu cette édition au moins une fois.
   */
  reviewPending: boolean;
  reviewError: string | null;
  reviewed: boolean;
}

const COLUMNS =
  "id, seq, local_date, scheduled_at, status, hold_reason, subject, size_bytes, frozen_at, enqueued_at, sent_at, " +
  "recipients_planned, recipients_sent, recipients_failed, recipients_skipped, duplicate_of, duplicate_ack_at, duplicate_ack_by, " +
  "ai_status, ai_reason, ai_intro, ai_preheader";

function toRow(raw: unknown): OccurrenceRow {
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : v === null || v === undefined ? null : Number(v));
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    id: String(r.id),
    seq: Number(r.seq ?? 0),
    localDate: str(r.local_date),
    scheduledAt: str(r.scheduled_at),
    status: String(r.status ?? "planned"),
    holdReason: str(r.hold_reason),
    subject: String(r.subject ?? ""),
    sizeBytes: num(r.size_bytes),
    frozenAt: str(r.frozen_at),
    enqueuedAt: str(r.enqueued_at),
    sentAt: str(r.sent_at),
    recipientsPlanned: num(r.recipients_planned),
    recipientsSent: num(r.recipients_sent),
    recipientsFailed: num(r.recipients_failed),
    recipientsSkipped: num(r.recipients_skipped),
    duplicateOf: str(r.duplicate_of),
    duplicateAckAt: str(r.duplicate_ack_at),
    duplicateAckBy: str(r.duplicate_ack_by),
    articles: [],
    aiStatus: str(r.ai_status),
    aiReason: str(r.ai_reason),
    aiIntro: str(r.ai_intro),
    aiPreheader: str(r.ai_preheader),
    reviewPending: false,
    reviewError: null,
    reviewed: false,
  };
}

type EtatRelecture = Pick<OccurrenceRow, "reviewPending" | "reviewError" | "reviewed">;

/**
 * L'état de relecture (0079) de TOUTES les occurrences affichées, en UNE requête — À PART de la liste.
 *
 * ⛔ UNE REQUÊTE SÉPARÉE, ET QUI PEUT ÉCHOUER SANS RIEN EMPORTER. Si ces colonnes étaient dans
 * `COLUMNS`, une base où 0079 n'est pas encore appliquée ferait échouer la lecture ENTIÈRE, et
 * l'écran afficherait « No occurrence yet » au-dessus d'une série qui tourne. Ici, un échec rend une
 * carte vide : on perd le badge de relecture, pas la page.
 *
 * ⛔ « En attente » est la définition du fan-out (`@nf/edition`) : l'écran dit « changes pending »
 * exactement quand l'édition est sautée.
 */
async function relecturesByOccurrence(db: Db, ids: string[]): Promise<Map<string, EtatRelecture>> {
  const out = new Map<string, EtatRelecture>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("campaign_occurrence")
    .select("id, review_rev, review_applied_rev, review_error")
    .in("id", ids);
  if (error) return out;
  for (const raw of (data ?? []) as unknown[]) {
    const r = raw as Record<string, unknown>;
    out.set(String(r.id), {
      reviewPending: revisionEnAttente(r.review_rev, r.review_applied_rev),
      reviewError: typeof r.review_error === "string" ? r.review_error : null,
      reviewed: typeof r.review_rev === "number" && r.review_rev > 0,
    });
  }
  return out;
}

/**
 * Les articles retenus, pour TOUTES les occurrences affichées, en UNE requête.
 *
 * ⚠️ Une requête par occurrence ferait 40 allers-retours pour une page qui en montre 40 : le même
 * écran mettrait dix fois plus longtemps à s'afficher, et la lenteur passerait pour un problème de
 * base de données alors que ce serait une boucle.
 */
async function articlesByOccurrence(db: Db, ids: string[]): Promise<Map<string, { url: string; title: string }[]>> {
  const out = new Map<string, { url: string; title: string }[]>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("feed_article_sent")
    .select("occurrence_id, article_url, article_title")
    .in("occurrence_id", ids)
    .order("sent_at", { ascending: true });
  // Un défaut de lecture ici ne doit pas vider l'écran des occurrences : on perd la liste des
  // articles, pas la page. Le reste de l'écran dit toujours la vérité.
  if (error) return out;
  for (const raw of (data ?? []) as unknown[]) {
    const r = raw as Record<string, unknown>;
    const key = String(r.occurrence_id ?? "");
    const list = out.get(key) ?? [];
    list.push({ url: String(r.article_url ?? ""), title: String(r.article_title ?? "") });
    out.set(key, list);
  }
  return out;
}

/**
 * Les occurrences d'une campagne, la plus proche en premier.
 *
 * ⚠️ Tri par `seq` DÉCROISSANT et non par date : une occurrence retenue ou annulée peut avoir
 * perdu sa date (`local_date` nul), et un tri par date la ferait disparaître en bas de liste —
 * or c'est exactement celle qu'il faut voir.
 */
export async function listOccurrences(db: Db, campaignId: string, assetId: string, limit = 40): Promise<OccurrenceRow[]> {
  const { data, error } = await db
    .from("campaign_occurrence")
    .select(COLUMNS)
    .eq("campaign_id", campaignId)
    .eq("asset_id", assetId)
    .order("seq", { ascending: false })
    .limit(limit);
  if (error) return [];
  const rows = ((data as unknown[]) ?? []).map(toRow);
  const ids = rows.map((r) => r.id);
  const [articles, relectures] = await Promise.all([articlesByOccurrence(db, ids), relecturesByOccurrence(db, ids)]);
  return rows.map((r) => ({ ...r, articles: articles.get(r.id) ?? [], ...relectures.get(r.id) }));
}

/**
 * Combien d'éditions de cette série sont DÉJÀ PARTIES (`sent`) ou en train de partir (`sending`).
 *
 * ⛔ UN COMPTE EN BASE, PAS UN COMPTE SUR LA LISTE AFFICHÉE : `listOccurrences` s'arrête à 40
 * lignes, et un compte tiré d'une liste tronquée est un compte faux. Deux gestes en dépendent : le
 * libellé « Resume series » (on reprend, on ne découvre pas), et la confirmation de suppression, qui
 * affirmait « Nothing was ever sent from it » sur une série dont des éditions étaient parties — la
 * suppression emporte ces éditions avec elle (`on delete cascade`, migration 0027).
 *
 * `null` = lecture en échec : l'écran doit alors se taire sur le chiffre, pas afficher zéro.
 */
export async function compterEditionsParties(db: Db, campaignId: string, assetId: string): Promise<number | null> {
  const { count, error } = await db
    .from("campaign_occurrence")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("asset_id", assetId)
    .in("status", ["sent", "sending"]);
  if (error) return null;
  return count ?? 0;
}

/**
 * LES ÉCHÉANCES QUI VONT RÉELLEMENT PARTIR — `planned` et `frozen`, rien d'autre.
 *
 * ⛔⛔ CE N'EST PAS `OCCURRENCES_ARRETABLES` (`@/lib/data/campaigns`), ET LA DIFFÉRENCE EST LE SUJET.
 * Cette liste-là répond à « qu'est-ce qu'un humain peut encore arrêter ? » et inclut donc `held`.
 * Celle-ci répond à « qu'est-ce qui va partir ? » : une occurrence `held` a été RETENUE par le
 * matérialiseur, elle ne partira pas à sa date. L'annoncer comme prochaine date afficherait un envoi
 * promis qui n'aura pas lieu — et le pire est que l'écran de détail, lui, dirait l'inverse.
 * Même couple de statuts que l'index `idx_occurrence_due` (migration 0027), qui est ce que le
 * planificateur ramasse.
 */
export const ECHEANCES_A_VENIR = ["planned", "frozen"] as const;

/**
 * Les statuts LUS pour décrire une série — `ECHEANCES_A_VENIR` plus `held`.
 *
 * ⛔ `held` EST LU MAIS N'EST JAMAIS UNE DATE. Une édition retenue ne partira pas : l'annoncer comme
 * prochaine échéance promettrait un envoi qui n'aura pas lieu. Mais la TAIRE complètement — ce que
 * faisait le chargeur précédent — est pire : la colonne affichait « Nothing planned » au-dessus
 * d'éditions bel et bien créées et bel et bien bloquées, et rien nulle part ne le disait.
 */
export const ECHEANCES_LUES = [...ECHEANCES_A_VENIR, "held"] as const;

/**
 * Ce qu'une série a vraiment devant elle. Trois faits, parce qu'UNE date n'en couvrait qu'un.
 *
 * ⛔ « Nothing planned » RÉPONDAIT À CINQ ÉTATS DIFFÉRENTS, signalé par Alix le 18/09/2026 sur une
 * série marquée « Series on » : série éteinte · allumée mais pas encore matérialisée (le
 * matérialiseur passe toutes les 10 min) · matérialisée mais RETENUE · en retard (la date est passée
 * et rien n'est parti) · cadence terminée. Quatre d'entre eux sont des pannes ; le cinquième est
 * normal. Les afficher avec la même phrase interdisait de les distinguer — et le pastille verte
 * « Series on » juste à côté affirmait le contraire dans la même seconde.
 */
export type EcheanceSerie = {
  /** La prochaine édition qui partira vraiment. */
  prochaine: string | null;
  /** La PLUS ANCIENNE édition dont la date est passée et qui n'est toujours pas partie. */
  enRetard: string | null;
  /** Des éditions RETENUES par le matérialiseur : créées, et elles ne partiront pas. */
  retenues: number;
};

/**
 * Classe des lignes d'occurrence par campagne. Extrait pour être prouvable sans base.
 *
 * ⛔ ON NE COMPARE PAS DES CHAÎNES, ON COMPARE DES INSTANTS. PostgREST rend
 * `2026-09-20T07:00:00+00:00` là où `toISOString()` rend `2026-09-20T07:00:00.000Z` : un `>=`
 * lexicographique entre ces deux formes répond n'importe quoi (`+` vaut 0x2B, `.` vaut 0x2E), et il
 * répondrait JUSTE tant que les deux côtés viennent de la même source — donc en test, et pas en
 * production.
 *
 * ⛔ ET L'ORDRE DES LIGNES N'EST PLUS UNE HYPOTHÈSE. La version précédente gardait « la première
 * vue » et tenait donc sa justesse d'un `order by` écrit ailleurs, dans la requête : le jour où ce
 * tri change, l'écran annonce l'échéance la plus LOINTAINE sans qu'aucune erreur soit levée. On
 * prend ici le minimum, explicitement.
 */
export function classerEcheances(
  lignes: { campaign_id?: unknown; scheduled_at?: unknown; status?: unknown }[],
  maintenantIso: string,
): Map<string, EcheanceSerie> {
  const out = new Map<string, EcheanceSerie>();
  const maintenant = Date.parse(maintenantIso);
  if (!Number.isFinite(maintenant)) return out;

  for (const r of lignes) {
    const id = r.campaign_id === null || r.campaign_id === undefined ? "" : String(r.campaign_id);
    const quand = r.scheduled_at === null || r.scheduled_at === undefined ? "" : String(r.scheduled_at);
    if (id === "") continue;
    const statut = r.status === null || r.status === undefined ? "" : String(r.status);

    const e = out.get(id) ?? { prochaine: null, enRetard: null, retenues: 0 };
    out.set(id, e);

    // ⚠️ Une édition retenue se COMPTE même sans date : c'est l'incident qui compte, pas son horaire.
    if (statut === "held") {
      e.retenues += 1;
      continue;
    }
    // Une ligne sans date lisible est ignorée plutôt que comptée : la retenir ferait masquer la
    // vraie prochaine échéance par une case vide.
    const t = Date.parse(quand);
    if (quand === "" || !Number.isFinite(t)) continue;

    if (t >= maintenant) {
      if (e.prochaine === null || t < Date.parse(e.prochaine)) e.prochaine = quand;
    } else if (e.enRetard === null || t < Date.parse(e.enRetard)) {
      e.enRetard = quand;
    }
  }
  return out;
}

/**
 * L'état des échéances de chaque série, pour une liste de campagnes, en UNE requête.
 *
 * ⚠️ UNE REQUÊTE, PAS UNE PAR LIGNE. `cadenceDeCampagne()` répond à la même question mais fait une
 * requête plus un RPC par campagne : sur une liste de trente séries, l'écran ferait soixante
 * allers-retours, et la lenteur passerait pour un problème de base de données alors que ce serait
 * une boucle.
 *
 * ⚠️ ELLE LIT LES OCCURRENCES MATÉRIALISÉES, pas la cadence voulue. Une série dont la cadence est
 * enregistrée mais non allumée n'a AUCUNE occurrence, et c'est exact — rien n'est prévu tant que
 * personne ne l'a allumée. Annoncer une date calculée depuis la cadence promettrait un envoi que le
 * matérialiseur ne créera jamais.
 *
 * ⚠️ LE VOLUME EST BORNÉ PAR LES STATUTS, pas par un plafond : `sent`, `sending`, `cancelled` et
 * `failed` sont exclus, et le matérialiseur ne crée qu'à 21 jours (`HORIZON_DAYS`). Ce qui reste,
 * c'est l'horizon plus les incidents.
 */
export async function echeancesDesSeries(
  db: Db,
  campaignIds: string[],
  assetId: string,
  maintenantIso: string,
): Promise<Map<string, EcheanceSerie>> {
  if (campaignIds.length === 0) return new Map();
  const { data, error } = await db
    .from("campaign_occurrence")
    .select("campaign_id, scheduled_at, status")
    .in("campaign_id", campaignIds)
    .eq("asset_id", assetId)
    .in("status", [...ECHEANCES_LUES])
    .order("scheduled_at", { ascending: true });
  // Un défaut de lecture ici ne doit pas vider la liste des campagnes : on perd la colonne « next »,
  // pas l'écran. Le reste des lignes continue de dire la vérité.
  if (error) return new Map();
  return classerEcheances((data ?? []) as Record<string, unknown>[], maintenantIso);
}
