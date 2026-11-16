import { NextResponse } from "next/server";
import {
  LOCKED_FIELDS,
  buildCampaignPatch,
  champsAPropager,
  findCampaign,
  nomsDesChamps,
  repointUpcomingOccurrences,
  updateCampaign,
  type CampaignBody,
  type findPublishedVersionRef,
} from "@/lib/data/campaigns";
import { jsonError, readJson, type requireContext } from "@/app/api/builder/_shared";

/**
 * PATCH /api/campaigns/[id] — modifie une campagne encore modifiable.
 *
 * Trois barrières, du plus fort au plus faible :
 *  1. `sending` / `sent` / `cancelled` : la campagne appartient au passé (ou est en train de
 *     partir). On ne réécrit pas ce qui est déjà chez les abonnés → 409.
 *  2. `scheduled` : elle est engagée pour une date. Seul le libellé interne (`name`) reste
 *     modifiable ; changer sujet, segment ou finalité derrière une planification serait un
 *     changement invisible du contrat → il faut annuler d'abord → 409.
 *  3. verrouillée (`locked_at`) : le CONTENU est figé (sujet, preheader, version de template).
 *     C'est tout l'intérêt du verrou : republier le modèle ne doit rien changer à cette
 *     campagne-là. Le ciblage (segment, finalité), lui, reste ajustable → 409 sur le contenu seul.
 *
 * `scheduledAt` n'est volontairement PAS modifiable ici : la planification passe par
 * `/schedule`, qui est le seul endroit où ses garde-fous sont appliqués.
 *
 * ⭐ ENREGISTRER LA CAMPAGNE REPOINTE LES ÉDITIONS À VENIR (décisions d'Alix du 25/09/2026 : « A » pour
 * la version, puis « même règle » pour le sujet, le preheader et le segment). Quand l'un de ces champs
 * CHANGE (`champsAPropager` ; une version `null` jamais), les éditions `planned` de la série datées
 * au-delà de la fenêtre de gel reçoivent les nouvelles valeurs DE CES CHAMPS-LÀ, et d'eux seuls
 * (`repointUpcomingOccurrences`). La réponse dit combien ont bougé, combien gardent les anciennes (déjà
 * en préparation, ou retenues), et quels champs ont suivi (`occurrencesFields`).
 * ⛔ ORDRE : la campagne d'abord, les éditions ensuite. Dans l'autre ordre, un échec de la campagne
 * laisserait des éditions sur une version que le plan ne porte pas, et le matérialiseur continuerait
 * d'en créer sur l'ancienne. Un échec de la seconde moitié rend 207 (campagne écrite, éditions non),
 * sur le modèle de `arm/route.ts`.
 *
 * Module séparé de `route.ts` (qui ne peut exporter que ses méthodes HTTP) : la session, la version
 * publiée (qui lit les cookies pour l'octroi) et l'horloge y sont injectées, pour qu'un banc mesure
 * la route sans cookie, sans base et sans heure qui tourne.
 */

export interface PatchCampaignDeps {
  requireContext: () => ReturnType<typeof requireContext>;
  /** `findPublishedVersionRef` en production — injectée : la vraie lit la session pour l'octroi. */
  versionPubliee: typeof findPublishedVersionRef;
  maintenant: () => Date;
}

export async function patchCampaign(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: PatchCampaignDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  if (campaign.status === "sending" || campaign.status === "sent" || campaign.status === "cancelled") {
    return jsonError(`campaign is ${campaign.status} and can no longer be edited`, 409, {
      status: campaign.status,
    });
  }

  const body = await readJson<CampaignBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const built = await buildCampaignPatch(db, asset.id, body, deps.versionPubliee);
  if (!built.ok) return jsonError(built.error, built.status);
  if (built.touched.length === 0) return jsonError("nothing to update", 400);

  if (campaign.status === "scheduled") {
    const beyondName = built.touched.filter((f) => f !== "name");
    if (beyondName.length > 0) {
      return jsonError(
        `campaign is scheduled — cancel it before changing ${beyondName.join(", ")}`,
        409,
        { status: campaign.status, blocked: beyondName },
      );
    }
  }

  if (campaign.lockedAt) {
    const frozen = built.touched.filter((f) => (LOCKED_FIELDS as readonly string[]).includes(f));
    if (frozen.length > 0) {
      return jsonError(
        `campaign content is locked — ${frozen.join(", ")} cannot change after lock`,
        409,
        { lockedAt: campaign.lockedAt, blocked: frozen },
      );
    }
  }

  const { error } = await updateCampaign(db, id, asset.id, built.patch);
  if (error) return jsonError(error, 500);

  /*
   * Quels champs d'édition ont CHANGÉ ? Seuls ceux-là repointent. ⛔ Un PATCH du nom, de la finalité ou
   * de la case des contacts, une valeur inchangée ou une version retirée (`null`) ne touchent AUCUNE
   * édition. ⛔ Pas de condition sur `recurrenceActive` : une série arrêtée sans annulation envoie
   * encore ses éditions planifiées.
   */
  const champs = champsAPropager(campaign, built.patch, built.touched);
  const noms = nomsDesChamps(champs);

  let occurrences: { moved: number; skippedInFreezeWindow: number; held: number } | undefined;
  if (noms.length > 0) {
    const r = await repointUpcomingOccurrences(db, id, asset.id, champs, {
      freezeLeadMinutes: campaign.freezeLeadMinutes,
      now: deps.maintenant(),
    });
    if (r.error) {
      // La campagne EST enregistrée : on ne rend pas une erreur qui ferait croire le contraire. On dit
      // ce qui a marché et ce qui n'a pas marché, dans la même réponse — comme `arm` et `recurrence`.
      const updated = await findCampaign(db, id, asset.id);
      return NextResponse.json(
        { campaign: updated, occurrences: null, occurrencesError: r.error, occurrencesFields: noms },
        { status: 207 },
      );
    }
    occurrences = { moved: r.moved, skippedInFreezeWindow: r.skippedInFreezeWindow, held: r.held };
  }

  const updated = await findCampaign(db, id, asset.id);
  return NextResponse.json(
    occurrences ? { campaign: updated, occurrences, occurrencesFields: noms } : { campaign: updated },
  );
}
