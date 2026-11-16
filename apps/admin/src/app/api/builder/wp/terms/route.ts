import { NextResponse } from "next/server";
import { findWpSource } from "@/lib/data/wp-sources";
import { listTerms, resolveAuth } from "@nf/wp/client";
import { WpFetchError } from "@nf/wp/guard";
// Racine du package et non `@nf/wp/rss` : la carte `exports` n'expose pas encore ce sous-chemin.
import { RSS_NO_TAXONOMY_NOTICE } from "@nf/wp";
import { jsonError, requireContext } from "../../_shared";

export const runtime = "nodejs";
// Les catégories d'un site changent sans nous prévenir : jamais de cache de route.
export const dynamic = "force-dynamic";

/**
 * GET /api/builder/wp/terms — catégories ou étiquettes d'une source, pour le sélecteur.
 *
 * Paramètres : `sourceId` (requis), `taxonomy` = `categories|tags`, `q` (recherche).
 *
 * POURQUOI LA RECHERCHE PART CHEZ WORDPRESS ET NON DANS LE NAVIGATEUR. atlas-review.example déclare
 * 43 857 étiquettes. Charger « les 300 plus utilisées » puis filtrer localement donnerait un
 * sélecteur qui répond « aucun résultat » pour 43 557 étiquettes qui existent pourtant. Un filtre
 * local sur une liste tronquée ne cherche pas : il ment. `?search=` interroge tout le site.
 *
 * ⚠️ `truncated` est REMONTÉ, jamais avalé : une liste coupée en silence se lit comme « cette
 * catégorie n'existe pas ici ».
 */
export async function GET(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const params = new URL(req.url).searchParams;

  const sourceId = params.get("sourceId") ?? "";
  if (!sourceId) return jsonError("`sourceId` is required", 400);

  const taxonomy = params.get("taxonomy") ?? "categories";
  if (taxonomy !== "categories" && taxonomy !== "tags") {
    return jsonError('`taxonomy` must be "categories" or "tags"', 400);
  }

  // Portée marque : la source d'une autre marque est indiscernable d'une source inexistante.
  const source = await findWpSource(db, sourceId, asset.id);
  if (!source) return jsonError("source not found", 404);

  // ⛔ UNE CAPACITÉ ABSENTE N'EST PAS UNE PANNE. Demander `/wp-json/wp/v2/categories` à une source
  // RSS partait vers un site sans API REST : mesuré le 25/08, lumen-living et bluefin-news.example répondent tous
  // deux 404, et cette route en faisait un 502 « le site a répondu 404 » — l'opérateur lit une
  // panne et va vérifier son réseau, là où il n'y a rien à réparer. Même garde qu'en `/probe`, même
  // phrase qu'au-dessus de la grille (`RSS_NO_TAXONOMY_NOTICE`) : 200, liste vide, cause nommée.
  if (source.kind === "rss") {
    return NextResponse.json({
      terms: [],
      truncated: false,
      unavailable: "rss",
      notice: RSS_NO_TAXONOMY_NOTICE,
    });
  }

  const auth = resolveAuth(source.restRoot, source.authKind, source.authUser);

  try {
    const { terms, truncated } = await listTerms(source.restRoot, auth, taxonomy, params.get("q") ?? "");
    return NextResponse.json({ terms, truncated });
  } catch (e) {
    // Le site distant est en panne : ce n'est PAS une liste vide. Un sélecteur vide et muet
    // ferait conclure « ce site n'a pas de catégories », et l'auteur composerait sans filtre.
    const detail = e instanceof WpFetchError ? e.message : "the site could not be reached";
    return jsonError(detail, 502);
  }
}
