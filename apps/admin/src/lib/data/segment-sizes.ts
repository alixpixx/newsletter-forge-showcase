import { AUDIENCE_VIEW, compileRule, type CompiledRule, type RuleContext } from "@nf/segments/compile";
import { ruleContextForAsset } from "@/lib/data/campaigns";
import { isValidRule, type SegmentRow } from "@/lib/data/segments";

/**
 * La taille ACTUELLE de chaque segment enregistré, mesurée quand la liste est servie.
 *
 * ⛔ POURQUOI (25/09/2026, Alix : « la colonne Last measured size ne s'update pas »). Le seul chiffre
 * de la colonne était `segment.cached_count`, écrit UNE fois, à l'enregistrement (POST /api/segments ;
 * aucun écran n'appelle le PATCH qui le réécrit, aucun cron ne le touche). Mesuré en base le 25/09 :
 * « Newsletter » (Northwind Sports) affichait 10 du 23/09 pour 31 abonnés réels. Le compte coûte ~4 ms en SQL
 * et une marque a au plus 7 segments : on le refait à chaque affichage plutôt que de servir un
 * instantané qui ment dès la première inscription.
 *
 * ⛔ MÊME CHEMIN QUE LA LISTE DÉPLIÉE (`segment-members.ts`) ET QUE LE FAN-OUT : même compilateur, mêmes
 * tables de correspondance (`ruleContextForAsset`, lues UNE fois pour toute la liste), même vue tirée
 * de la règle, scope marque posé AVANT le `.or()`. Un compte écrit « à côté » finirait par annoncer un
 * nombre que ni la liste ni l'envoi ne servent.
 *
 * ⛔ UN COMPTE RATÉ N'EST JAMAIS UN ZÉRO, ET NE CASSE PAS LA PAGE. Chaque échec est NOMMÉ par segment
 * (l'écran retombe alors sur l'instantané daté, en disant pourquoi) et journalisé. Un ciblage élargi
 * ne se compte pas : le chiffre décrirait plus de monde que la règle.
 *
 * Aucune écriture : un affichage (GET) qui réécrirait `cached_count` serait déclenché par n'importe
 * quel chargement de page, robots compris.
 */

type Db = Parameters<typeof ruleContextForAsset>[0];

export type SegmentSizeFailure = "no-db" | "unreadable-rule" | "targeting-incomplete" | "lookup-failed";

export type LiveSegmentSize =
  | { ok: true; count: number }
  | { ok: false; reason: SegmentSizeFailure; unsupported?: string[] };

const journal = (segmentId: string | null, detail: string | null) =>
  console.error(JSON.stringify({ t: new Date().toISOString(), event: "segment-size-lecture-ratee", segmentId, detail }));

async function mesurer(
  db: Db,
  assetId: string,
  segment: Pick<SegmentRow, "id" | "rule">,
  contexte: RuleContext,
): Promise<LiveSegmentSize> {
  // Une règle illisible ne vaut PAS « toute la marque ».
  if (!isValidRule(segment.rule)) return { ok: false, reason: "unreadable-rule" };

  let compiled: CompiledRule;
  try {
    compiled = compileRule(segment.rule, contexte);
  } catch {
    return { ok: false, reason: "unreadable-rule" };
  }
  if (compiled.widened) return { ok: false, reason: "targeting-incomplete", unsupported: compiled.unsupported };

  try {
    let q = db.from(AUDIENCE_VIEW[compiled.population]).select("id", { count: "exact", head: true }).eq("asset_id", assetId);
    if (compiled.expr) q = q.or(compiled.expr);
    const { count, error } = await q;
    // Un `count` absent n'est pas un zéro.
    if (error || typeof count !== "number") {
      journal(segment.id, error?.message ?? "count absent");
      return { ok: false, reason: "lookup-failed" };
    }
    return { ok: true, count };
  } catch (e) {
    journal(segment.id, e instanceof Error ? e.message : String(e));
    return { ok: false, reason: "lookup-failed" };
  }
}

/** Taille actuelle de chaque segment, par identifiant. Ne lève jamais. */
export async function measureSegmentSizes(
  db: Db | null,
  assetId: string | null,
  segments: Pick<SegmentRow, "id" | "rule">[],
): Promise<Map<string, LiveSegmentSize>> {
  const tailles = new Map<string, LiveSegmentSize>();
  if (segments.length === 0) return tailles;

  // Sans marque, on ne compte rien : un compte non scopé additionnerait toutes les marques.
  if (!db || !assetId) {
    for (const s of segments) tailles.set(s.id, { ok: false, reason: "no-db" });
    return tailles;
  }

  let contexte: RuleContext;
  try {
    contexte = await ruleContextForAsset(db, assetId);
  } catch (e) {
    journal(null, e instanceof Error ? e.message : String(e));
    for (const s of segments) tailles.set(s.id, { ok: false, reason: "lookup-failed" });
    return tailles;
  }

  const mesures = await Promise.all(segments.map((s) => mesurer(db, assetId, s, contexte)));
  segments.forEach((s, i) => tailles.set(s.id, mesures[i]));
  return tailles;
}
