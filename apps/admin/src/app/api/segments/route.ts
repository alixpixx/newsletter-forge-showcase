import { NextResponse } from "next/server";
import { jsonError, readJson, requireContext } from "@/app/api/builder/_shared";
import { isValidRule, listSegments } from "@/lib/data/segments";
import { authorEmail } from "@/lib/data/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/segments — segments enregistrés de la marque courante. */
export async function GET() {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const segments = await listSegments(c.ctx.asset.id);
  return NextResponse.json({ segments });
}

interface CreateBody {
  name?: unknown;
  rule?: unknown;
  cachedCount?: unknown;
}

/**
 * POST /api/segments — enregistre un segment.
 *
 * On stocke la RÈGLE, jamais une liste d'abonnés : un segment figé mentirait dès le lendemain et,
 * pire, court-circuiterait le re-contrôle du consentement au moment de l'envoi.
 *
 * `cachedCount` est accepté parce que l'écran vient de le calculer et que le recalculer ici doublerait
 * la requête — mais c'est un AFFICHAGE horodaté, jamais une autorisation d'envoi.
 */
export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<CreateBody>(req);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return jsonError("name is required", 400);
  if (name.length > 120) return jsonError("name must be 120 characters or less", 400);

  if (!isValidRule(body?.rule)) {
    return jsonError("rule must be a group with a conditions array", 400);
  }

  const cached = typeof body?.cachedCount === "number" && Number.isFinite(body.cachedCount) ? Math.max(0, Math.trunc(body.cachedCount)) : null;

  const { data, error } = await db
    .from("segment")
    .insert({
      asset_id: asset.id,
      name,
      kind: "dynamic",
      rule_json: body.rule,
      cached_count: cached,
      cached_at: cached === null ? null : new Date().toISOString(),
      created_by: await authorEmail(),
    })
    .select("id")
    .single();

  if (error || !data) return jsonError(error?.message ?? "could not create segment", 500);

  return NextResponse.json({ id: String((data as { id: string }).id) }, { status: 201 });
}
