/**
 * ---------------------------------------------------------------------------
 * Résolution des flux d'articles, à l'instant du gel.
 * ---------------------------------------------------------------------------
 *
 * ⛔ C'EST ICI, ET NULLE PART AILLEURS, QUE LE CONTENU DU SOIR EST FABRIQUÉ. Le modèle publié ne
 * porte qu'une REQUÊTE et un aperçu ; l'aperçu date du jour où l'auteur a réglé le bloc et ne doit
 * JAMAIS partir. Si cette résolution échoue, l'occurrence est RETENUE — on ne retombe pas sur
 * l'aperçu, ce serait envoyer la newsletter de ce jour-là en ayant l'air de fonctionner.
 *
 * ⚠️ CE FICHIER NE DÉCIDE RIEN. Il branche : il sait où chercher (REST ou RSS), qui interroger
 * (la source de CETTE marque) et ce qui est déjà parti. La règle — combien on garde, quand on
 * refuse — vit dans `resolveFeed` de @nf/wp, appelée aussi par l'admin pour l'aperçu. Deux
 * implémentations de la même règle finiraient par ne plus dire la même chose, et c'est l'écran qui
 * mentirait à l'auteur.
 *
 * ⚠️ AUTHENTIFICATION : aucune. Mesuré le 25/08 sur les cinq racines REST du parc, elles répondent
 * toutes anonymement, et les trois sources RSS n'ont pas de notion d'authentification. Le mot de
 * passe applicatif WordPress n'est donc nécessaire nulle part — et s'il le devenait, la requête
 * échouerait BRUYAMMENT plutôt que de rendre une liste vide qu'on prendrait pour une journée creuse.
 */
import { feedBlocksOf, describeFeed, type FeedResolution } from "@nf/render/feed";
import type { EmailDoc } from "@nf/render";
import {
  enrichir,
  fetchPosts,
  fetchPostsByIds,
  fetchFeedPosts,
  resolveFeed,
  staleFeedWarning,
  toFeedCandidate,
  type FeedCandidate,
} from "@nf/wp";
import {
  fenetreClassement,
  joursDeFenetre,
  melangeDemande,
  modeDeSelection,
  raisonLisible,
} from "@nf/analytics/article-views";
import type { PlannerDb } from "./planner-db";
import { log } from "./log";

/** Un article retenu, tel qu'on le mémorise pour ne pas le renvoyer demain. */
export interface SentArticle {
  blockId: string;
  articleUrl: string;
  articleTitle: string;
  publishedAt: string | null;
}

/**
 * Un bloc « les derniers » dont l'article le plus récent a dépassé `STALE_FEED_HOURS` (@nf/wp), sous
 * la forme exacte de la ligne `feeds_resolved` du journal (`planner.ts`).
 *
 * ⛔ UN CONSTAT, PAS UN VERDICT : l'édition part quand même (décision d'Alix, 25/09). Ce qui manquait
 * ce jour-là, c'était une trace — deux envois des sept mêmes articles, et rien nulle part pour le dire.
 */
export interface StaleFeed {
  block: string;
  age_hours: number;
  newest_published_at: string;
}

export type FeedOutcome =
  | { ok: true; resolutions: Record<string, FeedResolution>; sent: SentArticle[]; stale?: StaleFeed[] }
  /**
   * `reason` est affichée telle quelle dans l'écran des occurrences : elle doit tenir seule.
   * `retry` = une PANNE (le site ou notre base n'a pas répondu), pas un verdict sur le contenu : le
   * gel réessaie à la passe suivante tant qu'il reste une passe avant l'envoi (`planner.ts`).
   */
  | { ok: false; reason: string; retry?: true };

/**
 * ⛔ UNE PANNE DE NOTRE CÔTÉ NE S'IMPUTE PAS À LA MARQUE. Le 23/09, l'édition Copper Kettle a été
 * retenue avec « Copper Kettle did not answer » alors que c'était notre propre base qui refusait la
 * requête (414 du proxy devant PostgREST) : l'écran envoyait chercher la panne chez le site. Les
 * appels que ce fichier fait à NOTRE base et à NOTRE entrepôt lèvent donc cette erreur-ci.
 */
export class PanneInterne extends Error {}

/** La phrase posée sur l'occurrence retenue quand la résolution d'un flux LÈVE. */
export function raisonDePanne(label: string, e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  return e instanceof PanneInterne
    ? `building this edition failed on our side, not on ${label}'s — ${detail}`
    : `${label} did not answer while building this edition — ${detail}`;
}

/**
 * Les trois lecteurs WordPress de ce fichier, injectables — ⛔ POUR LES BANCS, jamais en production.
 *
 * ⛔ POURQUOI, ET C'EST MESURÉ (25/09/2026). `packages/wp/src/client.test.ts` double `./guard` par
 * `mock.module`, et ce double FUIT vers toute la suite : un banc qui doublait `globalThis.fetch` pour
 * atteindre `fetchPosts` passait seul et tombait à la racine, selon l'ordre des fichiers. Passer les
 * lecteurs ici ne dépend d'aucun ordre.
 */
export interface Recolteurs {
  fetchPosts: typeof fetchPosts;
  fetchPostsByIds: typeof fetchPostsByIds;
  fetchFeedPosts: typeof fetchFeedPosts;
}

const RECOLTEURS: Recolteurs = { fetchPosts, fetchPostsByIds, fetchFeedPosts };

/**
 * Résout TOUS les flux d'un document. Le premier qui échoue arrête tout : une newsletter à trous
 * n'est pas une newsletter dégradée, c'est une newsletter fausse.
 */
export async function resolveFeedsOfDoc(
  db: PlannerDb,
  doc: EmailDoc,
  ctx: {
    campaignId: string;
    assetId: string;
    occurrenceId: string;
    now: Date;
    /**
     * L'écart en jours depuis l'envoi précédent, quand la campagne a une récurrence armée.
     * `null` = pas de cadence exploitable. Paresseuse : seuls les blocs réglés sur « suivre la
     * cadence » la demandent, et elle coûte un aller-retour en base.
     */
    cadenceJours?: () => Promise<number | null>;
    /**
     * L'interrupteur de la CAMPAGNE (`campaign.mix_latest`, migration 0049) : faut-il compléter les
     * blocs classés par vues avec les articles des 48 h que l'entrepôt ne sait pas encore mesurer ?
     *
     * ⭐ Il vit dans la campagne et pas dans le modèle parce qu'un modèle sert PLUSIEURS campagnes —
     * « Friday NL TW » et « Resumo da rodada » partagent la version 509c87c3 en production — et
     * qu'Alix veut le mélange sur l'une et pas sur l'autre.
     */
    mixLatest?: boolean;
  },
  recolteurs: Recolteurs = RECOLTEURS,
): Promise<FeedOutcome> {
  const feeds = feedBlocksOf(doc);
  if (feeds.length === 0) return { ok: true, resolutions: {}, sent: [] };

  const resolutions: Record<string, FeedResolution> = {};
  const sent: SentArticle[] = [];
  const stale: StaleFeed[] = [];
  const fetchedAt = ctx.now.toISOString();

  /**
   * ⚠️ Mémoïsée : un document peut porter plusieurs blocs réglés sur la cadence, et ils parlent
   * tous de la MÊME campagne. Sans ce cache, trois blocs feraient trois fois la même requête — et,
   * pire, rien ne garantirait qu'ils obtiennent la même réponse si la passe s'étire.
   */
  let cadenceLue: { valeur: number | null } | null = null;
  const lireCadence = async (): Promise<number | null> => {
    if (cadenceLue === null) {
      cadenceLue = { valeur: ctx.cadenceJours ? await ctx.cadenceJours() : null };
    }
    return cadenceLue.valeur;
  };

  for (const feed of feeds) {
    const source = await db.loadWpSource(feed.sourceId, ctx.assetId);
    if (!source) {
      return {
        ok: false,
        reason: `the WordPress source of "${describeFeed(feed)}" no longer exists on this brand — pick another source in the template`,
      };
    }

    /**
     * ⛔ LA MÊME FENÊTRE POUR LA RÉCOLTE ET POUR LA MESURE, décidée une fois. Elle sert plus bas au
     * lecteur de vues : deux appels séparés laisseraient l'un des deux dériver sans que rien ne le
     * dise. Cf. `fenetreClassement`.
     *
     * ⚠️ La cadence n'est lue QUE si le bloc la demande : un bloc à durée fixe, ou trié par date,
     * ne doit pas payer une requête pour une valeur qu'il n'utilisera pas.
     */
    /**
     * ⚠️ La cadence est lue dès que le bloc en DÉPEND : pour la DURÉE de la fenêtre (`views` réglé
     * sur « cadence »), ou pour le MODE lui-même (`mixed`, qui retombe sur « les derniers » quand
     * la lettre est quotidienne). Un bloc trié par date ne paie toujours aucune requête.
     */
    const veutMelange = melangeDemande(feed.orderby, ctx.mixLatest);
    const cadence =
      veutMelange || (feed.orderby === "views" && feed.viewsWindow === "cadence")
        ? await lireCadence()
        : undefined;
    const choix = modeDeSelection(feed.orderby, cadence, ctx.mixLatest);
    const mode = choix.mode;
    /** Le mode effectif décide de tout ce qui suit — pas le réglage du modèle. */
    const classeParVues = mode !== "date";

    const duree = joursDeFenetre(feed.viewsWindow, cadence);
    const fenetre = fenetreClassement(ctx.now, duree.jours);

    // Ce que le pool a réellement couvert — rapporté au journal, jamais deviné.
    let recolte: { total: number | null; truncated: boolean } = { total: null, truncated: false };

    // ⚠️ Le nombre à récolter est décidé par @nf/wp (`feedFetchLimit`, appelée dans `resolveFeed`),
    // pas ici : c'est la même marge que celle dont l'écran d'aperçu se sert, et deux marges
    // différentes feraient diverger ce qu'on voit de ce qui part.
    const harvest = async (limit: number): Promise<FeedCandidate[]> => {
      if (source.kind === "rss") {
        // ⚠️ UN FLUX RSS NE SAIT PAS FILTRER. `categories`/`tags` sont ignorés par le lecteur — le
        // signaler ici évite de chercher pourquoi « la catégorie ne s'applique pas » : elle ne
        // s'applique jamais sur ces trois sources, qui n'ont pas d'API REST.
        if (feed.categories.length > 0 || feed.tags.length > 0) {
          log("planner", {
            occurrence: ctx.occurrenceId,
            feed: feed.id,
            notice: "rss_source_ignores_filters",
            source: source.label,
          });
        }
        const { candidates } = await recolteurs.fetchFeedPosts(source.restRoot, { kind: "none" }, { limit });
        return candidates.map(toFeedCandidate);
      }
      const r = await recolteurs.fetchPosts(
        source.restRoot,
        { kind: "none" },
        {
          limit,
          categories: feed.categories,
          tags: feed.tags,
          // ⛔ LES MÊMES BORNES QUE L'APERÇU. Classer par vues implique de ne récolter que ce qui
          // est classable : sans `before`, le haut du flux est toujours postérieur à l'ingestion de
          // l'entrepôt et l'occurrence serait retenue à chaque échéance. Sans `after`, le pool
          // n'aurait aucun rapport avec la fenêtre annoncée — on classerait les derniers articles
          // du site en promettant les plus lus de la période. Deux bornes différentes ici et dans
          // l'aperçu feraient valider un pool et en envoyer un autre.
          ...(classeParVues
            ? {
                after: fenetre.apres,
                // ⛔ EN MODE `mixed`, LA RÉCOLTE VA JUSQU'À MAINTENANT. La moitié « les derniers »
                // vit précisément dans les 48 h que `fenetre.avant` exclut : garder cette borne
                // ferait chercher des articles frais dans une période d'où ils sont bannis, et la
                // moitié serait vide à chaque envoi sans qu'aucune erreur ne le dise.
                before: mode === "mixed" ? fenetre.fraisAvant : fenetre.avant,
                // Le pool couvre toute la fenêtre : il se récolte sans médias, sinon il pèserait
                // des mégaoctets et le site n'aurait pas fini de répondre. Les retenus sont
                // ré-enrichis plus bas.
                sansMedia: true,
              }
            : {}),
        },
      );
      recolte = { total: r.total, truncated: r.truncated };
      return r.candidates.map(toFeedCandidate);
    };

    let verdict;
    try {
      verdict = await resolveFeed(
        {
          sourceId: feed.sourceId,
          categories: feed.categories,
          tags: feed.tags,
          count: feed.count,
          minCount: feed.minCount,
          dedupeDays: feed.dedupeDays,
          orderby: mode,
          // La frontière décidée par `fenetreClassement`, transmise telle quelle : `resolveFeed`
          // refuse de la recalculer, et c'est ce refus qui garantit une seule décision de bornes.
          ...(mode === "mixed" ? { freshBoundary: fenetre.frontiereFraicheUtc } : {}),
          label: source.label,
        },
        {
          fetch: harvest,
          alreadySent: (hrefs, sinceIso) =>
            db.sentArticleUrls(ctx.campaignId, hrefs, sinceIso).catch((e: unknown) => {
              throw new PanneInterne(e instanceof Error ? e.message : String(e));
            }),
          /**
           * ⛔ LE MÊME LECTEUR QUE L'APERÇU (`api/builder/wp/feed-preview`), à la même fenêtre. Deux
           * chemins de lecture différents feraient valider un ordre à l'auteur et en envoyer un
           * autre — et personne ne s'en apercevrait avant que la lettre soit partie.
           *
           * Fourni SEULEMENT quand le bloc le demande : `resolveFeed` n'appelle cette fonction que
           * dans ce cas, mais la passer toujours ferait croire, en lisant ce code, que le tri par
           * vues est actif partout.
           */
          ...(classeParVues
            ? {
                views: async (hrefs: string[]) => {
                  const audience = await db
                    .articleViews(ctx.assetId, hrefs, fenetre.du, fenetre.au)
                    .catch((e: unknown) => {
                      throw new PanneInterne(e instanceof Error ? e.message : String(e));
                    });
                  // ⛔ Un refus LÈVE. Rendre une carte vide ferait dire à `resolveFeed` « aucun
                  // article n'est encore mesuré » — une phrase qui parle de fraîcheur — alors que
                  // la cause est une propriété non élue ou un entrepôt injoignable. L'occurrence
                  // serait retenue avec la mauvaise explication, donc le mauvais geste de réparation.
                  if (!audience.ok) throw new PanneInterne(raisonLisible(audience.motif));
                  return audience.vues;
                },
              }
            : {}),
          now: ctx.now,
        },
      );
    } catch (e) {
      // ⛔ SITE INJOIGNABLE ≠ FLUX TROP MAIGRE, et les deux appellent des gestes opposés : réessayer
      // d'un côté, publier davantage de l'autre. `resolveFeed` LÈVE dans le premier cas et rend un
      // verdict dans le second — c'est pour ça que le try n'entoure que l'appel.
      return { ok: false, reason: raisonDePanne(source.label, e), retry: true };
    }

    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    /**
     * ⛔ RECOLLER LES MÉDIAS SUR LES SEULS RETENUS. Le pool du mode `views` a été récolté sans
     * `_embed` : sans ce second appel, les cartes partiraient sans vignette ni catégorie. Il ne
     * porte que sur les articles choisis — une requête, une douzaine d'articles.
     *
     * ⚠️ Un échec ici ne doit PAS tuer l'édition : les articles sont bons, seule leur illustration
     * manque. On journalise et on part avec les cartes légères, plutôt que de retenir une
     * occurrence entière pour des vignettes.
     */
    let items = verdict.items;
    if (classeParVues && source.kind !== "rss" && items.length > 0) {
      try {
        const frais = await recolteurs.fetchPostsByIds(
          source.restRoot,
          { kind: "none" },
          items.map((i) => i.postId),
        );
        items = enrichir(items, frais.map(toFeedCandidate));
      } catch (e) {
        log("planner", {
          occurrence: ctx.occurrenceId,
          feed: feed.id,
          notice: "media_enrich_failed",
          detail: (e as Error).message,
        });
      }
    }

    resolutions[feed.id] = { items, fetchedAt };
    // Jugé sur le mode SERVI (`mode`), pas sur le réglage du modèle : une quotidienne réglée sur
    // `mixed` part en « les derniers », et c'est alors bien un bloc « les derniers » qui vieillit.
    const perime = staleFeedWarning(mode, items, ctx.now);
    if (perime) {
      stale.push({ block: feed.id, age_hours: perime.ageHours, newest_published_at: perime.newestPublishedAt });
    }
    for (const item of items) {
      sent.push({
        blockId: feed.id,
        articleUrl: item.href,
        articleTitle: item.title,
        publishedAt: item.publishedAt ?? null,
      });
    }

    log("planner", {
      occurrence: ctx.occurrenceId,
      feed: feed.id,
      rule: describeFeed(feed),
      kept: items.length,
      dropped: verdict.dropped,
      /**
       * ⛔ CE QUE LE CLASSEMENT A RÉELLEMENT COUVERT. Sans ces trois chiffres, un tri par vues
       * calculé sur un pool tronqué est indiscernable d'un tri sur la fenêtre entière — et c'est
       * dans le journal, après coup, qu'on cherchera pourquoi un article évident n'est pas sorti.
       * `pool_truncated` veut dire : la fenêtre en contenait plus que `MAX_POOL`, donc le classement
       * ne porte que sur ses articles les plus récents.
       */
      ...(classeParVues
        ? {
            window_days: fenetre.jours,
            window_from: duree.origine,
            pool_total: recolte.total,
            pool_truncated: recolte.truncated,
          }
        : {}),
      /**
       * ⛔ D'OÙ VIENNENT LES CARTES, quand le bloc en compose deux moitiés. « 3 + 2 comme prévu » et
       * « 5 + 0 parce que le site n'a rien publié depuis deux jours » donnent la même lettre à
       * l'écran ; seul ce couple de chiffres les sépare après coup.
       */
      ...(verdict.composition ? { composition: verdict.composition } : {}),
      /**
       * ⛔ LE MODE DEMANDÉ N'EST PAS TOUJOURS LE MODE SERVI. Une quotidienne réglée sur « mixte »
       * part en « les derniers » : sans cette ligne, le journal serait indiscernable de celui d'un
       * bloc réglé sur « date », et personne ne saurait que la règle du modèle n'a pas pris.
       */
      ...(choix.degrade
        ? { orderby_asked: feed.orderby, orderby_served: mode, cadence_days: cadence, mix_latest: ctx.mixLatest === true }
        : {}),
      /**
       * ⛔ L'INTERRUPTEUR EST JOURNALISÉ DÈS QU'IL EST ARMÉ, même quand il ne change rien. C'est le
       * cas le plus probable aujourd'hui : aucun modèle en base n'est classé par vues (0 sur les 17
       * versions portant un flux, mesuré le 04/09), donc une case cochée n'aura longtemps aucun
       * bloc à promouvoir. Sans cette ligne, « la case n'était pas cochée » et « elle l'était mais
       * ce bloc n'est pas classé par vues » seraient indiscernables dans le journal.
       */
      ...(ctx.mixLatest === true && !choix.degrade ? { mix_latest: true, orderby_served: mode } : {}),
    });
  }

  return { ok: true, resolutions, sent, stale };
}
