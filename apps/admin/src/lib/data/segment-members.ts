import { AUDIENCE_VIEW, compileRule, type CompiledRule, type RuleContext } from "@nf/segments/compile";
import { ruleContextForAsset } from "@/lib/data/campaigns";
import { findSegment, isValidRule } from "@/lib/data/segments";

/**
 * Qui est DANS un segment enregistré, maintenant — la liste que l'écran des segments déplie.
 *
 * ⛔ LA LISTE EST CELLE QUE L'ENVOI SERVIRAIT, PAS UNE APPROXIMATION. Même compilateur
 * (`@nf/segments/compile`), mêmes tables de correspondance (`ruleContextForAsset`), même vue
 * (`sendable_subscription`), même scope marque, même `.or(expr)` que le fan-out
 * (`apps/worker/src/fanout-db.ts`, `pageAudience`). Une liste écrite « à côté » finirait par montrer
 * des gens que l'envoi ne servira pas — ou taire des gens qu'il servira — sans qu'aucune erreur ne se
 * lève. Seul le gate de FINALITÉ du fan-out n'est pas ici : il dépend de la campagne, pas du segment.
 *
 * ⛔ UN CIBLAGE ÉLARGI NE SE LISTE PAS. Si un terme d'un ET n'a pas compilé, la liste montrerait une
 * population PLUS LARGE que la règle affichée — au pire toute la marque. On refuse, en nommant les
 * conditions tombées, exactement comme le compteur et l'estimation d'audience.
 *
 * ⛔ UNE ERREUR DE BASE N'EST JAMAIS « PERSONNE ». Chaque lecture ratée rend un échec nommé ; une
 * liste vide présentée comme « ce segment est vide » enverrait chercher une panne dans la règle.
 */

type Db = Parameters<typeof findSegment>[0];

export const MEMBERS_PAGE_SIZE = 50;
export const MEMBERS_MAX_PAGE_SIZE = 100;
export const MEMBERS_SEARCH_MAX_LENGTH = 100;
/**
 * Plafond de la recherche d'adresses. La recherche se fait sur `subscriber`, qui est GLOBAL (toutes
 * marques) ; les identifiants trouvés repartent ensuite dans un `.in("subscriber_id", …)` que
 * supabase-js écrit dans l'URL. 100 uuid ≈ 3,7 Ko : on reste loin des limites d'URL des proxys
 * (8 Ko chez certains) même avec une règle longue à côté. Au-delà, on le DIT (`truncated`) au lieu de
 * montrer une liste partielle comme si elle était complète.
 */
export const MEMBERS_SEARCH_CAP = 100;

export interface SegmentMemberRow {
  subscriptionId: string;
  email: string;
  joinedAt: string | null;
  engagementLevel: string | null;
}

export type SegmentMembersFailure = "not-found" | "unreadable-rule" | "targeting-incomplete" | "lookup-failed";

export type SegmentMembersResult =
  | {
      ok: true;
      rows: SegmentMemberRow[];
      /** Lignes qui correspondent à la recherche (ou tout le segment, sans recherche). */
      total: number;
      /** Tout le segment, recherche ignorée : le nombre qu'un envoi servirait maintenant. */
      segmentTotal: number;
      /** Page EFFECTIVE — ramenée à la dernière si le segment a rétréci entre deux clics. */
      page: number;
      pageSize: number;
      /** Le terme réellement cherché, après nettoyage (`""` = pas de recherche). */
      query: string;
      /** La recherche a touché son plafond : des correspondances ont pu ne pas être examinées. */
      truncated: boolean;
      /** Conditions écartées sous un OU : la liste est peut-être plus ÉTROITE que la règle. */
      unsupported: string[];
    }
  | { ok: false; reason: SegmentMembersFailure; unsupported?: string[]; detail?: string };

/**
 * Nettoie la recherche d'adresse.
 *
 * PostgREST n'expose pas de clause ESCAPE : `%` et `*` (son alias) deviendraient des jokers, et les
 * guillemets, virgules et parenthèses cassent le parsing des filtres. On les RETIRE.
 *
 * ⚠️ Différent de `sanitizeSearch` (médias) : `_ . + @` restent. Une adresse en contient presque
 * toujours — les retirer rendrait introuvable `jean_dupont@…` ou `a+promo@…`. Le `_` reste un joker
 * d'un caractère pour ILIKE ; il ne peut qu'ÉLARGIR la correspondance (il matche aussi le `_` saisi),
 * jamais faire disparaître l'adresse cherchée.
 */
export function sanitizeEmailSearch(v: string): string {
  return v.replace(/[%*,()"'\\]/g, "").trim().slice(0, MEMBERS_SEARCH_MAX_LENGTH);
}

type Erreur = { message?: string } | null | undefined;
const echec = (reason: SegmentMembersFailure, error?: Erreur, unsupported?: string[]): SegmentMembersResult => {
  const detail = error?.message;
  if (reason === "lookup-failed") {
    // Le message brut nomme la requête fautive ; il est journalisé, jamais montré. Le terme cherché
    // (une adresse, donc une PII) n'y figure pas.
    console.error(JSON.stringify({ t: new Date().toISOString(), event: "segment-members-lecture-ratee", detail: detail ?? null }));
  }
  return { ok: false, reason, ...(unsupported ? { unsupported } : {}), ...(detail ? { detail } : {}) };
};

export async function listSegmentMembers(
  db: Db,
  assetId: string,
  segmentId: string,
  opts: { q?: string; page?: number; pageSize?: number } = {},
): Promise<SegmentMembersResult> {
  const pageSize = Math.min(MEMBERS_MAX_PAGE_SIZE, Math.max(1, Math.trunc(opts.pageSize ?? MEMBERS_PAGE_SIZE) || MEMBERS_PAGE_SIZE));
  const pageDemandee = Math.max(1, Math.trunc(opts.page ?? 1) || 1);

  // 1. Le segment, SCOPÉ MARQUE : celui d'une autre marque est indiscernable d'un inexistant.
  const segment = await findSegment(db, segmentId, assetId);
  if (!segment) return echec("not-found");

  // 2. Une règle illisible ne vaut PAS « tout le monde » : ce raccourci listerait toute la marque sur
  //    une donnée corrompue.
  if (!isValidRule(segment.rule)) return echec("unreadable-rule");

  // 3. Les tables de correspondance de la MARQUE — les mêmes que le compteur et l'estimation.
  let contexte: RuleContext;
  try {
    contexte = await ruleContextForAsset(db, assetId);
  } catch (e) {
    return echec("lookup-failed", { message: e instanceof Error ? e.message : String(e) });
  }

  let compiled: CompiledRule;
  try {
    compiled = compileRule(segment.rule, contexte);
  } catch {
    // `isValidRule` ne regarde que la racine : un sous-groupe forgé peut encore faire lever le
    // compilateur. C'est une règle illisible, pas une panne de base.
    return echec("unreadable-rule");
  }

  // 4. ⛔ Élargi = refus, AVANT toute lecture de la vue. Une lecture des tables de correspondance
  //    ratée arrive ici aussi : ses prédicats tombent, et sous un ET ils élargissent.
  if (compiled.widened) return echec("targeting-incomplete", null, compiled.unsupported);
  const { expr, unsupported, population } = compiled;

  // ⛔ Scope marque TOUJOURS posé, et AVANT le `.or()` de la règle — sinon il serait absorbé dans la
  //    disjonction. Contrairement au compteur, pas de `if (assetId)` : sans marque, on ne liste rien.
  // ⛔ La vue vient de la règle : « Newsletter: No » liste les contacts (0088), comme le fan-out.
  const audience = (colonnes: string, options?: { count: "exact"; head: true }) => {
    let q = db.from(AUDIENCE_VIEW[population]).select(colonnes, options).eq("asset_id", assetId);
    if (expr) q = q.or(expr);
    return q;
  };

  // 5. Le segment entier, maintenant. Un `count` absent n'est pas un zéro.
  const tout = await audience("id", { count: "exact", head: true });
  if (tout.error || typeof tout.count !== "number") return echec("lookup-failed", tout.error);
  const segmentTotal = tout.count;

  // 6. La recherche : d'abord les PERSONNES dont l'adresse correspond, ensuite leur intersection avec
  //    le segment par `.in("subscriber_id")`. La vue n'expose pas l'e-mail ; et ⛔ jamais la
  //    recherche glissée dans une chaîne `or(...)` : une virgule ou une parenthèse saisie y
  //    ajouterait un terme à la DISJONCTION, donc des gens hors de la règle.
  const query = sanitizeEmailSearch(opts.q ?? "");
  let ids: string[] | null = null;
  let truncated = false;
  if (query) {
    const trouves = await db
      .from("subscriber")
      .select("id")
      .ilike("email", `%${query}%`)
      // La vue écarte déjà les contacts fictifs : les chercher ne ferait que consommer le plafond.
      .eq("is_demo", false)
      .order("id", { ascending: true })
      .limit(MEMBERS_SEARCH_CAP + 1);
    if (trouves.error || !Array.isArray(trouves.data)) return echec("lookup-failed", trouves.error);
    const tous = (trouves.data as { id: unknown }[]).map((r) => String(r.id));
    truncated = tous.length > MEMBERS_SEARCH_CAP;
    ids = tous.slice(0, MEMBERS_SEARCH_CAP);
  }

  let total = segmentTotal;
  if (ids) {
    if (ids.length === 0) {
      total = 0;
    } else {
      const filtres = await audience("id", { count: "exact", head: true }).in("subscriber_id", ids);
      if (filtres.error || typeof filtres.count !== "number") return echec("lookup-failed", filtres.error);
      total = filtres.count;
    }
  }

  // 7. Page ramenée dans les bornes : un segment peut rétrécir entre deux clics, et une plage
  //    au-delà du total rendrait une page vide sous « N subscribers » (voire un refus de PostgREST).
  const page = Math.min(pageDemandee, Math.max(1, Math.ceil(total / pageSize)));
  const base = { ok: true as const, total, segmentTotal, page, pageSize, query, truncated, unsupported };
  if (total === 0) return { ...base, rows: [] };

  const debut = (page - 1) * pageSize;
  let liste = audience("id, subscriber_id, created_at, engagement_level");
  if (ids) liste = liste.in("subscriber_id", ids);
  const lus = await liste
    .order("created_at", { ascending: false })
    // Clé de départage : sans elle, deux inscrits de la même seconde n'ont pas d'ordre stable, et
    // tourner les pages peut montrer quelqu'un deux fois et en sauter un autre.
    .order("id", { ascending: true })
    .range(debut, debut + pageSize - 1);
  if (lus.error || !Array.isArray(lus.data)) return echec("lookup-failed", lus.error);

  // `as unknown` : la liste de colonnes passe par une variable, supabase-js ne sait donc pas typer la
  // ligne (il rend `GenericStringError`). La forme est celle du `select` juste au-dessus.
  const lignes = lus.data as unknown as { id: unknown; subscriber_id: unknown; created_at: unknown; engagement_level: unknown }[];
  if (lignes.length === 0) return { ...base, rows: [] };

  // 8. Les adresses. La vue n'expose pas l'e-mail (seulement `subscriber_id`) : une seconde lecture,
  //    bornée à la page.
  const personnes = [...new Set(lignes.map((l) => String(l.subscriber_id)))];
  const adresses = await db.from("subscriber").select("id, email").in("id", personnes);
  if (adresses.error || !Array.isArray(adresses.data)) return echec("lookup-failed", adresses.error);
  const emailDe = new Map<string, string>();
  for (const raw of adresses.data as { id: unknown; email: unknown }[]) emailDe.set(String(raw.id), String(raw.email ?? ""));

  return {
    ...base,
    rows: lignes.map((l) => ({
      subscriptionId: String(l.id),
      // La vue joint `subscriber` : une adresse manquante ne peut venir que d'un effacement survenu
      // entre les deux lectures. On garde la ligne (elle est dans le compte) sans inventer d'adresse.
      email: emailDe.get(String(l.subscriber_id)) ?? "",
      joinedAt: l.created_at ? String(l.created_at) : null,
      engagementLevel: l.engagement_level ? String(l.engagement_level) : null,
    })),
  };
}
