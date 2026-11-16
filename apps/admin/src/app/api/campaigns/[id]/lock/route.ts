import { NextResponse } from "next/server";
import { generateIntroColumns } from "@nf/ai";
import { articlesOf } from "@nf/render/articles";
import { feedBlocksOf, describeFeed } from "@nf/render/feed";
import { extractTokens, MERGE_VARS, poserPreheader, usesAiTokens } from "@nf/render/hydrate";
import { UTM_DEFAULTS, applyUtm, utmSlug } from "@nf/render/links";
import type { EmailDoc } from "@nf/render";
import { jetonsSansValeurHorsSerie } from "@/components/campaigns/cadence";
import { weighShell } from "@/lib/weight";
import {
  findCampaign,
  findPublishedVersionRef,
  loadVersionSnapshot,
  updateCampaign,
} from "@/lib/data/campaigns";
import { resoudreChoixLegal } from "@/lib/data/legal-footer-templates";
import { jsonError, requireContext } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * ⛔ Le verrou peut désormais appeler le modèle (introduction et accroche). Sans ce plafond
 * explicite, Vercel coupe la fonction bien avant les 45 s que le client s'autorise, et l'opérateur
 * voit un échec réseau au lieu du verrou qu'il a demandé.
 */
export const maxDuration = 60;

/**
 * POST /api/campaigns/[id]/lock — fige le contenu de la campagne.
 *
 * On COPIE `html_shell` / `text_shell` / `size_bytes` de la version publiée dans la campagne.
 * Motif : republier le modèle après coup ne doit PAS changer ce que reçoivent les abonnés d'une
 * campagne déjà partie. Sans cette copie, `template_version` serait la seule source du rendu et
 * une correction de dernière minute réécrirait rétroactivement un email déjà distribué.
 *
 * Le snapshot reste un SHELL : les tokens `{{…}}` et les marqueurs `nf:if` sont résolus par
 * destinataire au send (hydratation), jamais dupliqués en base.
 *
 * ⛔ Verrouiller n'envoie rien et ne met rien en file.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const campaign = await findCampaign(db, id, asset.id);
  if (!campaign) return jsonError("campaign not found", 404);

  if (campaign.lockedAt) {
    return jsonError("campaign is already locked", 409, { lockedAt: campaign.lockedAt });
  }
  if (campaign.status !== "draft") {
    return jsonError(`only a draft campaign can be locked — this one is ${campaign.status}`, 409, {
      status: campaign.status,
    });
  }
  if (!campaign.templateVersionId) {
    return jsonError("campaign has no template version selected", 400);
  }

  // Revalidation complète : la version a pu être désarchivée, dépubliée ou son template archivé
  // depuis qu'elle a été choisie. Le verrou est le dernier moment où l'on peut encore refuser.
  const ref = await findPublishedVersionRef(db, campaign.templateVersionId, asset.id);
  if (!ref) {
    return jsonError(
      "the selected template version is no longer a published version of this brand",
      400,
      { templateVersionId: campaign.templateVersionId },
    );
  }

  const snapshot = await loadVersionSnapshot(db, ref.id);
  if (!snapshot || !snapshot.htmlShell) {
    // Une version publiée sans HTML compilé n'existe pas en pratique ; si elle apparaît, c'est un
    // défaut de publication. On refuse plutôt que de figer un email vide.
    return jsonError("the published version has no compiled HTML — republish the template", 422);
  }

  /*
   * ⛔ UNE CAMPAGNE PONCTUELLE NE PEUT PAS FIGER UN FLUX D'ARTICLES, et il faut le dire ici plutôt
   * que de laisser passer. Le HTML compilé d'un modèle à flux contient l'APERÇU — les articles du
   * jour où l'auteur a réglé le bloc. Le copier tel quel enverrait ce contenu-là à de vrais
   * abonnés, en ayant l'air d'avoir parfaitement fonctionné : ni erreur, ni journal, ni écran qui
   * s'allume. C'est exactement le défaut que le bloc flux existe pour tuer.
   *
   * Les séries récurrentes, elles, résolvent leurs flux au GEL, 90 minutes avant chaque échéance
   * (`apps/worker/src/feed-resolve.ts`). Un flux n'a de sens que là.
   */
  const { data: docRow } = await db
    .from("template_version")
    .select("doc, legal_footer_template_id")
    .eq("id", ref.id)
    .maybeSingle();
  const doc = ((docRow as { doc?: unknown } | null)?.doc ?? { rows: [] }) as EmailDoc;

  // Le pied légal que CETTE version a choisi à sa publication — c'est lui que la vue d'envoi lira.
  // Revérifié ici : les éditions de la marque ont pu changer depuis la publication.
  const choixLegal = await resoudreChoixLegal(
    db,
    asset,
    ((docRow as { legal_footer_template_id?: string | null } | null)?.legal_footer_template_id ?? null),
  );
  if (!choixLegal.ok) return jsonError(choixLegal.error, choixLegal.status);
  const feeds = feedBlocksOf(doc);
  if (feeds.length > 0) {
    return jsonError(
      `this template picks its articles shortly before each send (${describeFeed(feeds[0]!)}) — a one-off ` +
        `campaign has no such moment. Turn on recurrence for this campaign, or replace the WordPress feed ` +
        `block with imported articles.`,
      422,
    );
  }

  /*
   * ⛔ UN SHORTCODE INCONNU DANS LE SUJET NE DOIT PAS FRANCHIR LE VERROU.
   *
   * L'hydratation retire en SILENCE tout jeton hors registre (fail-closed voulu : mieux vaut un
   * blanc qu'un `{{typo}}` livré à un abonné). Conséquence : « Edição de {{data}} » part en
   * « Edição de  » chez 1 200 personnes, sans erreur, sans journal, sans écran qui s'allume. Le
   * verrou est le dernier moment où quelqu'un regarde encore — c'est donc ici que ça se refuse.
   *
   * ⚠️ On ne refuse PAS un sujet trop long une fois les jetons remplis : `{{first_article}}` n'a
   * pas encore de valeur au verrouillage (elle naît au gel, avec les articles du jour). L'écran
   * prévient sur des valeurs d'exemple ; inventer ici une estimation ferait refuser des sujets
   * parfaitement valides.
   */
  const sujetFige = campaign.subject.trim() === "" ? (snapshot.subject ?? "") : campaign.subject;
  const inconnus = extractTokens(sujetFige).filter((t) => !(t in MERGE_VARS));
  if (inconnus.length > 0) {
    return jsonError(
      `the subject uses ${inconnus.map((t) => `{{${t}}}`).join(", ")}, which ${
        inconnus.length > 1 ? "are not shortcodes" : "is not a shortcode"
      } — it would be silently removed and the subject would ship incomplete. Fix it from the campaign screen.`,
      422,
    );
  }

  /*
   * ⛔ UN JETON D'OCCURRENCE DANS LE SUJET D'UNE CAMPAGNE PONCTUELLE : LE MUR SUIVANT, REFUSÉ ICI.
   *
   * `{{first_article}}`, `{{article_count}}` et `{{edition_number}}` sont dans le registre : ils
   * passent donc le contrôle ci-dessus. Mais leur valeur n'existe QUE sur une occurrence de série —
   * elle est écrite au gel et relue nulle part ailleurs (`apps/worker/src/render.ts`, l. 158-173).
   * Une campagne sans cadence n'a ni occurrence ni gel : ces jetons s'hydratent en chaîne vide, à
   * tous les coups.
   *
   * Le dommage est exactement celui du refus juste au-dessus — un sujet qui part incomplet, sans
   * erreur, sans journal — et il va plus loin : si le sujet ne tenait QUE sur ces jetons, le gate
   * d'envoi le refuse en `missing_subject` et la campagne se ferme en `paused`, après le verrou,
   * après la planification, après que tout a été validé. Le verrou est le dernier moment où
   * quelqu'un regarde encore. Même raisonnement que le refus des blocs de flux, vingt lignes plus
   * haut : ce que la campagne ne pourra jamais produire se dit AVANT de figer.
   */
  const jetonsDeSerie = jetonsSansValeurHorsSerie(extractTokens(sujetFige), campaign.recurrenceDays.length > 0);
  if (jetonsDeSerie.length > 0) {
    return jsonError(
      `the subject uses ${jetonsDeSerie.map((t) => `{{${t}}}`).join(", ")}, which ${
        jetonsDeSerie.length > 1 ? "are filled" : "is filled"
      } from each occurrence of a series — a one-off campaign has no such moment, so the subject would ship ` +
        `with a blank there. Turn on recurrence for this campaign, or write a fixed subject.`,
      422,
    );
  }

  /*
   * BALISAGE UTM — ici, parce que c'est le premier moment où la campagne a un nom.
   *
   * ⛔ AVANT LA PESÉE, PAS APRÈS. Les paramètres ajoutent une soixantaine d'octets par lien ;
   * peser le shell nu puis baliser ferait passer sous le seuil Gmail des emails qui, une fois
   * expédiés, seraient tronqués — et Gmail coupe la fin, c'est-à-dire le footer légal et son lien
   * de désinscription. La table de mesure doit hériter du filtre de production.
   *
   * Les liens système ne sont pas concernés : ce sont encore des jetons à ce stade
   * (`{{unsubscribe_url}}`), et `applyUtm` les laisse strictement intacts — verrouillé par un test.
   */
  /*
   * ⭐ LE PREHEADER DE LA CAMPAGNE ÉCRASE CELUI DU MODÈLE — et jusqu'au 18/09/2026 il n'écrasait
   * rien du tout.
   *
   * ⛔ CE QUI ÉTAIT CASSÉ. Le champ « Preheader » de l'écran campagne était saisi, sauvegardé, gelé
   * (l. 235 ci-dessous), affiché… et n'atteignait JAMAIS la boîte du lecteur. Seul `mj-preview` —
   * donc le preheader DU MODÈLE — arrivait dans l'e-mail. Conséquence directe : deux campagnes
   * partageant un modèle avaient forcément la même ligne d'aperçu, quoi qu'on tape dans leur champ.
   *
   * ⛔ LE REPLI EST RÉSOLU ICI, et il est le MÊME qu'à l'écriture en base vingt lignes plus bas :
   * ce que la campagne a écrit, sinon ce que le modèle propose. Deux résolutions différentes
   * feraient partir un aperçu que l'écran n'annonce pas.
   *
   * ⛔ AVANT `applyUtm` ET AVANT LA PESÉE. Le preheader ajoute des octets au shell : peser avant de
   * le poser laisserait passer un e-mail qui, une fois expédié, dépasse le seuil de troncature de
   * Gmail — et Gmail coupe la FIN, c'est-à-dire le footer légal et son lien de désinscription.
   */
  const preheaderEffectif =
    campaign.preheader && campaign.preheader.trim() !== "" ? campaign.preheader : (snapshot.preheader ?? "");
  const avecPreheader = poserPreheader(snapshot.htmlShell, preheaderEffectif);

  const balise = applyUtm(avecPreheader, {
    ...UTM_DEFAULTS,
    campaign: utmSlug(campaign.name),
  });
  const htmlShell = balise.html;
  const sizeBytes = Buffer.byteLength(htmlShell, "utf8");

  // Au-delà du seuil, Gmail tronque l'email et coupe le footer légal — donc le lien de
  // désinscription. C'est un défaut de conformité, pas une coquetterie de poids.
  //
  // ⚠️ On mesure l'email HYDRATÉ, pas le shell : le footer et les liens signés que le worker
  // injecte ensuite pèsent plusieurs kilo-octets. Verrouiller sur le poids du shell laissait
  // passer exactement les emails qui se font tronquer. Même juge que `publish`.
  const weight = await weighShell(htmlShell, asset.id, asset.name, choixLegal.cfg);
  if (weight.overLimit) {
    return jsonError(weight.message ?? "email too large", 422, {
      sizeBytes,
      hydratedBytes: weight.hydratedBytes,
      overheadBytes: weight.overheadBytes,
    });
  }

  /*
   * L'INTRODUCTION ET L'ACCROCHE ÉCRITES PAR LE MODÈLE — le pendant EXACT de ce que fait le gel
   * d'une occurrence, par la MÊME fonction (`generateIntroColumns`, @nf/ai).
   *
   * ⛔ ICI, PAS AILLEURS. Le verrouillage est le seul moment d'une campagne ponctuelle où le
   * contenu est arrêté : c'est son équivalent du gel. Générer plus tôt figerait un texte qui parle
   * d'articles encore modifiables ; plus tard, il n'y a plus de « plus tard ».
   *
   * ⛔ LE JETON EST L'INTERRUPTEUR, et ⛔ UN ÉCHEC NE BLOQUE PAS LE VERROU. `generateIntroColumns`
   * ne lève pas : la campagne se verrouille avec `ai_status='failed'` et son motif. Un service
   * tiers indisponible ne doit pas empêcher d'arrêter un contenu.
   */
  /*
   * ⛔ LE DÉCLENCHEUR LIT LE PREHEADER EFFECTIF, PAS CELUI DU MODÈLE. Depuis que la campagne écrase
   * le modèle, `doc.meta.preheader` n'est plus ce qui part : s'en servir ici produirait les deux
   * erreurs symétriques — payer une génération pour un `{{ai_preheader}}` que la campagne vient
   * justement de remplacer, et ne PAS générer pour un `{{ai_preheader}}` écrit sur la campagne, qui
   * partirait alors en blanc.
   */
  const aiColumns = usesAiTokens(htmlShell, sujetFige, preheaderEffectif)
    ? await generateIntroColumns(
        {
          assetName: asset.name,
          language: doc.meta?.locale ?? "en",
          articles: articlesOf(doc),
          subject: sujetFige,
        },
        new Date(),
      )
    : null;

  const lockedAt = new Date().toISOString();
  const { error } = await updateCampaign(db, id, asset.id, {
    // Absentes quand rien ne réclame de texte du modèle : on n'écrit pas des NULL qui
    // ressembleraient à une génération ratée.
    ...(aiColumns ?? {}),
    html_shell: htmlShell,
    text_shell: snapshot.textShell,
    size_bytes: sizeBytes,
    locked_at: lockedAt,
    // Le sujet figé doit correspondre au rendu figé. On n'écrase JAMAIS un sujet déjà saisi
    // (c'est une décision éditoriale) ; on ne comble que le vide, avec celui de la version.
    ...(campaign.subject.trim() === "" ? { subject: snapshot.subject } : {}),
    ...(campaign.preheader === null || campaign.preheader.trim() === ""
      ? { preheader: snapshot.preheader }
      : {}),
  });
  if (error) return jsonError(error, 500);

  const locked = await findCampaign(db, id, asset.id);
  return NextResponse.json({ campaign: locked, lockedAt, sizeBytes });
}
