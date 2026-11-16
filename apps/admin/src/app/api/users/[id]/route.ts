import { NextResponse } from "next/server";
import { deleteUser, findById, setAssets, setTemplates, updateUser } from "@/lib/data/app-user";
import { isUuid } from "@/lib/data/templates";
import { jsonError, readJson, requireSuperAdmin } from "@/app/api/builder/_shared";
import { preparerModification } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rôle, statut, « All brands » (`allAssets`) et « All templates » (`allTemplates`, 0075), et octrois
 * d'un compte. Réservé aux administrateurs.
 *
 * ⛔ Un administrateur ne peut modifier ni supprimer SON PROPRE compte ici. Ce ne sont pas des
 * gestes qu'on rattrape depuis l'interface : se rétrograder ferme la page qui permettrait de
 * revenir en arrière. Un autre administrateur le fait, ou c'est du SQL — dans les deux cas c'est
 * délibéré. Le trigger `app_user_garder_un_administrateur` garde en plus le dernier super_admin
 * actif, y compris contre une modification faite par quelqu'un d'autre.
 */

/** Le message du trigger n'est pas une panne : c'est un refus métier, il mérite un 409 lisible. */
function traduire(e: unknown): NextResponse {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("super_admin actif doit subsister")) {
    return jsonError("At least one active administrator must remain.", 409);
  }
  return jsonError(msg, 500);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const garde = await requireSuperAdmin();
  if (!garde.ok) return garde.res;
  const { db, user } = garde.ctx;

  const { id } = await params;
  if (!isUuid(id)) return jsonError("not found", 404);
  if (id === user.id) return jsonError("You cannot change your own role or access.", 409);

  const cible = await findById(db, id);
  if (!cible) return jsonError("not found", 404);

  // Validation et contrôle des octrois : handler.ts, éprouvé sans base par handler.test.ts.
  const decision = await preparerModification(await readJson<unknown>(req), cible, db);
  if (!decision.ok) return jsonError(decision.erreur, decision.statut, decision.extra);
  const { role, status, allAssets, allTemplates, assetIds, templateIds } = decision.modif;

  try {
    // ⚠️ `!== undefined` sur CHACUN des deux : `false` est une modification (retirer « All »), pas
    // une absence. Les lignes d'octroi explicites ne sont PAS effacées quand on coche « All » —
    // l'écran les renvoie inchangées — pour que décocher rende la sélection d'avant.
    if (role || status || allAssets !== undefined || allTemplates !== undefined) {
      await updateUser(db, id, { role, status, allAssets, allTemplates });
    }
    if (assetIds) await setAssets(db, id, assetIds, user.id);
    if (templateIds) await setTemplates(db, id, templateIds, user.id);
  } catch (e) {
    return traduire(e);
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const garde = await requireSuperAdmin();
  if (!garde.ok) return garde.res;
  const { db, user } = garde.ctx;

  const { id } = await params;
  if (!isUuid(id)) return jsonError("not found", 404);
  if (id === user.id) return jsonError("You cannot remove your own account.", 409);

  const cible = await findById(db, id);
  if (!cible) return jsonError("not found", 404);

  try {
    // Les deux tables d'octroi partent en cascade (0044). Les colonnes de traçabilité posées
    // ailleurs (template.created_by, template_version.author_email) sont du texte libre sans FK :
    // supprimer un compte n'efface pas qui a écrit quoi, et c'est voulu.
    await deleteUser(db, id);
  } catch (e) {
    return traduire(e);
  }

  return NextResponse.json({ ok: true });
}
