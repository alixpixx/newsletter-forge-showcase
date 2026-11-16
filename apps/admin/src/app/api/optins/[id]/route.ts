import { NextResponse } from "next/server";
import { getCurrentAsset } from "@/lib/asset-context";
import { setDefaultTag } from "@/lib/data/optins";

/**
 * Le tag par défaut d'un optin — celui que porteront les PROCHAINS contacts de ce formulaire.
 *
 * ⚠️ Ce geste ne touche aucun contact déjà arrivé. C'est délibéré (décision d'Alix du 08/09/2026) :
 * poser un tag et retaguer rétroactivement des milliers de personnes sont deux décisions
 * différentes, et les fondre en un seul clic ferait de la seconde un effet de bord de la première.
 * Le rétroactif est `POST …/apply-tag`, avec son compte et sa confirmation.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const asset = await getCurrentAsset();
  if (!asset.id) return NextResponse.json({ ok: false, reason: "no-asset" }, { status: 409 });

  let tagId: number | null;
  try {
    const body = (await req.json()) as { tagId?: unknown };
    // `null` est une valeur légitime : retirer le tag par défaut doit être possible.
    if (body.tagId === null || body.tagId === undefined) tagId = null;
    else if (typeof body.tagId === "number" && Number.isInteger(body.tagId)) tagId = body.tagId;
    else return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  } catch {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  const res = await setDefaultTag(id, asset.id, tagId);
  if (!res.ok) {
    // 409 et non 500 : « ce tag n'est pas de cette marque » est un refus métier, pas une panne.
    const code = res.reason === "optin-hors-marque" || res.reason === "tag-hors-marque" ? 409 : 500;
    return NextResponse.json(res, { status: code });
  }
  return NextResponse.json({ ok: true, tagId });
}
