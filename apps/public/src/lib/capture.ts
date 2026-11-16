import type { Db } from "./supabase";
import { readLabel } from "./automation-label";
import { MAX_SLUGS, MAX_SLUG_LENGTH } from "./interests";
import { isUuidLoose } from "./uuid";

/**
 * LE CONTRAT D'INGESTION v2 — la provenance à trois niveaux (campagne → créative → intérêts).
 *
 * CE QUE CE MODULE FAIT, ET DANS QUEL ORDRE. Il LIT le contrat (partie pure, sans base), puis il
 * ÉCRIT — un résolveur par niveau, plus l'écriture de l'événement — et enfin il RELIT pour l'écho.
 * La séparation n'est pas cosmétique : la partie pure est la seule qui puisse être mise sous banc
 * sans harnais, et c'est elle qui porte toutes les décisions de forme.
 *
 * ⛔ POURQUOI UN OBJET NEUF, ET AUCUN CHAMP EXISTANT TOUCHÉ (D5). Si l'émetteur partait le premier
 * en envoyant des OBJETS dans `interests` (le champ v1, qui attend des chaînes),
 * `normalizeInterests` écarterait chaque élément non-`string`, la longueur tomberait à 0, la
 * branche entière serait sautée et la réponse serait `200 {ok:true}` : 100 % des intérêts perdus,
 * sans une ligne de journal. Le v2 s'AJOUTE, le v1 reste accepté et gelé.
 *
 * ⛔ ABSENCE ≠ NULL, et c'est le mécanisme de PostgREST qui le rend implémentable : une clé absente
 * du payload n'est pas écrite, une clé à `null` l'est. D'où trois états distincts et jamais
 * confondus pour la campagne d'une créative : champ absent = on ne touche à rien ; `null` explicite
 * = on détache ; objet = on rattache. Un `capture_campaign_id: x ?? null` mal placé détacherait la
 * créative de sa campagne à chaque inscription où l'émetteur n'a rien dit.
 *
 * ⛔ LES TROIS ABSENCES DES INTÉRÊTS NE SE CONFONDENT PAS (P6). « le formulaire ne demande rien »
 * (`asks:false`), « il demande et rien n'a été coché » (`asks:true`, `chosen:[]`) et « on ignore ce
 * qu'il proposait » (`offered` absent ⇒ `interests_offered` NULL en base) sont trois faits
 * différents. Le dernier est le dénominateur de tout taux d'intérêt : le perdre une fois le perd
 * pour toujours, puisque rien ne permet de le reconstituer après coup.
 *
 * ⛔ UN ACCESSOIRE NE COÛTE JAMAIS UNE INSCRIPTION. Un slug d'intérêt hors format est ÉCARTÉ avec
 * son motif, jamais refusé. Les deux seules exceptions sont des identifiants et des vocabulaires :
 * un uuid mal formé et une taxonomie inconnue produiraient un classement faux et DÉFINITIF (voir
 * plus bas), donc un 422 lisible côté émetteur.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LES SIX DÉCISIONS TRANCHÉES LE 10/09/2026 AVANT D'ÉCRIRE UNE LIGNE
 *
 * (a) TAXONOMIES : jeu FERMÉ (`tag` | `category` | `custom`). Côté optinforge la liste des sujets
 *     est lue en direct sur WordPress et mélange deux espaces de noms : `noticias` peut être une
 *     catégorie ET un tag. Sans taxonomie fiable, les deux fusionneraient en un seul intérêt,
 *     IRRÉVERSIBLEMENT (l'identité d'un tag est `unique(asset_id, slug)`). Une taxonomie inconnue
 *     est donc un 422, pas un repli : se replier sur `custom` fabriquerait exactement la fusion
 *     qu'on cherche à empêcher.
 * (b) `creative.variant_label` est écrit dans `capture_event.variant_external_id`. La colonne
 *     s'appelle « external_id » et recevra un LIBELLÉ : le nom ment, et c'est assumé — perdre la
 *     variante coûterait plus cher qu'un nom de colonne imparfait, et la renommer imposerait un
 *     `create or replace` des trois vues d'audience.
 * (c) `creative.parent_external_id` : AUCUNE colonne d'accueil n'existe (vérifié dans 0063). Il est
 *     donc déclaré dans `ignored_fields` — c'est précisément le signal que ce champ sert à produire.
 *     Le stocker dans un jsonb libre reviendrait à le perdre en douceur.
 * (d) Les intérêts v2 ne sont PAS écrits dans `subscription_tag` / `subscription.tag_ids`.
 *     `subscription.interest_ids` est maintenu par le TRIGGER depuis `capture_event` ; écrire aussi
 *     les tables de tags recréerait les deux écrivains applicatifs du même fait dénoncés par D6 —
 *     ceux qui concordent par chance jusqu'au jour où un quatrième chemin en oublie un.
 * (e) `tracking_consent` : fusionné par OU, comme les finalités. Le code d'avant écrivait
 *     `body.tracking_consent === true` sur une souscription existante : une seconde inscription
 *     muette sur ce champ posait `false` par-dessus un `true` et remettait `tracking_consent_at` à
 *     NULL, sans le moindre `consent_event` de retrait. ⚠️ Le RETRAIT reste possible, par le centre
 *     de préférences, qui lui écrit sa preuve. → à confirmer par Alix.
 * (f) RPC `ingest_capture()` : ABSENTE du dépôt au 10/09/2026 (dernière migration : 0063).
 *     L'écriture passe donc par un insert nu, isolé dans `writeCaptureEvent` — le jour où la RPC
 *     arrive, c'est UNE fonction à basculer, pas un chemin à retrouver dans la route.
 */

/** La version du contrat que ce récepteur comprend. Un autre numéro est refusé, jamais deviné. */
export const CAPTURE_CONTRACT = 2;

/** Voir (a) : le jeu est FERMÉ, et c'est ce qui empêche deux espaces de noms de fusionner. */
export const CAPTURE_TAXONOMIES = ["tag", "category", "custom"] as const;
export type CaptureTaxonomy = (typeof CAPTURE_TAXONOMIES)[number];

/** Bornes de texte libre. Alignées sur `optin.name` (120) et sur la borne de slug déjà en place. */
const MAX_NAME = 120;
const MAX_LEAD_ID = 200;
const MAX_PLACEMENT = 64;

/**
 * Le slug d'un intérêt, AVANT préfixage. Volontairement plus strict que le v1 (qui accepte
 * n'importe quelle chaîne de 64 caractères) : ce slug devient un morceau d'IDENTITÉ permanente
 * (`interest:<taxonomy>:<slug>`), et un accent ou une espace y produirait deux tags pour un même
 * sujet selon l'encodage d'arrivée.
 */
const INTEREST_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface CaptureInterestItem {
  /** Le slug tel que l'émetteur l'écrit, conservé pour `tag.source_slug`. */
  slug: string;
  label: string;
  taxonomy: CaptureTaxonomy;
}

/** Ce qui a été compris mais ÉCARTÉ, avec son motif — jamais un silence. */
export interface CaptureRejected {
  slug: string;
  reason: string;
}

export interface CaptureCampaignInput {
  externalId: string;
  name: string;
}

export interface CaptureCreativeInput {
  externalId: string;
  name: string;
  placement: string | null;
  /** Voir (b) : un LIBELLÉ, destiné à une colonne qui s'appelle `variant_external_id`. */
  variantLabel: string | null;
  /**
   * Le SLUG du label d'automation (0095), calculé ici depuis le NOM envoyé (`lib/automation-label.ts`).
   * `null` = aucun label, ou un nom inutilisable : écarté, jamais refusé (un accessoire ne coûte pas
   * une inscription) — l'émetteur le lit dans `resolved.automation_label`.
   */
  automationLabel: string | null;
}

export interface CaptureInterestsInput {
  /** `false` = ce formulaire ne POSE pas la question. Sans lui, P6 est inexprimable. */
  asks: boolean;
  /** `undefined` = l'émetteur n'a rien dit ⇒ `interests_offered` reste NULL. `[]` = rien proposé. */
  offered: CaptureInterestItem[] | undefined;
  chosen: CaptureInterestItem[];
  rejected: CaptureRejected[];
}

export interface CaptureV2 {
  leadId: string | null;
  /** `undefined` ⇒ la colonne n'est pas citée, et c'est le défaut de la base qui décide. */
  occurredAt: string | undefined;
  /** `undefined` = absent (ne rien toucher) ; `null` = détachement explicite. */
  campaign: CaptureCampaignInput | null | undefined;
  creative: CaptureCreativeInput | null | undefined;
  interests: CaptureInterestsInput | undefined;
}

export type CaptureParse =
  | { ok: true; value: CaptureV2 | null }
  | { ok: false; error: string; field: string; expected: string };

function refus(error: string, field: string, expected: string): CaptureParse & { ok: false } {
  return { ok: false, error, field, expected };
}

function estObjet(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function texte(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

/**
 * Lit une liste d'intérêts (proposés ou cochés).
 *
 * Rend `kept` ET `rejected` : le v1 (`normalizeInterests`) écarte en SILENCE par un `continue`, ce
 * qui convenait à un tableau de chaînes anonymes. Ici chaque intérêt écarté est un sujet que
 * quelqu'un a coché et ne recevra pas — l'émetteur doit pouvoir le lire, avec son motif.
 *
 * ⛔ SEULE la taxonomie fait échouer (voir (a)). Tout le reste est écarté.
 */
export function normalizeInterestItems(
  raw: unknown,
  chemin: string,
):
  | { ok: true; kept: CaptureInterestItem[]; rejected: CaptureRejected[] }
  | { ok: false; error: string; field: string; expected: string } {
  const kept: CaptureInterestItem[] = [];
  const rejected: CaptureRejected[] = [];
  if (!Array.isArray(raw)) {
    return { ok: false, error: "capture-interets-invalide", field: chemin, expected: "array" };
  }

  const vus = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entree = raw[i];
    if (!estObjet(entree)) {
      rejected.push({ slug: String(i), reason: "pas-un-objet" });
      continue;
    }

    // La taxonomie d'abord : elle décide de l'IDENTITÉ, donc elle est vérifiée avant tout le reste.
    const taxonomy = typeof entree.taxonomy === "string" ? entree.taxonomy.trim().toLowerCase() : "";
    if (!(CAPTURE_TAXONOMIES as readonly string[]).includes(taxonomy)) {
      return {
        ok: false,
        error: "capture-taxonomie-inconnue",
        field: `${chemin}[${i}].taxonomy`,
        expected: CAPTURE_TAXONOMIES.join("|"),
      };
    }

    const brut = typeof entree.slug === "string" ? entree.slug.trim().toLowerCase() : "";
    if (!brut) {
      rejected.push({ slug: String(entree.slug ?? ""), reason: "slug-absent" });
      continue;
    }
    if (brut.length > MAX_SLUG_LENGTH) {
      rejected.push({ slug: brut.slice(0, MAX_SLUG_LENGTH), reason: "slug-trop-long" });
      continue;
    }
    if (!INTEREST_SLUG_RE.test(brut)) {
      // Un accent, une espace, une majuscule accentuée : deux encodages du même sujet donneraient
      // deux tags permanents. Écarté avec son motif plutôt que translittéré au jugé.
      rejected.push({ slug: brut, reason: "slug-hors-format" });
      continue;
    }

    const cle = `${taxonomy}:${brut}`;
    if (vus.has(cle)) {
      rejected.push({ slug: brut, reason: "doublon" });
      continue;
    }
    if (kept.length >= MAX_SLUGS) {
      rejected.push({ slug: brut, reason: `au-dela-de-${MAX_SLUGS}` });
      continue;
    }

    vus.add(cle);
    kept.push({
      slug: brut,
      label: texte(entree.label, MAX_NAME) ?? brut,
      taxonomy: taxonomy as CaptureTaxonomy,
    });
  }

  return { ok: true, kept, rejected };
}

/**
 * Lit l'objet `capture`. Aucune base, aucun effet : c'est la fonction que le banc met sous tension.
 *
 * Le champ ABSENT rend `{ ok: true, value: null }` : un corps v1 pur reste parfaitement valide, et
 * les deux côtés du pont doivent pouvoir être déployés dans n'importe quel ordre.
 */
export function parseCapture(raw: unknown): CaptureParse {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!estObjet(raw)) return refus("capture-invalide", "capture", "object");

  // La VERSION avant tout le reste : lire un contrat inconnu avec les règles de celui-ci
  // fabriquerait des données plausibles et fausses, ce qui est pire qu'un refus.
  if (raw.v !== CAPTURE_CONTRACT) {
    return refus("capture-version-inconnue", "capture.v", String(CAPTURE_CONTRACT));
  }

  let leadId: string | null = null;
  if (raw.lead_id !== undefined && raw.lead_id !== null) {
    const t = texte(raw.lead_id, MAX_LEAD_ID);
    // C'est la clé de déduplication de l'événement : mal formée, elle rendrait le doublon
    // indétectable et l'émetteur ne le saurait jamais.
    if (!t) return refus("capture-lead-id-invalide", "capture.lead_id", "non-empty string");
    leadId = t;
  }

  let occurredAt: string | undefined;
  if (raw.occurred_at !== undefined && raw.occurred_at !== null) {
    const t = typeof raw.occurred_at === "string" ? raw.occurred_at.trim() : "";
    const d = t ? new Date(t) : new Date(NaN);
    // Une date illisible deviendrait « maintenant » et réécrirait l'ordre des touches — donc la
    // première touche, donc le rattachement de campagne de la souscription.
    if (Number.isNaN(d.getTime())) {
      return refus("capture-date-invalide", "capture.occurred_at", "ISO 8601 timestamp");
    }
    occurredAt = d.toISOString();
  }

  let campaign: CaptureCampaignInput | null | undefined;
  if (raw.campaign === null) {
    campaign = null;
  } else if (raw.campaign !== undefined) {
    if (!estObjet(raw.campaign)) return refus("capture-campagne-invalide", "capture.campaign", "object or null");
    const ext = texte(raw.campaign.external_id, 64);
    if (!ext || !isUuidLoose(ext)) {
      return refus("capture-campagne-invalide", "capture.campaign.external_id", "uuid");
    }
    const name = texte(raw.campaign.name, MAX_NAME);
    // Le nom n'est pas décoratif : c'est le seul libellé que l'écran de provenance saura afficher,
    // et une campagne sans nom y serait un uuid nu que personne ne sait relier à quoi que ce soit.
    if (!name) return refus("capture-campagne-invalide", "capture.campaign.name", "non-empty string");
    campaign = { externalId: ext.toLowerCase(), name };
  }

  let creative: CaptureCreativeInput | null | undefined;
  if (raw.creative === null) {
    creative = null;
  } else if (raw.creative !== undefined) {
    if (!estObjet(raw.creative)) return refus("capture-creative-invalide", "capture.creative", "object or null");
    const ext = texte(raw.creative.external_id, 64);
    if (!ext || !isUuidLoose(ext)) {
      return refus("capture-creative-invalide", "capture.creative.external_id", "uuid");
    }
    const name = texte(raw.creative.name, MAX_NAME);
    if (!name) return refus("capture-creative-invalide", "capture.creative.name", "non-empty string");
    creative = {
      externalId: ext.toLowerCase(),
      name,
      placement: texte(raw.creative.placement, MAX_PLACEMENT),
      variantLabel: texte(raw.creative.variant_label, MAX_NAME),
      automationLabel: readLabel(raw.creative.automation_label)?.slug ?? null,
    };
  }

  let interests: CaptureInterestsInput | undefined;
  if (raw.interests !== undefined && raw.interests !== null) {
    if (!estObjet(raw.interests)) return refus("capture-interets-invalide", "capture.interests", "object");
    if (typeof raw.interests.asks !== "boolean") {
      return refus("capture-interets-invalide", "capture.interests.asks", "boolean");
    }

    const rejected: CaptureRejected[] = [];
    let offered: CaptureInterestItem[] | undefined;
    // ⛔ `offered` ABSENT et `offered: []` sont deux faits opposés : « on ne sait pas ce qui était
    //    proposé » et « rien n'était proposé ». Le premier laisse `interests_offered` à NULL.
    if (raw.interests.offered !== undefined && raw.interests.offered !== null) {
      const lu = normalizeInterestItems(raw.interests.offered, "capture.interests.offered");
      if (!lu.ok) return refus(lu.error, lu.field, lu.expected);
      offered = lu.kept;
      rejected.push(...lu.rejected);
    }

    let chosen: CaptureInterestItem[] = [];
    if (raw.interests.chosen !== undefined && raw.interests.chosen !== null) {
      const lu = normalizeInterestItems(raw.interests.chosen, "capture.interests.chosen");
      if (!lu.ok) return refus(lu.error, lu.field, lu.expected);
      chosen = lu.kept;
      rejected.push(...lu.rejected);
    }

    interests = { asks: raw.interests.asks, offered, chosen, rejected };
  }

  return {
    ok: true,
    value: {
      leadId,
      occurredAt,
      campaign,
      creative,
      interests,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * Les champs COMPRIS — et donc, par différence, ceux qui ne le sont pas
 * ═══════════════════════════════════════════════════════════════════════════════ */

const CLES_CORPS = [
  "email", "first_name", "asset", "consent", "tracking_consent", "company", "ft", "edition",
  "purposes", "partner_consent", "granted_purposes", "interests", "optin", "source",
  "source_detail", "ip_address", "user_agent", "source_url", "capture",
  // ⛔ LE PAYS DU CONTACT, ET C'EST UN AUTRE FAIT QUE LE MARCHÉ DE L'ÉDITION. Voir `paysAlpha2`.
  //    Ajouté ICI parce qu'une clé absente de cette liste ressort en `ignored_fields`, et que
  //    l'émetteur écrit alors `champs-ignores:country` dans `bridge_error` sur CHAQUE lead relayé.
  "country",
  // Le contact hors newsletter (0088) — voir `lireMode`.
  "mode",
];
// ⚠️ `source_url` n'est PAS une clé de `capture` : l'URL vit au niveau du corps depuis le v1, et en
// ajouter une seconde donnerait deux sources pour un même fait, dont la plus récente gagnerait par
// hasard d'écriture. Un `capture.source_url` envoyé ressort donc dans `ignored_fields`, ce qui dit
// à l'émetteur d'employer le champ existant.
const CLES_CAPTURE = ["v", "lead_id", "occurred_at", "campaign", "creative", "interests"];
const CLES_CAMPAGNE = ["external_id", "name"];
const CLES_CREATIVE = ["external_id", "name", "placement", "parent_external_id", "variant_label", "automation_label"];
const CLES_INTERETS = ["asks", "offered", "chosen"];
const CLES_ITEM = ["slug", "label", "taxonomy"];

/**
 * Faut-il réécrire `subscription.optin_id` sur une réinscription ? (D8)
 *
 * ⛔ LA RÈGLE EST « PREMIÈRE TOUCHE », ET ELLE N'EST PAS ARBITRAIRE. Sur la MÊME LIGNE,
 * `subscription.capture_campaign_id` est posée par le trigger 0063 à la PREMIÈRE occurrence
 * (`order by occurred_at`). Si `optin_id` suivait la DERNIÈRE, deux colonnes voisines
 * répondraient à la même question — « par où cette personne est-elle entrée ? » — par deux
 * origines différentes, sans qu'aucune erreur ne le signale : l'écran des créatives et celui des
 * campagnes attribueraient le même abonné à deux endroits, et le seul moyen de s'en apercevoir
 * serait de comparer deux écrans à la main.
 *
 * Les touches SUIVANTES ne sont pas perdues pour autant : elles s'empilent dans
 * `capture_optin_ids`, que le même trigger maintient. Rien ne disparaît ; chaque colonne répond à
 * une seule question.
 */
export function optinIdPremiereTouche(
  existant: string | null | undefined,
  nouveau: string | null | undefined,
): { optin_id: string } | Record<string, never> {
  return nouveau && !existant ? { optin_id: nouveau } : {};
}

/**
 * Le pays DU CONTACT, en ISO-3166-1 alpha-2 majuscule, ou `null`.
 *
 * ⛔ CE N'EST PAS LE MARCHÉ DE L'ÉDITION, et les deux ne doivent JAMAIS s'écraser l'un l'autre.
 * `consent_event.country` reçoit `edition.market` — le marché de la publication, arbitré et
 * documenté. `subscription.country` reçoit ceci — d'où vient la PERSONNE. Un lead brésilien inscrit
 * sur une édition chilienne porte légitimement `country='BR'` et `market='CL'` : recopier l'un dans
 * l'autre écrirait une géographie fausse dans une preuve légale, sans une seule erreur.
 *
 * ⛔ ILLISIBLE ⇒ `null`, JAMAIS UNE VALEUR INVENTÉE. `subscription.country` est le prédicat de
 * segmentation (index `idx_sub_asset_country`, migration 0003) : un `"Brazil"` tronqué en `"BR"` ou
 * un alpha-3 `"BRA"` rabaissé en `"BR"` ferait entrer des gens dans un ciblage qui ne les vise pas.
 * On n'accepte donc que la forme exacte, et l'absence de réponse s'écrit comme une absence.
 *
 * ⚠️ CE QUE CE FILTRE NE PROUVE PAS, et il ne faut pas lui faire dire plus : il vérifie la FORME
 * (deux lettres), pas l'APPARTENANCE à la liste ISO. `ZZ` passe. Une table des 249 codes serait à
 * maintenir et rejetterait `XK` (Kosovo), pourtant employé partout en pratique — un faux négatif
 * silencieux sur de vraies personnes coûte plus cher ici qu'un `ZZ` visible en base.
 */
export function paysAlpha2(valeur: unknown): string | null {
  if (typeof valeur !== "string") return null;
  const t = valeur.trim();
  if (!/^[A-Za-z]{2}$/.test(t)) return null;
  return t.toUpperCase();
}

/**
 * Faut-il écrire `subscription.country` sur une réinscription ?
 *
 * ⛔ PREMIÈRE TOUCHE, exactement comme `optinIdPremiereTouche` (D8), et pour une raison de plus :
 * le pays déjà posé a servi à segmenter des envois DÉJÀ PARTIS. Le réécrire à la deuxième
 * inscription — depuis un émetteur qui géolocalise autrement, ou depuis un VPN — déplacerait
 * silencieusement la personne d'un ciblage à un autre, et l'historique d'envois ne correspondrait
 * plus à la colonne qui prétend l'expliquer.
 */
export function paysPremiereTouche(
  existant: string | null | undefined,
  nouveau: string | null | undefined,
): { country: string } | Record<string, never> {
  return nouveau && !existant ? { country: nouveau } : {};
}

/**
 * Une adresse acceptable par une colonne `inet`, ou `null`.
 *
 * ⛔ POURQUOI CE FILTRE EXISTE, ET CE QU'IL PROTÈGE. Sur le pont, l'IP vient du CORPS
 * (`body.ip_address`) : c'est l'ÉMETTEUR qui la choisit. Un émetteur qui recopie son
 * `X-Forwarded-For` tel quel envoie `"203.0.113.7, 70.41.3.18"` — que Postgres refuse en 22P02.
 * Or l'INSERT de `consent_event` ne lit pas son retour : la ligne ne serait pas écrite, la route
 * rendrait 200, et la PREUVE LÉGALE DU CONSENTEMENT n'existerait pas. Un défaut de cette famille
 * ne se voit pas le jour où il arrive ; il se voit le jour d'un contrôle, sur des mois de leads.
 *
 * Mieux vaut une preuve SANS IP qu'aucune preuve : on récupère donc ce qui est récupérable (le
 * premier élément d'une liste XFF), puis on valide la FORME. Un préfixe `/24` est refusé : une
 * preuve de consentement nomme une machine, pas un réseau.
 */
export function ipInet(valeur: unknown): string | null {
  if (typeof valeur !== "string") return null;
  const premier = (valeur.split(",")[0] ?? "").trim();
  // 45 = la plus longue forme IPv6 possible (IPv4-mapped complète).
  if (!premier || premier.length > 45) return null;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(premier);
  // Un octet à zéro non significatif (`01`) est lu en OCTAL par certaines piles : deux lecteurs,
  // deux adresses. Une preuve ne peut pas être ambiguë.
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255 && !(o.length > 1 && o.startsWith("0"))) ? premier : null;

  if (!premier.includes(":") || !/^[0-9A-Fa-f:]+$/.test(premier)) return null;
  if ((premier.match(/::/g) ?? []).length > 1) return null;
  const groupes = premier.split(":").filter((g) => g !== "");
  return groupes.length <= 8 && groupes.every((g) => g.length <= 4) ? premier : null;
}

/**
 * Les champs que le contrat NOMME mais que rien ne stocke (voir (c)). Ils sortent dans
 * `ignored_fields` : « compris et vide » et « pas compris du tout » doivent rester distinguables,
 * et un champ déclaré qui n'atterrit nulle part appartient au second groupe.
 */
const NON_STOCKES = ["capture.creative.parent_external_id"];

/**
 * Ce que ce relevé s'autorise à parcourir, avant toute authentification.
 *
 * ⛔ POURQUOI DES BORNES. `collectIgnored` est appelé sur le corps BRUT, à l'entrée de la route,
 * donc AVANT le contrôle du secret d'ingestion et avant l'anti-bot : c'est du travail offert à un
 * appelant non authentifié. Sans borne, un corps de 10 000 clés inconnues fait construire 10 000
 * chaînes puis les trie — un coût qui grandit avec ce que l'attaquant envoie, pas avec ce que nous
 * comprenons. Le déplacer après l'authentification ne marcherait pas : l'écho appartient AUSSI au
 * chemin public, qui n'a pas de secret.
 *
 * Les valeurs sont larges devant tout émetteur réel (le contrat nomme 5 clés par objet, et une
 * créative propose des dizaines de sujets, pas des milliers) : un émetteur honnête ne les atteint
 * jamais, et l'écho tronqué le DIT plutôt que de mentir par omission.
 */
const MAX_ECARTS = 60;
const MAX_ITEMS_INSPECTES = 200;
/** Sort dans `ignored_fields` quand la borne a mordu : un écho tronqué ne doit pas passer pour complet. */
const MARQUE_TRONQUE = "…(relevé tronqué)";

function inconnues(objet: unknown, connues: string[], prefixe: string, out: string[]): void {
  if (!estObjet(objet)) return;
  for (const cle of Object.keys(objet)) {
    if (out.length >= MAX_ECARTS) return;
    if (!connues.includes(cle)) out.push(prefixe ? `${prefixe}.${cle}` : cle);
  }
}

/**
 * Les clés reçues et NON COMPRISES, en chemins pointés.
 *
 * ⛔ C'EST LE SEUL SIGNAL qui distingue « champ inconnu » de « champ compris et vide ». Sans lui,
 * un émetteur qui écrit `capture.creatives` au pluriel reçoit un `200 {ok:true}` parfaitement
 * rassurant et perd 100 % de ses créatives.
 *
 * ⚠️ On ne descend QUE dans `capture`. Les champs v1 sont gelés et leurs sous-clés inconnues sont
 * tolérées depuis toujours : les dénoncer aujourd'hui ferait apparaître comme une régression un
 * comportement que la v1 promet. `source_detail` est un jsonb libre — descendre dedans n'aurait
 * aucun sens.
 */
export function collectIgnored(body: unknown): string[] {
  const out: string[] = [];
  if (!estObjet(body)) return out;

  inconnues(body, CLES_CORPS, "", out);

  const c = body.capture;
  if (!estObjet(c)) return out.sort();

  inconnues(c, CLES_CAPTURE, "capture", out);
  inconnues(c.campaign, CLES_CAMPAGNE, "capture.campaign", out);
  inconnues(c.creative, CLES_CREATIVE, "capture.creative", out);
  inconnues(c.interests, CLES_INTERETS, "capture.interests", out);

  let tronque = false;
  for (const champ of ["offered", "chosen"] as const) {
    const liste = estObjet(c.interests) ? c.interests[champ] : undefined;
    if (!Array.isArray(liste)) continue;
    if (liste.length > MAX_ITEMS_INSPECTES) tronque = true;
    liste
      .slice(0, MAX_ITEMS_INSPECTES)
      .forEach((item, i) => inconnues(item, CLES_ITEM, `capture.interests.${champ}[${i}]`, out));
  }

  for (const chemin of NON_STOCKES) {
    const [, sous, feuille] = chemin.split(".");
    const parent = sous ? (c as Record<string, unknown>)[sous] : c;
    if (estObjet(parent) && feuille !== undefined && parent[feuille] !== undefined) out.push(chemin);
  }

  // ⛔ La troncature se DÉCLARE. Un écho silencieusement écourté redevient exactement le « 200
  //    rassurant » que ce relevé existe pour empêcher : l'émetteur croirait avoir tout fait lire.
  // `>=` et non `>` : à la borne exacte, `inconnues` s'est arrêté sans pouvoir savoir s'il restait
  // des clés. Déclarer la troncature est alors le seul énoncé vrai — « au moins 60 », pas « 60 ».
  if (tronque || out.length >= MAX_ECARTS) {
    out.length = Math.min(out.length, MAX_ECARTS);
    out.push(MARQUE_TRONQUE);
  }

  return out.sort();
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * La SÉQUENCE — le geste irréversible de D7, isolé pour être mis sous banc
 * ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * L'entrée empruntée : l'inscription à la newsletter (défaut, inchangée) ou le CONTACT hors
 * newsletter (0088, lot E).
 */
export type SignupMode = "subscribe" | "contact";

/**
 * Lit `mode`. Absent ⇒ l'inscription de toujours ; `"contact"` ⇒ un contact hors newsletter.
 *
 * ⛔ LE CONTACT EST RÉSERVÉ À L'INGESTION SERVEUR. Il entre SANS double opt-in et devient
 * atteignable par une campagne : ouvert à un appelant anonyme, n'importe qui ferait recevoir des
 * e-mails à l'adresse d'un tiers sans que ce tiers ait jamais cliqué quoi que ce soit.
 *
 * ⛔ VOCABULAIRE FERMÉ. Une valeur inconnue est un 422, jamais un repli sur l'inscription : un
 * émetteur qui écrit `"contacts"` au pluriel ferait sinon partir un e-mail de confirmation à une
 * personne qui n'a rien demandé à la newsletter.
 */
export function lireMode(
  raw: unknown,
  serverIngest: boolean,
): { ok: true; mode: SignupMode } | { ok: false; error: string; expected: string; status: number } {
  if (raw === undefined || raw === null) return { ok: true, mode: "subscribe" };
  if (raw !== "contact") return { ok: false, error: "mode-inconnu", expected: '"contact" or absent', status: 422 };
  if (!serverIngest) {
    return { ok: false, error: "mode-reserve-ingestion", expected: "server ingestion", status: 403 };
  }
  return { ok: true, mode: "contact" };
}

/**
 * Les finalités d'un CONTACT : ce que l'émetteur a transmis, et RIEN DE PLUS.
 *
 * ⛔ `content` N'EST PAS FORCÉ, À L'INVERSE DE L'INSCRIPTION. Là-bas `content: true` traduit la case
 * Newsletter que la route exige ; un contact n'a coché AUCUNE case newsletter. Le forcer écrirait un
 * consentement que personne n'a donné — et ouvrirait à ce contact toutes les campagnes de finalité
 * `content` SANS la case `contacts_ignore_purpose` qui existe pour que ce choix soit fait à la main.
 */
export function finalitesContact(pont: Record<string, unknown> | null | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(pont ?? {})) out[k] = v === true;
  return out;
}

export interface SignupSequence {
  /** Le chemin public d'AVANT, inchangé : `{ok:true, already:true}` sans rien écrire. */
  earlyAlready: boolean;
  updateSubscription: boolean;
  /** ⛔ `status: 'pending'` en dur : sur une souscription ACTIVE, ce serait une désinscription. */
  forceStatusPending: boolean;
  writeConsentEvent: boolean;
  issueToken: boolean;
  sendConfirmation: boolean;
  writeCaptureEvent: boolean;
  /** Le statut d'une souscription CRÉÉE : `pending` (attend son clic) ou `contact` (0088). */
  createStatus: "pending" | "contact";
  /** Tag par défaut de l'optin et intérêts v1 (pont seulement). */
  applyTags: boolean;
}

/**
 * Ce qu'une inscription DOIT faire, selon l'état de la souscription et l'entrée empruntée.
 *
 * ⛔ LE DÉFAUT QUE CE LOT CORRIGE. La route rendait `{ok:true, already:true}` AVANT toute écriture
 * dès que la souscription était active : la deuxième inscription d'une même personne — donc la
 * deuxième créative, donc les intérêts cochés la deuxième fois — était perdue sans une trace.
 *
 * ⛔ ET LE PIÈGE QUE LA CORRECTION OUVRE. L'UPDATE de la branche « existante » pose `status:
 * 'pending'` en dur. Supprimer le retour anticipé sans garder le statut ferait passer un abonné
 * ACTIF en PENDING : il sortirait de `sendable_subscription`, ne recevrait plus rien, et rien ne le
 * signalerait. D'où un drapeau explicite plutôt qu'un `if` de plus dans la route.
 *
 * ⛔ SUR UNE SOUSCRIPTION ACTIVE, SEUL L'ÉVÉNEMENT EST ÉCRIT. Pas de jeton, pas d'e-mail —
 * confirmer quelqu'un de déjà confirmé est irréversible et public. Pas de `consent_event` non plus,
 * et pas d'élargissement des finalités : accorder une finalité de plus sans écrire sa preuve
 * fabriquerait un consentement sans preuve, ce qui est pire que de ne pas l'élargir. → à trancher
 * par Alix si une seconde inscription doit pouvoir ajouter une finalité.
 *
 * ⛔ LE CONTACT (0088) NE TOUCHE JAMAIS UNE SOUSCRIPTION EXISTANTE, QUEL QUE SOIT SON STATUT. Un
 * abonné `active` qui remplit un formulaire hors newsletter reste `active` ; un `unsubscribed` reste
 * désinscrit — le repasser en `contact` le rendrait de nouveau atteignable par une campagne, après
 * qu'il a dit non. Seul l'événement de capture s'ajoute. Sans souscription, elle est créée au statut
 * `contact` : ni preuve d'opt-in (il n'y en a pas eu), ni jeton, ni e-mail.
 */
export function decideSignup(args: {
  existingStatus: string | null;
  serverIngest: boolean;
  mode?: SignupMode;
}): SignupSequence {
  const active = args.existingStatus === "active";
  const existe = args.existingStatus !== null;

  if (args.mode === "contact") {
    return {
      earlyAlready: false,
      updateSubscription: false,
      forceStatusPending: false,
      writeConsentEvent: false,
      issueToken: false,
      sendConfirmation: false,
      writeCaptureEvent: true,
      createStatus: "contact",
      applyTags: !existe,
    };
  }

  if (active && !args.serverIngest) {
    return {
      earlyAlready: true,
      updateSubscription: false,
      forceStatusPending: false,
      writeConsentEvent: false,
      issueToken: false,
      sendConfirmation: false,
      writeCaptureEvent: false,
      createStatus: "pending",
      applyTags: false,
    };
  }

  if (active) {
    return {
      earlyAlready: false,
      updateSubscription: false,
      forceStatusPending: false,
      writeConsentEvent: false,
      issueToken: false,
      sendConfirmation: false,
      writeCaptureEvent: true,
      createStatus: "pending",
      applyTags: true,
    };
  }

  return {
    earlyAlready: false,
    updateSubscription: existe,
    forceStatusPending: existe,
    writeConsentEvent: true,
    issueToken: true,
    sendConfirmation: true,
    writeCaptureEvent: args.serverIngest,
    createStatus: "pending",
    applyTags: args.serverIngest,
  };
}

/**
 * Fusion des finalités par OU logique.
 *
 * ⛔ UNE RÉINSCRIPTION NE RETIRE JAMAIS UN CONSENTEMENT. L'UPDATE d'avant écrasait
 * `granted_purposes` : `offers` pouvait reculer de `true` à `false` sans aucun `consent_event` de
 * retrait — une réduction de consentement sans preuve, invisible des deux côtés. Le retrait a son
 * chemin, le centre de préférences, qui lui écrit sa trace.
 */
export function mergePurposes(
  existant: Record<string, unknown> | null | undefined,
  nouveau: Record<string, boolean | undefined>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  // ⛔ UNE CLÉ ABSENTE N'EST PAS UNE CLÉ À `false`, ET LA PORTE D'ENVOI LES LIT À L'OPPOSÉ.
  //    `purposeAllowed` (packages/config/src/send-policy.ts) rend `granted[p] !== false` sous une
  //    base légale `opt_out`, et `purposeGateFilter` traduit ça en `or(col.is.null,col.neq.false)` :
  //    la clé MANQUANTE y vaut « pas de retrait », donc AUTORISÉ. Ne conserver que les `true`
  //    effacerait donc un refus explicite et rouvrirait un envoi que la personne avait décoché —
  //    l'inverse exact de ce que cette fusion existe pour empêcher. On fusionne par OU en
  //    CONSERVANT chaque clé vue de part et d'autre.
  for (const [k, v] of Object.entries(existant ?? {})) out[k] = v === true;
  for (const [k, v] of Object.entries(nouveau)) out[k] = out[k] === true || v === true;
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * Les résolveurs — un par niveau, `db` en premier argument, jamais de `throw`
 * ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * Trouve la campagne d'acquisition, ou la CRÉE.
 *
 * Même mécanique que `resolveOptin` : `upsert` sur l'unique PLEIN `(asset_id, external_id)` puis
 * relecture. Le libellé suit (une campagne renommée chez l'émetteur se renomme ici), la clé ne
 * bouge pas, et `first_seen_at` est préservé parce que la clé n'est pas citée dans le payload.
 */
export async function resolveCaptureCampaign(
  db: Db,
  assetId: string,
  campaign: CaptureCampaignInput,
): Promise<{ value: { id: string } | null; error: string | null }> {
  try {
    const { error: upsertError } = await db.from("capture_campaign").upsert(
      {
        asset_id: assetId,
        external_id: campaign.externalId,
        name: campaign.name,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "asset_id,external_id", ignoreDuplicates: false },
    );
    if (upsertError) return { value: null, error: `campaign-upsert:${upsertError.message}` };

    const { data, error: readError } = await db
      .from("capture_campaign")
      .select("id")
      .eq("asset_id", assetId)
      .eq("external_id", campaign.externalId)
      .maybeSingle();
    if (readError) return { value: null, error: `campaign-read:${readError.message}` };
    if (!data) return { value: null, error: "campaign-absente-apres-upsert" };

    return { value: { id: (data as { id: string }).id }, error: null };
  } catch (err) {
    return { value: null, error: `unexpected:${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Le slug d'identité d'un intérêt. Le préfixe est ce qui empêche `noticias` (catégorie) et `noticias` (tag) de fusionner. */
export function interestSlug(item: CaptureInterestItem): string {
  return `interest:${item.taxonomy}:${item.slug}`;
}

/**
 * Résout (et crée au besoin) les tags d'intérêt d'une marque.
 *
 * ⛔ ON LIT AVANT D'ÉCRIRE, ET C'EST OBLIGATOIRE. L'unique de `tag` est `(asset_id, slug)` SEUL :
 * `kind` n'en fait pas partie. Un `upsert … ignoreDuplicates:false` rendrait donc un tag MANUEL
 * homonyme requalifié en tag d'intérêt — exactement ce que la migration interdit (« un tag manuel
 * nommé interest:… suffirait à casser un filtre fondé sur la forme »). Une collision est donc
 * écartée avec son motif, jamais résolue au jugé.
 *
 * ⚠️ `upsert … ignoreDuplicates:true` puis relecture pour les manquants : deux inscriptions
 * simultanées sur un intérêt neuf courent l'une contre l'autre, et l'unique en ferait échouer une —
 * donc perdre les intérêts d'un abonné pour une raison qui ne le concerne pas.
 */
export async function resolveInterestTags(
  db: Db,
  assetId: string,
  items: CaptureInterestItem[],
): Promise<{ ids: number[]; rejected: CaptureRejected[]; error: string | null }> {
  if (items.length === 0) return { ids: [], rejected: [], error: null };

  const rejected: CaptureRejected[] = [];
  try {
    const parSlug = new Map<string, CaptureInterestItem>();
    for (const item of items) parSlug.set(interestSlug(item), item);
    const slugs = [...parSlug.keys()];

    const { data: connus, error: readError } = await db
      .from("tag")
      .select("id, slug, kind")
      .eq("asset_id", assetId)
      .in("slug", slugs);
    if (readError) return { ids: [], rejected, error: `tag-read:${readError.message}` };

    const ids = new Map<string, number>();
    const squattes = new Set<string>();
    for (const t of (connus ?? []) as { id: number; slug: string; kind: string | null }[]) {
      if (t.kind === "interest") ids.set(t.slug, t.id);
      else squattes.add(t.slug);
    }
    for (const slug of squattes) {
      rejected.push({ slug, reason: `slug-occupe-par-un-tag-kind-manual` });
    }

    const manquants = slugs.filter((s) => !ids.has(s) && !squattes.has(s));
    if (manquants.length > 0) {
      const { error: insertError } = await db.from("tag").upsert(
        manquants.map((slug) => {
          const item = parSlug.get(slug) as CaptureInterestItem;
          return {
            asset_id: assetId,
            slug,
            label: item.label,
            kind: "interest",
            taxonomy: item.taxonomy,
            source_slug: item.slug,
            source: "capture_bridge",
          };
        }),
        { onConflict: "asset_id,slug", ignoreDuplicates: true },
      );
      if (insertError) return { ids: [], rejected, error: `tag-create:${insertError.message}` };

      const { data: apres, error: rereadError } = await db
        .from("tag")
        .select("id, slug, kind")
        .eq("asset_id", assetId)
        .in("slug", manquants);
      if (rereadError) return { ids: [], rejected, error: `tag-reread:${rereadError.message}` };
      for (const t of (apres ?? []) as { id: number; slug: string; kind: string | null }[]) {
        // Une ligne créée entre-temps par un autre appel peut très bien être manuelle : la
        // relecture revérifie le `kind` au lieu de le supposer.
        if (t.kind === "interest") ids.set(t.slug, t.id);
        else rejected.push({ slug: t.slug, reason: "slug-occupe-par-un-tag-kind-manual" });
      }
    }

    // L'ordre des `items` est conservé : deux inscriptions identiques doivent produire le même
    // tableau, sinon `interest_ids` diffère sans qu'aucun fait n'ait changé.
    const resolus: number[] = [];
    for (const item of items) {
      const id = ids.get(interestSlug(item));
      if (id === undefined) {
        if (!squattes.has(interestSlug(item))) {
          rejected.push({ slug: interestSlug(item), reason: "non-resolu" });
        }
        continue;
      }
      if (!resolus.includes(id)) resolus.push(id);
    }

    return { ids: resolus, rejected, error: null };
  } catch (err) {
    return { ids: [], rejected, error: `unexpected:${err instanceof Error ? err.message : String(err)}` };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * L'ÉCRITURE de l'événement — un seul endroit, pour n'avoir qu'un endroit à basculer
 * ═══════════════════════════════════════════════════════════════════════════════ */

export interface CaptureEventInput {
  subscriptionId: string;
  assetId: string;
  optinId: string | null;
  captureCampaignId: string | null;
  leadExternalId: string | null;
  occurredAt: string | undefined;
  interestIds: number[];
  /** `undefined` ⇒ la colonne N'EST PAS citée ⇒ elle reste NULL (« on ne sait pas »). */
  interestsOffered: number[] | undefined;
  campaignNameAtCapture: string | null;
  optinNameAtCapture: string | null;
  variantExternalId: string | null;
  sourceUrl: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** Slug du label d'automation (0095). `null` ⇒ la colonne N'EST PAS citée. */
  automationLabel: string | null;
}

export interface CaptureEventOutcome {
  id: string | null;
  duplicate: boolean;
  error: string | null;
}

/**
 * Écrit l'événement de capture. UN SEUL point d'écriture, volontairement.
 *
 * ⛔ INSERT NU, SANS `onConflict`. L'unique de dédoublonnage est un index PARTIEL
 * (`… where lead_external_id is not null`) : PostgREST n'envoie qu'une liste de colonnes, Postgres
 * refuse alors l'inférence (42P10) et rend un 500. L'arbitre du doublon est donc la BASE — une
 * violation 23505 est lue comme « déjà vu », et la ligne existante est relue.
 *
 * ⛔ UN ÉCHEC ICI NE COÛTE PAS L'INSCRIPTION. L'abonné et son consentement sont déjà écrits quand
 * cette fonction est appelée. L'événement est important ; le consentement l'est davantage.
 *
 * Voir (f) : le jour où `newsletter.ingest_capture()` existe, c'est le CORPS de cette fonction qui
 * change, et rien d'autre dans la route.
 */
export async function writeCaptureEvent(db: Db, args: CaptureEventInput): Promise<CaptureEventOutcome> {
  // ⛔ Construit clé par clé : un objet bâti avec `interests_offered: x ?? null` écrirait « rien
  //    n'était proposé » à chaque inscription où l'émetteur n'a rien dit, et le dénominateur des
  //    taux d'intérêt serait faux pour toujours.
  const payload: Record<string, unknown> = {
    subscription_id: args.subscriptionId,
    asset_id: args.assetId,
    optin_id: args.optinId,
    capture_campaign_id: args.captureCampaignId,
    lead_external_id: args.leadExternalId,
    interest_ids: args.interestIds,
    campaign_name_at_capture: args.campaignNameAtCapture,
    optin_name_at_capture: args.optinNameAtCapture,
    variant_external_id: args.variantExternalId,
    source_url: args.sourceUrl,
    ip_address: args.ipAddress,
    user_agent: args.userAgent,
  };
  if (args.interestsOffered !== undefined) payload.interests_offered = args.interestsOffered;
  if (args.occurredAt !== undefined) payload.occurred_at = args.occurredAt;
  // ⛔ CITÉE SEULEMENT QUAND ELLE PORTE UN LABEL : une colonne inconnue de PostgREST ferait échouer
  //    l'insert. Si ce code partait avant 0095, seules les inscriptions À LABEL perdraient leur
  //    événement — pas toutes.
  if (args.automationLabel) payload.automation_label = args.automationLabel;

  try {
    const { data, error } = await db.from("capture_event").insert(payload).select("id").single();
    if (!error && data) return { id: (data as { id: string }).id, duplicate: false, error: null };

    const code = (error as { code?: string } | null)?.code ?? "";
    if (code === "23505" && args.leadExternalId) {
      const { data: deja, error: relecture } = await db
        .from("capture_event")
        .select("id")
        .eq("asset_id", args.assetId)
        .eq("lead_external_id", args.leadExternalId)
        .maybeSingle();
      if (relecture) return { id: null, duplicate: true, error: `event-reread:${relecture.message}` };
      return { id: (deja as { id: string } | null)?.id ?? null, duplicate: true, error: null };
    }

    return {
      id: null,
      duplicate: false,
      error: `event-insert:${(error as { message?: string } | null)?.message ?? "sans-ligne"}`,
    };
  } catch (err) {
    return { id: null, duplicate: false, error: `unexpected:${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface CaptureEcho {
  campaign_id: string | null;
  optin_id: string | null;
  interest_ids: number[];
  /** Le slug réellement écrit (0095) : `null` dit à l'émetteur que son label n'a pas été retenu. */
  automation_label: string | null;
}

/**
 * L'écho, RELU depuis la ligne écrite.
 *
 * ⛔ JAMAIS RECOPIÉ DEPUIS L'ENTRÉE. Un écho construit à partir de la requête ne prouve que la
 * capacité à parser du JSON : il dirait « campagne rattachée » alors que la résolution a échoué et
 * que la colonne est NULL. C'est une requête DISTINCTE de l'insert, par l'id rendu par la base.
 */
export async function readCaptureEcho(db: Db, eventId: string): Promise<CaptureEcho | null> {
  try {
    const { data, error } = await db
      .from("capture_event")
      .select("id, capture_campaign_id, optin_id, interest_ids, automation_label")
      .eq("id", eventId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as {
      capture_campaign_id: string | null;
      optin_id: string | null;
      interest_ids: number[] | null;
      automation_label?: string | null;
    };
    return {
      campaign_id: row.capture_campaign_id ?? null,
      optin_id: row.optin_id ?? null,
      interest_ids: row.interest_ids ?? [],
      automation_label: row.automation_label ?? null,
    };
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * La SONDE — ce que ce récepteur comprend, dit sans écrire une ligne
 * ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * Le corps du `GET /api/v1/signup`. Interface MACHINE, donc en anglais comme le reste de l'API.
 *
 * ⛔ AUCUN `process.env`, AUCUN accès base. Dire à un appelant anonyme si `NF_INGEST_SECRET` est
 * posée lui apprendrait si la porte est ouverte — le 401 doit rester la seule information qu'il
 * obtienne à ce sujet.
 *
 * ⚠️ Les bornes sont IMPORTÉES, jamais recopiées : une sonde qui annonce 24 pendant que le code en
 * applique 12 est pire qu'une absence de sonde, parce qu'on la croit.
 */
export function captureProbe(): Record<string, unknown> {
  return {
    ok: true,
    contract: CAPTURE_CONTRACT,
    accepts: {
      // ⛔ `source_url` EST UN CHAMP DU CORPS, PAS DE `capture`, et la sonde doit le dire ici.
      //    L'annoncer sous `capture` invitait l'émetteur à écrire `capture.source_url` : la clé
      //    n'est pas dans `CLES_CAPTURE`, elle ressortirait en `ignored_fields`, et
      //    `capture_event.source_url` recevrait l'origine de la requête (notre propre domaine) à la
      //    place de la page du visiteur — un champ faux, sans une seule erreur.
      body: {
        source_url: "string, optional — the page the visitor was on. TOP-LEVEL field, not capture.source_url",
        // ⛔ LA SONDE DOIT DIRE LES DEUX MOITIÉS : que le champ existe, ET qu'il ne touche pas au
        //    marché de l'édition. Annoncer « country » tout court inviterait l'émetteur à y mettre
        //    le pays du SITE, et la segmentation viserait la publication au lieu des personnes.
        country:
          "ISO-3166-1 alpha-2, optional, server ingestion only — the CONTACT's country. Written on FIRST touch only, never overwritten. Unreadable values are dropped to null. Distinct from the edition market, which is never affected.",
        // ⛔ L'émetteur LIT cette clé avant d'envoyer un contact : un récepteur qui ne l'annonce pas
        //    ne connaît pas le mode, et le lead doit rester arrêté chez l'émetteur plutôt que de
        //    partir en inscription newsletter.
        mode:
          '"contact", optional, server ingestion only — a NON-newsletter contact: no consent required, no double opt-in, no email. An existing subscription is never changed (only the capture event is recorded). Any other value is a 422.',
      },
      capture: {
        v: `must equal ${CAPTURE_CONTRACT}`,
        // ⚠️ « optional » au sens du schéma, mais SANS lui il n'y a AUCUN dédoublonnage : l'unique
        //    de `capture_event` est partiel (`where lead_external_id is not null`). Deux envois du
        //    même lead — un simple réessai après timeout — produisent alors deux événements, donc
        //    un `capture_event_count` gonflé qu'aucune erreur ne signale.
        lead_id:
          "string, optional but STRONGLY recommended — the only deduplication key; without it a retry creates a second capture event",
        occurred_at: "ISO 8601 timestamp, optional — emitter time, drives first-touch order",
        campaign: "{ external_id: uuid, name: string } | null — omit to leave untouched, null to detach",
        creative: "{ external_id: uuid, name: string, placement?, variant_label?, automation_label? } | null",
        interests:
          "{ asks: boolean, offered?: item[], chosen?: item[] } — item is { slug, label?, taxonomy }",
      },
      legacy_v1: {
        interests: "string[] — accepted and frozen, creates tags of kind 'manual'",
        optin: "{ slug, name } — accepted and frozen; when both are sent, capture wins",
      },
    },
    taxonomies: CAPTURE_TAXONOMIES,
    limits: {
      max_interests: MAX_SLUGS,
      max_slug_length: MAX_SLUG_LENGTH,
      slug_pattern: INTEREST_SLUG_RE.source,
      max_name_length: MAX_NAME,
    },
    echo: [
      "ok", "contract", "mode", "already", "duplicate", "subscription_id", "capture_event_id",
      "resolved.campaign_id", "resolved.optin_id", "resolved.interest_ids", "resolved.automation_label",
      "rejected_interests", "ignored_fields",
    ],
    notes: [
      "The echo is read back from the stored row, never copied from the request.",
      "interests.offered omitted leaves 'offered' unknown; an empty array records 'nothing offered'.",
      "capture.creative.parent_external_id is understood but not stored: it is reported in ignored_fields.",
      "capture.creative.automation_label is the label NAME (1-80 chars); it is stored as a slug (e.g. 'Libertadores 2026' -> 'libertadores-2026'). An unusable name is dropped, never fails the signup: resolved.automation_label is then null.",
      "A signup on an already active subscription still records the capture event, and sends no email.",
      "mode:\"contact\" creates a subscription with status 'contact' only when none exists; it grants no newsletter purpose and uses the full suppression list.",
      "ok:true with capture_event_id:null means nothing was recorded; the reason is not disclosed.",
      "Server-to-server ingestion requires the x-nf-ingest-secret header; anonymous callers get a bare {ok:true}.",
      // ⛔ Sans ces deux notes, la seule règle SURPRENANTE du contrat reste invisible : un slug
      //    fautif passe en 200 (l'inscription vaut plus qu'un sujet) alors qu'une taxonomie fautive
      //    est un 422 (elle décide d'une identité permanente). Un émetteur qui l'ignore croit avoir
      //    tout transmis.
      "An unknown or missing item taxonomy is a 422; a malformed slug never fails the signup, it is dropped.",
      "rejected_interests lists every interest that was dropped, with its reason: compare it against what you sent.",
    ],
  };
}
