/**
 * ---------------------------------------------------------------------------
 * S-4 — Le matérialiseur : deux passes, aucun envoi.
 * ---------------------------------------------------------------------------
 *
 * `materialize` transforme une CADENCE (« lundi et vendredi à 10:00 ») en OCCURRENCES datées ;
 * `freeze` fige le contenu de celles qui approchent. Ni l'une ni l'autre n'écrit dans
 * `email_outbox` — ce fichier n'importe même pas la notion de destinataire. La preuve tient dans
 * une requête : `select count(*) from email_outbox where occurrence_id is not null` doit rester à
 * 0 après n'importe quel nombre de passes.
 *
 * ⛔ POURQUOI LE CALENDRIER N'EST PAS CALCULÉ ICI. Les dates viennent de la fonction SQL
 * `campaign_occurrences` (migration 0025), la même que l'aperçu du wizard. Recalculer en
 * TypeScript donnerait le bon résultat onze mois sur douze et le mauvais les jours de changement
 * d'heure, parce que Node et Postgres n'embarquent pas la même tzdata. Une divergence là-dessus
 * ne se découvre pas en test : elle se découvre parce qu'un abonné signale un email arrivé une
 * heure trop tôt.
 *
 * ⛔ POURQUOI ON NE RECRÉE JAMAIS UN JOUR DÉJÀ CONNU, MÊME ANNULÉ. La clé
 * `(campaign_id, local_date) where status <> 'cancelled'` autorise volontairement un opérateur à
 * re-planifier à la main un vendredi qu'il avait annulé. Mais un matérialiseur qui balaie toutes
 * les cinq minutes ressusciterait cette occurrence dans la minute qui suit l'annulation. Le
 * matérialiseur regarde donc TOUS les jours déjà connus, annulés compris, et se tait.
 */
import { generateIntroColumns, type AiColumns } from "@nf/ai";
import { worstFreshness } from "@nf/config";
import {
  contexteGele,
  finaliserEdition,
  lireBase,
  textesIa,
  validerOverrides,
  type EditionBase,
} from "@nf/edition";
import { articlesOf } from "@nf/render/articles";
import { feedBlocksOf, type FeedResolution } from "@nf/render/feed";
import { usesAiTokens } from "@nf/render/hydrate";
import type { EmailDoc } from "@nf/render";
// ⚠️ Import de TYPE seulement : il est effacé à la compilation, l'invariant « le chemin d'envoi ne
// voit jamais MJML » reste porté par les imports DYNAMIQUES de `@nf/render/compile` plus bas.
import type { BrandPartials } from "@nf/render/compile";
import type { ComputedOccurrence, PlanRow, PlannerDb } from "./planner-db";
import { idsALire, pointeursDuDoc, raisonPartialsManquants, resoudrePartials } from "./brand-partials";
import { resolveFeedsOfDoc, type SentArticle, type StaleFeed } from "./feed-resolve";
import { log } from "./log";

/*
 * ⚠️ L'empreinte, l'article de tête, le nombre d'articles et le jeton de sujet vivent désormais dans
 * `@nf/edition` : la recompilation après relecture et l'aperçu de l'admin doivent les calculer
 * exactement comme le gel. Ré-exportés ici pour les appelants et les bancs qui les lisaient ici.
 */
export { FIRST_ARTICLE_TOKEN, contentFingerprint, countArticles, firstArticleTitle } from "@nf/edition";

/** Combien de jours d'avance on matérialise. 21 = trois semaines : assez pour que la collègue voie
 *  sa série se remplir, trop court pour qu'un changement de cadence laisse une longue traîne. */
export const HORIZON_DAYS = 21;
/** Garde-fou par campagne et par passe : une cadence quotidienne sur 21 jours en produit 21. */
const MAX_PER_CAMPAIGN = 60;

export interface PlannerReport {
  plansScanned: number;
  occurrencesCreated: number;
  occurrencesSkippedExisting: number;
  frozen: number;
  held: number;
  errors: string[];
  /**
   * Les doublons retenus (S-5), pour que l'appelant ALERTE. Un blocage qui ne se voit que dans un
   * journal est un blocage que personne ne lève : la série s'arrête en silence et la collègue
   * découvre le lundi que rien n'est parti vendredi.
   */
  duplicatesHeld: { occurrenceId: string; campaignName: string; previous: string }[];
  /**
   * ⛔ L'INVARIANT DU LOT, RELU EN BASE après la passe : combien de lignes d'`email_outbox`
   * portent une occurrence. Écrire « le matérialiseur n'envoie pas » ne prouve rien ; ce nombre,
   * si. Tant que S-6 n'existe pas, il vaut 0 — et s'il ne vaut pas 0, la passe le DIT.
   */
  outboxRowsWithOccurrence: number;
  /**
   * ⛔ LES ÉDITIONS QUE PLUS RIEN NE FERA PARTIR : encore `planned` alors que leur heure est
   * passée. Le gel les exclut exprès (on n'envoie pas en retard), mais l'exclusion ne se voyait
   * NULLE PART : ni erreur, ni `held`, ni raison, ni compteur. Un cron `plan` qui s'arrête une
   * nuit laisse derrière lui exactement ces cadavres, et rien ne le dit. Ce nombre le dit.
   */
  occurrencesMissed: number;
  /**
   * Éditions GELÉES reconstruites après une relecture (0079). Une relecture non appliquée n'est pas
   * comptée ici : elle part dans `errors`, avec sa raison, et le fan-out refuse l'édition en attendant.
   */
  refrozen: number;
  /**
   * Éditions laissées `planned` sur une PANNE (site muet, lecture de notre base en échec) : la passe
   * suivante réessaie. Voir `reessayable`. Une panne à la dernière passe utile est comptée dans `held`.
   */
  retrying: number;
}

/**
 * ⛔ LA DERNIÈRE PASSE UTILE. Le cron `plan` tourne toutes les 10 minutes (`docs/WORKER.md`) : une
 * édition dont l'envoi est à plus de 15 minutes verra au moins une autre passe AVANT son heure. En
 * deçà, plus rien ne garantit qu'une passe la reprenne à temps — on retient, avec la raison, plutôt
 * que de la laisser devenir une édition « manquée » sans explication.
 */
export const DERNIERE_CHANCE_MS = 15 * 60_000;

/**
 * Une PANNE se réessaie-t-elle à la passe suivante ? Oui tant qu'une passe peut encore geler avant
 * l'heure d'envoi. Sans heure lisible, non : on ne peut pas savoir s'il reste une passe.
 *
 * ⛔ POURQUOI. Le 25/09/2026, une édition Northwind Sports a été retenue parce que le site avait mis plus de 10 s
 * à répondre, UNE fois, 90 minutes avant l'envoi — et `held` n'est jamais repris (le gel ne relit que
 * `planned`). Les commentaires de ce fichier promettaient depuis le début « la passe suivante
 * réessaiera » ; le code retenait pour de bon. Une panne passagère ne doit pas coûter une édition.
 */
export function reessayable(scheduledAt: string | null | undefined, now: Date): boolean {
  if (!scheduledAt) return false;
  const t = Date.parse(scheduledAt);
  return Number.isFinite(t) && t - now.getTime() > DERNIERE_CHANCE_MS;
}

export interface PlannerOptions {
  horizonDays?: number;
  /** `true` = tout calculer et tout journaliser SANS écrire une ligne. Sert à la mise en service. */
  simulate?: boolean;
  /** Injectable pour les tests ; jamais renseigné en production. */
  now?: Date;
  /**
   * La résolution des flux, injectable — ⛔ POUR LES BANCS, jamais renseignée en production, même
   * motif que `now` juste au-dessus.
   *
   * ⛔ POURQUOI CETTE PORTE EXISTE, ET C'EST MESURÉ. Sans elle, AUCUN test ne peut atteindre la
   * recompilation : `resolveFeedsOfDoc` appelle WordPress pour de vrai, et la doubler par
   * `mock.module("@nf/wp", …)` empoisonne la suite ENTIÈRE — 10 tests de `packages/wp` tombent, et
   * ni `afterAll` ni un re-mock ne restaurent le module. Conséquence de cette impasse : la ligne qui
   * passe l'en-tête de marque au compilateur n'était exercée par rien, et un `throw` inconditionnel
   * posé dessus laissait `bun test` à 981 pass / 0 fail.
   */
  resoudreFlux?: typeof resolveFeedsOfDoc;
}

/** Postgres : violation d'unicité. Deux workers qui matérialisent la même série se croisent — ce
 *  n'est pas une erreur, c'est la garde de la base qui fait exactement son travail. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * Numéro de la prochaine occurrence d'une série — ce que l'e-mail affiche en `{{edition_number}}`.
 *
 * Le départ (`campaign.edition_start`, 0067) sert de PLANCHER, jamais de remise à zéro : une série
 * qui a déjà numéroté jusqu'à 45 continue à 46 même si quelqu'un abaisse le départ, et un départ
 * relevé à 140 fait sauter directement à 140. Un numéro ne recule jamais, un numéro déjà attribué
 * ne change jamais.
 *
 * Un départ absent ou invalide vaut 1 : lire une base d'avant 0067 ne doit pas planter la passe.
 */
export function prochainNumero(existants: readonly { seq: number }[], depart: number | null | undefined): number {
  const plancher = typeof depart === "number" && Number.isInteger(depart) && depart >= 1 ? depart - 1 : 0;
  return existants.reduce((m, o) => Math.max(m, o.seq), plancher) + 1;
}

/** Les `fetchedAt` de tous les blocs sourcés d'un document, pour la mesure de fraîcheur. */
export function fetchedAtsOf(doc: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const o = node as Record<string, unknown>;
    const src = o.source as Record<string, unknown> | undefined;
    if (src && typeof src.fetchedAt === "string") out.push(src.fetchedAt);
    for (const v of Object.values(o)) visit(v);
  };
  visit(doc);
  return out;
}

// ---------------------------------------------------------------------------
// Passe 1 — matérialiser
// ---------------------------------------------------------------------------

async function materializeOne(
  db: PlannerDb,
  plan: PlanRow,
  now: Date,
  horizonDays: number,
  simulate: boolean,
  report: PlannerReport,
): Promise<void> {
  if (!plan.recurrence_days?.length || !plan.recurrence_time || !plan.timezone || !plan.recurrence_anchor) {
    // La contrainte `campaign_active_needs_recurrence` (0027) rend ce cas impossible en base ; on
    // le traite quand même, parce qu'un matérialiseur qui plante sur une ligne bloque les autres.
    report.errors.push(`${plan.id}: armée mais cadence incomplète`);
    return;
  }

  const from = now.toISOString();
  const horizonEnd = new Date(now.getTime() + horizonDays * 24 * 3_600_000);
  // Une fin de série borne la fenêtre. `+1 jour` pour couvrir le dernier jour en entier quel que
  // soit le fuseau : s'arrêter à minuit UTC couperait la dernière occurrence en Amérique.
  const until = plan.recurrence_until
    ? new Date(new Date(`${plan.recurrence_until}T00:00:00Z`).getTime() + 24 * 3_600_000)
    : null;
  const to = until && until < horizonEnd ? until : horizonEnd;
  if (to <= now) return; // série terminée : rien à matérialiser, et ce n'est pas une erreur.

  const computed = await db.computeOccurrences({
    days: plan.recurrence_days,
    time: plan.recurrence_time,
    timezone: plan.timezone,
    everyWeeks: plan.recurrence_every_weeks ?? 1,
    anchor: plan.recurrence_anchor,
    from,
    to: to.toISOString(),
    limit: MAX_PER_CAMPAIGN,
  });

  const existing = await db.listOccurrences(plan.id);
  // ⛔ TOUS les jours connus, annulés compris. Voir l'en-tête du fichier.
  const known = new Set(existing.map((o) => o.local_date).filter((d): d is string => d !== null));
  let nextSeq = prochainNumero(existing, plan.edition_start);

  for (const occ of computed) {
    if (known.has(occ.local_date)) {
      report.occurrencesSkippedExisting++;
      continue;
    }
    if (simulate) {
      log("planner", { plan: plan.id, would_create: occ.local_date, at: occ.local_text });
      report.occurrencesCreated++;
      known.add(occ.local_date);
      continue;
    }
    try {
      await db.insertOccurrence({
        campaign_id: plan.id,
        asset_id: plan.asset_id,
        seq: nextSeq,
        local_date: occ.local_date,
        scheduled_at: occ.fires_at,
        status: "planned",
        subject: plan.subject ?? "",
        preheader: plan.preheader,
        template_version_id: plan.template_version_id,
        segment_id: plan.segment_id,
      });
      report.occurrencesCreated++;
      known.add(occ.local_date);
      nextSeq++;
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Un autre worker a créé la même occurrence entre notre lecture et notre écriture. La base
        // a tranché ; on relit le numéro de séquence et on continue.
        report.occurrencesSkippedExisting++;
        known.add(occ.local_date);
        const relu = await db.listOccurrences(plan.id);
        nextSeq = prochainNumero(relu, plan.edition_start);
        continue;
      }
      report.errors.push(`${plan.id} ${occ.local_date}: ${(e as Error).message}`);
      return; // une campagne qui échoue ne doit pas empêcher les suivantes d'être traitées.
    }
  }
}

// ---------------------------------------------------------------------------
// Passe 2 — geler
// ---------------------------------------------------------------------------

/**
 * Fige le contenu des occurrences dont l'heure de gel est atteinte.
 *
 * Le contenu est COPIÉ depuis la version publiée du plan, comme le fait `/lock` pour une campagne
 * ponctuelle. Copier et non référencer : republier le modèle après le gel ne doit pas changer ce
 * qui part, sinon une correction de dernière minute réécrirait rétroactivement un email déjà
 * distribué.
 *
 * ⚠️ C'est ici que la barrière de fraîcheur (WP-3) trouve enfin son point d'accroche : elle
 * mesure l'âge des articles À L'INSTANT D'ENVOI de CETTE occurrence, et retient — bruyamment —
 * plutôt que d'expédier la newsletter de la semaine dernière.
 */
async function freezeDue(
  db: PlannerDb,
  now: Date,
  simulate: boolean,
  report: PlannerReport,
  resoudreFlux: typeof resolveFeedsOfDoc = resolveFeedsOfDoc,
): Promise<void> {
  const due = await db.listOccurrencesToFreeze(now.toISOString());

  for (const row of due) {
    const retenir = async (raison: string, duplicateOf?: string) => {
      report.held++;
      log("planner", { occurrence: row.id, decision: "held", reason: raison, duplicate_of: duplicateOf });
      if (!simulate) await db.holdOccurrence(row.id, raison, duplicateOf);
    };
    /**
     * Une PANNE, pas un verdict : l'édition reste `planned` et la passe suivante réessaie, tant qu'il
     * en reste une avant l'envoi (`reessayable`). À la dernière passe utile, on retient avec la raison.
     */
    const panne = async (raison: string) => {
      if (reessayable(row.scheduled_at, now)) {
        report.retrying++;
        log("planner", { occurrence: row.id, decision: "retry_next_pass", reason: raison });
        return;
      }
      await retenir(`${raison} — still failing on the last pass before the send time`);
    };

    if (!row.template_version_id) {
      await retenir("no template version selected on the campaign");
      continue;
    }
    const version = await db.loadPublishedVersion(row.template_version_id, row.asset_id);
    if (!version) {
      await retenir("the selected template version is no longer a published version of this brand");
      continue;
    }
    if (!version.html_shell) {
      await retenir(
        "the published version has no compiled HTML — republish the template, then open the campaign and save it so its next editions use the new version",
      );
      continue;
    }

    // Fraîcheur mesurée jusqu'à l'INSTANT D'ENVOI de cette occurrence, jamais jusqu'à maintenant :
    // un contenu récolté lundi et envoyé vendredi a six jours au moment où l'abonné le lit.
    const fetchedAts = fetchedAtsOf(version.doc);
    if (fetchedAts.length > 0) {
      const verdict = worstFreshness(fetchedAts, row.scheduled_at ?? undefined);
      if (verdict.blocking) {
        // ⛔ On REPREND la phrase du verdict au lieu d'en écrire une : le seuil n'a qu'une seule
        // définition (`@nf/config`), et l'écran et le journal disent donc exactement la même chose.
        await retenir(
          `${verdict.message} — republish the template with fresh articles, then open the campaign and save it so its next editions use the new version`,
        );
        continue;
      }
    }

    /*
     * LES FLUX D'ARTICLES — le contenu du soir se fabrique ICI.
     *
     * ⛔ AUCUN ÉCHEC N'EST UN REPLI. Le modèle publié porte un APERÇU des articles, figé le jour où
     * l'auteur a réglé le bloc. Retomber dessus enverrait la newsletter de ce jour-là en ayant l'air
     * de fonctionner — le défaut exact que le bloc flux existe pour tuer.
     * Une catégorie sous son plancher, une source disparue : c'est un VERDICT, on retient avec la
     * raison. Une source injoignable (ou notre base) : c'est une PANNE, l'édition reste `planned` et
     * la passe suivante réessaie, jusqu'à la dernière passe utile (`panne`, `reessayable`).
     */
    let feedResolutions: Record<string, FeedResolution> = {};
    let feedSent: SentArticle[] = [];
    /** Les blocs « les derniers » dont le plus récent a plus de 24 h — journalisés, jamais retenus. */
    let feedStale: StaleFeed[] = [];
    /** Les rows d'en-tête et de pied de marque, résolues pour la recompilation (voir plus bas). */
    let partialsDeMarque: BrandPartials | undefined;
    const hasFeeds = feedBlocksOf(version.doc as EmailDoc).length > 0;
    if (hasFeeds) {
      /*
       * ⛔ L'EN-TÊTE DE MARQUE SE RÉSOUT ICI, ET C'EST LE SEUL ENDROIT DU WORKER QUI EN A BESOIN.
       * Partout ailleurs le shell figé à la publication porte déjà l'en-tête, et le worker n'a rien
       * à savoir. Mais une édition à flux est RECOMPILÉE plus bas, avec les articles du jour — et
       * une recompilation sans partials produit un e-mail SANS en-tête, sans erreur, pour
       * précisément les newsletters qui partent chaque semaine.
       *
       * ⛔ UN POINTEUR NON RÉSOLU RETIENT L'ÉDITION. Compiler sans l'en-tête serait le pire des deux
       * mondes : l'e-mail part, il est nu, et rien ne le signale. Une édition retenue se voit, et la
       * réparation sert l'édition suivante — une édition retenue n'est pas reprise.
       *
       * ⚠️ ET ON LE FAIT AVANT DE RÉSOUDRE LES FLUX, délibérément : la résolution des flux est un
       * aller-retour WordPress qui choisit les articles du jour. Les dépenser pour une édition
       * qu'on va retenir trois lignes plus loin n'a aucun sens.
       */
      const pointeurs = pointeursDuDoc(version.doc);
      /*
       * ⛔ C'EST LE DOCUMENT QUI DÉCIDE D'ENTRER ICI, PAS LE RÉSULTAT DU FILTRE. Un modèle dont
       * l'unique pointeur est mal formé n'a rien à lire en base, mais il a bel et bien une fente à
       * honorer : brancher cette condition sur les ids lisibles le ferait sortir sans garde et
       * compiler l'e-mail SANS en-tête — exactement le défaut qu'on ferme ici.
       */
      if (pointeurs.header !== undefined || pointeurs.footer !== undefined) {
        const aLire = idsALire(pointeurs);
        let lignes: Awaited<ReturnType<typeof db.brandPartialsOf>> = [];
        try {
          // Aucun id lisible ⇒ aucune lecture : PostgREST refuserait le filtre en 400, et la
          // résolution ci-dessous marquera la fente manquante de toute façon.
          if (aLire.length > 0) lignes = await db.brandPartialsOf(row.asset_id, aLire);
        } catch (e) {
          // ⛔ Une lecture en panne n'est pas « ce modèle n'a pas d'en-tête » : c'est une PANNE, la
          // passe suivante réessaie — même doctrine que la résolution des flux ci-dessous.
          await panne(`the brand header or footer of this edition could not be read — ${(e as Error).message}`);
          continue;
        }
        const resolu = resoudrePartials(pointeurs, lignes);
        if (resolu.manquants.length > 0) {
          await retenir(raisonPartialsManquants(resolu.manquants));
          continue;
        }
        partialsDeMarque = { header: resolu.header, footer: resolu.footer };
      }

      const outcome = await resoudreFlux(db, version.doc as EmailDoc, {
        campaignId: row.campaign_id,
        assetId: row.asset_id,
        occurrenceId: row.id,
        now,
        /**
         * ⛔ PARESSEUSE, ET C'EST VOULU. Seuls les blocs réglés sur « suivre la cadence » en ont
         * besoin ; la calculer d'avance ferait un aller-retour de plus à CHAQUE gel, y compris
         * pour les documents sans aucun flux classé par vues.
         */
        cadenceJours: () => db.cadenceJours(row),
        /**
         * ⛔ `=== true` et pas une conversion souple : la colonne est `not null default false`,
         * mais la jointure PostgREST rend `null` quand la campagne a disparu entre le plan et le
         * gel. « Campagne absente » ne doit pas se lire « mélange demandé ».
         */
        mixLatest: row.campaign?.mix_latest === true,
      });
      if (!outcome.ok) {
        await (outcome.retry ? panne(outcome.reason) : retenir(outcome.reason));
        continue;
      }
      feedResolutions = outcome.resolutions;
      feedSent = outcome.sent;
      feedStale = outcome.stale ?? [];
    }

    /*
     * ⚠️ ON RECOMPILE, ET C'EST LE PRIX DU CONTENU DU JOUR. `version.html_shell` a été compilé à la
     * publication, donc avec l'aperçu : il ne peut pas servir. La compilation n'est chargée qu'ICI,
     * par un import dynamique — le chemin d'ENVOI, lui, garde son invariant : il n'exécute que
     * `hydrate()` et ne voit jamais MJML.
     */
    let htmlShell = version.html_shell;
    let textShell = version.text_shell;
    let compiledBytes: number | null = null;
    // Le document QUI PART. Sans flux c'est le modèle tel quel ; avec, c'est lui déplié — et c'est
    // de CELUI-LÀ que le sujet doit tirer `{{first_article}}`, sans quoi il chercherait un titre
    // dans un bloc flux qui n'en contient pas encore.
    let shippedDoc = version.doc as EmailDoc;
    if (hasFeeds) {
      try {
        const { expandFeedBlocks } = await import("@nf/render/feed");
        const { compileDoc } = await import("@nf/render/compile");
        const { doc: expanded, report } = expandFeedBlocks(version.doc as EmailDoc, feedResolutions);
        shippedDoc = expanded;
        const built = await compileDoc(expanded, partialsDeMarque);
        htmlShell = built.html;
        textShell = built.text;
        compiledBytes = built.sizeBytes;
        /*
         * ⛔ LES AVERTISSEMENTS DE LA COMPILATION SONT JOURNALISÉS, PLUS JETÉS. On ne lisait que
         * `html`, `text` et `sizeBytes` : `built.warnings` tombait par terre. Or c'est exactement là
         * qu'`applyBrandPartials` écrit « cet e-mail désigne un en-tête que le compilateur n'a pas
         * reçu » et « cet en-tête est DÉJÀ dans le document, l'appliquer l'afficherait deux fois ».
         * Un câblage raté sur la ligne au-dessus n'avait donc AUCUNE trace nulle part.
         *
         * Journaliser, pas retenir : la garde posée plus haut refuse déjà tout pointeur non résolu,
         * et retenir une édition sur un avertissement de mise en page arrêterait une newsletter que
         * personne n'a demandé d'arrêter.
         */
        log("planner", {
          occurrence: row.id,
          decision: "feeds_resolved",
          feeds: report.feeds,
          articles: report.articles,
          bytes: built.sizeBytes,
          ...(built.warnings.length > 0 ? { warnings: built.warnings } : {}),
          /*
           * ⛔ UN BLOC « LES DERNIERS » QUI SERT DES ARTICLES DE PLUS DE 24 H SE JOURNALISE. Le 25/09,
           * deux éditions Northwind Sports ont envoyé les 7 mêmes articles à trois heures d'écart : le filtre de
           * catégories ne ramenait plus rien de neuf, et rien nulle part ne le disait. Journaliser,
           * PAS retenir (décision d'Alix) : ce qui part ne change pas d'un octet.
           */
          ...(feedStale.length > 0 ? { stale_feeds: feedStale } : {}),
        });
      } catch (e) {
        await retenir(`this edition could not be built with today's articles — ${(e as Error).message}`);
        continue;
      }
    }

    /*
     * ⭐ LA BASE DE RELECTURE (0079) — ce que le gel a produit AVANT toute relecture humaine.
     *
     * Elle est ÉCRITE sur l'occurrence (`review_base`) pour qu'une relecture puisse reconstruire
     * l'édition SANS rien redemander : ni à WordPress (il rendrait d'autres articles), ni aux rows
     * d'en-tête (elles ont pu changer depuis), ni au modèle (il a pu être republié). L'aperçu de
     * l'admin part de ce même objet — c'est ce qui l'empêche de montrer un autre e-mail que celui-ci.
     *
     * ⚠️ `html_shell` est le shell AVANT preheader et balisage UTM : la fin du gel (ci-dessous) les pose,
     * et elle doit pouvoir les reposer à l'identique après une relecture du sujet ou du preheader.
     */
    const pointeurs = pointeursDuDoc(version.doc);
    const base: EditionBase = {
      version: 1,
      doc: shippedDoc,
      partials: partialsDeMarque ? { ...partialsDeMarque } : null,
      pointeAuxPartials: pointeurs.header !== undefined || pointeurs.footer !== undefined,
      html_shell: htmlShell,
      text_shell: textShell,
      size_bytes: compiledBytes ?? version.size_bytes ?? null,
      subject: row.subject?.trim() ? row.subject : (version.subject ?? ""),
      preheader: row.preheader?.trim() ? row.preheader : version.preheader,
      campaign_name: row.campaign?.name ?? "",
      segment_id: row.segment_id,
      ai: false,
      ai_intro: null,
      ai_preheader: null,
    };

    /*
     * L'ÉCART D'UNE RELECTURE FAITE AVANT LE GEL — sujet et preheader de CETTE édition, écrits depuis
     * l'écran « Review edition » tant qu'elle n'était que `planned`.
     *
     * ⛔ VALIDÉ ICI AUSSI, pas seulement par la route : ce que le worker applique ne dépend pas de la
     * bonne conduite de l'appelant. Un écart invalide n'est PAS appliqué ET n'est pas tu : le gel
     * produit la base, écrit la raison dans `review_error` et laisse la révision en attente — le
     * fan-out refusera donc l'édition tant qu'un humain n'aura pas corrigé ou annulé sa relecture.
     * Envoyer la base en silence aurait fait partir ce que la relecture avait voulu changer.
     */
    const ecart = validerOverrides(row.review_overrides ?? null, {
      etat: "planned",
      base: null,
      sujetDeBase: base.subject,
      preheaderDeBase: base.preheader,
    });
    const overrides = ecart.ok ? ecart.overrides : null;

    /*
     * LA FIN DU GEL — sujet, preheader, balisage UTM, taille, empreinte, article de tête — par
     * `finaliserEdition` (@nf/edition), la fonction que la recompilation après relecture et l'aperçu de
     * l'admin appellent aussi. Les règles ci-dessous y vivent désormais ; elles restent écrites ici
     * parce que c'est ici qu'on les cherche.
     *
     * L'ARTICLE DE TÊTE ET LE NOMBRE D'ARTICLES DE CETTE ÉDITION.
     *
     * ⛔ ON NE SUBSTITUE PLUS ICI. `{{first_article}}` était remplacé dans le sujet par un
     * `split().join()` littéral, hors du registre de @nf/render : deux moteurs de jetons
     * coexistaient, celui-ci ignorant l'échappement, le repli inline `{{x|y}}` et le rapport de
     * tokens inconnus. Le sujet gelé portait donc un titre en dur, et corriger l'article de tête
     * après le gel ne corrigeait plus rien. Désormais on ÉCRIT la valeur (colonnes de 0050) et le
     * rendu la lit — un seul moteur, et la valeur reste corrigeable jusqu'à l'envoi.
     *
     * ⛔ LA GARDE, ELLE, RESTE. Un sujet qui promet un titre alors que l'édition n'a aucun article
     * partirait amputé de sa promesse, sans erreur : le jeton inconnu ou vide s'efface en silence.
     * On retient l'édition et on dit pourquoi.
     *
     * BALISAGE UTM des liens de contenu — le pendant de ce que `/lock` fait pour une campagne
     * ponctuelle, par la MÊME fonction : deux copies d'une règle de réécriture d'href finiraient
     * par diverger, et le désaccord ne se verrait que dans la boîte du lecteur.
     *
     * ⛔ AVANT `sizeBytes` ET `sha`. La taille doit être celle du HTML qui part ; et l'empreinte
     * anti-doublon doit porter sur le contenu expédié, sinon deux éditions identiques cesseraient
     * de se ressembler pour la garde.
     *
     * ⛔ AUCUN PARAMÈTRE VARIABLE PAR ÉDITION (pas d'`utm_content=edition-7`). Il changerait
     * l'empreinte à chaque échéance et la garde anti-doublon ne mordrait PLUS JAMAIS — elle
     * laisserait passer en silence une série qui renverrait huit fois le même contenu.
     *
     * ⭐ LE PREHEADER DE L'OCCURRENCE (sinon celui du modèle) ENTRE DANS LE HTML — et jusqu'au
     * 18/09/2026 il n'y entrait pas. Il était calculé ici, servait à l'empreinte anti-doublon juste
     * en dessous, s'affichait à l'écran… et n'atteignait jamais la boîte du lecteur : seul
     * `mj-preview`, donc le preheader DU MODÈLE, arrivait dans l'e-mail.
     *
     * ⛔ REMONTÉ AVANT `applyUtm`, ET C'EST LE MÊME ORDRE QUE `/lock`. La taille et l'empreinte se
     * mesurent sur le HTML qui part : poser le preheader après elles ferait mentir les deux.
     *
     * ⛔ LA TAILLE ET L'EMPREINTE SE MESURENT SUR LE HTML QUI PART, pas sur celui du modèle. Avec un
     * flux les deux diffèrent à chaque échéance ; prendre la taille du modèle ferait mentir l'écran,
     * et prendre son empreinte ferait déclarer DOUBLON deux éditions au contenu pourtant différent —
     * la garde anti-doublon se retournerait alors contre la série qu'elle protège.
     */
    const fin = await finaliserEdition(base, overrides);
    if (!fin.ok) {
      await retenir(fin.raison);
      continue;
    }
    const {
      html_shell: htmlFinal,
      text_shell: textFinal,
      size_bytes: sizeBytes,
      subject,
      preheader,
      content_sha256: sha,
      first_article_title: firstArticle,
      article_count: articleCount,
    } = fin.edition;

    /*
     * S-5 — LA GARDE ANTI-DOUBLON.
     *
     * Si le contenu arrêté est identique au précédent, cette occurrence enverrait à 1 200 personnes
     * un e-mail qu'elles ont déjà reçu. Techniquement tout aurait fonctionné ; éditorialement c'est
     * un incident. On retient, on nomme l'occurrence copiée, et on laisse un humain trancher —
     * renvoyer le même contenu est parfois délibéré, ce n'est pas au worker d'en décider.
     *
     * `duplicate_ack_at` non nul = quelqu'un a déjà tranché : on ne re-pose pas la question.
     */
    if (!row.duplicate_ack_at) {
      const precedente = await db.findLastSettled(row.campaign_id, row.id);
      if (precedente && precedente.content_sha256 === sha) {
        const quand = precedente.local_date ?? `#${precedente.seq}`;
        report.duplicatesHeld.push({
          occurrenceId: row.id,
          campaignName: row.campaign?.name ?? row.campaign_id,
          previous: quand,
        });
        await retenir(
          `identical to the edition of ${quand} (same content, same subject, same segment) — send it anyway from the campaign screen, or republish the template and save the campaign so its next editions use the new version`,
          precedente.id,
        );
        continue;
      }
    }

    if (simulate) {
      log("planner", { occurrence: row.id, would_freeze: true, bytes: sizeBytes, sha: sha.slice(0, 12) });
      report.frozen++;
      continue;
    }

    /*
     * L'INTRODUCTION ET L'ACCROCHE ÉCRITES PAR LE MODÈLE — un seul appel pour toute l'édition.
     *
     * ⛔ ICI, ET PAS PLUS HAUT. Après la garde anti-doublon et après `simulate` : une édition
     * retenue comme doublon ou une passe de simulation ne doivent rien dépenser. Après la
     * compilation aussi, parce que c'est le HTML EXPÉDIÉ qui dit si le jeton est là.
     *
     * ⛔ LE JETON EST L'INTERRUPTEUR. Pas de `{{ai_intro}}` ni de `{{ai_preheader}}` dans le
     * contenu figé, pas d'appel : on ne paie jamais un texte que rien n'affichera.
     *
     * ⛔ UN ÉCHEC NE RETIENT PAS L'ÉDITION. `generateIntroColumns` ne lève pas : elle rend
     * `ai_status='failed'` et son motif. Un service tiers indisponible ne doit pas empêcher un
     * envoi — le jeton retombe sur son repli vide et l'édition part sans son introduction.
     */
    let aiColumns: AiColumns | null = null;
    // ⛔ LE PREHEADER EFFECTIF, PAS CELUI DU MODÈLE. Depuis que l'occurrence écrase le modèle,
    // `shippedDoc.meta.preheader` n'est plus ce qui part : s'en servir ici générerait pour un
    // `{{ai_preheader}}` que l'occurrence vient de remplacer, et ne générerait PAS pour celui qu'un
    // humain a écrit sur l'occurrence — qui partirait alors en blanc.
    if (usesAiTokens(htmlFinal, subject, preheader)) {
      aiColumns = await generateIntroColumns(
        {
          assetName: shippedDoc.meta?.assetSlug ?? "",
          language: shippedDoc.meta?.locale ?? "en",
          articles: articlesOf(fin.doc),
          subject,
        },
        now,
      );
      log("planner", {
        occurrence: row.id,
        decision: "ai_intro",
        status: aiColumns.ai_status,
        model: aiColumns.ai_model ?? undefined,
        reason: aiColumns.ai_reason ?? undefined,
      });
    }

    /*
     * La base figée garde les textes TELS QUE LE MODÈLE LES A ÉCRITS : c'est ce que « Reset to AI
     * version » rétablit. Ce qui PART est l'écart d'une relecture s'il existe, sinon ces mêmes textes
     * (`textesIa`) — sans relecture, les deux valeurs sont identiques à celles de `aiColumns`.
     */
    const baseFigee: EditionBase = aiColumns
      ? { ...base, ai: true, ai_intro: aiColumns.ai_intro, ai_preheader: aiColumns.ai_preheader }
      : base;

    try {
      const gele = await db.freezeOccurrence(row.id, {
        // Absentes quand le modèle ne porte aucun jeton IA : on n'écrit pas des NULL qui
        // ressembleraient à une génération ratée.
        ...(aiColumns ?? {}),
        ...(textesIa(baseFigee, overrides) ?? {}),
        html_shell: htmlFinal,
        text_shell: textFinal,
        size_bytes: sizeBytes,
        subject,
        preheader,
        content_sha256: sha,
        first_article_title: firstArticle,
        article_count: articleCount,
        review_base: baseFigee,
        /*
         * ⛔ LA RÉVISION APPLIQUÉE EST CELLE QU'ON A LUE, JAMAIS « LA DERNIÈRE ». Si l'écran a écrit
         * une relecture entre notre lecture et cette écriture, la révision stockée la dépasse : la
         * passe de relecture ci-dessous la reprend, et le fan-out refuse l'édition en attendant.
         * Un écart invalide n'est pas appliqué : révision 0, et la raison dans `review_error`.
         */
        review_applied_rev: ecart.ok ? (row.review_rev ?? 0) : 0,
        review_error: ecart.ok ? null : ecart.erreur,
        // ⛔ La version, le sujet, le preheader et le segment LUS — les valeurs BRUTES de la ligne, pas
        // celles du gel : repointés entre-temps par l'enregistrement de la campagne, pas de gel.
      }, row.template_version_id, { subject: row.subject, preheader: row.preheader, segment_id: row.segment_id });

      /*
       * ⛔ UNE PASSE QUI N'A PAS GELÉ NE COMPTE PAS, ET SURTOUT NE MÉMORISE PAS.
       *
       * L'UPDATE est gardé par `status = 'planned'` : si une autre passe a gelé la même occurrence
       * entre notre lecture et notre écriture, il ne touche aucune ligne. Tant qu'on ne lisait pas
       * ce résultat, les deux passes comptaient un gel et les deux brûlaient les mêmes articles.
       * Même issue si la VERSION, le SUJET, le PREHEADER ou le SEGMENT ont été repointés entre-temps
       * (gardes `versionLue` et `contenuLu`) : rien n'est compté ni mémorisé, l'édition reste `planned`
       * et la passe suivante la gèle avec les nouvelles valeurs.
       */
      if (!gele) {
        log("planner", { occurrence: row.id, decision: "not-frozen-changed-meanwhile", version_read: row.template_version_id });
        continue;
      }
      report.frozen++;
      log("planner", {
        occurrence: row.id,
        decision: "frozen",
        bytes: sizeBytes,
        sha: sha.slice(0, 12),
        ...(overrides !== null ? { reviewed_before_freeze: true } : {}),
        ...(ecart.ok ? {} : { review_not_applied: ecart.erreur }),
      });

      // ⛔ APRÈS LE GEL, JAMAIS AVANT. Mémoriser d'abord condamnerait les articles d'une occurrence
      // qui, finalement, n'est pas partie : ils seraient exclus de tous les envois suivants sans
      // avoir jamais atteint personne. Et l'échec de cette mémorisation ne défait pas le gel — il
      // se paie en répétition possible demain, ce qui est infiniment moins grave qu'une édition
      // perdue.
      if (feedSent.length > 0) {
        try {
          await db.recordSentArticles(
            feedSent.map((a) => ({
              campaignId: row.campaign_id,
              occurrenceId: row.id,
              assetId: row.asset_id,
              blockId: a.blockId,
              articleUrl: a.articleUrl,
              articleTitle: a.articleTitle,
              publishedAt: a.publishedAt,
            })),
          );
        } catch (e) {
          report.errors.push(`record feed articles ${row.id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      report.errors.push(`freeze ${row.id}: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Passe 3 — reconstruire les éditions relues (0079)
// ---------------------------------------------------------------------------

/**
 * Reconstruit chaque édition GELÉE dont la relecture n'est pas encore appliquée
 * (`review_rev > review_applied_rev`).
 *
 * ⛔ C'EST LE SEUL ENDROIT QUI ÉCRIT CE QUI PART D'UNE ÉDITION RELUE. La route de l'admin n'écrit que
 * l'ÉCART (`review_overrides`) et incrémente la révision ; elle ne touche ni au shell, ni au sujet, ni
 * aux textes du modèle. Recompiler côté admin aurait fait deux définitions de la même édition. Ici, on
 * repart de la base figée au gel et on passe par `finaliserEdition` — la fonction du gel lui-même.
 *
 * ⛔ UNE RELECTURE QUI NE S'APPLIQUE PAS RESTE EN ATTENTE, BRUYAMMENT. Ni repli sur l'ancien shell, ni
 * mise en `held` (une édition retenue ne se relâche plus) : la raison est écrite dans `review_error`
 * (l'écran de relecture l'affiche sous le bouton), la passe la compte dans `errors`, et le fan-out
 * refuse d'enfiler une édition dont la révision n'est pas appliquée. L'humain corrige ou annule sa
 * relecture ; la passe suivante reconstruit.
 *
 * ⚠️ L'écriture est gardée par la RÉVISION LUE (et `status = 'frozen'`) : une relecture enregistrée
 * pendant qu'on reconstruisait n'est pas écrasée par une version plus ancienne — la passe suivante la
 * prendra.
 */
async function refreezeReviewed(db: PlannerDb, simulate: boolean, report: PlannerReport): Promise<void> {
  const lignes = await db.listOccurrencesToRefreeze();
  for (const row of lignes) {
    const enAttente = async (raison: string) => {
      report.errors.push(`review ${row.id}: ${raison}`);
      log("planner", { occurrence: row.id, decision: "review-not-applied", rev: row.review_rev, reason: raison });
      if (!simulate) await db.recordReviewError(row.id, row.review_rev, raison);
    };
    try {
      const base = lireBase(row.review_base);
      if (!base) {
        await enAttente("this edition has no frozen base to rebuild from — undo the review, or cancel the edition");
        continue;
      }
      const ecart = validerOverrides(row.review_overrides, contexteGele(base));
      if (!ecart.ok) {
        await enAttente(ecart.erreur);
        continue;
      }
      const fin = await finaliserEdition(base, ecart.overrides);
      if (!fin.ok) {
        await enAttente(fin.raison);
        continue;
      }
      if (simulate) {
        log("planner", { occurrence: row.id, would_apply_review: row.review_rev, sha: fin.edition.content_sha256.slice(0, 12) });
        report.refrozen++;
        continue;
      }
      const applique = await db.applyReview(row.id, row.review_rev, {
        ...fin.edition,
        ...(textesIa(base, ecart.overrides) ?? {}),
        review_applied_rev: row.review_rev,
        review_error: null,
      });
      if (!applique) {
        // Relue de nouveau, ou partie en file, entre notre lecture et notre écriture : rien à faire ici.
        log("planner", { occurrence: row.id, decision: "review-changed-meanwhile", rev: row.review_rev });
        continue;
      }
      report.refrozen++;
      log("planner", {
        occurrence: row.id,
        decision: "review-applied",
        rev: row.review_rev,
        recompiled: fin.recompilee,
        bytes: fin.edition.size_bytes,
        sha: fin.edition.content_sha256.slice(0, 12),
        ...(fin.warnings.length > 0 ? { warnings: fin.warnings } : {}),
      });
    } catch (e) {
      report.errors.push(`review ${row.id}: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// L'entrée
// ---------------------------------------------------------------------------

/**
 * Une passe complète du matérialiseur. ⛔ N'ENVOIE RIEN et n'écrit jamais dans `email_outbox` :
 * `outboxRowsWritten` est un `0` littéral, le compilateur refuserait une autre valeur.
 */
export async function runPlanner(db: PlannerDb, opts: PlannerOptions = {}): Promise<PlannerReport> {
  const now = opts.now ?? new Date();
  const horizonDays = opts.horizonDays ?? HORIZON_DAYS;
  const simulate = opts.simulate ?? false;

  const report: PlannerReport = {
    plansScanned: 0,
    occurrencesCreated: 0,
    occurrencesSkippedExisting: 0,
    frozen: 0,
    held: 0,
    errors: [],
    duplicatesHeld: [],
    outboxRowsWithOccurrence: 0,
    occurrencesMissed: 0,
    refrozen: 0,
    retrying: 0,
  };

  const plans = await db.listArmedPlans();
  report.plansScanned = plans.length;

  for (const plan of plans) {
    try {
      await materializeOne(db, plan, now, horizonDays, simulate, report);
    } catch (e) {
      report.errors.push(`${plan.id}: ${(e as Error).message}`);
    }
  }

  // Le gel balaie TOUTES les occurrences dues, y compris celles d'une campagne ponctuelle et
  // celles d'une série qu'on vient de désarmer : une occurrence déjà planifiée reste un
  // engagement pris. Désarmer arrête la création de NOUVELLES occurrences, pas celles qui existent.
  try {
    await freezeDue(db, now, simulate, report, opts.resoudreFlux ?? resolveFeedsOfDoc);
  } catch (e) {
    report.errors.push(`freeze: ${(e as Error).message}`);
  }

  // ⚠️ APRÈS le gel : une relecture écrite pendant que le gel tournait se rattrape dans la même passe.
  try {
    await refreezeReviewed(db, simulate, report);
  } catch (e) {
    report.errors.push(`review: ${(e as Error).message}`);
  }

  // Relu APRÈS les deux passes : une mesure prise avant ne prouverait rien de ce qu'elles ont fait.
  try {
    report.outboxRowsWithOccurrence = await db.countOutboxRowsWithOccurrence();
  } catch (e) {
    report.errors.push(`outbox check: ${(e as Error).message}`);
  }

  /*
   * Compté APRÈS le gel, pour la même raison : avant la passe, ce nombre inclurait les occurrences
   * que cette passe s'apprêtait à geler. Après, il ne reste que celles qu'elle n'a PAS pu prendre —
   * les éditions manquées. La mesure est en lecture seule : elle ne répare rien, elle rend visible.
   */
  try {
    report.occurrencesMissed = await db.countOverdueOccurrences(new Date().toISOString());
  } catch (e) {
    report.errors.push(`overdue check: ${(e as Error).message}`);
  }

  return report;
}
