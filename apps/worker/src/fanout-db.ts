/**
 * Accès base du FAN-OUT (S-6) — la seule surface du worker qui ÉCRIT des lignes de campagne.
 *
 * ⛔ POURQUOI UN TROISIÈME FICHIER D'ACCÈS. `db.ts` sert l'ENVOI (claim, mark sent/failed),
 * `planner-db.ts` sert la PLANIFICATION et ne nomme jamais `email_outbox` — c'est ce qui rend son
 * invariant vérifiable d'un coup d'œil. Le fan-out, lui, doit écrire dans la file : lui donner
 * accès au claim ou au mark aurait mélangé « remplir la file » et « la vider », deux gestes qu'on
 * veut pouvoir armer séparément. Un fichier par responsabilité, et la responsabilité se lit dans
 * la liste des méthodes.
 *
 * ⛔ AUCUNE ADRESSE E-MAIL NE TRANSITE PAR CE FICHIER. On lit des identifiants d'abonnement, on les
 * passe à `enqueue_campaign_batch` (0038) qui va chercher l'adresse en base. Le worker n'a donc
 * jamais en mémoire la liste des destinataires d'une campagne.
 */
import { createClient } from "@supabase/supabase-js";
import { AUDIENCE_VIEW, type Population, type RuleContext } from "@nf/segments";
import { revisionEnAttente } from "@nf/edition/regles";
import type { WorkerConfig } from "./env";
import { campaignCanStillSend } from "./campaign-status";

/** Une cible de mise en file : soit une occurrence de série, soit une campagne simple. */
export interface FanoutTarget {
  /** Identifiant de l'occurrence, ou `null` pour une campagne sans cadence. */
  occurrenceId: string | null;
  campaignId: string;
  assetId: string;
  campaignName: string;
  /** Le segment du porteur : celui de l'occurrence pour une série (il a été figé au gel). */
  segmentId: string | null;
  purpose: string | null;
  scheduledAt: string | null;
  /** Ce que l'admin avait annoncé au moment de planifier — sert à mesurer l'écart, pas à décider. */
  recipientsPlanned: number | null;
  /**
   * Relecture d'édition (0079), occurrences seulement. `reviewRev` est la révision LUE : la prise de la
   * cible est gardée par elle. `reviewPending` = une relecture est écrite mais le worker ne l'a pas
   * encore reconstruite — l'édition ne part pas dans cet état. Absents = campagne ponctuelle, ou
   * double de test d'avant 0079 : aucune relecture.
   */
  reviewRev?: number;
  reviewPending?: boolean;
  /**
   * La case de la CAMPAGNE (0088) : ses contacts hors newsletter passent sans leur finalité. Ne joue
   * que si le segment vise les contacts. Absente (double de test d'avant 0088) = barrière appliquée.
   */
  contactsIgnorePurpose?: boolean;
}

export interface SegmentRule {
  id: string;
  rule: unknown;
}

/** ⚠️ Factory, et non `ReturnType<typeof createClient>` : le type nu perd l'option `schema` et
 *  supabase-js infère alors un schéma VIDE — toutes les tables deviennent `never`. */
function makeClient(cfg: WorkerConfig) {
  return createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    db: { schema: "newsletter" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export class FanoutDb {
  private sb: ReturnType<typeof makeClient>;

  constructor(cfg: WorkerConfig) {
    this.sb = makeClient(cfg);
  }

  /**
   * Les OCCURRENCES dues : gelées, datées, dont l'heure d'envoi entre dans la fenêtre.
   *
   * ⛔ `status = 'frozen'` et rien d'autre. Une occurrence `planned` n'a pas encore de contenu (le
   * gel ne l'a pas atteinte), une `held` est retenue par la garde anti-doublon, une `cancelled` a
   * été annulée par un humain. Enfiler l'une des trois serait envoyer ce que personne n'a arrêté.
   */
  async listDueOccurrences(now: Date, leadMinutes: number): Promise<FanoutTarget[]> {
    const horizon = new Date(now.getTime() + leadMinutes * 60_000).toISOString();
    const { data, error } = await this.sb
      .from("campaign_occurrence")
      .select(
        "id, campaign_id, asset_id, segment_id, scheduled_at, recipients_planned, review_rev, review_applied_rev, campaign:campaign_id(name, purpose, status, archived_at, contacts_ignore_purpose)",
      )
      .eq("status", "frozen")
      .not("scheduled_at", "is", null)
      .lte("scheduled_at", horizon)
      .order("scheduled_at", { ascending: true });
    if (error) throw new Error(`listDueOccurrences: ${error.message}`);

    const rows = (data ?? []) as unknown as {
      id: string;
      campaign_id: string;
      asset_id: string;
      segment_id: string | null;
      scheduled_at: string | null;
      recipients_planned: number | null;
      review_rev?: number | null;
      review_applied_rev?: number | null;
      campaign: {
        name: string | null;
        purpose: string | null;
        status: string | null;
        archived_at?: string | null;
        contacts_ignore_purpose?: boolean | null;
      } | null;
    }[];

    return rows
      // Une campagne annulée ou en pause garde ses occurrences gelées en base ; les enfiler serait
      // un envoi que personne n'a demandé. ⛔ Le critère vit dans `campaign-status.ts` : le GEL le
      // lit aussi, et deux copies de la même règle finissent toujours par diverger.
      // ⛔ Archivée (0077) : même refus. Une édition gelée juste avant l'archivage, ou que
      // l'annulation n'a pas pu toucher, ne part pas d'une campagne rangée.
      .filter((r) => campaignCanStillSend(r.campaign?.status, r.campaign?.archived_at))
      .map((r) => ({
        occurrenceId: r.id,
        campaignId: r.campaign_id,
        assetId: r.asset_id,
        campaignName: r.campaign?.name ?? "(sans nom)",
        segmentId: r.segment_id,
        purpose: r.campaign?.purpose ?? null,
        scheduledAt: r.scheduled_at,
        recipientsPlanned: r.recipients_planned,
        reviewRev: typeof r.review_rev === "number" ? r.review_rev : 0,
        // ⛔ La définition de « en attente » vit dans `@nf/edition` : l'écran de relecture dit
        // « changes pending » exactement quand le fan-out refuse.
        reviewPending: revisionEnAttente(r.review_rev, r.review_applied_rev),
        // ⛔ `=== true` : une valeur absente se lit « barrière appliquée », jamais l'inverse.
        contactsIgnorePurpose: r.campaign?.contacts_ignore_purpose === true,
      }));
  }

  /**
   * Les CAMPAGNES SIMPLES dues : planifiées, sans cadence, dont l'heure entre dans la fenêtre.
   *
   * ⛔ `recurrence_days is null` exclut les campagnes-modèles d'une série. Sans ce filtre, une
   * série serait enfilée DEUX fois : une fois par son occurrence du jour, une fois par son modèle —
   * et le second envoi porterait le contenu figé au premier verrou.
   */
  async listDueCampaigns(now: Date, leadMinutes: number): Promise<FanoutTarget[]> {
    const horizon = new Date(now.getTime() + leadMinutes * 60_000).toISOString();
    const { data, error } = await this.sb
      .from("campaign")
      .select("id, asset_id, name, segment_id, purpose, scheduled_at, recipients_planned, contacts_ignore_purpose")
      .eq("status", "scheduled")
      .is("recurrence_days", null)
      // ⛔ Ceinture (0077) : archiver un envoi programmé le remet en brouillon, donc il ne passe
      // déjà plus `status = 'scheduled'`. Ce filtre tient le jour où une écriture reprogrammerait une
      // campagne rangée sans la sortir des archives.
      .is("archived_at", null)
      .not("scheduled_at", "is", null)
      .lte("scheduled_at", horizon)
      .order("scheduled_at", { ascending: true });
    if (error) throw new Error(`listDueCampaigns: ${error.message}`);

    return ((data ?? []) as unknown as {
      id: string;
      asset_id: string;
      name: string | null;
      segment_id: string | null;
      purpose: string | null;
      scheduled_at: string | null;
      recipients_planned: number | null;
      contacts_ignore_purpose?: boolean | null;
    }[]).map((r) => ({
      occurrenceId: null,
      campaignId: r.id,
      assetId: r.asset_id,
      campaignName: r.name ?? "(sans nom)",
      segmentId: r.segment_id,
      purpose: r.purpose,
      scheduledAt: r.scheduled_at,
      recipientsPlanned: r.recipients_planned,
      contactsIgnorePurpose: r.contacts_ignore_purpose === true,
    }));
  }

  /**
   * Prend la cible : `frozen`/`scheduled` → `sending`, en UNE écriture conditionnelle.
   *
   * ⛔ CE N'EST PAS UN CONFORT, C'EST L'IDEMPOTENCE. Lire l'état, tester, puis écrire se fait
   * doubler dès que deux passes se chevauchent (la plateforme peut redémarrer un cron avant la fin du
   * précédent) : les deux liraient `frozen`, les deux passeraient le test, les deux enfileraient.
   * `update ... where status = <état attendu>` ne peut réussir qu'une fois ; le perdant reçoit
   * zéro ligne et s'arrête. La même règle qu'au désabonnement en un clic.
   *
   * ⛔ ET POUR UNE OCCURRENCE, LA RÉVISION DE RELECTURE LUE FAIT PARTIE DE LA CONDITION (0079). Le
   * fan-out a vérifié plus haut qu'aucune relecture n'attendait ; si l'écran en enregistre une entre
   * cette lecture et cette prise, la révision a bougé, la prise échoue, et l'édition attend sa
   * reconstruction au lieu de partir avec le contenu d'AVANT la relecture. Dans l'autre ordre, c'est
   * la route de relecture qui trouve `sending` et refuse (409) : les deux ne peuvent pas gagner.
   */
  async claim(target: FanoutTarget): Promise<boolean> {
    if (target.occurrenceId) {
      let prise = this.sb
        .from("campaign_occurrence")
        .update({ status: "sending", updated_at: new Date().toISOString() })
        .eq("id", target.occurrenceId)
        .eq("status", "frozen");
      if (typeof target.reviewRev === "number") prise = prise.eq("review_rev", target.reviewRev);
      const { data, error } = await prise.select("id");
      if (error) throw new Error(`claim occurrence: ${error.message}`);
      return (data ?? []).length === 1;
    }
    const { data, error } = await this.sb
      .from("campaign")
      .update({ status: "sending" })
      .eq("id", target.campaignId)
      .eq("status", "scheduled")
      .select("id");
    if (error) throw new Error(`claim campaign: ${error.message}`);
    return (data ?? []).length === 1;
  }

  /**
   * Rend la cible à son état précédent quand la mise en file a échoué AVANT d'écrire quoi que ce
   * soit. Une cible laissée en `sending` alors que sa file est vide est un envoi qui ne partira
   * jamais et que personne ne verra bloqué.
   */
  async releaseClaim(target: FanoutTarget): Promise<void> {
    if (target.occurrenceId) {
      await this.sb
        .from("campaign_occurrence")
        .update({ status: "frozen", updated_at: new Date().toISOString() })
        .eq("id", target.occurrenceId)
        .eq("status", "sending");
      return;
    }
    await this.sb.from("campaign").update({ status: "scheduled" }).eq("id", target.campaignId).eq("status", "sending");
  }

  /** Marque une occurrence RETENUE avec sa raison — jamais un blocage muet (0025 exige la raison). */
  async holdOccurrence(occurrenceId: string, reason: string): Promise<void> {
    const { error } = await this.sb
      .from("campaign_occurrence")
      .update({ status: "held", hold_reason: reason, updated_at: new Date().toISOString() })
      .eq("id", occurrenceId);
    if (error) throw new Error(`holdOccurrence: ${error.message}`);
  }

  /**
   * ⭐ LE PENDANT DE `holdOccurrence` POUR UNE CAMPAGNE PONCTUELLE — et il manquait.
   *
   * ⛔ LE DÉFAUT QU'IL FERME (18/09/2026, campagne « Test 3 »). Tous les refus du fan-out étaient
   * gardés par `if (t.occurrenceId …)` : une SÉRIE écartée voyait son occurrence passer `held` avec
   * sa raison, tandis qu'une campagne ponctuelle écartée n'écrivait RIEN. Elle restait `scheduled`,
   * était re-scannée et re-écartée à chaque passe, sans une ligne en base — et l'admin affichait
   * « Scheduled » pour toujours. Vu d'Alix : « quand je schedule one send ça ne s'envoie pas ».
   *
   * ⛔ `paused` ET PAS UN NOUVEAU STATUT : la contrainte de 0018 fixe les six valeurs possibles, et
   * je ne peux pas appliquer de migration sur cette base. `paused` a exactement le bon sens — la
   * campagne ne partira pas tant qu'un humain n'aura pas tranché — il sort du scan de
   * `listDueCampaigns` (qui ne lit que `scheduled`), et `/schedule` sait la replanifier ensuite.
   *
   * ⛔ L'AUDIT EST ÉCRIT AVANT LA PAUSE. `campaign` n'a pas de colonne `hold_reason` (l'occurrence,
   * si) : la raison n'a qu'un seul endroit où vivre, `audit_log`. L'écrire après la pause exposerait
   * à une campagne arrêtée sans raison lisible — précisément le blocage muet qu'on corrige. Et un
   * audit qui échoue ne doit PAS empêcher la pause : une campagne qui reste `scheduled` est pire
   * qu'une campagne en pause dont la raison n'est que dans les journaux du worker.
   *
   * ⚠️ Écriture CONDITIONNELLE : si quelqu'un a changé le statut entre le scan et ici, on ne lui
   * passe pas dessus.
   *
   * ⛔ ET LA CONDITION PORTE SUR DEUX STATUTS, PAS UN (18/09/2026). Elle ne testait que
   * `scheduled` — or les refus décidés APRÈS `claim()` (audience vide, plafond d'audience) arrivent
   * sur une campagne que le fan-out vient lui-même de passer en `sending` : l'update ne trouvait
   * aucune ligne, l'audit s'écrivait, et la campagne restait `sending` avec une file vide. Personne
   * ne peut poser `sending` à la main — seul `claim()` le fait — donc accepter les deux ne passe sur
   * le geste de personne, et ferme le seul cas où la pause manquait.
   */
  async holdCampaign(target: FanoutTarget, reason: string): Promise<void> {
    const { error: auditError } = await this.sb.from("audit_log").insert({
      actor: "worker:fanout",
      action: "campaign-held",
      target_type: "campaign",
      target_id: target.campaignId,
      asset_id: target.assetId,
      meta: { reason, scheduled_at: target.scheduledAt, campaign_name: target.campaignName },
    });
    // Journalisé et pas jeté : voir le commentaire ci-dessus. `log` n'est pas importé ici (ce
    // fichier ne journalise rien d'autre) — l'appelant relaiera, la pause, elle, doit avoir lieu.
    if (auditError) console.error(JSON.stringify({ event: "hold-campaign-audit-failed", message: auditError.message }));

    const { error } = await this.sb
      .from("campaign")
      .update({ status: "paused", updated_at: new Date().toISOString() })
      .eq("id", target.campaignId)
      .in("status", ["scheduled", "sending"]);
    if (error) throw new Error(`holdCampaign: ${error.message}`);
  }

  /**
   * ⭐ UNE ERREUR DE FAN-OUT LAISSE UNE TRACE EN BASE — sans changer le statut.
   *
   * ⛔ LE DÉFAUT QU'ELLE FERME (18/09/2026). Une exception pendant `pageAudience` ou `enqueueBatch`
   * fait `releaseClaim` : la campagne repasse `scheduled` et sera reprise à la passe suivante. C'est
   * le bon comportement — une panne réseau ne doit pas mettre un envoi en pause définitive. Mais
   * c'était aussi une trace NULLE PART : la campagne rebondissait entre `scheduled` et `sending`
   * indéfiniment, l'admin affichait « Scheduled », et la seule trace vivait dans les journaux d'un
   * service que personne ne regarde.
   *
   * ⛔ ELLE N'ÉCRIT QUE L'AUDIT, JAMAIS LE STATUT. Mettre la campagne en pause sur une erreur
   * transitoire transformerait une coupure réseau de trois secondes en envoi annulé.
   *
   * ⚠️ Ne jette pas : on est déjà dans un `catch`. Un audit raté ne doit pas masquer l'erreur
   * d'origine, qui est la seule intéressante.
   */
  async auditFanoutError(target: FanoutTarget, message: string): Promise<void> {
    const { error } = await this.sb.from("audit_log").insert({
      actor: "worker:fanout",
      action: "campaign-fanout-error",
      target_type: "campaign",
      target_id: target.campaignId,
      asset_id: target.assetId,
      meta: {
        reason: message.slice(0, 500),
        scheduled_at: target.scheduledAt,
        campaign_name: target.campaignName,
        occurrence_id: target.occurrenceId,
      },
    });
    if (error) console.error(JSON.stringify({ event: "fanout-error-audit-failed", message: error.message }));
  }

  /**
   * ⚠️ LA COLONNE S'APPELLE `rule_json`, PAS `rule`. Écrite `rule`, la requête ne renvoie pas une
   * règle vide : elle ÉCHOUE (42703), donc le fan-out aurait retenu chaque cible avec un message
   * incompréhensible. C'est le banc qui l'a montré, pas le typecheck — supabase-js n'est pas typé
   * sur ce schéma, aucun compilateur ne relit ces chaînes.
   */
  async getSegmentRule(segmentId: string, assetId: string): Promise<SegmentRule | null> {
    const { data, error } = await this.sb
      .from("segment")
      .select("id, rule_json")
      .eq("id", segmentId)
      .eq("asset_id", assetId)
      .maybeSingle();
    if (error) throw new Error(`getSegmentRule: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as { id: string; rule_json: unknown };
    return { id: row.id, rule: row.rule_json };
  }

  /**
   * Les tables de correspondance ET les trois listes blanches de provenance de la marque — tout ce
   * dont `compileRule` a besoin, lu d'un seul geste.
   *
   * ⛔ LE REFLET EXACT DE `ruleContextForAsset` (apps/admin/src/lib/data/campaigns.ts), qui fait
   * autorité : c'est elle qui compte l'audience affichée avant de planifier. Même lecture, même
   * portée, mêmes inclusions — sinon le nombre annoncé et le nombre envoyé divergent sur la même
   * grandeur, sans une seule erreur. Concrètement :
   *  - tout est SCOPÉ MARQUE : `tag` et `optin` sont uniques par `(asset_id, slug)`. Une table non
   *    scopée compilerait la règle sur l'identifiant d'une AUTRE marque — un identifiant faux reste
   *    un identifiant, rien n'apparaîtrait dans `unsupported`, et `none_of` matcherait tout le monde ;
   *  - un intérêt est un tag de `kind = 'interest'`, jamais un LIKE sur le slug : un tag manuel nommé
   *    « interest:… » se ferait passer pour une donnée du pont ;
   *  - les ARCHIVÉS sont inclus : un formulaire retiré du site et une campagne d'acquisition terminée
   *    gardent leurs contacts, et un segment qui les cite doit rester envoyable ;
   *  - les créatives (`capture_optin_ids`) SONT les optins : même table, autre clé.
   *
   * ⛔ LES LISTES (trois de provenance + les automations, 24/09) ARRIVENT ENSEMBLE OU AUCUNE. N'en fournir qu'une partie ferait compiler un OU
   * amputé : sa seule branche résolue passe, `widened` reste faux, et l'envoi RÉTRÉCIT en silence.
   *
   * ⚠️ UNE LECTURE RATÉE LÈVE, ELLE NE REND PAS UNE LISTE ABSENTE. Côté admin, `undefined` fait
   * dénoncer le prédicat et refuser le compte, ce qui suffit. Ici, le même repli mettrait la campagne
   * en PAUSE — une panne réseau passagère exigerait un geste humain. Lever range l'erreur dans
   * `report.errors`, laisse la cible `scheduled`, et la passe suivante réessaie. Aucun des deux
   * chemins ne produit de filtre.
   */
  async ruleContext(assetId: string): Promise<RuleContext> {
    const [tagRes, optinRes, campRes, autoRes] = await Promise.all([
      this.sb.from("tag").select("id, slug, kind").eq("asset_id", assetId),
      this.sb.from("optin").select("id, slug").eq("asset_id", assetId),
      this.sb.from("capture_campaign").select("id").eq("asset_id", assetId),
      // TOUS statuts, comme `ruleContextForAsset` : une automation repassée en brouillon a envoyé.
      this.sb.from("automation").select("id").eq("asset_id", assetId),
    ]);
    if (tagRes.error) throw new Error(`ruleContext(tag): ${tagRes.error.message}`);
    if (optinRes.error) throw new Error(`ruleContext(optin): ${optinRes.error.message}`);
    if (campRes.error) throw new Error(`ruleContext(capture_campaign): ${campRes.error.message}`);
    if (autoRes.error) throw new Error(`ruleContext(automation): ${autoRes.error.message}`);

    const tagIdBySlug: Record<string, number> = {};
    const interestIds: number[] = [];
    for (const raw of ((tagRes.data as unknown[]) ?? [])) {
      const t = raw as { id: number; slug: string; kind: string | null };
      tagIdBySlug[t.slug] = t.id;
      if (t.kind === "interest") interestIds.push(t.id);
    }

    const optinIdBySlug: Record<string, string> = {};
    const captureOptinIds: string[] = [];
    for (const raw of ((optinRes.data as unknown[]) ?? [])) {
      const o = raw as { id: string; slug: string };
      optinIdBySlug[o.slug] = o.id;
      captureOptinIds.push(o.id);
    }

    const captureCampaignIds = ((campRes.data as unknown[]) ?? []).map((raw) => String((raw as { id: string }).id));
    const automationIds = ((autoRes.data as unknown[]) ?? []).map((raw) => String((raw as { id: string }).id));

    return { tagIdBySlug, optinIdBySlug, interestIds, captureOptinIds, captureCampaignIds, automationIds };
  }

  /** Les éditions dont le régime autorise l'opt-out — le gate de finalité y est plus permissif. */
  async optOutEditionIds(assetId: string, isOptOut: (regime: string) => boolean): Promise<string[]> {
    const { data, error } = await this.sb
      .from("asset_edition")
      .select("id, compliance_regime")
      .eq("asset_id", assetId);
    if (error) throw new Error(`optOutEditionIds: ${error.message}`);
    return ((data as unknown[]) ?? [])
      .map((raw) => raw as { id?: unknown; compliance_regime?: unknown })
      .filter((e) => isOptOut(String(e.compliance_regime ?? "")))
      .map((e) => String(e.id ?? ""))
      .filter(Boolean);
  }

  /**
   * Une PAGE d'audience, triée par identifiant et bornée par le dernier vu.
   *
   * ⛔ PAGINATION PAR CURSEUR ET NON PAR `range`. Un `offset` se décale dès qu'une souscription
   * change d'état pendant la passe (désinscription, suppression) : la ligne suivante glisse d'un
   * cran et se fait sauter — un abonné manquant, aucune erreur. Le curseur sur une colonne stable
   * ne peut pas sauter de ligne.
   */
  async pageAudience(p: {
    assetId: string;
    /** La vue vient de la RÈGLE (`AUDIENCE_VIEW`), exactement comme au compte de l'admin. */
    population: Population;
    segmentExpr: string | null;
    gateExpr: string | null;
    afterId: string | null;
    limit: number;
  }): Promise<string[]> {
    let q = this.sb.from(AUDIENCE_VIEW[p.population]).select("id").eq("asset_id", p.assetId);
    if (p.segmentExpr) q = q.or(p.segmentExpr);
    if (p.gateExpr) q = q.or(p.gateExpr);
    if (p.afterId) q = q.gt("id", p.afterId);
    const { data, error } = await q.order("id", { ascending: true }).limit(p.limit);
    if (error) throw new Error(`pageAudience: ${error.message}`);
    return ((data as unknown[]) ?? []).map((r) => String((r as { id: string }).id));
  }

  /**
   * Écrit un lot dans la file. Idempotente côté SQL (0038) : un rejeu n'ajoute rien.
   *
   * ⛔ Les contacts passent par LEUR fonction (0088), qui revalide contre `contact_subscription` et
   * marque le payload `audience: contacts` — la seule clé qui fasse accepter le statut `contact` à la
   * porte d'envoi. Un identifiant de contact remis à 0038 serait écarté par sa jointure, et
   * inversement : se tromper de fonction n'envoie rien à personne, ça ne franchit aucune barrière.
   */
  async enqueueBatch(
    campaignId: string,
    occurrenceId: string | null,
    subscriptionIds: string[],
    /** Sans défaut, exprès : un appelant qui l'oublierait ne compile pas. */
    population: Population,
  ): Promise<number> {
    const fonction = population === "contacts" ? "enqueue_campaign_batch_contacts" : "enqueue_campaign_batch";
    const { data, error } = await this.sb.rpc(fonction, {
      p_campaign_id: campaignId,
      p_occurrence_id: occurrenceId,
      p_subscription_ids: subscriptionIds,
    });
    if (error) throw new Error(`enqueueBatch: ${error.message}`);
    return Number(data ?? 0);
  }

  /** Combien de lignes de file portent déjà cette cible — la mesure qui fait foi, relue en base. */
  async countQueued(campaignId: string, occurrenceId: string | null): Promise<number> {
    let q = this.sb.from("email_outbox").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
    q = occurrenceId ? q.eq("occurrence_id", occurrenceId) : q.is("occurrence_id", null);
    const { count, error } = await q;
    if (error) throw new Error(`countQueued: ${error.message}`);
    return count ?? 0;
  }

  /** Consigne le résultat : quand la file a été remplie, et avec combien de lignes. */
  async markEnqueued(target: FanoutTarget, queued: number, at: Date): Promise<void> {
    if (target.occurrenceId) {
      const { error } = await this.sb
        .from("campaign_occurrence")
        .update({ enqueued_at: at.toISOString(), recipients_planned: queued, updated_at: at.toISOString() })
        .eq("id", target.occurrenceId);
      if (error) throw new Error(`markEnqueued occurrence: ${error.message}`);
      return;
    }
    const { error } = await this.sb
      .from("campaign")
      .update({ enqueued_at: at.toISOString(), recipients_planned: queued })
      .eq("id", target.campaignId);
    if (error) throw new Error(`markEnqueued campaign: ${error.message}`);
  }
}
