import { getDb } from "@/lib/supabase";

/**
 * LA PROVENANCE, CÔTÉ LECTURE (niveaux 1, 2 et 3).
 *
 * Trois niveaux, trois objets : la CAMPAGNE d'acquisition (`capture_campaign`), la CRÉATIVE
 * (`optin`) et l'INTÉRÊT (`tag` de `kind='interest'`). La vérité est dans `capture_event` ; les
 * colonnes tableau de `subscription` n'en sont qu'une projection maintenue par trigger.
 * ⛔ Aucune fonction d'ici n'écrit : le trigger est le seul écrivain de ces colonnes.
 *
 * ⛔ DEUX PIÈGES POSTGREST MESURÉS EN PRODUCTION LE 09/09/2026, et ils sont opposés :
 *    `cs.{}` (contains d'un ensemble VIDE) matche TOUT LE MONDE — 1 203 sur 1 203 — et `ov.{}`
 *    (overlaps vide) ne matche PERSONNE. Le même oubli produit donc, selon l'opérateur, une fuite
 *    totale ou un zéro muet. Règle dure appliquée partout ici : on teste la vacuité AVANT l'appel
 *    et on n'émet jamais la requête avec un tableau vide.
 *
 * ⚠️ Chaque fonction prend `db` en PREMIER paramètre. C'est la seule forme que le double de test du
 * dépôt sait injecter (`campaigns.test.ts`) — et le jour où tous les écrans affichent légitimement
 * zéro, un écran juste et un écran cassé sont indiscernables à l'œil.
 */

type Db = NonNullable<ReturnType<typeof getDb>>;

/** uuid impossible : la sentinelle d'un identifiant demandé mais introuvable. JAMAIS un tableau vide. */
export const UUID_IMPOSSIBLE = "00000000-0000-0000-0000-000000000000";
/** Même rôle pour un identifiant de tag : les `tag.id` sont des entiers positifs. */
export const TAG_IMPOSSIBLE = -1;

/* ════════════════════════════════════════════════════════════════════════════
 * Les cinq états d'un intérêt sur un formulaire — fonction PURE, donc testable
 * ══════════════════════════════════════════════════════════════════════════ */

export type EtatInterets = "no-form" | "form-unknown" | "not-asked" | "asked-empty" | "chosen";

export interface EntreeInterets {
  /** false = l'événement n'a pas d'`optin_id` (résolution ratée à l'ingestion, `on delete set null`). */
  optinConnu: boolean;
  /** `optin.asks_interests` — inconnaissable quand la créative l'est (d'où le `null`). */
  asksInterests: boolean | null;
  /** Ce qui a été coché, GELÉ le jour de la capture. */
  interestIds: number[];
  /** ⚠️ `null` = l'émetteur ne nous a pas dit ce qu'il proposait ; `[]` = il proposait rien. */
  interestsOffered: number[] | null;
}

/**
 * QUATRE ABSENCES QUI NE VEULENT PAS DIRE LA MÊME CHOSE, plus le cas normal.
 *
 * ⛔ Les confondre fait dire à l'écran quelque chose qu'on ne sait pas. « Ce formulaire ne demandait
 * rien » est une AFFIRMATION : la porter sur un événement dont la créative n'a pas pu être résolue
 * invente une propriété d'un objet qu'on n'a même pas retrouvé.
 *
 * L'ordre des tests n'est pas décoratif : un intérêt coché prouve à lui seul que la question a été
 * posée, même si le drapeau `asks_interests` de la créative dit aujourd'hui le contraire (il décrit
 * l'état COURANT du formulaire, pas celui du jour de la capture).
 */
export function etatInterets(e: EntreeInterets | null): EtatInterets {
  if (e === null) return "no-form";
  if (!e.optinConnu) return "form-unknown";
  if (e.interestIds.length > 0) return "chosen";
  // `interests_offered` non vide prouve une offre, même si le drapeau courant est retombé à false.
  const aDemande = e.asksInterests === true || (e.interestsOffered !== null && e.interestsOffered.length > 0);
  return aDemande ? "asked-empty" : "not-asked";
}

/* ════════════════════════════════════════════════════════════════════════════
 * L'état vide d'un niveau — « rien reçu » et « rien à CE niveau » ne se disent pas pareil
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⛔ « No lead has reached {marque} yet » est une AFFIRMATION SUR LE PONT, et l'écran la portait
 * sur les trois niveaux dès qu'un tableau était vide.
 *
 * Mesuré le 13/09/2026 : copper-kettle avait reçu 4 inscriptions et 0 intérêt (la créative ne pose
 * pas la question). L'onglet Interests annonçait donc que le pont n'avait jamais rien transporté —
 * sur la seule marque qui venait justement de recevoir, et en listant trois interrupteurs déjà
 * fermés. Un écran qui se trompe d'état vide envoie chercher une panne qui n'existe pas.
 *
 * Le nombre d'inscriptions de la marque est la seule chose qui départage les deux. Et comme il se
 * LIT, il peut manquer : une lecture ratée ne se replie pas sur « rien reçu », elle se tait.
 */
export type EtatVideNiveau = "rien-recu" | "recu-sans-ce-niveau" | "indetermine";

export interface CapturesDeLaMarque {
  /** ⛔ `false` = la lecture a échoué. Ce n'est pas zéro, et ça ne se rend pas comme zéro. */
  known: boolean;
  value: number;
}

export function etatVideNiveau(captures: CapturesDeLaMarque): EtatVideNiveau {
  if (!captures.known) return "indetermine";
  return captures.value > 0 ? "recu-sans-ce-niveau" : "rien-recu";
}

/** Combien d'inscriptions le pont a déposées sur cette marque, tous niveaux confondus. */
export async function countCaptureEvents(db: Db, assetId: string | null): Promise<CapturesDeLaMarque> {
  if (!assetId) return { known: false, value: 0 };
  const { count, error } = await db
    .from("capture_event").select("id", { count: "exact", head: true }).eq("asset_id", assetId);
  // ⛔ `count` peut être `null` SANS erreur (l'en-tête de comptage n'est pas toujours renvoyé).
  // C'est « je ne sais pas », et le confondre avec zéro ramènerait exactement le défaut corrigé.
  if (error || count === null || count === undefined) return { known: false, value: 0 };
  return { known: true, value: count };
}

/* ════════════════════════════════════════════════════════════════════════════
 * Le bras A/B d'une inscription — information, jamais critère de ciblage
 * ══════════════════════════════════════════════════════════════════════════ */

export interface EvenementBras {
  subscriptionId: string;
  occurredAt: string;
  variantExternalId: string | null;
}

/**
 * Le bras A/B de l'inscription la PLUS ANCIENNE de chaque souscription.
 *
 * ⛔ Le bras vient de cette capture-là et d'aucune autre : retenir « le premier bras non nul
 * rencontré » collerait le bras d'une inscription sous le nom du formulaire d'une autre — un
 * rapprochement faux qui ne se voit pas, puisque les deux valeurs sont vraies séparément.
 *
 * ⚠️ « La plus ancienne » n'est pas garanti être l'inscription dont le formulaire est affiché en
 * gras dans la liste : celui-là vient de `subscription.optin_id`, figée à l'ordre d'ARRIVÉE des
 * requêtes du pont et jamais réalignée ensuite (`refresh_subscription_capture` ne la touche pas).
 * Deux inscriptions reçues dans le désordre suffisent à les séparer. La règle retenue ici est la
 * même que celle de la campagne affichée juste au-dessus du bras, pas celle du formulaire.
 *
 * Une souscription dont la plus ancienne capture ne porte aucun bras n'apparaît pas dans le
 * résultat : l'écran ne dira rien plutôt que d'affirmer qu'il n'y avait pas d'A/B — newsletter-forge
 * ne connaît que la créative parente, jamais ses bras, donc il ne peut pas le savoir.
 */
export function variantDePremiereTouche(events: EvenementBras[]): Record<string, string> {
  const premiere = new Map<string, EvenementBras>();
  for (const e of events) {
    if (!e.subscriptionId) continue;
    const t = Date.parse(e.occurredAt);
    if (Number.isNaN(t)) continue;
    const deja = premiere.get(e.subscriptionId);
    if (!deja || t < Date.parse(deja.occurredAt)) premiere.set(e.subscriptionId, e);
  }
  const out: Record<string, string> = {};
  for (const [id, e] of premiere) {
    if (e.variantExternalId) out[id] = e.variantExternalId;
  }
  return out;
}

/** Bornage de la lecture ci-dessous. Voir le commentaire : le préfixe le plus ANCIEN suffit. */
const MAX_EVENEMENTS_BRAS = 500;

/**
 * Les bras A/B de première touche pour les souscriptions d'une page de liste.
 *
 * ⚠️ Tri `occurred_at` ASC puis troncature : si un événement d'une souscription est dans le
 * résultat, tout événement plus ancien y est aussi — donc le premier événement de cette
 * souscription y est. Une souscription absente du préfixe n'affiche simplement pas de bras ;
 * la troncature peut taire une information, jamais en inventer une fausse.
 * ⛔ Garde de vacuité : sans identifiant, aucune requête (`in.()` vide est une requête payée pour rien).
 */
export async function listVariantsPremiereTouche(
  db: Db, subscriptionIds: string[],
): Promise<Record<string, string>> {
  if (subscriptionIds.length === 0) return {};
  const { data, error } = await db
    .from("capture_event")
    .select("subscription_id, occurred_at, variant_external_id")
    .in("subscription_id", subscriptionIds)
    .order("occurred_at", { ascending: true })
    .limit(MAX_EVENEMENTS_BRAS);
  if (error || !data) return {};
  return variantDePremiereTouche(
    (data as unknown[]).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        subscriptionId: String(r.subscription_id ?? ""),
        occurredAt: String(r.occurred_at ?? ""),
        variantExternalId: (r.variant_external_id as string | null) ?? null,
      };
    }),
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * Les événements de capture d'une personne (drawer « Where they signed up »)
 * ══════════════════════════════════════════════════════════════════════════ */

export interface CaptureEventRow {
  id: string;
  subscriptionId: string;
  assetId: string;
  occurredAt: string;
  optinKnown: boolean;
  /** Nom COURANT de la créative. */
  optinName: string | null;
  /** Nom FIGÉ au moment de la capture — il peut différer, et alors il faut le dire. */
  optinNameAtCapture: string | null;
  placement: string | null;
  asksInterests: boolean | null;
  campaignName: string | null;
  campaignNameAtCapture: string | null;
  interests: { id: number; label: string }[];
  interestIds: number[];
  interestsOffered: number[] | null;
  variantExternalId: string | null;
  sourceUrl: string | null;
}

/**
 * Les inscriptions observées pour un jeu de souscriptions, de la plus récente à la plus ancienne.
 *
 * ⛔ P9 — `allowedAssetIds` n'est pas une commodité d'affichage. Le drawer est VOLONTAIREMENT non
 * scopé marque (le RGPD impose de montrer tous les consentements d'une personne), mais le plan
 * d'acquisition d'une marque interdite n'a rien à y faire. Le filtre est posé dans la REQUÊTE, pas
 * au rendu : un nom de créative d'une autre marque ne doit pas exister dans le HTML servi.
 * Liste vide (aucune marque autorisée, ou pas de session) ⇒ aucune requête, aucun événement.
 */
export async function listCaptureEvents(
  db: Db,
  subscriptionIds: string[],
  allowedAssetIds: string[],
): Promise<CaptureEventRow[]> {
  if (subscriptionIds.length === 0 || allowedAssetIds.length === 0) return [];

  const { data, error } = await db
    .from("capture_event")
    .select(
      "id, subscription_id, asset_id, occurred_at, optin_id, capture_campaign_id, interest_ids, interests_offered, campaign_name_at_capture, optin_name_at_capture, variant_external_id, source_url, optin:optin_id(name, placement, asks_interests), campaign:capture_campaign_id(name)",
    )
    .in("subscription_id", subscriptionIds)
    .in("asset_id", allowedAssetIds)
    .order("occurred_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];

  const brutes = (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown> & {
      optin?: { name?: string | null; placement?: string | null; asks_interests?: boolean } | null;
      campaign?: { name?: string | null } | null;
    };
    return {
      id: String(r.id ?? ""),
      subscriptionId: String(r.subscription_id ?? ""),
      assetId: String(r.asset_id ?? ""),
      occurredAt: String(r.occurred_at ?? ""),
      optinKnown: r.optin_id !== null && r.optin_id !== undefined,
      optinName: r.optin?.name ?? null,
      optinNameAtCapture: (r.optin_name_at_capture as string | null) ?? null,
      placement: r.optin?.placement ?? null,
      asksInterests: r.optin ? r.optin.asks_interests === true : null,
      campaignName: r.campaign?.name ?? null,
      campaignNameAtCapture: (r.campaign_name_at_capture as string | null) ?? null,
      interestIds: (r.interest_ids as number[] | null) ?? [],
      interestsOffered: (r.interests_offered as number[] | null) ?? null,
      variantExternalId: (r.variant_external_id as string | null) ?? null,
      sourceUrl: (r.source_url as string | null) ?? null,
    };
  });

  // Un seul aller-retour pour tous les libellés de la page : une requête par événement ferait
  // grossir le drawer avec l'historique de la personne.
  const idsInterets = [...new Set(brutes.flatMap((b) => b.interestIds))];
  const libelles = await labelsDesTags(db, idsInterets);

  return brutes.map((b) => ({
    ...b,
    interests: b.interestIds.map((id) => ({ id, label: libelles[id] ?? `#${id}` })),
  }));
}

/** Libellés de tags par identifiant. ⛔ Garde de vacuité : sans ids, pas de requête. */
async function labelsDesTags(db: Db, ids: number[]): Promise<Record<number, string>> {
  if (ids.length === 0) return {};
  const { data } = await db.from("tag").select("id, slug, label").in("id", ids);
  const out: Record<number, string> = {};
  for (const raw of (data as unknown[]) ?? []) {
    const t = raw as { id: number; slug: string; label: string | null };
    out[t.id] = t.label || t.slug;
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
 * Gouvernance — les campagnes d'acquisition (niveau 1)
 * ══════════════════════════════════════════════════════════════════════════ */

export interface CaptureCampaignRow {
  id: string;
  externalId: string;
  name: string;
  firstSeenAt: string | null;
  /** Dernière fois que le pont a MENTIONNÉ cette campagne — un horodatage d'ingestion. */
  lastSeenAt: string | null;
  /**
   * Dernière inscription RÉELLE (`max(occurred_at)`), la seule date qu'une colonne « Last signup »
   * ait le droit d'afficher. ⛔ `lastSeenAt` s'en écarte de plusieurs jours dès qu'un lot est
   * rejoué : le 13/09/2026, l'onglet Campaigns annonçait « 13 Sep » (le rejeu) pendant que
   * l'onglet Creatives affichait « 11 Sep » (l'inscription) pour le même et unique couple.
   */
  lastSignupAt: string | null;
  archivedAt: string | null;
  /** Tout le monde, contacts de démonstration et désabonnés compris. */
  contacts: number;
  /** Ce qu'une campagne d'envoi peut réellement servir. L'écart avec `contacts` EST l'information. */
  sendable: number;
  /** Créatives rattachées AUJOURD'HUI à cette campagne (le rattachement peut changer chez l'émetteur). */
  creatives: number;
}

export interface CaptureCampaignsResult {
  rows: CaptureCampaignRow[];
  source: "db" | "none";
  /** Motif d'un échec de lecture — distinct d'une marque qui n'a simplement aucune campagne. */
  reason: string | null;
  /**
   * ⛔ `false` ⇒ les dates d'inscription n'ont pas pu être lues. La colonne doit alors se taire, et
   * surtout ne pas afficher « Never » : « aucune inscription » et « je n'ai pas pu regarder » sont
   * deux réponses opposées à la même case.
   */
  lastSignupKnown: boolean;
}

const CAMPAGNES_VIDE: CaptureCampaignsResult = {
  rows: [], source: "none", reason: null, lastSignupKnown: false,
};

/**
 * Les campagnes d'acquisition et leurs deux comptes.
 *
 * ⛔ ON NE SOMME PAS LES CRÉATIVES D'UNE CAMPAGNE. Quelqu'un entré par deux créatives de la même
 * campagne serait compté deux fois, et le total d'une campagne pourrait dépasser le nombre de
 * personnes qu'elle a réellement fait entrer. Le seul compte juste est un head-count sur la
 * projection `capture_campaign_ids`, qui dédoublonne par construction.
 */
export async function listCaptureCampaigns(db: Db, assetId: string | null): Promise<CaptureCampaignsResult> {
  if (!assetId) return { ...CAMPAGNES_VIDE, reason: "no-asset" };

  const [campRes, optinRes, statsRes] = await Promise.all([
    db.from("capture_campaign").select("id, external_id, name, first_seen_at, last_seen_at, archived_at")
      .eq("asset_id", assetId).order("name"),
    // Une seule requête pour tout le rattachement : une par campagne ferait N requêtes pour un
    // chiffre que l'on peut compter ici.
    db.from("optin").select("id, capture_campaign_id").eq("asset_id", assetId),
    // ⚠️ MÊME SOURCE que l'onglet Creatives (`capture_source_stats.last_signup_at`), et c'est le
    // point : les deux onglets donnaient deux dates différentes pour le même couple. La vue agrège
    // par créative, donc la date d'une campagne est le plus récent signup de ses créatives —
    // rattachement COURANT, comme la colonne « Creatives » juste à côté.
    db.from("capture_source_stats").select("capture_campaign_id, last_signup_at").eq("asset_id", assetId),
  ]);
  if (campRes.error) return { ...CAMPAGNES_VIDE, reason: campRes.error.message };

  /** campagne -> inscription la plus récente de ses créatives. */
  const dernierSignup = new Map<string, string>();
  for (const raw of (statsRes.data as unknown[]) ?? []) {
    const s = raw as { capture_campaign_id: string | null; last_signup_at: string | null };
    if (!s.capture_campaign_id || !s.last_signup_at) continue;
    // ⛔ `Date.parse`, jamais une comparaison de chaînes : deux horodatages du même instant peuvent
    // s'écrire avec des décalages différents, et « +00:00 » se compare mal à « Z » ou à « -03:00 ».
    const t = Date.parse(s.last_signup_at);
    if (Number.isNaN(t)) continue;
    const deja = dernierSignup.get(s.capture_campaign_id);
    if (!deja || t > Date.parse(deja)) dernierSignup.set(s.capture_campaign_id, s.last_signup_at);
  }

  const creativesPar = new Map<string, number>();
  for (const raw of (optinRes.data as unknown[]) ?? []) {
    const o = raw as { capture_campaign_id: string | null };
    if (!o.capture_campaign_id) continue;
    creativesPar.set(o.capture_campaign_id, (creativesPar.get(o.capture_campaign_id) ?? 0) + 1);
  }

  const brutes = ((campRes.data as unknown[]) ?? []).map((raw) => {
    const c = raw as Record<string, unknown>;
    return {
      id: String(c.id ?? ""),
      externalId: String(c.external_id ?? ""),
      name: String(c.name ?? ""),
      firstSeenAt: (c.first_seen_at as string | null) ?? null,
      lastSeenAt: (c.last_seen_at as string | null) ?? null,
      archivedAt: (c.archived_at as string | null) ?? null,
    };
  });

  const rows = await Promise.all(
    brutes.map(async (c) => ({
      ...c,
      lastSignupAt: dernierSignup.get(c.id) ?? null,
      contacts: await compteContenant(db, "subscription", assetId, "capture_campaign_ids", c.id),
      sendable: await compteContenant(db, "sendable_subscription", assetId, "capture_campaign_ids", c.id),
      creatives: creativesPar.get(c.id) ?? 0,
    })),
  );

  // ⛔ Une lecture des créatives en panne donne « 0 creatives » sur TOUTES les lignes, et zéro se
  // lit comme une mesure. Les campagnes restent affichées — elles, on les a lues — mais l'écran
  // doit dire qu'une colonne est manquante et non nulle. Même raisonnement pour les dates : sans
  // la vue, `lastSignupAt` est `null` partout, ce qui s'afficherait « Never » sur chaque ligne.
  return {
    rows,
    source: "db",
    reason: optinRes.error ? optinRes.error.message : null,
    lastSignupKnown: !statsRes.error,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * Gouvernance — les intérêts (niveau 3)
 * ══════════════════════════════════════════════════════════════════════════ */

export interface CaptureInterestRow {
  id: number;
  slug: string;
  label: string;
  taxonomy: string | null;
  sourceSlug: string | null;
  contacts: number;
  sendable: number;
  /**
   * Dénominateur de « Of those asked » : les contacts venus d'une créative qui propose AUJOURD'HUI
   * cet intérêt. ⚠️ C'est l'offre courante, pas celle du jour de la capture (voir `offerUnknown`).
   */
  asked: number;
  /**
   * NUMÉRATEUR du même taux, restreint à la MÊME population que `asked`.
   * ⛔ Diviser `contacts` (toute la marque) par `asked` (les seuls sollicités) fabriquerait des
   * taux au-dessus de 100 % dès qu'une créative retire un intérêt de son offre : les gens qui
   * l'ont coché hier restent comptés au numérateur et disparaissent du dénominateur.
   */
  chosenAmongAsked: number;
  /** Créatives de la marque proposant aujourd'hui cet intérêt. 0 ⇒ aucun dénominateur, donc aucun taux. */
  offeredBy: number;
}

export interface CaptureInterestsResult {
  rows: CaptureInterestRow[];
  /** Inscriptions dont l'offre est INCONNUE (`interests_offered is null`) : elles ne peuvent alimenter aucun taux. */
  offerUnknown: number;
  totalEvents: number;
  source: "db" | "none";
  reason: string | null;
}

const INTERETS_VIDE: CaptureInterestsResult = {
  rows: [], offerUnknown: 0, totalEvents: 0, source: "none", reason: null,
};

/**
 * Les intérêts déclarés, avec le seul dénominateur qu'on sache borner.
 *
 * ⛔ « Of those asked » ne se calcule JAMAIS sur l'audience entière : un intérêt coché par 12
 * personnes sur 20 à qui la question a été posée n'est pas « 1 % des 1 203 abonnés ». Et un
 * dénominateur nul ne se traduit pas par « 0 % » : 0/0 n'est pas un taux, l'écran doit se taire.
 *
 * ⚠️ Le dénominateur retenu est l'OFFRE COURANTE des créatives (`optin.offered_interest_ids`), le
 * seul que PostgREST sache compter en `head` sans rapatrier de lignes. Il réécrit donc le passé
 * quand une créative change son offre — c'est pourquoi `offerUnknown` est remonté à part et que la
 * colonne doit nommer ce qu'elle compte, à l'écran.
 */
export async function listCaptureInterests(db: Db, assetId: string | null): Promise<CaptureInterestsResult> {
  if (!assetId) return { ...INTERETS_VIDE, reason: "no-asset" };

  const [tagRes, optinRes, totalRes, inconnuRes] = await Promise.all([
    // ⛔ `kind`, jamais un LIKE sur le slug : un tag manuel nommé « interest:… » se ferait passer
    // pour une donnée du pont.
    db.from("tag").select("id, slug, label, taxonomy, source_slug")
      .eq("asset_id", assetId).eq("kind", "interest").order("slug"),
    db.from("optin").select("id, offered_interest_ids").eq("asset_id", assetId),
    db.from("capture_event").select("id", { count: "exact", head: true }).eq("asset_id", assetId),
    db.from("capture_event").select("id", { count: "exact", head: true })
      .eq("asset_id", assetId).is("interests_offered", null),
  ]);
  if (tagRes.error) return { ...INTERETS_VIDE, reason: tagRes.error.message };

  /** intérêt -> créatives qui le proposent aujourd'hui. Construit ici, pas par N requêtes. */
  const offrantes = new Map<number, string[]>();
  for (const raw of (optinRes.data as unknown[]) ?? []) {
    const o = raw as { id: string; offered_interest_ids: number[] | null };
    for (const tid of o.offered_interest_ids ?? []) {
      const l = offrantes.get(tid) ?? [];
      l.push(o.id);
      offrantes.set(tid, l);
    }
  }

  const brutes = ((tagRes.data as unknown[]) ?? []).map((raw) => {
    const t = raw as Record<string, unknown>;
    const slug = String(t.slug ?? "");
    return {
      id: Number(t.id ?? 0),
      slug,
      // ⛔ Un slug n'est pas un libellé : l'écran doit montrer « Colo-Colo », jamais
      // « interest:tag:colo-colo ». Le repli sur le slug n'existe que pour ne rien perdre.
      label: (t.label as string | null) || slug,
      taxonomy: (t.taxonomy as string | null) ?? null,
      sourceSlug: (t.source_slug as string | null) ?? null,
    };
  });

  const rows = await Promise.all(
    brutes.map(async (t) => {
      const optins = offrantes.get(t.id) ?? [];
      return {
        ...t,
        contacts: await compteContenant(db, "subscription", assetId, "interest_ids", t.id),
        sendable: await compteContenant(db, "sendable_subscription", assetId, "interest_ids", t.id),
        asked: await compteChevauchant(db, "subscription", assetId, "capture_optin_ids", optins),
        chosenAmongAsked: await compteChevauchant(
          db, "subscription", assetId, "capture_optin_ids", optins, { colonne: "interest_ids", valeurs: [t.id] },
        ),
        offeredBy: optins.length,
      };
    }),
  );

  return {
    rows,
    offerUnknown: inconnuRes.count ?? 0,
    totalEvents: totalRes.count ?? 0,
    source: "db",
    // ⛔ Sans les créatives, `offrantes` est vide et CHAQUE ligne rend « no one asked » — un état
    // qui se lit comme « personne n'a jamais posé la question », alors qu'on n'a pas pu lire les
    // formulaires. Les intérêts restent affichés, mais la panne est nommée.
    reason: optinRes.error ? optinRes.error.message : null,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * Options de filtre pour la liste des abonnés (aucun compteur : rien d'inventé)
 * ══════════════════════════════════════════════════════════════════════════ */

export interface CaptureFilterOptions {
  campaigns: { id: string; name: string }[];
  interests: { id: number; slug: string; label: string }[];
  source: "db" | "none";
}

/**
 * De quoi peupler les chips « Campaign » et « Interest » en tête de liste — deux requêtes, sans
 * aucun compteur. Un contrôle qui ne propose rien n'est pas affiché : il n'enseignerait que son
 * inutilité.
 */
export async function listCaptureFilterOptions(db: Db, assetId: string | null): Promise<CaptureFilterOptions> {
  if (!assetId) return { campaigns: [], interests: [], source: "none" };
  const [campRes, tagRes] = await Promise.all([
    db.from("capture_campaign").select("id, name").eq("asset_id", assetId)
      .is("archived_at", null).order("name").limit(50),
    db.from("tag").select("id, slug, label").eq("asset_id", assetId).eq("kind", "interest").order("slug").limit(50),
  ]);
  return {
    campaigns: ((campRes.data as unknown[]) ?? []).map((raw) => {
      const c = raw as { id: string; name: string | null };
      return { id: String(c.id), name: c.name || "Untitled campaign" };
    }),
    interests: ((tagRes.data as unknown[]) ?? []).map((raw) => {
      const t = raw as { id: number; slug: string; label: string | null };
      return { id: t.id, slug: t.slug, label: t.label || t.slug };
    }),
    source: "db",
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * Les deux head-counts, et leur garde de vacuité
 * ══════════════════════════════════════════════════════════════════════════ */

/** `@>` sur une seule valeur — le tableau passé n'est jamais vide, donc jamais `cs.{}`. */
async function compteContenant(
  db: Db, relation: string, assetId: string, colonne: string, valeur: string | number,
): Promise<number> {
  const { count } = await db
    .from(relation).select("id", { count: "exact", head: true })
    .eq("asset_id", assetId).contains(colonne, [valeur]);
  return count ?? 0;
}

/**
 * `&&` sur une liste — ⛔ et zéro requête quand la liste est vide.
 * `ov.{}` ne matche personne : le résultat serait le même par accident aujourd'hui, mais c'est un
 * appel réseau payé pour un zéro qu'on connaît déjà, et surtout le symétrique de `cs.{}` qui, lui,
 * ramènerait tout le monde. On ne laisse pas une garde dépendre de l'opérateur choisi.
 */
async function compteChevauchant(
  db: Db,
  relation: string,
  assetId: string,
  colonne: string,
  valeurs: string[],
  /** Restriction facultative — c'est elle qui met numérateur et dénominateur sur la même population. */
  aussi?: { colonne: string; valeurs: (string | number)[] },
): Promise<number> {
  if (valeurs.length === 0) return 0;
  let q = db
    .from(relation).select("id", { count: "exact", head: true })
    .eq("asset_id", assetId).overlaps(colonne, valeurs);
  if (aussi) q = q.contains(aussi.colonne, aussi.valeurs);
  const { count } = await q;
  return count ?? 0;
}

/* ════════════════════════════════════════════════════════════════════════════
 * Enveloppes pour les composants serveur (qui n'ont pas de `db` sous la main)
 * ══════════════════════════════════════════════════════════════════════════ */

export async function loadCaptureCampaigns(assetId: string | null): Promise<CaptureCampaignsResult> {
  const db = getDb();
  if (!db) return { ...CAMPAGNES_VIDE, reason: "no-db" };
  return listCaptureCampaigns(db, assetId);
}

/** ⛔ Sans base, `known:false` : l'écran doit se taire, pas annoncer que le pont n'a rien livré. */
export async function loadCaptureEventCount(assetId: string | null): Promise<CapturesDeLaMarque> {
  const db = getDb();
  if (!db) return { known: false, value: 0 };
  return countCaptureEvents(db, assetId);
}

export async function loadCaptureInterests(assetId: string | null): Promise<CaptureInterestsResult> {
  const db = getDb();
  if (!db) return { ...INTERETS_VIDE, reason: "no-db" };
  return listCaptureInterests(db, assetId);
}

export async function loadCaptureFilterOptions(assetId: string | null): Promise<CaptureFilterOptions> {
  const db = getDb();
  if (!db) return { campaigns: [], interests: [], source: "none" };
  return listCaptureFilterOptions(db, assetId);
}
