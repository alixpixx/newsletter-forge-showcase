import { NextResponse } from "next/server";
import { buildCampaignPatch, listCampaigns, type CampaignBody } from "@/lib/data/campaigns";
import { authorEmail } from "@/lib/data/templates";
import { jsonError, readJson, requireContext } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
// Une campagne change d'état à chaque action : jamais de cache de route.
export const dynamic = "force-dynamic";

/**
 * GET /api/campaigns — campagnes de la marque courante, celles de l'onglet actif par défaut.
 * `?archived=1` rend l'onglet Archived. ⚠️ Comparaison FERMÉE : toute autre valeur = onglet actif.
 */
export async function GET(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;

  const archived = new URL(req.url).searchParams.get("archived") === "1";
  const campaigns = await listCampaigns(c.ctx.asset.id, { archived });
  return NextResponse.json({ campaigns });
}

/**
 * POST /api/campaigns — crée une campagne au statut `draft`.
 *
 * Seul `name` est exigé : une campagne naît comme une intention vague et se précise (contenu,
 * segment, finalité) au fil de l'assistant. Les garde-fous qui comptent — verrou puis
 * planification — vérifient l'exhaustivité au moment où elle devient nécessaire, pas avant.
 *
 * ⛔ Rien n'est mis en file ici : la création d'une campagne n'envoie AUCUN email.
 */
export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<CampaignBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);
  if (body.name === undefined) return jsonError("name is required", 400);

  const built = await buildCampaignPatch(db, asset.id, body);
  if (!built.ok) return jsonError(built.error, built.status);

  const { data, error } = await db
    .from("campaign")
    .insert({
      asset_id: asset.id,
      status: "draft",
      // `subject` est NOT NULL en base : la colonne a un défaut, mais un PATCH partiel ne doit
      // jamais pouvoir insérer null — on pose explicitement la chaîne vide.
      subject: "",
      ...built.patch,
      created_by: await authorEmail(),
    })
    .select("id")
    .single();

  if (error || !data) return jsonError(error?.message ?? "could not create campaign", 500);

  return NextResponse.json({ id: String((data as { id: string }).id) }, { status: 201 });
}
