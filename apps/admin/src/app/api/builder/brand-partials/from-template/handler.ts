import { NextResponse } from "next/server";
import {
  createBrandPartial,
  isPositionedSlot,
  rowAPromouvoir,
  validateBrandPartialName,
  validateBrandPartialRows,
} from "@/lib/data/brand-partials";
import { findTemplate, getDraftRow } from "@/lib/data/templates";
import { jsonError, readJson, requireTemplateAccess, type requireContext } from "../../_shared";

/* Module séparé de `route.ts` : la session y est injectée, pour qu'un banc mesure la route sans cookie. */
export type Garde = () => ReturnType<typeof requireContext>;

interface Body {
  templateId?: unknown;
  slot?: unknown;
  name?: unknown;
}

/**
 * POST /api/builder/brand-partials/from-template — lève l'en-tête (ou le pied) qu'un modèle porte
 * déjà, et en fait un partial réutilisable.
 *
 * ⛔ POURQUOI CETTE ROUTE EXISTE, ET POURQUOI ELLE N'EST PAS UN LUXE. Sans elle, remplir la
 * bibliothèque signifie recomposer à la main un en-tête qui existe déjà dans quatre modèles —
 * identique à l'octet près sur Copper Kettle. Personne ne le ferait, et la fonctionnalité entière
 * resterait une table vide avec un bel écran devant.
 *
 * ⛔ PAS DE BLOC PAR CETTE ROUTE (0080). Un bloc n'a pas de place fixe dans un modèle : lever « la
 * première row » ou « celle d'avant le pied légal » prendrait l'en-tête ou le pied en croyant prendre
 * un contenu. Refus en 400 AVANT toute lecture — un bloc se crée par « New » ou par « Save this row ».
 *
 * ⚠️ ELLE LIT LE BROUILLON, pas la version publiée. C'est le document que l'auteur voit dans le
 * builder, et la publication recrée un brouillon identique juste après avoir figé la version : les
 * deux coïncident, sauf pendant qu'on édite — auquel cas c'est bien l'état à l'écran qu'on veut
 * lever, pas une version d'avant les corrections.
 *
 * ⛔ LE MODÈLE N'EST PAS MODIFIÉ. On COPIE une row vers la bibliothèque ; poser le pointeur sur des
 * modèles est un geste séparé, explicite, qui republie — ce n'est pas un effet de bord de « créer
 * un en-tête ».
 */
export async function liftFromTemplate(req: Request, garde: Garde) {
  const c = await garde();
  if (!c.ok) return c.res;
  const { db, asset, user } = c.ctx;

  const body = await readJson<Body>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  const templateId = typeof body.templateId === "string" ? body.templateId : "";
  if (!templateId) return jsonError("templateId is required", 400);
  if (body.slot === "block") {
    return jsonError(
      "a block cannot be lifted from a template — it has no fixed place there. Create it with “New”, or use “Save this row” in the builder",
      400,
    );
  }
  if (!isPositionedSlot(body.slot)) return jsonError('slot must be "header" or "footer"', 400);
  const slot = body.slot;

  const nom = validateBrandPartialName(body.name);
  if (!nom.ok) return jsonError(nom.refusal.error, nom.refusal.status);

  const template = await findTemplate(db, templateId, asset.id);
  if (!template) return jsonError("template not found", 404);

  // ⛔ Le contenu du modèle SORT vers un autre objet : c'est une lecture de son document, elle
  // demande le même droit que son ouverture. Octroi ⇒ 404, jamais 403 : un modèle non octroyé doit
  // rester indiscernable d'un inexistant.
  const refus = await requireTemplateAccess(c.ctx, template.id);
  if (refus) return refus;

  const draft = await getDraftRow(db, template.id);
  if (!draft) return jsonError("this template has no draft to lift a header or footer from", 404);

  const choisie = rowAPromouvoir(draft.doc, slot);
  if (!choisie.ok) return jsonError(choisie.refusal.error, choisie.refusal.status);

  /*
   * ⛔ ON REVALIDE LA ROW EXTRAITE, alors qu'elle vient de parser. Ce n'est pas une redondance :
   * `validateBrandPartialRows` porte le SECOND invariant, le refus du bloc `footer_legal`, et c'est
   * la seule barrière que le serveur oppose à un appel direct. La faire sauter ici parce que « la
   * source est un modèle valide » créerait un chemin d'écriture moins gardé que l'autre — et c'est
   * toujours celui-là qu'on finit par emprunter.
   */
  const rows = validateBrandPartialRows([choisie.row]);
  if (!rows.ok) {
    return NextResponse.json(
      { error: rows.refusal.error, ...(rows.refusal.issues ? { issues: rows.refusal.issues } : {}) },
      { status: rows.refusal.status },
    );
  }

  const cree = await createBrandPartial(db, {
    assetId: asset.id,
    slot,
    name: nom.name,
    rows: rows.rows,
    author: user.email,
  });
  if (!cree.ok) return jsonError(cree.refusal.error, cree.refusal.status);

  return NextResponse.json({ id: cree.id, from: { templateId: template.id, name: template.name } }, { status: 201 });
}
