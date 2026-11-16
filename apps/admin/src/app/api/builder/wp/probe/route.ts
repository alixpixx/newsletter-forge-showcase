import { NextResponse } from "next/server";
import { findWpSource, recordProbe } from "@/lib/data/wp-sources";
import {
  authEnvVarFor,
  hasAuthSecret,
  listTerms,
  normalizeRestRoot,
  probe,
  resolveAuth,
  type WpTerm,
} from "@nf/wp/client";
// Racine du package et non `@nf/wp/rss` : la carte `exports` n'expose pas encore ce sous-chemin.
import { probeFeedSource } from "@nf/wp";
import { jsonError, readJson, requireContext } from "../../_shared";

export const runtime = "nodejs";
// Sonder, c'est mesurer maintenant. Une réponse en cache serait exactement le contraire.
export const dynamic = "force-dynamic";

/**
 * POST /api/builder/wp/probe — mesure ce qu'un site WordPress sait faire.
 *
 * DEUX USAGES, UNE SEULE MESURE :
 *  - `{ sourceId }` : sonde une source existante ET ENREGISTRE le verdict (`status`,
 *    `capabilities`, `last_probed_at`). C'est le bouton « Tester » d'un écran de réglages.
 *  - `{ restRoot }` : sonde une URL que l'opérateur vient de taper, SANS rien écrire. C'est ce qui
 *    permet de découvrir qu'un domaine ne répond pas avant de créer une ligne qui mentirait.
 *
 * POURQUOI CETTE ROUTE EST LA SEULE PORTE SORTANTE ARBITRAIRE DU PRODUIT — et pourquoi elle passe
 * par `lib/wp/guard.ts` : l'admin tourne sur l'infrastructure qui détient la clé `service_role` de
 * Supabase. Une requête sortante pilotée par un champ texte y vaut bien plus qu'ailleurs. Le garde
 * ré-examine chaque redirection, vérifie la résolution DNS (169.254.169.254, RFC1918), plafonne le
 * temps et les octets, et LARGUE l'en-tête d'authentification dès que l'origine change.
 *
 * ⛔ La réponse ne contient jamais le mot de passe applicatif : `hasSecret` est un booléen et
 * `secretVarName` est le nom de la variable d'environnement attendue.
 */

interface ProbeBody {
  sourceId?: unknown;
  restRoot?: unknown;
  authUser?: unknown;
  /** Ramène aussi catégories et étiquettes — ce dont le sélecteur multi-catégories a besoin. */
  withTerms?: unknown;
  /** `rss` pour un site sans API REST exploitable (lumen-living, bluefin-news.example). Défaut : `wp-rest`. */
  kind?: unknown;
}

export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<ProbeBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const sourceId = typeof body.sourceId === "string" ? body.sourceId : null;

  // --- Cas 1 : une source existante. Le verdict sera écrit.
  if (sourceId) {
    const source = await findWpSource(db, sourceId, asset.id);
    if (!source) return jsonError("source not found", 404);

    const auth = resolveAuth(source.restRoot, source.authKind, source.authUser);
    // ⛔ SONDER PAR LE CHEMIN QUE LA SOURCE EMPRUNTE VRAIMENT. Une source RSS passée au lecteur
    // REST répondrait « 404 rest_no_route » et s'afficherait cassée alors qu'elle rend 43 articles.
    // Un témoin qui accuse une source qui marche est pire qu'un témoin absent.
    const result =
      source.kind === "rss" ? await probeFeedSource(source.restRoot, auth) : await probe(source.restRoot, auth);

    // On écrit AUSSI les échecs : une source cassée doit se voir dans la liste sans avoir à
    // re-cliquer. Un statut qui ne retient que les succès est un témoin qui ne témoigne de rien.
    const updated = await recordProbe(db, sourceId, asset.id, result);

    // Un flux n'a pas de taxonomies à lister : les demander à un site sans API REST rendrait un
    // `termsError` qui parle d'une panne, là où il n'y a qu'une capacité absente et déjà dite.
    const terms =
      body.withTerms === true && result.ok && source.kind !== "rss"
        ? await safeTerms(source.restRoot, auth)
        : null;

    return NextResponse.json({
      probe: result,
      source: updated
        ? {
            ...updated,
            secretVarName: authEnvVarFor(updated.restRoot),
            hasSecret: hasAuthSecret(updated.restRoot),
          }
        : null,
      ...(terms ?? {}),
    });
  }

  // --- Cas 2 : une URL tapée. Rien n'est écrit — la source n'existe pas encore.
  const restRoot = normalizeRestRoot(typeof body.restRoot === "string" ? body.restRoot : "");
  if (restRoot === "") return jsonError("restRoot is required", 400);

  const authUser = typeof body.authUser === "string" ? body.authUser.trim() : "";
  const auth = resolveAuth(restRoot, authUser ? "app_password" : "none", authUser || null);

  const isFeed = body.kind === "rss";
  const result = isFeed ? await probeFeedSource(restRoot, auth) : await probe(restRoot, auth);
  const terms = body.withTerms === true && result.ok && !isFeed ? await safeTerms(restRoot, auth) : null;

  return NextResponse.json({
    probe: result,
    secretVarName: authEnvVarFor(restRoot),
    hasSecret: hasAuthSecret(restRoot),
    // Le secret est réclamé mais absent : c'est la cause n°1 d'un 401 sur un site protégé, et la
    // dire ici évite une demi-heure de recherche côté opérateur.
    secretMissing: Boolean(authUser) && !hasAuthSecret(restRoot),
    ...(terms ?? {}),
  });
}

/**
 * Catégories et étiquettes, sans jamais faire échouer la sonde.
 *
 * Une taxonomie fermée par un plugin de sécurité est fréquente et n'empêche pas de lire les
 * articles : la remonter comme une erreur globale condamnerait une source utilisable.
 */
async function safeTerms(
  root: string,
  auth: ReturnType<typeof resolveAuth>,
): Promise<{
  categories: WpTerm[];
  tags: WpTerm[];
  termsTruncated: boolean;
  termsError: string | null;
}> {
  try {
    const [cats, tags] = await Promise.all([
      listTerms(root, auth, "categories"),
      listTerms(root, auth, "tags"),
    ]);
    return {
      categories: cats.terms,
      tags: tags.terms,
      // ⛔ Ne jamais taire une troncature : un sélecteur incomplet et muet se lit comme
      // « cette catégorie n'existe pas sur ce site ».
      termsTruncated: cats.truncated || tags.truncated,
      termsError: null,
    };
  } catch (e) {
    return {
      categories: [],
      tags: [],
      termsTruncated: false,
      termsError: e instanceof Error ? e.message : "taxonomies illisibles",
    };
  }
}
