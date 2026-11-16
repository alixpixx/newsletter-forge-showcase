import { NextResponse } from "next/server";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { BOM_UTF8, nomDeFichierCsv, tableauCsv } from "@/lib/csv";
import { ENTETES_EXPORT, ligneExport, MAX_LIGNES } from "@/lib/data/subscriber-actions";
import type { EngLevel, SubscriberRow, TagInfo } from "@/lib/data/subscribers";

/**
 * POST /api/subscribers/export — les souscriptions sélectionnées, en CSV.
 *
 * ⛔ POST ET NON GET, alors que c'est une lecture : la liste des identifiants dépasse vite ce qu'une
 * URL accepte, et une URL portant des identifiants d'abonnés atterrit dans les journaux du proxy et
 * l'historique du navigateur. Le corps de requête n'y atterrit pas.
 *
 * ⛔ SCOPÉ MARQUE, SANS EXCEPTION. Les identifiants viennent du navigateur : sans le `eq(asset_id)`,
 * un identifiant deviné ou recopié ferait sortir l'abonné d'une AUTRE marque dans un fichier. Les
 * lignes hors marque ne sont pas refusées bruyamment — elles n'existent simplement pas pour cette
 * requête, exactement comme une campagne d'une autre marque rend 404.
 */

export async function POST(req: Request) {
  const asset = await getCurrentAsset();
  if (!asset.id) return NextResponse.json({ ok: false, reason: "no-asset" }, { status: 409 });

  const db = getDb();
  if (!db) return NextResponse.json({ ok: false, reason: "no-db" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string") : [];
  if (ids.length === 0) return NextResponse.json({ ok: false, reason: "no-selection" }, { status: 400 });
  if (ids.length > MAX_LIGNES) {
    return NextResponse.json({ ok: false, reason: "too-many", max: MAX_LIGNES }, { status: 413 });
  }

  const [liste, tagList] = await Promise.all([
    db
      .from("subscription")
      .select(
        "id, status, country, engagement_score, engagement_level, created_at, tag_ids, interest_ids, capture_event_count, granted_purposes, subscriber:subscriber_id(email, first_name)",
      )
      .in("id", ids)
      .eq("asset_id", asset.id),
    db.from("tag").select("id, slug, label, kind").eq("asset_id", asset.id),
  ]);

  if (liste.error) return NextResponse.json({ ok: false, reason: "read-failed" }, { status: 500 });

  const tags: Record<number, TagInfo> = {};
  for (const t of tagList.data ?? []) {
    const r = t as { id: number; slug: string; label: string | null; kind: string | null };
    tags[r.id] = { slug: r.slug, label: r.label || r.slug, kind: r.kind === "interest" ? "interest" : "manual" };
  }

  const rows: SubscriberRow[] = ((liste.data ?? []) as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown> & { subscriber?: { email?: string; first_name?: string | null } };
    return {
      id: String(r.id ?? ""),
      email: r.subscriber?.email ?? "",
      first_name: r.subscriber?.first_name ?? null,
      status: String(r.status ?? ""),
      source: null,
      country: (r.country as string | null) ?? null,
      engagement_score: Number(r.engagement_score ?? 0),
      engagement_level: (r.engagement_level as EngLevel) ?? "churned",
      created_at: String(r.created_at ?? ""),
      tag_ids: (r.tag_ids as number[]) ?? [],
      optin_id: null,
      capture_campaign_id: null,
      capture_campaign_ids: [],
      capture_optin_ids: [],
      interest_ids: (r.interest_ids as number[]) ?? [],
      capture_event_count: Number(r.capture_event_count ?? 0),
      purposes: (r.granted_purposes as Record<string, boolean>) ?? {},
    };
  });

  // Trié par adresse : deux exports de la même sélection doivent donner le même fichier, sinon
  // comparer deux versions d'une liste devient impossible.
  rows.sort((a, b) => a.email.localeCompare(b.email));

  const csv = tableauCsv([...ENTETES_EXPORT], rows.map((r) => ligneExport(r, tags)));
  const jour = new Date().toISOString().slice(0, 10);
  const nom = nomDeFichierCsv(`${asset.name || "subscribers"}-subscribers`, jour);

  return new NextResponse(BOM_UTF8 + csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nom}"`,
      // Un export est une photographie d'un instant : rien à mettre en cache, ni chez le navigateur
      // ni chez le proxy, qui resservirait une liste périmée sous le nom du jour.
      "Cache-Control": "no-store",
    },
  });
}
