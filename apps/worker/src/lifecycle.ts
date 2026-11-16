/**
 * ---------------------------------------------------------------------------
 * LA PASSE DE CYCLE DE VIE — réactiver les revenants, mesurer les anciennes vagues. ELLE N'ENFILE PLUS.
 * ---------------------------------------------------------------------------
 *
 * ⛔ LA RELANCE DE MASSE D'ICI EST RETIRÉE (24/09/2026, Alix : « je veux tout dans système même les
 * lifecycles et que tout soit éditable directement depuis la page automations »). La relance des
 * inactifs est l'automation « Re-engagement » du moteur (0082) : visible, modifiable, simulée avant
 * d'être armée, depuis Automations. Deux relances en parallèle écriraient deux fois aux mêmes gens.
 * Aucun chemin de ce fichier n'appelle plus `enqueue_reengagement_batch` (0058), et
 * `LIFECYCLE_ENABLED` n'arme plus rien : la variable est lue pour être signalée, jamais obéie.
 *
 * Ce qui reste :
 *  - la RÉACTIVATION (`reactivate_sunset`, 0058), SEUL chemin qui annule un sunset — celui que pose
 *    l'automation Sunset du moteur (0082 : « réversible »). La tâche `plan` la fait à CHAQUE passe
 *    (`reactiverRevenants`), puisque cette tâche-ci n'a jamais eu de cron ;
 *  - la MESURE des vagues déjà parties (0060), pour qu'une relance passée qui a coûté reste visible.
 *
 * ⛔ ELLE N'INSTANCIE NI `Db` NI `Mailgun`, comme `plan` et `engagement`.
 */
import { createClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./env";
import { log } from "./log";

interface LigneReactivation {
  candidates?: number;
  reactivated?: number;
}

/** Ce que `sync_lifecycle_outcomes` (0060) rend : des relances vues, des relances mises à jour. */
interface LigneSync {
  candidates?: number;
  updated?: number;
}

/**
 * Une ligne de `newsletter.reengagement_result` (0060) : ce qu'une vague a produit, par marque.
 *
 * ⚠️ `opened` et `clicked` y sont STRUCTURELLEMENT NULS et ce n'est pas une panne — Mailgun ne pose
 * ni pixel ni réécriture de lien sans `tracking_consent`. Ils sont lus quand même : le jour où ce
 * consentement change, la mesure suit sans qu'on ait à toucher au worker.
 */
export interface LigneResultat {
  asset_id?: string | null;
  asset_slug?: string | null;
  enqueued?: number;
  delivered?: number;
  responded?: number;
  unsubscribed?: number;
  complained?: number;
  bounced?: number;
  orphan_events?: number;
}

export interface LifecycleDbLike {
  reactivate(assetId: string | null, dryRun: boolean): Promise<LigneReactivation>;
  /** Reporte sur chaque relance les événements postérieurs qui la concernent (0060). */
  syncOutcomes(assetId: string | null, dryRun: boolean): Promise<LigneSync>;
  /** Lit le résultat par marque, après synchronisation. */
  outcomes(assetId: string | null): Promise<LigneResultat[]>;
}

/** ⚠️ Factory plutôt que `ReturnType<typeof createClient>` : le type nu perd l'option `schema` et
 *  supabase-js infère alors un schéma VIDE — toutes les tables deviennent `never`. */
function makeClient(cfg: WorkerConfig) {
  return createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    db: { schema: "newsletter" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export class LifecycleDb implements LifecycleDbLike {
  private sb: ReturnType<typeof makeClient>;

  constructor(cfg: WorkerConfig) {
    this.sb = makeClient(cfg);
  }

  async reactivate(assetId: string | null, dryRun: boolean): Promise<LigneReactivation> {
    const { data, error } = await this.sb.rpc("reactivate_sunset", {
      p_asset_id: assetId,
      p_dry_run: dryRun,
    });
    if (error) throw new Error(`reactivate_sunset: ${error.message}`);
    return (((data ?? []) as LigneReactivation[])[0]) ?? {};
  }

  async syncOutcomes(assetId: string | null, dryRun: boolean): Promise<LigneSync> {
    const { data, error } = await this.sb.rpc("sync_lifecycle_outcomes", {
      p_asset_id: assetId,
      p_dry_run: dryRun,
    });
    if (error) throw new Error(`sync_lifecycle_outcomes: ${error.message}`);
    return (((data ?? []) as LigneSync[])[0]) ?? {};
  }

  async outcomes(assetId: string | null): Promise<LigneResultat[]> {
    let q = this.sb.from("reengagement_result").select("*");
    if (assetId) q = q.eq("asset_id", assetId);
    const { data, error } = await q;
    if (error) throw new Error(`reengagement_result: ${error.message}`);
    return (data ?? []) as LigneResultat[];
  }
}

/**
 * Le plancher en dessous duquel un ratio ne veut rien dire.
 *
 * ⛔ SANS LUI, UNE SEULE PERSONNE DÉCLENCHE L'ALERTE. Trois e-mails délivrés, un désabonnement,
 * zéro réaction : le rapport « coût > bénéfice » est vrai arithmétiquement et faux en pratique. Une
 * alerte qui se déclenche sur du bruit est coupée avant le jour où elle sert.
 */
const MIN_DELIVERED_POUR_JUGER = 20;

/**
 * Les marques dont une vague a coûté plus qu'elle n'a rapporté.
 *
 * ⛔ LE DÉNOMINATEUR EST `delivered`, JAMAIS `enqueued`. Une relance peut rester `pending` pour
 * toujours ; la compter parmi les e-mails « envoyés à des gens » ferait baisser artificiellement
 * tous les taux, et donc taire l'alerte exactement quand la file se bouche.
 *
 * ⛔ LE COÛT INCLUT LES PLAINTES, PAS LES REBONDS. Un désabonnement et une plainte sont des refus ;
 * un rebond est une adresse morte, qui ne dit rien du contenu ni du bien-fondé de la relance.
 */
export function vaguesCouteuses(lignes: LigneResultat[]): string[] {
  const couteuses: string[] = [];
  for (const l of lignes) {
    const delivered = Number(l.delivered ?? 0);
    if (delivered < MIN_DELIVERED_POUR_JUGER) continue;
    const cout = Number(l.unsubscribed ?? 0) + Number(l.complained ?? 0);
    const gain = Number(l.responded ?? 0);
    if (cout > gain) couteuses.push(l.asset_slug ?? l.asset_id ?? "?");
  }
  return couteuses;
}

export interface LifecycleOptions {
  /** Restreindre à une marque. `null` = toutes. */
  assetId?: string | null;
}

export interface LifecycleReport {
  reactivated: number;
  /** Relances dont un résultat a été reporté par cette passe (0060). */
  outcomesUpdated: number;
  /** Le dénominateur honnête : des relances CONFIRMÉES remises, toutes vagues confondues. */
  delivered: number;
  /** Réactions de première partie — ouverture de la page de préférences depuis la relance. */
  responded: number;
  /** Le coût : désabonnements et plaintes postérieurs à une relance. */
  unsubscribed: number;
  complained: number;
  /**
   * Événements reçus sans ligne d'origine rattachable.
   *
   * ⛔ CE N'EST PAS UNE SOMME, C'EST LE PLUS GRAND COMPTE VU. La vue ajoute à chaque marque les
   * orphelins SANS marque — additionner les lignes compterait ces derniers autant de fois qu'il y a
   * de marques. Non nul, il dit une seule chose, et elle suffit : tous les chiffres ci-dessus sont
   * des PLANCHERS.
   */
  orphanEvents: number;
  /** Marques dont une vague délivrée a coûté plus qu'elle n'a rapporté. */
  costlyAssets: string[];
}

/**
 * Réactive les abonnés revenus APRÈS leur sunset. Un appel, toute la base ou une marque.
 *
 * ⛔ Ne pas réactiver n'est pas une précaution, c'est laisser quelqu'un exclu à tort : seul un
 * appelant qui simule lui-même (`dryRun`) se contente de compter.
 * ⚠️ Sans risque de ressusciter tout le monde : la fonction SQL ne réactive que sur une réaction
 * STRICTEMENT postérieure à la marque (0058).
 */
export async function reactiverRevenants(
  db: Pick<LifecycleDbLike, "reactivate">,
  assetId: string | null,
  dryRun: boolean,
): Promise<{ candidates: number; reactivated: number }> {
  const r = await db.reactivate(assetId, dryRun);
  const out = { candidates: Number(r.candidates ?? 0), reactivated: Number(r.reactivated ?? 0) };
  if (out.candidates > 0) log("sunset-reactivated", { dry_run: dryRun, candidates: out.candidates, reactivated: out.reactivated });
  return out;
}

/**
 * Une passe de cycle de vie : réactiver, puis mesurer ce qu'ont produit les vagues DÉJÀ parties.
 *
 * ⛔ ELLE N'ENFILE RIEN, quoi que dise l'environnement (voir l'en-tête).
 * ⚠️ La mesure tourne sans simulation : reporter des faits DÉJÀ arrivés n'envoie rien et ne met rien
 * en file. Ne pas le faire ne protégerait personne — cela rendrait seulement le rapport aveugle.
 */
export async function runLifecycle(db: LifecycleDbLike, opts: LifecycleOptions): Promise<LifecycleReport> {
  const assetId = opts.assetId ?? null;

  const { reactivated } = await reactiverRevenants(db, assetId, false);

  const sync = await db.syncOutcomes(assetId, false);
  const outcomesUpdated = Number(sync.updated ?? 0);
  const resultats = await db.outcomes(assetId);

  const somme = (f: (l: LigneResultat) => number) => resultats.reduce((t, l) => t + f(l), 0);

  const report: LifecycleReport = {
    reactivated,
    outcomesUpdated,
    delivered: somme((l) => Number(l.delivered ?? 0)),
    responded: somme((l) => Number(l.responded ?? 0)),
    unsubscribed: somme((l) => Number(l.unsubscribed ?? 0)),
    complained: somme((l) => Number(l.complained ?? 0)),
    orphanEvents: resultats.reduce((m, l) => Math.max(m, Number(l.orphan_events ?? 0)), 0),
    costlyAssets: vaguesCouteuses(resultats),
  };

  log("lifecycle-done", {
    reactivated: report.reactivated,
    // Ce qu'ont produit les vagues précédentes. `delivered` est le dénominateur : sans lui, aucun
    // des trois autres chiffres ne se lit.
    outcomes_updated: report.outcomesUpdated,
    delivered: report.delivered,
    responded: report.responded,
    unsubscribed: report.unsubscribed,
    complained: report.complained,
    // ⛔ Non nul ⇒ des événements arrivent sans qu'on sache à quoi les rattacher, et TOUS les
    // chiffres de cette ligne sont des planchers. Sans ce compteur, « 0 réaction » et « la mesure
    // ne mord pas » s'écrivent exactement pareil dans le journal.
    orphan_events: report.orphanEvents,
    costly: report.costlyAssets.length,
  });

  return report;
}

/**
 * Un seul cas réveille quelqu'un : UNE VAGUE DÉLIVRÉE A COÛTÉ PLUS QU'ELLE N'A RAPPORTÉ
 * (`costlyAssets`) — plus de refus que de réactions. Rien n'échoue, tout est vert, et on perd des
 * abonnés. Ces e-mails sont DÉJÀ partis : leur coût est acquis.
 *
 * ⛔ Le plafond quotidien n'alerte plus d'ici : plus rien n'y est enfilé (il vit dans l'automation).
 */
export function lifecycleNeedsAlert(r: LifecycleReport): boolean {
  return r.costlyAssets.length > 0;
}
