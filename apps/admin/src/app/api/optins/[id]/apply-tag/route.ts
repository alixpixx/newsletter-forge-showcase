import { NextResponse } from "next/server";
import { getCurrentAsset } from "@/lib/asset-context";
import { applyDefaultTag } from "@/lib/data/optins";

/**
 * Applique le tag par défaut de l'optin aux contacts DÉJÀ arrivés.
 *
 * ⛔ DEUX APPELS, PAS UN. Sans `confirm: true`, la route COMPTE et n'écrit rien — c'est ce nombre
 * qui s'affiche dans la demande de confirmation. Un geste qui touche des milliers de lignes ne doit
 * pas s'exécuter au premier clic : la personne doit voir l'effet avant de l'autoriser, et le
 * nombre annoncé doit être celui qui CHANGERA (les contacts qui portent déjà le tag ne comptent
 * pas), sinon la confirmation porte sur un chiffre faux.
 *
 * ⚠️ C'est réversible en principe (on peut retirer un tag), mais pas par un bouton d'annulation :
 * raison de plus pour compter d'abord.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const asset = await getCurrentAsset();
  if (!asset.id) return NextResponse.json({ ok: false, reason: "no-asset" }, { status: 409 });

  let confirm = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { confirm?: unknown };
    confirm = body.confirm === true;
  } catch {
    confirm = false;
  }

  const res = await applyDefaultTag(id, asset.id, !confirm);
  if (!res.ok) {
    const metier = res.reason === "optin-hors-marque" || res.reason === "aucun-tag-par-defaut";
    return NextResponse.json(res, { status: metier ? 409 : 500 });
  }
  // `applied` dit sans ambiguïté si quelque chose a été écrit : un appelant qui lirait seulement
  // `affected` ne saurait pas distinguer un décompte d'une application.
  return NextResponse.json({ ok: true, affected: res.affected ?? 0, applied: confirm });
}
