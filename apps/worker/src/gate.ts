/**
 * Porte de conformité par ligne, juste avant l'envoi (C4/C5). Keyée sur `kind`.
 * Décide : envoyer ou skip (raison), et si le suivi (pixel/clics) est autorisé.
 *
 * Subtilité qui TUERAIT le funnel si on la ratait : une `confirmation` part vers un abonné
 * `pending` (le double opt-in n'est pas encore confirmé). Appeler canSend() la bloquerait
 * (not_active). Les messages transactionnels bypassent donc le statut ; seul le marketing
 * exige `active`. La suppression, elle, est ré-évaluée LIVE dans la vue (send-time).
 */
import { canSend, canTrack, legalBasisForRegime, trackingAccepted, type ConsentPurpose } from "@nf/config";
import { TX_TRIGGER_STATUS } from "@nf/automations";
import type { OutboxContext } from "./db";

type Policy = {
  bypassStatus: boolean;
  bypassSuppression: boolean;
  allowTracking: boolean;
  marketing: boolean;
  /** Ne compte que la suppression DURE (`hard_suppressed`, 0073) : voir `confirmation`. */
  suppressionDureSeule?: boolean;
  /** L'accusé de désinscription : sa propre règle de statut et de suppression, voir `unsubscribe_ack`. */
  accuseDeDepart?: boolean;
  /** Une ligne sans finalité ne part pas (voir `automation`). */
  finaliteObligatoire?: boolean;
  /** Le statut exigé dépend du déclencheur écrit au payload (voir `automation_tx`). */
  statutParDeclencheur?: boolean;
  /** Accepte une ligne marquée `audience: contacts` (0088) — `campaign` seule, voir `gate()`. */
  audienceContacts?: boolean;
};

const POLICY: Record<string, Policy> = {
  /*
   * Service DOI : envoyer à un 'pending' est le but même ; pas de pixel.
   *
   * ⭐ SEULE LA SUPPRESSION DURE L'ARRÊTE (22/09/2026, Alix : « si la personne se reinscrit on l'a
   * reme dans le systeme »). Une personne effacée ou désinscrite de tout qui se réinscrit doit
   * RECEVOIR son lien : c'est son clic qui lève l'ancienne suppression (`confirm/page.tsx`). Bloquée
   * ici, elle ne pourrait jamais confirmer. Rebond dur et plainte arrêtent toujours.
   */
  confirmation: { bypassStatus: true, bypassSuppression: false, allowTracking: false, marketing: false, suppressionDureSeule: true },
  // Post-confirmation : exige 'active' + non-supprimé (canSend). Pas de pixel marketing.
  welcome: { bypassStatus: false, bypassSuppression: false, allowTracking: false, marketing: false },
  /*
   * Close-loop : la personne vient de se désinscrire — l'accusé part quand même, c'est sa raison
   * d'être. Le statut `active` n'est donc pas exigé, et la suppression SOUPLE (`global_optout`, que
   * pose « Unsubscribe from all brands » juste avant de mettre l'accusé en file) ne l'arrête pas.
   *
   * ⛔ MAIS PLUS « TOUT BYPASSER » (22/09/2026, le jour où l'accusé a enfin été mis en file). La
   * politique d'avant laissait partir l'accusé :
   *  - vers un REBOND DUR ou une PLAINTE — écrire à une boîte morte, ou à quelqu'un qui nous a
   *    signalés comme spam, est ce qui coûte la réputation du domaine ;
   *  - vers une souscription EFFACÉE (`deleted`) entre la mise en file et l'envoi — `erase_subscriber`
   *    ne touche pas `email_outbox.to_email`, l'accusé serait donc parti à la VRAIE adresse d'une
   *    personne qui vient de demander l'oubli.
   * D'où `accuseDeDepart` : seule une souscription `unsubscribed`, et seule une suppression DURE
   * lue à `false`, laissent partir.
   */
  unsubscribe_ack: { bypassStatus: true, bypassSuppression: false, allowTracking: false, marketing: false, accuseDeDepart: true },
  // Campagne marketing : gate par FINALITÉ (purpose) + statut + suppression + suivi conditionnel.
  broadcast: { bypassStatus: false, bypassSuppression: false, allowTracking: true, marketing: true },
  // Envoi de TEST depuis le builder : la destination est une adresse interne, pas forcément un
  // abonné → le statut est bypassé. Mais c'est un email RÉEL : suppression respectée (une adresse
  // sur la do-not-send ne reçoit rien, même en test) et allow-list appliquée dans process.ts.
  // Aucun pixel : un test ne doit polluer ni les stats ni le consentement.
  test: { bypassStatus: true, bypassSuppression: false, allowTracking: false, marketing: false },
  // Campagne du builder = marketing complet : statut actif + suppression + finalité + tracking
  // conditionné au consentement (canTrack). Seul kind qui puisse viser les contacts hors newsletter.
  campaign: { bypassStatus: false, bypassSuppression: false, allowTracking: true, marketing: true, audienceContacts: true },
  /*
   * Réengagement (lot 5) : marketing COMPLET, exactement comme une campagne.
   *
   * ⛔ AUCUN BYPASS, ET SURTOUT PAS CELUI DU STATUT. La tentation serait de bypasser pour
   * « rattraper » les inactifs — ce serait écrire à des gens qui se sont désinscrits ou dont le
   * double opt-in n'a jamais été confirmé, au motif qu'ils ne réagissent pas. Ne pas réagir n'est
   * pas un consentement : un abonné dormant est justement quelqu'un dont le seul titre à recevoir
   * est le consentement qu'il a donné, et ce consentement exige `active`.
   *
   * ⛔ NI CELUI DE LA SUPPRESSION. Une adresse sur la do-not-send y est parce qu'elle a rebondi
   * durement ou s'est plainte. Lui envoyer un « on ne vous a pas vu » est la façon la plus rapide
   * de transformer une plainte en signalement de domaine.
   *
   * ⚠️ `marketing: true` fait passer la FINALITÉ par `canSend` : un réengagement ne part que si
   * l'abonné a accordé la finalité que porte la ligne (0057 la rend obligatoire en base). Le suivi
   * reste conditionné au consentement de suivi, comme partout ailleurs.
   */
  reengagement: { bypassStatus: false, bypassSuppression: false, allowTracking: true, marketing: true },
  /*
   * Automation marketing (0082) : marketing COMPLET, comme `campaign` et `reengagement`.
   *
   * ⛔ ET LA FINALITÉ EST OBLIGATOIRE ICI AUSSI. `canSend` ne vérifie le consentement QUE si la ligne
   * porte une finalité : une ligne `automation` sans `purpose` partirait donc sans qu'aucun
   * consentement marketing soit relu. 0082 l'interdit en base ; la porte le refuse quand même, pour
   * le jour où une ligne arriverait d'ailleurs.
   */
  automation: {
    bypassStatus: false,
    bypassSuppression: false,
    allowTracking: true,
    marketing: true,
    finaliteObligatoire: true,
  },
  /*
   * Automation TRANSACTIONNELLE (0082) : la relance de confirmation et le renouvellement du
   * consentement, rien d'autre.
   *
   * ⛔ C'EST LA SEULE EXCEPTION À `not_active` DES AUTOMATIONS, ET ELLE EST BORNÉE AU DÉCLENCHEUR. Le
   * statut n'est pas « bypassé » : il est remplacé par celui que le déclencheur exige
   * (`TX_TRIGGER_STATUS`) — `pending` pour la relance (confirmée entre-temps = plus rien à relancer),
   * `active` pour le renouvellement. Un déclencheur absent ou inconnu au payload ne part pas.
   *
   * ⛔ TOUTE SUPPRESSION ARRÊTE, dure ou souple : l'exception « suppression dure seule » de
   * `confirmation` sert la personne qui revient d'elle-même ; une relance, c'est NOUS qui écrivons.
   * Pas de pixel : un transactionnel ne mesure rien.
   */
  automation_tx: {
    bypassStatus: true,
    bypassSuppression: false,
    allowTracking: false,
    marketing: false,
    statutParDeclencheur: true,
  },
};

export type GateDecision = { send: true; track: boolean } | { send: false; reason: string };

/**
 * Âge maximal d'une ligne de file, en jours.
 *
 * ⛔ POURQUOI CE PLAFOND EXISTE. `claim_outbox` n'a AUCUNE borne d'âge — c'est écrit noir sur blanc
 * dans `index.ts` : « elle partirait au premier ». Mesuré le 15/09/2026 (`select … from
 * newsletter.email_outbox where status='pending'`), la file porte HUIT lignes, aucune en
 * `test`/`campaign`, toutes à `attempts = 0` — jamais tentées, parce que le worker n'a jamais quitté
 * le `dry-run`. Elles se rangent en deux groupes que rien ne distingue au moment du `claim` :
 *
 *   · **20/08 18:04 — quatre lignes, 26 jours** : 2 `confirmation` Northwind Sports + 2 `welcome`, toutes à
 *     `@example.com` (RFC 2606, non délivrable). Ce sont elles que la borne d'âge refuse.
 *   · **13/09 13:38 — quatre `confirmation`, 2 jours** : 3 adresses grand public + 1 adresse interne, les
 *     leads Copper Kettle. Deux jours, donc **DANS** la fenêtre : la borne d'âge ne les retient pas.
 *
 * Un « Bienvenue » qui arrive presque un mois après l'inscription n'est pas un envoi tardif, c'est un
 * envoi que le destinataire ne peut plus rattacher à son geste — et pour une marque qui démarre,
 * c'est une plainte.
 *
 * ⛔ ET IL N'A PLUS AUCUNE EXCEPTION — décision d'Alix du 15/09/2026 au soir, qui renverse celle du
 * matin : « jveux jamais de liste stocké qui s'envoi apres c'est le milleur moyen d'avoir un
 * probleme qui balance d'un coup 10000 maisl ».
 *
 * Les `confirmation` en étaient exemptées, au motif qu'elles avaient leur propre horloge — le
 * `doi_token`, relu dans `process.ts`. Sauf que ce jeton a été PROLONGÉ à la main au 29/09, seize
 * jours après la mise en file : une horloge qu'on repousse ne borne plus rien. L'exemption
 * couvrait donc exactement les seules lignes qui partiraient à de VRAIES personnes. Le jeton reste
 * une borne, mais une borne EN PLUS de l'âge, jamais une licence qui le prolonge : deux bornes en
 * ET, la plus courte gagne.
 *
 * ⚠️ CE QUE CE CHOIX COÛTE AUJOURD'HUI : RIEN DE RÉEL. Les quatre lignes que la borne refuse sont
 * les quatre du 20/08, toutes à `@example.com` — pas une personne derrière. Le prix est assumé pour
 * la prochaine file oubliée, pas payé sur celle-ci : une inscription perdue se refait ; un e-mail
 * délivré ne se reprend pas.
 *
 * ⛔⛔ ET CETTE BORNE NE SUFFIT PAS — c'est le piège de ce fichier. Les quatre confirmations
 * Copper Kettle du 13/09 ont DEUX JOURS : elles passent l'âge, elles passent le jeton (prolongé au
 * 29/09), et elles partiraient à trois adresses grand public et une adresse interne au premier passage en
 * `live`. La borne d'âge périme le stock ANCIEN ; elle ne dit rien du stock RÉCENT. La seule parade
 * pour celui-là est le geste 0 bis de la checklist de `docs/WORKER.md` : COMPTER ce qui partirait
 * avant d'armer, et ne pas armer si le compte n'est pas zéro.
 */
export const OUTBOX_AGE_MAX_JOURS = 7;

export function gate(ctx: OutboxContext, now: Date = new Date()): GateDecision {
  const policy = POLICY[ctx.kind];
  if (!policy) return { send: false, reason: `unknown_kind:${ctx.kind}` };

  // ⛔ L'ÂGE D'ABORD, ET POUR TOUS LES KINDS SANS EXCEPTION (voir OUTBOX_AGE_MAX_JOURS).
  const misEnFile = new Date(ctx.created_at).getTime();
  // ⛔ Une date illisible ne vaut pas « fraîche ». On ne peut pas affirmer qu'une ligne est
  // récente si on ne sait pas quand elle a été écrite : on refuse plutôt que d'envoyer à l'aveugle.
  if (!Number.isFinite(misEnFile)) return { send: false, reason: "stale_outbox:unknown_date" };
  const jours = (now.getTime() - misEnFile) / 86_400_000;
  if (jours > OUTBOX_AGE_MAX_JOURS) {
    return { send: false, reason: `stale_outbox:${Math.floor(jours)}d` };
  }

  // Sans asset/édition/footer résolus, impossible de construire un envoi conforme.
  if (!ctx.asset_id || !ctx.compliance_regime || !ctx.legal_footer) {
    return { send: false, reason: "missing_context" };
  }

  // Suppression (liste do-not-send). Ré-évaluée au send-time dans la vue.
  // ⛔ Une colonne `hard_suppressed` ABSENTE (0073 pas appliquée) ou illisible ne vaut pas « pas
  // dure » : on retombe sur `suppressed`, c'est-à-dire le comportement d'avant.
  // ⛔ ET SEULEMENT POUR UNE SOUSCRIPTION ENCORE `pending` — celle d'une réinscription. Une
  // confirmation restée en file pour quelqu'un qui a été effacé (`deleted`) ou s'est désinscrit de
  // tout (`unsubscribed`) entre-temps ne part pas : l'exception est pour qui revient, pas pour qui part.
  const dureSeule =
    policy.suppressionDureSeule && ctx.sub_status === "pending" && typeof ctx.hard_suppressed === "boolean";
  /*
   * ⛔ L'ACCUSÉ DE DÉSINSCRIPTION : seule la suppression DURE compte, et elle doit être LUE. Une
   * colonne absente ou nulle ne vaut pas « pas dure » : sans elle on ne sait pas distinguer une
   * désinscription de tout (qui doit recevoir son accusé) d'une plainte (qui ne doit rien recevoir),
   * et dans le doute l'accusé ne part pas — il n'est qu'une politesse, une plainte ne se reprend pas.
   */
  const supprime = policy.accuseDeDepart
    ? ctx.hard_suppressed !== false
    : dureSeule
      ? ctx.hard_suppressed
      : ctx.suppressed;
  if (!policy.bypassSuppression && supprime) {
    return { send: false, reason: "suppressed" };
  }

  /*
   * ⛔ L'ACCUSÉ NE PART QU'À UNE SOUSCRIPTION ENCORE `unsubscribed` AU MOMENT DE PARTIR. Effacée
   * (`deleted`) entre-temps : la personne a demandé l'oubli, on ne lui écrit plus. Réinscrite
   * (`pending`/`active`) : l'accusé dirait le contraire de ce qu'elle vient de faire.
   */
  if (policy.accuseDeDepart && ctx.sub_status !== "unsubscribed") {
    return { send: false, reason: "not_unsubscribed" };
  }

  // ⛔ Le statut exigé vient du DÉCLENCHEUR, relu sur la ligne (voir `automation_tx`).
  if (policy.statutParDeclencheur) {
    const declencheur = ctx.payload?.automation_trigger;
    const exige = typeof declencheur === "string" && Object.hasOwn(TX_TRIGGER_STATUS, declencheur)
      ? TX_TRIGGER_STATUS[declencheur]
      : undefined;
    if (!exige) return { send: false, reason: "tx_trigger_not_allowed" };
    if (ctx.sub_status !== exige) return { send: false, reason: `not_${exige}` };
  }

  if (policy.finaliteObligatoire && !ctx.purpose) {
    return { send: false, reason: "missing_purpose" };
  }

  /*
   * ⛔ LES CONTACTS HORS NEWSLETTER (0088, décision d'Alix du 25/09/2026).
   *
   * Un contact (statut `contact`) n'a PAS demandé la newsletter : il ne reçoit que la campagne qui l'a
   * visé par « Newsletter: No ». La seule preuve de ce ciblage est la marque `audience: contacts` que
   * pose `enqueue_campaign_batch_contacts` — et rien d'autre ne l'écrit. D'où trois règles, toutes
   * fermées :
   *  - une ligne SANS la marque exige `active`, comme toujours : un contact n'y passe pas ;
   *  - une ligne AVEC la marque exige `contact`, et seulement pour `campaign` : un contact devenu
   *    abonné entre-temps, ou une marque trouvée sur un autre kind, ne partent pas ;
   *  - la finalité ne saute que si la ligne porte AUSSI `ignore_purpose: true` (la case de la
   *    campagne, recopiée par la fonction de mise en file).
   * Le statut exigé passe à `canSend` par `requiredStatus` : la décision reste celle du moteur
   * partagé, rien ne lui fait croire qu'un contact est actif.
   */
  const ligneContacts = ctx.payload?.audience === "contacts";
  if (ligneContacts && !policy.audienceContacts) return { send: false, reason: "contacts_not_allowed" };
  if (ligneContacts && ctx.sub_status !== "contact") return { send: false, reason: "not_contact" };
  const finaliteIgnoree = ligneContacts && ctx.payload?.ignore_purpose === true;

  // Statut (consentement actif) + FINALITÉ (marketing) — via le moteur partagé.
  if (!policy.bypassStatus) {
    const decision = canSend({
      status: ctx.sub_status ?? "unknown",
      requiredStatus: ligneContacts ? "contact" : "active",
      suppressed: false, // déjà vérifié ci-dessus (respecte bypassSuppression)
      usesTracking: false,
      trackingConsent: ctx.tracking_consent ?? false,
      // Gate par finalité uniquement pour le marketing (broadcast) ; les transactionnels non. Et pas
      // pour les contacts d'une campagne dont la case est cochée (voir juste au-dessus).
      purpose: policy.marketing && ctx.purpose && !finaliteIgnoree ? (ctx.purpose as ConsentPurpose) : undefined,
      grantedPurposes: ctx.granted_purposes ?? undefined,
      legalBasis: legalBasisForRegime(ctx.compliance_regime),
    });
    if (!decision.ok) return { send: false, reason: decision.reason };
  }

  const track = policy.allowTracking && canTrack({ trackingConsent: suiviAccepte(ctx) });
  return { send: true, track };
}

/**
 * Ce destinataire peut-il être suivi ? Le TYPE d'envoi est décidé à part (`allowTracking` de la
 * politique) ; la règle sur la PERSONNE (mode « pour tous » de la marque, refus explicite — 0092)
 * vit dans `@nf/config` (`trackingAccepted`), partagée avec l'écran de préférences.
 */
export function suiviAccepte(
  ctx: Pick<OutboxContext, "tracking_consent" | "tracking_mode" | "tracking_refused">,
): boolean {
  return trackingAccepted({
    trackingConsent: ctx.tracking_consent,
    trackingMode: ctx.tracking_mode,
    trackingRefused: ctx.tracking_refused,
  });
}
