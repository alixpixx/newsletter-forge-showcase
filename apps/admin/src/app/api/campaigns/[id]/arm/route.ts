import { NextResponse } from "next/server";
import {
  OCCURRENCES_ARRETABLES,
  cancelUpcomingOccurrences,
  findCampaign,
  findPublishedVersionRef,
  updateCampaign,
} from "@/lib/data/campaigns";
import { jsonError, requireContext } from "@/app/api/builder/_shared";
import { migrationMessage, postArm } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/campaigns/[id]/arm — POST démarre une série (« Start series »), DELETE l'arrête
 * (« Stop series »), GET dit ce que l'arrêt annulerait.
 *
 * ⚠️ « arm » ne vit plus que dans cette URL et dans le code : à l'écran, une série est « Running »
 * ou « Stopped » (Alix, 22/09/2026). Renommer la route aurait cassé les appels sans rien rendre plus
 * clair à personne — c'est le vocabulaire affiché qui trompait, pas le chemin.
 *
 * Le contrat de POST (préconditions, finalité, aperçu honnête) est dans `handler.ts`, testé.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return postArm(req, ctx, {
    requireContext,
    versionPubliee: findPublishedVersionRef,
    maintenant: () => new Date(),
  });
}

/**
 * LES ÉDITIONS ENCORE À VENIR — celles que l'arrêt annule.
 *
 * ⛔ CE QUE CE DÉCOMPTE EXISTE POUR DIRE. Arrêter la série ne stoppe que la CRÉATION de nouvelles
 * dates : ni le gel (`planner-db.ts`) ni la mise en file (`fanout-db.ts`) ne lisent
 * `recurrence_active`. Une édition déjà planifiée gèle et part, série arrêtée ou non — d'où
 * l'annulation systématique au DELETE (décision d'Alix du 18/09/2026). L'écran ne peut annoncer ce
 * qu'il annule que s'il a le chiffre.
 *
 * Les trois statuts retenus sont ceux qu'un humain peut encore arrêter — la liste vit dans
 * `@/lib/data/campaigns` (`OCCURRENCES_ARRETABLES`), parce que trois gestes s'en servent :
 * arrêter la série, retirer la cadence, et annuler une édition seule.
 */

/**
 * GET — l'état de la série, tel que l'écran doit l'annoncer AVANT d'agir.
 *
 * Sert la confirmation de « Stop series » : elle nomme les dates qui seront annulées.
 * Le décompte est fait en base et non dérivé de la liste affichée — celle-ci est plafonnée à 40
 * lignes, et un compte tiré d'une liste tronquée est un compte faux.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  const { data, error } = await db
    .from("campaign_occurrence")
    .select("id, scheduled_at, status")
    .eq("campaign_id", id)
    .eq("asset_id", asset.id)
    .in("status", OCCURRENCES_ARRETABLES)
    .gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true });
  if (error) {
    const friendly = migrationMessage(error.message);
    return jsonError(friendly ?? error.message, friendly ? 503 : 500);
  }

  const rows = (data ?? []) as unknown as { scheduled_at: string | null }[];
  return NextResponse.json({
    active: campaign.recurrenceActive,
    upcoming: {
      count: rows.length,
      dates: rows.map((r) => r.scheduled_at).filter((v): v is string => typeof v === "string"),
    },
  });
}

/**
 * DELETE — arrêter la série. `?cancelUpcoming=1` annule EN PLUS les éditions déjà prévues ; les
 * deux écrans qui arrêtent une série le passent TOUJOURS (`desarmement.test.ts` le garde).
 *
 * ⛔ POURQUOI CE N'EST PAS LE DÉFAUT DE LA ROUTE, ET POURQUOI CE N'EST PLUS IMPOSSIBLE NON PLUS. Les occurrences
 * gelées portent un contenu arrêté pour une date : les effacer d'office ferait disparaître sans
 * trace des éditions qu'un humain avait validées. Mais ne PAS pouvoir les arrêter depuis le même
 * geste laissait l'utilisateur croire qu'il avait éteint sa série alors qu'elle continuait
 * d'envoyer — décision d'Alix du 18/09/2026 : la confirmation compte les éditions concernées et
 * laisse choisir.
 *
 * ⚠️ ANNULER NE ROUVRE PAS LA DATE. Le matérialiseur ne recrée jamais un jour déjà connu, annulé
 * compris (`planner.ts`). Réarmer plus tard ne rattrapera donc pas ces dates-là. Et une édition
 * déjà gelée a brûlé ses articles dans `feed_article_sent` : l'annulation ne les rend pas au stock.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  const { error } = await updateCampaign(db, id, asset.id, { recurrence_active: false });
  if (error) {
    const friendly = migrationMessage(error);
    return NextResponse.json({ error: friendly ?? error, migrationMissing: Boolean(friendly) }, { status: friendly ? 503 : 500 });
  }

  // ⛔ L'ANNULATION VIENT APRÈS LE DÉSARMEMENT, JAMAIS AVANT. Dans l'autre ordre, un échec à
  // mi-chemin laisserait une série ARMÉE dont les éditions viennent d'être annulées : le
  // matérialiseur en recréerait aussitôt de nouvelles, et le geste aurait produit l'inverse de ce
  // qu'il annonce.
  let annulees = 0;
  if (new URL(req.url).searchParams.get("cancelUpcoming") === "1") {
    const { cancelled, error: cancelErr } = await cancelUpcomingOccurrences(db, id, asset.id);
    if (cancelErr) {
      // La série EST désarmée : on ne rend pas une erreur qui ferait croire le contraire. On dit ce
      // qui a marché et ce qui n'a pas marché, dans la même réponse.
      return NextResponse.json(
        { ok: true, active: false, cancelled: 0, cancelError: cancelErr },
        { status: 207 },
      );
    }
    annulees = cancelled;
  }

  return NextResponse.json({ ok: true, active: false, cancelled: annulees });
}
