import { NextResponse } from "next/server";
import { authorEmail } from "@/lib/data/templates";
import { findWpSource } from "@/lib/data/wp-sources";
import { fetchPost, resolveAuth } from "@nf/wp/client";
import { WpFetchError } from "@nf/wp/guard";
// Racine du package et non `@nf/wp/rss` : la carte `exports` n'expose pas encore ce sous-chemin.
import { discoverFeed, parseFeed } from "@nf/wp";
import { importRemoteImage } from "@/lib/wp/media-import";
import { ArticleBlock } from "@nf/render/schema";
import { jsonError, readJson, requireContext } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/builder/wp/refresh — relit UN article chez sa source et rend l'écart.
 *
 * ⛔ CETTE ROUTE N'ÉCRIT PAS DANS LE DOCUMENT. Elle rend l'état actuel de l'article et la liste
 * des champs qui ont bougé ; c'est l'écran qui montre l'écart et l'auteur qui décide. Un
 * rafraîchissement qui applique tout seul écraserait sans prévenir un titre raccourci à la main
 * ou un extrait réécrit — le genre de perte qu'on ne remarque qu'une fois l'e-mail parti.
 *
 * ⚠️ ARTICLE DISPARU = 410, PAS UN BLOC VIDE. Dépublié, supprimé, passé en privé : le bloc reste
 * tel quel dans le document et l'auteur est prévenu. Le vider « pour être à jour » ferait
 * disparaître du contenu que personne n'a demandé à retirer.
 *
 * ⛔ ET SUR UNE SOURCE RSS, « ABSENT DU FLUX » N'EST PAS « DISPARU » : c'est 409, pas 410. Un flux
 * n'expose que ses dernières entrées ; l'article plus ancien existe toujours, on ne peut simplement
 * plus le mesurer. Confondre les deux ferait supprimer des blocs valides.
 *
 * L'image n'est rapatriée QUE si son URL d'origine a changé — et la déduplication par sha256 fait
 * que même dans ce cas, des octets déjà connus ne repartent pas dans le stockage.
 */

interface RefreshBody {
  sourceId?: unknown;
  postId?: unknown;
  /** État actuel du bloc, pour calculer l'écart. Facultatif : sans lui on rend juste le neuf. */
  current?: {
    title?: unknown;
    excerpt?: unknown;
    href?: unknown;
    imageSrc?: unknown;
    imageAlt?: unknown;
  };
  /** URL de la vignette telle qu'elle était chez la source à l'insertion — sert à savoir si elle a bougé. */
  currentRemoteImage?: unknown;
}

const str = (v: unknown, max = 2048): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * ⛔ BORNE LUE DANS LE SCHÉMA, JAMAIS RECOPIÉE. L'`alt_text` de WordPress est rédigé à la main et
 * n'a aucune limite là-bas ; posé tel quel dans le bloc, un alt de 340 caractères rend le
 * BROUILLON ENTIER insauvegardable — sur un message zod que personne ne relierait au clic
 * « Apply ». Même plafond que `packages/wp/src/feed.ts` (chemin des flux) : les deux chemins
 * d'import doivent couper au même endroit, sinon le même article passe par l'un et bloque par
 * l'autre. Un `300` en dur ici se désynchroniserait en silence le jour où le schéma bouge.
 * ⚠️ `?? Infinity` : si le schéma n'annonce plus de borne, on ne coupe plus — on n'invente pas
 * une limite que le document n'a pas.
 */
const MAX_ALT = ArticleBlock.shape.imageAlt.maxLength ?? Number.POSITIVE_INFINITY;

export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<RefreshBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const sourceId = str(body.sourceId, 64);
  const postId = str(body.postId, 40);
  if (!sourceId || !postId) return jsonError("`sourceId` and `postId` are required", 400);

  const source = await findWpSource(db, sourceId, asset.id);
  if (!source) return jsonError("source not found", 404);

  const auth = resolveAuth(source.restRoot, source.authKind, source.authUser);

  // ⛔ RELIRE PAR LE CHEMIN QUE LA SOURCE EMPRUNTE VRAIMENT — même branchement qu'en `/probe` et
  // qu'en `/posts`. `fetchPost` fait `Number(postId)` et rend `null` hors entier positif : une clé
  // RSS (`rss_d87c3416`) le faisait répondre `null` SANS AVOIR RIEN DEMANDÉ au site, et la route
  // concluait « article dépublié » sur un article vivant. lumen-living et bluefin-news.example n'ont aucune API
  // REST : c'était 100 % des blocs de ces deux marques.
  const viaFeed = source.kind === "rss";

  let fresh;
  try {
    if (viaFeed) {
      // Pas `fetchFeedPosts` : son `limit` plafonne à MAX_ARTICLES (20) alors que lumen-living publie
      // 43 entrées, et sa borne de fraîcheur écarterait justement l'entrée qu'on cherche. Ici on
      // veut TOUT le flux, sans filtre — on cherche une entrée précise, pas des candidats.
      const found = await discoverFeed(source.restRoot, auth);
      const { candidates } = parseFeed(found.body, found.url, found.redirects);
      fresh = candidates.find((c) => c.id === postId) ?? null;
    } else {
      fresh = await fetchPost(source.restRoot, auth, postId);
    }
  } catch (e) {
    const detail = e instanceof WpFetchError ? e.message : "the site could not be reached";
    return jsonError(detail, 502);
  }

  if (!fresh && viaFeed) {
    // ⛔ SURTOUT PAS « DÉPUBLIÉ ». Un flux ne porte que ses dernières entrées (mesuré le 25/08 :
    // 43 chez lumen-living, 20 chez bluefin-news.example) : au-delà, l'article existe presque toujours, il est
    // seulement sorti de la fenêtre. Dire « dépublié » ferait supprimer un bloc parfaitement valide.
    // 409 et non 410 : rien n'a disparu, c'est la mesure qui n'est plus possible.
    return jsonError(
      "this article has scrolled out of the feed — the block is left untouched, its freshness cannot be rechecked",
      409,
      { scrolledOut: true },
    );
  }

  if (!fresh) {
    // 410 Gone : l'article a existé, il n'est plus publié. Distinct du 404 « source inconnue »
    // renvoyé plus haut — deux causes différentes méritent deux réponses différentes.
    return jsonError(
      "that article is no longer published on the site — the block is left untouched",
      410,
      { gone: true },
    );
  }

  // Borné DÈS LA SOURCE, et le même texte part vers la médiathèque et vers l'écran : deux
  // versions de l'alt (une coupée, une non) mettraient le bloc et l'image en désaccord.
  // ⚠️ `str` fait aussi le `.trim()` — un alt réduit à un espace passerait le « non vide » du
  // schéma tout en étant muet pour un lecteur d'écran, donc pire qu'un vide qui, lui, se voit.
  const altDistant = str(fresh.imageAlt, MAX_ALT);

  const cur = body.current ?? {};
  const changed: string[] = [];
  if (str(cur.title, 200) !== fresh.title) changed.push("title");
  if (str(cur.excerpt, 1000) !== fresh.excerpt) changed.push("excerpt");
  if (str(cur.href) !== fresh.permalink) changed.push("link");

  // L'URL DISTANTE d'avant contre celle d'aujourd'hui. Comparer à `imageSrc` (notre URL réhébergée)
  // n'apprendrait rien : elle ne ressemble jamais à celle du site.
  const ancienneDistante = str(body.currentRemoteImage);
  const imageMoved = Boolean(fresh.imageUrl) && fresh.imageUrl !== ancienneDistante;
  if (imageMoved) changed.push("image");

  let imageSrc: string | null = null;
  let imageNote: string | null = null;

  if (imageMoved && fresh.imageUrl) {
    const imported = await importRemoteImage(db, asset, fresh.imageUrl, altDistant, await authorEmail());
    if (imported.ok) imageSrc = imported.image.url;
    else {
      imageNote = imported.reason;
      // L'image n'a pas pu être rapatriée : on retire « image » de la liste des changements
      // applicables. La proposer et livrer l'ancienne serait un écart annoncé puis non tenu.
      changed.splice(changed.indexOf("image"), 1);
    }
  }

  return NextResponse.json({
    changed,
    fetchedAt: new Date().toISOString(),
    article: {
      title: fresh.title,
      excerpt: fresh.excerpt,
      href: fresh.permalink,
      publishedAt: fresh.publishedAt,
      /**
       * L'alt de l'article TEL QU'IL EST chez la source, borné — vide compris. Ce vide est une
       * information, pas une panne : il dit qu'il n'existe aucune description de cette image.
       */
      imageAlt: altDistant,
      /** URL chez NOUS, ou `null` si l'image n'a pas changé (le bloc garde alors la sienne). */
      imageSrc,
      /** URL chez la SOURCE — à re-stocker pour la prochaine comparaison. */
      remoteImageUrl: fresh.imageUrl,
    },
    imageNote,
  });
}
