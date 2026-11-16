/**
 * Traitement d'UNE ligne : gate → render → veto footer → résolution expéditeur → allowlist →
 * (dry-run: log seul) → envoi Mailgun → mark_sent/mark_failed. Pur par-ligne : une mauvaise
 * ligne ne contamine jamais le lot (try/catch au niveau boucle). En dry-run, AUCUNE mutation DB.
 */
import { canonicalMessageId } from "@nf/config";
import { signUnsub } from "@nf/tokens";
import { ALLOWLIST_OUVERTE, type WorkerConfig } from "./env";
import type { Db, OutboxContext } from "./db";
import { gate } from "./gate";
import { render } from "./render";
import { Mailgun, resolveSender } from "./mailgun";
import { log, slackAlert } from "./log";
import { FENETRE_DEBIT_MS } from "./debit";

/**
 * Dernière fenêtre où l'on a alerté, par template de cycle de vie (clé : marque + kind — la clé
 * primaire du rattachement, donc exactement « ce template-là »).
 *
 * ⛔ UNE ALERTE PAR TEMPLATE ET PAR FENÊTRE, COMME LES AUTRES ALERTES DU WORKER. Un template cassé
 * retombe sur le dur à CHAQUE e-mail : une rafale de cinquante inscriptions posterait cinquante fois
 * le même message, qu'on apprendrait à ignorer — et le jour où un second template casse, il serait
 * noyé. Mémoire du processus : dans le service résident, elle couvre la fenêtre ; dans le cron, chaque
 * passage repart de zéro, soit au plus une alerte par passage de cinq minutes.
 */
const repliDitPour = new Map<string, number>();

/**
 * Les kinds qui portent `List-Unsubscribe` (+ `List-Unsubscribe-Post` quand `WORKER_ONE_CLICK` est
 * posé) : tout e-mail lié à un abonnement et qu'on peut ne plus vouloir recevoir.
 *
 * ⛔ TOUT KIND MARKETING Y EST, SANS EXCEPTION. Gmail et Yahoo exigent ces en-têtes des expéditeurs
 * en volume (février 2024) ; un e-mail marketing sans eux perd sa place en boîte de réception. Le
 * `reengagement` en était ABSENT jusqu'au 24/09/2026 — c'est pourtant l'e-mail qu'on envoie à des
 * gens qui ne lisent plus, donc le plus exposé à un « signaler comme spam » quand le bouton de
 * désinscription manque. Le banc `desinscription-en-tetes.test.ts` relit la table des politiques de `gate.ts` et
 * exige que chaque kind `marketing: true` figure ici : un kind neuf oublié le fait rougir.
 *
 * ⚠️ `broadcast` n'est plus accepté par la contrainte de `email_outbox` ; il reste ici parce qu'il
 * reste marketing dans la politique — cohérence plutôt qu'exception.
 *
 * Les transactionnels `confirmation` et `unsubscribe_ack` n'ont rien à désinscrire, pas plus que
 * `automation_tx` (relance de confirmation, renouvellement du consentement). `automation`, lui, est
 * MARKETING (0082) : il y est comme `campaign`.
 */
export const KINDS_DESINSCRIPTIBLES: ReadonlySet<string> = new Set([
  "welcome",
  "campaign",
  "test",
  "reengagement",
  "broadcast",
  "automation",
]);

async function alerterRepliCycleDeVie(cfg: WorkerConfig, ctx: OutboxContext, raison: string, now: Date): Promise<void> {
  const cle = `${ctx.asset_id ?? "?"}:${ctx.kind}`;
  const fenetre = Math.floor(now.getTime() / FENETRE_DEBIT_MS);
  if (repliDitPour.get(cle) === fenetre) return;
  repliDitPour.set(cle, fenetre);
  log("lifecycle_fallback_alert", { id: ctx.id, kind: ctx.kind, asset: ctx.asset_slug ?? null, reason: raison });
  await slackAlert(
    cfg.slackWebhookUrl,
    `nf-worker: le modèle rattaché à l'e-mail « ${ctx.kind} » de ${ctx.asset_slug ?? ctx.asset_id ?? "?"} n'a PAS pu servir ` +
      `(${raison}) — c'est l'e-mail de secours codé en dur qui part à sa place. Corrige ce modèle dans ` +
      `Automations › Lifecycle emails, puis republie-le.`,
  );
}


/**
 * `now` est un paramètre pour les bancs : la porte refuse une ligne trop vieille et le jeton de
 * confirmation expire, donc un banc à l'horloge réelle virerait au rouge un matin sans qu'une ligne de
 * code ait bougé. La boucle ne le passe pas.
 */
export async function processRow(
  ctx: OutboxContext,
  cfg: WorkerConfig,
  db: Db,
  mailgun: Mailgun,
  now: Date = new Date(),
): Promise<void> {
  const dryRun = cfg.mode === "dry-run";
  const base = { id: ctx.id, kind: ctx.kind, to: ctx.to_email };

  // En dry-run on n'a jamais claim la ligne (status reste 'pending') → aucune mutation permise.
  const skip = async (reason: string) => {
    if (dryRun) log("row", { ...base, decision: "would_skip", reason });
    else {
      await db.markSkipped(ctx.id, reason);
      log("row", { ...base, decision: "skipped", reason });
    }
  };

  // 1) Porte de conformité (statut / suppression / kind / âge de la ligne).
  const g = gate(ctx, now);
  if (!g.send) return void (await skip(g.reason));

  /*
   * 1 bis) LE LIEN DE CONFIRMATION MÈNE-T-IL ENCORE QUELQUE PART ?
   *
   * ⛔ `render.ts` ne vérifie que la PRÉSENCE de `action_url`. L'URL est figée à la mise en file et
   * porte un jeton de 48 h que plus personne ne regarde : sans cette lecture, la bascule du worker
   * enverrait des liens morts à de vraies personnes, qui cliqueraient pour lire « lien expiré ».
   * Le détail du raisonnement et la mesure du 15/09/2026 sont dans `doi-link.ts`.
   *
   * ⚠️ La garde tourne AUSSI en dry-run — elle ne mute rien, et c'est justement en dry-run qu'on
   * veut lire `would_skip doi_token_expire` AVANT de basculer, plutôt que de le découvrir après.
   */
  // ⛔ La relance de confirmation d'une automation (0082) porte le MÊME lien : même lecture.
  const relance = ctx.kind === "automation_tx" && ctx.payload?.automation_trigger === "confirmation_reminder";
  if (ctx.kind === "confirmation" || relance) {
    const etat = await db.etatLienConfirmation(ctx.subscription_id, now);
    if (etat !== "valide") return void (await skip(`doi_token_${etat}`));
  }

  // 2) Rendu (footer conforme + liens signés ; kinds builder = hydratation du shell figé).
  const outcome = render(ctx, cfg.publicBaseUrl);
  if (!outcome.ok) return void (await skip(outcome.reason));
  const rendered = outcome.email;

  /*
   * 2 bis) UN TEMPLATE DE CYCLE DE VIE RATTACHÉ QUI N'A PAS SERVI SE DIT (inventaire, élément 114).
   * L'e-mail part quand même — avec le HTML de secours, c'est la règle de `renderLifecycle` — mais la
   * marque croit envoyer SON e-mail : sans alerte, elle l'apprendrait d'un abonné. Y compris en
   * dry-run : c'est un défaut de réglage, pas d'envoi, et c'est avant la bascule qu'on veut le voir.
   */
  if (rendered.lifecycleFallback) await alerterRepliCycleDeVie(cfg, ctx, rendered.lifecycleFallback, now);

  // Tokens hors registre : le rendu les a retirés (pas de `{{typo}}` livré), on les rend visibles.
  if (rendered.unknownTokens && rendered.unknownTokens.length > 0) {
    log("row", { ...base, decision: "unknown_tokens", tokens: rendered.unknownTokens.join(",") });
  }

  // 3) Veto footer incomplet (ex. CAN-SPAM sans adresse postale).
  if (rendered.footerMissing.length > 0) {
    return void (await skip(`footer_incomplete:${rendered.footerMissing.join(",")}`));
  }

  // 4) Expéditeur (domaine + From) selon le mode d'envoi.
  const sender = resolveSender(cfg, ctx);
  if (!sender) return void (await skip("no_sending_domain"));

  // 5) Allowlist (lower(citext) : email exact OU domaine) — ou OUVERTE (`*`, la mise en production).
  const to = ctx.to_email.toLowerCase();
  const allowed =
    cfg.allowlist.has(ALLOWLIST_OUVERTE) || cfg.allowlist.has(to) || cfg.allowlist.has(to.split("@")[1] ?? "");

  // 6) DRY-RUN : on journalise la décision complète, sans jamais envoyer ni muter.
  if (dryRun) {
    log("row", {
      ...base,
      decision: "would_send",
      track: g.track,
      from: sender.from,
      domain: sender.domain,
      // L'adresse de réponse de la MARQUE (jamais celle d'un abonné) : utile pour vérifier le réglage.
      reply_to: sender.replyTo ?? null,
      allowlisted: allowed,
      subject: rendered.subject,
    });
    return;
  }

  // 7) LIVE : allowlist fail-closed (hors liste = skip terminal, jamais renvoyé).
  if (!allowed) return void (await skip("not_allowlisted"));

  // 8) Envoi. List-Unsubscribe pour tout kind de `KINDS_DESINSCRIPTIBLES` (voir sa définition) :
  //    tout e-mail lié à un abonnement doit être désinscriptible en un clic depuis le client mail.
  //    ⛔ PAS DE `mailto:` (décision D7 du plan des automations, 24/09/2026) : aucune boîte ne traite
  //    `unsubscribe@` — aucun code du dépôt ne lit ces messages. Une personne qui s'y désinscrivait
  //    restait abonnée sans le savoir. Le lien HTTPS (+ One-Click) suffit à Gmail et Yahoo.
  const wantsListUnsub = KINDS_DESINSCRIPTIBLES.has(ctx.kind);
  const listUnsub =
    wantsListUnsub && ctx.subscription_id
      ? `<${cfg.publicBaseUrl}/unsubscribe?token=${signUnsub(ctx.subscription_id)}>`
      : undefined;

  const result = await mailgun.send({
    domain: sender.domain,
    from: sender.from,
    to: ctx.to_email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    messageId: ctx.id,
    messageIdHost: cfg.messageIdHost,
    track: g.track,
    listUnsub,
    oneClick: cfg.oneClick,
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    // Variables Mailgun : rattachent chaque événement (delivered/bounce/complaint) à sa campagne.
    vars: {
      outbox_id: ctx.id,
      kind: ctx.kind,
      ...(ctx.campaign_id ? { campaign_id: ctx.campaign_id } : {}),
      ...(ctx.template_version_id ? { template_version_id: ctx.template_version_id } : {}),
    },
  });

  if (result.ok) {
    /*
     * ⛔ NORMALISÉ AVANT D'ÊTRE STOCKÉ. L'API rend l'identifiant avec ses chevrons ; le webhook, à
     * l'autre bout, les retire avant de chercher cette même ligne. Stocker la forme brute rendait
     * l'égalité incapable de mordre : l'événement s'écrivait sans destinataire, sans marque et sans
     * campagne, avec un 200 rendu au fournisseur et aucune trace du problème. La même fonction
     * normalise ici et là-bas — voir `@nf/config` `canonicalMessageId`.
     */
    const messageId = canonicalMessageId(result.id);
    await db.markSent(ctx.id, messageId, g.track);
    log("row", { ...base, decision: "sent", provider_message_id: messageId });
    return;
  }

  await db.markFailed(ctx.id, result.error, result.retryable);
  log("row", { ...base, decision: "failed", retryable: result.retryable, reason: result.error });
  await slackAlert(cfg.slackWebhookUrl, `nf-worker: envoi échoué (${ctx.kind}, retryable=${result.retryable}): ${result.error}`);
}
