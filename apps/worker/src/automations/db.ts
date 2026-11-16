/**
 * Accès base du moteur d'automations (0082), séparé de `db.ts` qui sert l'envoi.
 *
 * ⛔ CE FICHIER NE NOMME JAMAIS `email_outbox`. Le moteur ne met RIEN en file lui-même : il appelle
 * `automation_due`, qui sélectionne, trace et enfile dans UNE transaction (voir 0082). Une écriture
 * directe ici serait une seconde porte d'entrée dans la file, sans la trace d'idempotence devant.
 *
 * ⚠️ Deux lectures seulement : les automations ARMÉES, et le résultat d'une étape. Le client est
 * derrière `AutomationDbLike` pour que les bancs le doublent sans aucune base.
 */
import { createClient } from "@supabase/supabase-js";
import type { AutomationRecord } from "@nf/automations";
import type { WorkerConfig } from "../env";

/** Ce que rend `automation_due` (une ligne). */
export interface DueResult {
  eligible: number;
  allowed: number;
  written: number;
  simulated: boolean;
  daily_used: number;
  reason: string | null;
}

export interface DueOptions {
  /** Taille de lot (la fonction la borne aussi, à 500 et au plafond du jour). */
  batch: number;
  /** `WORKER_ALLOWLIST`, en minuscules. */
  allowlist: string[];
  /** ⛔ Vrai SEULEMENT si l'automation est `live` ET le worker en `WORKER_MODE=live`. */
  liveAllowed: boolean;
  /** Origine publique, pour un nouveau lien de confirmation. */
  confirmBaseUrl: string | null;
  /** Compter sans rien écrire (`PLANNER_SIMULATE`). */
  probe: boolean;
}

export interface AutomationDbLike {
  /** Les automations `simulation` et `live`. Jamais `draft` ni `paused`. */
  armed(): Promise<AutomationRecord[]>;
  due(automationId: string, step: number, opts: DueOptions): Promise<DueResult>;
}

/**
 * La table ou la fonction n'existe pas encore : 0082 n'est pas appliquée. Ce n'est PAS une panne —
 * le worker est déployé avant la migration, et la passe doit alors se taire (journal seul).
 */
export class AutomationsNotInstalled extends Error {
  constructor(detail: string) {
    super(`automations non installees (0082 non appliquee ?) : ${detail}`);
    this.name = "AutomationsNotInstalled";
  }
}

/** Codes PostgREST / Postgres d'un objet absent : table (`PGRST205`, `42P01`), fonction (`PGRST202`, `42883`). */
const ABSENT = new Set(["PGRST205", "42P01", "PGRST202", "42883"]);

export function estAbsent(error: { code?: string | null } | null | undefined): boolean {
  return !!error?.code && ABSENT.has(error.code);
}

/** ⚠️ Factory plutôt que `ReturnType<typeof createClient>` : le type nu perd l'option `schema`. */
function makeClient(cfg: WorkerConfig) {
  return createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    db: { schema: "newsletter" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const COLONNES =
  "id, asset_id, name, trigger, filters, settings, steps, status, purpose, daily_cap, " +
  "window_start_hour, window_end_hour, timezone, event_cursor";

export class AutomationDb implements AutomationDbLike {
  private sb: ReturnType<typeof makeClient>;

  constructor(cfg: WorkerConfig) {
    this.sb = makeClient(cfg);
  }

  async armed(): Promise<AutomationRecord[]> {
    const { data, error } = await this.sb
      .from("automation")
      .select(COLONNES)
      .in("status", ["simulation", "live"])
      .order("created_at", { ascending: true });
    if (error) {
      if (estAbsent(error)) throw new AutomationsNotInstalled(`${error.code} ${error.message}`);
      throw new Error(`lecture des automations: ${error.message}`);
    }
    return (data ?? []) as unknown as AutomationRecord[];
  }

  async due(automationId: string, step: number, opts: DueOptions): Promise<DueResult> {
    const { data, error } = await this.sb.rpc("automation_due", {
      p_automation_id: automationId,
      p_step: step,
      p_batch: opts.batch,
      p_allowlist: opts.allowlist,
      p_live_allowed: opts.liveAllowed,
      p_confirm_base_url: opts.confirmBaseUrl,
      p_probe: opts.probe,
    });
    if (error) {
      if (estAbsent(error)) throw new AutomationsNotInstalled(`${error.code} ${error.message}`);
      throw new Error(`automation_due: ${error.message}`);
    }
    const l = (((data ?? []) as Partial<DueResult>[])[0]) ?? {};
    return {
      eligible: Number(l.eligible ?? 0),
      allowed: Number(l.allowed ?? 0),
      written: Number(l.written ?? 0),
      simulated: l.simulated !== false,
      daily_used: Number(l.daily_used ?? 0),
      reason: l.reason ?? null,
    };
  }
}
