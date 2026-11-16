import { NextResponse } from "next/server";
import { getCurrentAsset } from "@/lib/asset-context";
import { getDb } from "@/lib/supabase";
import { BOM_UTF8, nomDeFichierCsv, tableauCsv } from "@/lib/csv";
import { findCampaign } from "@/lib/data/campaigns";
import { lireStatsCampagnes } from "@/lib/data/campaign-stats";
import { lireEngagementDeCampagne } from "@/lib/data/engagement";
import { COLONNES_CSV, lignesCsv, nomEnvoi } from "@/lib/campaign-stats";
import { COLONNES_ENGAGEMENT_CSV, lignesEngagementCsv } from "@/lib/engagement-csv";

/**
 * GET /api/analytics/campaigns/[id]/export — les envois d'une campagne, en CSV (feature 7).
 * `?part=engagement` (0094) : l'engagement à la place — résumé ouvertures/clics, liens, délai jusqu'à
 * la 1re action, dimensions — toutes éditions, ou une seule (`&edition=<occurrenceId>`).
 *
 * GET, parce que l'URL ne porte qu'un identifiant de campagne (aucune donnée d'abonné) et qu'un lien
 * de téléchargement suffit. ⛔ SCOPÉ MARQUE : une campagne d'une autre marque rend 404, exactement comme
 * sa page. ⛔ Une lecture ratée rend une erreur, jamais un fichier d'en-têtes seuls qui se lirait
 * « aucun envoi ». ⛔ `edition` n'est retenu que s'il désigne une édition DE CETTE campagne (même règle
 * que la page) ; sinon il est ignoré, et la ligne « Selection » du fichier dit ce qu'il couvre.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const part = url.searchParams.get("part");
  if (part !== null && part !== "engagement") {
    return NextResponse.json({ ok: false, reason: "unknown-part" }, { status: 400 });
  }
  const asset = await getCurrentAsset();
  if (!asset.id) return NextResponse.json({ ok: false, reason: "no-asset" }, { status: 409 });
  const db = getDb();
  if (!db) return NextResponse.json({ ok: false, reason: "no-db" }, { status: 503 });

  const campagne = await findCampaign(db, id, asset.id);
  if (!campagne) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const lu = await lireStatsCampagnes(db, asset.id, { campaignId: id, limit: 1 });
  if (!lu.known) return NextResponse.json({ ok: false, reason: lu.reason }, { status: 503 });
  const stats = lu.campaigns[0];
  const jour = new Date().toISOString().slice(0, 10);

  let csv: string;
  let nom: string;
  if (part === "engagement") {
    const demandee = url.searchParams.get("edition");
    const edition = stats?.recurring
      ? (stats.editions.find((e) => e.occurrenceId !== null && e.occurrenceId === demandee) ?? null)
      : null;
    const eng = await lireEngagementDeCampagne(db, asset.id, id, edition?.occurrenceId ?? null);
    if (!eng.known) return NextResponse.json({ ok: false, reason: eng.reason }, { status: 503 });
    const selection = edition ? nomEnvoi(edition) : stats?.recurring ? "All editions" : "Single send";
    csv = tableauCsv([...COLONNES_ENGAGEMENT_CSV], lignesEngagementCsv(eng.value, selection));
    const suffixe = edition ? `-edition-${edition.seq ?? (edition.localDate ?? "").slice(0, 10)}` : "";
    nom = nomDeFichierCsv(`${campagne.name || "campaign"}-engagement${suffixe}`, jour);
  } else {
    csv = tableauCsv([...COLONNES_CSV], lignesCsv(stats?.editions ?? []));
    nom = nomDeFichierCsv(`${campagne.name || "campaign"}-analytics`, jour);
  }

  return new NextResponse(BOM_UTF8 + csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nom}"`,
      "Cache-Control": "no-store",
    },
  });
}
