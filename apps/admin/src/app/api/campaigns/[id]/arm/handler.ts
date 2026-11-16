import { NextResponse } from "next/server";
import { findCampaign, updateCampaign, type findPublishedVersionRef } from "@/lib/data/campaigns";
import { ECHEANCES_A_VENIR } from "@/lib/data/occurrences";
import { jsonError, type requireContext } from "@/app/api/builder/_shared";

/**
 * POST /api/campaigns/[id]/arm — DÉMARRER une série (« Start series » à l'écran).
 *
 * ⛔ LE SEUL ÉCRIVAIN DE `recurrence_active = true` DU DÉPÔT. La route de cadence écrit la cadence
 * et JAMAIS cet interrupteur : enregistrer quand on veut, démarrer quand on a décidé. Le mot
 * « arm » survit dans l'URL et le code ; il a disparu de l'écran (Alix, 22/09/2026 : « c'est tjr
 * pas comprehensible a quoi ca sert »). À l'écran, une série est « Running » ou « Stopped ».
 *
 * ⚠️ CE QUE CE GESTE DÉCLENCHE. Démarrer rend la campagne visible du matérialiseur
 * (`listArmedPlans`), qui crée des occurrences `planned` puis les gèle 90 min avant chaque
 * échéance ; le fan-out les met en file à leur heure. Le worker tourne EN PRODUCTION (mesuré le
 * 22/09/2026 : deux séries ont déjà une édition envoyée) — ce bouton fait donc partir de vrais
 * e-mails, et chaque refus ci-dessous est le dernier moment où la personne qui peut corriger est
 * encore devant l'écran.
 *
 * ⛔ UNE SÉRIE N'EST JAMAIS VERROUILLÉE. Chaque édition se fige elle-même au gel ; une campagne
 * verrouillée est figée pour UNE date, et la répéter renverrait ce contenu figé à chaque édition.
 *
 * Module séparé de `route.ts` (qui ne peut exporter que ses méthodes HTTP) : la session, la version
 * publiée (qui lit les cookies pour l'octroi) et l'horloge y sont injectées, pour qu'un banc mesure
 * la route sans cookie, sans base et sans heure qui tourne.
 */

export interface ArmDeps {
  requireContext: () => ReturnType<typeof requireContext>;
  /** `findPublishedVersionRef` en production — injectée : la vraie lit la session pour l'octroi. */
  versionPubliee: typeof findPublishedVersionRef;
  maintenant: () => Date;
}

/** Les colonnes de cadence, absentes de `CampaignRow` (qui sert les écrans, pas la planification). */
export interface CadenceRow {
  recurrence_days: number[] | null;
  recurrence_time: string | null;
  recurrence_every_weeks: number | null;
  recurrence_anchor: string | null;
  recurrence_until: string | null;
  recurrence_active: boolean | null;
  timezone: string | null;
  freeze_lead_minutes: number | null;
}

const CADENCE_COLS =
  "recurrence_days, recurrence_time, recurrence_every_weeks, recurrence_anchor, " +
  "recurrence_until, recurrence_active, timezone, freeze_lead_minutes";

/** L'horizon du matérialiseur (`HORIZON_DAYS`, `apps/worker/src/planner.ts`) — l'aperçu dit le même. */
export const HORIZON_JOURS = 21;

/** Message dédié quand les colonnes n'existent pas encore — pas un 500 opaque. */
export function migrationMessage(raw: string): string | null {
  return /recurrence_days|recurrence_active|column .* does not exist|schema cache/i.test(raw)
    ? "recurring campaigns are not installed yet — migration 0027 has not been applied"
    : null;
}

/**
 * Ce que l'écran annonce après le démarrage : les éditions qui PARTIRONT dans l'horizon.
 * `null` = on ne sait pas le dire (lecture en échec) — jamais un zéro inventé.
 */
export interface Apercu {
  count: number;
  first: string | null;
  last: string | null;
  /**
   * Dates de la cadence, dans l'horizon, qui NE partiront PAS parce qu'elles existent déjà sous un
   * statut qui ne part plus (annulée, retenue…). Le matérialiseur ne recrée jamais un jour connu.
   */
  excluded: number;
}

/**
 * ⛔ UN APERÇU HONNÊTE, PAS LA CADENCE BRUTE.
 *
 * L'ancien aperçu comptait toutes les dates de la fonction SQL. Or le matérialiseur ne recrée JAMAIS
 * un jour déjà connu, annulé compris (`planner.ts`, l'ensemble `known`). Après « Stop » puis
 * « Resume », l'écran annonçait donc comme prochaines des dates annulées qui n'existeraient jamais :
 * « first on Tuesday », et mardi rien ne part.
 *
 * Règle, date par date (clé = `local_date`, comme le matérialiseur) :
 *  - aucune occurrence connue ⇒ elle sera créée ⇒ elle PART ;
 *  - au moins une occurrence `planned`/`frozen` ⇒ elle PART (la clé d'unicité autorise une date
 *    annulée puis re-planifiée à la main : les deux lignes coexistent) ;
 *  - sinon (annulée, retenue, en échec…) ⇒ elle ne part pas, et on la COMPTE à part.
 *
 * Exportée pour le banc : c'est ici que « annoncé » et « réel » doivent coïncider.
 */
export function apercuHonnete(
  calculees: { local_date?: unknown; fires_at?: unknown }[],
  connues: { local_date?: unknown; status?: unknown }[],
): Apercu {
  const partira = new Map<string, boolean>();
  for (const o of connues) {
    if (typeof o.local_date !== "string" || o.local_date === "") continue;
    const va = (ECHEANCES_A_VENIR as readonly string[]).includes(String(o.status ?? ""));
    partira.set(o.local_date, (partira.get(o.local_date) ?? false) || va);
  }
  let excluded = 0;
  const bornes: string[] = [];
  for (const r of calculees) {
    if (typeof r.fires_at !== "string" || r.fires_at === "") continue;
    const date = typeof r.local_date === "string" ? r.local_date : "";
    if (date !== "" && partira.get(date) === false) {
      excluded++;
      continue;
    }
    bornes.push(r.fires_at);
  }
  // ⛔ Tri sur des INSTANTS, pas sur des chaînes : PostgREST rend `+00:00` là où d'autres rendent `Z`.
  bornes.sort((a, b) => Date.parse(a) - Date.parse(b));
  return { count: bornes.length, first: bornes[0] ?? null, last: bornes.at(-1) ?? null, excluded };
}

export async function postArm(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: ArmDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  const lue = await lireCadence(db, id, asset.id);
  if (!lue.ok) {
    const friendly = migrationMessage(lue.error);
    return jsonError(friendly ?? lue.error, friendly ? 503 : 500);
  }
  const cadence = lue.cadence;

  /*
   * LES REFUS, DU PLUS STRUCTUREL AU PLUS RÉPARABLE. Chacun nomme ce qui manque ET où le corriger :
   * un refus qui dit seulement « impossible » oblige à deviner, et on finit par démarrer en SQL.
   */
  /*
   * ⛔ ARCHIVÉE (0077) : le worker ignore une campagne archivée. La démarrer ici afficherait
   * « Running » sur une série que le planificateur ne regardera jamais — le blocage muet que ce
   * fichier existe pour empêcher. La réactivation passe par ICI aussi, mais APRÈS avoir retiré
   * `archived_at` : ce refus ne la gêne pas, il interdit seulement le raccourci.
   */
  if (campaign.archivedAt) {
    return jsonError("this campaign is archived — reactivate it from the Archived tab to start it again", 409);
  }
  if (campaign.status === "cancelled" || campaign.status === "sent") {
    return jsonError(`this campaign is ${campaign.status} — create a new campaign to build a series`, 409);
  }
  if (campaign.lockedAt) {
    return jsonError(
      "this campaign's content is frozen for a single date — unlock it first, then start the series",
      409,
    );
  }
  if (!cadence.recurrence_days || cadence.recurrence_days.length === 0 || !cadence.recurrence_time) {
    return jsonError("no cadence saved yet — pick the days and the time first, then start the series", 409);
  }
  if (!cadence.timezone) {
    return jsonError("this campaign has no time zone — a series cannot inherit the browser's zone", 409);
  }
  if (!campaign.subject.trim()) {
    return jsonError("the campaign has no subject — every edition would be sent without one", 409);
  }
  /*
   * ⛔ LA FINALITÉ, REFUSÉE ICI COMME `/schedule` LA REFUSE POUR UN ENVOI UNIQUE (22/09/2026).
   * Le gate d'envoi rejette tout destinataire qui n'a pas accordé CETTE finalité : une série sans
   * finalité démarre, gèle, met en file… et chaque édition part à zéro destinataire, en silence,
   * semaine après semaine. `/schedule` la contrôlait ; `/arm` non — la série était le seul chemin
   * vers l'envoi où l'oubli passait.
   */
  if (!campaign.purpose) {
    return jsonError(
      "this campaign has no purpose — without it the send gate rejects every recipient. Pick one under Audience, then start the series",
      409,
    );
  }

  /*
   * LA PRÉCONDITION QUI COMPTE VRAIMENT. Sans version publiée de CETTE marque, le gel retient
   * chaque occurrence l'une après l'autre (« the selected template version is no longer a published
   * version of this brand ») : la série a l'air lancée, tourne, et n'envoie jamais rien.
   */
  if (!campaign.templateVersionId) {
    return jsonError("no template version selected — pick the content the series will send", 409);
  }
  if (!(await deps.versionPubliee(db, campaign.templateVersionId, asset.id))) {
    return jsonError(
      "the selected template version is not a published version of this brand — publish it first, or pick another",
      409,
    );
  }

  const { error } = await updateCampaign(db, id, asset.id, { recurrence_active: true });
  if (error) {
    const friendly = migrationMessage(error);
    return NextResponse.json({ error: friendly ?? error, migrationMissing: Boolean(friendly) }, { status: friendly ? 503 : 500 });
  }

  /*
   * ⛔ RELECTURE : ON NE DIT PAS « RUNNING » SUR LA FOI D'UN APPEL SANS ERREUR.
   *
   * `updateCampaign` ne demande pas son résultat à PostgREST : un UPDATE qui ne touche AUCUNE
   * ligne rend `error: null`, exactement comme un succès. C'est le geste qui fait exister des envois
   * futurs : il n'a pas droit à un écran vert obtenu par défaut. On relit la colonne, elle seule fait foi.
   */
  const { data: relu } = await db
    .from("campaign")
    .select("recurrence_active")
    .eq("id", id)
    .eq("asset_id", asset.id)
    .maybeSingle();
  if (!relu || (relu as { recurrence_active: boolean | null }).recurrence_active !== true) {
    return jsonError("the series could not be started — nothing was written, and it is not running", 500);
  }

  /*
   * CE QUI VA RÉELLEMENT PARTIR, pas seulement « c'est démarré ». La même fonction SQL que le
   * matérialiseur, la même fenêtre (horizon ET date de fin — l'ancien aperçu ignorait la fin), puis
   * les dates déjà connues retirées comme le matérialiseur les retire (`apercuHonnete`).
   *
   * ⚠️ Cette lecture ne peut plus faire échouer le démarrage : il a eu lieu. Si elle échoue, on rend
   * `upcoming: null` — « on ne sait pas » — et non un zéro qui se lirait « aucune date ne tombe ».
   */
  const apercu = await apercuDeLaSerie(db, id, asset.id, cadence, deps.maintenant());

  return NextResponse.json({ ok: true, active: true, horizonDays: HORIZON_JOURS, upcoming: apercu });
}

type Db = Parameters<typeof findCampaign>[0];

/**
 * Les colonnes de cadence d'une campagne, scopées marque. Sortie de `postArm` le 22/09/2026 pour que
 * l'APERÇU d'une réactivation (onglet Archived) lise la cadence EXACTEMENT comme le démarrage.
 */
export async function lireCadence(
  db: Db,
  id: string,
  assetId: string,
): Promise<{ ok: true; cadence: CadenceRow } | { ok: false; error: string }> {
  const { data: raw, error } = await db
    .from("campaign")
    .select(CADENCE_COLS)
    .eq("id", id)
    .eq("asset_id", assetId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, cadence: (raw ?? {}) as unknown as CadenceRow };
}

/**
 * CE QUI PARTIRA si la série tourne à partir de `from` — la même fonction SQL que le matérialiseur,
 * la même fenêtre (horizon ET date de fin), puis les dates déjà connues retirées (`apercuHonnete`).
 *
 * ⚠️ Sortie de `postArm` (22/09/2026) SANS en changer une requête : deux lecteurs — le démarrage, et
 * l'aperçu d'une réactivation qui annonce la première date AVANT le clic. Deux copies de ce calcul
 * annonceraient deux « first edition » pour la même série.
 *
 * `null` = on ne sait pas le dire (lecture en échec) — jamais un zéro inventé.
 */
export async function apercuDeLaSerie(
  db: Db,
  id: string,
  assetId: string,
  cadence: CadenceRow,
  from: Date,
): Promise<Apercu | null> {
  try {
    const horizon = new Date(from.getTime() + HORIZON_JOURS * 24 * 3600_000);
    // Même borne que le matérialiseur : `+1 jour` pour couvrir le dernier jour en entier, quel que
    // soit le fuseau — s'arrêter à minuit UTC couperait la dernière occurrence en Amérique.
    const fin = cadence.recurrence_until
      ? new Date(new Date(`${cadence.recurrence_until}T00:00:00Z`).getTime() + 24 * 3600_000)
      : null;
    const to = fin && fin < horizon ? fin : horizon;
    const { data: occ, error: occErr } = await db.rpc("campaign_occurrences", {
      p_days: cadence.recurrence_days,
      p_time: cadence.recurrence_time,
      p_timezone: cadence.timezone,
      p_every_weeks: cadence.recurrence_every_weeks ?? 1,
      p_anchor: cadence.recurrence_anchor ?? from.toISOString().slice(0, 10),
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_limit: 60,
    });
    if (occErr) return null;
    const { data: connues, error: connErr } = await db
      .from("campaign_occurrence")
      .select("local_date, status")
      .eq("campaign_id", id)
      .eq("asset_id", assetId);
    if (connErr) return null;
    return apercuHonnete(
      (occ ?? []) as { local_date?: unknown; fires_at?: unknown }[],
      (connues ?? []) as { local_date?: unknown; status?: unknown }[],
    );
  } catch {
    return null;
  }
}
