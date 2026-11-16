import { NextResponse } from "next/server";
import { authorEmail, isUuid } from "@/lib/data/templates";
import { jsonError, requireContext } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/occurrences/[id]/duplicate-ack — « envoie-la quand même ».
 *
 * CE QUE CETTE ROUTE EXISTE POUR RÉSOUDRE. Le matérialiseur retient une occurrence dont le contenu
 * est identique au précédent : sans elle, les abonnés recevraient deux fois le même e-mail. Mais
 * renvoyer le même contenu est parfois délibéré — une relance, un rattrapage d'audience, une
 * édition « best of ». La machine ne peut pas trancher ça ; elle peut seulement s'assurer qu'un
 * humain l'a fait, et laisser une trace de qui.
 *
 * ⛔ POURQUOI ON ÉCRIT UNE DÉCISION ET PAS SEULEMENT UN STATUT. Repasser l'occurrence en `planned`
 * sans mémoriser l'accord ne servirait à rien : la passe suivante du matérialiseur, cinq minutes
 * plus tard, retrouverait la même empreinte et la re-bloquerait. `duplicate_ack_at` est ce qui
 * rend le geste DURABLE — c'est la différence entre un bouton et un bouton qui marche.
 *
 * ⛔ CE QUE CETTE ROUTE NE FAIT PAS : envoyer. Elle remet l'occurrence dans la file de gel du
 * matérialiseur, rien d'autre. Aucun e-mail n'est mis en file ici, et il n'y a d'ailleurs pas
 * encore de chemin qui le ferait (S-6 n'est pas livré).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  if (!isUuid(id)) return jsonError("invalid occurrence id", 400);

  const author = await authorEmail();
  if (!author) {
    // La contrainte `occurrence_dup_ack_complete` (0028) refuse un accord sans auteur. On le dit
    // ici plutôt que de laisser Postgres répondre à notre place.
    return jsonError("no signed-in user — this decision has to carry a name", 401);
  }

  const { data, error } = await db
    .from("campaign_occurrence")
    .select("id, asset_id, seq, local_date, status, hold_reason, duplicate_of, duplicate_ack_at")
    .eq("id", id)
    .eq("asset_id", asset.id)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("occurrence not found in this brand", 404);

  const occ = data as {
    id: string;
    seq: number;
    local_date: string | null;
    status: string;
    hold_reason: string | null;
    duplicate_of: string | null;
    duplicate_ack_at: string | null;
  };

  if (occ.duplicate_ack_at) {
    return jsonError("this edition is already authorised — it will freeze on the next pass", 409, {
      duplicateAckAt: occ.duplicate_ack_at,
    });
  }

  // Chaque refus nomme le statut réel : « impossible » sans raison oblige à deviner la suite.
  if (occ.status !== "held") {
    const raison =
      occ.status === "planned"
        ? "this edition is not held — there is nothing to authorise"
        : occ.status === "frozen"
          ? "this edition is already frozen — its content is settled"
          : occ.status === "sent"
            ? "this edition has already been sent"
            : `a ${occ.status} edition cannot be authorised`;
    return jsonError(raison, 409, { status: occ.status });
  }

  // ⛔ On n'autorise que le doublon. Une occurrence retenue pour CONTENU PÉRIMÉ ne se lève pas
  // d'un clic : la réponse à « ces articles ont douze jours » est de republier, pas de passer
  // outre. Confondre les deux ferait de ce bouton un « ignorer tous les avertissements ».
  if (!occ.duplicate_of) {
    return jsonError(
      "this edition is held for another reason than a duplicate and will not be sent — republish the template, then open the campaign and save it so its next editions use the new version",
      409,
      { holdReason: occ.hold_reason },
    );
  }

  const now = new Date().toISOString();
  const { error: upErr } = await db
    .from("campaign_occurrence")
    .update({
      status: "planned",
      hold_reason: null,
      duplicate_ack_at: now,
      duplicate_ack_by: author,
      updated_at: now,
    })
    .eq("id", id)
    .eq("asset_id", asset.id)
    // Garde de concurrence : si la ligne a bougé depuis la lecture, on ne l'écrase pas.
    .eq("status", "held");
  if (upErr) return jsonError(upErr.message, 500);

  return NextResponse.json({
    id,
    status: "planned",
    duplicateAckAt: now,
    duplicateAckBy: author,
    /** Ce qui va se passer, en toutes lettres : l'opérateur ne doit pas avoir à le deviner. */
    next: "the planner will freeze this edition on its next pass — no email is queued by this action",
  });
}
