import { NextResponse } from "next/server";
import {
  createBrandPartial,
  isBrandPartialSlot,
  listBrandPartials,
  validateBrandPartialName,
  validateBrandPartialRows,
} from "@/lib/data/brand-partials";
import { jsonError, readJson, type requireContext } from "../_shared";

/*
 * Module séparé de `route.ts` : la session y est injectée, pour qu'un banc mesure la route sans
 * cookie (même découpe que `legal-footer-templates/handler.ts`). L'auteur est lu sur la session
 * déjà résolue — `authorEmail()` relisait la même.
 */
export type Garde = () => ReturnType<typeof requireContext>;

/**
 * GET /api/builder/brand-partials — la bibliothèque VIVANTE de la marque courante : en-têtes, pieds
 * et blocs (`slot` dit lequel).
 *
 * Chaque `rows` renvoyé porte des ids NEUFS : le client peut l'insérer tel quel dans son document
 * sans dupliquer un id (les ids de rows sont humains et déjà dupliqués entre modèles en production).
 *
 * ⛔ Une lecture ratée répond 503, jamais une liste vide : « cette marque n'a pas d'en-tête » et
 * « la base n'a pas répondu » ne doivent pas s'afficher pareil — le second inviterait à en recréer
 * un par-dessus celui qui existe.
 */
export async function listPartials(garde: Garde) {
  const c = await garde();
  if (!c.ok) return c.res;

  const lecture = await listBrandPartials(c.ctx.db, c.ctx.asset.id);
  if (!lecture.known) return jsonError("could not read this brand's headers, footers and blocks", 503);

  return NextResponse.json({ brandPartials: lecture.value });
}

interface CreateBody {
  slot?: unknown;
  name?: unknown;
  rows?: unknown;
}

/**
 * POST /api/builder/brand-partials — crée un en-tête, un pied ou un bloc de marque.
 *
 * Les gardes sont ceux du serveur, pas ceux de l'écran : voir `validateBrandPartialRows` pour les
 * deux invariants (schéma des rows, refus du `footer_legal`), identiques pour les trois fentes. Une
 * UI peut être contournée par un appel direct ; ces refus-là, non.
 *
 * ⛔ LA FENTE EST UNE LISTE FERMÉE. Une valeur inconnue est refusée en 400 AVANT toute écriture : la
 * base la refuserait aussi (`brand_partial_slot_check`), mais en 500, loin de sa cause.
 */
export async function createPartial(req: Request, garde: Garde) {
  const c = await garde();
  if (!c.ok) return c.res;
  const { db, asset, user } = c.ctx;

  const body = await readJson<CreateBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  if (!isBrandPartialSlot(body.slot)) return jsonError('slot must be "header", "footer" or "block"', 400);
  const slot = body.slot;

  const nom = validateBrandPartialName(body.name);
  if (!nom.ok) return jsonError(nom.refusal.error, nom.refusal.status);

  const rows = validateBrandPartialRows(body.rows);
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

  return NextResponse.json({ id: cree.id }, { status: 201 });
}
