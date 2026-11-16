import { NextResponse } from "next/server";
import { resolveBrandPartials } from "@/lib/data/brand-partials";
import { CanvasRenderError, renderCanvas } from "@/lib/canvas-render";
import { jsonError, readJson, type requireContext } from "../_shared";

/* Module séparé de `route.ts` : la session y est injectée pour qu'un banc la mesure sans cookie. */
export type Garde = () => ReturnType<typeof requireContext>;

const chaine = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * POST /api/builder/canvas-render — le HTML que le compilateur émet pour CHAQUE bloc du document,
 * plus la feuille de style qui va avec. C'est ce que le canvas affiche : voir `lib/canvas-render.ts`.
 *
 * ⛔ AUCUNE ÉCRITURE. Le document vient du corps de la requête ; la seule lecture en base est celle
 * des en-tête et pied de MARQUE que le document désigne (`meta.headerPartialId` / `footerPartialId`),
 * scopée sur la marque de la session par `resolveBrandPartials`.
 *
 * Contrairement à l'aperçu, cette route EXIGE la session : elle est appelée à chaque frappe, et une
 * route de compilation ouverte serait un moteur de calcul gratuit pour qui la trouve.
 *
 * Une lecture ratée des partials ne refuse pas le rendu : on compile sans, et l'avertissement
 * d'`applyBrandPartials` (« points at a brand header, but none was supplied ») remonte à l'écran.
 */
export async function canvasRenderHandler(req: Request, garde: Garde) {
  const c = await garde();
  if (!c.ok) return c.res;

  const body = await readJson<{ doc?: unknown }>(req);
  if (!body || body.doc === undefined) return jsonError("doc is required", 400);

  const meta =
    typeof body.doc === "object" && body.doc !== null
      ? ((body.doc as { meta?: unknown }).meta as Record<string, unknown> | undefined)
      : undefined;
  const lu = await resolveBrandPartials(c.ctx.db, c.ctx.asset.id, {
    headerPartialId: chaine(meta?.headerPartialId),
    footerPartialId: chaine(meta?.footerPartialId),
  });
  const partials = lu.known ? { header: lu.value.header, footer: lu.value.footer } : undefined;

  try {
    return NextResponse.json(await renderCanvas(body.doc, partials));
  } catch (err) {
    if (err instanceof CanvasRenderError) return jsonError(err.message, 400, { issues: err.issues });
    const message = err instanceof Error ? err.message : String(err);
    return jsonError(`compilation failed: ${message}`, 422);
  }
}
