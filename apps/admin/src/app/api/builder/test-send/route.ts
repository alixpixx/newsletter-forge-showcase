import { NextResponse } from "next/server";
import { EmailDoc } from "@nf/render/schema";
import { compileDoc } from "@nf/render/compile";
import { authorEmail, findTemplate, getDraftRow } from "@/lib/data/templates";
import { resolveBrandPartials } from "@/lib/data/brand-partials";
import { legalTemplateIdOf, poserChoixLegal, resoudreChoixLegal } from "@/lib/data/legal-footer-templates";
import { etatDuTest, verifierExclusion } from "@/lib/test-send-verdict";
import { isEmail, issuesOf, jsonError, readJson, requireContext, requireTemplateAccess } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TestSendBody {
  templateId?: unknown;
  to?: unknown;
}

/**
 * POST /api/builder/test-send — met un envoi de test EN FILE dans `newsletter.email_outbox`.
 *
 * L'admin n'envoie jamais lui-même : un seul chemin d'envoi (le worker) = une seule barrière de
 * conformité, un seul quota Mailgun, une seule trace. On compile ici et on fige le HTML dans
 * `payload` — la ligne reste envoyable telle quelle même si le brouillon change juste après.
 *
 * Le worker sait rendre `kind='test'` : il hydrate le HTML figé (shell de version publiée, ou le
 * `payload.html` compilé ici quand le brouillon n'est pas publié) — vérifié en dry-run.
 *
 * ⚠️ HONNÊTETÉ — la mise en file ne garantit PAS la réception : le worker tourne en `dry-run` par
 * défaut, et en mode `live` il applique une allow-list stricte. La réponse porte donc
 * `delivery:"queued"` et l'UI ne doit annoncer qu'une MISE EN FILE, jamais une réception.
 */
export async function POST(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const body = await readJson<TestSendBody>(req);
  const templateId = typeof body?.templateId === "string" ? body.templateId : "";
  const to = typeof body?.to === "string" ? body.to.trim() : "";

  if (!templateId) return jsonError("templateId is required", 400);
  if (!to) return jsonError("recipient address is required", 400);
  if (!isEmail(to)) return jsonError(`"${to}" is not a valid email address`, 422);

  const template = await findTemplate(db, templateId, asset.id);
  if (!template) return jsonError("template not found", 404);

  // ⛔ L'envoi de test fait sortir le CONTENU du template par email : c'est une lecture, avec un
  // destinataire choisi par l'appelant. Elle demande le même droit que l'ouverture.
  const refus = await requireTemplateAccess(c.ctx, template.id);
  if (refus) return refus;

  /*
   * ⛔ LA LISTE D'EXCLUSION SE LIT AU CLIC. Le worker écarte un test vers une adresse exclue — à raison,
   * c'est un vrai e-mail — mais l'écran avait déjà dit « Queued » : le 24/09, deux tests vers une
   * adresse effacée sont restés sans réponse (`lib/test-send-verdict.ts`). Illisible ⇒ on refuse,
   * plutôt que de mettre en file un test dont on ne sait pas s'il partira.
   */
  const exclusion = await verifierExclusion(db, to, asset.id);
  if (!exclusion.ok) return jsonError(exclusion.message, exclusion.status);

  const draft = await getDraftRow(db, template.id);
  if (!draft) return jsonError("draft not found", 404);

  const parsed = EmailDoc.safeParse(draft.doc);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid document", warnings: issuesOf(parsed.error) }, { status: 422 });
  }

  /*
   * ⛔ UN ENVOI DE TEST DOIT MONTRER L'E-MAIL RÉEL, en-tête de marque compris — c'est sa seule
   * raison d'être. Un test qui arrive sans l'en-tête ferait conclure « il manque le logo » à
   * quelqu'un dont le modèle est parfait, ou l'inverse : valider une mise en page qu'aucun
   * destinataire ne recevra. On refuse plutôt que d'envoyer une image fausse du résultat.
   */
  const partials = await resolveBrandPartials(db, asset.id, parsed.data.meta);
  if (!partials.known) {
    return jsonError(
      "the brand header or footer this email points at could not be read — no test was sent",
      503,
    );
  }

  let compiled;
  try {
    compiled = await compileDoc(parsed.data, { header: partials.value.header, footer: partials.value.footer });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError(`compilation failed: ${message}`, 422);
  }

  /*
   * ⛔ LE PIED LÉGAL CHOISI VOYAGE PAR LE BROUILLON. La vue d'envoi lit le choix sur la version que
   * pointe la ligne (`template_version_id` = ce brouillon) : on l'y pose AVANT la mise en file. Un
   * choix introuvable ou incomplet refuse, pour la même raison que l'en-tête ci-dessus : un test qui
   * arrive avec un autre pied que celui choisi fait valider un e-mail que personne ne recevra.
   */
  const choixLegal = await resoudreChoixLegal(db, asset, legalTemplateIdOf(parsed.data));
  if (!choixLegal.ok) return jsonError(choixLegal.error, choixLegal.status);
  const pose = await poserChoixLegal(db, draft.id, choixLegal.templateId);
  if (!pose.ok) return jsonError(pose.error, 500);

  const subject = `[TEST] ${draft.subject || parsed.data.meta.subject || template.name}`.slice(0, 300);

  const { data: ligne, error } = await db.from("email_outbox").insert({
    asset_id: asset.id,
    to_email: to,
    kind: "test",
    subject,
    status: "pending",
    // `template_version_id` pointe le BROUILLON : la vue outbox_context expose son html_shell,
    // encore vide tant qu'aucune publication n'a eu lieu — d'où le HTML figé dans `payload`.
    template_version_id: draft.id,
    payload: {
      source: "builder-test",
      template_id: template.id,
      template_slug: template.slug,
      requested_by: await authorEmail(),
      html: compiled.html,
      text: compiled.text,
      size_bytes: compiled.sizeBytes,
      compiler_version: compiled.compilerVersion,
    },
  }).select("id").single();

  if (error) return jsonError(error.message, 500);

  return NextResponse.json({
    ok: true,
    delivery: "queued",
    // L'identifiant de la ligne : l'écran suit ce que le worker en fait (GET ci-dessous).
    id: (ligne as { id: string } | null)?.id ?? null,
    warnings: compiled.warnings,
    sizeBytes: compiled.sizeBytes,
  });
}

/**
 * GET /api/builder/test-send?id=… — ce que le worker a fait d'un envoi de test : parti, écarté (et
 * pourquoi), refusé par le fournisseur, ou encore en file. Seule une ligne `test` de la marque
 * courante se lit ici : ni une autre marque, ni un autre kind.
 */
export async function GET(req: Request) {
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError("id is required", 400);

  const { data, error } = await db
    .from("email_outbox")
    .select("status, error, sent_at")
    .eq("id", id)
    .eq("asset_id", asset.id)
    .eq("kind", "test")
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("test not found", 404);

  return NextResponse.json(etatDuTest(data as { status: string; error: string | null; sent_at: string | null }));
}
