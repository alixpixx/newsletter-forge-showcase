import { NextResponse } from "next/server";
import { isLifecycleKind } from "@nf/render/lifecycle-checks";
import { authorEmail, findTemplate } from "@/lib/data/templates";
import { assetEditionLocales } from "@/lib/data/asset-editions";
import { lifecycleTemplateToReopen, setLifecycleBinding } from "@/lib/data/lifecycle-templates";
import { canEditTemplate } from "@/lib/session";
import { lifecycleStarterLocale } from "@/lib/lifecycle-starter";
import { creerModeleCycleDeVie } from "@/lib/lifecycle-seed-create";
import { lireThemesDeMarque } from "@/lib/lifecycle-seed-all";
import { jsonError, readJson, requireContext } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/builder/lifecycle-seed — crée un modèle PRÉ-REMPLI pour un e-mail de cycle de vie, puis
 * le rattache à ce kind. Corps : `{ kind, assetId }` — `assetId` est la marque que l'ÉCRAN affichait.
 *
 * ⛔ POURQUOI UNE ROUTE, ET PAS DEUX APPELS DEPUIS L'ÉCRAN. Le geste est indivisible du point de vue
 * de la personne : « écris-moi un point de départ pour cet e-mail ». Laissé au client, il se
 * décompose en création + écriture du brouillon + rattachement, dont chaque maillon peut échouer
 * seul et laisser un état que l'écran ne sait pas nommer. Ici l'ordre est tenu par le serveur, et
 * l'échec du rattachement est RAPPORTÉ plutôt que masqué.
 *
 * ⛔ L'ORDRE N'EST PAS NÉGOCIABLE : DOCUMENT D'ABORD, RATTACHEMENT ENSUITE. `PUT .../lifecycle`
 * recompile le brouillon et refuse en 422 s'il manque `{{confirm_url}}` ou `{{preferences_url}}` —
 * un modèle neuf issu d'`initialDoc` parse ET compile, donc le refus tomberait vraiment. Rattacher
 * puis remplir échouerait au clic, silencieusement.
 *
 * ⛔ LE CONTENU EST FABRIQUÉ SERVEUR, JAMAIS ACCEPTÉ DU CLIENT. Accepter un document dans le corps
 * rouvrirait un chemin d'écriture de contenu sans revalidation sur l'objet le plus engagé du
 * produit : l'e-mail que personne ne relit avant qu'il parte.
 */
export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset, user } = c.ctx;

  const body = await readJson<{ kind?: unknown; assetId?: unknown }>(req);
  const kind = body?.kind;
  if (!isLifecycleKind(kind)) return jsonError("unknown lifecycle kind", 400);

  /*
   * ⛔ LA MARQUE DU GESTE EST CELLE QUE L'ÉCRAN AFFICHAIT, PAS CELLE DU COOKIE À CET INSTANT.
   * Aucun identifiant de modèle ne vient du client ici : sans ce contrôle, RIEN ne peut échouer, et
   * un onglet resté ouvert sur une marque pendant qu'un autre en a changé (le cookie `nf_asset` est
   * global au navigateur) créerait le modèle ET poserait le rattachement sur une marque que
   * personne ne regardait. Le chemin d'écriture voisin refuse déjà proprement dans ce cas
   * (`PUT .../lifecycle` résout le modèle par (id, asset.id) et rend 404) ; celui-ci doit refuser
   * aussi, et dire le geste à faire.
   */
  if (typeof body?.assetId !== "string" || body.assetId !== asset.id) {
    return jsonError("brand changed in another tab — reload the page", 409);
  }

  /* --------------------------------- Cette fente est-elle DÉJÀ servie par un modèle à moi ? */
  /*
   * ⛔ IDEMPOTENT SUR LA FENTE. Voir `lifecycleTemplateToReopen` : le garde-fou de l'écran (« pas de
   * Customise sur une fente déjà servie ») ne vit que dans un rendu serveur, qu'un retour arrière,
   * un second onglet ou une réponse perdue rendent périmé. On rouvre alors le modèle qui part
   * réellement au lieu d'en fabriquer un jumeau, et on ne crée rien.
   */
  const rouvrir = await lifecycleTemplateToReopen(db, asset.id, kind, async (templateId) => {
    // Exactement les deux conditions de l'état « bound » de l'écran : vivant dans CETTE marque
    // (`findTemplate` écarte l'archivé et l'autre marque) et ouvrable par cette personne.
    if (!(await findTemplate(db, templateId, asset.id))) return false;
    return canEditTemplate(user, templateId);
  });
  if (!rouvrir.known) {
    return jsonError("could not read what currently serves this email — try again", 503);
  }
  if (rouvrir.value) {
    return NextResponse.json({ id: rouvrir.value, kind, attached: true, reused: true }, { status: 200 });
  }

  /* ------------------------------------------------------- La langue du modèle */
  /*
   * ⛔ CE QUE LA MARQUE ENVOIE, PAS CE QU'ELLE DÉCLARE. Voir `assetEditionLocales`.
   *
   * ⛔ ET UNE LECTURE RATÉE N'EST PAS UNE MARQUE SANS ÉDITION. Les deux rendent `value: []`, mais
   * seule la seconde autorise le repli sur le registre. Retomber en silence sur `asset.languages`
   * après une panne écrit le modèle dans la langue DÉCLARÉE — celle dont on sait qu'elle a déjà
   * divergé de l'envoi en production — et rend 201 comme si de rien n'était. On refuse, comme
   * `PUT .../lifecycle` et la route de publication le font déjà sur leur propre `known`.
   */
  const editions = await assetEditionLocales(asset.id);
  if (!editions.known) {
    return jsonError("could not read the languages this brand sends in — try again", 503);
  }
  const locale = lifecycleStarterLocale(editions.value, asset.languages);

  /*
   * Les couleurs de la marque (décision d'Alix du 22/09/2026) : le thème de son modèle publié le plus
   * récent. ⚠️ Une lecture ratée ne bloque PAS ce geste-ci : on sème avec le thème par défaut du
   * builder, comme avant — une couleur se règle ensuite dans l'éditeur, un e-mail absent non.
   */
  const themes = await lireThemesDeMarque(db, [asset.id]);
  const theme = themes.known ? themes.value.get(asset.id) : undefined;

  /* ------------------------ Contre-épreuve, puis écriture : modèle + brouillon + octroi */
  // La séquence (contrôle AVANT toute écriture, retour arrière lu) vit dans `creerModeleCycleDeVie`,
  // partagée avec l'action « toutes les marques ».
  const author = await authorEmail();
  const cree = await creerModeleCycleDeVie(db, {
    assetId: asset.id,
    assetSlug: asset.slug,
    kind,
    locale,
    theme,
    author,
    userId: user.id,
  });
  if (!cree.ok) return jsonError(cree.message, cree.status);
  const id = cree.id;

  /* ------------------------------------------------ Écriture 2 : rattachement */
  /*
   * ⛔ UN ÉCHEC ICI NE DÉTRUIT PAS LE MODÈLE. Il existe, il est octroyé, il est éditable et il
   * apparaîtra dans le sélecteur : le détruire ferait perdre un contenu valide pour une raison qui
   * ne le concerne pas. On le DIT (`attached: false`) au lieu de prétendre que tout s'est passé —
   * l'écran renvoie alors la personne vers le sélecteur, qui fait exactement ce geste-là.
   */
  const lien = await setLifecycleBinding(db, asset.id, kind, id, author);
  if (!lien.ok) {
    return NextResponse.json({ id, kind, attached: false, attachError: lien.message }, { status: 201 });
  }

  return NextResponse.json({ id, kind, attached: true }, { status: 201 });
}
