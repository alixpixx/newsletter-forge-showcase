import { NextResponse } from "next/server";
import { authorEmail } from "@/lib/data/templates";
import { creerModeleCycleDeVie, retirerModele } from "@/lib/lifecycle-seed-create";
import { semerToutesLesMarques } from "@/lib/lifecycle-seed-all";
import { jsonError, readJson, requireSuperAdmin } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/builder/lifecycle-seed/all-brands — « Create editable versions for all brands ».
 * Corps : `{ confirm: "all-brands" }`.
 *
 * Pour chaque marque et chacun des quatre e-mails de cycle de vie dont la fente est LIBRE : crée un
 * modèle du builder aux couleurs de la marque (brouillon + version publiable) et le rattache. Une
 * fente déjà servie n'est jamais touchée — voir `lifecycle-seed-all.ts` pour les deux barrières.
 *
 * ⛔ SUPER_ADMIN SEULEMENT. Le geste écrit dans TOUTES les marques ; un administrateur de marque n'a
 * pas à créer de modèles chez les autres.
 *
 * ⛔ LE CORPS DE CONFIRMATION N'EST PAS DÉCORATIF. Un POST vide — un rejeu, un lien suivi par un outil
 * — ne doit pas suffire à écrire dans toutes les marques : l'écran envoie la phrase après une
 * confirmation explicite, rien d'autre ne l'envoie.
 *
 * ⚠️ LES MODÈLES CRÉÉS SONT DES BROUILLONS. Tant qu'aucune version n'est PUBLIÉE, le worker continue
 * d'envoyer le HTML de secours (`renderLifecycle` retombe dessus sans alerter : un rattachement sans
 * version publiée n'est pas une panne). Publier chaque modèle reste un geste humain, dans le builder.
 */
export async function POST(req: Request) {
  const c = await requireSuperAdmin();
  if (!c.ok) return c.res;
  const { db, user } = c.ctx;

  const body = await readJson<{ confirm?: unknown }>(req);
  if (body?.confirm !== "all-brands") return jsonError("confirmation missing", 400);

  const author = await authorEmail();
  const r = await semerToutesLesMarques({
    db,
    author,
    creer: async ({ marque, kind, locale, theme }) => {
      const cree = await creerModeleCycleDeVie(db, {
        assetId: marque.id,
        assetSlug: marque.slug,
        kind,
        locale,
        theme,
        author,
        userId: user.id,
      });
      return cree.ok ? cree : { ok: false, message: cree.message };
    },
    retirer: (id) => retirerModele(db, id),
  });
  if (!r.known) {
    // Rien n'a été écrit : les lectures préalables ont échoué avant la première création.
    return jsonError("could not read the brands and their current lifecycle emails — nothing was created, try again", 503);
  }
  return NextResponse.json({ lignes: r.lignes }, { status: 200 });
}
