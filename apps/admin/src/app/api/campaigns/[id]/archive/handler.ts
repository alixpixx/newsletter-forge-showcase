import { NextResponse } from "next/server";
import {
  cancelUpcomingOccurrences,
  findCampaign,
  updateCampaign,
  type CampaignRow,
  type estimateAudience,
  type findPublishedVersionRef,
} from "@/lib/data/campaigns";
import { jsonError, type Context, type requireContext } from "@/app/api/builder/_shared";
import { estUneSerie, quandDansLeFuseau } from "@/components/campaigns/cadence";
import { planDeReactivation, versLaBase, type ArchivedResume } from "@/lib/campaign-archive";
import { HORIZON_JOURS, apercuDeLaSerie, lireCadence, postArm, type Apercu } from "../arm/handler";
import { postSchedule } from "../schedule/handler";

/**
 * ARCHIVER ET RÉACTIVER UNE CAMPAGNE — `POST /archive`, `GET|POST /reactivate` (0077).
 *
 * ⭐ LA DEMANDE (Alix, 22/09/2026) : « sur chaque campagne un bouton archiver (avec un onglet archive
 * dans campagne) et quand on archive une campagne ça la met en pause (pause qu'on peut réactiver dans
 * la section archive) ». Archiver = RANGER **ET** METTRE HORS D'ÉTAT D'ENVOYER, selon l'état :
 *
 *   | état                     | Archive                                              | Reactivate                          |
 *   |--------------------------|------------------------------------------------------|-------------------------------------|
 *   | en cours d'envoi         | 409 — on n'archive pas un envoi en vol               | —                                   |
 *   | série en marche          | arrêt PUIS annulation des éditions à venir PUIS rangement | redémarre, par les refus de `/arm` |
 *   | envoi unique programmé   | retour brouillon (verrou gardé) ET rangement, d'un geste | reprogrammé, par les refus de `/schedule` ; date passée ⇒ brouillon |
 *   | brouillon, envoyée, annulée, en pause | rangement seul                          | retour dans la liste, tel quel      |
 *
 * ⛔ `archived_at` SEUL N'ARRÊTE RIEN côté worker (voir 0077) : c'est CETTE route qui arrête. La
 * ceinture du worker (une campagne archivée n'est ni planifiée, ni gelée, ni enfilée) tient ce que
 * l'annulation n'a pas pu toucher.
 *
 * ⛔ LA RÉACTIVATION NE CONTOURNE AUCUN GARDE. Elle APPELLE `postArm` et `postSchedule` — les mêmes
 * fonctions que les boutons « Start series » et « Schedule » — avec le contexte déjà résolu. Une
 * finalité manquante, un contenu déverrouillé, une version dépubliée depuis : la campagne revient
 * dans la liste, et la réponse dit pourquoi rien n'est reparti (207). Réécrire ces refus ici en
 * aurait fait une deuxième porte vers l'envoi, qui aurait fini par en oublier un.
 *
 * Module séparé des `route.ts` (qui ne peuvent exporter que leurs méthodes HTTP) : la session, la
 * version publiée (qui lit les cookies pour l'octroi), le compte d'audience et l'horloge sont injectés,
 * pour qu'un banc mesure les routes sans cookie, sans base et sans heure qui tourne.
 */

export interface ArchiveDeps {
  requireContext: () => ReturnType<typeof requireContext>;
  maintenant: () => Date;
}

export interface ReactivateDeps extends ArchiveDeps {
  /** `findPublishedVersionRef` en production — transmise telle quelle à `postArm`. */
  versionPubliee: typeof findPublishedVersionRef;
  /** `estimateAudience` en production — transmise telle quelle à `postSchedule`. */
  estimerAudience: typeof estimateAudience;
}

type Db = Context["db"];

/** Message dédié quand 0077 n'est pas encore appliquée — pas un 500 opaque. */
export function migrationArchivage(raw: string): string | null {
  return /archived_at|archived_resume|campaign_archive_pair|schema cache/i.test(raw)
    ? "archiving is not installed yet — migration 0077 has not been applied"
    : null;
}

/**
 * La trace d'un geste d'archivage. ⛔ AUCUNE donnée d'abonné dans `meta` : l'état de la campagne,
 * son nom, des dates et des compteurs — rien qui désigne une personne.
 *
 * ⚠️ Un audit raté ne défait PAS le geste (même règle que `holdCampaign` côté worker) : la campagne
 * EST archivée, le dire autrement mentirait. La réponse porte `audited: false`.
 */
async function journaliser(
  db: Db,
  ctx: Context,
  action: "campaign-archived" | "campaign-reactivated",
  campaign: CampaignRow,
  meta: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await db.from("audit_log").insert({
    actor: `admin:${ctx.user.email}`,
    action,
    target_type: "campaign",
    target_id: campaign.id,
    asset_id: ctx.asset.id,
    meta: { ...meta, campaign_name: campaign.name },
  });
  if (error) console.error(JSON.stringify({ event: `${action}-audit-failed`, message: error.message }));
  return !error;
}

/* ------------------------------------------------------------------ *
 * Archiver
 * ------------------------------------------------------------------ */

export async function postArchive(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: ArchiveDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  if (campaign.archivedAt) return jsonError("this campaign is already archived", 409);
  // ⛔ UN ENVOI EN VOL NE S'ARCHIVE PAS : la file est déjà écrite, les messages partent. Le ranger
  // ferait croire qu'on l'a arrêté, alors que rien ne peut plus l'arrêter d'ici.
  if (campaign.status === "sending") {
    return jsonError(
      "this campaign is sending right now — it cannot be archived until the send has finished",
      409,
      { status: campaign.status },
    );
  }

  const enMarche = estUneSerie(campaign) && campaign.recurrenceActive;
  const programmee = campaign.status === "scheduled";

  /*
   * ⛔ UNE SÉRIE EN MARCHE : ARRÊT, PUIS ANNULATION, PUIS RANGEMENT — jamais dans un autre ordre.
   *
   * Arrêter d'abord, sinon le planificateur recréerait aussitôt ce qu'on vient d'annuler (même
   * règle que `DELETE /arm?cancelUpcoming=1`, décision d'Alix du 18/09/2026). Annuler TOUJOURS : ni
   * le gel ni la mise en file ne lisent `recurrence_active`, une édition déjà planifiée partirait
   * série arrêtée. La confirmation de l'écran a listé ces dates AVANT le clic (`GET /arm`).
   * ⚠️ Une date annulée n'est JAMAIS recréée (`planner.ts`) : la réactivation ne la rattrapera pas.
   */
  let annulees: number | null = 0;
  let cancelError: string | null = null;
  if (enMarche) {
    const { error: stopErr } = await updateCampaign(db, id, asset.id, { recurrence_active: false });
    if (stopErr) {
      const friendly = migrationArchivage(stopErr);
      return jsonError(
        friendly ?? `the series could not be stopped, so nothing was archived: ${stopErr}`,
        friendly ? 503 : 500,
      );
    }
    const annulation = await cancelUpcomingOccurrences(db, id, asset.id);
    if (annulation.error) {
      // La série EST arrêtée : on continue, et la réponse dira les deux moitiés séparément (207).
      cancelError = annulation.error;
      annulees = null;
    } else {
      annulees = annulation.cancelled;
    }
  }

  const resume: ArchivedResume = {
    previousStatus: campaign.status,
    seriesRunning: enMarche,
    scheduledAt: programmee ? campaign.scheduledAt : null,
    editionsCancelled: annulees,
  };
  const maintenant = deps.maintenant().toISOString();

  /*
   * LE RANGEMENT, EN UNE SEULE ÉCRITURE — et pour un envoi programmé, le retrait du calendrier AVEC.
   *
   * ⛔ Les champs du retrait sont ceux de `/unschedule` (`status: draft`, `scheduled_at: null`,
   * `recipients_planned: null`) et RIEN d'autre : le verrou, le HTML figé et l'identifiant survivent,
   * pour que « Reactivate » puisse le remettre à sa date. ⛔ JAMAIS `/cancel`, qui est TERMINAL : on
   * ne revient pas d'une annulation, et archiver promet une pause.
   *
   * ⚠️ GARDÉE PAR LE STATUT LU ET PAR `archived_at is null`, et RELUE. Entre la lecture et cette
   * écriture, le fan-out a pu prendre l'envoi (`scheduled` → `sending`) ou un autre onglet a pu
   * archiver : l'écriture ne touche alors aucune ligne — et un UPDATE qui ne touche rien RÉUSSIT en
   * silence, d'où le `.select()`.
   */
  const patch: Record<string, unknown> = {
    archived_at: maintenant,
    archived_resume: versLaBase(resume),
    updated_at: maintenant,
    ...(programmee ? { status: "draft", scheduled_at: null, recipients_planned: null } : {}),
  };
  const { data: rangee, error: writeErr } = await db
    .from("campaign")
    .update(patch)
    .eq("id", id)
    .eq("asset_id", asset.id)
    .eq("status", campaign.status)
    .is("archived_at", null)
    .select("id");

  const dejaFait = enMarche
    ? ` The series was stopped${annulees && annulees > 0 ? ` and ${annulees} planned edition${annulees > 1 ? "s were" : " was"} cancelled` : ""} — start it again from its campaign page if that was not intended.`
    : "";
  if (writeErr) {
    const friendly = migrationArchivage(writeErr.message);
    return jsonError(
      friendly ?? `the campaign could not be archived: ${writeErr.message}.${dejaFait}`,
      friendly ? 503 : 500,
    );
  }
  if (!rangee || (rangee as unknown[]).length === 0) {
    return jsonError(
      `this campaign changed while it was being archived (it may have started sending) — reload the page and try again.${dejaFait}`,
      409,
    );
  }

  const audited = await journaliser(db, c.ctx, "campaign-archived", campaign, versLaBase(resume));

  return NextResponse.json(
    {
      ok: true,
      archivedAt: maintenant,
      resume,
      cancelled: annulees,
      audited,
      ...(cancelError ? { cancelError } : {}),
    },
    { status: cancelError ? 207 : 200 },
  );
}

/* ------------------------------------------------------------------ *
 * Réactiver
 * ------------------------------------------------------------------ */

/** Ce qui a été rétabli — la réponse le dit EXACTEMENT, l'écran ne le devine pas. */
export type Retabli =
  | { what: "series"; running: true; upcoming: Apercu | null }
  | { what: "series"; running: false; refusal: string }
  | { what: "scheduled"; scheduledAt: string; recipientsPlanned: number | null }
  | { what: "draft"; previousDate: string; pastDate: boolean; refusal: string | null }
  | { what: "list"; status: string };

/** La phrase d'écran — une seule, écrite ici, pour que la liste et la page disent la même chose. */
export function phraseDeReactivation(r: Retabli, timezone: string | null): string {
  switch (r.what) {
    case "series": {
      if (!r.running) {
        return `Back in the campaigns list, but the series did not start again: ${r.refusal}. Fix that, then start the series from its campaign page.`;
      }
      const up = r.upcoming;
      if (!up) return "Reactivated — the series is running again. Its next dates appear on the campaign page once the planner has created them.";
      if (up.count === 0) return `Reactivated — the series is running again, but no edition falls in the next ${HORIZON_JOURS} days. Check the cadence.`;
      return `Reactivated — the series is running again. First edition on ${quandDansLeFuseau(up.first, timezone)}, ${up.count} in the next ${HORIZON_JOURS} days.`;
    }
    case "scheduled":
      return `Reactivated — scheduled again for ${quandDansLeFuseau(r.scheduledAt, "UTC")}${
        r.recipientsPlanned === null ? "" : `, to ${r.recipientsPlanned.toLocaleString("en-US")} recipient${r.recipientsPlanned === 1 ? "" : "s"}`
      }.`;
    case "draft":
      return r.pastDate
        ? `Back in the campaigns list as a draft. Its send date (${quandDansLeFuseau(r.previousDate, "UTC")}) has passed, so nothing goes out: pick a new date on its page.`
        : `Back in the campaigns list as a draft, but it could not be scheduled again: ${r.refusal ?? "unknown reason"}. Its date was ${quandDansLeFuseau(r.previousDate, "UTC")}.`;
    case "list":
      return "Restored to the campaigns list. Nothing was running, so nothing starts.";
  }
}

/** Lit le corps JSON d'une réponse de route appelée en interne — sans jamais lever. */
async function corps(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function postReactivate(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: ReactivateDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);
  if (!campaign.archivedAt) return jsonError("this campaign is not archived — there is nothing to reactivate", 409);

  const plan = planDeReactivation(campaign, deps.maintenant().getTime());

  /*
   * 1. SORTIR DES ARCHIVES — D'ABORD. `/arm` et `/schedule` refusent une campagne archivée (le worker
   *    l'ignorerait) : c'est après ce retrait, et seulement après, qu'ils peuvent juger le reste. Dans
   *    l'autre ordre, un redémarrage réussi suivi d'un retrait raté laisserait une série « Running »
   *    rangée dans un onglet que le worker ne regarde pas.
   *    ⚠️ Gardée par `archived_at is not null` et relue : deux clics, deux onglets, une seule sortie.
   */
  const { data: sortie, error: sortieErr } = await db
    .from("campaign")
    .update({ archived_at: null, archived_resume: null, updated_at: deps.maintenant().toISOString() })
    .eq("id", id)
    .eq("asset_id", asset.id)
    .not("archived_at", "is", null)
    .select("id");
  if (sortieErr) {
    const friendly = migrationArchivage(sortieErr.message);
    return jsonError(friendly ?? `the campaign could not be taken out of the archive: ${sortieErr.message}`, friendly ? 503 : 500);
  }
  if (!sortie || (sortie as unknown[]).length === 0) {
    return jsonError("this campaign was already reactivated — reload the page", 409);
  }

  /*
   * 2. RÉTABLIR CE QUI TOURNAIT — PAR LES MÊMES PORTES QUE LES BOUTONS, jamais à côté. Le contexte
   *    déjà résolu est transmis : même session, même marque, aucune seconde lecture de cookie.
   */
  const memeContexte = async () => ({ ok: true as const, ctx: c.ctx });
  let retabli: Retabli;
  switch (plan.quoi) {
    case "serie": {
      const res = await postArm(new Request(req.url, { method: "POST" }), { params: Promise.resolve({ id }) }, {
        requireContext: memeContexte,
        versionPubliee: deps.versionPubliee,
        maintenant: deps.maintenant,
      });
      const b = await corps(res);
      retabli = res.ok
        ? { what: "series", running: true, upcoming: (b.upcoming ?? null) as Apercu | null }
        : { what: "series", running: false, refusal: String(b.error ?? `request failed (${res.status})`) };
      break;
    }
    case "programmee": {
      const res = await postSchedule(
        new Request(req.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scheduledAt: plan.scheduledAt }),
        }),
        { params: Promise.resolve({ id }) },
        {
          requireContext: memeContexte,
          estimerAudience: deps.estimerAudience,
          maintenant: () => deps.maintenant().getTime(),
        },
      );
      const b = await corps(res);
      retabli = res.ok
        ? {
            what: "scheduled",
            scheduledAt: String(b.scheduledAt ?? plan.scheduledAt),
            recipientsPlanned: typeof b.recipientsPlanned === "number" ? b.recipientsPlanned : null,
          }
        : {
            what: "draft",
            previousDate: plan.scheduledAt,
            pastDate: false,
            refusal: String(b.error ?? `request failed (${res.status})`),
          };
      break;
    }
    case "date-passee":
      // ⛔ UN ENVOI EN RETARD NE PART JAMAIS TOUT SEUL. Le reprogrammer « maintenant » serait un envoi
      // que personne n'a décidé ; `/schedule` le refuserait d'ailleurs (date passée). Brouillon, et
      // l'écran demande une nouvelle date.
      retabli = { what: "draft", previousDate: plan.scheduledAt, pastDate: true, refusal: null };
      break;
    case "liste":
      retabli = { what: "list", status: campaign.status };
      break;
  }

  const refuse = (retabli.what === "series" && !retabli.running) || (retabli.what === "draft" && !retabli.pastDate);
  const audited = await journaliser(db, c.ctx, "campaign-reactivated", campaign, {
    restored: retabli.what === "series" ? (retabli.running ? "series-running" : "series-stopped") : retabli.what,
    previous_status: campaign.archivedResume?.previousStatus ?? campaign.status,
    scheduled_at: retabli.what === "scheduled" ? retabli.scheduledAt : null,
    refusal: refuse ? ("refusal" in retabli ? retabli.refusal : null) : null,
  });

  return NextResponse.json(
    { ok: true, restored: retabli, message: phraseDeReactivation(retabli, campaign.timezone), audited },
    // 207 : la campagne EST sortie des archives, mais ce qui tournait n'a pas pu repartir. Les deux
    // moitiés sont dites séparément, comme `/arm` le fait pour l'annulation.
    { status: refuse ? 207 : 200 },
  );
}

/**
 * GET /reactivate — CE QUE LA RÉACTIVATION VA FAIRE, lu AVANT le clic.
 *
 * La confirmation dit exactement ce qui repart : la première édition et le nombre de destinataires
 * pour une série, la date pour un envoi unique. Les deux chiffres sont ceux que les routes
 * utiliseront (`apercuDeLaSerie` = le calcul de `/arm`, `estimateAudience` = celui de `/schedule`) :
 * une confirmation qui annoncerait un autre calcul promettrait autre chose que ce qui partira.
 * ⚠️ Un compte illisible rend `null` et sa raison, jamais un zéro.
 */
export async function getReactivate(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: ReactivateDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);
  if (!campaign.archivedAt) return jsonError("this campaign is not archived — there is nothing to reactivate", 409);

  const plan = planDeReactivation(campaign, deps.maintenant().getTime());
  const base = { archivedAt: campaign.archivedAt, resume: campaign.archivedResume, plan, timezone: campaign.timezone };

  if (plan.quoi !== "serie" && plan.quoi !== "programmee") return NextResponse.json(base);

  let upcoming: Apercu | null = null;
  if (plan.quoi === "serie") {
    const lue = await lireCadence(db, id, asset.id);
    upcoming = lue.ok ? await apercuDeLaSerie(db, id, asset.id, lue.cadence, deps.maintenant()) : null;
  }
  const audience = await deps.estimerAudience(db, asset.id, campaign.segmentId, campaign.purpose, {
    contactsIgnorePurpose: campaign.contactsIgnorePurpose,
  });
  return NextResponse.json({
    ...base,
    horizonDays: HORIZON_JOURS,
    upcoming,
    recipients: audience.eligible,
    recipientsReason: audience.reason,
  });
}
