import { NextResponse } from "next/server";
import { findById } from "@/lib/data/app-user";
import { isUuid } from "@/lib/data/templates";
import { jsonError, readJson, requireSuperAdmin } from "@/app/api/builder/_shared";
import { definirMotDePasse } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * « Set password » depuis « Manage access ». Réservé aux administrateurs.
 *
 * ⛔ Pas sur son propre compte : « Change password » (barre latérale) exige le mot de passe actuel,
 * et cette route ne le demande pas. L'ouvrir sur soi permettrait à quiconque tient une session
 * d'administrateur restée ouverte de prendre le compte sans rien savoir.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const garde = await requireSuperAdmin();
  if (!garde.ok) return garde.res;
  const { db, user } = garde.ctx;

  const { id } = await params;
  if (!isUuid(id)) return jsonError("not found", 404);
  if (id === user.id) {
    return jsonError("To change your own password, use “Change password” at the bottom of the sidebar.", 409);
  }

  try {
    const cible = await findById(db, id);
    if (!cible) return jsonError("not found", 404);
    const r = await definirMotDePasse(await readJson<unknown>(req), cible, db, `admin:${user.email}`);
    if (!r.ok) return jsonError(r.erreur, r.statut);
    return NextResponse.json({ ok: true, activated: r.activated, status: r.status });
  } catch (e) {
    // Le message de la base reste dans les journaux du serveur ; la réponse n'en dit pas plus.
    console.error(JSON.stringify({ event: "user-password-set-failed", message: e instanceof Error ? e.message : String(e) }));
    return jsonError("The password could not be set. Try again.", 500);
  }
}
