import { NextResponse } from "next/server";
import { findMedia, removeMedia, updateMediaAlt } from "@/lib/data/media";
import { jsonError, readJson, requireContext } from "../../_shared";

export const runtime = "nodejs";
// Écriture sur la médiathèque : rien à mettre en cache.
export const dynamic = "force-dynamic";

const MAX_ALT = 300;

interface PatchBody {
  alt?: unknown;
}

/**
 * PATCH /api/builder/media/[id] — modifie le texte alternatif STOCKÉ.
 *
 * C'est le défaut proposé à chaque insertion. Tant qu'il n'était pas réécriptible, un alt saisi
 * dans le sélecteur ne servait qu'une fois : la même image réinsérée ailleurs revenait muette, et
 * la publication la refusait à nouveau (`EmailDocPublishable` exige un alt).
 *
 * Un alt VIDE reste accepté : l'utilisateur doit pouvoir effacer une description fausse, et le
 * garde-fou qui compte est celui de la publication, pas celui de la bibliothèque. L'écran signale
 * l'absence d'alt, il ne l'empêche pas.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const body = await readJson<PatchBody>(req);
  if (!body || typeof body.alt !== "string") return jsonError("alt is required", 400);

  const alt = body.alt.trim();
  // Tronquer en silence produirait une description coupée au milieu d'un mot, que personne ne
  // relit : on refuse et on le dit.
  if (alt.length > MAX_ALT) return jsonError(`alt must be ${MAX_ALT} characters or less`, 400);

  let row;
  try {
    row = await updateMediaAlt(db, asset.id, id, alt);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "could not update the image", 500);
  }
  // Inexistante OU appartenant à une autre marque : la même réponse, aucun oracle d'existence.
  if (!row) return jsonError("image not found", 404);

  return NextResponse.json({ item: row });
}

/**
 * DELETE /api/builder/media/[id] — ARCHIVE l'image : elle quitte la bibliothèque, rien n'est détruit.
 *
 * Le fichier reste hébergé, volontairement : son URL est figée dans les documents déjà publiés et
 * dans les emails déjà reçus (voir `removeMedia`). La LIGNE reste elle aussi, depuis la migration
 * 0021 qui a ajouté `archived_at` : elle porte l'empreinte de déduplication, et la perdre ferait
 * qu'un re-téléversement des mêmes octets crée un SECOND fichier identique, orphelin.
 * Re-téléverser une image archivée la restaure au lieu de la dupliquer.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  // Appartenance vérifiée AVANT l'écriture : un id d'une autre marque doit être indiscernable
  // d'un id inexistant.
  const existing = await findMedia(db, asset.id, id);
  if (!existing) return jsonError("image not found", 404);

  let deleted: boolean;
  try {
    deleted = await removeMedia(db, asset.id, id);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "could not remove the image", 500);
  }
  if (!deleted) return jsonError("image not found", 404);

  // « archived », pas « removed » : la ligne et le fichier restent. Le nom du champ doit dire ce
  // qui s'est réellement passé, sinon un client en déduira qu'il peut recréer sans conflit de dédup.
  return NextResponse.json({ id, archived: true, fileRetained: true, rowRetained: true });
}
