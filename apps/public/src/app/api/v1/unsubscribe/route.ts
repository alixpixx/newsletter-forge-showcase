import { NextResponse } from "next/server";
import { getDb } from "@/lib/supabase";
import { verifyUnsub } from "@/lib/tokens";
import { normalizeLocale } from "@/lib/i18n";
import { ecrireDesabonnement, ipDeLaRequete, METHODE_MACHINE } from "@/lib/desabonnement";

/**
 * Désabonnement en UN CLIC (RFC 8058) — la cible du POST annoncé par l'en-tête
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` que Gmail et Yahoo exigent de tout
 * expéditeur en volume.
 *
 * ⛔ POURQUOI LA ROUTE D'ABORD, LE DRAPEAU ENSUITE. Le worker sait déjà émettre l'en-tête
 * (`apps/worker/src/mailgun.ts`), mais `WORKER_ONE_CLICK` vaut `false` par défaut. Annoncer un
 * one-click sans route derrière ferait répondre 405 à Gmail : le désabonnement échoue, la personne
 * clique « spam », et la réputation du domaine paie — PIRE que de ne rien annoncer. Ce fichier
 * comble le manque ; l'activation du drapeau reste une décision d'Alix, jamais un effet de bord.
 *
 * ⛔ INVARIANT — UNE SEULE FAÇON DE SE DÉSINSCRIRE. Même jeton signé (`verifyUnsub`, source unique
 * dans packages/tokens) et même écriture que la page `/unsubscribe` : `status = 'unsubscribed'`
 * plus un `consent_event` dont la `language` est normalisée pareil. Deux chemins qui divergeraient
 * donneraient un abonné « désinscrit » d'un côté et toujours servi de l'autre — invisible jusqu'à
 * la plainte.
 *
 * ⛔ CETTE URI N'EST JAMAIS DIFFUSÉE. L'adresse qui fait foi, la seule mise dans `List-Unsubscribe`
 * par `apps/worker/src/process.ts`, est `/unsubscribe`. `apps/public/src/middleware.ts` y réécrit le
 * POST vers ce fichier et laisse le GET à la page. Ne PAS repointer le worker ici : ce handler
 * répond 405 en GET, et tout client sans RFC 8058 ouvre le lien en GET.
 *
 * L'appelant est une MACHINE : pas de session, pas de cookie, pas de CSRF, pas de page de
 * confirmation, pas de redirection. On désabonne et on répond.
 */

/** Valeur imposée par la RFC 8058 §3.1 dans le corps du POST. */
const MARQUEUR_ONE_CLICK = "one-click";

function succes() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

/**
 * ⛔ 405 VOULU, CE N'EST PAS UN OUBLI. La cible du one-click n'accepte QUE POST : un GET ici
 * viendrait d'un scanner de liens (antivirus d'entreprise, préchargement d'un client mail) et
 * désabonnerait des gens à leur insu. Le geste humain a sa propre page, `/unsubscribe?token=…`,
 * que le message d'erreur nomme pour que l'appelant sache où aller. C'est aussi la raison pour
 * laquelle cette URI n'est jamais posée dans un e-mail : personne ne doit l'atteindre en GET.
 */
export function GET() {
  return NextResponse.json(
    {
      error: "methode-non-autorisee",
      hint: "One-click unsubscribe accepts POST only. To unsubscribe from a browser, open /unsubscribe?token=<token>.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function POST(req: Request) {
  const db = getDb();
  /**
   * 503 assumé : une panne de notre côté est le SEUL cas où un réessai du MTA a du sens (le
   * désabonnement n'a pas eu lieu). Tout le reste répond par un statut définitif, jamais par une
   * erreur qui ferait rejouer le POST indéfiniment.
   */
  if (!db) return NextResponse.json({ error: "service-indisponible" }, { status: 503 });

  const brut = await req.text().catch(() => "");
  const form = new URLSearchParams(brut);

  /**
   * Le corps doit porter `List-Unsubscribe=One-Click`. On compare sans tenir compte de la casse du
   * NOM du champ (les MTA ne s'accordent pas dessus et `URLSearchParams.get` est sensible à la
   * casse) : c'est le seul marqueur qui distingue un one-click d'un POST au hasard sur l'URL.
   */
  let marqueur: string | null = null;
  for (const [cle, valeur] of form) {
    if (cle.trim().toLowerCase() === "list-unsubscribe") marqueur = valeur;
  }
  if (marqueur?.trim().toLowerCase() !== MARQUEUR_ONE_CLICK) {
    return NextResponse.json(
      {
        error: "corps-invalide",
        hint: "RFC 8058 requires the body `List-Unsubscribe=One-Click` sent as application/x-www-form-urlencoded.",
      },
      { status: 400 },
    );
  }

  /**
   * Le jeton voyage dans la query : c'est le lien signé que le worker met dans `List-Unsubscribe`,
   * et le MTA POSTe cette URL telle quelle. `token` dans le corps est un repli, parce qu'un MTA peut
   * rejouer l'URL sans sa query.
   *
   * ⛔ `||` ET NON `??` : sur une URL qui porte `?token=` (clé présente, valeur vide),
   * `searchParams.get` renvoie la CHAÎNE VIDE et non `null` — avec `??` le repli ne se déclenchait
   * jamais et un POST portant un jeton VALIDE dans le corps repartait en 403. Un repli mort qui
   * avait l'air vivant : mesuré 403 avant correctif, 200 après.
   *
   * `t` reste accepté par tolérance défensive, PAS parce qu'un lien le porte : la seule occurrence
   * du dépôt est une URL factice de mesure de poids (`packages/render/src/shell-checks.ts:80`).
   */
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || url.searchParams.get("t") || form.get("token");

  /**
   * ⚠️ Jeton invalide ou périmé : réponse UNIQUE et définitive (403), identique quel que soit le
   * motif. Ne jamais dire si l'adresse existe — et ne jamais répondre 5xx ici, ce qui condamnerait
   * Gmail à rejouer sans fin un POST qui ne réussira jamais.
   */
  const subId = verifyUnsub(token);
  if (!subId) return NextResponse.json({ error: "lien-invalide" }, { status: 403 });

  const { data: sub } = await db
    .from("subscription")
    .select("id, status, language")
    .eq("id", subId)
    .maybeSingle();

  /**
   * ⚠️ Signature valide mais plus de ligne : le droit à l'oubli est déjà passé par là. Il n'y a
   * plus rien à désabonner et plus personne à servir — on répond SUCCÈS, parce qu'un 404 ferait
   * compter un one-click en échec chez Gmail alors que l'objectif est atteint.
   */
  if (!sub) return succes();

  /**
   * ⛔ L'ÉCRITURE N'EST PLUS ICI. Elle vit dans `lib/desabonnement.ts`, partagée avec la page
   * humaine — c'est l'invariant que l'en-tête de ce fichier déclare : « une seule façon de se
   * désinscrire ». Le correctif de concurrence (`.neq` DANS l'instruction d'écriture) y est gardé
   * par un test qui EXIGE l'appel, pas seulement le bon résultat.
   *
   * Le seul écart entre les deux appelants est le libellé d'audit : `list_unsub_one_click` ici,
   * `list_unsub` pour un geste humain. Un audit doit pouvoir prouver qu'un désabonnement machine
   * a bien été tracé comme tel.
   */
  const issue = await ecrireDesabonnement(db, subId, {
    methode: METHODE_MACHINE,
    langue: url.searchParams.get("lang") || (sub.language as string | null),
    ip: ipDeLaRequete(req.headers),
    ua: req.headers.get("user-agent"),
  });

  /**
   * Écriture refusée = le désabonnement N'A PAS eu lieu. 503 pour que le MTA rejoue, plutôt qu'un
   * faux succès qui laisserait la personne abonnée sans que rien ne le signale.
   *
   * ⚠️ `deja` est un SUCCÈS au même titre que `fait` : dans les deux cas la personne n'est plus
   * servie. Répondre autre chose que 200 ferait compter un one-click en échec chez Gmail.
   */
  if (issue === "echec") {
    return NextResponse.json({ error: "ecriture-impossible" }, { status: 503 });
  }

  /**
   * ⛔ AUCUN ACCUSÉ DE DÉSINSCRIPTION ICI, MÊME SUR `fait` — décision d'Alix du 22/09/2026. La
   * messagerie de la personne vient de lui confirmer le geste dans sa propre interface ; lui écrire
   * en plus répondrait à un clic fait CHEZ Gmail par un e-mail de plus. L'accusé ne part que de nos
   * pages (`api/v1/unsubscribe/confirm`, centre de préférences). Un banc lit ce fichier et rougit si
   * une mise en file y apparaît (`unsubscribe/confirm/handler.test.ts`).
   */
  return succes();
}
