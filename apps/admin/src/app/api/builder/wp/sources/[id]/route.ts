import { NextResponse } from "next/server";
import {
  deleteWpSource,
  findWpSource,
  updateWpSource,
  type WpSourceRow,
} from "@/lib/data/wp-sources";
import { authEnvVarFor, hasAuthSecret } from "@nf/wp/client";
import { jsonError, readJson, requireContext } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  label?: unknown;
  restRoot?: unknown;
  /** `wp-rest` ou `rss` — réparer une source déclarée du mauvais type sans passer par du SQL. */
  kind?: unknown;
  defaultCategories?: unknown;
  authKind?: unknown;
  authUser?: unknown;
}

function withSecretState(row: WpSourceRow) {
  return {
    ...row,
    secretVarName: authEnvVarFor(row.restRoot),
    hasSecret: hasAuthSecret(row.restRoot),
  };
}

/** GET — une source de la marque courante. Une source d'une autre marque est un 404, pas un 403 : */
/*  révéler l'existence d'un identifiant appartenant à une autre marque est déjà une fuite. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const { id } = await params;
  const row = await findWpSource(c.ctx.db, id, c.ctx.asset.id);
  if (!row) return jsonError("source not found", 404);
  return NextResponse.json({ source: withSecretState(row) });
}

/**
 * PATCH — modifie une source.
 *
 * ⚠️ `editionId` n'est PAS modifiable. Déplacer une source d'une édition à l'autre changerait
 * silencieusement la langue des articles que les compositions existantes vont tirer. Pour changer
 * d'édition, on crée une source dans la bonne — c'est deux clics de plus et zéro surprise.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const { id } = await params;
  const body = await readJson<PatchBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  // Même refus qu'à la création : une valeur inconnue n'est pas corrigée en silence, sinon
  // « réparer » une source RSS mal typée la remettrait sur le chemin REST sans le dire.
  if (body.kind !== undefined && body.kind !== "rss" && body.kind !== "wp-rest") {
    return jsonError('`kind` must be "wp-rest" or "rss" — use "rss" for a site whose REST API does not answer', 400);
  }

  const result = await updateWpSource(c.ctx.db, id, c.ctx.asset.id, {
    label: typeof body.label === "string" ? body.label : undefined,
    restRoot: typeof body.restRoot === "string" ? body.restRoot : undefined,
    kind: body.kind === "rss" ? "rss" : body.kind === "wp-rest" ? "wp-rest" : undefined,
    defaultCategories: Array.isArray(body.defaultCategories)
      ? body.defaultCategories.map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : undefined,
    authKind:
      body.authKind === "app_password" ? "app_password" : body.authKind === "none" ? "none" : undefined,
    authUser: typeof body.authUser === "string" ? body.authUser : undefined,
  });

  if ("error" in result) {
    return jsonError(result.error, result.error === "source not found" ? 404 : 400);
  }
  return NextResponse.json({ source: withSecretState(result.row) });
}

/** DELETE — retire la source. Ce qui est déjà parti ne dépend pas d'elle (le contenu est copié). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const { id } = await params;
  const existing = await findWpSource(c.ctx.db, id, c.ctx.asset.id);
  if (!existing) return jsonError("source not found", 404);

  const err = await deleteWpSource(c.ctx.db, id, c.ctx.asset.id);
  if (err) return jsonError(err.error, 500);
  return NextResponse.json({ deleted: id });
}
