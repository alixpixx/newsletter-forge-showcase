import { NextResponse } from "next/server";
import type { Db } from "@/lib/supabase";
import { ecrireDesabonnement, ipDeLaRequete, METHODE_HUMAIN } from "@/lib/desabonnement";
import { mettreEnFileAccuse } from "@/lib/accuse-desabonnement";

/**
 * Le POST de `api/v1/unsubscribe/confirm` — le geste HUMAIN, depuis le bouton de `/unsubscribe`.
 * Le pourquoi de la route est dans `route.ts`.
 *
 * Module séparé : la base et la vérification du jeton y sont injectées, pour qu'un banc mesure la
 * route sans secret ni réseau (même partage que le webhook Mailgun). `@/lib/tokens` n'est pas
 * importé ici : il vérifie le secret dès son chargement.
 */
export interface DesinscriptionHumaineDeps {
  getDb: () => Db | null;
  verifyUnsub: (token: string | undefined | null) => string | null;
}

export async function handleDesinscriptionHumaine(req: Request, deps: DesinscriptionHumaineDeps): Promise<Response> {
  const db = deps.getDb();
  if (!db) return NextResponse.json({ error: "service-indisponible" }, { status: 503 });

  const url = new URL(req.url);
  let corps: { token?: unknown; lang?: unknown } = {};
  try {
    corps = (await req.json()) as typeof corps;
  } catch {
    corps = {};
  }

  // Le jeton vient du corps (la page l'y met), la query reste acceptée en repli.
  const token =
    (typeof corps.token === "string" && corps.token) || url.searchParams.get("token") || undefined;

  /**
   * ⚠️ Jeton invalide : réponse UNIQUE et définitive, identique quel que soit le motif. Ne jamais
   * dire si l'adresse existe — répondre différemment pour « signature fausse » et « souscription
   * inconnue » ferait de cette route un oracle d'appartenance à la liste.
   */
  const subId = deps.verifyUnsub(token);
  if (!subId) return NextResponse.json({ error: "lien-invalide" }, { status: 403 });

  // L'adresse et la marque sont lues ICI, dans la même requête que la langue : l'accusé en a besoin
  // et la souscription n'a plus à être relue après l'écriture.
  const { data: sub } = await db
    .from("subscription")
    .select("id, language, asset_id, subscriber:subscriber_id(email), asset:asset_id(name)")
    .eq("id", subId)
    .maybeSingle();

  // Signature valide mais plus de ligne : le droit à l'oubli est déjà passé. Plus rien à
  // désabonner, et l'objectif est atteint — c'est un succès.
  if (!sub) return NextResponse.json({ ok: true }, { status: 200 });

  const langueDeLaPage =
    (typeof corps.lang === "string" && corps.lang) || url.searchParams.get("lang") || null;

  const issue = await ecrireDesabonnement(db, subId, {
    methode: METHODE_HUMAIN,
    langue: langueDeLaPage || (sub.language as string | null),
    ip: ipDeLaRequete(req.headers),
    ua: req.headers.get("user-agent"),
  });

  /**
   * ⛔ L'ÉCHEC SE DIT. C'est le seul cas où la personne est TOUJOURS ABONNÉE : répondre 200
   * afficherait « désabonnement confirmé » au-dessus d'une souscription active, et elle
   * recevrait la prochaine campagne après avoir vu une confirmation.
   */
  if (issue === "echec") {
    return NextResponse.json({ error: "ecriture-impossible" }, { status: 503 });
  }

  /**
   * L'accusé de désinscription — sur `fait` SEULEMENT. `deja` répond le même 200 (la personne est
   * bien désinscrite), mais c'est un second clic, un rejeu, ou le perdant d'une course : l'accusé est
   * déjà parti avec le gagnant, ou la désinscription s'est faite ailleurs. `mettreEnFileAccuse` ne
   * lève jamais et son échec est journalisé : il ne change pas la réponse (voir le module).
   */
  if (issue === "fait") {
    await mettreEnFileAccuse(db, {
      subscriptionId: subId,
      assetId: (sub.asset_id as string | null) ?? null,
      email: (sub.subscriber as { email?: string } | null)?.email,
      marque: (sub.asset as { name?: string } | null)?.name,
      langue: (sub.language as string | null) || langueDeLaPage,
      origine: "unsubscribe_page",
    });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
