import { NextResponse } from "next/server";
import { getCurrentAsset } from "@/lib/asset-context";
import { getSubscribers, type LevelFilter } from "@/lib/data/subscribers";
import { MAX_LIGNES } from "@/lib/data/subscriber-actions";
import { statutDemande } from "@/lib/data/statut-abonnes";
import { paysDemande } from "@/lib/data/pays-abonnes";
import { TRI_PAR_DEFAUT } from "@/lib/data/tri-abonnes";

/**
 * POST /api/subscribers/ids — tous les identifiants qui correspondent aux filtres affichés.
 *
 * ⛔ POURQUOI CETTE ROUTE EXISTE. La case d'en-tête ne coche que les 25 lignes visibles : c'est le
 * seul choix honnête pour une case posée dans un en-tête de tableau, mais il rendait impossible
 * d'agir sur une sélection de 400 personnes autrement qu'en parcourant seize pages. Le geste
 * « tout sélectionner » a donc besoin d'une réponse du serveur — le navigateur ne connaît pas les
 * lignes qu'il n'a pas reçues.
 *
 * ⛔ ELLE NE REÇOIT AUCUN IDENTIFIANT DE MARQUE. La marque vient de la session (`getCurrentAsset`),
 * jamais du corps de requête : accepter un `assetId` du navigateur ferait de cette route un moyen
 * d'énumérer les abonnés d'une marque à laquelle on n'a pas accès.
 *
 * ⛔ ELLE PASSE PAR `getSubscribers`, LA FONCTION DE LA LISTE ELLE-MÊME. Réécrire ici la résolution
 * des filtres (provenances en identifiants, sentinelles d'introuvable, groupes de statuts) ferait
 * exister deux définitions de « la population affichée » — et le jour où elles divergent, « tout
 * sélectionner » cocherait des lignes que la liste ne montre pas. Le prix est de charger des
 * colonnes dont on ne garde que l'`id` ; c'est un geste manuel et rare, et la propriété qu'on
 * achète est exactement celle qui compte.
 */
export async function POST(req: Request) {
  const asset = await getCurrentAsset();
  if (!asset.id) return NextResponse.json({ ok: false, reason: "no-asset" }, { status: 409 });

  const body = (await req.json().catch(() => ({}))) as {
    level?: unknown; campaign?: unknown; creative?: unknown; interest?: unknown; status?: unknown;
    pays?: unknown;
  };
  const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  // Même liste blanche que la page : une valeur inconnue vaut « tous », jamais un filtre inventé.
  const level: LevelFilter = (["active", "dormant", "churned"] as const).includes(body.level as never)
    ? (body.level as LevelFilter)
    : "all";

  const res = await getSubscribers(
    asset.id,
    level,
    1,
    MAX_LIGNES,
    { campaign: texte(body.campaign), creative: texte(body.creative), interest: texte(body.interest) },
    // Le tri n'a aucune importance pour une sélection complète, mais en demander un connu évite de
    // faire travailler la base sur un ordre dont personne ne lira le résultat.
    TRI_PAR_DEFAUT,
    statutDemande(texte(body.status)),
    // ⛔ LE PAYS ENTRE ICI AUSSI. Absent, « tout sélectionner » cocherait des lignes que la
    // liste ne montre pas — deux définitions de « la population affichée », et le geste qui
    // suit (tagger, exporter, effacer) porterait sur la mauvaise.
    paysDemande(texte(body.pays)),
  );

  if (res.source !== "db") return NextResponse.json({ ok: false, reason: "no-db" }, { status: 503 });

  const ids = res.rows.map((r) => r.id);
  const total = level === "all" ? res.counts.all : res.counts[level];

  /*
   * ⛔ `tronque` DOIT REMONTER. Au-delà du plafond, la sélection ne couvre pas ce que l'écran
   * annonce : laisser croire à « les 8 000 » alors qu'on en tient 5 000 ferait tagger — ou effacer —
   * une part de la population en silence, et le compte rendu final donnerait un nombre plus petit
   * sans que personne ne sache lequel des deux est le bon.
   */
  return NextResponse.json({
    ok: true,
    ids,
    total,
    tronque: total > ids.length,
    max: MAX_LIGNES,
  });
}
