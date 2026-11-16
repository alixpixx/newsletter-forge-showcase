/**
 * Accès base de la RÉCONCILIATION (S-7).
 *
 * ⛔ SURFACE VOLONTAIREMENT MINUSCULE : lire l'état d'une file, écrire un statut et trois
 * compteurs. Aucune insertion, aucune méthode qui touche au contenu d'une ligne d'`email_outbox` :
 * une réconciliation ne doit pas pouvoir faire partir un e-mail, même par erreur de frappe.
 */
import { createClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./env";

export interface ReconcileTarget {
  occurrenceId: string | null;
  campaignId: string;
  campaignName: string;
  enqueuedAt: string | null;
}

export interface OutboxTally {
  total: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  skipped: number;
}

function makeClient(cfg: WorkerConfig) {
  return createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    db: { schema: "newsletter" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export class ReconcileDb {
  private sb: ReturnType<typeof makeClient>;

  constructor(cfg: WorkerConfig) {
    this.sb = makeClient(cfg);
  }

  /** Les cibles en cours d'envoi : occurrences d'abord, puis campagnes simples. */
  async listSending(): Promise<ReconcileTarget[]> {
    const { data: occ, error: e1 } = await this.sb
      .from("campaign_occurrence")
      .select("id, campaign_id, enqueued_at, campaign:campaign_id(name)")
      .eq("status", "sending");
    if (e1) throw new Error(`listSending occurrences: ${e1.message}`);

    const { data: camp, error: e2 } = await this.sb
      .from("campaign")
      .select("id, name, enqueued_at")
      .eq("status", "sending")
      .is("recurrence_days", null);
    if (e2) throw new Error(`listSending campaigns: ${e2.message}`);

    const fromOcc = ((occ ?? []) as unknown as {
      id: string;
      campaign_id: string;
      enqueued_at: string | null;
      campaign: { name: string | null } | null;
    }[]).map((r) => ({
      occurrenceId: r.id,
      campaignId: r.campaign_id,
      campaignName: r.campaign?.name ?? "(sans nom)",
      enqueuedAt: r.enqueued_at,
    }));

    const fromCamp = ((camp ?? []) as unknown as {
      id: string;
      name: string | null;
      enqueued_at: string | null;
    }[]).map((r) => ({
      occurrenceId: null,
      campaignId: r.id,
      campaignName: r.name ?? "(sans nom)",
      enqueuedAt: r.enqueued_at,
    }));

    return [...fromOcc, ...fromCamp];
  }

  /**
   * L'état de la file pour une cible, statut par statut.
   *
   * ⚠️ Six comptages `head` plutôt qu'un `group by` : PostgREST ne sait pas agréger, et rapatrier
   * les lignes pour les compter en mémoire ferait transiter des milliers d'adresses par le worker
   * — exactement ce que le fan-out s'interdit. Six requêtes qui ne ramènent aucune donnée coûtent
   * moins cher qu'une seule qui ramène la PII d'une campagne entière.
   */
  async tally(t: ReconcileTarget): Promise<OutboxTally> {
    const count = async (status?: string): Promise<number> => {
      let q = this.sb.from("email_outbox").select("id", { count: "exact", head: true }).eq("campaign_id", t.campaignId);
      q = t.occurrenceId ? q.eq("occurrence_id", t.occurrenceId) : q.is("occurrence_id", null);
      if (status) q = q.eq("status", status);
      const { count: n, error } = await q;
      if (error) throw new Error(`tally(${status ?? "total"}): ${error.message}`);
      return n ?? 0;
    };

    const [total, pending, sending, sent, failed, skipped] = await Promise.all([
      count(),
      count("pending"),
      count("sending"),
      count("sent"),
      count("failed"),
      count("skipped"),
    ]);
    return { total, pending, sending, sent, failed, skipped };
  }

  /** Clôt la cible : statut terminal + les trois compteurs qui racontent l'envoi. */
  async close(t: ReconcileTarget, verdict: "sent" | "failed", tally: OutboxTally): Promise<void> {
    const now = new Date().toISOString();
    const counters = {
      recipients_sent: tally.sent,
      recipients_failed: tally.failed,
      recipients_skipped: tally.skipped,
    };

    if (t.occurrenceId) {
      const { error } = await this.sb
        .from("campaign_occurrence")
        // `sent_at` n'est posé QUE si quelque chose est parti : une date d'envoi sur une occurrence
        // dont personne n'a rien reçu ferait mentir tous les écrans qui l'affichent.
        .update({ status: verdict, ...counters, sent_at: verdict === "sent" ? now : null, updated_at: now })
        .eq("id", t.occurrenceId)
        .eq("status", "sending");
      if (error) throw new Error(`close occurrence: ${error.message}`);
      return;
    }

    // ⚠️ `campaign.status` n'admet pas 'failed' (contrainte campaign_status_check) : une campagne
    // dont rien n'est parti revient à `paused`, un état qui EXISTE et qui dit « arrêtée, pas
    // terminée ». Inventer un statut hors contrainte ferait échouer l'écriture et laisserait la
    // campagne bloquée en `sending` — le défaut qu'on est en train de corriger.
    const status = verdict === "sent" ? "sent" : "paused";
    const { error } = await this.sb
      .from("campaign")
      .update({ status, ...counters, sent_at: verdict === "sent" ? now : null })
      .eq("id", t.campaignId)
      .eq("status", "sending");
    if (error) throw new Error(`close campaign: ${error.message}`);
  }

  /** Rend une cible prise mais jamais enfilée — elle sera reprise à la passe suivante. */
  async requeue(t: ReconcileTarget): Promise<void> {
    if (t.occurrenceId) {
      const { error } = await this.sb
        .from("campaign_occurrence")
        .update({ status: "frozen", updated_at: new Date().toISOString() })
        .eq("id", t.occurrenceId)
        .eq("status", "sending");
      if (error) throw new Error(`requeue occurrence: ${error.message}`);
      return;
    }
    const { error } = await this.sb
      .from("campaign")
      .update({ status: "scheduled" })
      .eq("id", t.campaignId)
      .eq("status", "sending");
    if (error) throw new Error(`requeue campaign: ${error.message}`);
  }
}
