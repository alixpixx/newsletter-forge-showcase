import { NextResponse } from "next/server";
import { getDb } from "@/lib/supabase";
import { getCurrentAsset } from "@/lib/asset-context";
import { AUDIENCE_VIEW, compileRule } from "@nf/segments/compile";
import { ruleContextForAsset } from "@/lib/data/campaigns";
import type { Group } from "@nf/segments/fields";

/**
 * Compte RÉEL d'un segment en base. Protégé par le proxy (session requise).
 *
 * Le filtre de consentement ne vient JAMAIS de la règle : on compte sur la vue
 * `sendable_subscription` (status = 'active' ET non-suppression), la même barrière
 * qu'à l'envoi (C4). Le ciblage est une commodité, le consentement est une barrière.
 *
 * Scopé sur la MARQUE COURANTE : sans ça le numérateur comptait les 9 marques alors que le
 * dénominateur (getActiveTotal) est scopé — le pourcentage affiché était faux.
 */
export async function POST(req: Request) {
  const db = getDb();
  if (!db) return NextResponse.json({ count: null, reason: "no-db", unsupported: [] });

  let rule: Group;
  try {
    rule = (await req.json()).rule as Group;
    if (!rule || rule.type !== "group") throw new Error("bad rule");
  } catch {
    return NextResponse.json({ count: null, reason: "bad-request", unsupported: [] }, { status: 400 });
  }

  // La marque est résolue AVANT les tables de correspondance : `newsletter.tag` est unique par
  // `(asset_id, slug)`, donc deux marques peuvent porter le même slug avec des ids différents.
  const asset = await getCurrentAsset();

  // ⛔ LES CINQ TABLES DE CORRESPONDANCE — dont les TROIS LISTES BLANCHES DE PROVENANCE — viennent
  // de `ruleContextForAsset`, partagée avec `estimateAudience`. Sans elles, tout prédicat de
  // capture (`capture_campaign`, `capture_creative`, `interest`) rend `null` chez le compilateur :
  // le critère de provenance est inerte, l'écran affiche une règle que le filtre n'applique pas.
  // Et les deux compteurs annonceraient deux nombres pour la même règle s'ils lisaient chacun de
  // leur côté.
  const { expr, unsupported, widened, population } = compileRule(rule, await ruleContextForAsset(db, asset.id));

  // ⛔ UN CIBLAGE QUI S'EST ÉLARGI NE SE COMPTE PAS. Si un terme d'un ET n'a pas pu être compilé,
  // le nombre qu'on afficherait serait celui d'une population PLUS LARGE que la règle à l'écran —
  // et rien à l'écran ne le montrerait, puisque la règle, elle, est affichée en entier. Un chiffre
  // faux et rassurant est pire que pas de chiffre.
  if (widened) {
    return NextResponse.json({
      count: null,
      demoExcluded: null,
      sunsetExcluded: null,
      unsupported,
      widened: true,
      reason: "targeting-incomplete",
      scoped: !!asset.id,
    });
  }

  // La vue applique déjà le statut (active, ou contact pour « Newsletter: No ») + exclusion des
  // suppressions. ⛔ La vue vient de la RÈGLE (`AUDIENCE_VIEW`), jamais d'un défaut local.
  let q = db.from(AUDIENCE_VIEW[population]).select("*", { count: "exact", head: true });
  // Scope marque — appliqué AVANT le `.or()` de la règle (sinon il serait absorbé dans la disjonction).
  if (asset.id) q = q.eq("asset_id", asset.id);
  if (expr) q = q.or(expr);

  const { count, error } = await q;
  if (error) {
    /*
     * ⛔ LA BASE A RÉPONDU, ET ELLE A REFUSÉ — ce n'est PAS « base indisponible ».
     *
     * Les deux se ressemblent depuis l'écran : dans les deux cas `count` vaut `null`. Mais ils
     * appellent des gestes opposés. « Indisponible » se lit « ce n'est pas moi, réessaie plus
     * tard » et invite à ignorer l'avertissement ; ici, c'est la RÈGLE EN COURS D'ÉCRITURE que
     * PostgREST refuse, et le nombre affiché à côté (l'estimation locale) ne décrit aucun
     * ciblage réel. Sans ce nom, quelqu'un enregistre un segment invalide en croyant l'avoir vu
     * compter.
     *
     * `detail` porte le message brut : il nomme l'expression fautive, et c'est la seule chose qui
     * permette de comprendre le refus. Il n'est pas montré tel quel, il est journalisé.
     */
    console.error(JSON.stringify({ t: new Date().toISOString(), event: "segment-count-refuse", detail: error.message }));
    return NextResponse.json({ count: null, reason: "query-failed", detail: error.message, unsupported, scoped: !!asset.id });
  }

  // Le MÊME ciblage sur les deux AUTRES parts de la partition (vues 0035 et 0059) : les contacts de
  // démonstration, et les abonnés réels que le sunset a écartés. Depuis 0034, une base qui n'a que
  // des faux contacts compte 0 — et un zéro qu'on n'explique pas se lit comme une panne de la règle
  // qu'on est en train d'écrire. Un échec ici ne casse pas le compte : `null` = non compté.
  //
  // ⛔ Il en faut DEUX depuis 0057 : `sendable_subscription` filtre aussi `sunset_at is null`, donc
  // un abonné marqué manquait aux deux chiffres et l'écran ne pouvait plus expliquer son zéro.
  const complement = async (view: string) => {
    let q2 = db.from(view).select("id", { count: "exact", head: true });
    if (asset.id) q2 = q2.eq("asset_id", asset.id);
    if (expr) q2 = q2.or(expr);
    const { count: n } = await q2;
    return n ?? null;
  };

  // Les deux compléments décrivent des ABONNÉS écartés : sans objet quand la règle vise les contacts.
  const contacts = population === "contacts";
  return NextResponse.json({
    count: count ?? 0,
    demoExcluded: contacts ? null : await complement("excluded_demo_subscription"),
    sunsetExcluded: contacts ? null : await complement("sunsetted_subscription"),
    unsupported,
    widened: false,
    population,
    scoped: !!asset.id,
  });
}
