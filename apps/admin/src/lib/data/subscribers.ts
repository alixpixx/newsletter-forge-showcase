import { getDb } from "@/lib/supabase";
import { getSessionUser } from "@/lib/session";
import { isUuid } from "@/lib/data/templates";
import { ordreDuTri, TRI_PAR_DEFAUT, type TriAbonnes } from "@/lib/data/tri-abonnes";
import { statutsDuGroupe, type FiltreStatut } from "@/lib/data/statut-abonnes";
import { paysDesLignes, MAX_ECHANTILLON_PAYS } from "@/lib/data/pays-abonnes";
import {
  listCaptureEvents,
  listVariantsPremiereTouche,
  TAG_IMPOSSIBLE,
  UUID_IMPOSSIBLE,
  type CaptureEventRow,
} from "@/lib/data/capture";

export type EngLevel = "active" | "dormant" | "churned";
export type LevelFilter = EngLevel | "all";

/** Un tag de la marque, avec ce qui permet ENFIN de distinguer un intérêt d'un tag d'équipe. */
export interface TagInfo {
  slug: string;
  label: string;
  kind: "manual" | "interest";
}

export interface SubscriberRow {
  /**
   * ⚠️ Clé stable de la ligne. Absente jusqu'au 10/09/2026 : la table s'ordonnait sur
   * `engagement_score` seul, sur 1 203 lignes à scores répétés — un même abonné pouvait donc
   * apparaître page 1 ET page 2, et React n'avait que l'e-mail comme clé.
   */
  id: string;
  email: string;
  first_name: string | null;
  status: string;
  /** Canal d'acquisition (`content_upgrade` pour tout le monde aujourd'hui) — relégué au drawer. */
  source: string | null;
  country: string | null;
  engagement_score: number;
  engagement_level: EngLevel;
  created_at: string;
  tag_ids: number[];
  /** Créative de la PREMIÈRE touche (miroir écrit par le trigger). */
  optin_id: string | null;
  /** Campagne de la première touche. */
  capture_campaign_id: string | null;
  capture_campaign_ids: string[];
  capture_optin_ids: string[];
  interest_ids: number[];
  /** 0 = jamais passé par un formulaire (les 1 202 contacts de démonstration). Pas une panne. */
  capture_event_count: number;
  /**
   * Ce que la personne a accepté de recevoir, finalité par finalité — les cases du formulaire de
   * capture (`granted_purposes`). Le worker s'en sert déjà comme porte d'envoi (`gate.ts`).
   *
   * ⛔ UNE CLÉ ABSENTE N'EST PAS `false`, c'est « on ne lui a jamais posé la question ». Les deux se
   * rendent différemment à l'écran : une case décochée est un refus, une clé absente n'est rien.
   * ⚠️ Et les valeurs de masse ne sont pas des choix : les 1 105 contacts `organic`/`social`/
   * `import`/`crm_sync` portent `offers:true, partners:false` par le BACKFILL de la migration 0014.
   * Les vrais choix sont ceux arrivés par le pont (`content_upgrade`).
   */
  purposes: Record<string, boolean>;
}

/** Les trois niveaux de provenance, tels qu'ils voyagent dans l'URL. */
export interface CaptureFilter {
  /** uuid de `capture_campaign` (notre substitut, pas l'uuid amont). */
  campaign: string | null;
  /** slug d'`optin`. */
  creative: string | null;
  /** slug de `tag` (`kind='interest'`). */
  interest: string | null;
}

/** Un filtre demandé qui ne désigne rien. L'appelant DOIT le dire : sinon la liste vide ment. */
export interface FiltresIntrouvables {
  campaign: boolean;
  creative: boolean;
  interest: boolean;
}

export const AUCUN_FILTRE_CAPTURE: CaptureFilter = { campaign: null, creative: null, interest: null };

export interface SubscribersResult {
  rows: SubscriberRow[];
  counts: Record<LevelFilter, number>;
  /** id -> slug/libellé/nature, pour afficher les tags et les intérêts sans requête par ligne. */
  tags: Record<number, TagInfo>;
  /** uuid de créative -> nom courant, résolu une fois pour toute la page. */
  optinNames: Record<string, string>;
  /** uuid de campagne d'acquisition -> nom courant. */
  campaignNames: Record<string, string>;
  /**
   * uuid de SOUSCRIPTION -> libellé du bras A/B de sa PREMIÈRE capture — la même que celle dont la
   * créative est affichée. Absent quand cette capture ne portait pas de bras : l'écran se tait
   * alors, il n'affirme pas que le formulaire n'avait pas d'A/B (voir `variantDePremiereTouche`).
   */
  variantNames: Record<string, string>;
  /** Ce que la marque peut réellement servir, sous les MÊMES filtres que la liste. */
  sendable: number;
  /** Contacts de démonstration compris dans la liste — la liste les MONTRE, elle ne les cache pas. */
  demo: number;
  notFound: FiltresIntrouvables;
  page: number;
  pageSize: number;
  /**
   * false = aucun filtre marque appliqué (base injoignable) → la liste et les compteurs
   * sont un AGRÉGAT toutes marques. L'appelant DOIT le signaler.
   */
  scoped: boolean;
  source: "db" | "none";
}

const EMPTY: SubscribersResult = {
  rows: [],
  counts: { all: 0, active: 0, dormant: 0, churned: 0 },
  tags: {},
  optinNames: {},
  campaignNames: {},
  variantNames: {},
  sendable: 0,
  demo: 0,
  notFound: { campaign: false, creative: false, interest: false },
  page: 1,
  pageSize: 25,
  scoped: false,
  source: "none",
};

export interface SubscriberDetail {
  email: string;
  first_name: string | null;
  created_at: string | null;
  subscriptions: {
    asset: string;
    assetId: string | null;
    /** P9 : false ⇒ l'origine de cette marque est masquée, le consentement reste montré. */
    canAccess: boolean;
    source: string | null;
    status: string;
    purposes: Record<string, boolean>;
    tracking: boolean;
  }[];
  events: { event_type: string; purpose: string | null; method: string | null; legal_basis: string | null; occurred_at: string }[];
  /** Les inscriptions observées, du plus récent au plus ancien — marques autorisées SEULEMENT. */
  captures: CaptureEventRow[];
  /** Combien de marques ont vu leur origine masquée. Le dire vaut mieux que faire disparaître. */
  hiddenOrigins: number;
}

/**
 * Détail d'un abonné (profil + consentement par marque + timeline d'audit + provenance) pour le drawer.
 * VOLONTAIREMENT non scopé : le RGPD/LGPD impose de pouvoir montrer TOUS les consentements
 * d'une personne. Chaque ligne porte déjà son nom de marque, donc rien n'est ambigu.
 *
 * ⛔ La PROVENANCE, elle, est scopée (P9). Montrer les consentements d'une marque interdite est une
 * obligation ; montrer son plan d'acquisition — quelle campagne, quelle créative, quel placement —
 * n'en est pas une. Le masquage est fait dans la requête, pas au rendu.
 */
export async function getSubscriberDetail(email: string): Promise<SubscriberDetail | null> {
  const db = getDb();
  if (!db) return null;
  const { data: sub } = await db
    .from("subscriber").select("id, email, first_name, created_at").eq("email", email).maybeSingle();
  if (!sub) return null;

  const { data: subs } = await db
    .from("subscription")
    .select("status, granted_purposes, tracking_consent, source, id, asset_id, asset:asset_id(name)")
    .eq("subscriber_id", sub.id);
  const subIds = (subs ?? []).map((s) => (s as { id: string }).id);

  // ⛔ Fail closed : pas de session lisible ⇒ aucune marque autorisée ⇒ aucune origine servie.
  const u = await getSessionUser();
  const autorisees = u?.assetIds ?? [];

  let events: SubscriberDetail["events"] = [];
  if (subIds.length) {
    const { data: ev } = await db
      .from("consent_event")
      .select("event_type, purpose, method, legal_basis, occurred_at")
      .in("subscription_id", subIds)
      .order("occurred_at", { ascending: false })
      .limit(40);
    events = ((ev as unknown[]) ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        event_type: String(r.event_type ?? ""),
        purpose: (r.purpose as string | null) ?? null,
        method: (r.method as string | null) ?? null,
        legal_basis: (r.legal_basis as string | null) ?? null,
        occurred_at: String(r.occurred_at ?? ""),
      };
    });
  }

  const captures = await listCaptureEvents(db, subIds, autorisees);

  const subscriptions = ((subs as unknown[]) ?? []).map((raw) => {
    const r = raw as Record<string, unknown> & { asset?: { name?: string } };
    const assetId = (r.asset_id as string | null) ?? null;
    const canAccess = assetId !== null && autorisees.includes(assetId);
    return {
      asset: r.asset?.name ?? "—",
      assetId,
      canAccess,
      // Le canal d'acquisition fait partie de l'origine : masqué avec elle.
      source: canAccess ? ((r.source as string | null) ?? null) : null,
      status: String(r.status ?? ""),
      purposes: (r.granted_purposes ?? {}) as Record<string, boolean>,
      tracking: r.tracking_consent === true,
    };
  });

  return {
    email: sub.email,
    first_name: sub.first_name ?? null,
    created_at: sub.created_at ?? null,
    subscriptions,
    events,
    captures,
    hiddenOrigins: subscriptions.filter((s) => !s.canAccess).length,
  };
}

/**
 * Total d'abonnés réellement abonnés (status=active) pour la marque — DÉNOMINATEUR du % de
 * segment. Sans `assetId` ce total était l'agrégat 9 marques et le pourcentage affiché faux.
 * `assetId === null` (base injoignable) → agrégat, à signaler côté UI.
 *
 * ⛔ `null` QUAND LA LECTURE N'A PAS ABOUTI (pas de base, erreur, compte absent), JAMAIS 0 : l'écran
 * Targeting affichait « 0 active subscribers in scope » base coupée — un chiffre que rien n'a lu.
 */
export async function getActiveTotal(assetId: string | null): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const q = db
    .from("subscription")
    .select("*", { count: "exact", head: true })
    .eq("status", "active");
  const { count, error } = await (assetId ? q.eq("asset_id", assetId) : q);
  if (error || count == null) return null;
  return count;
}

/**
 * Liste + compteurs d'abonnés, lus depuis `newsletter.subscription` (service_role).
 * Scopé sur `assetId` (colonne `asset_id`, NOT NULL en base). Paginé via `page` (1-based).
 * `assetId === null` → pas de filtre, `scoped: false` renvoyé à l'appelant.
 */
export async function getSubscribers(
  assetId: string | null,
  level: LevelFilter = "all",
  page = 1,
  limit = 25,
  filtre: CaptureFilter = AUCUN_FILTRE_CAPTURE,
  tri: TriAbonnes = TRI_PAR_DEFAUT,
  statut: FiltreStatut | null = null,
  /** Code ISO 3166-1 alpha-2 DÉJÀ validé par `paysDemande` — jamais une valeur d’URL brute. */
  pays: string | null = null,
): Promise<SubscribersResult> {
  const db = getDb();
  if (!db) return { ...EMPTY, page, pageSize: limit };
  // ⛔ Sans marque courante, on rend VIDE au lieu d'agréger toutes les marques : le filtre
  // était simplement omis, et un membre d'une seule marque voyait les abonnés des neuf.
  if (!assetId) return { ...EMPTY, page, pageSize: limit };

  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * limit;

  /*
   * Les trois niveaux de provenance, résolus en identifiants AVANT toute requête.
   *
   * ⛔ Un identifiant demandé qui n'existe pas ne doit PAS retomber sur « pas de filtre » : l'écran
   * afficherait toute la marque en montrant le filtre comme actif — le pire des deux mondes.
   * On le traduit en un filtre qui ne matche rien, et la liste vide est alors la vérité.
   *
   * ⛔ La sentinelle est un tableau NON VIDE contenant une valeur impossible. Un tableau vide
   * ferait l'inverse exact de ce qu'on veut : `cs.{}` matche TOUT LE MONDE (1 203/1 203, mesuré en
   * production le 09/09/2026).
   */
  const notFound: FiltresIntrouvables = { campaign: false, creative: false, interest: false };

  let optinId: string | null = null;
  if (filtre.creative) {
    const { data } = await db
      .from("optin").select("id").eq("asset_id", assetId).eq("slug", filtre.creative).maybeSingle();
    optinId = data ? String((data as { id: string }).id) : null;
    notFound.creative = optinId === null;
  }

  let campaignId: string | null = null;
  if (filtre.campaign) {
    // ⚠️ Une valeur qui n'a pas la forme d'un uuid ne part pas en base : PostgREST rendrait une
    // 22P02 que ce code lirait comme « aucune ligne », soit le bon résultat pour la mauvaise raison.
    if (isUuid(filtre.campaign)) {
      const { data } = await db
        .from("capture_campaign").select("id").eq("asset_id", assetId).eq("id", filtre.campaign).maybeSingle();
      campaignId = data ? String((data as { id: string }).id) : null;
    }
    notFound.campaign = campaignId === null;
  }

  let interestId: number | null = null;
  if (filtre.interest) {
    const { data } = await db
      .from("tag").select("id").eq("asset_id", assetId).eq("kind", "interest")
      .eq("slug", filtre.interest).maybeSingle();
    interestId = data ? Number((data as { id: number }).id) : null;
    notFound.interest = interestId === null;
  }

  /**
   * ⛔ LES QUATRE COLONNES DE PROVENANCE SONT DES TABLEAUX. Un `.eq("capture_optin_ids", uuid)`
   * lève une 42883 (`uuid[] = uuid`) et fait PLANTER le composant serveur au lieu de rendre une
   * liste vide — sur un chemin qu'aucun clic normal n'emprunte, donc invisible jusqu'à la prod.
   *
   * Les contraintes sont décrites UNE fois et rejouées sur les six requêtes (liste, 4 compteurs,
   * 2 vues) : c'est ce qui garantit que les nombres affichés parlent de la population affichée.
   */
  const contraintes: { colonne: string; valeurs: (string | number)[] }[] = [];
  if (optinId) contraintes.push({ colonne: "capture_optin_ids", valeurs: [optinId] });
  else if (notFound.creative) contraintes.push({ colonne: "capture_optin_ids", valeurs: [UUID_IMPOSSIBLE] });
  if (campaignId) contraintes.push({ colonne: "capture_campaign_ids", valeurs: [campaignId] });
  else if (notFound.campaign) contraintes.push({ colonne: "capture_campaign_ids", valeurs: [UUID_IMPOSSIBLE] });
  if (interestId !== null) contraintes.push({ colonne: "interest_ids", valeurs: [interestId] });
  else if (notFound.interest) contraintes.push({ colonne: "interest_ids", valeurs: [TAG_IMPOSSIBLE] });

  /*
   * L'état de consentement demandé, en statuts de base.
   *
   * ⛔ IL SE REJOUE SUR LES SIX REQUÊTES, comme les contraintes de provenance. Appliqué à la seule
   * liste, les compteurs des onglets et le « N sendable » de l'en-tête continueraient de décrire
   * toute la marque au-dessus d'un tableau qui n'en montre qu'une part — c'est le défaut que ce
   * fichier a déjà corrigé une fois pour le niveau d'engagement.
   */
  const statuts = statutsDuGroupe(statut);

  const countFor = (lvl?: EngLevel) => {
    let q = db.from("subscription").select("*", { count: "exact", head: true }).eq("asset_id", assetId);
    // ⚠️ Les compteurs par niveau héritent du filtre de la LISTE, sinon les nombres affichés à côté
    // de « Active / Dormant » parleraient d'une population plus large que celle qu'on voit.
    for (const c of contraintes) q = q.contains(c.colonne, c.valeurs);
    if (statuts.length > 0) q = q.in("status", statuts);
    // ⚠️ Le pays AUSSI : posé sur la seule liste, il laisserait ces compteurs décrire toute la
    // marque au-dessus d’un tableau qui n’en montre qu’un pays.
    if (pays) q = q.eq("country", pays);
    return lvl ? q.eq("engagement_level", lvl) : q;
  };

  /**
   * Les deux nombres qui rendent le zéro lisible : ce qu'une campagne peut servir, et combien de
   * contacts de démonstration la liste contient. ⚠️ La liste les MONTRE (aucun filtre `is_demo`
   * n'existe ici) : l'en-tête doit donc dire « of them are demo contacts », jamais « hidden ».
   */
  const countVue = (vue: string) => {
    let q = db.from(vue).select("id", { count: "exact", head: true }).eq("asset_id", assetId);
    // ⚠️ Le niveau AUSSI, exactement comme la liste : sans lui, « N sendable » et « N of them are
    // demo » décrivaient toute la marque sous un tableau qui n'en montre qu'un tiers, et le mot
    // « them » désignait une population que l'écran ne servait pas.
    if (level !== "all") q = q.eq("engagement_level", level);
    for (const c of contraintes) q = q.contains(c.colonne, c.valeurs);
    // ⚠️ `sendable_subscription` ne contient QUE des `active` : filtrer sur « Unsubscribed » y rend
    // donc 0, et c'est la vérité — aucun désabonné n'est envoyable. Le taire afficherait « 412
    // sendable » sous une liste de désabonnés.
    if (statuts.length > 0) q = q.in("status", statuts);
    if (pays) q = q.eq("country", pays);
    return q;
  };

  // Filtres AVANT order/range : `.eq()` / `.contains()` n'existent pas sur le transform builder.
  let listFilter = db
    .from("subscription")
    .select(
      "id, status, source, country, engagement_score, engagement_level, created_at, tag_ids, optin_id, capture_campaign_id, capture_campaign_ids, capture_optin_ids, interest_ids, capture_event_count, granted_purposes, subscriber:subscriber_id(email, first_name)",
    )
    .eq("asset_id", assetId);
  if (level !== "all") listFilter = listFilter.eq("engagement_level", level);
  for (const c of contraintes) listFilter = listFilter.contains(c.colonne, c.valeurs);
  if (statuts.length > 0) listFilter = listFilter.in("status", statuts);
  // ⛔ `.eq()` et non `.contains()` : `country` est une colonne SCALAIRE. Les mélanger lève une
  // 42883 (`text = text[]`) qui fait PLANTER le composant serveur au lieu de rendre une liste vide.
  if (pays) listFilter = listFilter.eq("country", pays);
  /*
   * ⚠️ L'ORDRE VIENT DU MENU, LA CLÉ DE DÉPARTAGE RESTE. `ordreDuTri` ne rend qu'une colonne
   * connue : un `?sort=` recopié de travers est retombé sur le défaut bien avant d'arriver ici, il
   * n'entre jamais dans un `.order()`.
   */
  const ordre = ordreDuTri(tri);
  const listQ = listFilter
    .order(ordre.colonne, { ascending: ordre.ascendant })
    // ⛔ CLÉ SECONDAIRE OBLIGATOIRE. Sans elle, deux lignes de même score n'ont pas d'ordre stable
    // entre deux requêtes : parcourir les pages pouvait montrer le même abonné deux fois et en
    // sauter un autre, sans qu'aucun compteur ne bouge. Elle vaut pour TOUS les tris — « inscrit le
    // même jour » est encore plus fréquent qu'« même score ».
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  const [all, active, dormant, churned, list, tagList, sendableRes, demoRes] = await Promise.all([
    countFor(),
    countFor("active"),
    countFor("dormant"),
    countFor("churned"),
    listQ,
    // ⛔ Scopé marque. Cette lecture agrégeait les 9 marques : une carte de tags d'une autre marque
    // pouvait donner un libellé à un identifiant qui n'appartient pas à celle qu'on regarde.
    db.from("tag").select("id, slug, label, kind").eq("asset_id", assetId),
    countVue("sendable_subscription"),
    countVue("excluded_demo_subscription"),
  ]);

  if (list.error || !list.data) return { ...EMPTY, page: safePage, pageSize: limit, scoped: assetId !== null };

  const tags: Record<number, TagInfo> = {};
  for (const t of tagList.data ?? []) {
    const row = t as { id: number; slug: string; label: string | null; kind: string | null };
    tags[row.id] = {
      slug: row.slug,
      label: row.label || row.slug,
      kind: row.kind === "interest" ? "interest" : "manual",
    };
  }

  const rows: SubscriberRow[] = (list.data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown> & { subscriber?: { email?: string; first_name?: string | null } };
    return {
      id: String(r.id ?? ""),
      email: r.subscriber?.email ?? "",
      first_name: r.subscriber?.first_name ?? null,
      status: String(r.status ?? ""),
      source: (r.source as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      engagement_score: Number(r.engagement_score ?? 0),
      engagement_level: (r.engagement_level as EngLevel) ?? "churned",
      created_at: String(r.created_at ?? ""),
      tag_ids: (r.tag_ids as number[]) ?? [],
      optin_id: (r.optin_id as string | null) ?? null,
      capture_campaign_id: (r.capture_campaign_id as string | null) ?? null,
      capture_campaign_ids: (r.capture_campaign_ids as string[]) ?? [],
      capture_optin_ids: (r.capture_optin_ids as string[]) ?? [],
      interest_ids: (r.interest_ids as number[]) ?? [],
      capture_event_count: Number(r.capture_event_count ?? 0),
      // ⛔ Une clé ABSENTE n'est pas `false` : on rend l'objet tel quel et la colonne n'affiche
      // que les finalités VRAIES. Fabriquer les 4 clés ici ferait mentir l'écran sur les
      // abonnements antérieurs au recueil du choix.
      purposes: (r.granted_purposes ?? {}) as Record<string, boolean>,
    };
  });

  // Les libellés de provenance : DEUX requêtes pour toute la page, et ZÉRO quand la page n'en
  // contient aucune (le cas du jour 1). ⛔ Jamais `.in("id", [])` : une requête payée pour rien,
  // et le premier pas vers une requête par ligne.
  // ⚠️ Le bras A/B s'ajoute ici et NULLE PART AILLEURS : il ne vit que sur `capture_event`, aucune
  // colonne de `subscription` ne le porte. C'est aussi pourquoi il reste une information et ne
  // deviendra pas un filtre — arbitrage d'Alix du 13/09/2026.
  // ⛔ Aucune requête pour les lignes sans capture : une page de contacts de démonstration n'en
  // déclenche aucune.
  const [optinNames, campaignNames, variantNames] = await Promise.all([
    nomsPar(db, "optin", [...new Set(rows.flatMap((r) => [...r.capture_optin_ids, ...(r.optin_id ? [r.optin_id] : [])]))], "Untitled form"),
    nomsPar(db, "capture_campaign", [...new Set(rows.flatMap((r) => [...r.capture_campaign_ids, ...(r.capture_campaign_id ? [r.capture_campaign_id] : [])]))], "Untitled campaign"),
    listVariantsPremiereTouche(db, rows.filter((r) => r.capture_event_count > 0).map((r) => r.id)),
  ]);

  return {
    rows,
    counts: {
      all: all.count ?? 0,
      active: active.count ?? 0,
      dormant: dormant.count ?? 0,
      churned: churned.count ?? 0,
    },
    tags,
    optinNames,
    campaignNames,
    variantNames,
    sendable: sendableRes.count ?? 0,
    demo: demoRes.count ?? 0,
    notFound,
    page: safePage,
    pageSize: limit,
    scoped: assetId !== null,
    source: "db",
  };
}

/**
 * uuid -> nom courant. ⛔ Garde de vacuité : aucune requête sans identifiant à résoudre.
 *
 * ⛔ UN NOM VIDE N'EST PAS UN NOM ABSENT. `name` est `not null` mais rien n'interdit la chaîne
 * vide, et le libellé vient de l'émetteur. Laisser tomber l'entrée faisait rendre « Signup form
 * unknown » / « No campaign » pour une créative parfaitement retrouvée — la ligne se lisait comme
 * une lecture ratée. Le repli reprend mot pour mot celui des pastilles de filtre
 * (`listCaptureFilterOptions`), sinon deux écrans nomment la même ligne de deux façons.
 */
async function nomsPar(
  db: NonNullable<ReturnType<typeof getDb>>,
  relation: string,
  ids: string[],
  siVide: string,
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data } = await db.from(relation).select("id, name").in("id", ids);
  const out: Record<string, string> = {};
  for (const raw of (data as unknown[]) ?? []) {
    const r = raw as { id: string; name: string | null };
    out[String(r.id)] = r.name?.trim() ? r.name : siVide;
  }
  return out;
}


/**
 * Les pays présents chez cette marque, pour le menu du filtre.
 *
 * ⛔ POSTGREST N’A PAS DE `SELECT DISTINCT`. Le menu se construit donc sur un ÉCHANTILLON borné
 * d’une seule colonne, pas sur un ensemble de valeurs. Conséquence assumée : au-delà du plafond, un
 * pays rare peut manquer du menu — il reste atteignable par l’URL, `paysDemande` n’ayant jamais
 * besoin du menu pour accepter un code bien formé.
 *
 * ⚠️ DÉLIBÉRÉMENT HORS DE `getSubscribers` : la route « tout sélectionner » appelle celle-ci pour
 * résoudre une population et n’a aucun menu à construire. Lui faire payer cette lecture serait une
 * requête de plus par clic, pour rien.
 */
export async function getPaysAbonnes(assetId: string | null): Promise<string[]> {
  const db = getDb();
  if (!db || !assetId) return [];
  const { data, error } = await db
    .from("subscription")
    .select("country")
    .eq("asset_id", assetId)
    .not("country", "is", null)
    .limit(MAX_ECHANTILLON_PAYS);
  if (error || !data) return [];
  return paysDesLignes(data as { country?: unknown }[]);
}
