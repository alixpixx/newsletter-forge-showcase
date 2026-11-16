import { NextResponse } from "next/server";
import { cancelUpcomingOccurrences, findCampaign, updateCampaign } from "@/lib/data/campaigns";
import { jsonError, readJson, type requireContext } from "@/app/api/builder/_shared";
import { MAX_EDITION_START, parseEditionStart } from "@/lib/edition-start";

/**
 * PATCH /api/campaigns/[id]/recurrence — enregistre (ou retire) la cadence d'une campagne.
 *
 * ⛔ ENREGISTRER N'EST PAS ARMER. Cette route écrit les jours, l'heure, le fuseau et la fin ; elle
 * ne met JAMAIS `recurrence_active` à vrai. Armer une série est un geste distinct, sur un écran
 * distinct, parce que c'est le geste qui fait exister des envois futurs. Une case cochée par
 * mégarde dans un assistant ne doit pas pouvoir programmer douze semaines d'e-mails.
 *
 * ⚠️ RIEN N'EST MATÉRIALISÉ ICI non plus : aucune occurrence n'est créée. Le matérialiseur (S-4)
 * est le seul écrivain de `campaign_occurrence`.
 *
 * Une campagne DÉJÀ VERROUILLÉE refuse la cadence : son contenu est figé pour une date précise, la
 * transformer en série renverrait ce même contenu figé à chaque occurrence — le défaut exact que
 * toute cette architecture existe pour rendre impossible.
 *
 * Module séparé de `route.ts` (qui ne peut exporter que ses méthodes HTTP) : la session et la date du
 * jour y sont injectées, pour qu'un banc mesure la route sans cookie ni horloge.
 */

export interface RecurrenceDeps {
  requireContext: () => ReturnType<typeof requireContext>;
  /** Jour UTC `YYYY-MM-DD` : borne la date de fin et sert d'ancre. */
  today: () => string;
}

interface RecurrenceBody {
  days?: unknown;
  time?: unknown;
  timezone?: unknown;
  everyWeeks?: unknown;
  until?: unknown;
  freezeLeadMinutes?: unknown;
  /** Numéro de la première édition (0067). Absent = inchangé. */
  editionStart?: unknown;
  /** `true` = retirer la cadence et redevenir une campagne ponctuelle. */
  clear?: unknown;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Message dédié quand les colonnes n'existent pas encore — pas un 500 opaque. */
function migrationMessage(raw: string): string | null {
  if (/edition_start/i.test(raw)) {
    return "the starting edition number is not installed yet — migration 0067 has not been applied";
  }
  return /recurrence_days|recurrence_time|column .* does not exist|schema cache/i.test(raw)
    ? "recurring campaigns are not installed yet — migration 0027 has not been applied"
    : null;
}

export async function patchRecurrence(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: RecurrenceDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  const body = await readJson<RecurrenceBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  /*
   * RETIRER LA CADENCE ANNULE AUSSI LES ÉDITIONS DÉJÀ PLANIFIÉES — décision d'Alix, 18/09/2026.
   *
   * ⛔ Ce geste-ci est le PLUS fort des trois : il éteint la série ET efface la cadence. Le laisser
   * conserver les éditions prévues alors que « Turn off », plus faible, les annule, en aurait fait
   * la porte dérobée du système : l'utilisateur qui veut tout arrêter aurait trouvé, sous le bouton
   * le plus définitif, le comportement le moins définitif.
   * ⛔ MÊME ORDRE QUE LE DÉSARMEMENT, pour la même raison : on écrit `recurrence_active: false`
   * d'abord. Dans l'autre ordre, le matérialiseur recréerait ce qu'on vient d'annuler.
   */
  if (body.clear === true) {
    const { error } = await updateCampaign(db, id, asset.id, {
      recurrence_days: null,
      recurrence_time: null,
      recurrence_anchor: null,
      recurrence_until: null,
      recurrence_active: false,
    });
    if (error) return jsonError(migrationMessage(error) ?? error, migrationMessage(error) ? 503 : 500);

    // La cadence EST retirée : un échec d'annulation ne doit pas se lire comme un échec du geste.
    // On rend 207 et les deux moitiés séparément, exactement comme le désarmement.
    const { cancelled, error: cancelErr } = await cancelUpcomingOccurrences(db, id, asset.id);
    if (cancelErr) {
      return NextResponse.json(
        { ok: true, recurring: false, cancelled: 0, cancelError: cancelErr },
        { status: 207 },
      );
    }
    return NextResponse.json({ ok: true, recurring: false, cancelled });
  }

  if (campaign.lockedAt) {
    return jsonError(
      "this campaign's content is frozen for a single date — unlock it first, then set a cadence",
      409,
    );
  }

  const days = Array.isArray(body.days)
    ? [...new Set(body.days.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort()
    : [];
  if (days.length === 0) return jsonError("pick at least one day of the week (1 = Monday … 7 = Sunday)", 400);

  const time = typeof body.time === "string" ? body.time.slice(0, 5) : "";
  if (!TIME_RE.test(time)) return jsonError("`time` must be HH:MM in 24-hour form", 400);

  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
  if (!timezone) return jsonError("`timezone` is required — a series cannot inherit the browser's zone", 400);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return jsonError(`unknown time zone "${timezone}"`, 400);
  }

  const everyWeeks = Math.min(8, Math.max(1, Math.trunc(Number(body.everyWeeks ?? 1)) || 1));

  const until = typeof body.until === "string" && DATE_RE.test(body.until) ? body.until : null;
  const today = deps.today();
  if (until !== null && until <= today) {
    return jsonError("the end date is today or in the past — the series would never send", 400);
  }

  const freeze = Math.min(1440, Math.max(0, Math.trunc(Number(body.freezeLeadMinutes ?? 90))));

  const editionStart = parseEditionStart(body.editionStart);
  if (editionStart === null) {
    return jsonError(`the first edition number must be a whole number between 1 and ${MAX_EDITION_START}`, 400);
  }

  /*
   * L'ANCRE du « une semaine sur N » est posée UNE FOIS, à l'enregistrement, et n'est plus touchée.
   * La recalculer à chaque lecture ferait glisser la parité : une série « une semaine sur deux »
   * enregistrée un mardi puis relue le mardi suivant changerait de semaine de référence, et
   * sauterait ou doublerait une édition sans que rien ne l'explique.
   */
  const anchor = today;

  const { error } = await updateCampaign(db, id, asset.id, {
    recurrence_days: days,
    recurrence_time: time,
    timezone,
    recurrence_every_weeks: everyWeeks,
    recurrence_anchor: anchor,
    recurrence_until: until,
    freeze_lead_minutes: freeze,
    ...(editionStart === undefined ? {} : { edition_start: editionStart }),
    // ⛔ Jamais `recurrence_active: true` ici. Voir l'en-tête.
  });

  if (error) {
    const friendly = migrationMessage(error);
    return NextResponse.json(
      { error: friendly ?? error, migrationMissing: Boolean(friendly) },
      { status: friendly ? 503 : 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    recurring: true,
    days,
    time,
    timezone,
    everyWeeks,
    until,
    anchor,
    freezeLeadMinutes: freeze,
    editionStart: editionStart ?? null,
    /** Toujours faux : l'armement est un autre geste. Renvoyé pour que l'écran ne le suppose pas. */
    active: false,
  });
}
