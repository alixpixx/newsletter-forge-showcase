import { NextResponse } from "next/server";
import { findCampaign, updateCampaign } from "@/lib/data/campaigns";
import { jsonError, readJson, requireContext } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/campaigns/[id]/content — les réglages de CONTENU d'une campagne.
 *
 * ⛔ POURQUOI UNE ROUTE À PART, ET PAS `/recurrence`. Cette dernière valide `days` et `time` et
 * rend 400 sans eux : une campagne PONCTUELLE ne pourrait alors jamais régler son mélange. Or les
 * quatre campagnes en base sont exactement dans ce cas (`recurrence_active = false`, mesuré le
 * 04/09/2026) — la route de la récurrence aurait été un verrou sur la seule population existante.
 *
 * L'axe est net : `/recurrence` règle QUAND la campagne part, celle-ci règle CE QU'ELLE CONTIENT.
 *
 * ⚠️ ELLE N'ÉCRIT RIEN D'AUTRE. `mix_latest` est le seul réglage de contenu porté par la campagne
 * aujourd'hui ; le sujet, le modèle et le segment ont leurs propres chemins, et les mélanger ici
 * ferait de cette route un fourre-tout dont personne ne saurait plus ce qu'il touche.
 */

interface ContentBody {
  /** `true` = compléter les blocs classés par vues avec les articles des 48 h non encore mesurés. */
  mixLatest?: unknown;
}

/** Message dédié quand la colonne n'existe pas encore — pas un 500 opaque. */
function migrationMessage(raw: string): string | null {
  return /mix_latest|column .* does not exist|schema cache/i.test(raw)
    ? "the article mix setting is not installed yet — migration 0049 has not been applied"
    : null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  /**
   * ⛔ UNE CAMPAGNE VERROUILLÉE REFUSE. Son contenu est déjà figé pour une date : accepter le
   * réglage rendrait une case cochée qui ne changerait rien à ce qui va partir — un interrupteur
   * qui ne commande plus rien est pire qu'un interrupteur absent, parce qu'on lui fait confiance.
   */
  if (campaign.lockedAt) {
    return jsonError(
      "this campaign's content is frozen, so changing the mix would not affect what goes out — unlock it first to change this setting.",
      409,
    );
  }

  const body = await readJson<ContentBody>(req);
  if (!body) return jsonError("invalid JSON body", 400);

  /**
   * ⛔ LISTE FERMÉE À DEUX VALEURS, et rien d'autre n'est accepté. Traiter « tout ce qui n'est pas
   * `true` » comme `false` ferait qu'une faute de frappe du client DÉSARMERAIT le mélange en
   * silence, en répondant 200 — le réglage aurait l'air enregistré et vaudrait l'inverse.
   */
  if (body.mixLatest !== true && body.mixLatest !== false) {
    return jsonError("mixLatest must be true or false", 400);
  }
  const mixLatest = body.mixLatest;

  const { error } = await updateCampaign(db, id, asset.id, { mix_latest: mixLatest });
  if (error) {
    const friendly = migrationMessage(error);
    return NextResponse.json(
      { error: friendly ?? error, migrationMissing: Boolean(friendly) },
      { status: friendly ? 503 : 500 },
    );
  }

  return NextResponse.json({ ok: true, mixLatest });
}
