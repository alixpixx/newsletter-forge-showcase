import { NextResponse } from "next/server";
import { isUuid } from "@/lib/data/templates";
import { jsonError, requireContext } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/occurrences/[id]/cancel — renoncer à UNE édition.
 *
 * ⛔ POURQUOI CETTE ROUTE EXISTE. L'écran d'une série savait déjà dire qu'une édition était perdue
 * — son heure passée, son contenu jamais gelé — et il invitait à « l'annuler ». Ce geste n'existait
 * nulle part : ni bouton, ni route. Un écran qui nomme une issue inexistante est pire qu'un écran
 * muet, parce qu'il fait chercher. Le commentaire du désarmement (`campaigns/[id]/arm`) promettait
 * lui aussi ce geste (« pour annuler une édition précise, on l'annule »). Les deux disaient vrai
 * d'une chose qui n'était pas écrite.
 *
 * ⛔ CE QUE L'ANNULATION NE FAIT PAS : LIBÉRER LA DATE. Le matérialiseur relit TOUTES les
 * occurrences d'un plan, annulées comprises, et n'en recrée jamais une sur un jour déjà connu
 * (`apps/worker/src/planner.ts:193`). C'est délibéré : ressusciter un jour qu'un humain a annulé
 * annulerait sa décision. La clé d'unicité de la base, elle, l'autoriserait
 * (`0027_campaign_occurrence.sql:216` exclut les annulées) — mais le code tranche plus strictement
 * que la base, et c'est le code qui décide. Annuler ferme donc la date, elle ne la rouvre pas.
 *
 * ⚠️ CE QUE L'ANNULATION NE REND PAS. Une édition déjà GELÉE a mémorisé ses articles dans
 * `feed_article_sent` : ils resteront exclus de l'anti-répétition des éditions suivantes pendant
 * toute la fenêtre `dedupeDays`. L'annulation ne les rend pas au stock — la réponse le dit, plutôt
 * que de laisser découvrir plus tard une édition maigre sans cause apparente.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  if (!isUuid(id)) return jsonError("invalid occurrence id", 400);

  const { data, error } = await db
    .from("campaign_occurrence")
    .select("id, seq, local_date, status")
    .eq("id", id)
    .eq("asset_id", asset.id)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("occurrence not found in this brand", 404);

  const occ = data as { id: string; seq: number; local_date: string | null; status: string };

  /*
   * LES TROIS ÉTATS ANNULABLES SONT CEUX QUI N'ONT RIEN ENVOYÉ : `planned` (rien n'est encore
   * décidé), `held` (le matérialiseur l'a retenue) et `frozen` (le contenu est arrêté mais rien
   * n'est parti). Au-delà, il y a des destinataires dans la boucle et le geste n'est plus une
   * annulation : chaque refus nomme l'état réel et où regarder, parce que « impossible » seul
   * oblige à deviner.
   */
  if (occ.status === "cancelled") {
    return jsonError("this edition is already cancelled", 409, { status: occ.status });
  }
  if (occ.status !== "planned" && occ.status !== "held" && occ.status !== "frozen") {
    const raison =
      occ.status === "sending"
        ? "this edition is already in the send queue — cancelling here would not stop the emails already claimed"
        : occ.status === "sent"
          ? "this edition has already been sent — it cannot be taken back"
          : occ.status === "failed"
            ? "this edition failed on send — cancelling would hide the failure instead of explaining it"
            : `a ${occ.status} edition cannot be cancelled`;
    return jsonError(raison, 409, { status: occ.status });
  }

  const etaitGelee = occ.status === "frozen";
  const now = new Date().toISOString();

  /*
   * ⛔ ON RELIT L'ÉCRITURE. `update().eq()` sans `.select()` rend `error: null` qu'il ait touché
   * une ligne ou zéro : un statut concurrent (le gel qui passe à `frozen` entre notre lecture et
   * notre écriture) donnerait un écran vert sur une occurrence intacte. La garde `.eq("status", …)`
   * fait le travail, le `.select()` prouve qu'elle l'a fait.
   */
  const { data: touchees, error: upErr } = await db
    .from("campaign_occurrence")
    .update({ status: "cancelled", updated_at: now })
    .eq("id", id)
    .eq("asset_id", asset.id)
    .eq("status", occ.status)
    .select("id");
  if (upErr) return jsonError(upErr.message, 500);
  if (!touchees || (touchees as unknown[]).length === 0) {
    return jsonError(
      "this edition changed while you were looking at it — reload the page and check its state before cancelling",
      409,
    );
  }

  return NextResponse.json({
    id,
    status: "cancelled",
    /** Ce qui se passe ensuite, en toutes lettres — l'opérateur ne doit pas avoir à le deviner. */
    next: "the planner will never recreate an occurrence on this day — cancelling closes the date, it does not free it",
    ...(etaitGelee
      ? { warning: "this edition was frozen — the articles it had picked stay excluded from the next editions" }
      : {}),
  });
}
