import { compileDoc } from "@nf/render/compile";
import { checkLifecycleShell, lifecycleShellMessage, type LifecycleKind } from "@nf/render/lifecycle-checks";
import { slugify, uniqueSlug } from "@/lib/data/templates";
import { grantTemplate } from "@/lib/data/app-user";
import type { getDb } from "@/lib/supabase";
import { lifecycleStarter, lifecycleStarterDisplayName } from "@/lib/lifecycle-starter";

type Db = NonNullable<ReturnType<typeof getDb>>;

/**
 * CRÉER LE MODÈLE DE DÉPART D'UN E-MAIL DE CYCLE DE VIE — modèle, brouillon, octroi — SANS le rattacher.
 *
 * ⛔ POURQUOI CE MODULE EXISTE. Ces trois écritures vivaient dans `api/builder/lifecycle-seed/route.ts`.
 * L'action « toutes les marques » (décision d'Alix du 22/09/2026) fait le même geste pour chaque
 * marque : recopier la séquence en aurait fait deux, et la première correction n'aurait touché que
 * l'une. Une seule séquence, deux appelants.
 *
 * ⛔ LE RATTACHEMENT N'EST PAS ICI, À DESSEIN. Les deux appelants ne rattachent pas de la même façon :
 * la route d'une marque DÉPLACE le rattachement sur le modèle neuf (c'est son geste, « Customise ») ;
 * l'action toutes marques ne pose un rattachement QUE sur une fente libre et n'en écrase jamais un
 * (voir `lifecycle-seed-all.ts`).
 */
export async function creerModeleCycleDeVie(
  db: Db,
  p: {
    assetId: string;
    assetSlug: string;
    kind: LifecycleKind;
    locale: string;
    theme?: unknown;
    author: string | null;
    userId: string;
  },
): Promise<{ ok: true; id: string } | { ok: false; status: number; message: string }> {
  const starter = lifecycleStarter(p.kind, { assetSlug: p.assetSlug, locale: p.locale, theme: p.theme });

  /*
   * ⛔ ON NE CRÉE PAS UN DOCUMENT QU'ON N'A PAS CONTRÔLÉ. La fabrique est vérifiée par un banc, mais
   * c'est ici que la conséquence tombe : si une modification future du point de départ perdait le
   * jeton exigé, ce contrôle refuse AVANT de créer quoi que ce soit, au lieu de laisser partir un
   * e-mail de confirmation sans lien de confirmation. Même fonction que la route de publication et
   * que la route de rattachement — trois contrôles différents finiraient par diverger.
   *
   * ⚠️ PAS DE RÉSOLUTION D'EN-TÊTE DE MARQUE ICI : le document sort d'une fabrique en mémoire dont le
   * `meta` ne contient aucun `*PartialId`. Appliquer un en-tête est un geste SÉPARÉ.
   */
  try {
    const compiled = await compileDoc(starter.doc);
    const rapport = checkLifecycleShell({
      kind: p.kind,
      html: compiled.html,
      text: compiled.text,
      subject: starter.doc.meta.subject,
    });
    if (!rapport.ok) {
      return {
        ok: false,
        status: 500,
        message: `the starting point could not be built: ${lifecycleShellMessage(rapport) ?? "missing merge tag"}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      status: 500,
      message: `the starting point could not be compiled: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  const slug = await uniqueSlug(db, p.assetId, starter.name);
  // ⛔ LE NOM SUIT LE SLUG (voir `lifecycleStarterDisplayName`) : deux modèles semés pour le même kind
  // ne doivent pas porter le même libellé dans le sélecteur.
  const name = lifecycleStarterDisplayName(p.kind, slugify(starter.name), slug);

  const { data, error } = await db
    .from("template")
    .insert({ asset_id: p.assetId, slug, name, category: starter.category, created_by: p.author })
    .select("id")
    .single();
  if (error || !data) return { ok: false, status: 500, message: error?.message ?? "could not create template" };
  const id = String((data as { id: string }).id);

  const { error: draftError } = await db.from("template_version").insert({
    template_id: id,
    version: 0,
    status: "draft",
    subject: starter.doc.meta.subject,
    preheader: starter.doc.meta.preheader,
    doc: starter.doc,
    doc_schema: 2,
  });
  if (draftError) {
    // Un template sans brouillon est inéditable ET invisible du builder : mieux vaut échouer net.
    const retire = await retirerModele(db, id);
    return {
      ok: false,
      status: 500,
      message: retire
        ? `could not create draft: ${draftError.message}`
        : `could not create draft (${draftError.message}) and the empty template could not be removed — id ${id}`,
    };
  }

  /*
   * ⛔ L'OCTROI FAIT PARTIE DE LA CRÉATION, ET IL LÈVE. Sans lui, `listTemplatesRead` filtre le modèle
   * hors de la liste et `/builder/[id]` rend un 404 pour son propre auteur. `grantTemplate` jette au
   * lieu de rendre une erreur : sans ce try, l'échec tomberait APRÈS les deux insertions, laissant un
   * modèle que son auteur ne reverra jamais.
   */
  try {
    await grantTemplate(db, p.userId, id, p.userId);
  } catch (err) {
    const retire = await retirerModele(db, id);
    const raison = err instanceof Error ? err.message : "unknown error";
    return {
      ok: false,
      status: 500,
      message: retire
        ? `could not grant access to the new template: ${raison}`
        : `could not grant access to the new template (${raison}) and it could not be removed — id ${id}`,
    };
  }

  return { ok: true, id };
}

/**
 * Retire un modèle qu'on vient de créer. Rien n'est transactionnel (PostgREST) : on défait nous-mêmes.
 *
 * ⛔ ET ON LIT CE QUE LE RETRAIT RÉPOND. Un retour arrière dont on n'inspecte pas l'erreur est un retour
 * arrière rendu comme réussi : le message affirmait que rien n'avait été créé alors qu'une ligne
 * `template` subsistait, invisible et comptée. Rend faux quand quelque chose subsiste.
 *
 * ⚠️ L'octroi (`app_user_template`) part avec le modèle : sa clé étrangère est `on delete cascade`
 * (relu en prod le 22/09/2026). Le rattachement aussi — c'est pourquoi on ne retire JAMAIS par ici un
 * modèle qui serait déjà rattaché : la cascade effacerait le réglage de la marque avec lui.
 */
export async function retirerModele(db: Db, id: string): Promise<boolean> {
  const { error: erreurBrouillon } = await db.from("template_version").delete().eq("template_id", id);
  const { error: erreurModele } = await db.from("template").delete().eq("id", id);
  return !erreurBrouillon && !erreurModele;
}
