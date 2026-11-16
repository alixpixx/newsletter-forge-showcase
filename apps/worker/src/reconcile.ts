/**
 * ---------------------------------------------------------------------------
 * S-7 — La réconciliation : clore ce qui est fini, et dire ce qui s'est passé.
 * ---------------------------------------------------------------------------
 *
 * LE TROU QU'ELLE BOUCHE. Le fan-out fait passer sa cible en `sending` avant d'écrire la première
 * ligne — c'est ce qui empêche deux passes de l'enfiler deux fois. Mais rien ne l'en fait sortir :
 * sans réconciliation, une occurrence reste `sending` pour toujours, l'écran affiche « envoi en
 * cours » trois semaines plus tard, et personne ne peut dire si la série est partie.
 *
 * ⛔ CE FICHIER N'ENVOIE RIEN ET NE RÉ-ENFILE RIEN. Il lit l'état des lignes déjà en file et écrit
 * trois compteurs plus un statut. Il ne peut pas faire partir un e-mail, même en cas de bug : il
 * n'ouvre pas Mailgun et n'insère dans aucune table.
 *
 * QUAND UNE CIBLE EST-ELLE FINIE. Quand plus AUCUNE de ses lignes n'est `pending` ni `sending`.
 * Tant qu'il en reste une, on ne conclut pas : une campagne à moitié partie n'est ni un succès ni
 * un échec, et la marquer `sent` empêcherait de voir qu'elle est bloquée.
 *
 * ⚠️ ET SI LA FILE EST VIDE ? Deux cas très différents qu'on refuse de confondre : une cible qui a
 * été enfilée (`enqueued_at` non nul) et dont les lignes ont été purgées est TERMINÉE ; une cible
 * qui n'a jamais rien enfilé est ANORMALE — le fan-out l'a prise puis a échoué avant d'écrire. La
 * seconde n'est pas close en silence : elle est signalée et rendue à son état précédent, pour être
 * reprise à la passe suivante.
 */
import type { ReconcileDb, ReconcileTarget, OutboxTally } from "./reconcile-db";
import { log } from "./log";

export interface ReconcileLine {
  campaignId: string;
  occurrenceId: string | null;
  campaignName: string;
  status: "sent" | "failed" | "still_sending" | "requeued" | "error";
  tally: OutboxTally;
}

export interface ReconcileReport {
  scanned: number;
  closed: number;
  failed: number;
  stillSending: number;
  requeued: number;
  errors: string[];
  lines: ReconcileLine[];
}

/**
 * Le verdict d'une cible dont la file est entièrement traitée.
 *
 * ⛔ « ZÉRO PARTI » N'EST PAS « ENVOYÉ ». Une occurrence dont toutes les lignes ont échoué ou été
 * écartées ne doit pas porter le même statut qu'une qui a atteint ses lecteurs : `failed` est ce
 * qui déclenche l'alerte et ce qui empêche la série de considérer cette semaine comme faite.
 * Un envoi dont personne n'a rien reçu est un envoi raté, quelle qu'en soit la raison.
 */
function verdict(t: OutboxTally): "sent" | "failed" {
  return t.sent > 0 ? "sent" : "failed";
}

export async function runReconcile(db: ReconcileDb): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    scanned: 0,
    closed: 0,
    failed: 0,
    stillSending: 0,
    requeued: 0,
    errors: [],
    lines: [],
  };

  const targets: ReconcileTarget[] = await db.listSending();
  report.scanned = targets.length;

  for (const t of targets) {
    try {
      const tally = await db.tally(t);
      const line: ReconcileLine = {
        campaignId: t.campaignId,
        occurrenceId: t.occurrenceId,
        campaignName: t.campaignName,
        status: "still_sending",
        tally,
      };
      report.lines.push(line);

      if (tally.pending > 0 || tally.sending > 0) {
        report.stillSending += 1;
        continue;
      }

      if (tally.total === 0) {
        // File vide : terminé (lignes purgées) ou jamais enfilé (le fan-out a échoué après avoir
        // pris la cible). On ne devine pas — `enqueued_at` tranche, et le cas anormal est rendu.
        if (!t.enqueuedAt) {
          await db.requeue(t);
          line.status = "requeued";
          report.requeued += 1;
          log("reconcile-requeue", { campaign: t.campaignName, occurrence: t.occurrenceId });
          continue;
        }
      }

      const v = verdict(tally);
      await db.close(t, v, tally);
      line.status = v;
      if (v === "sent") report.closed += 1;
      else report.failed += 1;

      log("reconcile-close", {
        campaign: t.campaignName,
        occurrence: t.occurrenceId,
        verdict: v,
        sent: tally.sent,
        failed: tally.failed,
        skipped: tally.skipped,
      });
    } catch (e) {
      // Une cible qui explose ne doit pas emporter les autres.
      report.errors.push(`${t.campaignName}: ${(e as Error).message}`);
    }
  }

  return report;
}
