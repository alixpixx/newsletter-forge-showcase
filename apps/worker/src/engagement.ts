/**
 * ---------------------------------------------------------------------------
 * L'ENGAGEMENT — recalculé depuis les événements, jamais deviné.
 * ---------------------------------------------------------------------------
 *
 * ⛔ POURQUOI CETTE TÂCHE EXISTE. Les neuf colonnes d'engagement de `subscription` sont lues par le
 * tableau de bord, par l'écran Subscribers et par le compilateur de segments — et n'étaient écrites
 * par AUCUN code. Leur seul écrivain était `0004_seed_demo_subscribers.sql`, c'est-à-dire le jeu de
 * démonstration. Tant que rien ne les recalcule, cibler « les inactifs » vise une colonne que
 * personne n'alimente : le segment a l'air de marcher, et il désigne des gens au hasard.
 *
 * ⛔ LE CALCUL EST EN SQL, PAS ICI. Une boucle applicative sur des milliers d'abonnements ferait un
 * aller-retour par ligne, ne serait pas atomique, et écrirait un état à moitié recalculé si elle
 * s'interrompait. La fonction `newsletter.recompute_engagement` (0056) fait tout en une passe et
 * n'écrit que ce qui change. Ce fichier ne fait que l'appeler, la journaliser et alerter.
 *
 * ⛔ CETTE TÂCHE N'ENVOIE RIEN et ne touche jamais `email_outbox`. Elle lit `email_event` et écrit
 * des colonnes de `subscription` — c'est tout. Elle n'ouvre pas Mailgun, comme `plan`.
 */
import { createClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./env";
import { log } from "./log";

export interface EngagementReport {
  scanned: number;
  changed: number;
  active: number;
  dormant: number;
  churned: number;
  /** Combien d'abonnements n'ont reçu AUCUN e-mail mesurable. Voir le commentaire de `runEngagement`. */
  withoutEvents: number;
  /**
   * Combien d'e-mails sont RÉELLEMENT partis, tous abonnés confondus.
   *
   * ⛔ C'EST LE DISCRIMINANT, et il n'a rien d'un ornement. « Personne n'a d'événement » a deux
   * causes qui donnent le même chiffre et appellent des gestes opposés : soit rien n'est encore
   * parti (état normal, on attend), soit des e-mails sont partis et leurs retours ne se rattachent
   * à personne (la jointure webhook → outbox est cassée, et tout l'engagement restera nul en
   * silence). Sans ce compteur, `withoutEvents = 100 %` ne nomme pas sa cause.
   */
  sentEmails: number;
  dryRun: boolean;
}

/** Ce que la fonction SQL rend, en `snake_case`. */
interface Ligne {
  scanned?: number;
  changed?: number;
  lvl_active?: number;
  lvl_dormant?: number;
  lvl_churned?: number;
  without_events?: number;
}

export interface EngagementDbLike {
  recompute(assetId: string | null, dryRun: boolean): Promise<Ligne>;
  /** Combien d'e-mails ont réellement quitté la file (`status = 'sent'`), sur le même périmètre. */
  countSentEmails(assetId: string | null): Promise<number>;
}

/** ⚠️ Factory, et non `ReturnType<typeof createClient>` : annoter le client avec le type nu perd
 *  l'option `schema` et supabase-js infère alors un schéma VIDE — toutes les tables deviennent
 *  `never`, et chaque requête cesse de compiler pour une raison qui n'a rien à voir avec elle. */
function makeClient(cfg: WorkerConfig) {
  return createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    db: { schema: "newsletter" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export class EngagementDb implements EngagementDbLike {
  private sb: ReturnType<typeof makeClient>;

  constructor(cfg: WorkerConfig) {
    this.sb = makeClient(cfg);
  }

  async recompute(assetId: string | null, dryRun: boolean): Promise<Ligne> {
    /*
     * ⚠️ `p_now` N'EST PAS PASSÉ : la fonction prend `now()` de POSTGRES. L'horloge du worker et
     * celle de la base peuvent dériver, et tous les seuils d'ancienneté (30 j, 90 j) se lisent
     * contre cette date. Deux horloges pour une seule frontière feraient basculer des abonnés d'un
     * niveau à l'autre selon la machine qui a lancé la passe.
     */
    const { data, error } = await this.sb.rpc("recompute_engagement", {
      p_asset_id: assetId,
      p_dry_run: dryRun,
    });
    if (error) throw new Error(`recompute_engagement: ${error.message}`);
    // La fonction est `returns table` : PostgREST rend un tableau d'une seule ligne.
    const rows = (data ?? []) as Ligne[];
    return rows[0] ?? {};
  }

  async countSentEmails(assetId: string | null): Promise<number> {
    /*
     * `head: true` : on veut le NOMBRE, pas les lignes. Ramener la file d'envoi entière pour la
     * compter côté worker coûterait le volume d'une campagne pour un seul entier.
     *
     * ⚠️ LE PÉRIMÈTRE SUIT CELUI DU RECALCUL. Compter les envois de TOUTES les marques pendant
     * qu'on ne recalcule qu'une seule ferait dire au discriminant « des e-mails sont partis » alors
     * qu'aucun n'est parti pour la marque examinée — l'alerte accuserait une jointure saine.
     */
    let q = this.sb.from("email_outbox").select("id", { count: "exact", head: true }).eq("status", "sent");
    if (assetId) q = q.eq("asset_id", assetId);
    const { count, error } = await q;
    if (error) throw new Error(`count sent emails: ${error.message}`);
    return count ?? 0;
  }
}

/**
 * Une passe de recalcul.
 *
 * ⚠️ `withoutEvents` EST LE CHIFFRE QUI DIT SI LA CHAÎNE MARCHE. Un abonnement sans aucun événement
 * mesurable est normal quand il vient d'arriver — et suspect quand ils le sont tous. Au 08/09/2026,
 * `email_event` est VIDE (aucun e-mail jamais envoyé) : la valeur attendue est donc 100 %, et elle
 * doit tomber dès les premiers envois. Si elle reste à 100 % après un envoi réel, ce n'est pas
 * l'engagement qui est nul, c'est la jointure webhook → outbox qui ne rattache rien.
 */
export async function runEngagement(
  db: EngagementDbLike,
  opts: { assetId?: string | null; dryRun?: boolean } = {},
): Promise<EngagementReport> {
  const dryRun = opts.dryRun === true;
  const assetId = opts.assetId ?? null;
  const r = await db.recompute(assetId, dryRun);
  const report: EngagementReport = {
    scanned: Number(r.scanned ?? 0),
    changed: Number(r.changed ?? 0),
    active: Number(r.lvl_active ?? 0),
    dormant: Number(r.lvl_dormant ?? 0),
    churned: Number(r.lvl_churned ?? 0),
    withoutEvents: Number(r.without_events ?? 0),
    sentEmails: await db.countSentEmails(assetId),
    dryRun,
  };
  log("engagement-done", {
    dry_run: dryRun,
    scanned: report.scanned,
    changed: report.changed,
    active: report.active,
    dormant: report.dormant,
    churned: report.churned,
    without_events: report.withoutEvents,
    sent_emails: report.sentEmails,
  });
  return report;
}

/**
 * Le seul cas où cette passe doit réveiller quelqu'un : des e-mails sont partis, et AUCUN abonnement
 * n'a le moindre événement mesurable.
 *
 * ⛔ POURQUOI CE PRÉDICAT, ET PAS « withoutEvents > 0 ». Un abonné sans événement est le cas NORMAL
 * tant que rien ne lui a été envoyé — au 08/09/2026 c'est l'état de toute la base (0 e-mail parti).
 * Alerter là-dessus, ce serait crier tous les soirs sur un état sain jusqu'au premier envoi, et
 * l'alerte serait coupée bien avant de servir. Ce qu'on veut savoir est l'inverse : les e-mails
 * partent, et les retours ne se rattachent à personne — c'est la signature exacte d'une jointure
 * `provider_message_id` cassée, qui rendrait zéro partout avec un journal parfaitement vert.
 *
 * ⚠️ `scanned > 0` est nécessaire : sur un périmètre vide, `withoutEvents === scanned` vaut 0 === 0
 * et l'alerte partirait sur une base sans le moindre abonné.
 */
export function engagementNeedsAlert(r: EngagementReport): boolean {
  return r.sentEmails > 0 && r.scanned > 0 && r.withoutEvents === r.scanned;
}
