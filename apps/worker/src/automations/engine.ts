/**
 * Le moteur d'automations (0082) — une passe, appelée par la tâche `plan` APRÈS le gel.
 *
 * ⛔ PAS DE NOUVELLE ENTRÉE D'ORDONNANCEUR. Le moteur vit dans la tâche `plan`, qui tourne déjà sur
 * sa cadence : aucune nouvelle horloge à armer, donc aucune horloge oubliée.
 *
 * ⛔ LE MOTEUR NE DÉCIDE PAS QUI REÇOIT : `automation_due` le fait, dans la même transaction que
 * l'écriture. Le moteur décide seulement QUELLES automations il ose appeler, et avec quel droit :
 *  - seules `simulation` et `live` sont lues, et relues ici (un `paused` renvoyé par erreur ne
 *    tourne pas) ;
 *  - chacune est REVALIDÉE (`validateAutomation`) avant tout appel ;
 *  - `p_live_allowed` n'est vrai QUE pour une automation `live` ET un worker en `WORKER_MODE=live`.
 *    C'est la seconde clé : la fonction SQL refuse aussi, mais une seule serrure ne suffit pas quand
 *    ouvrir envoie de vrais e-mails ;
 *  - une automation `live` sur un worker en `dry-run` n'est PAS appelée du tout (`drain_cannot_send`) ;
 *  - hors fenêtre horaire, rien n'est appelé (la fonction le revérifie) ;
 *  - le lot ne dépasse jamais le plafond quotidien de l'automation ;
 *  - jamais deux passes à la fois dans ce processus (et la fonction pose un verrou par automation,
 *    qui couvre deux processus).
 */
import { inSendWindow, validateAutomation, type AutomationRecord } from "@nf/automations";
import { AutomationsNotInstalled, type AutomationDbLike, type DueResult } from "./db";

export interface AutomationRunOptions {
  /** `WORKER_MODE === "live"`. */
  workerLive: boolean;
  /** `WORKER_ALLOWLIST`, en minuscules. */
  allowlist: string[];
  /** Origine publique (lien de confirmation neuf). */
  confirmBaseUrl: string | null;
  /** `PLANNER_SIMULATE` : compter, ne rien écrire — pas même la simulation ni le curseur. */
  probe: boolean;
  /** Taille de lot par étape, avant le plafond de l'automation. */
  batch?: number;
  now?: Date;
}

export interface AutomationStepReport {
  step: number;
  result: DueResult;
}

export interface AutomationRunEntry {
  id: string;
  name: string;
  trigger: string;
  status: string;
  /** Pourquoi rien n'a été appelé (validation, fenêtre, mode), ou `null` si les étapes ont tourné. */
  skipped: string | null;
  errors: string[];
  steps: AutomationStepReport[];
}

export interface AutomationRunReport {
  /** Une autre passe tournait déjà dans ce processus : celle-ci n'a rien fait. */
  busy: boolean;
  /** 0082 absente : rien n'a été fait, et ce n'est pas une panne. */
  notInstalled: boolean;
  automations: AutomationRunEntry[];
  /** Traces écrites en simulation / en réel (lignes en file ou sunsets posés). */
  simulatedWritten: number;
  liveWritten: number;
  /** Automations armées écartées parce qu'invalides : à signaler, elles ne tournent pas. */
  invalid: string[];
  /** Erreurs d'appel (une automation en erreur n'arrête pas les autres). */
  failures: string[];
}

export const LOT_PAR_DEFAUT = 100;

/**
 * Les raisons après lesquelles les étapes suivantes n'ont rien à faire DANS CETTE PASSE : un verrou
 * tenu, un plafond atteint (il est commun aux étapes), un curseur qu'on vient de poser, une
 * configuration que la fonction refuse.
 */
const STOP = new Set([
  "busy",
  "daily_cap_reached",
  "cursor_initialized",
  "not_found",
  "not_armed",
  "no_engine",
  "drain_cannot_send",
  "no_allowlist",
  "missing_purpose",
  "bad_filters",
  "bad_settings",
  "bad_timezone",
  "missing_optin_filter",
  "outside_window",
  "no_confirm_base_url",
]);

let passeEnCours = false;

export async function runAutomations(db: AutomationDbLike, opts: AutomationRunOptions): Promise<AutomationRunReport> {
  const report: AutomationRunReport = {
    busy: false,
    notInstalled: false,
    automations: [],
    simulatedWritten: 0,
    liveWritten: 0,
    invalid: [],
    failures: [],
  };

  // ⛔ Jamais deux passes à la fois : la seconde rend la main sans rien lire.
  if (passeEnCours) {
    report.busy = true;
    return report;
  }
  passeEnCours = true;
  try {
    const now = opts.now ?? new Date();
    let lignes: AutomationRecord[];
    try {
      lignes = await db.armed();
    } catch (e) {
      if (e instanceof AutomationsNotInstalled) {
        report.notInstalled = true;
        return report;
      }
      throw e;
    }

    for (const ligne of lignes) {
      const entree: AutomationRunEntry = {
        id: String(ligne.id ?? "?"),
        name: String(ligne.name ?? ""),
        trigger: String(ligne.trigger ?? ""),
        status: String(ligne.status ?? ""),
        skipped: null,
        errors: [],
        steps: [],
      };
      report.automations.push(entree);

      // ⛔ Relu ici : la requête filtre déjà, mais un `draft` ou un `paused` ne tourne JAMAIS, même
      // renvoyé par erreur.
      if (ligne.status !== "simulation" && ligne.status !== "live") {
        entree.skipped = "not_armed";
        continue;
      }

      const v = validateAutomation(ligne);
      if (!v.ok) {
        entree.skipped = "invalid";
        entree.errors = v.errors;
        report.invalid.push(`${entree.name} (${entree.id}) : ${v.errors.join(" ; ")}`);
        continue;
      }
      const a = v.automation;
      if (!a.id) {
        entree.skipped = "invalid";
        report.invalid.push(`${entree.name} : sans id`);
        continue;
      }
      if (!a.spec.engine) {
        entree.skipped = "no_engine";
        continue;
      }

      // ⛔ Une automation `live` sur un worker qui ne peut pas envoyer n'est pas appelée : la faire
      // tourner en simulation occuperait les créneaux de vrais envois.
      if (a.status === "live" && !opts.workerLive) {
        entree.skipped = "drain_cannot_send";
        continue;
      }

      // Fenêtre horaire, dans le fuseau de l'automation. Un déclencheur silencieux n'envoie rien.
      if (a.spec.kind !== null && !inSendWindow(now, a.timezone, a.windowStartHour, a.windowEndHour)) {
        entree.skipped = "outside_window";
        continue;
      }

      const liveAllowed = a.status === "live" && opts.workerLive;
      // ⛔ Jamais plus que le plafond du jour en un lot (la fonction recompte ce qui est déjà écrit).
      const batch = Math.max(1, Math.min(opts.batch ?? LOT_PAR_DEFAUT, a.dailyCap));

      for (let step = 1; step <= a.steps.length; step += 1) {
        let result: DueResult;
        try {
          result = await db.due(a.id, step, {
            batch,
            allowlist: opts.allowlist,
            liveAllowed,
            confirmBaseUrl: opts.confirmBaseUrl,
            probe: opts.probe,
          });
        } catch (e) {
          if (e instanceof AutomationsNotInstalled) {
            report.notInstalled = true;
            return report;
          }
          const message = (e as Error).message;
          entree.errors.push(`step ${step}: ${message}`);
          report.failures.push(`${entree.name} (${a.id}) step ${step}: ${message}`);
          break;
        }
        entree.steps.push({ step, result });
        if (!opts.probe) {
          if (result.simulated) report.simulatedWritten += result.written;
          else report.liveWritten += result.written;
        }
        if (result.reason && STOP.has(result.reason)) break;
      }
    }
    return report;
  } finally {
    passeEnCours = false;
  }
}

/** Une ligne de journal par passe : ce qui a tourné, ce qui a été écrit, ce qui a été écarté. */
export function resumeAutomations(r: AutomationRunReport): Record<string, unknown> {
  return {
    busy: r.busy,
    not_installed: r.notInstalled,
    armed: r.automations.length,
    ran: r.automations.filter((a) => a.skipped === null).length,
    skipped: r.automations
      .filter((a) => a.skipped !== null)
      .map((a) => `${a.trigger}:${a.skipped}`)
      .join(",") || null,
    simulated_written: r.simulatedWritten,
    live_written: r.liveWritten,
    invalid: r.invalid.length,
    failures: r.failures.length,
  };
}
