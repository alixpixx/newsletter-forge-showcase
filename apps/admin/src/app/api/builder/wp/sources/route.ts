import { NextResponse } from "next/server";
import {
  createWpSource,
  listWpSources,
  listWpSourcesForEdition,
  type WpSourceKind,
  type WpSourceRow,
} from "@/lib/data/wp-sources";
import { authEnvVarFor, hasAuthSecret } from "@nf/wp/client";
import { jsonError, readJson, requireContext } from "../../_shared";

export const runtime = "nodejs";
// La liste porte l'état des sondes : la mettre en cache afficherait un « ok » périmé.
export const dynamic = "force-dynamic";

/**
 * Sources WordPress d'une marque (migration 0024).
 *
 * ⛔ CE QUE CETTE ROUTE NE RENVOIE JAMAIS : le mot de passe applicatif. Il n'est pas en base
 * (décision D4, Alix 20/08) et il n'est pas lu ici. On expose seulement `secretVarName` — le NOM de
 * la variable d'environnement attendue — et `hasSecret`, un booléen. C'est ce dont l'opérateur a
 * besoin pour comprendre pourquoi une sonde échoue en 401, et rien de plus.
 */

interface CreateBody {
  editionId?: unknown;
  label?: unknown;
  restRoot?: unknown;
  defaultCategories?: unknown;
  authKind?: unknown;
  authUser?: unknown;
  /**
   * `rss` pour les sites dont l'API REST ne répond pas (lumen-living.example, bluefin-news.example — mesurés 404
   * sur `/wp-json`). Sans cette clé, ces deux marques resteraient indéclarables, donc invisibles
   * pour l'assistant d'insertion : la colonne existe en base depuis 0024, il ne manquait que le
   * passage par la route.
   */
  kind?: unknown;
}

/** Enrichit une ligne de ce que seul le serveur peut savoir — sans jamais lire la valeur du secret. */
function withSecretState(row: WpSourceRow) {
  return {
    ...row,
    secretVarName: authEnvVarFor(row.restRoot),
    hasSecret: hasAuthSecret(row.restRoot),
  };
}

/**
 * GET /api/builder/wp/sources[?editionId=…]
 *
 * Sans `editionId` : toutes les sources de la marque (écran de réglages).
 * Avec : celles d'UNE édition — c'est la seule liste que la composition a le droit de proposer,
 * puisqu'une newsletter en espagnol ne doit pas pouvoir tirer des articles de la racine anglaise.
 */
export async function GET(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const editionId = new URL(req.url).searchParams.get("editionId");

  if (editionId) {
    const rows = await listWpSourcesForEdition(db, editionId, asset.id);
    return NextResponse.json({ sources: rows.map(withSecretState), error: null });
  }

  // L'erreur de lecture voyage jusqu'au client : une liste vide et un échec de lecture ne se
  // racontent pas de la même façon à l'opérateur.
  const { rows, error } = await listWpSources(asset.id);
  return NextResponse.json({ sources: rows.map(withSecretState), error });
}

/**
 * POST /api/builder/wp/sources — déclare une source.
 *
 * La source naît en `status: "unknown"` : déclarer n'est pas vérifier. C'est `POST /wp/probe` qui
 * mesure, et le sondage réel des 8 domaines des marques justifie cette prudence — un seul répond
 * proprement. Une création qui afficherait « connecté » sur la foi d'une URL bien formée mentirait
 * sept fois sur huit.
 */
export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<CreateBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const authKind = body.authKind === "app_password" ? "app_password" : "none";

  // ⛔ UNE VALEUR INCONNUE SE REFUSE, ELLE NE SE CORRIGE PAS EN SILENCE. `kind: "RSS"`, `"Rss"` ou
  // `"feed"` retombait sur `wp-rest` : on créait une source REST sur un site qui n'a pas d'API REST,
  // et l'opérateur récoltait le « 404 rest_no_route » que ce lot existe précisément pour supprimer.
  // Le défaut ne vaut que pour un `kind` ABSENT — un client qui n'en parle pas.
  if (body.kind !== undefined && body.kind !== "rss" && body.kind !== "wp-rest") {
    return jsonError('`kind` must be "wp-rest" or "rss" — use "rss" for a site whose REST API does not answer', 400);
  }
  const kind: WpSourceKind = body.kind === "rss" ? "rss" : "wp-rest";

  const result = await createWpSource(db, asset.id, {
    editionId: typeof body.editionId === "string" ? body.editionId : "",
    label: typeof body.label === "string" ? body.label : "",
    restRoot: typeof body.restRoot === "string" ? body.restRoot : "",
    kind,
    defaultCategories: Array.isArray(body.defaultCategories)
      ? body.defaultCategories.map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : [],
    authKind,
    authUser: typeof body.authUser === "string" ? body.authUser : null,
  });

  if ("error" in result) return jsonError(result.error, 400);
  return NextResponse.json({ source: withSecretState(result.row) }, { status: 201 });
}
