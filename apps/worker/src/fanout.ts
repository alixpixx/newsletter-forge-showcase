/**
 * ---------------------------------------------------------------------------
 * S-6 — Le fan-out : l'audience devient des lignes de file, et rien de plus.
 * ---------------------------------------------------------------------------
 *
 * CE QUE CE FICHIER FAIT : pour chaque occurrence gelée (ou campagne simple planifiée) dont
 * l'heure approche, il énumère l'audience et écrit une ligne `pending` par abonnement.
 * CE QU'IL NE FAIT PAS : envoyer. Aucune ligne n'est marquée `sent`, Mailgun n'est jamais ouvert,
 * `WORKER_MODE` n'est même pas lu ici. Remplir la file et la vider sont deux tâches, deux crons.
 *
 * ⛔ POURQUOI CÔTÉ WORKER ET PAS À LA PLANIFICATION. Deux raisons opposées se rejoignent :
 *  — la règle du projet interdit toute écriture dans `email_outbox` depuis un chemin d'admin ou de
 *    planification : c'est ce qui garantit qu'un clic dans l'interface ne peut pas mettre 4 000
 *    e-mails en file par accident ;
 *  — et une audience calculée trois semaines à l'avance serait fausse le jour de l'envoi : des gens
 *    se sont désinscrits, d'autres se sont inscrits. La file se remplit peu avant l'heure.
 *
 * ⛔ LA FRAÎCHEUR EST PORTÉE PAR L'OCCURRENCE. Le sujet et le contenu servis viennent de
 * l'occurrence, pas de la campagne : c'est le seul moyen qu'une série hebdomadaire n'envoie pas
 * huit fois les articles de la semaine 1. La résolution est faite en SQL par
 * `enqueue_campaign_batch` (0038) et le rendu la respecte (`render.ts`).
 */
import { compileRule, type Population, type RuleNode } from "@nf/segments";
import { legalBasisForRegime, purposeGateFilter, type ConsentPurpose } from "@nf/config";
import type { FanoutDb, FanoutTarget } from "./fanout-db";
import { log } from "./log";

/**
 * Fenêtre d'avance : on enfile une cible dont l'heure d'envoi tombe dans les N minutes.
 *
 * ⛔ ZÉRO DEPUIS LE 22/09/2026 — ET LES 20 MINUTES D'AVANT FAISAIENT PARTIR EN AVANCE. Elles
 * supposaient que les lignes enfilées attendaient l'heure dite. Elles n'attendent pas :
 * `enqueue_campaign_batch` (0038) ne pose pas `next_attempt_at`, qui vaut donc `now()`, et
 * `claim_outbox` réclame tout `next_attempt_at <= now()`. Une campagne de 20:00 enfilée à 19:40
 * partait à 19:40 (mesuré : la ligne de « Test 6 » est partie 30 s après sa mise en file). Avec un
 * fan-out toutes les cinq minutes, l'avance serait devenue systématique.
 *
 * À zéro, une cible n'est prise qu'une fois son heure ARRIVÉE : le drain résident la prend dans
 * les secondes qui suivent, le cron au plus un tick plus tard. En retard de quelques secondes plutôt
 * qu'en avance de vingt minutes — une newsletter annoncée pour 20:00 ne doit pas arriver à 19:40.
 */
export const DEFAULT_LEAD_MINUTES = 0;
/** Taille d'un lot d'insertion. Assez grand pour limiter les allers-retours, assez petit pour
 *  qu'un crash ne perde qu'un lot — et l'idempotence rend le rejeu sans conséquence. */
export const BATCH_SIZE = 500;
/**
 * Plafond par cible et par passe. ⛔ Ce n'est pas une optimisation : c'est le garde-fou qui
 * transforme une règle de segment devenue folle (ou un `unsupported` mal interprété) en ALERTE
 * plutôt qu'en 200 000 e-mails. Au-delà, la cible est RETENUE et un humain tranche.
 */
export const DEFAULT_MAX_PER_TARGET = 20_000;
/**
 * ⛔ LA BORNE BASSE, ET ELLE COMPTE AUTANT QUE LA HAUTE. Une cible dont l'heure est passée depuis
 * longtemps est DUE au sens de la requête — et l'enfiler la ferait partir maintenant, des jours
 * après la date annoncée. Constaté sur cette base : une campagne planifiée pour le 22/08 dormait
 * encore en `scheduled` le 25/08 ; sans borne, la première passe de fan-out l'expédiait. Un envoi
 * en retard de trois jours n'est pas un rattrapage, c'est une surprise — pour le lecteur comme
 * pour celui qui l'avait planifié. Au-delà, on ne touche à rien et on le DIT.
 */
export const DEFAULT_MAX_LATE_MINUTES = 180;

export interface FanoutOptions {
  now?: Date;
  leadMinutes?: number;
  maxLateMinutes?: number;
  batchSize?: number;
  maxPerTarget?: number;
  /** Tout calculer, tout journaliser, n'écrire AUCUNE ligne. */
  simulate?: boolean;
}

export interface FanoutTargetReport {
  campaignId: string;
  occurrenceId: string | null;
  campaignName: string;
  /** Ce que l'admin avait annoncé à la planification. */
  planned: number | null;
  /** Ce que la passe a réellement mis en file (0 en simulation). */
  queued: number;
  /** Ce que la base contient pour cette cible APRÈS la passe — la seule mesure qui fait foi. */
  inQueue: number;
  /** Prédicats de segment que le compilateur ne sait pas évaluer : comptés, jamais tus. */
  unsupported: string[];
  skipped?: string;
  held?: string;
}

export interface FanoutReport {
  targetsScanned: number;
  targetsEnqueued: number;
  rowsQueued: number;
  held: { campaignName: string; occurrenceId: string | null; reason: string }[];
  errors: string[];
  targets: FanoutTargetReport[];
}

/**
 * Une cible sans finalité ne doit jamais entrer en file : le gate d'envoi n'aurait rien à comparer.
 *
 * ⛔ LE SEGMENT N'EST PAS DANS CETTE LISTE, ET C'EST DÉLIBÉRÉ. Une campagne sans segment vise toute
 * la marque ; l'écarter ici la faisait échouer FERMÉE et sans bruit — la campagne restait
 * `scheduled`, était re-sautée à chaque passe, et rien hors des journaux du worker ne le disait.
 * Or la base produit déjà des `segment_id` nuls toute seule : la FK est `on delete set null`, donc
 * supprimer un segment suffisait à condamner silencieusement les campagnes qui s'en servaient.
 *
 * ⚠️ Ce qui protège l'audience n'a jamais été ce test : c'est la vue `sendable_subscription` et le
 * gate de finalité juste en dessous, tous deux appliqués indépendamment du ciblage.
 */
function preflight(t: FanoutTarget, now: Date, maxLateMinutes: number): string | null {
  if (!t.purpose) return "no_purpose";
  if (!t.assetId) return "no_asset";
  if (t.scheduledAt) {
    const lateMinutes = (now.getTime() - new Date(t.scheduledAt).getTime()) / 60_000;
    if (lateMinutes > maxLateMinutes) return `too_late:${Math.round(lateMinutes)}min`;
  }
  return null;
}

/**
 * ⭐ UN REFUS S'ÉCRIT POUR LES DEUX FORMES DE CIBLE — série ET campagne ponctuelle.
 *
 * ⛔ LE DÉFAUT QUE CETTE FONCTION EFFACE (18/09/2026). Les trois refus du fan-out écrivaient chacun
 * leur trace derrière un `if (t.occurrenceId …)`. Une occurrence de série écartée passait donc
 * `held` avec sa raison ; une campagne PONCTUELLE écartée, elle, ne laissait qu'une ligne de journal
 * du worker — pas une ligne en base, pas un changement de statut, rien à l'écran. Elle restait
 * `scheduled` pour toujours et était re-écartée à chaque passe. C'est ce qu'Alix a vu : « quand je
 * schedule one send ça ne s'envoie pas », sur une campagne que l'admin annonçait « Scheduled ».
 *
 * Trois copies de la même asymétrie, c'est trois occasions de la réintroduire : il n'y a plus qu'un
 * seul chemin de refus, et il traite les deux formes.
 *
 * ⚠️ `already_claimed` N'ARRIVE PAS ICI, et c'est délibéré : c'est le seul refus TRANSITOIRE (une
 * autre passe a pris la cible et va l'enfiler). Mettre cette campagne en pause casserait un envoi
 * qui part très bien.
 */
async function retenir(
  db: FanoutDb,
  t: FanoutTarget,
  simulate: boolean,
  report: FanoutReport,
  line: FanoutTargetReport,
  /** La raison COMPLÈTE : elle va au journal, en base et dans le rapport. */
  raison: string,
  /** Le libellé court du rapport de ligne, quand la raison porte un détail (`widened:tag:x`). */
  court: string = raison,
): Promise<void> {
  line.skipped = court;
  // ⛔ UNE CIBLE ÉCARTÉE DOIT SE VOIR. Sans cette ligne, la seule trace d'un refus est un compteur
  // agrégé : la campagne n'est pas partie, le journal n'en parle pas, et on cherche du côté du
  // segment. Le refus se journalise là où il est décidé, avec sa raison.
  log("fanout-skip", {
    campaign: t.campaignName,
    occurrence: t.occurrenceId,
    reason: raison,
    scheduled_at: t.scheduledAt,
  });
  // Une cible incomplète ne se répare pas toute seule : elle est RETENUE avec sa raison, sinon elle
  // serait retentée à chaque passe et échouerait à chaque passe, en silence.
  if (!simulate) {
    if (t.occurrenceId) await db.holdOccurrence(t.occurrenceId, `fanout:${raison}`);
    else await db.holdCampaign(t, raison);
  }
  report.held.push({ campaignName: t.campaignName, occurrenceId: t.occurrenceId, reason: raison });
}

async function fanoutOne(
  db: FanoutDb,
  t: FanoutTarget,
  opts: Required<Pick<FanoutOptions, "batchSize" | "maxPerTarget" | "simulate" | "maxLateMinutes">> & { now: Date },
  report: FanoutReport,
): Promise<void> {
  const line: FanoutTargetReport = {
    campaignId: t.campaignId,
    occurrenceId: t.occurrenceId,
    campaignName: t.campaignName,
    planned: t.recipientsPlanned,
    queued: 0,
    inQueue: 0,
    unsupported: [],
  };
  report.targets.push(line);

  const missing = preflight(t, opts.now, opts.maxLateMinutes);
  if (missing) {
    await retenir(db, t, opts.simulate, report, line, missing);
    return;
  }

  /*
   * ⛔ JAMAIS UNE ÉDITION RELUE AVANT SA RECONSTRUCTION (0079).
   *
   * Un humain a relu cette édition (article caché ou corrigé, sujet, introduction) et le worker ne l'a
   * pas encore reconstruite : le shell en base est celui d'AVANT la relecture. L'enfiler enverrait
   * exactement ce que la relecture a refusé — l'article caché, le titre fautif — à toute l'audience.
   *
   * ⚠️ UN SAUT, PAS UNE RÉTENTION. Contrairement aux refus ci-dessus, cet état se répare tout seul : la
   * passe `plan` suivante reconstruit l'édition (ou écrit pourquoi elle ne le peut pas, à l'écran de
   * relecture), et le fan-out d'après la prend. La retenir la condamnerait — une édition `held` ne se
   * relâche plus. Au pire, elle part quelques minutes après son heure ; la borne `too_late` ci-dessus
   * reste le filet si la relecture n'est jamais corrigée.
   */
  if (t.reviewPending === true) {
    line.skipped = "review_pending";
    log("fanout-skip", {
      campaign: t.campaignName,
      occurrence: t.occurrenceId,
      reason: "review_pending",
      scheduled_at: t.scheduledAt,
    });
    return;
  }

  /*
   * Le ciblage est OPTIONNEL ; le consentement ne l'est pas. Sans segment, `segmentExpr` reste nul
   * et `pageAudience` n'ajoute simplement aucun prédicat de ciblage — la vue `sendable_subscription`
   * et `gateExpr` continuent de filtrer seuls. « Tous les abonnés de la marque qui ont accordé cette
   * finalité » est le résultat voulu, et il est produit par la même requête que d'habitude.
   *
   * ⛔ La distinction qui compte : ABSENT ≠ ILLISIBLE. Un segment désigné dont la règle ne se lit
   * pas reste un refus — deviner « tout le monde » sur une donnée corrompue serait un envoi de masse
   * accidentel. Ce refus est donc conservé mot pour mot, à l'intérieur de la branche.
   */
  let segmentExpr: string | null = null;
  // Sans segment : les abonnés, comme toujours. Seule une règle « Newsletter: No » vise les contacts.
  let population: Population = "subscribers";

  if (t.segmentId) {
    const segment = await db.getSegmentRule(t.segmentId, t.assetId);
    const rule = segment?.rule as RuleNode | null;
    if (!rule || (rule as { type?: unknown }).type !== "group") {
      // ⛔ Une règle illisible ne vaut PAS « tout le monde » : ce raccourci transformerait une donnée
      // corrompue en envoi de masse. Même refus que le compteur d'audience de l'admin.
      await retenir(db, t, opts.simulate, report, line, "unreadable_segment_rule");
      return;
    }

    /*
     * ⛔ LE CONTEXTE DE COMPILATION VIENT D'UN SEUL APPEL, SCOPÉ MARQUE, ET PORTE LES TROIS LISTES
     * BLANCHES DE PROVENANCE ENSEMBLE (voir `FanoutDb.ruleContext`, reflet de `ruleContextForAsset`).
     *
     * Jusqu'au 22/09/2026, le worker ne fournissait que les tags et les optins par slug. Tout segment
     * « venu de tel intérêt / telle créative / telle campagne d'acquisition » était donc dénoncé,
     * jugé élargi, et la campagne mise en PAUSE — alors que l'admin l'avait comptée et laissée
     * planifier. « Test », « Test 2 » et « Test 3 » (segments sur l'intérêt 12) sont tombées ainsi à
     * 11:30 UTC le 22/09. Le repli restait fermé, donc aucun envoi à côté — mais aucun envoi du tout.
     */
    const compiled = compileRule(rule, await db.ruleContext(t.assetId));
    line.unsupported = compiled.unsupported;

    /*
     * ⛔ UN CIBLAGE QUI S'EST ÉLARGI EST TRAITÉ COMME UNE RÈGLE ILLISIBLE.
     *
     * Jusqu'ici, un prédicat que le compilateur ne savait pas évaluer était compté dans le journal
     * et n'arrêtait RIEN. Or jeter un terme d'un ET n'enlève pas des destinataires, il en ajoute :
     * « brésiliens ET tagués campagne-X » privé de son second terme, c'est tous les brésiliens.
     * Le seul filet restant était le plafond de volume — il attrape la catastrophe, pas l'erreur de
     * quelques milliers d'adresses. Et un envoi ne se reprend pas.
     *
     * La cause n'est pas théorique : le slug d'un tag ou d'un optin cesse d'être résolvable dès que
     * quelqu'un le renomme ou le supprime, et la clé étrangère du segment est `on delete set null`.
     * Un humain tranche ; le worker ne devine pas.
     */
    if (compiled.widened) {
      const raison = `widened_segment_rule:${compiled.unsupported.join("|")}`;
      await retenir(db, t, opts.simulate, report, line, raison, "widened_segment_rule");
      return;
    }
    segmentExpr = compiled.expr;
    population = compiled.population;
  }

  /*
   * ⛔ LA BARRIÈRE DE FINALITÉ NE SAUTE QUE POUR LES CONTACTS D'UNE CAMPAGNE DONT LA CASE EST COCHÉE
   * (0088, décision d'Alix du 25/09/2026 : « Tous, j'assume le juridique »). Un abonné newsletter la
   * passe toujours, case cochée ou non ; un contact sans la case aussi. Le même calcul que
   * `estimateAudience` côté admin — sinon l'écran annonce un nombre que la file ne sert pas.
   */
  const purposeIgnored = population === "contacts" && t.contactsIgnorePurpose === true;
  const gateExpr = purposeIgnored
    ? null
    : purposeGateFilter(
        t.purpose as ConsentPurpose,
        await db.optOutEditionIds(t.assetId, (regime) => legalBasisForRegime(regime) === "opt_out"),
      );

  // La cible est PRISE avant la première écriture : deux passes qui se chevauchent ne peuvent pas
  // enfiler la même campagne, et celle qui perd la course ne fait rien du tout.
  if (!opts.simulate) {
    const taken = await db.claim(t);
    if (!taken) {
      line.skipped = "already_claimed";
      log("fanout-skip", { campaign: t.campaignName, occurrence: t.occurrenceId, reason: "already_claimed" });
      return;
    }
  }

  let after: string | null = null;
  let queued = 0;
  let seen = 0;
  try {
    for (;;) {
      const ids: string[] = await db.pageAudience({
        assetId: t.assetId,
        population,
        segmentExpr,
        gateExpr,
        afterId: after,
        limit: opts.batchSize,
      });
      if (ids.length === 0) break;
      seen += ids.length;

      if (seen > opts.maxPerTarget) {
        // ⛔ Le plafond ne tronque PAS en silence : il retient la cible et laisse ce qui a déjà été
        // écrit tel quel (l'idempotence permettra de reprendre là où on s'est arrêté). Tronquer
        // sans le dire produirait une campagne « réussie » qui n'a touché qu'une partie des gens.
        const reason = `audience_over_cap:${opts.maxPerTarget}`;
        line.held = reason;
        /*
         * ⛔ LES DEUX FORMES DE CIBLE SONT RETENUES, PAS UNE SEULE (corrigé le 18/09/2026).
         * L'occurrence passait `held` avec sa raison ; la campagne ponctuelle, elle, recevait un
         * `releaseClaim` — donc un retour à `scheduled`. Elle était re-scannée à la passe suivante,
         * re-dépassait le plafond, était re-relâchée : une boucle sans fin, sans une ligne en base,
         * pendant que l'admin affichait « Scheduled ». Or un plafond dépassé est exactement ce qu'un
         * humain doit trancher — c'est le contraire d'un incident transitoire.
         */
        if (t.occurrenceId && !opts.simulate) await db.holdOccurrence(t.occurrenceId, `fanout:${reason}`);
        else if (!opts.simulate) await db.holdCampaign(t, reason);
        report.held.push({ campaignName: t.campaignName, occurrenceId: t.occurrenceId, reason });
        line.queued = queued;
        line.inQueue = opts.simulate ? 0 : await db.countQueued(t.campaignId, t.occurrenceId);
        return;
      }

      if (!opts.simulate) {
        queued += await db.enqueueBatch(t.campaignId, t.occurrenceId, ids, population);
      }
      after = ids[ids.length - 1] ?? null;
      if (ids.length < opts.batchSize) break;
    }
  } catch (e) {
    // Une erreur au milieu du fan-out laisse des lignes déjà écrites : on ne les retire PAS (elles
    // sont valides et l'idempotence permettra de compléter), mais la cible retourne à son état
    // précédent pour être reprise à la passe suivante.
    if (!opts.simulate) {
      await db.releaseClaim(t);
      // ⛔ ET LA RAISON S'ÉCRIT EN BASE. Le `releaseClaim` seul rendait la campagne à `scheduled`
      // sans laisser la moindre marque : elle rebondissait entre `scheduled` et `sending` à chaque
      // passe, indéfiniment, pendant que l'admin affichait « Scheduled ». L'audit ne change PAS le
      // statut — la reprise reste voulue — il rend seulement la panne lisible.
      await db.auditFanoutError(t, (e as Error).message);
    }
    report.errors.push(`${t.campaignName}: ${(e as Error).message}`);
    line.skipped = "error";
    line.inQueue = opts.simulate ? 0 : await db.countQueued(t.campaignId, t.occurrenceId).catch(() => 0);
    return;
  }

  line.queued = queued;
  // ⛔ LA MESURE QUI FAIT FOI EST RELUE EN BASE, pas accumulée en mémoire : un rejeu après crash
  // insère 0 ligne (conflit) alors que la file en contient déjà des milliers. Compter ce qu'on a
  // écrit répondrait « 0 mis en file » sur une campagne parfaitement prête à partir.
  line.inQueue = opts.simulate ? 0 : await db.countQueued(t.campaignId, t.occurrenceId);

  /*
   * ⛔ UNE AUDIENCE VIDE EST UN INCIDENT, PAS UN ENVOI DE ZÉRO MESSAGE (18/09/2026).
   *
   * Ce chemin tombait jusqu'ici dans `markEnqueued(t, 0)` juste en dessous, avec trois effets tous
   * silencieux : `recipients_planned` était ÉCRASÉ à 0 — donc la seule preuve que quelqu'un était
   * attendu disparaissait —, la campagne restait `sending`, et il fallait attendre la passe suivante
   * pour que la réconciliation la close. Une campagne visant 1 destinataire finissait « 0 prévu,
   * rien envoyé », sans qu'aucun écran ne puisse dire qu'elle avait visé quelqu'un.
   *
   * La cause est TOUJOURS en amont et TOUJOURS humaine : personne dans le segment, consentement de
   * finalité non accordé, abonnés `pending` (double opt-in non confirmé), supprimés, ou en
   * `@example.*` (`is_demo`). Aucune ne se répare toute seule, donc la cible est RETENUE avec sa
   * raison plutôt que retentée en boucle.
   *
   * ⚠️ `line.inQueue === 0` EN PLUS DE `seen === 0` : si une passe précédente a déjà rempli la file
   * et que l'audience est vide seulement maintenant (tout le monde s'est désabonné entre-temps), des
   * lignes sont EN VOL. Les mettre en pause ici couperait un envoi en cours ; c'est à la
   * réconciliation de conclure.
   */
  if (seen === 0 && line.inQueue === 0) {
    await retenir(db, t, opts.simulate, report, line, "empty_audience");
    return;
  }

  if (!opts.simulate) {
    await db.markEnqueued(t, line.inQueue, new Date());
    report.targetsEnqueued += 1;
    report.rowsQueued += queued;
  }

  log("fanout-target", {
    campaign: t.campaignName,
    occurrence: t.occurrenceId,
    planned: line.planned,
    queued: line.queued,
    in_queue: line.inQueue,
    unsupported: line.unsupported.length,
    // Un envoi à toute la marque et un envoi ciblé produisent la même ligne de journal — sauf
    // celle-ci. C'est le seul endroit où l'élargissement de l'audience laisse une trace datée.
    targeting: t.segmentId ? "segment" : "whole-brand",
    // Et qui : abonnés ou contacts, avec ou sans la barrière de finalité — daté, lui aussi.
    population,
    purpose_ignored: purposeIgnored,
    simulate: opts.simulate,
  });
}

/**
 * ⭐ CE QUE LA PASSE AURAIT TRAITÉ — sans rien écrire, sans rien prendre.
 *
 * ⛔ POURQUOI ELLE EXISTE. Quand le fan-out refuse de démarrer (worker hors `live`), il se contente
 * de journaliser et de rendre la main : un refus PARFAITEMENT silencieux, dans un service dont
 * personne ne lit les journaux. Le refus lui-même est bon — il empêche de remplir une file que
 * personne ne peut vider — mais il doit pouvoir dire CE QU'IL COÛTE. « Le worker n'envoie pas » est
 * une information tiède ; « 3 campagnes étaient dues à l'instant et aucune ne partira » est une
 * alerte.
 *
 * ⚠️ Deux lectures seules, aucune prise : on ne peut pas se voler une cible à soi-même.
 */
export async function compterCiblesDues(db: FanoutDb, leadMinutes?: number, now: Date = new Date()): Promise<number> {
  const lead = leadMinutes ?? DEFAULT_LEAD_MINUTES;
  const [occurrences, campagnes] = await Promise.all([
    db.listDueOccurrences(now, lead),
    db.listDueCampaigns(now, lead),
  ]);
  return occurrences.length + campagnes.length;
}

/**
 * Une passe complète : occurrences d'abord (une série ratée se voit tout de suite), campagnes
 * simples ensuite.
 */
export async function runFanout(db: FanoutDb, options: FanoutOptions = {}): Promise<FanoutReport> {
  const now = options.now ?? new Date();
  const lead = options.leadMinutes ?? DEFAULT_LEAD_MINUTES;
  const opts = {
    now,
    batchSize: options.batchSize ?? BATCH_SIZE,
    maxPerTarget: options.maxPerTarget ?? DEFAULT_MAX_PER_TARGET,
    maxLateMinutes: options.maxLateMinutes ?? DEFAULT_MAX_LATE_MINUTES,
    simulate: options.simulate ?? false,
  };

  const report: FanoutReport = {
    targetsScanned: 0,
    targetsEnqueued: 0,
    rowsQueued: 0,
    held: [],
    errors: [],
    targets: [],
  };

  const targets = [...(await db.listDueOccurrences(now, lead)), ...(await db.listDueCampaigns(now, lead))];
  report.targetsScanned = targets.length;

  for (const t of targets) {
    try {
      await fanoutOne(db, t, opts, report);
    } catch (e) {
      // Une cible qui explose ne doit pas emporter les autres : la série de vendredi ne dépend pas
      // de celle de lundi.
      report.errors.push(`${t.campaignName}: ${(e as Error).message}`);
    }
  }

  return report;
}
