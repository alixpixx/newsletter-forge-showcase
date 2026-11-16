import type { AppRole } from "@/lib/auth";
import { lireBooleenOptionnel, voitToutesLesMarques } from "@/lib/acces";
import { grantedAssetIds, type AppUserRow, type AppUserStatus, type Db } from "@/lib/data/app-user";
import { isUuid } from "@/lib/data/templates";

/**
 * Modification d'un compte — la décision, séparée du transport et des écritures.
 *
 * Tout ce qui peut REFUSER une modification vit ici ; la route ne fait que garder l'accès, lire la
 * cible, appeler cette fonction et écrire ce qu'elle rend. Même gabarit `handler.ts` +
 * `handler.test.ts` que les routes d'effacement et de cycle de vie : c'est ce qui permet de prouver
 * sans base qu'un drapeau mal typé est refusé et que le contrôle des templates suit le drapeau de
 * MARQUES — le seul des deux qui décide de ce qu'est un octroi mort.
 */

export type Modification = {
  role?: AppRole;
  status?: AppUserStatus;
  /** « All brands » (0075). `undefined` = inchangé. Voir lib/acces.ts : `false` est une valeur à écrire. */
  allAssets?: boolean;
  /** « All templates » (0075). `undefined` = inchangé, `false` est une valeur à écrire. */
  allTemplates?: boolean;
  /** `null` = on ne touche pas aux octrois de marque. */
  assetIds: string[] | null;
  /** `null` = on ne touche pas aux octrois de template. */
  templateIds: string[] | null;
};

export type DecisionModification =
  | { ok: true; modif: Modification }
  | { ok: false; statut: number; erreur: string; extra?: Record<string, unknown> };

/** ⚠️ `all_assets` seul : le contrôle « la marque avant ses templates » ne dépend QUE des marques.
 *  `all_templates` n'ouvre aucune marque, donc il ne peut pas rendre un octroi vivant. */
type Cible = Pick<AppUserRow, "id" | "role" | "status" | "password_hash" | "all_assets">;

const listeIds = (v: unknown): string[] | null =>
  Array.isArray(v) ? [...new Set(v.map(String).filter(isUuid))] : null;

const refus = (statut: number, erreur: string, extra?: Record<string, unknown>): DecisionModification => ({
  ok: false,
  statut,
  erreur,
  extra,
});

export async function preparerModification(
  corpsRecu: unknown,
  cible: Cible,
  db: Db,
): Promise<DecisionModification> {
  const body = (corpsRecu ?? {}) as {
    role?: unknown;
    status?: unknown;
    allAssets?: unknown;
    allTemplates?: unknown;
    assetIds?: unknown;
    templateIds?: unknown;
  };

  let role: AppRole | undefined;
  if (body.role !== undefined) {
    if (body.role !== "super_admin" && body.role !== "member") return refus(400, "Unknown role.");
    role = body.role;
  }

  let status: AppUserStatus | undefined;
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") {
      // « invited » ne se pose pas à la main : ce serait un compte en attente d'un lien que
      // personne n'a émis — une invitation qui ne peut aboutir.
      return refus(400, "Status must be active or disabled.");
    }
    if (cible.status === "invited") return refus(409, "This invitation has not been accepted yet.");
    if (body.status === "active" && !cible.password_hash) {
      return refus(409, "This account has no password yet — send a new invitation.");
    }
    status = body.status;
  }

  // ⛔ Deux lectures SÉPARÉES : ce sont deux droits distincts, et un corps qui envoie l'un mal typé
  // doit être refusé en le NOMMANT — sinon l'administrateur corrige le mauvais champ.
  const marques = lireBooleenOptionnel(body.allAssets);
  if (!marques.ok) return refus(400, "allAssets must be true or false.");
  const allAssets = marques.valeur;

  const modeles = lireBooleenOptionnel(body.allTemplates);
  if (!modeles.ok) return refus(400, "allTemplates must be true or false.");
  const allTemplates = modeles.valeur;

  const assetIds = listeIds(body.assetIds);
  const templateIds = listeIds(body.templateIds);

  // ⛔ Un template octroyé hors des marques de la personne serait un octroi mort : la liste des
  // templates filtre par marque, elle ne le montrerait jamais. On refuse en nommant ce qui manque
  // plutôt que d'écrire une ligne dont personne ne verra jamais l'effet.
  // ⛔ LE DRAPEAU QUI DÉSARME CE CONTRÔLE EST CELUI DES MARQUES, PAS CELUI DES TEMPLATES. « All
  // templates » ne donne accès à aucune marque supplémentaire : coché seul, un octroi hors marque
  // resterait exactement aussi mort qu'avant. Le lire ici rendrait ce contrôle inopérant.
  // La question ne se pose donc PAS pour qui voit toutes les MARQUES (super_admin, ou `all_assets`).
  // On la pose sur l'état FINAL — rôle et drapeau après l'écriture — pas sur l'actuel : décocher
  // « All brands » dans la même requête remet le contrôle en jeu.
  // ⚠️ Les octrois explicites envoyés avec « All brands » coché sont écrits tels quels, sans
  // contrôle : ils ne servent qu'au jour où l'on décoche, et c'est ce jour-là qu'il les rattrape.
  const roleFinal = role ?? cible.role;
  const allAssetsFinal = allAssets ?? cible.all_assets;
  if (templateIds && templateIds.length > 0 && !voitToutesLesMarques(roleFinal, allAssetsFinal)) {
    // Périmètre de marques APRÈS l'écriture : ce qu'on s'apprête à poser, sinon l'existant.
    const marquesFinales = assetIds ?? (await grantedAssetIds(db, cible.id));
    const { data, error } = await db.from("template").select("id, asset_id").in("id", templateIds);
    if (error) return refus(500, `template: ${error.message}`);
    const parId = new Map(
      ((data ?? []) as { id: string; asset_id: string }[]).map((r) => [r.id, r.asset_id]),
    );
    const orphelins = templateIds.filter((t) => {
      const a = parId.get(t);
      return !a || !marquesFinales.includes(a);
    });
    if (orphelins.length > 0) {
      return refus(400, "Grant the brand before granting its templates.", { templateIds: orphelins });
    }
  }

  return { ok: true, modif: { role, status, allAssets, allTemplates, assetIds, templateIds } };
}
