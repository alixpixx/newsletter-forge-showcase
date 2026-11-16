import { NextResponse } from "next/server";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { traiterEffacement } from "./handler";

/**
 * POST /api/subscribers/erase — droit à l'oubli sur les personnes sélectionnées.
 *
 * Le transport seulement : la marque vient de la session, la base du client de service, et toute
 * la décision est dans `handler.ts` — qui, lui, est éprouvé. Ce chemin est le plus destructeur de
 * l'admin ; il n'avait aucun test jusqu'au 18/09/2026.
 */
export async function POST(req: Request) {
  const asset = await getCurrentAsset();
  const body = await req.json().catch(() => ({}));
  const r = await traiterEffacement(body, { assetId: asset.id, db: getDb() });
  return NextResponse.json(r.corps, { status: r.statut });
}
