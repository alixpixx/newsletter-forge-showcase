import { getDb } from "@/lib/supabase";
import { ecartDeCadence } from "@nf/analytics/article-views";

type Db = NonNullable<ReturnType<typeof getDb>>;

/**
 * La cadence à appliquer à un bloc flux réglé sur « suivre la cadence », vue depuis l'APERÇU —
 * c'est-à-dire avant tout envoi.
 *
 * ⚠️ CE N'EST PAS TOUT À FAIT LE CALCUL DU GEL, et c'est voulu. Le worker connaît l'occurrence
 * qu'il gèle et mesure l'écart jusqu'à ELLE (`PlannerDb.cadenceJours`). Ici aucune occurrence n'est
 * en cours : l'auteur règle un bloc pour le PROCHAIN envoi, donc la cible est la prochaine
 * occurrence à venir. Sur une cadence irrégulière (lundi + vendredi), les deux valeurs diffèrent
 * légitimement — 4 jours pour l'un, 3 pour l'autre.
 *
 * ⛔ UN MODÈLE SERT PLUSIEURS CAMPAGNES, et c'est le cas EN PRODUCTION : « Quartz Tips — Resumo da
 * Semana (importé) » v1 sert `Resumo da rodada — domingo` et `Friday NL TW`. Quand elles n'ont pas
 * la même cadence, il n'y a pas de bonne réponse à afficher : on rend `several` et l'écran le dit,
 * plutôt que d'élire la première et d'annoncer une période que l'autre campagne ne produira pas.
 *
 * ⛔ `raison` accompagne TOUJOURS `jours`. Une cadence absente fait retomber l'appelant sur sept
 * jours, et sept jours voulus se lisent exactement comme sept jours faute de mieux : sans le motif,
 * l'auteur ne saurait pas qu'il lui reste à armer une récurrence.
 */
export type RaisonCadence =
  | "ok"
  /** Campagne inexistante, ou appartenant à une autre marque — les deux se traitent pareil. */
  | "not-found"
  /** Aucune campagne n'utilise encore ce modèle : il n'y a personne à qui emprunter une cadence. */
  | "no-campaign"
  /** Des campagnes l'utilisent, aucune n'a de récurrence armée. */
  | "not-recurring"
  /** Plusieurs campagnes récurrentes, et leurs périodes diffèrent : on refuse de choisir. */
  | "several"
  /** Récurrence armée mais plus aucune échéance à venir (`recurrence_until` dépassé). */
  | "no-next"
  /** Le prochain envoi est le PREMIER : aucun précédent depuis lequel mesurer une période. */
  | "no-previous";

export interface CadenceApercu {
  jours: number | null;
  /** L'occurrence visée, en ISO. `null` dès que `raison` n'est pas `ok`. */
  prochain: string | null;
  raison: RaisonCadence;
  /** La campagne dont la cadence est appliquée — l'écran nomme sa source plutôt qu'un nombre nu. */
  campagne: string | null;
}

/** 95 jours : couvre le plafond de 90 de `viewsWindow` avec une marge, en arrière comme en avant. */
const HORIZON_MS = 95 * 86_400_000;

const CHAMPS_CADENCE =
  "id, name, timezone, recurrence_active, recurrence_days, recurrence_time, recurrence_every_weeks, recurrence_anchor";

interface LigneCadence {
  id: string;
  name: string | null;
  timezone: string | null;
  recurrence_active: boolean | null;
  recurrence_days: number[] | null;
  recurrence_time: string | null;
  recurrence_every_weeks: number | null;
  recurrence_anchor: string | null;
}

const estRecurrente = (c: LigneCadence): boolean =>
  c.recurrence_active === true &&
  Array.isArray(c.recurrence_days) &&
  c.recurrence_days.length > 0 &&
  !!c.recurrence_time &&
  !!c.recurrence_anchor;

/** La cadence d'UNE campagne dont on a déjà vérifié qu'elle est récurrente. */
async function cadenceDUneLigne(db: Db, cam: LigneCadence, maintenant: Date): Promise<CadenceApercu> {
  const nom = cam.name ?? null;
  /**
   * ⛔ ON DEMANDE LA CADENCE VOULUE, PAS LES OCCURRENCES MATÉRIALISÉES. `campaign_occurrences` est
   * `stable` et ne lit aucune table ; la table `campaign_occurrence`, elle, porte les accidents —
   * une occurrence annulée la semaine dernière doublerait la période affichée ici sans que
   * personne l'ait décidé, et l'aperçu annoncerait une fenêtre que l'envoi ne produira pas.
   */
  const { data, error } = await db.rpc("campaign_occurrences", {
    p_days: cam.recurrence_days,
    // Le fuseau vient de la CAMPAGNE, jamais du navigateur ni du serveur.
    p_timezone: cam.timezone ?? "UTC",
    p_time: cam.recurrence_time,
    p_every_weeks: cam.recurrence_every_weeks ?? 1,
    p_anchor: cam.recurrence_anchor,
    p_from: new Date(maintenant.getTime() - HORIZON_MS).toISOString(),
    p_to: new Date(maintenant.getTime() + HORIZON_MS).toISOString(),
    p_limit: 400,
  });
  if (error) return { jours: null, prochain: null, raison: "not-recurring", campagne: nom };

  const firesAt = ((data ?? []) as unknown as { fires_at: string }[]).map((r) => r.fires_at);
  // La prochaine échéance STRICTEMENT à venir : une occurrence déjà passée ne sera pas gelée, et la
  // présenter comme cible ferait afficher une période déjà servie.
  const t = maintenant.getTime();
  let prochain: string | null = null;
  let meilleur = Number.POSITIVE_INFINITY;
  for (const f of firesAt) {
    const ms = Date.parse(f);
    if (Number.isFinite(ms) && ms > t && ms < meilleur) {
      meilleur = ms;
      prochain = f;
    }
  }
  if (!prochain) return { jours: null, prochain: null, raison: "no-next", campagne: nom };

  const jours = ecartDeCadence(firesAt, prochain);
  if (jours === null) return { jours: null, prochain, raison: "no-previous", campagne: nom };
  return { jours, prochain, raison: "ok", campagne: nom };
}

/** La cadence d'une campagne NOMMÉE — le cas sans ambiguïté, quand l'appelant sait laquelle. */
export async function cadenceDeCampagne(
  db: Db,
  campaignId: string,
  assetId: string,
  maintenant: Date,
): Promise<CadenceApercu> {
  const { data, error } = await db
    .from("campaign")
    .select(CHAMPS_CADENCE)
    // Scoping par marque, comme partout ailleurs : une campagne d'une autre marque doit être
    // indiscernable d'une campagne inexistante.
    .eq("id", campaignId)
    .eq("asset_id", assetId)
    .maybeSingle();
  if (error || !data) return { jours: null, prochain: null, raison: "not-found", campagne: null };

  const cam = data as unknown as LigneCadence;
  if (!estRecurrente(cam)) {
    return { jours: null, prochain: null, raison: "not-recurring", campagne: cam.name ?? null };
  }
  return cadenceDUneLigne(db, cam, maintenant);
}

/**
 * La cadence déduite du MODÈLE en cours d'édition — le seul chemin dont dispose le builder, qui
 * s'ouvre depuis la liste des modèles et n'a jamais de campagne sous la main.
 *
 * ⚠️ La jointure passe par `template_version.template_id`, pas par `template_version_id` : le
 * builder édite le BROUILLON (version 0) tandis qu'une campagne pointe une version PUBLIÉE. Joindre
 * sur la version ne rendrait jamais rien.
 */
async function campagnesDuModele<T>(
  db: Db,
  templateId: string,
  assetId: string,
  champs: string,
): Promise<T[] | null> {
  const { data: versions, error: errV } = await db
    .from("template_version")
    .select("id")
    .eq("template_id", templateId);
  if (errV) return null;

  const ids = ((versions ?? []) as unknown as { id: string }[]).map((v) => v.id);
  if (ids.length === 0) return [];

  /*
   * ⛔ LES CAMPAGNES ARCHIVÉES NE VOTENT PAS (0077). Une série rangée ne part plus : sa cadence
   * compterait pourtant dans le vote, et un modèle qui ne sert plus qu'UNE série vivante se lirait
   * « plusieurs cadences », ou son mélange suivrait une campagne qu'on a mise de côté.
   */
  const { data, error } = await db
    .from("campaign")
    .select(champs)
    .eq("asset_id", assetId)
    .in("template_version_id", ids)
    .is("archived_at", null);
  if (error) return null;
  return (data ?? []) as unknown as T[];
}

export async function cadenceDuModele(
  db: Db,
  templateId: string,
  assetId: string,
  maintenant: Date,
): Promise<CadenceApercu> {
  const lignes = await campagnesDuModele<LigneCadence>(db, templateId, assetId, CHAMPS_CADENCE);
  if (lignes === null) return { jours: null, prochain: null, raison: "not-found", campagne: null };
  if (lignes.length === 0) return { jours: null, prochain: null, raison: "no-campaign", campagne: null };

  const recurrentes = lignes.filter(estRecurrente);
  if (recurrentes.length === 0) {
    return { jours: null, prochain: null, raison: "not-recurring", campagne: null };
  }

  const resultats = await Promise.all(recurrentes.map((c) => cadenceDUneLigne(db, c, maintenant)));
  const abouties = resultats.filter((r) => r.raison === "ok");
  if (abouties.length === 0) return resultats[0]!;

  /**
   * ⛔ DEUX CADENCES DIFFÉRENTES ⇒ AUCUNE. Élire la première afficherait une période juste pour une
   * campagne et fausse pour l'autre, sans que rien ne distingue les deux cas à l'écran. Deux
   * campagnes qui tombent sur la MÊME période, en revanche, ne créent aucune ambiguïté.
   */
  const distinctes = new Set(abouties.map((r) => r.jours));
  if (distinctes.size > 1) {
    return { jours: null, prochain: null, raison: "several", campagne: null };
  }
  // Le nom n'est porté que s'il désigne sans ambiguïté : à plusieurs campagnes de même période,
  // en nommer une seule laisserait croire que les autres ne comptent pas.
  return abouties.length === 1 ? abouties[0]! : { ...abouties[0]!, campagne: null };
}


/* ------------------------------------------------------------------ *
 * L'interrupteur de mélange, vu depuis le builder
 * ------------------------------------------------------------------ */

/** Pourquoi l'aperçu ne peut pas appliquer l'interrupteur de mélange — quand il ne le peut pas. */
export type RaisonMelange =
  | "ok"
  /** Campagne inexistante, autre marque, ou base injoignable. */
  | "not-found"
  /** Aucune campagne n'utilise ce modèle : personne ne porte de réglage. */
  | "no-campaign"
  /**
   * Plusieurs campagnes l'utilisent et elles ne sont PAS d'accord.
   *
   * ⛔ Ce cas est réel dès le premier jour : « Friday NL TW » et « Resumo da rodada — domingo »
   * partagent la version 509c87c3. Élire la valeur de l'une afficherait un aperçu juste pour elle
   * et faux pour l'autre, sans que rien ne le signale — exactement ce que cette route existe pour
   * empêcher. On rend donc l'aperçu SANS mélange, et on le dit.
   */
  | "several";

export interface MelangeApercu {
  /** `null` dès que `raison` n'est pas `ok` — l'appelant traite alors comme « pas de mélange ». */
  actif: boolean | null;
  raison: RaisonMelange;
  /** La campagne dont le réglage est appliqué, quand elle est seule à le porter. */
  campagne: string | null;
}

const CHAMPS_MELANGE = "id, name, mix_latest";

interface LigneMelange {
  id: string;
  name: string | null;
  mix_latest: boolean | null;
}

/** Réduit un lot de campagnes à un verdict unique — la seule règle d'unanimité du fichier. */
function unanimite(lignes: LigneMelange[]): MelangeApercu {
  if (lignes.length === 0) return { actif: null, raison: "no-campaign", campagne: null };
  /**
   * ⛔ UNE SEULE CONVERSION, RÉUTILISÉE POUR LES DEUX DÉCISIONS. Lire `mix_latest` une fois pour
   * détecter le désaccord et une seconde fois pour rendre le verdict laisse les deux lectures
   * diverger : mesuré par mutation le 04/09 — assouplir la première en `!== false` faisait passer
   * « une campagne à `null`, une à `true` » pour un accord, et le verdict prenait alors la valeur
   * de la première. Le mélange s'éteignait pour la campagne qui l'avait allumé, en silence.
   */
  const valeurs = lignes.map((l) => l.mix_latest === true);
  if (new Set(valeurs).size > 1) return { actif: null, raison: "several", campagne: null };
  // Le nom n'accompagne le verdict que s'il désigne sans ambiguïté : à plusieurs campagnes
  // d'accord entre elles, en nommer une laisserait croire que les autres ne comptent pas.
  return { actif: valeurs[0]!, raison: "ok", campagne: lignes.length === 1 ? (lignes[0]!.name ?? null) : null };
}

/** L'interrupteur d'UNE campagne, quand l'appelant sait laquelle. */
export async function melangeDeCampagne(
  db: Db,
  campaignId: string,
  assetId: string,
): Promise<MelangeApercu> {
  // ⚠️ Pas de contrôle d'uuid ici, comme `cadenceDeCampagne` juste au-dessus : un id malformé fait
  // répondre 400 à PostgREST, donc `error`, donc `not-found` — le même verdict que pour une
  // campagne d'une autre marque, et c'est le bon : les deux appellent le même geste.
  const { data, error } = await db
    .from("campaign")
    .select(CHAMPS_MELANGE)
    .eq("id", campaignId)
    .eq("asset_id", assetId)
    .maybeSingle();
  if (error || !data) return { actif: null, raison: "not-found", campagne: null };
  return unanimite([data as unknown as LigneMelange]);
}

/**
 * L'interrupteur déduit du MODÈLE en cours d'édition — le seul chemin dont dispose le builder, qui
 * s'ouvre depuis la liste des modèles et n'a jamais de campagne sous la main.
 *
 * ⚠️ Même jointure que la cadence : par `template_version.template_id`, jamais par
 * `template_version_id`. Le builder édite le brouillon v0, une campagne pointe une version publiée.
 */
export async function melangeDuModele(
  db: Db,
  templateId: string,
  assetId: string,
): Promise<MelangeApercu> {
  const lignes = await campagnesDuModele<LigneMelange>(db, templateId, assetId, CHAMPS_MELANGE);
  if (lignes === null) return { actif: null, raison: "not-found", campagne: null };
  return unanimite(lignes);
}
