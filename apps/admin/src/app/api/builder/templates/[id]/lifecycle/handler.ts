import { NextResponse } from "next/server";
import { checkLifecycleShell, isLifecycleKind, lifecycleShellMessage } from "@nf/render/lifecycle-checks";
import { findTemplate } from "@/lib/data/templates";
import {
  lifecycleKindsOfTemplate,
  publishedLifecycleShell,
  setLifecycleBinding,
  templateOfLifecycleKind,
} from "@/lib/data/lifecycle-templates";
import { jsonError, readJson, type requireContext, type requireTemplateAccess } from "../../../_shared";

/**
 * PUT /api/builder/templates/[id]/lifecycle — désigne ce template pour un e-mail de cycle de vie,
 * ou retire un rattachement. Trois corps, un seul écrivain :
 *   { kind: K }                 ce template sert K (et évince celui qui servait K)
 *   { kind: K, detach: true }   K n'est plus servi par ce template
 *   { kind: null }              ce template ne sert plus AUCUN e-mail de cycle de vie
 *
 * ⛔ POURQUOI LE DÉTACHEMENT ACCEPTE UN KIND EXPLICITE. Un écran orienté « e-mail » (la liste des
 * modèles) veut vider UNE fente ; la fiche d'un modèle, elle, veut débrancher CE modèle. Sans le
 * kind, la route devait redécouvrir « le kind de ce template » — or un template peut en servir deux,
 * la lecture rendait alors une erreur, donc `null`, donc un 200 « détaché » qui n'avait rien
 * supprimé. Un faux succès parfait : l'écran se rafraîchissait sur l'état inchangé.
 *
 * ⛔ CE QUE CE GESTE FAIT VRAIMENT. À partir du rattachement, le worker sert ce template À LA PLACE
 * du HTML en dur, pour tous les envois de ce kind sur cette marque. C'est le seul écran du produit
 * qui change le contenu d'un e-mail que personne ne relit avant qu'il parte.
 *
 * ⛔ ON CONTRÔLE AU RATTACHEMENT, PAS SEULEMENT À LA PUBLICATION. La barrière de publication ne
 * protège que les publications À VENIR : rattacher un template DÉJÀ publié et dépourvu de
 * `{{confirm_url}}` le mettrait en service immédiatement, sans que rien ne s'y oppose. On refuse
 * donc ici la même chose, avec la même fonction et la même phrase.
 *
 * ⚠️ On juge la version PUBLIÉE — c'est elle que le worker servira (voir « Attacher »). Un template
 * jamais publié est rattachable : la vue ne rend rien tant qu'aucune version n'est publiée, donc le
 * worker sert le HTML en dur, ce qui n'est jamais une panne. Le contrôle mordra à la publication.
 *
 * Module séparé de `route.ts` : la session et l'octroi y sont injectés, pour qu'un banc mesure la
 * route sans cookie. L'auteur est lu sur la session déjà résolue — `authorEmail()` relisait la même.
 */

export interface LifecycleDeps {
  requireContext: () => ReturnType<typeof requireContext>;
  requireTemplateAccess: typeof requireTemplateAccess;
}

export async function putLifecycle(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: LifecycleDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset, user } = c.ctx;
  const auteur = user.email;

  const { id } = await params;
  const template = await findTemplate(db, id, asset.id);
  if (!template) return jsonError("template not found", 404);

  // Octroi : 404 et non 403, un template non octroyé est indiscernable d'un inexistant.
  const refus = await deps.requireTemplateAccess(c.ctx, template.id);
  if (refus) return refus;

  const body = await readJson<{ kind?: unknown; detach?: unknown }>(req);
  const kind = body?.kind ?? null;
  // ⚠️ Comparaison FERMÉE au booléen `true` : un `"false"` ou un `0` traînant dans le corps ne doit
  // pas basculer un rattachement en détachement — les deux gestes n'ont pas la même conséquence.
  const detacher = body?.detach === true;

  /* ------------------------------------- Détacher tout ce que ce template sert */
  if (kind === null) {
    // Retirer ne peut jamais casser un envoi : le worker retombe sur le HTML en dur.
    const actuels = await lifecycleKindsOfTemplate(db, asset.id, template.id);
    // Ne rien savoir n'autorise pas à répondre « c'est fait » : ce serait le faux succès qu'on fuit.
    if (!actuels.known) return jsonError("could not read the current lifecycle setting", 503);
    for (const actuel of actuels.value) {
      // Le dernier argument fait porter « et seulement si c'est bien CE template » par le DELETE
      // lui-même : entre la lecture ci-dessus et ici, quelqu'un a pu poser un autre modèle.
      const r = await setLifecycleBinding(db, asset.id, actuel, null, auteur, template.id);
      if (!r.ok) return jsonError(r.message, 500);
    }
    return NextResponse.json({ kind: null });
  }

  if (!isLifecycleKind(kind)) return jsonError("unknown lifecycle kind", 400);

  /* ------------------------------------------------- Détacher CE kind précis */
  if (detacher) {
    const porteur = await templateOfLifecycleKind(db, asset.id, kind);
    if (!porteur.known) return jsonError("could not read the current lifecycle setting", 503);
    // Vider par (asset_id, kind) écraserait le réglage d'un AUTRE template si l'écran était périmé.
    // On ne supprime donc que si ce template sert bien ce kind ; sinon l'état demandé est déjà vrai.
    // ⛔ CETTE LECTURE NE PROTÈGE RIEN À ELLE SEULE : elle donne le 200 sans effet du cas courant,
    // mais entre elle et le DELETE la fente peut changer de porteur. C'est le prédicat
    // `template_id` passé ci-dessous, évalué par Postgres, qui interdit d'effacer le réglage
    // d'autrui.
    if (porteur.value !== template.id) return NextResponse.json({ kind: null });
    const r = await setLifecycleBinding(db, asset.id, kind, null, auteur, template.id);
    return r.ok ? NextResponse.json({ kind: null }) : jsonError(r.message, 500);
  }

  /* ------------------------------------------------------------- Attacher */
  /*
   * ⛔ ON JUGE LE SHELL QUI PARTIRAIT : celui de la version PUBLIÉE, que la vue d'envoi lit. Il est
   * déjà compilé (en-tête et pied de marque compris) : le contrôle ne cherche que des jetons, il n'y a
   * rien à recompiler. Juger le brouillon, comme avant le 16/09, laissait rattacher un template dont la
   * version en ligne n'a pas de lien de confirmation — et le worker la servait aussitôt.
   * Jamais publié : rattachable, le worker sert le HTML en dur ; la publication contrôlera.
   * Illisible : un verdict impossible ne s'écrit pas « conforme ».
   */
  const publiee = await publishedLifecycleShell(db, template.id);
  if (!publiee.known) {
    return jsonError("could not read this template's published version — the lifecycle setting was left unchanged", 503);
  }
  if (publiee.value) {
    const rapport = checkLifecycleShell({ kind, ...publiee.value });
    if (!rapport.ok) {
      return jsonError(
        `${lifecycleShellMessage(rapport) ?? "template is not usable here"} Fix it in the builder and publish, then try again.`,
        422,
      );
    }
  }

  const r = await setLifecycleBinding(db, asset.id, kind, template.id, auteur);
  return r.ok ? NextResponse.json({ kind }) : jsonError(r.message, r.message.includes("another brand") ? 409 : 500);
}
