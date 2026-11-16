import { ALL_PURPOSES, legalBasisForRegime, purposeGateFilter, type ConsentPurpose } from "@nf/config";
import { isUuid } from "@/lib/data/templates";
import { canEditTemplate, getSessionUser } from "@/lib/session";
import { AUDIENCE_VIEW, compileRule, type Population, type RuleContext } from "@nf/segments/compile";
import type { RuleNode } from "@nf/segments/fields";
import { getDb } from "@/lib/supabase";
import { lireResume, type ArchivedResume } from "@/lib/campaign-archive";

/**
 * Accès serveur aux campagnes (`newsletter.campaign`).
 *
 * Une campagne est une INTENTION D'ENVOI : elle décrit quoi, à qui, quand — et fige le rendu au
 * moment du verrou. Elle ne met RIEN en file : `email_outbox` n'est jamais écrite ici.
 *
 * ⚠️ INVARIANT (identique aux templates) : tout est scopé par marque. Une campagne d'une autre
 * marque doit être indiscernable d'une campagne inexistante — 404, jamais 403.
 */

/* ------------------------------------------------------------------ *
 * Vocabulaire
 * ------------------------------------------------------------------ */

/** Doit rester aligné sur le CHECK de `newsletter.campaign.status` (migration 0018). */
export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "paused", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * Finalités : on réutilise `ALL_PURPOSES` de `@nf/config` plutôt que de recopier la liste.
 * C'est la MÊME énumération que celle du gate d'envoi (`canSend`) et que le CHECK de la colonne ;
 * la dupliquer ici garantirait qu'un jour l'admin propose une finalité que l'envoi refuse.
 */
export const CAMPAIGN_PURPOSES = ALL_PURPOSES;

/** Statuts depuis lesquels une annulation a encore un sens (rien n'est parti). */
export const CANCELLABLE: readonly CampaignStatus[] = ["draft", "scheduled", "paused"];

/** Statuts depuis lesquels une planification est possible. */
export const SCHEDULABLE: readonly CampaignStatus[] = ["draft", "paused"];

export const isCampaignPurpose = (v: string): v is ConsentPurpose =>
  (CAMPAIGN_PURPOSES as readonly string[]).includes(v);

/* ------------------------------------------------------------------ *
 * Lignes
 * ------------------------------------------------------------------ */

export interface CampaignRow {
  id: string;
  name: string;
  status: string;
  subject: string;
  preheader: string | null;
  templateVersionId: string | null;
  segmentId: string | null;
  purpose: string | null;
  scheduledAt: string | null;
  lockedAt: string | null;
  sentAt: string | null;
  recipientsPlanned: number | null;
  sizeBytes: number | null;
  updatedAt: string;
  /**
   * ⭐ CE QUE L'ENVOI A RÉELLEMENT PRODUIT — et il n'était lu par PERSONNE.
   *
   * ⛔ LE DÉFAUT QUE CES QUATRE COLONNES FERMENT (18/09/2026). L'écran de détail affichait dix faits,
   * tous issus du PLAN : statut, version, segment, destinataires *prévus*, date *planifiée*. Pas un
   * seul ne venait de la file d'envoi. Une campagne planifiée pour 20:45 dont rien n'était parti à
   * 21:00 affichait exactement la même chose qu'une campagne qui allait partir dans dix minutes —
   * « Scheduled », et rien d'autre. Vu d'Alix : « j'ai fait une campagne one shot et rien ne s'est
   * envoyé », sans qu'aucun écran ne puisse dire à quelle étape ça s'était arrêté.
   *
   * `enqueuedAt` est le fait qui tranche : il est posé par le fan-out du worker au moment où la file
   * est remplie. Nul avec une date planifiée passée = la mise en file n'a JAMAIS eu lieu, et la
   * cause est donc en amont de l'envoi (worker à l'arrêt, hors `live`, ou cron absent). Non nul avec
   * zéro envoi = la file s'est remplie et c'est le drain qui n'a pas suivi. Deux pannes qui ne se
   * règlent pas au même endroit, et que rien ne distinguait.
   *
   * Les trois compteurs sont écrits par la réconciliation (0040). `recipientsSkipped` porte les
   * refus du gate d'envoi — consentement, suppression, liste blanche — et c'est le seul chiffre qui
   * explique un « 1 prévu, 0 envoyé » sans la moindre erreur nulle part.
   */
  enqueuedAt: string | null;
  recipientsSent: number | null;
  recipientsFailed: number | null;
  recipientsSkipped: number | null;
  /**
   * L'interrupteur de mélange (migration 0049) : compléter les blocs classés par vues avec les
   * articles des 48 h que l'entrepôt ne sait pas encore mesurer.
   *
   * ⚠️ `false` et non `null` par défaut : la colonne est `not null default false`. Un booléen
   * nullable ferait apparaître un troisième état à l'écran (« non réglé ») qui n'existe pas.
   */
  mixLatest: boolean;
  /**
   * L'accroche et l'introduction écrites par le modèle au VERROUILLAGE (0055), pour une campagne
   * ponctuelle. Le pendant de ce que le gel écrit sur chaque occurrence d'une série.
   *
   * ⛔ `aiStatus = 'failed'` doit atteindre l'écran : la campagne se verrouille quand même — un
   * service tiers ne doit pas empêcher d'arrêter un contenu — mais elle partira sans son
   * introduction, et rien d'autre ne le dirait. NULL = aucun jeton IA, aucun appel.
   */
  aiStatus: string | null;
  aiReason: string | null;
  aiIntro: string | null;
  aiPreheader: string | null;
  /**
   * LA CADENCE D'UNE SÉRIE, telle qu'elle est en base.
   *
   * ⛔ Ces colonnes étaient ÉCRITES par `/api/campaigns/[id]/recurrence` et relues par PERSONNE :
   * aucun écran ne les affichait, et l'assistant ne se rouvre pas sur une campagne existante. Vu de
   * l'utilisateur, une série enregistrée avec succès n'existait nulle part — « rien ne se
   * sauvegarde » (18/09/2026). Écrire sans relire, c'est écrire dans le vide.
   *
   * `recurrenceDays` vide = campagne ponctuelle. `recurrenceActive` = la série est ARMÉE (seul
   * `/arm` le pose) ; une cadence enregistrée mais non armée ne crée aucune occurrence, et l'écran
   * doit pouvoir dire cette différence.
   */
  recurrenceDays: number[];
  recurrenceTime: string | null;
  recurrenceEveryWeeks: number | null;
  recurrenceUntil: string | null;
  recurrenceActive: boolean;
  timezone: string | null;
  freezeLeadMinutes: number | null;
  editionStart: number | null;
  /**
   * RANGÉE DANS L'ONGLET « Archived » depuis cet instant (0077), `null` = active.
   *
   * ⛔ ARCHIVÉE NE VEUT PAS DIRE INTROUVABLE. `findCampaign` ne filtre PAS cette colonne : c'est le
   * garde 404 de toutes les routes d'une campagne, y compris celle qui la réactive, et le lien profond
   * de Délivrabilité doit continuer d'ouvrir une campagne archivée. Seule la LISTE sépare les onglets.
   */
  archivedAt: string | null;
  /** Ce que « Reactivate » rétablira — `null` si et seulement si la campagne n'est pas archivée. */
  archivedResume: ArchivedResume | null;
  /**
   * LA CASE « envoyer aux contacts sans leur finalité » (0088, décision d'Alix du 25/09/2026).
   *
   * Ne joue QUE si le segment vise les contacts (« Newsletter: No ») : les abonnés newsletter gardent
   * leur barrière de finalité entière, case cochée ou non. ⛔ `=== true` : une colonne absente se lit
   * « barrière appliquée », jamais l'inverse.
   */
  contactsIgnorePurpose: boolean;
}

type Db = NonNullable<ReturnType<typeof getDb>>;

/**
 * Colonnes exposées. `html_shell` / `text_shell` n'y sont JAMAIS : le snapshot pèse jusqu'à
 * 100 Ko et n'a aucun usage côté liste ou détail — seul le worker le lit, via `outbox_context`.
 */
export const CAMPAIGN_SELECT =
  "id, name, status, subject, preheader, template_version_id, segment_id, purpose, " +
  "scheduled_at, locked_at, sent_at, recipients_planned, size_bytes, updated_at, mix_latest, " +
  "ai_status, ai_reason, ai_intro, ai_preheader, " +
  // L'état RÉEL de l'envoi : écrit par le fan-out (0037) et la réconciliation (0040), relu par
  // personne jusqu'au 18/09/2026. Voir le commentaire sur `enqueuedAt`.
  "enqueued_at, recipients_sent, recipients_failed, recipients_skipped, " +
  // La cadence : écrite depuis 0027/0067, jamais relue jusqu'au 18/09/2026.
  "recurrence_days, recurrence_time, recurrence_every_weeks, recurrence_until, recurrence_active, " +
  "timezone, freeze_lead_minutes, edition_start, " +
  // L'archivage (0077). ⛔ La migration passe AVANT ce code : sans la colonne, PostgREST refuse la
  // lecture et TOUTE lecture de campagne de l'admin tombe avec elle.
  "archived_at, archived_resume, " +
  // La case des contacts hors newsletter (0088, appliquée le 25/09/2026 AVANT ce code).
  "contacts_ignore_purpose";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Exportée pour le banc : c'est ICI que la cadence passe de la base à l'écran. */
export function mapCampaign(raw: unknown): CampaignRow {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    status: String(r.status ?? "draft"),
    subject: String(r.subject ?? ""),
    preheader: str(r.preheader),
    templateVersionId: str(r.template_version_id),
    segmentId: str(r.segment_id),
    purpose: str(r.purpose),
    scheduledAt: str(r.scheduled_at),
    lockedAt: str(r.locked_at),
    sentAt: str(r.sent_at),
    recipientsPlanned: num(r.recipients_planned),
    sizeBytes: num(r.size_bytes),
    updatedAt: String(r.updated_at ?? ""),
    enqueuedAt: str(r.enqueued_at),
    // ⛔ `num()` et non `?? 0` : « la réconciliation n'est jamais passée » et « elle a compté zéro »
    // sont deux faits différents, et c'est précisément leur différence qui dit où chercher.
    recipientsSent: num(r.recipients_sent),
    recipientsFailed: num(r.recipients_failed),
    recipientsSkipped: num(r.recipients_skipped),
    // ⛔ `=== true`, jamais `Boolean(...)` : une valeur absente (colonne pas encore en cache
    // PostgREST) doit se lire « pas de mélange », pas « valeur douteuse promue en oui ».
    mixLatest: r.mix_latest === true,
    aiStatus: str(r.ai_status),
    aiReason: str(r.ai_reason),
    aiIntro: str(r.ai_intro),
    aiPreheader: str(r.ai_preheader),
    // ⛔ Un tableau, jamais `null` : « pas de jours » et « colonne absente » se lisent tous deux
    // « campagne ponctuelle », et un `null` obligerait chaque écran à s'en souvenir.
    recurrenceDays: Array.isArray(r.recurrence_days)
      ? (r.recurrence_days as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
      : [],
    // `time without time zone` revient en "10:00:00" : on garde "10:00", ce que l'écran affiche.
    recurrenceTime: str(r.recurrence_time)?.slice(0, 5) ?? null,
    recurrenceEveryWeeks: num(r.recurrence_every_weeks),
    recurrenceUntil: str(r.recurrence_until),
    recurrenceActive: r.recurrence_active === true,
    timezone: str(r.timezone),
    freezeLeadMinutes: num(r.freeze_lead_minutes),
    editionStart: num(r.edition_start),
    archivedAt: str(r.archived_at),
    // ⛔ Le résumé n'est lu que sur une campagne archivée : un résumé orphelin (la contrainte de
    // 0077 l'interdit, mais une lecture ne parie pas sur l'écriture) ne doit rien faire redémarrer.
    archivedResume: r.archived_at ? lireResume(r.archived_resume) : null,
    contactsIgnorePurpose: r.contacts_ignore_purpose === true,
  };
}

/**
 * Campagnes de la marque courante, les plus récentes d'abord — celles d'UN onglet.
 * `assetId === null` (base injoignable) → liste vide : on préfère un écran vide honnête à
 * l'agrégat des 9 marques.
 *
 * ⛔ `archived` CHOISIT L'ONGLET, et chaque onglet ne montre QUE le sien : une campagne archivée
 * dans la liste active se relirait « elle tourne encore » ; une active dans l'onglet Archived
 * proposerait « Reactivate » sur ce qui n'a jamais été arrêté. Défaut : l'onglet actif.
 */
export async function listCampaigns(
  assetId: string | null,
  opts: { archived?: boolean } = {},
): Promise<CampaignRow[]> {
  const db = getDb();
  if (!db || !assetId) return [];
  return lireCampagnes(db, assetId, opts);
}

/** Même lecture, client injecté — exportée pour le banc (la liste d'un onglet ne se devine pas). */
export async function lireCampagnes(
  db: Db,
  assetId: string,
  { archived = false }: { archived?: boolean } = {},
): Promise<CampaignRow[]> {
  const base = db.from("campaign").select(CAMPAIGN_SELECT).eq("asset_id", assetId);
  const filtree = archived ? base.not("archived_at", "is", null) : base.is("archived_at", null);
  // L'onglet Archived se lit dans l'ordre où l'on a rangé : la dernière archivée en tête.
  const { data, error } = await (archived
    ? filtree.order("archived_at", { ascending: false })
    : filtree.order("created_at", { ascending: false }));

  if (error || !data) return [];
  return (data as unknown[]).map(mapCampaign);
}

/**
 * Combien de campagnes dans CHAQUE onglet — le compteur d'un onglet nomme ce qu'il compte, et
 * l'onglet d'à côté doit pouvoir dire son chiffre sans charger sa liste.
 *
 * `null` = compte illisible (jamais un zéro inventé : « aucune archivée » et « je n'ai pas pu
 * compter » n'appellent pas le même geste).
 */
export async function compterCampagnesParOnglet(
  db: Db,
  assetId: string,
): Promise<{ active: number | null; archived: number | null }> {
  const compter = async (archivees: boolean) => {
    const base = db.from("campaign").select("id", { count: "exact", head: true }).eq("asset_id", assetId);
    const { count, error } = await (archivees ? base.not("archived_at", "is", null) : base.is("archived_at", null));
    return error ? null : (count ?? 0);
  };
  const [active, archived] = await Promise.all([compter(false), compter(true)]);
  return { active, archived };
}

/** Une campagne de la marque, ou `null` (inexistante OU appartenant à une autre marque). */
export async function getCampaign(id: string, assetId: string): Promise<CampaignRow | null> {
  const db = getDb();
  if (!db) return null;
  return findCampaign(db, id, assetId);
}

/**
 * Même lecture, mais avec le client déjà résolu par la route (évite un second `getDb()`).
 *
 * ⛔ NE FILTRE JAMAIS `archived_at`. C'est le garde 404 COMMUN de toutes les routes d'une campagne :
 * le filtrer ferait répondre « introuvable » à la route qui réactive, à celle qui affiche la fiche,
 * et au lien profond de Délivrabilité — une campagne rangée deviendrait une campagne perdue. Chaque
 * route qui doit refuser une archivée le fait elle-même, en le DISANT (409, pas 404).
 */
export async function findCampaign(db: Db, id: string, assetId: string): Promise<CampaignRow | null> {
  // Un id non-uuid ne peut désigner aucune ligne : on l'écarte avant PostgREST (qui répondrait 400).
  if (!isUuid(id)) return null;
  const { data } = await db
    .from("campaign")
    .select(CAMPAIGN_SELECT)
    .eq("id", id)
    .eq("asset_id", assetId)
    .maybeSingle();
  return data ? mapCampaign(data) : null;
}

/**
 * Les actions du worker qui expliquent qu'une campagne ne soit pas partie. Il n'y en a que deux, et
 * elles ne disent PAS la même chose : `campaign-held` = arrêtée, un humain doit trancher ;
 * `campaign-fanout-error` = la mise en file a échoué, la campagne a été rendue à `scheduled` et sera
 * reprise — donc si cette ligne se répète, la reprise est une boucle sans fin.
 */
export const INCIDENTS_DE_CAMPAGNE = ["campaign-held", "campaign-fanout-error"] as const;

export interface CampaignIncident {
  action: string;
  reason: string;
  at: string;
}

/**
 * ⭐ POURQUOI LE WORKER N'A PAS FAIT PARTIR CETTE CAMPAGNE — et c'est la SEULE source qui existe.
 *
 * ⛔ LE DÉFAUT QUE CETTE LECTURE FERME (18/09/2026). `newsletter.campaign` n'a pas de colonne
 * `hold_reason` — l'occurrence d'une série, si. Quand le fan-out arrête une campagne PONCTUELLE, il
 * écrit donc sa raison dans `audit_log` et rien d'autre. Or aucun écran de l'admin ne lisait
 * `audit_log` : zéro occurrence du mot dans tout `apps/admin/src`. Résultat, une série arrêtée
 * affichait « Nothing went out » avec sa raison, et une campagne ponctuelle arrêtée pour EXACTEMENT
 * la même cause affichait « Paused », point. La même panne, lisible d'un côté, muette de l'autre.
 *
 * ⚠️ ELLE NE JETTE JAMAIS ET NE FAIT JAMAIS TOMBER LA PAGE. Un incident absent est le cas NORMAL
 * (la campagne va bien) ; une table illisible ne doit pas coûter l'écran de détail tout entier.
 * Dans les deux cas : `null`, et la page affiche le reste.
 *
 * ⚠️ SCOPÉE MARQUE comme tout le reste : `target_id` seul laisserait lire l'incident d'une campagne
 * d'une autre marque à qui devinerait un identifiant.
 */
export async function dernierIncidentDeCampagne(
  db: Db,
  campaignId: string,
  assetId: string,
): Promise<CampaignIncident | null> {
  if (!isUuid(campaignId)) return null;
  const { data, error } = await db
    .from("audit_log")
    .select("action, meta, created_at")
    .eq("target_type", "campaign")
    .eq("target_id", campaignId)
    .eq("asset_id", assetId)
    .in("action", [...INCIDENTS_DE_CAMPAGNE])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;

  const r = data as { action?: unknown; meta?: unknown; created_at?: unknown };
  const meta = (r.meta ?? {}) as Record<string, unknown>;
  const raison = str(meta.reason);
  return {
    action: String(r.action ?? ""),
    // ⛔ Jamais une chaîne vide : un bandeau « arrêtée pour : » suivi de rien se lit comme un bogue
    // d'affichage, et masque le fait — la campagne EST arrêtée — derrière un doute sur l'écran.
    reason: raison && raison.trim() !== "" ? raison : "no reason recorded",
    at: String(r.created_at ?? ""),
  };
}

/** Écriture scopée marque + `updated_at` rafraîchi (la table n'a pas de trigger). */
export async function updateCampaign(
  db: Db,
  id: string,
  assetId: string,
  patch: Record<string, unknown>,
): Promise<{ error: string | null }> {
  const { error } = await db
    .from("campaign")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("asset_id", assetId);
  return { error: error?.message ?? null };
}

/**
 * LES ÉDITIONS QU'UN HUMAIN PEUT ENCORE ARRÊTER — la frontière, écrite UNE fois.
 *
 * `planned` (rien n'est décidé), `held` (le matérialiseur l'a retenue) et `frozen` (le contenu est
 * arrêté mais rien n'est parti). ⛔ `sending` est EXCLU : la file est déjà écrite, prétendre
 * l'annuler d'un clic serait mentir. `sent`, `failed` et `cancelled` sont terminaux.
 *
 * ⚠️ Cette liste vivait en double — un tableau dans `arm/route.ts`, trois comparaisons `!==` dans
 * `occurrences/[id]/cancel/route.ts` — et un troisième geste (retirer la cadence) allait en écrire
 * une de plus. Deux listes qui doivent dire la même chose finissent par diverger en silence, et le
 * jour où elles divergent un écran annule ce qu'un autre déclare intouchable.
 */
export const OCCURRENCES_ARRETABLES: readonly string[] = ["planned", "frozen", "held"];

/**
 * Annule les éditions À VENIR d'une campagne — le geste, écrit une fois lui aussi.
 *
 * ⛔ L'APPELANT DOIT AVOIR DÉSARMÉ AVANT. Dans l'autre ordre, une série encore active verrait le
 * matérialiseur recréer aussitôt ce qu'on vient d'annuler : le geste produirait l'inverse de ce
 * qu'il annonce.
 * ⛔ `scheduled_at >= maintenant` : une édition dont l'heure est passée n'est plus « à venir », et
 * l'annuler après coup réécrirait une ligne que le worker est peut-être en train de lire.
 *
 * Rend le NOMBRE annulé, jamais un booléen : l'écran doit pouvoir dire « 4 annulées », et « ça a
 * marché » ne se vérifie contre rien.
 */
export async function cancelUpcomingOccurrences(
  db: Db,
  campaignId: string,
  assetId: string,
): Promise<{ cancelled: number; error: string | null }> {
  const { data, error } = await db
    .from("campaign_occurrence")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("campaign_id", campaignId)
    .eq("asset_id", assetId)
    .in("status", OCCURRENCES_ARRETABLES)
    .gte("scheduled_at", new Date().toISOString())
    .select("id");
  if (error) return { cancelled: 0, error: error.message };
  return { cancelled: (data ?? []).length, error: null };
}

/**
 * Le délai de gel par défaut, en minutes — celui de la colonne (`campaign.freeze_lead_minutes int not
 * null default 90`, migration 0027) et du repli du worker (`listOccurrencesToFreeze`, `?? 90`).
 */
export const DELAI_DE_GEL_PAR_DEFAUT_MIN = 90;

/**
 * La marge ajoutée au délai de gel : UNE période du cron `plan` du worker (toutes les 10 min,
 * `docs/WORKER.md`). Une édition qui entre dans sa fenêtre de gel d'ici là peut être prise par la
 * prochaine passe : on ne la déplace pas sous ses pieds.
 */
export const MARGE_AVANT_GEL_MS = 10 * 60_000;

/**
 * L'instant à partir duquel une édition `planned` peut encore changer de version sans croiser le gel :
 * `maintenant + délai de gel de la campagne + marge`. Exporté pour que l'écran annonce le MÊME compte
 * que ce que l'enregistrement déplace.
 */
export function seuilDeRepointage(now: Date, freezeLeadMinutes: number | null | undefined): Date {
  const lead =
    typeof freezeLeadMinutes === "number" && Number.isFinite(freezeLeadMinutes) && freezeLeadMinutes >= 0
      ? freezeLeadMinutes
      : DELAI_DE_GEL_PAR_DEFAUT_MIN;
  return new Date(now.getTime() + lead * 60_000 + MARGE_AVANT_GEL_MS);
}

export interface RepointResult {
  /** Éditions `planned`, datées au-delà du seuil, qui portent désormais les nouvelles valeurs. */
  moved: number;
  /**
   * Éditions à venir qui GARDENT leurs valeurs parce que leur contenu est déjà arrêté (`frozen`) ou le
   * sera avant la prochaine passe du worker (`planned` sous le seuil).
   */
  skippedInFreezeWindow: number;
  /** Éditions retenues (`held`) à venir : jamais touchées, comptées pour que l'écran le DISE. */
  held: number;
  error: string | null;
}

/**
 * LES CHAMPS D'UNE ÉDITION QUE L'ENREGISTREMENT DE SA CAMPAGNE RÉÉCRIT — exactement ceux que le
 * matérialiseur copie de la campagne dans chaque occurrence à sa création (`apps/worker/src/planner.ts`,
 * `materializeOne`), sous la MÊME forme : `subject ?? ""`, les trois autres tels quels.
 *
 * Une clé ABSENTE = le champ n'a pas changé : il n'est ni écrit, ni compté. ⚠️ `null` est une valeur
 * (preheader vidé, segment retiré), pas une absence.
 */
export interface ChampsDEdition {
  template_version_id?: string;
  subject?: string;
  preheader?: string | null;
  segment_id?: string | null;
}

/** Chaque colonne propagée, et son nom dans le corps du PATCH — celui que la réponse et l'écran disent. */
export const CHAMPS_D_EDITION = [
  ["template_version_id", "templateVersionId"],
  ["subject", "subject"],
  ["preheader", "preheader"],
  ["segment_id", "segmentId"],
] as const;

type ColonneDEdition = (typeof CHAMPS_D_EDITION)[number][0];

/**
 * Deux valeurs d'un champ d'édition disent-elles la même chose ?
 *
 * Sujet et preheader : `null` et `""` OUI — le gel retombe sur ceux du modèle dans les deux cas
 * (`row.subject?.trim() ? row.subject : version.subject`). ⛔ Sans cette équivalence, « Save content »,
 * qui envoie TOUJOURS `preheader: ""` quand le champ est vide, annoncerait « preheader » mis à jour sur
 * une série dont le preheader n'a jamais existé, et réécrirait trois semaines d'éditions pour rien.
 */
export function memeValeurDEdition(colonne: ColonneDEdition, a: unknown, b: unknown): boolean {
  if (colonne === "subject" || colonne === "preheader") return (a ?? "") === (b ?? "");
  return a === b;
}

/**
 * CE QUE L'ENREGISTREMENT D'UNE CAMPAGNE RÉPERCUTE SUR SES ÉDITIONS À VENIR — décisions d'Alix du
 * 25/09/2026 : « A » pour la version, puis « même règle » pour le sujet, le preheader et le segment.
 *
 * Un champ n'y entre que s'il est dans le corps (`touched`) ET qu'il CHANGE la valeur enregistrée.
 *  - ⛔ Version retirée (`null`) : n'entre JAMAIS. Une édition sans version est retenue au gel (« no
 *    template version selected »), et c'était déjà la règle du repointage.
 *  - Segment retiré (`null`) : entre. Sans segment, le fan-out vise toute la marque sous la même vue
 *    d'envoi et la même barrière de finalité (`fanout.ts`, `preflight` ne l'exige pas) — c'est aussi ce
 *    que le matérialiseur copierait dans l'édition suivante. Aucun état que l'envoi refuse n'est créé.
 */
export function champsAPropager(
  campagne: Pick<CampaignRow, "templateVersionId" | "subject" | "preheader" | "segmentId">,
  patch: Record<string, unknown>,
  touched: readonly string[],
): ChampsDEdition {
  const champs: ChampsDEdition = {};

  const version = patch.template_version_id;
  if (
    touched.includes("templateVersionId") &&
    typeof version === "string" &&
    version !== "" &&
    version !== campagne.templateVersionId
  ) {
    champs.template_version_id = version;
  }

  if (touched.includes("subject")) {
    const sujet = (patch.subject as string | null | undefined) ?? "";
    if (!memeValeurDEdition("subject", sujet, campagne.subject)) champs.subject = sujet;
  }

  if (touched.includes("preheader")) {
    const preheader = (patch.preheader as string | null | undefined) ?? null;
    if (!memeValeurDEdition("preheader", preheader, campagne.preheader)) champs.preheader = preheader;
  }

  if (touched.includes("segmentId")) {
    const segment = (patch.segment_id as string | null | undefined) ?? null;
    if (!memeValeurDEdition("segment_id", segment, campagne.segmentId)) champs.segment_id = segment;
  }

  return champs;
}

/** Les noms (ceux du corps du PATCH) des champs que `champs` porte, dans l'ordre de `CHAMPS_D_EDITION`. */
export function nomsDesChamps(champs: ChampsDEdition): string[] {
  return CHAMPS_D_EDITION.filter(([colonne]) => champs[colonne] !== undefined).map(([, nom]) => nom);
}

/**
 * ENREGISTRER UNE CAMPAGNE REPOINTE SES ÉDITIONS À VENIR — décisions d'Alix du 25/09/2026 : « A » pour
 * la version, puis « même règle » pour le sujet, le preheader et le segment.
 *
 * ⛔ LE DÉFAUT QUE CETTE FONCTION FERME. Le matérialiseur COPIE la version, le sujet, le preheader et le
 * segment de la campagne dans chaque occurrence à sa création (horizon 21 jours), et le gel comme le
 * fan-out lisent ceux de l'OCCURRENCE. Modifier l'un d'eux sur une série ne changeait donc que les
 * éditions créées APRÈS : les trois semaines déjà matérialisées partaient avec l'ancien, alors que
 * l'écran affichait le nouveau.
 *
 * ⛔ PUBLIER NE REPOINTE RIEN. Seul l'enregistrement de la campagne appelle cette fonction (PATCH, et
 * seulement pour les champs qui ont CHANGÉ, `champsAPropager`) ; « toujours la dernière publiée » a été
 * refusée.
 *
 * Ce qui est touché, et rien d'autre : `status = 'planned'`, `scheduled_at` non nul et au-delà de
 * `seuilDeRepointage` (délai de gel de la campagne + une période du cron). Scopé campagne ET marque.
 *  - `frozen`, `sending`, `sent`, `cancelled`, `failed` : le contenu est arrêté ou parti — jamais touché.
 *  - `held` : jamais touché, mais COMPTÉ — « send anyway » le relâche avec ce qu'il porte.
 *  - ⛔ PAS de filtre sur `recurrence_active` : une série arrêtée sans annulation envoie quand même
 *    ses éditions déjà planifiées (ni le gel ni le fan-out ne lisent cet interrupteur).
 *  - Seules les colonnes de `champs` et `updated_at` sont écrites : jamais `review_*`, jamais un champ
 *    qui n'a pas changé.
 *
 * ⚠️ LA COURSE AVEC LE GEL est tenue des deux côtés : ici par la fenêtre, côté worker par
 * `freezeOccurrence`, qui ne gèle que si la version, le sujet, le preheader et le segment n'ont pas
 * changé depuis sa lecture.
 *
 * La lecture (comptes) passe AVANT l'écriture : si elle échoue, rien n'a été écrit.
 */
export async function repointUpcomingOccurrences(
  db: Db,
  campaignId: string,
  assetId: string,
  champs: ChampsDEdition,
  { freezeLeadMinutes, now }: { freezeLeadMinutes: number | null | undefined; now: Date },
): Promise<RepointResult> {
  const colonnes = CHAMPS_D_EDITION.map(([colonne]) => colonne).filter((c) => champs[c] !== undefined);
  if (colonnes.length === 0) return { moved: 0, skippedInFreezeWindow: 0, held: 0, error: null };

  const maintenant = now.toISOString();
  const seuil = seuilDeRepointage(now, freezeLeadMinutes);

  const { data: lues, error: lectureErr } = await db
    .from("campaign_occurrence")
    .select("id, status, scheduled_at, template_version_id, subject, preheader, segment_id")
    .eq("campaign_id", campaignId)
    .eq("asset_id", assetId)
    .in("status", ["planned", "frozen", "held"])
    .gte("scheduled_at", maintenant);
  if (lectureErr) return { moved: 0, skippedInFreezeWindow: 0, held: 0, error: lectureErr.message };

  let skippedInFreezeWindow = 0;
  let held = 0;
  for (const raw of (lues as unknown[]) ?? []) {
    const r = raw as Record<string, unknown>;
    // Une édition qui porte DÉJÀ toutes les nouvelles valeurs ne « garde » rien : ne pas l'annoncer.
    if (colonnes.every((c) => memeValeurDEdition(c, r[c], champs[c]))) continue;
    const t = typeof r.scheduled_at === "string" ? Date.parse(r.scheduled_at) : Number.NaN;
    if (r.status === "held") held++;
    else if (r.status === "frozen") skippedInFreezeWindow++;
    else if (r.status === "planned" && Number.isFinite(t) && t <= seuil.getTime()) skippedInFreezeWindow++;
  }

  const valeurs: Record<string, unknown> = { updated_at: maintenant };
  for (const c of colonnes) valeurs[c] = champs[c];

  const { data, error } = await db
    .from("campaign_occurrence")
    .update(valeurs)
    .eq("campaign_id", campaignId)
    .eq("asset_id", assetId)
    .eq("status", "planned")
    .not("scheduled_at", "is", null)
    .gt("scheduled_at", seuil.toISOString())
    .select("id");
  if (error) return { moved: 0, skippedInFreezeWindow, held, error: error.message };
  return { moved: ((data as unknown[]) ?? []).length, skippedInFreezeWindow, held, error: null };
}

/* ------------------------------------------------------------------ *
 * Références (segment, version de template)
 * ------------------------------------------------------------------ */

export interface SegmentRef {
  id: string;
  name: string;
  rule: unknown;
}

/** Segment de la marque, ou `null`. Un segment d'une autre marque est traité comme inexistant. */
export async function findSegment(db: Db, id: string, assetId: string): Promise<SegmentRef | null> {
  if (!isUuid(id)) return null;
  const { data } = await db
    .from("segment")
    .select("id, name, rule_json")
    .eq("id", id)
    .eq("asset_id", assetId)
    .maybeSingle();
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return { id: String(r.id ?? ""), name: String(r.name ?? ""), rule: r.rule_json };
}

/**
 * La version de template existe-t-elle, est-elle PUBLIÉE, son template appartient-il à la marque,
 * et la personne connectée a-t-elle le droit de s'en servir ?
 * Le HTML n'est PAS chargé ici : cette vérification tourne à chaque création/modification, alors
 * que le snapshot ne sert qu'une fois, au verrou.
 *
 * ⚠️ C'est le POINT DE PASSAGE unique de la référence campagne → template : `buildCampaignPatch`,
 * l'armement et le verrou l'appellent tous les trois. Le contrôle d'octroi est donc posé ici, une
 * seule fois — le poser dans les trois routes laisserait la quatrième, un jour, sans garde.
 */
export async function findPublishedVersionRef(
  db: Db,
  versionId: string,
  assetId: string,
): Promise<{ id: string; templateId: string; version: number } | null> {
  if (!isUuid(versionId)) return null;
  const { data } = await db
    .from("template_version")
    .select("id, template_id, version, status")
    .eq("id", versionId)
    .eq("status", "published")
    .maybeSingle();
  if (!data) return null;

  const r = data as Record<string, unknown>;
  const templateId = String(r.template_id ?? "");
  // Le scope marque vit sur `template`, pas sur `template_version` : on remonte d'un cran.
  const { data: tpl } = await db
    .from("template")
    .select("id")
    .eq("id", templateId)
    .eq("asset_id", assetId)
    .maybeSingle();
  if (!tpl) return null;

  // Octroi : un template non octroyé doit se comporter comme une référence inexistante. Sans ce
  // contrôle, un membre pourrait programmer une campagne sur un template qu'il ne peut pas ouvrir
  // — et l'envoyer, puisque le rendu est figé au verrou et ne repasse plus par le template.
  const user = await getSessionUser();
  if (!user || !(await canEditTemplate(user, templateId))) return null;

  return { id: String(r.id ?? ""), templateId, version: Number(r.version ?? 0) };
}

export interface VersionSnapshot {
  id: string;
  subject: string;
  preheader: string | null;
  htmlShell: string | null;
  textShell: string | null;
  sizeBytes: number | null;
}

/** Snapshot complet — chargé UNIQUEMENT au verrou, jamais sur un chemin de lecture courant. */
export async function loadVersionSnapshot(db: Db, versionId: string): Promise<VersionSnapshot | null> {
  const { data } = await db
    .from("template_version")
    .select("id, subject, preheader, html_shell, text_shell, size_bytes")
    .eq("id", versionId)
    .maybeSingle();
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    subject: String(r.subject ?? ""),
    preheader: str(r.preheader),
    htmlShell: str(r.html_shell),
    textShell: str(r.text_shell),
    sizeBytes: num(r.size_bytes),
  };
}

/* ------------------------------------------------------------------ *
 * Audience — un COMPTE, jamais une liste
 * ------------------------------------------------------------------ */

export interface AudienceEstimate {
  segmentId: string | null;
  purpose: string | null;
  /** Souscriptions ENVOYABLES (actives, non supprimées) qui matchent la règle du segment. */
  sendable: number | null;
  /** Sous-ensemble ayant accordé la finalité demandée — ce que le gate d'envoi laissera passer. */
  eligible: number | null;
  /**
   * Contacts de DÉMONSTRATION que la barrière d'envoi vient d'écarter (adresse en domaine réservé
   * RFC 2606, cf. 0033/0034). Sans ce chiffre, un « 0 destinataires » se lit comme une panne et
   * envoie l'opérateur soupçonner sa règle de segment. `null` = non compté (erreur), 0 = compté.
   */
  demoExcluded: number | null;
  /**
   * Abonnés RÉELS que le sunset a écartés (`subscription.sunset_at`, cf. 0057/0059). Même raison
   * d'être que `demoExcluded` : depuis que la barrière filtre aussi les marqués, un « 0 » sans ce
   * chiffre laisse croire à une panne de la règle. Les trois comptes partitionnent exactement les
   * abonnements actifs non supprimés. `null` = non compté, 0 = compté.
   */
  sunsetExcluded: number | null;
  /** Prédicats de la règle ignorés faute de flux d'événements — affichés, jamais tus. */
  unsupported: string[];
  /** Pourquoi un compte est `null`. `null` quand tout a été calculé. */
  reason: string | null;
  /**
   * Qui la règle désigne : les abonnés newsletter (défaut, et toute règle sans « Newsletter: No »)
   * ou les contacts hors newsletter (0088). Les deux compléments ci-dessus décrivent des ABONNÉS
   * écartés : ils valent `null` pour les contacts.
   */
  population: Population;
  /**
   * La barrière de finalité a été SAUTÉE : population `contacts` ET case de la campagne cochée.
   * Dit à l'écran pourquoi `eligible === sendable` — sans ce drapeau, l'égalité se lirait « tout le
   * monde a consenti ».
   */
  purposeIgnored: boolean;
}

/**
 * Les tables de correspondance ET les trois listes blanches de provenance dont `compileRule` a
 * besoin, SCOPÉES MARQUE.
 *
 * ⛔ POURQUOI UNE SEULE FONCTION POUR DEUX APPELANTS. `/api/segments/count` (le chiffre affiché
 * pendant qu'on écrit la règle) et `estimateAudience` (le chiffre relu avant de planifier) portent
 * la MÊME grandeur. Deux lectures écrites côte à côte finissent par diverger d'un filtre — et le
 * jour où l'une autorise une campagne de capture que l'autre dénonce, l'écran annonce un nombre que
 * l'envoi ne servira jamais, sans qu'aucune erreur ne se lève.
 *
 * ⚠️ SCOPÉ MARQUE, OBLIGATOIREMENT : `newsletter.tag` et `newsletter.optin` sont uniques par
 * `(asset_id, slug)`, donc deux marques peuvent porter le même slug avec des ids DIFFÉRENTS. Sans
 * ce filtre, la dernière ligne rendue par PostgREST écrase les autres dans la table slug → id, et
 * la règle se compile sur l'id d'une AUTRE marque : `tag has vip` ne matche plus personne, et pire,
 * `tag is not vip` matche tout le monde — une exclusion qui échoue en s'OUVRANT, sans rien mettre
 * dans `unsupported` (un id faux reste un id, `predicateExpr` ne peut pas le savoir).
 *
 * ⛔ LES ARCHIVÉS SONT DANS LES LISTES BLANCHES. Une créative retirée du site et une campagne
 * d'acquisition terminée gardent leurs contacts : un segment enregistré qui les cite doit rester
 * comptable. Filtrer `archived_at` ici ferait dénoncer le prédicat — donc refuser le compte — sur
 * une règle que personne n'a touchée.
 *
 * ⛔ UNE LECTURE RATÉE REND `undefined`, JAMAIS `[]`. Les deux font dénoncer le prédicat
 * aujourd'hui, mais ils ne disent pas la même chose : `[]` affirme « cette marque n'autorise
 * aucune valeur », `undefined` avoue « je n'ai pas pu regarder ». Le jour où le compilateur
 * traitera les deux différemment, la distinction sera déjà là.
 *
 * ⛔ SANS MARQUE CONNUE, AUCUNE LISTE BLANCHE. Une liste non scopée autoriserait l'identifiant
 * d'une AUTRE marque — un uuid parfaitement valide, qui ne matche personne en `any_of` et TOUT LE
 * MONDE en `none_of`. On préfère dénoncer le prédicat (donc refuser de compter).
 */
export async function ruleContextForAsset(db: Db, assetId: string | null): Promise<RuleContext> {
  let tagQuery = db.from("tag").select("id, slug, kind");
  if (assetId) tagQuery = tagQuery.eq("asset_id", assetId);
  let optinQuery = db.from("optin").select("id, slug");
  if (assetId) optinQuery = optinQuery.eq("asset_id", assetId);
  const lireCampagnes = async () => {
    if (!assetId) return null;
    return db.from("capture_campaign").select("id").eq("asset_id", assetId);
  };
  // TOUS statuts : une automation repassée en brouillon a toujours envoyé ce qu'elle a envoyé, et un
  // segment qui la cite doit rester comptable. Même garde de marque que les campagnes.
  const lireAutomations = async () => {
    if (!assetId) return null;
    return db.from("automation").select("id").eq("asset_id", assetId);
  };

  const [tagRes, optinRes, campRes, autoRes] = await Promise.all([
    tagQuery, optinQuery, lireCampagnes(), lireAutomations(),
  ]);

  const tagIdBySlug: Record<string, number> = {};
  const interestIds: number[] = [];
  for (const raw of ((tagRes.data as unknown[]) ?? [])) {
    const t = raw as { id: number; slug: string; kind: string | null };
    tagIdBySlug[t.slug] = t.id;
    // ⛔ `kind`, jamais un LIKE sur le slug : un tag manuel nommé « interest:… » se ferait passer
    // pour une donnée du pont, et deviendrait ciblable comme un intérêt déclaré.
    if (t.kind === "interest") interestIds.push(t.id);
  }

  const optinIdBySlug: Record<string, string> = {};
  const captureOptinIds: string[] = [];
  for (const raw of ((optinRes.data as unknown[]) ?? [])) {
    const o = raw as { id: string; slug: string };
    optinIdBySlug[o.slug] = o.id;
    // ⚠️ Les CRÉATIVES de `capture_optin_ids` sont les optins eux-mêmes : même table, autre clé.
    // `optin` (le champ scalaire) les désigne par slug, `capture_creative` par identifiant.
    captureOptinIds.push(o.id);
  }

  const scopeConnu = !!assetId;
  return {
    tagIdBySlug,
    optinIdBySlug,
    interestIds: scopeConnu && !tagRes.error ? interestIds : undefined,
    captureOptinIds: scopeConnu && !optinRes.error ? captureOptinIds : undefined,
    captureCampaignIds: campRes && !campRes.error
      ? ((campRes.data as unknown[]) ?? []).map((raw) => String((raw as { id: string }).id))
      : undefined,
    automationIds: autoRes && !autoRes.error
      ? ((autoRes.data as unknown[]) ?? []).map((raw) => String((raw as { id: string }).id))
      : undefined,
  };
}

/**
 * Compte estimé d'une audience — AUCUNE PII n'est lue (requêtes `head` : zéro ligne rapatriée).
 *
 * La logique de ciblage est celle de `/api/segments/count` : même compilateur de règle
 * (`@nf/segments/compile`) et même vue `sendable_subscription`. Cette vue est la barrière de
 * consentement (statut actif + hors liste de suppression) ; le ciblage n'est qu'une commodité.
 * Cette route ajoute la seule chose qui lui manque : le gate par FINALITÉ.
 *
 * ⛔ LA VUE VIENT DE LA RÈGLE (`population`), comme au fan-out : « Newsletter: No » compte sur
 * `contact_subscription`, tout le reste sur `sendable_subscription`. Et la barrière de finalité ne
 * saute QUE pour les contacts d'une campagne dont la case est cochée — jamais pour un abonné.
 */
export async function estimateAudience(
  db: Db,
  assetId: string,
  segmentId: string | null,
  purpose: string | null,
  { contactsIgnorePurpose = false }: { contactsIgnorePurpose?: boolean } = {},
): Promise<AudienceEstimate> {
  const base: AudienceEstimate = {
    segmentId,
    purpose,
    sendable: null,
    eligible: null,
    demoExcluded: null,
    sunsetExcluded: null,
    unsupported: [],
    reason: null,
    population: "subscribers",
    purposeIgnored: false,
  };

  /*
   * ⛔ PAS DE SEGMENT N'EST PAS UNE DONNÉE MANQUANTE : c'est un ciblage VIDE, qui veut dire « toute
   * la marque ». Refuser de compter, comme on le faisait, rendait `eligible: null` — et la
   * planification, qui exige un compte, refusait alors une campagne parfaitement valide.
   *
   * Ce que « pas de segment » ne change PAS : la vue `sendable_subscription` (statut actif, hors
   * liste de suppression, hors contacts fictifs) et le gate de finalité plus bas s'appliquent
   * exactement pareil. C'est déjà ainsi que l'envoi procède — `fanout-db.ts` traite le ciblage
   * comme un `.or()` optionnel et applique la finalité séparément.
   *
   * ⚠️ À NE PAS CONFONDRE avec la règle illisible ci-dessous : là, un segment EST désigné et on ne
   * sait pas le lire. Compter tout le monde dans ce cas transformerait une donnée corrompue en
   * envoi de masse. Ici, personne n'a désigné de ciblage : il n'y a rien de corrompu à trahir.
   */
  let expr: string | null = null;
  let dedupedUnsupported: string[] = [];
  let population: Population = "subscribers";

  if (segmentId) {
    const segment = await findSegment(db, segmentId, assetId);
    if (!segment) return { ...base, reason: "segment not found" };

    const rule = segment.rule as RuleNode | null;
    if (!rule || (rule as { type?: unknown }).type !== "group") {
      // Une règle illisible ne vaut PAS « tout le monde » : ce raccourci transformerait une donnée
      // corrompue en envoi de masse. On refuse de compter plutôt que de deviner.
      return { ...base, reason: "segment rule is empty or unreadable" };
    }

    // ⛔ LES CINQ TABLES DE CORRESPONDANCE VIENNENT D'UN SEUL ENDROIT (voir `ruleContextForAsset`) :
    // le compteur de l'écran de segment lit exactement les mêmes, et deux lectures écrites
    // séparément finiraient par annoncer deux nombres pour la même règle.
    const compiled = compileRule(rule, await ruleContextForAsset(db, assetId));
    dedupedUnsupported = compiled.unsupported;

    // ⛔ MÊME REFUS QU'UNE RÈGLE ILLISIBLE, ET POUR LA MÊME RAISON. Un terme d'un ET qui n'a pas
    // compilé ne rétrécit pas l'audience, il l'ÉLARGIT : l'estimation porterait sur plus de monde
    // que la règle affichée. C'est exactement le chiffre qu'on relit avant d'appuyer sur envoyer.
    if (compiled.widened) {
      return {
        ...base,
        unsupported: dedupedUnsupported,
        reason: `targeting is incomplete (${dedupedUnsupported.join(", ")}) — the audience would be wider than the rule`,
      };
    }
    expr = compiled.expr;
    population = compiled.population;
  }

  const contacts = population === "contacts";
  const purposeIgnored = contacts && contactsIgnorePurpose;
  const query = () => {
    let q = db.from(AUDIENCE_VIEW[population]).select("id", { count: "exact", head: true }).eq("asset_id", assetId);
    if (expr) q = q.or(expr);
    return q;
  };

  const { count, error } = await query();
  if (error) return { ...base, population, unsupported: dedupedUnsupported, reason: error.message };
  const sendable = count ?? 0;

  // Le même ciblage, sur les DEUX AUTRES parts de la partition (vues 0035 et 0059) : combien de
  // contacts fictifs, et combien d'abonnés réels marqués par le sunset, viennent d'être écartés.
  // C'est ce qui rend un zéro lisible. Un échec de ces comptages ne fait PAS échouer l'estimation —
  // expliquer le chiffre est utile, pas vital.
  //
  // ⛔ Il en faut DEUX depuis 0057, pas un. `sendable_subscription` filtre désormais aussi
  // `sunset_at is null` ; avec le seul compte de démonstration, un abonné marqué disparaissait des
  // deux chiffres et l'écran pouvait afficher « 0 destinataire, 0 écarté » sans dire pourquoi.
  const complement = async (view: string) => {
    let q = db.from(view).select("id", { count: "exact", head: true }).eq("asset_id", assetId);
    if (expr) q = q.or(expr);
    const { count: n } = await q;
    return n ?? null;
  };
  // Les deux compléments sont des parts de la partition des ABONNÉS : sans objet pour les contacts.
  const demoExcluded = contacts ? null : await complement("excluded_demo_subscription");
  const sunsetExcluded = contacts ? null : await complement("sunsetted_subscription");
  const lu = { ...base, sendable, demoExcluded, sunsetExcluded, unsupported: dedupedUnsupported, population };

  // ⛔ La finalité reste EXIGÉE même quand sa barrière saute : le worker en a besoin (lien de
  // désinscription, journal), et une campagne sans finalité ne se planifie pas.
  if (!purpose || !isCampaignPurpose(purpose)) {
    return { ...lu, reason: "campaign has no purpose" };
  }

  // Contacts + case cochée : la décision d'Alix (25/09/2026) — le segment EST le consentement.
  if (purposeIgnored) return { ...lu, eligible: sendable, purposeIgnored: true };

  const { data: editions } = await db
    .from("asset_edition")
    .select("id, compliance_regime")
    .eq("asset_id", assetId);

  const optOutEditionIds = ((editions as unknown[]) ?? [])
    .map((raw) => raw as { id?: unknown; compliance_regime?: unknown })
    .filter((e) => legalBasisForRegime(String(e.compliance_regime ?? "")) === "opt_out")
    .map((e) => String(e.id ?? ""))
    .filter(Boolean);

  const { count: eligible, error: gateError } = await query().or(purposeGateFilter(purpose, optOutEditionIds));
  if (gateError) return { ...lu, reason: gateError.message };

  return { ...lu, eligible: eligible ?? 0 };
}

/* ------------------------------------------------------------------ *
 * Validation du corps (partagée par POST et PATCH)
 * ------------------------------------------------------------------ */

/** Champs figés par le verrou : ils décrivent ce que l'abonné VOIT. */
export const LOCKED_FIELDS = ["subject", "preheader", "templateVersionId"] as const;

export interface CampaignBody {
  name?: unknown;
  subject?: unknown;
  preheader?: unknown;
  templateVersionId?: unknown;
  segmentId?: unknown;
  purpose?: unknown;
  contactsIgnorePurpose?: unknown;
}

export type PatchResult =
  | { ok: true; patch: Record<string, unknown>; touched: string[] }
  | { ok: false; error: string; status: number };

/**
 * Traduit un corps JSON en colonnes, en validant chaque champ ET les références croisées.
 *
 * Les références sont vérifiées DANS LA MARQUE : pointer une version de template ou un segment
 * d'une autre marque doit échouer comme si l'objet n'existait pas. Sans ça, une campagne pourrait
 * envoyer le contenu d'une marque à la liste d'une autre.
 *
 * Seules les clés RÉELLEMENT présentes dans le corps sont traduites (`touched`) : le PATCH doit
 * pouvoir modifier un champ sans réécrire les autres.
 */
export async function buildCampaignPatch(
  db: Db,
  assetId: string,
  body: CampaignBody,
  // Injectable pour le banc du PATCH (la vraie lit la session pour l'octroi) ; défaut = production.
  versionPubliee: typeof findPublishedVersionRef = findPublishedVersionRef,
): Promise<PatchResult> {
  const patch: Record<string, unknown> = {};
  const touched: string[] = [];
  const bad = (error: string, status = 400): PatchResult => ({ ok: false, error, status });

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return bad("name cannot be empty");
    if (name.length > 120) return bad("name must be 120 characters or less");
    patch.name = name;
    touched.push("name");
  }

  if (body.subject !== undefined) {
    if (typeof body.subject !== "string") return bad("subject must be a string");
    if (body.subject.length > 200) return bad("subject must be 200 characters or less");
    patch.subject = body.subject;
    touched.push("subject");
  }

  if (body.preheader !== undefined) {
    if (body.preheader === null) {
      patch.preheader = null;
    } else {
      if (typeof body.preheader !== "string") return bad("preheader must be a string or null");
      if (body.preheader.length > 200) return bad("preheader must be 200 characters or less");
      patch.preheader = body.preheader;
    }
    touched.push("preheader");
  }

  if (body.templateVersionId !== undefined) {
    if (body.templateVersionId === null) {
      patch.template_version_id = null;
    } else {
      const versionId = String(body.templateVersionId);
      const ref = await versionPubliee(db, versionId, assetId);
      // Un brouillon n'est PAS envoyable : seule une version publiée a un rendu figé et vérifié.
      if (!ref) return bad("templateVersionId does not match a published template version of this brand");
      patch.template_version_id = ref.id;
    }
    touched.push("templateVersionId");
  }

  if (body.segmentId !== undefined) {
    if (body.segmentId === null) {
      patch.segment_id = null;
    } else {
      const segmentId = String(body.segmentId);
      const segment = await findSegment(db, segmentId, assetId);
      if (!segment) return bad("segmentId does not match a segment of this brand");
      patch.segment_id = segment.id;
    }
    touched.push("segmentId");
  }

  if (body.purpose !== undefined) {
    if (body.purpose === null) {
      patch.purpose = null;
    } else {
      const purpose = String(body.purpose);
      if (!isCampaignPurpose(purpose)) {
        return bad(`unknown purpose "${purpose}" — expected one of ${CAMPAIGN_PURPOSES.join(", ")}`);
      }
      patch.purpose = purpose;
    }
    touched.push("purpose");
  }

  // ⛔ Un booléen STRICT : « "false" », 1 ou `null` ne cochent ni ne décochent rien en silence — la
  // case lève une barrière de consentement, elle ne se devine pas.
  if (body.contactsIgnorePurpose !== undefined) {
    if (typeof body.contactsIgnorePurpose !== "boolean") return bad("contactsIgnorePurpose must be a boolean");
    patch.contacts_ignore_purpose = body.contactsIgnorePurpose;
    touched.push("contactsIgnorePurpose");
  }

  return { ok: true, patch, touched };
}
