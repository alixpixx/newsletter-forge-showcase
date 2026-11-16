import { NextResponse } from "next/server";
import { findWpSource } from "@/lib/data/wp-sources";
import { audienceEnJson, fenetreParDefaut, lireAudience } from "@nf/analytics/article-views";
import { MAX_ARTICLES, fetchPosts, resolveAuth } from "@nf/wp/client";
import { WpFetchError } from "@nf/wp/guard";
// Importé depuis la racine du package et non `@nf/wp/rss` : la carte `exports` de
// `packages/wp/package.json` n'expose pas encore ce sous-chemin, et ce lot n'a pas la main dessus.
import { RSS_NO_TAXONOMY_NOTICE, fetchFeedPosts, freshnessBound, type RssFeedInfo } from "@nf/wp";
import { jsonError, requireContext } from "../../_shared";

export const runtime = "nodejs";
// Le but de cet écran est de montrer ce qui vient d'être publié. Un cache le ferait mentir.
export const dynamic = "force-dynamic";

/**
 * GET /api/builder/wp/posts — les articles candidats, tels qu'ils apparaîtront dans les cartes.
 *
 * Paramètres : `sourceId` (requis), `categories` et `tags` (listes d'ids séparées par des virgules),
 * `limit` (1..20), `after` / `before` (ISO, bornes de publication).
 *
 * SÉMANTIQUE DE FILTRAGE (décision D1) : **OU entre catégories, OU entre étiquettes, ET entre les
 * deux groupes**. C'est le comportement natif de `wp/v2/posts` ; il est INVISIBLE dans l'URL, donc
 * l'écran l'écrit en toutes lettres au-dessus du sélecteur.
 *
 * ⚠️ CETTE ROUTE NE RAPATRIE AUCUNE IMAGE. Les cartes affichent la vignette DISTANTE, dans
 * l'admin, pour choisir — c'est un écran interne, pas un email. Le réhébergement n'a lieu qu'à
 * l'insertion (`/insert`), donc uniquement pour les articles réellement retenus : sonder 20
 * articles ne doit pas remplir la médiathèque de 20 images dont 17 ne partiront jamais.
 */
function idList(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => Number(v.trim()))
    // Un id non numérique passé à `?categories=` fait répondre 400 à WordPress : on l'écarte ici,
    // où l'on sait encore de quoi on parle.
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, 30);
}

/**
 * Ce qu'un flux N'A PAS donné, dit en toutes lettres au-dessus de la grille.
 *
 * ⛔ POURQUOI CE N'EST PAS DÉCORATIF. Un flux RSS rend un `WpCandidate` de la même forme qu'une
 * lecture REST — c'est tout l'objet du lot — et cette ressemblance est précisément le piège :
 * l'écran afficherait « 0 catégorie » comme si le site n'en avait aucune, et un extrait d'un mot
 * comme si l'auteur avait mal écrit son article. Les chiffres viennent de `RssFeedInfo`, mesurés
 * sur le flux réel, jamais supposés.
 */
function feedNotices(feed: RssFeedInfo): string[] {
  const out: string[] = [];
  const n = feed.itemsInFeed;

  if (feed.filtersIgnored) {
    out.push("Category and tag filters were ignored — an RSS feed carries no taxonomy ids, so this grid is unfiltered.");
  }
  if (!feed.hasCategories) {
    out.push(RSS_NO_TAXONOMY_NOTICE);
  }
  if (!feed.fullContent) {
    out.push("This feed carries a summary, not the full article. Excerpts are as short as the site chose to make them.");
  }
  if (feed.undatedItems > 0) {
    out.push(`${feed.undatedItems} of ${n} entries have no readable publication date. They count as stale and are hidden whenever a date range is set.`);
  }
  if (feed.datesWithoutTimezone > 0) {
    out.push(`${feed.datesWithoutTimezone} of ${n} entries date without a time zone. They are read as UTC and may be off by a few hours.`);
  }
  if (feed.replacementChars > 0) {
    // ⛔ Le mojibake ne lève AUCUNE erreur : sans cette phrase, « A��o do Gr�mio » traverse la
    // grille, l'insertion et l'envoi sans que personne ne l'ait vu venir.
    out.push(`${feed.replacementChars} characters in these titles and excerpts could not be decoded — this feed does not match the character set it declares. Check any article you insert from it.`);
  }
  if (feed.itemsWithImage < n) {
    out.push(`${n - feed.itemsWithImage} of ${n} entries carry no thumbnail. Those articles are inserted without an image.`);
  }
  return out;
}

/**
 * Les vues des candidats affichés — jamais un classement du site.
 *
 * ⛔ C'EST LE SENS QUI A ÉTÉ MESURÉ. On part des articles que le filtre de catégories a déjà retenus
 * et on leur demande leur audience (33 articles sur 33 appariés, mesuré le 01/09/2026). Le sens
 * inverse — prendre le haut du classement GA4 et en faire des articles — n'existe pas ici, et il
 * ferait entrer la page d'accueil et les pages de section : sur atlas-review, un top brut sort
 * 19 pages de catégorie sur 20.
 *
 * ⚠️ L'ÉCHEC DE L'AUDIENCE N'EST PAS L'ÉCHEC DE LA ROUTE. Les articles restent choisissables sans
 * leurs vues ; c'est le bandeau de l'écran qui dit pourquoi la colonne est vide. Faire tomber la
 * route entière transformerait une propriété GA4 muette en « le site WordPress est injoignable ».
 */
async function audienceDesCandidats(
  db: Parameters<typeof lireAudience>[0],
  assetId: string,
  candidates: { permalink: string }[],
) {
  const { du, au } = fenetreParDefaut(new Date());
  const hrefs = candidates.map((c) => c.permalink).filter(Boolean);
  return lireAudience(db, assetId, hrefs, du, au);
}

export async function GET(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const params = new URL(req.url).searchParams;

  const sourceId = params.get("sourceId") ?? "";
  if (!sourceId) return jsonError("`sourceId` is required", 400);

  const source = await findWpSource(db, sourceId, asset.id);
  if (!source) return jsonError("source not found", 404);

  const rawLimit = Number(params.get("limit") ?? "5");
  const limit = Number.isFinite(rawLimit) ? Math.min(MAX_ARTICLES, Math.max(1, Math.trunc(rawLimit))) : 5;

  // ⛔ LES BORNES SE VALIDENT ICI, POUR LES DEUX CHEMINS. `after`/`before` arrivaient bruts : côté
  // REST WordPress répondait 400 (que la route traduisait en 502 « le site est injoignable » —
  // faux, c'est la saisie), côté RSS `Date.parse("hier")` rendait `NaN` et la borne était AVALÉE
  // (mesuré : 20 articles rendus comme si aucune fenêtre n'avait été demandée). Deux chemins, deux
  // mensonges différents. 400 en nommant le paramètre : c'est une saisie à corriger, pas une panne.
  const after = params.get("after");
  const before = params.get("before");
  try {
    freshnessBound(after, "after");
    freshnessBound(before, "before");
  } catch (e) {
    return jsonError(e instanceof WpFetchError ? e.message : "invalid date range", 400);
  }

  const auth = resolveAuth(source.restRoot, source.authKind, source.authUser);

  try {
    // Le tiers du parc qui n'a pas d'API REST (lumen-living, bluefin-news.example) passe par le lecteur de flux.
    // ⛔ Le branchement est ICI et nulle part ailleurs : la sortie est le MÊME `WpCandidate`, donc
    // `/insert` et son réhébergement de vignettes ne voient aucune différence — c'est la condition
    // pour que le bandeau de provenance sache lire tous les blocs, pas seulement la moitié.
    if (source.kind === "rss") {
      const { candidates, feed } = await fetchFeedPosts(source.restRoot, auth, {
        limit,
        after: after ?? undefined,
        before: before ?? undefined,
        // Passés pour être SIGNALÉS ignorés, pas pour être appliqués : cf. `feedNotices`.
        categories: idList(params.get("categories")),
        tags: idList(params.get("tags")),
      });
      return NextResponse.json({
        candidates,
        fetchedAt: feed.fetchedAt,
        feed,
        feedNotices: feedNotices(feed),
        audience: audienceEnJson(await audienceDesCandidats(db, asset.id, candidates)),
      });
    }

    // ⚠️ `limit` est plafonné plus haut à `MAX_ARTICLES` : cet écran sert à INSÉRER des articles à
    // la main, pas à classer un pool. La pagination de `fetchPosts` ne se déclenche donc pas ici,
    // et `total`/`truncated` n'auraient rien à dire de plus que la liste elle-même.
    const { candidates } = await fetchPosts(source.restRoot, auth, {
      categories: idList(params.get("categories")),
      tags: idList(params.get("tags")),
      limit,
      after: after ?? undefined,
      before: before ?? undefined,
    });

    return NextResponse.json({
      candidates,
      // L'heure de la mesure, pour que l'écran puisse dire « il y a 2 minutes » plutôt que de
      // laisser croire que la liste est éternellement fraîche.
      fetchedAt: new Date().toISOString(),
      audience: audienceEnJson(await audienceDesCandidats(db, asset.id, candidates)),
    });
  } catch (e) {
    const detail = e instanceof WpFetchError ? e.message : "the site could not be reached";
    // 502 et non 200 avec une liste vide : « aucun article ne correspond » et « le site est
    // injoignable » amènent l'auteur à faire deux choses différentes.
    return jsonError(detail, 502);
  }
}
