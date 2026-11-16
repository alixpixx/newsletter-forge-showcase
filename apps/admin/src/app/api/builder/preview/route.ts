import { NextResponse } from "next/server";
import { EmailDoc, type Row } from "@nf/render/schema";
import { compileDoc } from "@nf/render/compile";
import { weighShell } from "@/lib/weight";
import { resolveBrandPartials } from "@/lib/data/brand-partials";
import { getLegalFooterTemplate, legalTemplateIdOf } from "@/lib/data/legal-footer-templates";
import { issuesOf, jsonError, readJson, requireContext } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PreviewBody {
  doc?: unknown;
}

/**
 * POST /api/builder/preview — compile un document SANS rien écrire.
 *
 * MJML pèse trop pour tourner dans le navigateur ; l'aperçu passe donc par le serveur. Aucune
 * lecture ni écriture en base : le document vient entièrement du corps de la requête, ce qui rend
 * cette route inoffensive vis-à-vis du scope marque (elle ne peut divulguer aucune donnée).
 *
 * ⚠️ Le HTML renvoyé contient les tokens `{{…}}` NON résolus : c'est le `html_shell`, exactement
 * ce qui sera stocké à la publication. L'hydratation par destinataire est l'affaire du worker.
 *
 * ⚠️ La marque n'est lue QUE pour peser l'email hydraté (`hydratedBytes`), et rien de ce qu'on lit
 * là n'est renvoyé : la réponse ne porte qu'un nombre d'octets. Sans ce poids, le pré-vol jugerait
 * le shell pendant que `POST …/publish` juge l'email complet, et toute une bande de documents
 * s'afficherait verte avant de se faire refuser en 422 — voir le POURQUOI sur `CompiledFacts`.
 */
export async function POST(req: Request) {
  const body = await readJson<PreviewBody>(req);
  if (!body || body.doc === undefined) return jsonError("doc is required", 400);

  const parsed = EmailDoc.safeParse(body.doc);
  if (!parsed.success) return jsonError("invalid document", 400, { issues: issuesOf(parsed.error) });

  /*
   * ⚠️ LA MARQUE EST LUE AVANT LA COMPILATION DEPUIS QUE L'EN-TÊTE EST UN POINTEUR. Elle servait
   * seulement à peser l'e-mail hydraté ; il faut désormais résoudre `doc.meta.*PartialId` pour que
   * l'aperçu montre ce que le lecteur recevra — un aperçu sans l'en-tête est un aperçu faux.
   *
   * ⛔ MAIS ON NE REFUSE JAMAIS UN APERÇU. C'est la seule des cinq entrées du compilateur qui
   * n'écrit rien et n'envoie rien : si la lecture échoue, on compile SANS partials, et
   * `applyBrandPartials` pousse alors son avertissement — « this email points at a brand header,
   * but none was supplied » — que l'écran affiche déjà avec les autres. Refuser priverait l'auteur
   * de son brouillon pour une panne qui ne le concerne pas ; mentir serait pire.
   */
  const c = await requireContext();
  let partials: { header: Row[]; footer: Row[] } | undefined;
  if (c.ok) {
    const resolu = await resolveBrandPartials(c.ctx.db, c.ctx.asset.id, parsed.data.meta);
    if (resolu.known) partials = { header: resolu.value.header, footer: resolu.value.footer };
  }

  try {
    const { html, text, warnings, sizeBytes } = await compileDoc(parsed.data, partials);

    // Le poids hydraté demande la marque. Si le contexte manque, on rend l'aperçu quand même :
    // perdre la mesure du poids ne justifie pas de perdre l'aperçu, et le pré-vol sait retomber
    // sur `sizeBytes` — en sous-estimant, donc sans jamais bloquer à tort.
    let hydratedBytes: number | undefined;
    if (c.ok) {
      // Le pied pesé est celui que l'e-mail a choisi. Illisible ⇒ on pèse celui de l'édition : un
      // aperçu ne refuse jamais, et la publication, elle, refusera ce choix introuvable.
      const choixId = legalTemplateIdOf(parsed.data);
      const choix = choixId
        ? await getLegalFooterTemplate(c.ctx.db, choixId, c.ctx.asset.id, { includeArchived: true })
        : null;
      const weight = await weighShell(html, c.ctx.asset.id, c.ctx.asset.name, choix?.value?.config ?? null);
      hydratedBytes = weight.hydratedBytes;
    }

    return NextResponse.json({ html, text, warnings, sizeBytes, hydratedBytes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError(`compilation failed: ${message}`, 422);
  }
}
