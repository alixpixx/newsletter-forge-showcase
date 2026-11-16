import { NextResponse } from "next/server";
import { EmailDocPublishable } from "@nf/render/schema";
import { weighShell } from "@/lib/weight";
import { compileDoc } from "@nf/render/compile";
import { checkLifecycleShell, lifecycleShellMessage } from "@nf/render/lifecycle-checks";
import { authorEmail, findTemplate, getDraftRow } from "@/lib/data/templates";
import { resolveBrandPartials } from "@/lib/data/brand-partials";
import { legalTemplateIdOf, poserChoixLegal, resoudreChoixLegal } from "@/lib/data/legal-footer-templates";
import { lifecycleKindsOfTemplate } from "@/lib/data/lifecycle-templates";
import { issuesOf, jsonError, readJson, requireContext, requireTemplateAccess } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PublishBody {
  note?: unknown;
}

/**
 * POST /api/builder/templates/[id]/publish — fige le brouillon en version n+1.
 *
 * Les barrières de contenu, en 422 (le document existe, il n'est simplement pas publiable) — une
 * lecture qui n'aboutit pas répond 503 :
 *  1. `EmailDocPublishable` — sujet renseigné, `alt` non vide sur chaque image. Un brouillon
 *     incomplet reste sauvegardable et prévisualisable ; il n'est pas envoyable.
 *  2. Compilation MJML — une erreur du moteur ne doit jamais produire une version publiée vide.
 *  3. Absence de footer légal — refusée ICI parce que l'envoi la refuse déjà (voir plus bas).
 *  4. Jetons du cycle de vie — si ce template sert une `confirmation` ou un `reengagement`
 *     (rattachement `lifecycle_template`, 0059), il doit porter le lien sans lequel cet e-mail ne
 *     fait rien. Ne s'applique JAMAIS à un template ordinaire.
 *  5. Poids > 102 400 octets — au-delà, Gmail tronque l'email et coupe le footer légal
 *     (donc le lien de désinscription) : c'est un défaut de conformité, pas une coquetterie.
 *  6. Pied légal choisi — il doit exister dans la marque et être complet pour chaque édition.
 *

 * L'écriture elle-même est atomique côté base (RPC `template_publish` : publie le brouillon
 * courant PUIS en recrée un identique).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const template = await findTemplate(db, id, asset.id);
  if (!template) return jsonError("template not found", 404);

  // ⛔ Le garde est posé ICI, avant la RPC `template_publish` : celle-ci est SECURITY DEFINER et
  // écrit sur l'identifiant qu'on lui passe sans vérifier à qui il appartient. Le déplacer dans
  // la fonction SQL changerait sa signature, donc casserait l'appel par nom de PostgREST.

  // ⛔ Octroi : 404 et non 403, un template non octroyé est indiscernable d'un inexistant.
  const refus = await requireTemplateAccess(c.ctx, template.id);
  if (refus) return refus;

  const draft = await getDraftRow(db, template.id);
  if (!draft) return jsonError("draft not found", 404);

  const body = await readJson<PublishBody>(req);
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;

  const parsed = EmailDocPublishable.safeParse(draft.doc);
  if (!parsed.success) {
    const warnings = issuesOf(parsed.error);
    return NextResponse.json({ error: "document is not publishable", warnings }, { status: 422 });
  }

  /*
   * ⛔ SIXIÈME BARRIÈRE, ET ELLE SE FERME EN 503, PAS EN 422 : l'en-tête et le pied de marque.
   * Le document ne porte qu'un POINTEUR ; les rows sont résolues ICI, à la compilation, parce que
   * c'est ici que le HTML est figé dans `template_version.html_shell` — et c'est ce shell que le
   * worker servira, sans jamais savoir qu'un partial existe.
   *
   * ⛔ UN POINTEUR NON RÉSOLU REFUSE LA PUBLICATION. Publier sans l'en-tête produirait une version
   * figée, silencieusement nue, que personne ne distinguerait d'une version correcte avant de l'avoir
   * reçue — et republier plus tard ne rattrape pas les envois partis entre-temps. 503 et non 422 :
   * le document n'est pas en faute, c'est la lecture qui n'a pas abouti, et réessayer a du sens.
   */
  const partials = await resolveBrandPartials(db, asset.id, parsed.data.meta);
  if (!partials.known) {
    return jsonError(
      "the brand header or footer this email points at could not be read — nothing was published",
      503,
    );
  }

  let compiled;
  try {
    compiled = await compileDoc(parsed.data, { header: partials.value.header, footer: partials.value.footer });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `compilation failed: ${message}`, warnings: [] }, { status: 422 });
  }

  // ⛔ SANS BLOC FOOTER LÉGAL, LE SHELL N'A AUCUN POINT D'INJECTION : le worker met l'envoi en veto
  // (`footer_incomplete:legal_footer_block`, apps/worker/src/render.ts) et l'email ne part jamais.
  // Ce refus existait donc déjà — il arrivait simplement des jours plus tard, sur une campagne, loin
  // de l'écran où l'auteur pouvait encore agir. On le remonte à la publication, au même endroit et
  // dans la même forme que les autres barrières de contenu (422 + `warnings`).
  // ⚠️ On teste le TOKEN DANS LE SHELL, pas le texte de l'avertissement du compilateur : c'est
  // exactement la chaîne que le worker cherche, donc les deux refus ne peuvent pas se désaccorder
  // (une reformulation de l'avertissement, elle, les séparerait en silence). L'avertissement reste
  // renvoyé dans `warnings` : le panneau de pré-vol et ce refus disent la même phrase.
  if (!compiled.html.includes("{{legal_footer_html}}")) {
    return NextResponse.json(
      {
        error:
          "no legal footer block — add the legal footer as the last block of the email, otherwise the send is vetoed for having no unsubscribe link",
        warnings: compiled.warnings,
      },
      { status: 422 },
    );
  }

  // ⛔ 5e BARRIÈRE — CE TEMPLATE SERT-IL UN E-MAIL DE CYCLE DE VIE, ET LUI MANQUE-T-IL CE SANS QUOI
  // CET E-MAIL NE FAIT RIEN ? Depuis 0059, une marque peut désigner un template pour remplacer le
  // HTML en dur d'une `confirmation` ou d'un `reengagement`. Le worker retombe toujours sur le code
  // en dur si le template MANQUE — mais s'il est présent et incomplet, il part tel quel. Un e-mail
  // de confirmation sans lien de confirmation est le pire cas du produit : la personne clique dans
  // le vide, ne confirme jamais, et le consentement que la loi nous demande de prouver n'existe pas.
  //
  // ⚠️ La règle vit dans `@nf/render/lifecycle-checks`, appelée AUSSI par le pré-vol : le bouton
  // « Publish » et ce refus doivent dire la même chose, sinon l'auteur prend un 422 sur un écran qui
  // vient de lui annoncer que tout va bien.
  //
  // ⚠️ Le contrôle ne s'applique qu'aux templates RATTACHÉS. Un template ordinaire n'est jamais
  // concerné — sans ce filtre, toutes les campagnes deviendraient impubliables.
  //
  // ⚠️ TOUS les kinds servis, et un refus net quand on ne peut pas les lire. Un template peut en
  // servir deux (la clé est (asset_id, kind)) : n'en contrôler qu'un laisserait passer l'autre. Et
  // une lecture en erreur ne vaut pas « ce template n'est rattaché à rien » — sur cette barrière-là,
  // confondre les deux publie l'e-mail de confirmation sans l'avoir contrôlé.
  const lifecycleKinds = await lifecycleKindsOfTemplate(db, asset.id, template.id);
  if (!lifecycleKinds.known) {
    return NextResponse.json(
      {
        error: "could not check whether this template serves a lifecycle email — try again",
        warnings: compiled.warnings,
      },
      { status: 503 },
    );
  }
  for (const lifecycleKind of lifecycleKinds.value) {
    const rapport = checkLifecycleShell({
      kind: lifecycleKind,
      html: compiled.html,
      text: compiled.text,
      subject: parsed.data.meta.subject,
    });
    if (!rapport.ok) {
      return NextResponse.json(
        { error: lifecycleShellMessage(rapport), warnings: compiled.warnings },
        { status: 422 },
      );
    }
  }

  // ⛔ LE PIED LÉGAL CHOISI (bloc `footer_legal`, `legalTemplateId`). Introuvable ou incomplet pour
  // une édition de la marque ⇒ refus : publier retomberait sur un autre pied que celui que l'auteur a
  // choisi, ou produirait des envois mis en veto (`footer_incomplete`) sans qu'aucun écran le dise.
  const choixLegal = await resoudreChoixLegal(db, asset, legalTemplateIdOf(parsed.data));
  if (!choixLegal.ok) {
    return NextResponse.json({ error: choixLegal.error, warnings: compiled.warnings }, { status: choixLegal.status });
  }

  // ⚠️ On pèse l'email HYDRATÉ — shell + footer légal le plus lourd de la marque + liens signés —
  // et non `compiled.sizeBytes`, qui ignore tout ce que le worker ajoute ensuite. Un document
  // approuvé à 101 Ko de shell part à plus de 106 Ko : Gmail coupe la fin, donc le lien de
  // désabonnement. Voir `@nf/render/shell-checks`. Le pied pesé est celui qui partira : le choisi.
  const weight = await weighShell(compiled.html, asset.id, asset.name, choixLegal.cfg);
  if (weight.overLimit) {
    return NextResponse.json(
      {
        error: weight.message,
        warnings: compiled.warnings,
        sizeBytes: compiled.sizeBytes,
        hydratedBytes: weight.hydratedBytes,
        // Rendu explicite : sans lui, l'écart entre le poids affiché ailleurs et celui du refus
        // se lit comme une incohérence de l'outil.
        overheadBytes: weight.overheadBytes,
      },
      { status: 422 },
    );
  }

  // Le sujet publié est celui du DOCUMENT (seule source validée ci-dessus) : on aligne la colonne
  // avant de figer, sinon une version publiée pourrait porter un sujet obsolète.
  if (draft.subject !== parsed.data.meta.subject || draft.preheader !== parsed.data.meta.preheader) {
    await db
      .from("template_version")
      .update({ subject: parsed.data.meta.subject, preheader: parsed.data.meta.preheader })
      .eq("id", draft.id);
  }

  // Le choix est posé sur le BROUILLON juste avant que la RPC le fige en version publiée : c'est
  // cette colonne que la vue d'envoi lit. Posé même à `null`, pour ne pas hériter d'un envoi de test.
  const pose = await poserChoixLegal(db, draft.id, choixLegal.templateId);
  if (!pose.ok) return jsonError(pose.error, 500);

  const { data, error } = await db.rpc("template_publish", {
    p_template_id: template.id,
    p_html: compiled.html,
    p_text: compiled.text,
    p_size: compiled.sizeBytes,
    p_compiler: compiled.compilerVersion,
    p_warnings: compiled.warnings,
    p_author: await authorEmail(),
    p_note: note,
  });

  if (error) return jsonError(error.message, 500);

  const row = (Array.isArray(data) ? data[0] : data) as { version?: unknown } | null;
  const version = Number(row?.version ?? 0);
  if (!version) return jsonError("publish did not return a version", 500);

  return NextResponse.json({ version, warnings: compiled.warnings, sizeBytes: compiled.sizeBytes });
}
