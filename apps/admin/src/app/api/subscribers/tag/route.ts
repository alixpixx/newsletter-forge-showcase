import { NextResponse } from "next/server";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { dejaTague, fusionnerTags } from "@/lib/data/subscriber-actions";

/**
 * POST /api/subscribers/tag — pose un tag de la marque sur les souscriptions sélectionnées.
 *
 * ⛔ UNION, JAMAIS REMPLACEMENT. `tag_ids` est une colonne tableau : écrire `[nouveau]` effacerait
 * les intérêts projetés par le trigger de capture et les tags déjà posés. La perte serait
 * silencieuse — l'écran afficherait simplement « un tag », ce qui a l'air normal.
 *
 * ⛔ LE TAG AUSSI EST VÉRIFIÉ. Il vient du navigateur comme les identifiants : sans le contrôle de
 * marque, un identifiant de tag d'une autre marque se poserait sur les abonnés de celle-ci, et les
 * libellés affichés viendraient d'une table que cet écran ne lit pas.
 */
export async function POST(req: Request) {
  const asset = await getCurrentAsset();
  if (!asset.id) return NextResponse.json({ ok: false, reason: "no-asset" }, { status: 409 });

  const db = getDb();
  if (!db) return NextResponse.json({ ok: false, reason: "no-db" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { ids?: unknown; tagId?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string") : [];
  const tagId = Number(body.tagId);
  if (ids.length === 0) return NextResponse.json({ ok: false, reason: "no-selection" }, { status: 400 });
  if (!Number.isInteger(tagId)) return NextResponse.json({ ok: false, reason: "no-tag" }, { status: 400 });

  const tag = await db.from("tag").select("id, label, slug").eq("id", tagId).eq("asset_id", asset.id).maybeSingle();
  if (tag.error) return NextResponse.json({ ok: false, reason: "read-failed" }, { status: 500 });
  if (!tag.data) return NextResponse.json({ ok: false, reason: "tag-hors-marque" }, { status: 409 });

  const cibles = await db.from("subscription").select("id, tag_ids").in("id", ids).eq("asset_id", asset.id);
  if (cibles.error) return NextResponse.json({ ok: false, reason: "read-failed" }, { status: 500 });

  const lignes = (cibles.data ?? []) as { id: string; tag_ids: number[] | null }[];
  let tagged = 0;
  let already = 0;
  const failed: string[] = [];

  for (const ligne of lignes) {
    if (dejaTague(ligne.tag_ids, tagId)) {
      already += 1;
      continue;
    }
    const { error } = await db
      .from("subscription")
      .update({ tag_ids: fusionnerTags(ligne.tag_ids, tagId) })
      .eq("id", ligne.id)
      // ⛔ Le filtre de marque est REJOUÉ à l'écriture, pas seulement à la lecture : entre les deux,
      // rien ne garantit que la ligne n'a pas changé de main, et une écriture non scopée serait la
      // seule à ne pas l'être de toute la route.
      .eq("asset_id", asset.id);
    if (error) failed.push(ligne.id);
    else tagged += 1;
  }

  /*
   * `missing` dit tout haut ce qu'un simple total cacherait : des identifiants sélectionnés qui ne
   * désignent aucune ligne de CETTE marque. Sans ce nombre, « 3 tagged » sur 5 cochés se lirait
   * comme une panne partielle sans cause visible.
   */
  const missing = ids.length - lignes.length;
  const label = (tag.data as { label: string | null; slug: string }).label || (tag.data as { slug: string }).slug;
  return NextResponse.json({
    ok: failed.length === 0,
    tagged,
    already,
    missing,
    failed: failed.length,
    label,
  });
}
