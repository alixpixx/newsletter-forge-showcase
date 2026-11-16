import { NextResponse } from "next/server";
import {
  SCHEDULABLE,
  findCampaign,
  updateCampaign,
  type CampaignStatus,
  type estimateAudience,
} from "@/lib/data/campaigns";
import { jsonError, readJson, type requireContext } from "@/app/api/builder/_shared";
import { resolveSendWhen } from "@/lib/send-when";

interface ScheduleBody {
  scheduledAt?: unknown;
  /** `true` = envoi immédiat, daté à l'heure du serveur. Exclusif de `scheduledAt`. */
  sendNow?: unknown;
}

/**
 * Module séparé de `route.ts` (qui ne peut exporter que ses méthodes HTTP) — sorti le 22/09/2026 pour
 * que la RÉACTIVATION d'un envoi archivé passe par CE contrôle-ci et par aucun autre : reprogrammer à
 * côté de `/schedule` aurait fait deux portes vers l'envoi, dont une sans les refus ci-dessous. Le
 * corps est celui de la route, à l'identique ; seuls la session, le compte d'audience et l'horloge
 * sont injectés, pour qu'un banc mesure la route sans cookie, sans base et sans heure qui tourne.
 */
export interface ScheduleDeps {
  requireContext: () => ReturnType<typeof requireContext>;
  /** `estimateAudience` en production. */
  estimerAudience: typeof estimateAudience;
  /** `Date.now` en production. */
  maintenant: () => number;
}

/**
 * POST /api/campaigns/[id]/schedule — engage la campagne pour une date.
 *
 * Chaque refus dit CE QUI manque et pas « invalid request » : l'utilisateur qui planifie a déjà
 * traversé quatre écrans, un message générique l'obligerait à tout rouvrir pour deviner.
 *
 * Les cinq exigences, et leur raison :
 *  - VERROUILLÉE : sans snapshot, le rendu envoyé dépendrait de l'état du modèle au moment du
 *    départ — donc d'une republication qui n'a rien à voir avec cette campagne.
 *  - DATE FUTURE : une date passée est soit une faute de frappe, soit un envoi immédiat déguisé.
 *    Les deux méritent un refus explicite plutôt qu'un départ surprise. L'envoi immédiat, lui,
 *    se DEMANDE (`sendNow: true`, 22/09/2026) et se date à l'heure du serveur.
 *  - SEGMENT : sans destinataires, il n'y a pas d'envoi à planifier.
 *  - FINALITÉ : le gate d'envoi (`canSend`) refuse tout destinataire n'ayant pas accordé CETTE
 *    finalité. Une campagne sans finalité serait intégralement bloquée au send, en silence.
 *  - SUJET NON VIDE : un email sans objet part directement en spam.
 *
 * ⛔ Planifier n'écrit RIEN dans `email_outbox` : la campagne devient `scheduled`, et c'est tout.
 * La mise en file reste à brancher (revue humaine requise avant de toucher 1 200 abonnés réels).
 */
export async function postSchedule(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: ScheduleDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  /*
   * ⛔ ARCHIVÉE (0077) : le fan-out ignore une campagne archivée. La planifier ici afficherait
   * « Scheduled » pour toujours sur un envoi que personne ne prendra — le blocage le plus silencieux
   * qui soit. La réactivation passe par ICI aussi, mais APRÈS avoir retiré `archived_at`.
   */
  if (campaign.archivedAt) {
    return jsonError("this campaign is archived — reactivate it from the Archived tab before scheduling it", 409, {
      status: campaign.status as CampaignStatus,
    });
  }

  if (!(SCHEDULABLE as readonly string[]).includes(campaign.status)) {
    return jsonError(
      campaign.status === "scheduled"
        ? "campaign is already scheduled — unschedule it before rescheduling"
        : `a ${campaign.status} campaign cannot be scheduled`,
      409,
      { status: campaign.status as CampaignStatus },
    );
  }

  /*
   * ⛔ UNE SÉRIE NE SE PLANIFIE PAS COMME UN ENVOI UNIQUE — ET LE REFUS EST NEUF (18/09/2026).
   *
   * Le fan-out ne ramasse les campagnes ponctuelles que si `recurrence_days is null`
   * (`apps/worker/src/fanout-db.ts`) : le filtre existe pour qu'une série ne parte pas deux fois,
   * une fois par son occurrence du jour et une fois par sa campagne-modèle. Conséquence jamais
   * dite à l'écran : une campagne qui porte une cadence et qu'on planifie ici n'est JAMAIS scannée.
   * Pas de refus, pas de `held`, pas de `paused`, pas de ligne d'audit — elle affiche « Scheduled »
   * pour toujours. C'était le blocage le plus silencieux du système.
   *
   * Une série part par ses ÉDITIONS : on la démarre (« Start series »), le planificateur crée les
   * dates. Le refus le dit.
   */
  if (campaign.recurrenceDays.length > 0) {
    return jsonError(
      "this campaign repeats — a series does not take a single send date. Start the series from its campaign " +
        "page and the planner will create each edition, or remove the cadence to send it once.",
      409,
      { status: campaign.status as CampaignStatus },
    );
  }

  const body = await readJson<ScheduleBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  // La date, OU l'envoi immédiat demandé en toutes lettres — voir `resolveSendWhen`.
  const quand = resolveSendWhen(body, deps.maintenant());
  if (!quand.ok) return jsonError(quand.error, 400);
  const { when, sendNow } = quand;

  // Les quatre prérequis d'ÉTAT sont évalués ensemble et renvoyés ensemble : les découvrir un par
  // un obligerait l'utilisateur à quatre allers-retours pour apprendre ce qu'on savait dès le
  // premier. `error` reste la raison la plus précise, `missing` donne le reste.
  // ⛔ Le segment n'est PAS un prérequis : sans lui, la campagne vise toute la marque. Ce qui
  // protège l'envoi n'est pas ce test mais la finalité juste en dessous, plus le compte figé plus
  // bas — lequel refuse encore, lui, une audience qu'on ne sait pas mesurer.
  const missing: string[] = [];
  if (!campaign.lockedAt) missing.push("campaign must be locked before scheduling — lock it to freeze its content");
  if (!campaign.purpose) missing.push("campaign has no purpose — without it the send gate rejects every recipient");
  if (campaign.subject.trim() === "") missing.push("campaign subject is empty");
  if (missing.length > 0) return jsonError(missing[0], 400, { missing });

  // Le compte planifié est figé ICI, avec la campagne : c'est ce qui permettra plus tard de
  // comparer « prévu » et « réellement envoyé ». Un compte nul (segment disparu, règle illisible)
  // fait échouer la planification — planifier vers une audience qu'on ne sait pas compter serait
  // signer un chèque en blanc.
  const audience = await deps.estimerAudience(db, asset.id, campaign.segmentId, campaign.purpose, {
    contactsIgnorePurpose: campaign.contactsIgnorePurpose,
  });
  if (audience.eligible === null) {
    return jsonError(`audience could not be counted: ${audience.reason ?? "unknown reason"}`, 400, {
      segmentId: campaign.segmentId,
      purpose: campaign.purpose,
    });
  }

  const { error } = await updateCampaign(db, id, asset.id, {
    status: "scheduled",
    scheduled_at: when.toISOString(),
    recipients_planned: audience.eligible,
  });
  if (error) return jsonError(error, 500);

  const scheduled = await findCampaign(db, id, asset.id);
  return NextResponse.json({
    campaign: scheduled,
    scheduledAt: when.toISOString(),
    sendNow,
    recipientsPlanned: audience.eligible,
    unsupported: audience.unsupported,
    // Dit explicitement ce qui n'a PAS eu lieu : aucune ligne n'a été mise en file d'envoi.
    queued: false,
  });
}
