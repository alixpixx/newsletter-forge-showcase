/**
 * Accès DB via supabase-js (service_role, schéma `newsletter`). Transport imposé par le terrain :
 * aucun password Postgres n'existe sur les projets visés → tout passe par PostgREST/RPC, comme
 * apps/public. `FOR UPDATE SKIP LOCKED` vit donc dans le RPC SECURITY DEFINER claim_outbox.
 */
import { createClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./env";
import { etatLienConfirmation, type EtatLienConfirmation, type LigneJeton } from "./doi-link";
import { estAbsent } from "./automations/db";

/** Client scoped au schéma `newsletter`. La factory capture le type exact (schéma non-public). */
function makeClient(cfg: WorkerConfig) {
  return createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    db: { schema: "newsletter" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Ligne de la vue newsletter.outbox_context (contexte résolu + suppression LIVE). */
export interface OutboxContext {
  id: string;
  kind: string;
  subject: string;
  action_url: string | null;
  payload: Record<string, unknown> | null;
  to_email: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  created_at: string;
  asset_id: string | null;
  subscription_id: string | null;
  asset_name: string | null;
  asset_slug: string | null;
  sending_subdomain: string | null;
  compliance_regime: "gdpr" | "lgpd" | "canspam" | null;
  legal_footer: Record<string, unknown> | null;
  language: string | null;
  sub_status: string | null;
  subscriber_id: string | null;
  tracking_consent: boolean | null;
  /**
   * Mode de suivi de la MARQUE (0092) : `all` = tous sauf refus explicite, `consent` = seulement
   * `tracking_consent`. Absent sur une base d'avant 0092 : la règle du consentement s'applique.
   */
  tracking_mode?: "all" | "consent" | null;
  /** Refus EXPLICITE du suivi par la personne (0092, centre de préférences). Absent avant 0092. */
  tracking_refused?: boolean | null;
  suppressed: boolean;
  // Ajouts consentement par finalité (migration 0015) :
  purpose: string | null;
  market: string | null;
  consent_mode: "single" | "granular" | null;
  granted_purposes: Record<string, boolean> | null;
  // Builder v2 (migrations 0018/0019) — références posées sur email_outbox pour les kinds
  // 'test'/'campaign'. La vue outbox_context les EXPOSE (0019 vérifiée appliquée en base) et
  // joint les shells figés : le worker ne compile jamais, il hydrate. `?` car une base sur
  // laquelle 0019 n'aurait pas tourné renverrait la ligne SANS ces clés (select * sur la vue).
  campaign_id?: string | null;
  template_version_id?: string | null;
  /** `template_version.html_shell` — HTML figé à la publication, tokens {{…}} non résolus. */
  template_html_shell?: string | null;
  template_text_shell?: string | null;
  /** `campaign.html_shell` — snapshot figé au lock de la campagne. */
  campaign_html_shell?: string | null;
  campaign_text_shell?: string | null;
  /**
   * Porteur de contenu d'une SÉRIE (colonnes appendues par 0036). Une occurrence a été gelée avec
   * SES articles, à SA date : c'est elle qui doit être servie, pas le snapshot du modèle — sans
   * quoi une série de huit semaines enverrait huit fois le contenu de la semaine 1.
   */
  occurrence_id?: string | null;
  occurrence_html_shell?: string | null;
  occurrence_text_shell?: string | null;
  occurrence_status?: string | null;
  /**
   * Numéro lisible et jour local de l'édition (colonnes appendues par 0048), lus sur l'occurrence
   * à CHAQUE rendu — jamais recopiés dans le payload, qui est écrit une fois par destinataire et
   * figerait la valeur en autant d'exemplaires qu'il y a d'abonnés.
   *
   * ⚠️ Nuls sur tout envoi hors série (bienvenue, confirmation, campagne ponctuelle jamais
   * matérialisée) : `occurrence_id` est alors nul et la jointure ne rend rien.
   */
  occurrence_seq?: number | null;
  /** Date seule (`YYYY-MM-DD`), SANS heure ni fuseau : c'est le jour local voulu de l'envoi. */
  occurrence_local_date?: string | null;
  /**
   * Colonnes appendues par 0050, pour les shortcodes de sujet.
   *
   * `campaign_local_date` est le jour local de la campagne elle-même, déjà converti dans son
   * fuseau côté SQL. Il ne sert QU'EN REPLI : quand une occurrence existe, c'est sa date qui fait
   * foi. Sans lui, une campagne ponctuelle — qui n'a jamais d'occurrence — servait un
   * `{{edition_date}}` vide.
   */
  campaign_name?: string | null;
  campaign_local_date?: string | null;
  occurrence_first_article?: string | null;
  occurrence_article_count?: number | null;
  /** Colonnes appendues par 0055 — l'accroche et l'intro écrites au gel (ou au verrouillage). */
  occurrence_ai_intro?: string | null;
  occurrence_ai_preheader?: string | null;
  campaign_ai_intro?: string | null;
  campaign_ai_preheader?: string | null;
  /**
   * Colonnes appendues par 0059 — le shell du template RATTACHÉ à ce kind pour cette marque
   * (`lifecycle_template`). La vue ne les remplit que si un rattachement existe, que le template
   * n'est pas archivé et que sa version courante est publiée.
   *
   * ⚠️ NULLES DANS LE CAS NORMAL, et ce n'est pas une panne : aucune marque n'a rien rattaché
   * aujourd'hui. Le rendu retombe alors sur le HTML en dur, qui reste la référence.
   */
  lifecycle_html_shell?: string | null;
  lifecycle_text_shell?: string | null;
  lifecycle_subject?: string | null;
  /**
   * Colonne appendue par 0073 — la suppression qu'une réinscription NE LÈVE PAS (rebond dur,
   * plainte, motif inconnu). `suppressed` compte aussi l'effacement et la désinscription globale.
   * La CONFIRMATION et l'ACCUSÉ DE DÉSINSCRIPTION la lisent (`gate.ts`) — l'accusé ne part que si
   * elle vaut `false`. `?` : absente tant que 0073 n'est pas appliquée.
   */
  hard_suppressed?: boolean | null;
  /**
   * Colonnes appendues par 0078 — l'expéditeur réglé par édition : le NOM affiché dans le From et
   * l'adresse de réponse. `?` : absentes tant que 0078 n'est pas appliquée, et alors le From reste
   * `"<nom de marque>"` sans Reply-To, exactement comme avant (`resolveSender`).
   * ⛔ Jamais le DOMAINE : il reste celui du sous-domaine d'envoi vérifié (alignement DMARC).
   */
  from_name?: string | null;
  reply_to?: string | null;
}

export class Db {
  private sb: ReturnType<typeof makeClient>;

  constructor(cfg: WorkerConfig) {
    this.sb = makeClient(cfg);
  }

  /** Réclame un lot de lignes (pending dues + sending périmés). Passe pending→sending, attempts++. */
  async claim(worker: string, batch: number, staleSeconds: number): Promise<string[]> {
    const { data, error } = await this.sb.rpc("claim_outbox", {
      p_worker: worker,
      p_batch: batch,
      p_stale_seconds: staleSeconds,
    });
    if (error) throw new Error(`claim_outbox: ${error.message}`);
    return (data ?? []).map((r: { id: string }) => r.id);
  }

  /**
   * Comme `claim`, mais seulement les kinds INTERACTIFS (confirmation, bienvenue, accusé, test) —
   * RPC `claim_outbox_interactive` (0073). La passe prioritaire du service résident, hors du plafond
   * des newsletters.
   */
  async claimInteractive(worker: string, batch: number, staleSeconds: number): Promise<string[]> {
    const { data, error } = await this.sb.rpc("claim_outbox_interactive", {
      p_worker: worker,
      p_batch: batch,
      p_stale_seconds: staleSeconds,
    });
    if (error) throw new Error(`claim_outbox_interactive: ${error.message}`);
    return (data ?? []).map((r: { id: string }) => r.id);
  }

  /** Contexte résolu pour un ensemble d'ids (suppression ré-évaluée au SELECT = send-time). */
  async fetchContext(ids: string[]): Promise<OutboxContext[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.sb.from("outbox_context").select("*").in("id", ids);
    if (error) throw new Error(`fetchContext: ${error.message}`);
    return (data ?? []) as OutboxContext[];
  }

  /**
   * DRY-RUN : lecture seule des lignes 'pending', AUCUNE mutation (ne claim jamais).
   * On NE filtre PAS sur next_attempt_at<=now() : ce serait l'horloge CLIENT (dérive possible),
   * alors que le vrai claim utilise now() côté serveur. Le preview montre donc tout le 'pending'
   * (une ligne en backoff apparaît quand même — inoffensif pour une prévisualisation).
   */
  async peekPending(limit: number): Promise<OutboxContext[]> {
    const { data, error } = await this.sb
      .from("outbox_context")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`peekPending: ${error.message}`);
    return (data ?? []) as OutboxContext[];
  }

  /**
   * État du lien de confirmation d'une souscription, relu AU MOMENT DE L'ENVOI.
   *
   * ⛔ POURQUOI UNE LECTURE DE PLUS, ET POURQUOI ELLE NE PASSE PAS PAR LA VUE. `outbox_context` est
   * la surface résolue du worker, et l'y ajouter serait plus élégant — mais ce serait une migration,
   * donc une garde INERTE tant que personne ne l'applique. Une garde qu'on croit posée et qui ne
   * tourne pas est pire que pas de garde. Ici, une lecture, effective au premier démarrage.
   *
   * ⚠️ Le coût est nul en pratique : seules les lignes `confirmation` la déclenchent, et il en est
   * passé QUATRE en un mois.
   *
   * ⚠️ La comparaison de dates se fait côté worker, pas côté serveur. Assumé : un jeton vit 48 h, la
   * dérive d'horloge se compte en secondes. `peekPending` refuse ce raccourci parce qu'elle
   * filtrerait sur `next_attempt_at`, une borne qui se joue à la seconde ; pas le cas ici.
   */
  async etatLienConfirmation(subscriptionId: string | null, maintenant: Date = new Date()): Promise<EtatLienConfirmation> {
    if (!subscriptionId) return "absent";
    const { data, error } = await this.sb
      .from("doi_token")
      .select("expires_at, confirmed_at")
      .eq("subscription_id", subscriptionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // ⛔ Un refus de lecture N'EST PAS un jeton valide. On lève : la boucle appelante marque la
    // ligne en échec RETRYABLE, ce qui la représentera au prochain tour. Retomber silencieusement
    // sur « valide » ferait partir le lien mort que cette garde existe pour arrêter, et retomber
    // sur « expiré » brûlerait définitivement une inscription légitime pour une panne réseau.
    if (error) throw new Error(`etatLienConfirmation: ${error.message}`);
    return etatLienConfirmation(data as LigneJeton | null, maintenant);
  }

  /**
   * Marque la ligne envoyée et mémorise si l'ouverture et le clic étaient SUIVIS (0085) — le
   * dénominateur honnête des taux d'ouverture et de clic.
   *
   * ⛔ LE MESSAGE EST DÉJÀ PARTI quand on arrive ici. Une ligne laissée `sending` est reprise par
   * `claim_outbox` après `p_stale_seconds`, c'est-à-dire RENVOYÉE. La mesure ne doit donc ajouter
   * AUCUNE cause d'échec : si la surcharge à 3 arguments est inconnue (0085 absente, cache de l'API
   * pas encore rechargé), on retombe sur l'appel d'origine et `tracked` reste nul — « inconnu ».
   */
  async markSent(id: string, providerMessageId: string, tracked?: boolean): Promise<void> {
    if (tracked !== undefined) {
      const { error } = await this.sb.rpc("outbox_mark_sent", {
        p_id: id,
        p_provider_message_id: providerMessageId,
        p_tracked: tracked,
      });
      if (!error) return;
      if (!estAbsent(error)) throw new Error(`outbox_mark_sent: ${error.message}`);
    }
    const { error } = await this.sb.rpc("outbox_mark_sent", { p_id: id, p_provider_message_id: providerMessageId });
    if (error) throw new Error(`outbox_mark_sent: ${error.message}`);
  }

  async markFailed(id: string, err: string, retryable: boolean): Promise<void> {
    const { error } = await this.sb.rpc("outbox_mark_failed", { p_id: id, p_error: err.slice(0, 500), p_retryable: retryable });
    if (error) throw new Error(`outbox_mark_failed: ${error.message}`);
  }

  async markSkipped(id: string, reason: string): Promise<void> {
    const { error } = await this.sb.rpc("outbox_mark_skipped", { p_id: id, p_reason: reason.slice(0, 500) });
    if (error) throw new Error(`outbox_mark_skipped: ${error.message}`);
  }

  /** Relâche (arrêt gracieux) les lignes réclamées mais non démarrées → 'pending', attempt annulé. */
  async release(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.sb.rpc("outbox_release", { p_ids: ids });
    if (error) throw new Error(`outbox_release: ${error.message}`);
  }
}
