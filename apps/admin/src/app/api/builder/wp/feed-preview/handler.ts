import { NextResponse } from "next/server";
import { findWpSource } from "@/lib/data/wp-sources";
import { fetchPosts, fetchPostsByIds, resolveAuth } from "@nf/wp/client";
import { WpFetchError } from "@nf/wp/guard";
import { enrichir, fetchFeedPosts, resolveFeed, staleFeedWarning, toFeedCandidate, type FeedCandidate } from "@nf/wp";
import {
  fenetreClassement,
  joursDeFenetre,
  lireAudience,
  modeDeSelection,
  raisonLisible,
} from "@nf/analytics/article-views";
import {
  cadenceDeCampagne,
  cadenceDuModele,
  melangeDeCampagne,
  melangeDuModele,
} from "@/lib/data/campaign-cadence";
import { jsonError, readJson, type requireContext } from "../../_shared";

/*
 * Module séparé de `route.ts` : la session y est injectée, pour qu'un banc mesure la route sans
 * cookie (même forme que `legal-footer-preview/handler.ts`).
 */
export type Garde = () => ReturnType<typeof requireContext>;

/**
 * Les trois lecteurs WordPress de la route, injectables — ⛔ POUR LES BANCS, jamais en production.
 *
 * ⛔ POURQUOI, ET C'EST MESURÉ (25/09/2026). `packages/wp/src/client.test.ts` double `./guard` par
 * `mock.module`, et ce double FUIT vers toute la suite : un banc qui doublait `globalThis.fetch` passait
 * seul et tombait à la racine (2 échecs sur 3871), selon l'ordre des fichiers.
 */
export interface Recolteurs {
  fetchPosts: typeof fetchPosts;
  fetchPostsByIds: typeof fetchPostsByIds;
  fetchFeedPosts: typeof fetchFeedPosts;
}

const RECOLTEURS: Recolteurs = { fetchPosts, fetchPostsByIds, fetchFeedPosts };

/**
 * POST /api/builder/wp/feed-preview — l'APERÇU d'un bloc `article-feed`, à cet instant.
 *
 * ⛔ CETTE ROUTE N'ÉCRIT DANS AUCUNE TABLE. Elle lit une source WordPress et rend des articles ;
 * c'est le document du builder (donc le brouillon du modèle) qui les mémorise. Écrire ici
 * poserait une seconde origine à l'aperçu, et l'aperçu affiché finirait par ne plus être celui
 * que le modèle porte.
 *
 * ⛔ CE QU'ELLE REND N'EST PAS CE QUI PARTIRA. Les articles envoyés sont résolus 90 min avant
 * chaque échéance par le worker (`apps/worker/src/feed-resolve.ts`). L'aperçu sert à régler la
 * règle, pas à composer l'email — d'où `previewAt`, que l'écran affiche pour dire de quand il date.
 *
 * ⚠️ LA DÉCISION EST CELLE DU WORKER, PAS UNE COPIE. On appelle `resolveFeed` de `@nf/wp`, le
 * même code que le gel : sans ça, l'aperçu promettrait des articles que l'envoi ne choisirait pas
 * (tri, doublons du lot, articles sans lien — trois règles qui divergeraient à la première
 * retouche). Seule différence assumée : l'anti-répétition ne s'applique pas, parce qu'un modèle
 * en cours d'écriture n'a aucun historique d'envoi — l'inspecteur le dit en toutes lettres.
 */
interface PreviewBody {
  sourceId?: unknown;
  categories?: unknown;
  tags?: unknown;
  count?: unknown;
  minCount?: unknown;
  dedupeDays?: unknown;
  orderby?: unknown;
  viewsWindow?: unknown;
  /**
   * La campagne depuis laquelle le builder a été ouvert, quand il l'a été. Absent quand on édite un
   * modèle seul — et c'est le cas normal, pas une omission : un modèle sert plusieurs campagnes.
   */
  campaignId?: unknown;
  /** Le modèle en cours d'édition : le seul repère dont dispose le builder pour trouver une cadence. */
  templateId?: unknown;
}

/**
 * L'entrepôt d'analytics n'a pas répondu — À NE PAS CONFONDRE avec `WpFetchError`.
 *
 * ⛔ Sans cette classe, le `catch` du bas retomberait sur « the site could not be reached » et
 * l'auteur irait vérifier son WordPress alors que c'est la propriété GA4 qui manque ou l'entrepôt
 * qui est injoignable. C'est la faute que tout ce chantier existe pour éviter, à un cran de plus.
 */
class AudienceIndisponible extends Error {}

/** Ids de taxonomie reçus du client — jamais passés bruts à WordPress, qui répond 400 sur un slug. */
function idList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => Number(v))
    .filter((n) => Number.isSafeInteger(n) && n >= 0)
    .slice(0, 10);
}

const clampInt = (raw: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  // ⚠️ `Number(undefined)` et `Number("")` valent NaN, et NaN échoue à toute comparaison : sans ce
  // test, un champ vidé partait tel quel et la requête se faisait sans quantité.
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};

export async function feedPreview(req: Request, garde: Garde, recolteurs: Recolteurs = RECOLTEURS) {
  const c = await garde();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<PreviewBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
  if (!sourceId) return jsonError("`sourceId` is required", 400);

  // Scoping par marque : une source d'une autre marque doit être indiscernable d'une source
  // inexistante — 404, jamais 403 (pas d'oracle d'existence).
  const source = await findWpSource(db, sourceId, asset.id);
  if (!source) return jsonError("source not found", 404);

  const categories = idList(body.categories);
  const tags = idList(body.tags);
  const count = clampInt(body.count, 5, 1, 12);
  const minCount = clampInt(body.minCount, 1, 1, 12);
  const dedupeDays = clampInt(body.dedupeDays, 0, 0, 60);
  // ⛔ Liste fermée, et le défaut est `date`. Un `orderby` inconnu ne doit PAS devenir « views » par
  // accident : le bloc annoncerait un classement que la marque ne peut pas produire.
  const orderby: "date" | "views" | "mixed" =
    body.orderby === "views" ? "views" : body.orderby === "mixed" ? "mixed" : "date";
  /**
   * ⛔ MÊME PRUDENCE QUE POUR `orderby` : tout ce qui n'est pas un nombre lisible retombe sur
   * `"cadence"`, le défaut du schéma. Interpréter une saisie douteuse comme une durée ferait
   * classer une période que personne n'a demandée, et l'écran l'annoncerait sans sourciller.
   */
  const viewsWindow: "cadence" | number = Number.isFinite(Number(body.viewsWindow))
    ? Math.min(90, Math.max(1, Math.trunc(Number(body.viewsWindow))))
    : "cadence";
  const campaignId = typeof body.campaignId === "string" && body.campaignId ? body.campaignId : null;
  const templateId = typeof body.templateId === "string" && body.templateId ? body.templateId : null;

  const notices: string[] = [];
  // ⛔ Un flux RSS ne porte AUCUN id de taxonomie : le filtre n'est pas « mal appliqué », il n'est
  // pas applicable. Se taire ferait chercher pendant dix minutes pourquoi la catégorie ne change
  // rien — sur ces sources elle ne changera jamais rien, ni ici ni à l'envoi.
  if (source.kind === "rss" && (categories.length > 0 || tags.length > 0)) {
    notices.push(
      "This source has no REST API — it is read as an RSS feed, which carries no category or tag ids. Those filters are ignored here and at send time.",
    );
  }

  /**
   * ⛔ L'APERÇU DOIT PASSER PAR LE MÊME LECTEUR QUE LE GEL. Le worker appelle `lireAudience` de
   * `@nf/analytics` avec son propre client ; si l'aperçu classait par un autre chemin, l'auteur
   * validerait un ordre et les abonnés en recevraient un autre — précisément ce que cette route
   * existe pour empêcher.
   *
   * ⚠️ Fenêtre décidée une seule fois par `fenetreClassement` et partagée avec la récolte : c'est
   * ce qui garantit qu'on mesure exactement ce qu'on a récolté.
   *
   * ⚠️ « Suivre la cadence » se résout ici en remontant du modèle aux campagnes qui l'emploient —
   * `campaignId` d'abord quand l'appelant sait laquelle, `templateId` sinon, qui est le seul repère
   * du builder (il s'ouvre depuis la liste des modèles, jamais depuis une campagne). Un modèle sert
   * plusieurs campagnes, et c'est déjà le cas en production : quand leurs périodes diffèrent, la
   * lecture rend `several` et rien n'est appliqué. Toutes ces impasses retombent sur sept jours en
   * DISANT laquelle, sans quoi l'aperçu montrerait « 7 jours » là où l'envoi en produirait quatre.
   *
   * On ne paie la lecture que si elle peut changer quelque chose : un bloc classé par date, ou
   * réglé sur une durée fixe, n'a aucune cadence à suivre.
   */
  const cadence =
    orderby === "mixed" || (orderby === "views" && viewsWindow === "cadence")
      ? campaignId
        ? await cadenceDeCampagne(db, campaignId, asset.id, new Date())
        : templateId
          ? await cadenceDuModele(db, templateId, asset.id, new Date())
          : null
      : null;
  /**
   * ⛔ `cadence ? cadence.jours : undefined`, JAMAIS `cadence?.jours ?? undefined` : les deux
   * absences ne disent pas la même chose. `undefined` = aucune campagne connue (aperçu isolé),
   * `null` = campagne connue mais sans cadence exploitable. Le `??` écraserait la seconde en la
   * première, et l'écran conseillerait d'ouvrir depuis une campagne à quelqu'un qui l'a déjà fait.
   */
  const duree = joursDeFenetre(viewsWindow, cadence ? cadence.jours : undefined);
  const fenetre = fenetreClassement(new Date(), duree.jours);
  /**
   * ⛔ L'APERÇU MONTRE LE MODE SERVI, PAS LE MODE DEMANDÉ. Une quotidienne réglée sur « mixte »
   * part en « les derniers » : montrer ici un mélange que l'envoi ne produira pas serait
   * exactement la divergence aperçu/envoi que cette route existe pour fermer.
   */
  /**
   * ⛔ L'INTERRUPTEUR VIT DANS LA CAMPAGNE, ET LE BUILDER N'EN CONNAÎT AUCUNE. Il s'ouvre depuis la
   * liste des modèles : les huit navigations vers `/builder/...` en partent. On remonte donc du
   * modèle aux campagnes qui l'emploient, exactement comme pour la cadence.
   *
   * ⛔ ET QUAND ELLES NE SONT PAS D'ACCORD, ON N'EN ÉLIT AUCUNE. Le cas est réel dès aujourd'hui :
   * « Friday NL TW » et « Resumo da rodada » partagent la version 509c87c3. Appliquer le réglage de
   * l'une rendrait un aperçu juste pour elle et faux pour l'autre — la divergence aperçu/envoi que
   * cette route existe pour fermer. On montre alors le résultat SANS mélange, et on le dit.
   */
  const melange =
    orderby === "views"
      ? campaignId
        ? await melangeDeCampagne(db, campaignId, asset.id)
        : templateId
          ? await melangeDuModele(db, templateId, asset.id)
          : null
      : null;
  if (melange?.raison === "several") {
    notices.push(
      "The campaigns using this template do not agree on the article mix — one has it on, another off. This preview shows the result WITHOUT the mix; open the campaign to see what it will actually send.",
    );
  }

  const choix = modeDeSelection(orderby, cadence ? cadence.jours : undefined, melange?.actif === true);
  const mode = choix.mode;
  const classeParVues = mode !== "date";
  if (choix.degrade) {
    notices.push(
      "This campaign sends every day, so there is nothing measurable to rank yet — analytics lags by two days. The block is serving the latest articles only; it will mix in the most viewed ones as soon as the campaign sends less often.",
    );
  }

  const lireVues = async (hrefs: string[]): Promise<Map<string, number>> => {
    const audience = await lireAudience(db, asset.id, hrefs, fenetre.du, fenetre.au);
    // ⛔ Un refus ne devient PAS une carte vide : `resolveFeed` traiterait ça comme « aucun article
    // mesuré » et rendrait une phrase parlant de fraîcheur, là où la cause est une propriété non
    // élue ou un entrepôt injoignable. On lève, et le `catch` du bas nomme la vraie cause.
    if (!audience.ok) throw new AudienceIndisponible(raisonLisible(audience.motif));
    return audience.vues;
  };

  const auth = resolveAuth(source.restRoot, source.authKind, source.authUser);

  /**
   * Ce que la récolte a réellement ramené. ⛔ L'écran doit pouvoir dire SUR QUOI il classe : un
   * classement calculé sur un pool coupé, affiché sans le dire, se lit comme un classement sur la
   * fenêtre entière — et c'est exactement le « mensonge de fenêtre » que ce mode existe pour éviter.
   */
  let recolte: { pooled: number; total: number | null; truncated: boolean } = {
    pooled: 0,
    total: null,
    truncated: false,
  };

  const fetchCandidates = async (limit: number): Promise<FeedCandidate[]> => {
    if (source.kind === "rss") {
      // ⚠️ Un flux RSS ne sait pas filtrer par date : en mode « most viewed » son pool restera
      // celui des dernières publications, donc probablement non mesurable. `resolveFeed` refusera
      // alors en le disant — c'est plus honnête qu'un classement sur trois articles au hasard.
      const { candidates } = await recolteurs.fetchFeedPosts(source.restRoot, auth, { limit });
      return candidates.map(toFeedCandidate);
    }
    const r = await recolteurs.fetchPosts(source.restRoot, auth, {
      limit,
      categories,
      tags,
      // ⛔ Classer par vues implique de ne récolter que ce qui est CLASSABLE, et RIEN QUE la
      // fenêtre annoncée. Sans `before`, le haut du flux est toujours postérieur à l'ingestion et
      // le bloc refuserait à chaque échéance ; sans `after`, on classerait les derniers articles du
      // site sous une étiquette qui promet une période.
      // Le pool couvre toute la fenêtre : sans médias, il tient en dizaines de kilo-octets là où
      // `_embed` en ferait des mégaoctets. Les retenus sont ré-enrichis après la sélection.
      // ⛔ En mode `mixed`, la borne haute va jusqu'à MAINTENANT : la moitié « les derniers » vit
      // dans les 48 h que `fenetre.avant` exclut, et la chercher sous cette borne la laisserait
      // vide à chaque aperçu.
      ...(classeParVues
        ? { after: fenetre.apres, before: mode === "mixed" ? fenetre.fraisAvant : fenetre.avant, sansMedia: true }
        : {}),
    });
    recolte = { pooled: r.candidates.length, total: r.total, truncated: r.truncated };
    return r.candidates.map(toFeedCandidate);
  };

  try {
    const verdict = await resolveFeed(
      {
        sourceId,
        categories,
        tags,
        count,
        minCount,
        dedupeDays,
        orderby: mode,
        ...(mode === "mixed" ? { freshBoundary: fenetre.frontiereFraicheUtc } : {}),
        label: source.label,
      },
      {
        fetch: fetchCandidates,
        ...(classeParVues ? { views: lireVues } : {}),
        // ⛔ Aucun historique à interroger : un modèle en cours d'écriture n'a encore rien envoyé.
        // On rend l'ensemble VIDE plutôt que d'inventer une exclusion — et l'écran dit que la
        // fenêtre d'anti-répétition ne s'applique qu'aux vraies échéances.
        alreadySent: async () => new Set<string>(),
        now: new Date(),
      },
    );

    const previewAt = new Date().toISOString();

    /**
     * Ce que l'écran affiche sous l'aperçu : la fenêtre classée, et sur combien d'articles.
     * `null` en mode `date` — annoncer une fenêtre là où il n'y en a pas serait un réglage
     * imaginaire de plus à comprendre.
     */
    const windowInfo =
      classeParVues
        ? {
            days: fenetre.jours,
            /** D'où vient la durée — l'écran doit distinguer « sept jours voulus » de « sept jours faute de mieux ». */
            origin: duree.origine,
            from: fenetre.du,
            to: fenetre.au,
            pooled: recolte.pooled,
            truncated: recolte.truncated,
            /**
             * Pourquoi la cadence n'a pas pu être suivie, quand une campagne était pourtant connue.
             * `origin` seul dirait « no-cadence » sans dire s'il faut armer la récurrence ou s'il
             * s'agit du tout premier envoi — deux situations qui appellent des gestes différents.
             */
            cadence: cadence ? cadence.raison : null,
            /** L'envoi visé, pour que l'écran parle d'une date plutôt que d'un nombre sans sujet. */
            nextSend: cadence?.prochain ?? null,
            /** La campagne dont la période est appliquée — `null` dès qu'elle ne serait pas la seule. */
            campaign: cadence?.campagne ?? null,
          }
        : null;

    // ⛔ Une troncature ne se tait pas. Elle veut dire que le classement porte sur les articles les
    // plus RÉCENTS de la fenêtre, pas sur la fenêtre — et le lecteur de l'écran doit pouvoir en
    // tenir compte plutôt que de croire à un classement complet.
    if (recolte.truncated) {
      notices.push(
        `This window holds ${recolte.total ?? "more"} articles — more than can be ranked at once. The ranking below covers only the ${recolte.pooled} most recent of them. Narrow the categories or shorten the window to rank the whole period.`,
      );
    }

    if (!verdict.ok) {
      // 200 et non 502 : la source a répondu, c'est la RÈGLE qui ne tient pas aujourd'hui. La
      // phrase de `resolveFeed` est celle que l'écran des occurrences affichera le soir venu —
      // la montrer ici, c'est montrer la rétention avant qu'elle ne coûte une échéance.
      return NextResponse.json({ items: [], previewAt, shortfall: verdict.reason, notices, window: windowInfo });
    }

    /**
     * ⛔ RECOLLER LES MÉDIAS SUR LES SEULS RETENUS — le même geste qu'au gel, sinon l'aperçu
     * montrerait des cartes sans vignette pour des articles qui en auront une à l'envoi.
     *
     * ⚠️ Un échec n'invalide pas l'aperçu : les articles et leur ordre sont justes, seule
     * l'illustration manque. On le DIT plutôt que de rendre 502 sur une source qui a répondu.
     */
    let items = verdict.items;
    if (classeParVues && source.kind !== "rss" && items.length > 0) {
      try {
        const frais = await recolteurs.fetchPostsByIds(source.restRoot, auth, items.map((i) => i.postId));
        items = enrichir(items, frais.map(toFeedCandidate));
      } catch {
        notices.push("Article images could not be loaded for this preview — the ranking above is unaffected.");
      }
    }

    return NextResponse.json({
      items,
      previewAt,
      shortfall: null,
      notices,
      window: windowInfo,
      /**
       * L'interrupteur appliqué à cet aperçu, et d'où il vient. `null` hors du mode « les plus
       * vus » — le mélange n'y a rien à promouvoir, et un motif rendu là serait un réglage
       * imaginaire de plus à comprendre.
       */
      mix: melange ? { active: melange.actif === true, reason: melange.raison, campaign: melange.campagne } : null,
      /** D'où viennent les cartes, quand le bloc en compose deux moitiés — `null` dans les autres modes. */
      composition: verdict.composition ?? null,
      /**
       * ⛔ L'article le plus récent d'un bloc « les derniers » a plus de 24 h — `null` sinon, et
       * toujours `null` hors du mode servi `date` (cf. `staleFeedWarning`). Le 25/09, un bloc Northwind Sports
       * filtré sur des catégories que le site n'emploie plus a servi toute la journée les mêmes
       * articles, et cet écran n'en disait rien. Jugé sur le mode SERVI (`mode`), comme au gel, et à
       * l'instant `previewAt` : l'âge affiché est celui de l'aperçu « taken … UTC » qu'il accompagne.
       */
      stale: staleFeedWarning(mode, items, new Date(previewAt)),
    });
  } catch (e) {
    // ⛔ L'ordre compte : l'audience d'abord, sinon une panne d'entrepôt se raconterait comme une
    // panne de site.
    if (e instanceof AudienceIndisponible) return jsonError(e.message, 502);
    const detail = e instanceof WpFetchError ? e.message : "the site could not be reached";
    // 502 et non 200 avec une liste vide : « le site est injoignable » et « rien ne correspond »
    // n'amènent pas l'auteur au même geste.
    return jsonError(detail, 502);
  }
}
