import { NextResponse } from "next/server";
import { listEditionLegalFooters, updateEditionLegalFooter } from "@/lib/data/asset-editions";
import { validerConfig } from "@/lib/legal-footer-cfg";
import { jsonError, readJson, requireContext } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/builder/legal-footer/[editionId] — écrit le pied légal d'une édition.
 *
 * ⛔ CE QUE CETTE ROUTE NE TOUCHE JAMAIS. Les liens de désinscription et de préférences ne sont pas
 * dans `FooterConfig` et ne peuvent pas y entrer : ils sont signés par destinataire et calculés à
 * l'envoi. Tout ce qui passe ici est du contenu éditorial ou cosmétique.
 *
 * ⛔ LA VALIDATION VIT DANS `@/lib/legal-footer-cfg`, ET CE N'EST PAS UN RANGEMENT. Un fichier de
 * route Next.js n'accepte qu'un jeu d'exports fermé : tant que `validerConfig` vivait ici, AUCUN banc
 * ne pouvait l'exercer — et ce sont ces fonctions qui décident de ce qui part en HTML brut chez
 * chaque destinataire. Voir `lib/legal-footer-cfg.test.ts`.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ editionId: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<{ cfg?: unknown }>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const valide = validerConfig(body.cfg);
  if (!valide.ok) return jsonError(valide.error, 422);

  const { editionId } = await params;
  const r = await updateEditionLegalFooter(db, { editionId, assetId: asset.id, cfg: valide.cfg });
  if (!r.ok) return jsonError(r.error, r.status);

  // On relit pour renvoyer `missing` À JOUR : c'est la seule chose qui dise si les e-mails de cette
  // édition peuvent partir, et l'écran doit l'apprendre de la même source que le veto d'envoi.
  const relu = await listEditionLegalFooters(db, asset.id, asset.name);
  const edition = relu.known ? relu.value.find((e) => e.id === editionId) : undefined;

  return NextResponse.json({
    updated: true,
    /*
     * ⛔ ON RENVOIE LA CONFIG TELLE QU'ELLE A ÉTÉ ÉCRITE, ET C'EST INDISPENSABLE. `validerConfig`
     * NORMALISE : elle rogne les espaces, arrondit les nombres, retire les champs vides et jette les
     * clés inconnues. Ce que l'écran a envoyé n'est donc PAS ce qui est en base — un champ nombre
     * part en `"30"` (une chaîne, c'est ce que rend un `<input>`) et revient en `30`.
     * Sans ce renvoi, l'écran compare éternellement son état brut à une valeur normalisée, se croit
     * modifié après CHAQUE enregistrement réussi, et ne confirme jamais rien. Trier les clés ne
     * suffisait pas : la divergence est sur les VALEURS.
     */
    cfg: valide.cfg,
    ...(edition ? { missing: edition.missing } : {}),
  });
}
