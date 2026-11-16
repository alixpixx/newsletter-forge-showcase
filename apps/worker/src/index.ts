/**
 * Point d'entrée du worker d'envoi newsletter-forge.
 *
 * Modes :
 *  - dry-run (DÉFAUT) : lecture seule, aucune mutation ni envoi. Prévisualise la décision de
 *    chaque ligne envoyable (would_send / would_skip:raison, tracking, from, allowlist). C'est
 *    ce qui tourne tant que DNS/DKIM + sign-off allowlist ne sont pas faits.
 *  - live : claim (pending→sending) → contexte → envoi Mailgun → mark. Gardes de boot fail-closed.
 *
 * Cadence : RUN_ONCE (défaut) draine puis exit 0 (cron) ; sinon SERVICE RÉSIDENT qui, toutes les
 * `POLL_INTERVAL_MS`, met en file ce qui est dû maintenant puis vide la file — l'envoi immédiat.
 * Arrêt gracieux SIGTERM/SIGINT : on ne démarre plus de nouvelle ligne, l'in-flight finit, exit.
 */
import { ALLOWLIST_OUVERTE, parseWorkerEnv } from "./env";
import { Db } from "./db";
import { Mailgun } from "./mailgun";
import { processRow } from "./process";
import { FENETRE_DEBIT_MS, fenetreCourante, lignesAReclamer, type FenetreDebit } from "./debit";
import { PlannerDb } from "./planner-db";
import { FanoutDb } from "./fanout-db";
import { compterCiblesDues, runFanout } from "./fanout";
import { fanoutSimule, optionsFanoutDepuisEnv, optionsFanoutInstantane } from "./fanout-env";
import { ReconcileDb } from "./reconcile-db";
import { runReconcile } from "./reconcile";
import { runPlanner } from "./planner";
import { EngagementDb, runEngagement, engagementNeedsAlert } from "./engagement";
import { LifecycleDb, reactiverRevenants, runLifecycle, lifecycleNeedsAlert } from "./lifecycle";
import { AutomationDb } from "./automations/db";
import { resumeAutomations, runAutomations } from "./automations/engine";
import { parseTask } from "./task";
import { log, slackAlert } from "./log";

let stopping = false;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function dryRunOnce(db: Db, cfg: ReturnType<typeof parseWorkerEnv>, mailgun: Mailgun): Promise<number> {
  const rows = await db.peekPending(cfg.batchSize);
  for (const ctx of rows) {
    if (stopping) break;
    try {
      await processRow(ctx, cfg, db, mailgun);
    } catch (e) {
      log("row", { id: ctx.id, kind: ctx.kind, decision: "error", reason: (e as Error).message });
    }
  }
  return rows.length;
}

/**
 * Un lot : réclamer AU PLUS `aReclamer` lignes, les traiter, rendre combien ont été réclamées.
 *
 * ⛔ `aReclamer` EST UN PARAMÈTRE, ET PAS `cfg.batchSize`. C'est l'appelant qui sait combien il
 * reste au passage en cours (voir `debit.ts`) : lire `cfg.batchSize` ici rendrait le plafond
 * inopérant, puisque chaque lot repartirait pour dix.
 *
 * `file` choisit la réclamation : `toute` (tous les kinds, interactifs en tête — 0057) ou
 * `interactifs` (seulement confirmation, bienvenue, accusé, test — 0073).
 */
async function drainOnceLive(
  db: Db,
  cfg: ReturnType<typeof parseWorkerEnv>,
  mailgun: Mailgun,
  aReclamer: number,
  file: "toute" | "interactifs" = "toute",
): Promise<number> {
  const ids =
    file === "interactifs"
      ? await db.claimInteractive(cfg.workerId, aReclamer, cfg.staleLockSeconds)
      : await db.claim(cfg.workerId, aReclamer, cfg.staleLockSeconds);
  if (ids.length === 0) return 0;
  const ctxs = await db.fetchContext(ids);
  const byId = new Map(ctxs.map((c) => [c.id, c]));
  let i = 0;
  for (; i < ids.length; i++) {
    if (stopping) break;
    const id = ids[i]!;
    const ctx = byId.get(id);
    if (!ctx) {
      // Ligne claim mais absente de la vue (ne devrait pas arriver) : échec permanent, pas de boucle.
      await db.markFailed(id, "context_missing", false);
      log("row", { id, decision: "failed", reason: "context_missing" });
      continue;
    }
    try {
      await processRow(ctx, cfg, db, mailgun);
    } catch (e) {
      // Exception de code : la ligne est 'sending' → on la repasse en pending (retryable).
      await db.markFailed(id, `worker_exception: ${(e as Error).message}`, true);
      log("row", { id, kind: ctx.kind, decision: "failed", reason: "exception" });
    }
  }
  // Arrêt gracieux au milieu du lot : relâcher les lignes réclamées mais JAMAIS démarrées
  // (sinon elles resteraient 'sending' avec une tentative brûlée jusqu'au reclaim périmé).
  if (i < ids.length) {
    const remaining = ids.slice(i);
    try {
      await db.release(remaining);
      log("released", { n: remaining.length });
    } catch (e) {
      log("error", { where: "release", error: (e as Error).message });
    }
  }
  return ids.length;
}

/**
 * S-6 — remplir la file, et seulement la remplir.
 *
 * ⛔ TROISIÈME TÂCHE, ET PAS UNE OPTION DES DEUX AUTRES. `plan` calcule des dates et gèle du
 * contenu sans jamais nommer `email_outbox` ; `drain` vide la file et ouvre Mailgun ; `enqueue`
 * écrit des lignes `pending` et n'ouvre rien. Les fondre aurait fait de la mise en file un effet de
 * bord possible d'un `WORKER_MODE=live` mal placé — trois processus, trois crons, trois pannes
 * indépendantes.
 *
 * ⚠️ CETTE TÂCHE N'ENVOIE RIEN — mais ce qu'elle écrit ne disparaît pas non plus. Une ligne
 * `pending` écrite pendant que le drain est en `dry-run` est IMMORTELLE (le drain lit sans
 * réclamer et ne mute rien), et `claim_outbox` n'a aucune borne d'âge : elle partirait au premier
 * passage en live, du plus vieux au plus récent. D'où la garde en tête de la fonction.
 */
async function runEnqueueTask(cfg: ReturnType<typeof parseWorkerEnv>): Promise<void> {
  // Même échappatoire que le matérialiseur : tout calculer, n'écrire aucune ligne. C'est ce qu'on
  // lance au premier passage en production, quand on veut VOIR ce qui serait mis en file.
  const simulate = fanoutSimule(process.env);

  /*
   * ⛔ GARDE — NE PAS REMPLIR UNE FILE QUE PERSONNE NE PEUT VIDER.
   *
   * `enqueue` était le seul chemin d'écriture réelle qui ne lisait PAS `WORKER_MODE`. En
   * `dry-run`, le drain lit sans jamais réclamer (`peekPending`) et ne mute aucune ligne : ce que
   * le fan-out écrit reste `pending` pour toujours. Trois conséquences, toutes silencieuses :
   *   1. la réconciliation ne conclut jamais (`pending > 0` ⇒ `still_sending`), l'occurrence reste
   *      `sending`, et `occurrence_one_in_flight_uk` fait échouer en 23505 la prise de TOUTES les
   *      éditions suivantes de la même campagne — la série meurt après la première ;
   *   2. sans destinataire envoyable, la cible est close en `failed` et sa campagne ponctuelle en
   *      `paused` ; `occurrence_campaign_local_date_uk` n'excluant que `cancelled`, ce jour-là est
   *      perdu DÉFINITIVEMENT — le matérialiseur retombera dessus en 23505 ;
   *   3. le stock s'accumule sans TTL ni purge.
   *
   * La sûreté ne peut donc pas reposer sur l'ABSENCE d'un cron `enqueue` : une absence n'est
   * visible nulle part et finit par être comblée. Elle est ici, au point d'étranglement — tant que
   * le drain ne peut pas envoyer, le fan-out ne remplit pas. `FANOUT_SIMULATE` reste la porte
   * d'essai (elle n'écrit aucune ligne), et le jour où `WORKER_MODE=live` est posé — le geste
   * humain — l'automatisation démarre d'elle-même, sans second réglage à ne pas oublier.
   *
   * ⚠️ Cette garde empêche le stock de SE CONSTITUER ; elle ne périme pas une ligne déjà en file.
   */
  // ⛔ Lu par `fanout-env.ts`, pas par `Number(x) || undefined` : ce motif avalait
  // `FANOUT_LEAD_MINUTES=0`, le seul réglage qui empêche un départ en avance.
  const { leadMinutes: lead, maxPerTarget: cap, maxLateMinutes: late } = optionsFanoutDepuisEnv(process.env);

  if (cfg.mode !== "live" && !simulate) {
    /*
     * ⛔ LE REFUS DIT CE QU'IL COÛTE (18/09/2026). Il ne journalisait qu'une ligne, dans un service
     * dont personne ne lit les journaux : la garde faisait son travail — ne pas remplir une file que
     * le drain ne peut pas vider — mais une campagne planifiée pour 20:45 ne partait pas, et RIEN
     * nulle part ne le disait. Ni l'admin (qui affiche « Scheduled »), ni Slack, ni la base : la
     * campagne n'est même pas LUE quand cette garde se ferme.
     *
     * ⚠️ L'ALERTE EST CONDITIONNÉE AU NOMBRE. Sans condition, un worker laissé en `dry-run` posterait
     * une alerte à chaque passe du cron — 48 par jour, qu'on apprendrait à ignorer en trois jours, et
     * le jour où elle compte elle serait noyée. On n'alerte que lorsqu'une cible était réellement due
     * à cette seconde : c'est l'envoi manqué qui parle, pas le réglage.
     *
     * ⚠️ Le comptage ne doit pas pouvoir faire échouer la tâche : une base injoignable rendrait le
     * refus plus bruyant qu'un envoi. En cas d'échec, on garde la ligne de journal et on se tait.
     */
    const dues = await compterCiblesDues(new FanoutDb(cfg), lead).catch(() => null);
    log("enqueue-refused", {
      reason: "drain_cannot_send",
      worker_mode: cfg.mode,
      due_targets: dues,
      hint: "FANOUT_SIMULATE=1 pour une passe a blanc, sans ecriture",
    });
    if (dues !== null && dues > 0) {
      await slackAlert(
        cfg.slackWebhookUrl,
        `nf-fanout: ${dues} cible(s) étaient DUES à l'instant et aucune ne partira — ce service est en ` +
          `WORKER_MODE=${cfg.mode}, donc le fan-out refuse de remplir une file que le drain ne peut pas vider. ` +
          `Les campagnes restent « Scheduled » à l'écran. Pose WORKER_MODE=live sur CE service (le réglage ` +
          `est par service, pas global) ou lance une passe à blanc avec FANOUT_SIMULATE=1.`,
      );
    }
    return;
  }

  /*
   * S-7 D'ABORD, S-6 ENSUITE — l'ordre n'est pas décoratif.
   *
   * Le fan-out prend sa cible en la passant à `sending` ; c'est la réconciliation qui l'en sort.
   * Réconcilier APRÈS aurait examiné des cibles que la même passe vient d'enfiler, dont la file est
   * encore intacte : rien à conclure, et un tour de retard à chaque fois. Réconcilier d'abord, c'est
   * clore ce que la passe PRÉCÉDENTE a fait partir, puis remplir pour la suivante.
   *
   * ⛔ Aucune des deux n'envoie : `runReconcile` lit des compteurs et écrit un statut, `runFanout`
   * écrit des lignes `pending`. L'envoi est la tâche `drain`, et elle exige `WORKER_MODE=live`.
   * La simulation vaut pour les deux : en `FANOUT_SIMULATE`, on ne clôt rien non plus, sans quoi on
   * modifierait l'état d'envois réels au cours d'un essai à blanc.
   */
  if (!simulate) {
    const rec = await runReconcile(new ReconcileDb(cfg));
    log("reconcile-done", {
      scanned: rec.scanned,
      closed: rec.closed,
      failed: rec.failed,
      still_sending: rec.stillSending,
      requeued: rec.requeued,
      errors: rec.errors.length,
    });
    for (const e of rec.errors) log("reconcile-error", { error: e });

    /*
     * Une cible close sans qu'un seul message ne parte est un ÉCHEC, pas une formalité : la série
     * ne doit pas considérer la semaine comme faite, et quelqu'un doit regarder pourquoi. Le
     * message dit lequel des trois compteurs porte la cause — délivrabilité (`failed`) ou
     * consentement (`skipped`) ne se règlent pas au même endroit.
     */
    for (const l of rec.lines) {
      if (l.status !== "failed") continue;
      await slackAlert(
        cfg.slackWebhookUrl,
        `nf-fanout: « ${l.campaignName} » s'est terminée SANS AUCUN envoi — ${l.tally.failed} échec(s), ` +
          `${l.tally.skipped} écarté(s) par le gate de conformité sur ${l.tally.total} ligne(s).` +
          (l.tally.skipped > l.tally.failed
            ? ` Le ciblage a visé des abonnés qui n'ont pas accordé cette finalité : c'est le segment ou la finalité qu'il faut revoir, pas la délivrabilité.`
            : ""),
      );
    }
  }

  const db = new FanoutDb(cfg);
  const report = await runFanout(db, { simulate, leadMinutes: lead, maxPerTarget: cap, maxLateMinutes: late });

  log("fanout-done", {
    simulate,
    scanned: report.targetsScanned,
    enqueued: report.targetsEnqueued,
    rows: report.rowsQueued,
    held: report.held.length,
    errors: report.errors.length,
  });

  for (const e of report.errors) log("fanout-error", { error: e });

  await alerterRapportFanout(cfg, report);
}

/**
 * Les alertes d'une passe de fan-out — partagées par la tâche `enqueue` et par le fan-out immédiat
 * du drain résident. Une cible retenue par l'un ne repasse pas par l'autre (elle est en pause) : si
 * un seul des deux alertait, la moitié des refus ne se verraient nulle part.
 */
async function alerterRapportFanout(
  cfg: ReturnType<typeof parseWorkerEnv>,
  report: Awaited<ReturnType<typeof runFanout>>,
): Promise<void> {
  /*
   * ⛔ UNE ERREUR DE MISE EN FILE NE SE VOYAIT NULLE PART SAUF DANS CES JOURNAUX (18/09/2026). Une
   * cible qui explose est rendue à `scheduled` et reprise à la passe suivante — c'est voulu, une
   * coupure réseau ne doit pas annuler un envoi. Mais si la cause PERSISTE (une règle de segment
   * qui fait échouer PostgREST, une RPC absente), la boucle est infinie : la campagne rebondit
   * entre `scheduled` et `sending` pour toujours, et l'écran répète « Scheduled ».
   *
   * Une alerte groupée, et pas une par cible : une base injoignable les fait toutes échouer en même
   * temps, et cent messages disent moins bien la même chose qu'un seul.
   */
  if (report.errors.length > 0) {
    await slackAlert(
      cfg.slackWebhookUrl,
      `nf-fanout: ${report.errors.length} cible(s) en ERREUR pendant la mise en file — rien n'est parti pour ` +
        `elles. Elles repassent « Scheduled » et seront reprises à la passe suivante ; si la cause persiste, ` +
        `la reprise est une boucle sans fin. Raison(s) : ${report.errors.slice(0, 3).join(" · ")}` +
        (report.errors.length > 3 ? ` (+${report.errors.length - 3} autre(s))` : ""),
    );
  }

  /*
   * Une cible RETENUE ne se débloque pas toute seule. Sans alerte, la collègue découvre le lundi
   * que rien n'est parti vendredi, et personne ne sait depuis quand. L'alerte porte la raison ET
   * le geste — un plafond dépassé se règle en corrigeant le segment, pas en relançant le worker.
   */
  for (const h of report.held) {
    await slackAlert(
      cfg.slackWebhookUrl,
      `nf-fanout: « ${h.campaignName} » n'a PAS été mise en file (${h.reason}). Rien n'est parti. ` +
        (h.occurrenceId ? `Occurrence ${h.occurrenceId}. ` : "") +
        `Corrige la cause puis republie ou replanifie — le worker ne réessaiera pas tout seul.`,
    );
  }

  /*
   * L'ÉCART entre ce que l'admin avait annoncé et ce qui est réellement en file. Il est NORMAL
   * qu'il existe (des gens se sont désinscrits depuis la planification) ; il est anormal qu'il soit
   * gros ou qu'il vaille tout. On le dit à partir de 10 % : en dessous c'est la vie d'une base
   * d'abonnés, au-dessus c'est un segment ou un consentement qui a bougé.
   */
  for (const t of report.targets) {
    if (t.planned === null || t.planned === 0 || t.skipped || t.held) continue;
    const gap = Math.abs(t.planned - t.inQueue) / t.planned;
    if (gap >= 0.1) {
      await slackAlert(
        cfg.slackWebhookUrl,
        `nf-fanout: « ${t.campaignName} » — ${t.inQueue} destinataires en file pour ${t.planned} annoncés à la planification.`,
      );
    }
  }
}

async function runPlanTask(cfg: ReturnType<typeof parseWorkerEnv>): Promise<void> {
  // `PLANNER_SIMULATE=1` : tout calculer, tout journaliser, n'écrire aucune ligne. Sert au premier
  // passage en production, quand on veut voir ce qui SERAIT créé avant de le laisser créer.
  const simulate = ["1", "true", "yes"].includes((process.env.PLANNER_SIMULATE ?? "").toLowerCase());
  const planner = new PlannerDb(cfg);
  const report = await runPlanner(planner, { simulate });

  log("planner-done", {
    simulate,
    plans: report.plansScanned,
    created: report.occurrencesCreated,
    already_there: report.occurrencesSkippedExisting,
    frozen: report.frozen,
    held: report.held,
    duplicates_held: report.duplicatesHeld.length,
    errors: report.errors.length,
    // ⛔ L'invariant, relu en base. Voir PlannerReport.
    outbox_rows_with_occurrence: report.outboxRowsWithOccurrence,
    // Les éditions que plus rien ne fera partir. Voir PlannerReport.occurrencesMissed.
    missed: report.occurrencesMissed,
  });

  for (const e of report.errors) log("planner-error", { error: e });

  /*
   * UNE ÉDITION MANQUÉE DOIT SORTIR DU JOURNAL, comme un doublon retenu.
   *
   * Le gel ne rattrape pas une occurrence dont l'heure est passée — c'est voulu, on n'envoie pas
   * en retard. Mais jusqu'ici l'édition disparaissait sans un mot : ni erreur, ni `held`, ni
   * raison. La cause la plus banale est un cron `plan` qui n'a pas tourné assez souvent : la
   * fenêtre utile ne dure que `freeze_lead_minutes` (90 min par défaut), et qui la rate la rate
   * DÉFINITIVEMENT. L'alerte dit le nombre et le geste à faire.
   *
   * ⚠️ On alerte sur un SEUIL de 0 assumé : une seule édition perdue est déjà un incident. Le
   * silence de cette ligne est la preuve que la cadence du cron tient.
   */
  if (report.occurrencesMissed > 0) {
    await slackAlert(
      cfg.slackWebhookUrl,
      `nf-planner: ${report.occurrencesMissed} édition(s) restée(s) « planned » après leur heure — ` +
        `elles ne partiront jamais et le gel ne les rattrapera pas. Vérifier que le cron « plan » ` +
        `tourne bien plus souvent que le délai de gel de ces campagnes, puis replanifier à la main.`,
    );
  }

  /*
   * S-5 — un doublon retenu doit SORTIR du journal.
   *
   * Une occurrence bloquée ne se débloque pas toute seule : tant que personne ne republie ou ne
   * clique « envoyer quand même », la série s'arrête. Sans alerte, la collègue le découvre le
   * lundi en constatant que la newsletter de vendredi n'est jamais partie — et personne ne saura
   * dire depuis quand ça dure. L'alerte porte la raison ET le geste à faire.
   */
  for (const d of report.duplicatesHeld) {
    await slackAlert(
      cfg.slackWebhookUrl,
      `nf-planner: « ${d.campaignName} » — l'édition à venir est identique à celle du ${d.previous}. ` +
        `Elle est RETENUE (rien n'est parti). Republie le modèle, ou autorise l'envoi depuis l'écran de campagne. ` +
        `Occurrence ${d.occurrenceId}.`,
    );
  }

  // Un email rattaché à une occurrence alors que le fan-out (S-6) n'existe pas est une anomalie
  // grave : quelque chose écrit dans la file d'envoi par un chemin que personne n'a prévu.
  if (report.outboxRowsWithOccurrence > 0) {
    await slackAlert(
      cfg.slackWebhookUrl,
      `nf-planner: ${report.outboxRowsWithOccurrence} ligne(s) email_outbox portent une occurrence alors que le fan-out n'est pas livré`,
    );
  }

  await runReactivationPass(cfg, simulate);
  await runAutomationsPass(cfg, simulate);
}

/**
 * Sortir du sunset ceux qui ont réagi APRÈS leur marque (`reactivate_sunset`, 0058) — à chaque passe
 * de `plan`, puisque la tâche `lifecycle` qui le faisait n'a jamais eu de cron.
 *
 * ⛔ AVANT LE MOTEUR : un revenant redevient joignable dès cette passe, au lieu de rester exclu une
 * passe de plus (même raison que l'ancien ordre de `runLifecycle`).
 * ⛔ UNE PANNE ICI NE FAIT ÉCHOUER NI `plan` NI LE MOTEUR : journal et alerte, puis on continue — elle
 * reprendra au passage suivant, et un sunset maintenu une passe de trop n'envoie rien à personne.
 */
async function runReactivationPass(cfg: ReturnType<typeof parseWorkerEnv>, simulate: boolean): Promise<void> {
  try {
    await reactiverRevenants(new LifecycleDb(cfg), null, simulate);
  } catch (e) {
    log("sunset-reactivation-error", { error: (e as Error).message });
    await slackAlert(cfg.slackWebhookUrl, `nf-planner: réactivation des sunsets échouée: ${(e as Error).message}`);
  }
}

/**
 * Les automations (0082), APRÈS le gel des campagnes — dans la tâche `plan`, pas dans une horloge à
 * elles (voir `automations/engine.ts`).
 *
 * ⛔ UNE PANNE DES AUTOMATIONS NE FAIT PAS ÉCHOUER LA TÂCHE `plan` : elle est journalisée et alertée
 * ici, puis la tâche se termine normalement. Le gel des campagnes a déjà eu lieu ; le rejouer à
 * cause d'une automation serait pire que l'automation manquée, qui reprendra au passage suivant.
 * ⚠️ Si le gel lève, cette passe ne tourne pas : elle reprendra au passage suivant de `plan`.
 */
async function runAutomationsPass(cfg: ReturnType<typeof parseWorkerEnv>, simulate: boolean): Promise<void> {
  try {
    const r = await runAutomations(new AutomationDb(cfg), {
      workerLive: cfg.mode === "live",
      allowlist: [...cfg.allowlist],
      confirmBaseUrl: cfg.publicBaseUrl,
      probe: simulate,
    });
    log("automations-done", { simulate, ...resumeAutomations(r) });
    // 0082 pas encore appliquée : journal seul — le worker est déployé AVANT la migration.
    if (r.notInstalled) return;
    for (const f of r.failures) log("automations-error", { error: f });
    if (r.invalid.length > 0) {
      await slackAlert(
        cfg.slackWebhookUrl,
        `nf-automations: ${r.invalid.length} automation(s) armée(s) écartée(s) parce qu'invalide(s) — elles ne tournent pas : ` +
          r.invalid.slice(0, 5).join(" | "),
      );
    }
    if (r.failures.length > 0) {
      await slackAlert(
        cfg.slackWebhookUrl,
        `nf-automations: ${r.failures.length} étape(s) en erreur — ` + r.failures.slice(0, 5).join(" | "),
      );
    }
  } catch (e) {
    log("automations-error", { error: (e as Error).message });
    await slackAlert(cfg.slackWebhookUrl, `nf-automations: passe échouée: ${(e as Error).message}`);
  }
}

/**
 * La passe d'engagement.
 *
 * ⛔ CETTE TÂCHE N'OUVRE NI `Db` NI `Mailgun`. Elle est placée AVANT eux dans `main()` pour cette
 * seule raison : instancier le client d'envoi pour un job qui ne fait que lire des événements et
 * écrire des colonnes de `subscription`, ce serait donner à un calcul de statistiques la capacité
 * d'envoyer un e-mail. Elle sort par `return`, comme `plan` et `enqueue`.
 */
async function runEngagementTask(cfg: ReturnType<typeof parseWorkerEnv>): Promise<void> {
  // `ENGAGEMENT_DRY_RUN=1` : recalculer et compter, n'écrire aucune colonne. C'est ainsi qu'on
  // vérifiera la passe le jour du premier envoi réel — les compteurs rendus sont EXACTEMENT ceux du
  // mode réel (voir 0056, `p_dry_run`).
  const dryRun = ["1", "true", "yes"].includes((process.env.ENGAGEMENT_DRY_RUN ?? "").toLowerCase());
  // Optionnel : restreindre à une marque. Vide = toutes. Une valeur illégale fait échouer la RPC
  // bruyamment, ce qui est le comportement voulu — un périmètre silencieusement ignoré recalculerait
  // toute la base en croyant n'en toucher qu'une part.
  const assetId = (process.env.ENGAGEMENT_ASSET_ID ?? "").trim() || null;

  const report = await runEngagement(new EngagementDb(cfg), { assetId, dryRun });

  if (engagementNeedsAlert(report)) {
    await slackAlert(
      cfg.slackWebhookUrl,
      `nf-engagement: ${report.sentEmails} e-mail(s) envoyé(s) et AUCUN des ${report.scanned} abonnements ` +
        `n'a le moindre événement. Les retours Mailgun ne se rattachent à personne : vérifier que le webhook ` +
        `est bien configuré et que \`provider_message_id\` est renseigné dans email_outbox. ` +
        `Tant que ça dure, l'engagement affiché vaut zéro pour tout le monde.`,
    );
  }
}

/**
 * La passe de cycle de vie : réactiver les revenants, mesurer les vagues déjà parties. ⛔ ELLE
 * N'ENFILE PLUS (voir `lifecycle.ts`) : la relance des inactifs est l'automation « Re-engagement ».
 *
 * ⛔ COMME `plan` ET `engagement`, ELLE SORT AVANT `new Db(cfg)`.
 */
async function runLifecycleTask(cfg: ReturnType<typeof parseWorkerEnv>): Promise<void> {
  // ⛔ `LIFECYCLE_ENABLED` N'ARME PLUS RIEN. On la signale pour que celui qui la pose sache
  // qu'elle est ignorée, au lieu de croire qu'une relance part.
  if ((process.env.LIFECYCLE_ENABLED ?? "").trim() !== "") {
    log("lifecycle-enabled-ignored", {
      reason: "the re-engagement wave moved to the automation engine (Automations > Re-engagement); nothing is enqueued here",
    });
  }
  const assetId = (process.env.LIFECYCLE_ASSET_ID ?? "").trim() || null;

  const report = await runLifecycle(new LifecycleDb(cfg), { assetId });

  if (lifecycleNeedsAlert(report)) {
    await slackAlert(
      cfg.slackWebhookUrl,
      `nf-lifecycle: la relance COÛTE plus qu'elle ne rapporte sur ${report.costlyAssets.join(", ")} — ` +
        `${report.unsubscribed + report.complained} refus (désabonnements + plaintes) pour ` +
        `${report.responded} réaction(s), sur ${report.delivered} e-mail(s) réellement remis` +
        (report.orphanEvents > 0
          ? `. ⚠️ ${report.orphanEvents} événement(s) sans origine rattachable : ces chiffres sont des PLANCHERS`
          : "") +
        `. Décision produit, pas incident technique : réduire la portée, réécrire le message, ou arrêter la séquence.`,
    );
  }
}

async function main() {
  const cfg = parseWorkerEnv();
  const task = parseTask();

  if (task === "enqueue") {
    log("boot", { task: "enqueue", mode: cfg.mode });
    try {
      await runEnqueueTask(cfg);
    } catch (e) {
      log("error", { where: "fanout", error: (e as Error).message });
      await slackAlert(cfg.slackWebhookUrl, `nf-fanout: passe échouée: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (task === "plan") {
    log("boot", { task: "plan", mode: cfg.mode });
    try {
      await runPlanTask(cfg);
    } catch (e) {
      log("error", { where: "planner", error: (e as Error).message });
      await slackAlert(cfg.slackWebhookUrl, `nf-planner: passe échouée: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (task === "engagement") {
    log("boot", { task: "engagement", mode: cfg.mode });
    try {
      await runEngagementTask(cfg);
    } catch (e) {
      log("error", { where: "engagement", error: (e as Error).message });
      await slackAlert(cfg.slackWebhookUrl, `nf-engagement: passe échouée: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (task === "lifecycle") {
    log("boot", { task: "lifecycle", mode: cfg.mode });
    try {
      await runLifecycleTask(cfg);
    } catch (e) {
      log("error", { where: "lifecycle", error: (e as Error).message });
      await slackAlert(cfg.slackWebhookUrl, `nf-lifecycle: passe échouée: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  const db = new Db(cfg);
  const mailgun = new Mailgun(cfg);

  const onSignal = (sig: string) => {
    log("shutdown", { signal: sig });
    stopping = true;
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  log("boot", {
    mode: cfg.mode,
    sending: cfg.sendingMode,
    run_once: cfg.runOnce,
    batch: cfg.batchSize,
    allowlist_size: cfg.allowlist.size,
    // Le témoin de la mise en production : `true` = tout destinataire reçoit. Jamais le contenu de
    // la liste (des adresses) dans le journal.
    allowlist_ouverte: cfg.allowlist.has(ALLOWLIST_OUVERTE),
    one_click: cfg.oneClick,
    worker_id: cfg.workerId,
  });

  if (cfg.mode === "dry-run") {
    const n = await dryRunOnce(db, cfg, mailgun);
    log("done", { mode: "dry-run", previewed: n });
    return;
  }

  if (cfg.runOnce) {
    try {
      let total = 0;
      let n = 0;
      do {
        /*
         * ⛔ LA VANNE DU PASSAGE. Cette boucle rappelait la réclamation TANT QU'ELLE RENDAIT DES
         * LIGNES — `do { … } while (n > 0)`. `BATCH_SIZE` dimensionnait un lot, pas un passage :
         * dix lignes par lot, mille lots, dix mille envois dans le MÊME tick de cron, et personne
         * ne pouvait s'interposer entre le premier et le dernier. Le plafond arrête le passage ; ce
         * qui reste attend le tick suivant. Décision d'Alix du 15/09/2026 — voir `debit.ts`.
         */
        const aReclamer = lignesAReclamer(total, cfg.batchSize, cfg.maxPerRun);
        if (aReclamer === 0) {
          log("plafond-atteint", {
            mode: "live",
            reclamees: total,
            max_per_run: cfg.maxPerRun,
            hint: "le reste part au prochain passage — jamais toute la file en un tick",
          });
          break;
        }
        n = await drainOnceLive(db, cfg, mailgun, aReclamer);
        total += n;
      } while (n > 0 && !stopping);
      log("done", { mode: "live", drained: total });
    } catch (e) {
      log("error", { where: "drain-once", error: (e as Error).message });
      await slackAlert(cfg.slackWebhookUrl, `nf-worker: drain (once) échoué: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  /*
   * ⭐ SERVICE RÉSIDENT — L'ENVOI IMMÉDIAT (22/09/2026, « jveux que ce soit instant si besoin »).
   *
   * Toutes les `POLL_INTERVAL_MS` (5 s par défaut), deux gestes, dans cet ordre :
   *   1. mettre en file ce qui est dû MAINTENANT — une campagne « Send now », ou une date arrivée.
   *      Avance forcée à zéro (`optionsFanoutInstantane`) : rien n'est pris avant son heure ;
   *   2. vider la file, sous le plafond de débit.
   * Un « Send now » part donc en quelques secondes, et une campagne datée à son heure, pas un tick
   * de cron plus tard.
   *
   * ⛔ LE FAN-OUT ENTRE DANS LE PROCESSUS DU DRAIN, ET C'EST LE SEUL ENDROIT OÙ IL LE PEUT. La tâche
   * `enqueue` refuse de remplir une file que le drain ne peut pas vider ; ici, c'est le drain
   * lui-même qui remplit, et seulement en `live` (le `dry-run` est sorti plus haut). La tâche
   * `enqueue` garde tout le reste : la réconciliation des statuts et les campagnes que ce chemin
   * n'aurait pas vues.
   *
   * ⛔ LE PLAFOND VAUT ICI PAR FENÊTRE DE CINQ MINUTES, PAS SUR LA VIE DU PROCESSUS (`debit.ts`) :
   * même débit maximal que le cron de drain qu'il remplace. Atteint, le drain ATTEND la fenêtre
   * suivante — exactement ce que faisait le cron entre deux ticks.
   *
   * ⛔⛔ UN SEUL DRAIN. Ce service REMPLACE le cron de drain ; les deux ensemble réclameraient la même
   * file, et la reprise d'un verrou périmé ne compare pas `locked_by` (0057) — un envoi en vol trop
   * long partirait deux fois.
   */
  const fanoutDb = new FanoutDb(cfg);
  const instantane = optionsFanoutInstantane(process.env);
  log("resident", { instant_fanout: instantane !== null, poll_ms: cfg.pollIntervalMs, window_ms: FENETRE_DEBIT_MS });

  let fenetre: FenetreDebit | null = null;
  let plafondDitPour: number | null = null;
  let prochainFanout = 0;
  let fenetreInteractifs: FenetreDebit | null = null;
  let plafondInteractifsDitPour: number | null = null;
  let erreurInteractifsDitePour: number | null = null;

  while (!stopping) {
    if (instantane && Date.now() >= prochainFanout) {
      prochainFanout = Date.now() + cfg.pollIntervalMs;
      try {
        const report = await runFanout(fanoutDb, { ...instantane });
        if (report.targetsScanned > 0) {
          log("fanout-instant", {
            scanned: report.targetsScanned,
            enqueued: report.targetsEnqueued,
            rows: report.rowsQueued,
            held: report.held.length,
            errors: report.errors.length,
          });
        }
        for (const e of report.errors) log("fanout-error", { error: e, mode: "instant" });
        await alerterRapportFanout(cfg, report);
        // Une cible en erreur est rendue à `scheduled` : la reprendre toutes les cinq secondes
        // noierait Slack. On laisse passer une fenêtre ; le cron `enqueue` réessaie aussi.
        if (report.errors.length > 0) prochainFanout = Date.now() + FENETRE_DEBIT_MS;
      } catch (e) {
        log("error", { where: "fanout-instant", error: (e as Error).message });
        await slackAlert(cfg.slackWebhookUrl, `nf-fanout: passe immédiate échouée: ${(e as Error).message}`);
        prochainFanout = Date.now() + FENETRE_DEBIT_MS;
      }
    }

    /*
     * ⭐ LES E-MAILS INTERACTIFS D'ABORD, HORS DU PLAFOND DES NEWSLETTERS (22/09/2026, Alix : « tout
     * les mails de type welcome etc soit instant les 5min d'attente ca doit etre que pour les
     * newsletter »). Confirmation, bienvenue, accusé, test : un geste humain attend la réponse.
     *
     * ⛔ LEUR PLAFOND EST À PART ET N'ENTRE PAS DANS `fenetre`. Compté dans la fenêtre des
     * newsletters, une confirmation attendrait de nouveau la fin d'une campagne ; compter les
     * newsletters ici ferait l'inverse. Deux fenêtres, deux compteurs (voir `debit.ts`).
     *
     * ⚠️ UNE PANNE DE CETTE PASSE NE BLOQUE RIEN : la passe suivante (`claim_outbox`) prend aussi les
     * interactifs, en tête. On retombe sur le délai d'avant, et on le dit une fois par fenêtre.
     */
    let nInteractifs = 0;
    try {
      fenetreInteractifs = fenetreCourante(fenetreInteractifs, Date.now(), FENETRE_DEBIT_MS);
      const aReclamerInteractifs = lignesAReclamer(
        fenetreInteractifs.reclamees,
        cfg.batchSize,
        cfg.maxInteractivePerWindow,
      );
      if (aReclamerInteractifs === 0) {
        if (plafondInteractifsDitPour !== fenetreInteractifs.debut) {
          plafondInteractifsDitPour = fenetreInteractifs.debut;
          log("plafond-atteint", {
            mode: "live-loop-interactifs",
            reclamees: fenetreInteractifs.reclamees,
            max_per_window: cfg.maxInteractivePerWindow,
            hint: "rafale d'inscriptions : le reste part a la fenetre suivante",
          });
          await slackAlert(
            cfg.slackWebhookUrl,
            `nf-worker: ${fenetreInteractifs.reclamees} e-mails interactifs en 5 min — plafond atteint (rafale d'inscriptions ?)`,
          );
        }
      } else {
        nInteractifs = await drainOnceLive(db, cfg, mailgun, aReclamerInteractifs, "interactifs");
        fenetreInteractifs = {
          debut: fenetreInteractifs.debut,
          reclamees: fenetreInteractifs.reclamees + nInteractifs,
        };
      }
    } catch (e) {
      const debut = fenetreInteractifs?.debut ?? null;
      if (erreurInteractifsDitePour !== debut) {
        erreurInteractifsDitePour = debut;
        log("error", { where: "drain-interactifs", error: (e as Error).message });
        await slackAlert(cfg.slackWebhookUrl, `nf-worker: passe interactifs échouée (repli sur la file commune): ${(e as Error).message}`);
      }
    }

    try {
      fenetre = fenetreCourante(fenetre, Date.now(), FENETRE_DEBIT_MS);
      const aReclamer = lignesAReclamer(fenetre.reclamees, cfg.batchSize, cfg.maxPerRun);
      if (aReclamer === 0) {
        // Une ligne de journal par fenêtre pleine, pas une toutes les cinq secondes.
        if (plafondDitPour !== fenetre.debut) {
          plafondDitPour = fenetre.debut;
          log("plafond-atteint", {
            mode: "live-loop",
            reclamees: fenetre.reclamees,
            max_per_run: cfg.maxPerRun,
            hint: "le reste part a la fenetre suivante — jamais toute la file d'un coup",
          });
        }
        await sleep(cfg.pollIntervalMs);
        continue;
      }
      const n = await drainOnceLive(db, cfg, mailgun, aReclamer);
      fenetre = { debut: fenetre.debut, reclamees: fenetre.reclamees + n };
      if (n === 0 && nInteractifs === 0) await sleep(cfg.pollIntervalMs);
    } catch (e) {
      log("error", { where: "drain-loop", error: (e as Error).message });
      await slackAlert(cfg.slackWebhookUrl, `nf-worker: drain échoué (retry): ${(e as Error).message}`);
      await sleep(cfg.pollIntervalMs);
    }
  }
  log("done", { mode: "live-loop" });
}

main().catch((e) => {
  log("fatal", { error: (e as Error).message });
  process.exit(1);
});
