/**
 * Accès base du MATÉRIALISEUR (S-4), séparé de `db.ts` qui sert l'envoi.
 *
 * ⛔ POURQUOI UN FICHIER À PART. `db.ts` est la surface qui touche `email_outbox` : claim, mark
 * sent/failed/skipped, release. Le matérialiseur ne doit RIEN pouvoir faire de tout cela. Les
 * séparer rend l'invariant du lot vérifiable d'un coup d'œil plutôt que par relecture : ce fichier
 * ne nomme jamais `email_outbox`, donc aucune passe de planification ne peut mettre un email en
 * file, même par erreur de frappe.
 */
import { createClient } from "@supabase/supabase-js";
import { ecartDeCadence, lireAudience, type Audience } from "@nf/analytics/article-views";
import { revisionEnAttente } from "@nf/edition/regles";
import type { WorkerConfig } from "./env";
import { campaignCanStillSend } from "./campaign-status";
import type { LignePartial } from "./brand-partials";

/** Le plan, tel que le matérialiseur le lit. */
export interface PlanRow {
  id: string;
  asset_id: string;
  name: string;
  status: string;
  timezone: string | null;
  recurrence_days: number[] | null;
  recurrence_time: string | null;
  recurrence_every_weeks: number | null;
  recurrence_anchor: string | null;
  recurrence_until: string | null;
  freeze_lead_minutes: number | null;
  template_version_id: string | null;
  segment_id: string | null;
  subject: string | null;
  preheader: string | null;
  /** Numéro de la première édition (0067). Plancher de la numérotation, voir `prochainNumero`. */
  edition_start: number | null;
}

/**
 * Ce que le gel a LU de l'édition et qu'il fige — la garde de `freezeOccurrence` exige qu'il n'ait pas
 * changé entre la lecture et l'écriture. Les valeurs BRUTES de la ligne, jamais celles du gel (sujet
 * retombé sur le modèle, preheader effectif) : c'est la ligne qu'on compare.
 */
export interface ContenuLu {
  subject: string | null;
  preheader: string | null;
  segment_id: string | null;
}

export interface OccurrenceBrief {
  id: string;
  seq: number;
  local_date: string | null;
  status: string;
}

export interface FreezeCandidate {
  id: string;
  campaign_id: string;
  asset_id: string;
  scheduled_at: string | null;
  subject: string | null;
  preheader: string | null;
  segment_id: string | null;
  template_version_id: string | null;
  /** Non nul = un humain a déjà dit « envoie quand même » sur cette occurrence (0028). */
  duplicate_ack_at: string | null;
  /**
   * L'écart d'une relecture écrite AVANT le gel (sujet / preheader de cette édition) et sa révision
   * (0079). Optionnels : un double de test d'avant 0079 ne les porte pas, et les lire absents vaut
   * « aucune relecture ».
   */
  review_overrides?: unknown;
  review_rev?: number | null;
  /**
   * ⚠️ La récurrence est embarquée ICI parce que le gel en a besoin : un bloc flux réglé sur
   * « suivre la cadence » doit connaître l'écart entre deux envois pour savoir quelle période
   * classer. `PlanRow` la porte aussi, mais il n'est lu que par le matérialiseur — deux passes
   * différentes, deux lectures.
   */
  campaign: {
    freeze_lead_minutes: number | null;
    name: string | null;
    status: string | null;
    /** 0077 — non nul = campagne archivée : elle ne gèle plus (voir `campaignCanStillSend`). */
    archived_at?: string | null;
    timezone: string | null;
    recurrence_days: number[] | null;
    recurrence_time: string | null;
    recurrence_every_weeks: number | null;
    recurrence_anchor: string | null;
    recurrence_active: boolean | null;
    /**
     * L'interrupteur de mélange (0049). ⛔ Il est lu ICI et nulle part ailleurs : sans cette ligne
     * dans le `select` ci-dessous, la case cochée à l'écran n'atteindrait JAMAIS le gel — une
     * colonne écrite par quelqu'un et lue par personne.
     */
    mix_latest: boolean | null;
  } | null;
}

/**
 * Une édition GELÉE dont la relecture attend d'être appliquée (0079) : `review_rev > review_applied_rev`.
 * `review_base` est ce que le gel a produit ; `review_overrides`, l'écart écrit par l'écran.
 */
export interface RefreezeCandidate {
  id: string;
  campaign_id: string;
  asset_id: string;
  review_base: unknown;
  review_overrides: unknown;
  review_rev: number;
  review_applied_rev: number;
  campaign: { name: string | null; status: string | null; archived_at?: string | null } | null;
}

/** Le dernier contenu ARRÊTÉ d'un plan, celui auquel le gel suivant se compare. */
export interface SettledOccurrence {
  id: string;
  seq: number;
  local_date: string | null;
  status: string;
  content_sha256: string | null;
}

export interface PublishedVersion {
  id: string;
  status: string;
  subject: string | null;
  preheader: string | null;
  doc: unknown;
  html_shell: string | null;
  text_shell: string | null;
  size_bytes: number | null;
  template?: { asset_id: string; archived_at: string | null } | null;
}

export interface ComputedOccurrence {
  local_date: string;
  fires_at: string;
  local_text: string;
}

/** ⚠️ Factory, et non `ReturnType<typeof createClient>` : annoter le client avec le type nu perd
 *  l'option `schema` et supabase-js infère alors un schéma VIDE — toutes les tables deviennent
 *  `never`, et chaque requête cesse de compiler pour une raison qui n'a rien à voir avec elle. */
function makeClient(cfg: WorkerConfig) {
  return createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    db: { schema: "newsletter" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * ⛔ UN FILTRE `.in()` VOYAGE DANS L'URL. PostgREST le reçoit en GET, et au-delà de la ligne de
 * requête qu'admet le proxy devant lui (8 Ko chez nginx par défaut, 4 Ko dans certaines configs)
 * la base n'est même pas interrogée : nginx répond 414. Le 23/09, l'édition Copper Kettle · CL a
 * été retenue pour ça — un bloc classé par vues passait tout son pool de la semaine.
 *
 * On découpe donc en tranches dont la valeur ENCODÉE tient sous `budget` caractères : une mesure
 * en octets d'URL, pas en nombre de liens, car un lien de 300 caractères en pèse trois courts.
 * 3000 laisse la place au reste de l'URL même sous un plafond de 4 Ko. Un lien seul plus long que
 * le budget part seul : on ne le coupe pas, on ne le perd pas. Les doublons sont retirés.
 */
export function tranchesDeLiens(hrefs: readonly string[], budget = 3000): string[][] {
  const tranches: string[][] = [];
  let courante: string[] = [];
  let poids = 0;
  for (const href of new Set(hrefs)) {
    // Guillemets et virgule comptés : postgrest-js cite une valeur qui contient `,` ou `()`.
    const p = encodeURIComponent(`"${href}",`).length;
    if (courante.length > 0 && poids + p > budget) {
      tranches.push(courante);
      courante = [];
      poids = 0;
    }
    courante.push(href);
    poids += p;
  }
  if (courante.length > 0) tranches.push(courante);
  return tranches;
}

export class PlannerDb {
  private sb: ReturnType<typeof makeClient>;

  constructor(cfg: WorkerConfig) {
    this.sb = makeClient(cfg);
  }

  /**
   * Les plans ARMÉS. `recurrence_active` est le seul interrupteur : rien d'autre ne rend une série
   * vivante, et aucune route de l'admin ne le met à vrai — c'est un geste délibéré, ailleurs.
   */
  async listArmedPlans(): Promise<PlanRow[]> {
    const { data, error } = await this.sb
      .from("campaign")
      .select(
        "id, asset_id, name, status, timezone, recurrence_days, recurrence_time, recurrence_every_weeks, recurrence_anchor, recurrence_until, freeze_lead_minutes, template_version_id, segment_id, subject, preheader, edition_start",
      )
      .eq("recurrence_active", true)
      // Une campagne annulée garde sa cadence en base ; la ressusciter serait un envoi que
      // personne n'a demandé.
      .not("status", "in", "(cancelled,sent)")
      // ⛔ Une campagne ARCHIVÉE (0077) non plus. La route d'archivage éteint déjà la série
      // (`recurrence_active = false`) : ce filtre est la ceinture, pour le jour où une écriture
      // rallumerait l'interrupteur d'une campagne rangée. Planifier dans un onglet que personne ne
      // regarde, c'est envoyer sans témoin.
      .is("archived_at", null);
    if (error) throw new Error(`listArmedPlans: ${error.message}`);
    return (data ?? []) as unknown as PlanRow[];
  }

  /** Les dates d'une cadence, calculées par la fonction SQL 0025 — jamais en TypeScript. */
  async computeOccurrences(p: {
    days: number[];
    time: string;
    timezone: string;
    everyWeeks: number;
    anchor: string;
    from: string;
    to: string;
    limit: number;
  }): Promise<ComputedOccurrence[]> {
    const { data, error } = await this.sb.rpc("campaign_occurrences", {
      p_days: p.days,
      p_time: p.time,
      p_timezone: p.timezone,
      p_every_weeks: p.everyWeeks,
      p_anchor: p.anchor,
      p_from: p.from,
      p_to: p.to,
      p_limit: p.limit,
    });
    if (error) throw new Error(`campaign_occurrences: ${error.message}`);
    return (data ?? []) as unknown as ComputedOccurrence[];
  }

  /**
   * Toutes les occurrences d'un plan, ANNULÉES COMPRISES : le matérialiseur ne doit jamais
   * ressusciter un jour qu'un humain a annulé, alors que la clé d'unicité, elle, l'autoriserait.
   */
  async listOccurrences(campaignId: string): Promise<OccurrenceBrief[]> {
    const { data, error } = await this.sb
      .from("campaign_occurrence")
      .select("id, seq, local_date, status")
      .eq("campaign_id", campaignId);
    if (error) throw new Error(`listOccurrences: ${error.message}`);
    return (data ?? []) as unknown as OccurrenceBrief[];
  }

  /**
   * ⚠️ Laisse remonter le CODE d'erreur Postgres : le matérialiseur distingue la violation
   * d'unicité (deux workers qui se croisent — normal) du reste (un vrai défaut).
   */
  async insertOccurrence(row: Record<string, unknown>): Promise<void> {
    const { error } = await this.sb.from("campaign_occurrence").insert(row);
    if (error) throw Object.assign(new Error(`insertOccurrence: ${error.message}`), { code: error.code });
  }

  /**
   * Occurrences dont l'heure de gel est atteinte : `scheduled_at − freeze_lead ≤ maintenant`.
   * Le décalage de gel est porté par le PLAN, d'où la jointure.
   */
  async listOccurrencesToFreeze(nowIso: string): Promise<FreezeCandidate[]> {
    const { data, error } = await this.sb
      .from("campaign_occurrence")
      .select(
        "id, campaign_id, asset_id, scheduled_at, subject, preheader, segment_id, template_version_id, duplicate_ack_at, review_overrides, review_rev, campaign:campaign_id(freeze_lead_minutes, name, status, archived_at, timezone, recurrence_days, recurrence_time, recurrence_every_weeks, recurrence_anchor, recurrence_active, mix_latest)",
      )
      .eq("status", "planned")
      .not("scheduled_at", "is", null)
      // Une occurrence dont l'heure est DÉJÀ PASSÉE n'est pas gelée ici : ce serait un rattrapage
      // silencieux, exactement ce que S-7 interdit (« on annule bruyamment, on ne rattrape pas »).
      .gte("scheduled_at", nowIso)
      .order("scheduled_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(`listOccurrencesToFreeze: ${error.message}`);

    const now = new Date(nowIso).getTime();
    return ((data ?? []) as unknown as FreezeCandidate[]).filter((r) => {
      /*
       * ⛔ LE MÊME REFUS QUE LE FAN-OUT, ET AU MÊME ENDROIT DE LA CHAÎNE.
       *
       * Geler coûte plus qu'un statut : la passe résout les flux WordPress puis MÉMORISE les
       * articles retenus dans `feed_article_sent`, ce qui les exclut des éditions suivantes. Le
       * faire pour une campagne que le fan-out refusera (`paused`, `cancelled`) brûlait donc les
       * articles du jour au profit d'un email qui ne partait jamais — une campagne laissée en pause
       * appauvrissait la newsletter en silence, sans la moindre trace.
       *
       * ⛔ `archived_at` passe par la MÊME fonction (0077) : une campagne archivée ne gèle plus, pour
       * la même raison qu'une campagne en pause — le fan-out la refusera.
       */
      if (!campaignCanStillSend(r.campaign?.status, r.campaign?.archived_at)) return false;
      const lead = (r.campaign?.freeze_lead_minutes ?? 90) * 60_000;
      return r.scheduled_at !== null && new Date(r.scheduled_at).getTime() - lead <= now;
    });
  }

  /**
   * Une version PUBLIÉE de cette marque, avec son document (pour la mesure de fraîcheur).
   * Revalidation complète, comme `/lock` : la version a pu être dépubliée ou son modèle archivé
   * depuis que la campagne l'a choisie. Le gel est le dernier moment où l'on peut encore refuser.
   */
  async loadPublishedVersion(versionId: string, assetId: string): Promise<PublishedVersion | null> {
    const { data, error } = await this.sb
      .from("template_version")
      .select(
        "id, status, subject, preheader, doc, html_shell, text_shell, size_bytes, template:template_id(asset_id, archived_at)",
      )
      .eq("id", versionId)
      .maybeSingle();
    if (error) throw new Error(`loadPublishedVersion: ${error.message}`);
    if (!data) return null;
    const v = data as unknown as PublishedVersion;
    if (v.status !== "published") return null;
    if (!v.template || v.template.asset_id !== assetId || v.template.archived_at !== null) return null;
    return v;
  }

  /**
   * Les lignes `brand_partial` d'une marque, pour les pointeurs que porte un document.
   *
   * ⛔ NE FILTRE PAS `archived_at`, et c'est le point entier : archiver un partial le retire de la
   * bibliothèque de l'admin, cela ne doit RIEN changer aux modèles qui pointent déjà dessus. Filtrer
   * ici ferait disparaître l'en-tête de plusieurs newsletters à leur prochaine édition, sans qu'un
   * seul écran ne l'ait annoncé.
   *
   * ⛔ FILTRE SUR `asset_id` malgré l'accès par id : un partial d'une autre marque doit être
   * indiscernable d'un partial inexistant — même invariant que partout ailleurs dans ce schéma.
   *
   * ⛔ LÈVE SI LA LECTURE ÉCHOUE. Rendre un tableau vide ferait croire à l'appelant que les
   * pointeurs ne désignent rien, et l'édition partirait sans son en-tête pour une panne réseau.
   */
  async brandPartialsOf(assetId: string, ids: readonly string[]): Promise<LignePartial[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.sb
      .from("brand_partial")
      .select("id, slot, rows")
      .eq("asset_id", assetId)
      .in("id", ids as string[]);
    if (error) throw new Error(`brandPartialsOf: ${error.message}`);
    return ((data as unknown) as LignePartial[]) ?? [];
  }

  /**
   * ⚠️ `eq("status","planned")` en garde de concurrence : on n'écrase pas une ligne qu'un autre
   * acteur aurait déjà fait bouger entre la lecture et l'écriture.
   *
   * ⛔ ET ON LIT LE RÉSULTAT. Sans `.select()`, supabase-js ne remonte ni erreur ni nombre de
   * lignes touchées : deux passes qui se chevauchent résolvaient toutes les deux les flux, une
   * seule gelait réellement, mais LES DEUX comptaient un gel et LES DEUX mémorisaient les articles
   * — donc les brûlaient en double. Le fan-out, lui, lit son claim depuis toujours ; le gel avait
   * la même garde écrite mais pas le même constat. Rend `true` si CETTE passe a gelé.
   *
   * ⛔ ET LA VERSION LUE (25/09/2026). Enregistrer une campagne avec une nouvelle version repointe ses
   * éditions `planned` à venir (admin, `repointUpcomingOccurrences`). Si ce repointage tombe entre
   * notre lecture et cette écriture, geler figerait le contenu de l'ANCIENNE version sous une ligne
   * qui porte la nouvelle. `versionLue` refuse ce gel : 0 ligne, `false`, et la passe suivante gèle
   * avec la version en place.
   *
   * ⛔ ET LE SUJET, LE PREHEADER ET LE SEGMENT LUS (25/09/2026 au soir, « même règle »). L'enregistrement
   * de la campagne les repointe eux aussi. Le gel les FIGE : il réécrit `subject` et `preheader` avec
   * ceux qu'il a lus (le patch les porte) et en tire le HTML, l'empreinte anti-doublon et `review_base`,
   * où le segment lu entre aussi. Sans cette garde, un repointage tombé entre la lecture et l'écriture
   * serait ÉCRASÉ par l'ancien sujet, et l'édition partirait avec lui — pendant que l'écran l'annonçait
   * mise à jour. Pour le segment, l'envoi viserait le nouveau sous une empreinte calculée sur l'ancien.
   */
  async freezeOccurrence(
    id: string,
    patch: Record<string, unknown>,
    versionLue: string,
    contenuLu: ContenuLu,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    let requete = this.sb
      .from("campaign_occurrence")
      .update({ ...patch, status: "frozen", frozen_at: now, updated_at: now })
      .eq("id", id)
      .eq("status", "planned")
      .eq("template_version_id", versionLue);
    for (const colonne of ["subject", "preheader", "segment_id"] as const) {
      const lu = contenuLu[colonne];
      // ⛔ `.is(…, null)`, JAMAIS `.eq(…, null)` : PostgREST lirait `eq.null` comme le TEXTE « null », et
      // un NULL SQL ne passe aucune égalité — toute édition sans preheader ou sans segment verrait son
      // gel refusé à chaque passe, en silence, jusqu'à manquer son heure.
      requete = lu === null ? requete.is(colonne, null) : requete.eq(colonne, lu);
    }
    const { data, error } = await requete.select("id");
    if (error) throw new Error(`freezeOccurrence: ${error.message}`);
    return (data ?? []).length > 0;
  }

  /* ---------------- Relecture d'édition (0079) ---------------- */

  /**
   * Les éditions GELÉES dont la relecture n'est pas encore appliquée.
   *
   * ⚠️ PostgREST ne compare pas deux colonnes entre elles : on ramène les gelées déjà relues au moins
   * une fois (`review_rev > 0`) et on garde celles dont la révision dépasse l'appliquée. Le volume est
   * borné par le statut : une édition n'est `frozen` que ~90 min.
   *
   * ⛔ LE MÊME REFUS QUE LE GEL ET LE FAN-OUT (`campaignCanStillSend`) : reconstruire une édition
   * d'une campagne en pause, annulée ou archivée n'enverrait rien — le fan-out la refusera.
   */
  async listOccurrencesToRefreeze(): Promise<RefreezeCandidate[]> {
    const { data, error } = await this.sb
      .from("campaign_occurrence")
      .select(
        "id, campaign_id, asset_id, review_base, review_overrides, review_rev, review_applied_rev, campaign:campaign_id(name, status, archived_at)",
      )
      .eq("status", "frozen")
      .gt("review_rev", 0)
      .order("scheduled_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(`listOccurrencesToRefreeze: ${error.message}`);
    return ((data ?? []) as unknown as RefreezeCandidate[]).filter(
      (r) =>
        campaignCanStillSend(r.campaign?.status, r.campaign?.archived_at) &&
        revisionEnAttente(r.review_rev, r.review_applied_rev),
    );
  }

  /**
   * Écrit une édition reconstruite. ⛔ Gardée par `status = 'frozen'` ET par la RÉVISION LUE : une
   * relecture enregistrée entre-temps (révision plus haute) ou une édition partie en file (`sending`)
   * ne sont jamais écrasées. Rend `true` si CETTE passe a écrit — même règle que `freezeOccurrence`.
   */
  async applyReview(id: string, rev: number, patch: Record<string, unknown>): Promise<boolean> {
    const { data, error } = await this.sb
      .from("campaign_occurrence")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "frozen")
      .eq("review_rev", rev)
      .select("id");
    if (error) throw new Error(`applyReview: ${error.message}`);
    return (data ?? []).length > 0;
  }

  /**
   * La raison pour laquelle une relecture ne s'applique pas, écrite là où l'écran la lit. Gardée par
   * la révision : une relecture corrigée depuis ne reçoit pas l'erreur de la précédente.
   */
  async recordReviewError(id: string, rev: number, reason: string): Promise<void> {
    const { error } = await this.sb
      .from("campaign_occurrence")
      .update({ review_error: reason.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("review_rev", rev);
    if (error) throw new Error(`recordReviewError: ${error.message}`);
  }

  /**
   * Les occurrences que le gel ne rattrapera JAMAIS : encore `planned` alors que leur heure est
   * passée. `listOccurrencesToFreeze` les exclut délibérément (on n'envoie pas en retard), mais
   * l'exclusion était MUETTE : l'édition ne partait pas, sans erreur, sans `held`, sans raison, et
   * aucun compteur du rapport ne la voyait. Un refus qui ne dit pas son nom est une panne.
   */
  async countOverdueOccurrences(nowIso: string): Promise<number> {
    const { count, error } = await this.sb
      .from("campaign_occurrence")
      .select("id", { count: "exact", head: true })
      .eq("status", "planned")
      .not("scheduled_at", "is", null)
      .lt("scheduled_at", nowIso);
    if (error) throw new Error(`countOverdueOccurrences: ${error.message}`);
    return count ?? 0;
  }

  /**
   * Retenir, avec la RAISON. La contrainte `occurrence_held_needs_reason` (0027) refuse un
   * « held » muet : un statut sans cause ne dit rien à qui découvre l'écran le lendemain matin.
   */
  async holdOccurrence(id: string, reason: string, duplicateOf?: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.sb
      .from("campaign_occurrence")
      .update({
        status: "held",
        hold_reason: reason.slice(0, 500),
        updated_at: now,
        // Renseigné AU MOMENT du blocage : le retrouver après coup obligerait à rejouer la
        // comparaison sur des lignes qui ont pu bouger entre-temps.
        ...(duplicateOf ? { duplicate_of: duplicateOf } : {}),
      })
      .eq("id", id)
      .eq("status", "planned");
    if (error) throw new Error(`holdOccurrence: ${error.message}`);
  }

  /**
   * Le dernier contenu ARRÊTÉ de ce plan — gelé, en vol OU envoyé.
   *
   * ⛔ POURQUOI PAS SEULEMENT « ENVOYÉ ». Comparer à la dernière occurrence `sent` laisse passer le
   * cas des occurrences rapprochées : une quotidienne gèle celle de demain 90 minutes avant, alors
   * que celle d'aujourd'hui n'est encore que `frozen`. La comparaison ne verrait rien, et les deux
   * partiraient identiques. Un contenu arrêté PARTIRA — c'est à lui qu'il faut se comparer.
   */
  async findLastSettled(campaignId: string, excludeId: string): Promise<SettledOccurrence | null> {
    const { data, error } = await this.sb
      .from("campaign_occurrence")
      .select("id, seq, local_date, status, content_sha256")
      .eq("campaign_id", campaignId)
      .neq("id", excludeId)
      .not("content_sha256", "is", null)
      .in("status", ["frozen", "sending", "sent"])
      .order("frozen_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`findLastSettled: ${error.message}`);
    return (data as unknown as SettledOccurrence | null) ?? null;
  }

  /**
   * ⛔ LA PREUVE DU LOT, mesurée et non supposée : combien de lignes d'`email_outbox` portent une
   * occurrence. Seule mention d'`email_outbox` de tout le chemin de planification, et elle est en
   * LECTURE. Tant que S-6 n'existe pas, ce nombre doit rester 0 après n'importe quelle passe.
   */
  async countOutboxRowsWithOccurrence(): Promise<number> {
    const { count, error } = await this.sb
      .from("email_outbox")
      .select("id", { count: "exact", head: true })
      .not("occurrence_id", "is", null);
    if (error) throw new Error(`countOutboxRowsWithOccurrence: ${error.message}`);
    return count ?? 0;
  }

  /* ---------------- Flux d'articles (blocs `article-feed`) ---------------- */

  /**
   * La source WordPress d'un bloc flux — SCOPÉE MARQUE.
   *
   * ⛔ Le filtre `asset_id` n'est pas une précaution de style : sans lui, un modèle qui aurait gardé
   * l'id d'une source d'une AUTRE marque tirerait ses articles de ce site-là, et la newsletter d'une
   * publication partirait avec le contenu d'une autre. Une source introuvable ici est une rétention,
   * jamais un repli silencieux.
   */
  async loadWpSource(
    sourceId: string,
    assetId: string,
  ): Promise<{ id: string; label: string; restRoot: string; kind: string } | null> {
    const { data, error } = await this.sb
      .from("wp_source")
      .select("id, label, rest_root, kind")
      .eq("id", sourceId)
      .eq("asset_id", assetId)
      .maybeSingle();
    if (error) throw new Error(`loadWpSource: ${error.message}`);
    if (!data) return null;
    const r = data as unknown as Record<string, unknown>;
    return {
      id: String(r.id),
      label: String(r.label ?? ""),
      restRoot: String(r.rest_root ?? ""),
      kind: String(r.kind ?? "wp-rest"),
    };
  }

  /**
   * Parmi ces liens, ceux qui sont DÉJÀ partis pour cette campagne depuis `sinceIso`.
   *
   * ⚠️ On interroge avec la liste des liens candidats plutôt que de rapatrier tout l'historique :
   * une quotidienne accumule des milliers de lignes. La fenêtre est calculée par l'appelant
   * (@nf/wp) — une seule définition de « déjà parti », partagée avec l'aperçu de l'admin.
   *
   * ⛔ LES CANDIDATS NE SONT PAS « LA DIZAINE QU'ON VA ENVOYER ». Un bloc classé par vues récolte
   * TOUTE la période, des centaines de liens, et ils passent tous ici : d'où les tranches (cf.
   * `tranchesDeLiens`). Une tranche en échec fait lever l'ensemble — un anti-répétition à moitié
   * lu renverrait des articles déjà partis sans que personne ne le voie.
   */
  async sentArticleUrls(campaignId: string, hrefs: string[], sinceIso: string): Promise<Set<string>> {
    const deja = new Set<string>();
    for (const tranche of tranchesDeLiens(hrefs)) {
      const { data, error } = await this.sb
        .from("feed_article_sent")
        .select("article_url")
        .eq("campaign_id", campaignId)
        .gte("sent_at", sinceIso)
        .in("article_url", tranche);
      if (error) throw new Error(`sentArticleUrls: ${error.message}`);
      for (const r of (data ?? []) as unknown as { article_url: string }[]) deja.add(r.article_url);
    }
    return deja;
  }

  /**
   * L'audience GA4 des articles candidats, pour un bloc réglé sur `orderby: "views"`.
   *
   * ⛔ ON PASSE PAR `@nf/analytics`, le MÊME module que l'aperçu de l'admin. Une seconde
   * implémentation de « les vues de ces liens » finirait par ne pas traiter les `null` pareil — et
   * l'auteur validerait un classement dont les abonnés recevraient un autre.
   *
   * ⚠️ Cette méthode ne fait que passer le client : toute la logique (fenêtre effective, motifs de
   * refus, `null` qui ne devient jamais 0) vit dans le module partagé, sous banc.
   */
  articleViews(assetId: string, hrefs: string[], du: string, au: string): Promise<Audience> {
    return lireAudience(this.sb, assetId, hrefs, du, au);
  }

  /**
   * L'écart en jours entre l'envoi précédent de cette campagne et celui qu'on gèle — la période
   * qu'un bloc flux réglé sur « suivre la cadence » doit classer.
   *
   * ⛔ ON DEMANDE À `campaign_occurrences`, PAS À LA TABLE DES OCCURRENCES. La fonction est
   * `stable`, ne lit aucune table et se calcule sur le passé : elle rend la cadence VOULUE. Lire
   * les occurrences réellement matérialisées ferait dépendre la période des accidents — une
   * occurrence retenue ou annulée la semaine dernière doublerait la fenêtre de cette semaine, sans
   * que personne l'ait décidé.
   *
   * `null` = aucune cadence exploitable : récurrence non armée, ou incomplète. L'appelant DIT alors
   * qu'il retombe sur le défaut ; il ne fait pas semblant d'avoir suivi la campagne.
   */
  async cadenceJours(c: FreezeCandidate): Promise<number | null> {
    const cam = c.campaign;
    if (
      !cam ||
      cam.recurrence_active !== true ||
      !cam.recurrence_days ||
      cam.recurrence_days.length === 0 ||
      !cam.recurrence_time ||
      !cam.recurrence_anchor ||
      !c.scheduled_at
    ) {
      return null;
    }

    const cible = new Date(c.scheduled_at);
    if (Number.isNaN(cible.getTime())) return null;
    // 95 jours : de quoi couvrir le plafond de 90 de `viewsWindow` avec une marge, sans demander
    // un historique dont personne ne ferait rien.
    const depuis = new Date(cible.getTime() - 95 * 86_400_000);

    const { data, error } = await this.sb.rpc("campaign_occurrences", {
      p_days: cam.recurrence_days,
      p_time: cam.recurrence_time,
      // ⚠️ Le fuseau vient de la CAMPAGNE, jamais du serveur : le worker tourne en UTC et
      // l'abonné lit à Rio. Une cadence calculée en UTC décalerait les frontières de jour.
      p_timezone: cam.timezone ?? "UTC",
      p_every_weeks: cam.recurrence_every_weeks ?? 1,
      p_anchor: cam.recurrence_anchor,
      p_from: depuis.toISOString(),
      p_to: cible.toISOString(),
      p_limit: 200,
    });
    if (error) throw new Error(`cadenceJours: ${error.message}`);

    return ecartDeCadence(
      ((data ?? []) as unknown as { fires_at: string }[]).map((r) => r.fires_at),
      c.scheduled_at,
    );
  }

  /**
   * Mémorise ce qui vient d'être retenu, pour que demain ne le renvoie pas.
   *
   * ⛔ ÉCRIT APRÈS LE GEL, JAMAIS AVANT. Enregistrer d'abord condamnerait les articles d'une
   * occurrence qui, finalement, n'est pas partie : ils seraient exclus de tous les envois suivants
   * sans avoir jamais atteint personne.
   * ⛔ PAR RPC, ET PAS PAR `upsert`. `feed_article_sent` protège son idempotence par deux index
   * uniques PARTIELS (0042), et PostgREST ne sait pas les viser : son `ignoreDuplicates` pose un
   * `ON CONFLICT` sur la clé primaire, où aucune collision n'a lieu puisque chaque ligne arrive
   * avec un `id` neuf. Le doublon remonte alors en 23505 et fait échouer TOUT le lot — mesuré le
   * 26/08 sur un banc. `ON CONFLICT DO NOTHING` sans cible (0043) est la seule forme qui couvre un
   * index partiel, et elle n'existe qu'en SQL.
   *
   * ⚠️ Les doublons ne sont pas une erreur : deux passes concurrentes peuvent proposer les mêmes
   * lignes, et une occurrence regelée après incident les propose forcément.
   */
  async recordSentArticles(
    rows: {
      campaignId: string;
      occurrenceId: string | null;
      assetId: string;
      blockId: string;
      articleUrl: string;
      articleTitle: string;
      publishedAt: string | null;
    }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.sb.rpc("record_feed_articles", {
      p_rows: rows.map((r) => ({
        campaign_id: r.campaignId,
        occurrence_id: r.occurrenceId,
        asset_id: r.assetId,
        block_id: r.blockId,
        article_url: r.articleUrl,
        article_title: r.articleTitle,
        published_at: r.publishedAt,
      })),
    });
    if (error) throw new Error(`recordSentArticles: ${error.message}`);
  }

  /** Ce qu'une occurrence a réellement retenu — pour l'afficher, pas pour décider. */
  async listSentArticles(occurrenceId: string): Promise<{ url: string; title: string }[]> {
    const { data, error } = await this.sb
      .from("feed_article_sent")
      .select("article_url, article_title")
      .eq("occurrence_id", occurrenceId)
      .order("sent_at", { ascending: true });
    if (error) throw new Error(`listSentArticles: ${error.message}`);
    return ((data ?? []) as unknown as { article_url: string; article_title: string }[]).map((r) => ({
      url: r.article_url,
      title: r.article_title,
    }));
  }
}
