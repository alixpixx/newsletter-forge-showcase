import { NextResponse } from "next/server";
import type { Row } from "@nf/render/schema";
import {
  archiveBrandPartial,
  countTemplatesUsingPartial,
  getBrandPartial,
  updateBrandPartial,
  validateBrandPartialName,
  validateBrandPartialRows,
} from "@/lib/data/brand-partials";
import { authorEmail } from "@/lib/data/templates";
import { jsonError, readJson, requireContext } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/builder/brand-partials/[id] — un partial PRÊT À ÊTRE APPLIQUÉ.
 *
 * Les `rows` renvoyées portent des ids fraîchement régénérés : deux appels successifs produisent
 * deux copies indépendantes. Hors marque courante, archivé ou inexistant → 404 (aucun oracle
 * d'existence inter-marques).
 *
 * `usedBy` dit combien de modèles VIVANTS de la marque pointent dessus. ⛔ Il est absent quand la
 * lecture a échoué — il ne vaut jamais 0 par défaut : « 0 modèle l'utilise » invite à l'archiver.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const lecture = await getBrandPartial(db, id, asset.id);
  if (!lecture.known) return jsonError("could not read this brand partial", 503);
  if (!lecture.value) return jsonError("brand partial not found", 404);

  const usage = await countTemplatesUsingPartial(db, asset.id, id);
  return NextResponse.json({
    ...lecture.value,
    ...(usage.known ? { usedBy: usage.value } : {}),
  });
}

interface PatchBody {
  name?: unknown;
  rows?: unknown;
  /** L'`updatedAt` que le client a lu. Voir le compare-and-swap ci-dessous. */
  baseUpdatedAt?: unknown;
}

/**
 * PATCH /api/builder/brand-partials/[id] — renomme le partial et/ou remplace ses rows.
 *
 * ⚠️ `rows` est un REMPLACEMENT complet, jamais une fusion : le builder édite le partial entier et
 * renvoie son état final. Une fusion partielle demanderait de décider quoi faire d'une row disparue,
 * et aucune réponse à cette question n'est évidente pour l'auteur.
 *
 * ⭐ Enregistrer ici met à jour TOUS les modèles qui pointent dessus — mais seulement à leur
 * prochaine PUBLICATION : le HTML est figé dans `template_version.html_shell`. La route ne prétend
 * donc rien d'autre que « c'est enregistré » ; c'est à l'écran de dire ce qu'il reste à publier.
 *
 * ⭐ `baseUpdatedAt` — COMPARE-AND-SWAP. Un partial sert plusieurs modèles, donc plusieurs
 * personnes peuvent l'ouvrir en même temps. Le client renvoie l'horodatage qu'il a lu ; s'il ne
 * correspond plus, la route répond 409 avec l'`updatedAt` du serveur au lieu d'écraser en silence
 * le travail de l'autre. Le champ reste facultatif : un appel qui ne le fournit pas écrit sans
 * garde, comme avant.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<PatchBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);
  if (body.name === undefined && body.rows === undefined) {
    return jsonError("nothing to update — send a name, rows, or both", 400);
  }

  const { id } = await params;
  // On revalide l'appartenance à la marque AVANT d'écrire : un id d'une autre marque — comme un id
  // qui n'est même pas un uuid — doit être indiscernable d'un id inexistant.
  const lecture = await getBrandPartial(db, id, asset.id);
  if (!lecture.known) return jsonError("could not read this brand partial", 503);
  if (!lecture.value) return jsonError("brand partial not found", 404);

  let name: string | undefined;
  if (body.name !== undefined) {
    const nom = validateBrandPartialName(body.name);
    if (!nom.ok) return jsonError(nom.refusal.error, nom.refusal.status);
    name = nom.name;
  }

  let rows: Row[] | undefined;
  if (body.rows !== undefined) {
    const valides = validateBrandPartialRows(body.rows);
    if (!valides.ok) {
      return NextResponse.json(
        { error: valides.refusal.error, ...(valides.refusal.issues ? { issues: valides.refusal.issues } : {}) },
        { status: valides.refusal.status },
      );
    }
    rows = valides.rows;
  }

  if (body.baseUpdatedAt !== undefined && typeof body.baseUpdatedAt !== "string") {
    return jsonError("baseUpdatedAt must be the updatedAt string you read", 400);
  }

  const r = await updateBrandPartial(db, {
    id,
    assetId: asset.id,
    name,
    rows,
    author: await authorEmail(),
    baseUpdatedAt: body.baseUpdatedAt,
  });

  if (!r.ok) {
    // Sur un conflit d'édition, l'écran a besoin de l'état du SERVEUR pour proposer de recharger :
    // un 409 nu laisserait l'auteur deviner ce qu'il doit faire de son brouillon.
    const etat = r.refusal.status === 409 ? await getBrandPartial(db, id, asset.id) : null;
    return NextResponse.json(
      {
        error: r.refusal.error,
        // ⛔ Les DEUX 409 (nom déjà pris, édition concurrente) portent le même statut et le même
        // `updatedAt` : sans ce `kind`, l'écran ne peut pas les séparer autrement qu'en lisant le
        // texte du message, et servait donc « rechargez la page » à qui avait seulement choisi un
        // nom déjà utilisé — un conseil qui ne débloque rien.
        ...(r.refusal.kind ? { kind: r.refusal.kind } : {}),
        ...(etat?.value ? { updatedAt: etat.value.updatedAt, updatedBy: etat.value.updatedBy } : {}),
      },
      { status: r.refusal.status },
    );
  }

  return NextResponse.json({ id, updated: true, updatedAt: r.updatedAt });
}

/**
 * DELETE /api/builder/brand-partials/[id] — ARCHIVE le partial, ne le détruit pas.
 *
 * ⛔ INVARIANT 4. Des modèles portent un POINTEUR vers cette ligne, y compris dans des versions déjà
 * publiées. Une suppression dure laisserait ces pointeurs dans le vide : chaque republication se
 * retrouverait incapable de résoudre son en-tête, et la seule réparation serait de rouvrir chaque
 * modèle à la main. L'archivage le retire de la bibliothèque en le laissant résoluble — les modèles
 * qui l'utilisent déjà continuent de se compiler avec.
 *
 * La réponse porte `usedBy` quand on a su le lire : c'est ce que l'écran doit montrer avant de
 * laisser archiver un en-tête qui sert encore quatre newsletters.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const lecture = await getBrandPartial(db, id, asset.id);
  if (!lecture.known) return jsonError("could not read this brand partial", 503);
  if (!lecture.value) return jsonError("brand partial not found", 404);

  const usage = await countTemplatesUsingPartial(db, asset.id, id);

  const r = await archiveBrandPartial(db, id, asset.id, await authorEmail());
  if (!r.ok) return jsonError(r.message, r.status);

  return NextResponse.json({
    id,
    archived: true,
    ...(usage.known ? { usedBy: usage.value } : {}),
  });
}
