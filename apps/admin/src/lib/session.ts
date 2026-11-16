import { cache } from "react";
import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionPerimee, verifySession, type AppRole, type SessionPayload } from "@/lib/auth";
import { getDb } from "@/lib/supabase";
import { voitToutesLesMarques, voitTousLesTemplates } from "@/lib/acces";
import {
  allAssetIds,
  findById,
  grantedAssetIds,
  grantedTemplateIds,
  hasTemplateGrant,
  type AppUserRow,
  type Db,
} from "@/lib/data/app-user";

/**
 * IDENTITÉ COURANTE — source de vérité unique de « qui regarde ? » et « a-t-il le droit ? ».
 *
 * ⚠️ Le cookie de session ne fait qu'IDENTIFIER. Il est signé, donc infalsifiable, mais il peut
 * avoir sept jours : le rôle et le statut qu'il porte sont ceux d'il y a une semaine. C'est
 * pourquoi ce module RELIT le compte en base à chaque requête. Désactiver quelqu'un ou lui
 * retirer une marque prend donc effet à la requête suivante, sans attendre l'expiration.
 *
 * Le `role` reste embarqué dans le cookie pour une seule raison : le proxy tourne en Edge et n'a
 * pas la base sous la main. Il s'en sert pour un premier filtrage des pages réservées. Ce n'est
 * jamais la décision finale — voir proxy.ts.
 *
 * ⚠️ Ce module remplace deux lectures de session dupliquées qui rendaient `null` en silence
 * (`authorEmail()` dans lib/data/templates.ts, `sessionEmail()` dans api/ai/_shared.ts) et dont
 * aucun appelant ne testait le `null` : un cookie cassé y devenait un accès anonyme.
 */

export type SessionUser = {
  id: string;
  email: string;
  role: AppRole;
  /** Droits d'ADMINISTRATION (écran des comptes, routes réservées). Aucun drapeau ne les donne. */
  isSuperAdmin: boolean;
  /**
   * Voit TOUTES les marques, présentes et futures : super_admin, ou membre coché « All brands »
   * (`all_assets`, 0075).
   */
  seesAllAssets: boolean;
  /**
   * Voit TOUS les templates DES MARQUES QU'IL VOIT, présents et futurs : super_admin, ou membre
   * coché « All templates » (`all_templates`, 0075). C'est ce champ — et lui seul, jamais
   * `seesAllAssets` ni `isSuperAdmin` — que lisent les décisions de VISIBILITÉ sur les templates.
   *
   * ⛔ INDÉPENDANT DES MARQUES, ET SANS EFFET SUR ELLES. Il lève le filtre PAR TEMPLATE ; le filtre
   * PAR MARQUE reste entier (`asset_id = <marque courante>` dans lib/data/templates.ts, et la
   * marque courante est prise dans `assetIds` par lib/asset-context.ts). Marque A + ce drapeau =
   * tous les templates de A, aucun de B.
   */
  seesAllTemplates: boolean;
  /** Les marques que cette personne peut voir. Si `seesAllAssets` : toutes, relues à chaque requête. */
  assetIds: string[];
};

/**
 * Le périmètre d'un compte — la décision que `getSessionUser` applique à chaque requête, isolée
 * pour être éprouvée avec une base factice.
 *
 * ⚠️ `allAssetIds` est relu À CHAQUE APPEL, jamais mis en cache ni recopié en lignes d'octroi : c'est
 * ce qui fait qu'une marque créée demain est visible demain par qui voit toutes les marques.
 *
 * ⛔ Les deux drapeaux se lisent SÉPARÉMENT : la liste de marques suit `all_assets` et lui seul,
 * `all_templates` ne l'élargit jamais. C'est toute la demande d'Alix (0075) — « accès qu'à un
 * domaine mais à tous les templates ».
 */
export async function perimetreDuCompte(
  db: Db,
  compte: Pick<AppUserRow, "id" | "role" | "all_assets" | "all_templates">,
): Promise<{ seesAllAssets: boolean; seesAllTemplates: boolean; assetIds: string[] }> {
  const seesAllAssets = voitToutesLesMarques(compte.role, compte.all_assets);
  const seesAllTemplates = voitTousLesTemplates(compte.role, compte.all_templates);
  const assetIds = seesAllAssets ? await allAssetIds(db) : await grantedAssetIds(db, compte.id);
  return { seesAllAssets, seesAllTemplates, assetIds };
}

/**
 * `cache()` déduplique l'appel dans un même rendu / une même requête : une page qui interroge
 * l'identité dans son layout, sa page et trois composants ne fait qu'un seul aller-retour.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const payload = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!payload) return null;

  const db = getDb();
  // ⛔ Base injoignable : on refuse l'identité au lieu de retomber sur le contenu du cookie.
  // Se rabattre sur le cookie ferait exactement l'inverse de ce module — croire un jeton qui
  // peut porter un rôle révoqué — et la panne deviendrait une élévation de privilège.
  if (!db) return null;

  return identiteDuCompte(db, payload);
});

/**
 * Ce qu'une session VÉRIFIÉE vaut, une fois le compte relu en base — la décision de
 * `getSessionUser`, isolée pour être éprouvée avec une base factice (session.test.ts), sans
 * cookies de Next.
 */
export async function identiteDuCompte(
  db: Db,
  payload: Pick<SessionPayload, "uid" | "iat">,
): Promise<SessionUser | null> {
  const compte = await findById(db, payload.uid);
  if (!compte || compte.status !== "active") return null;
  // Mot de passe changé après l'émission de ce cookie (0091) : la session ouverte avec l'ancien
  // ne vaut plus rien, à la requête suivante — comme une désactivation.
  if (sessionPerimee(payload.iat, compte.password_changed_at)) return null;

  const isSuperAdmin = compte.role === "super_admin";
  const { seesAllAssets, seesAllTemplates, assetIds } = await perimetreDuCompte(db, compte);

  return {
    id: compte.id,
    email: compte.email,
    role: compte.role,
    isSuperAdmin,
    seesAllAssets,
    seesAllTemplates,
    assetIds,
  };
}

/** L'identité, ou l'échec. À utiliser partout où l'absence d'identité doit ARRÊTER le traitement. */
export async function requireSessionUser(): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) throw new SessionRefusee("unauthenticated");
  return u;
}

export class SessionRefusee extends Error {
  constructor(public readonly raison: "unauthenticated" | "forbidden") {
    super(raison);
    this.name = "SessionRefusee";
  }
}

/** Cette personne voit-elle cette marque ? Qui voit toutes les marques (super_admin, `all_assets`)
 *  les voit toutes. ⛔ `all_templates` n'entre PAS ici : il n'ouvre aucune marque. */
export function canAccessAsset(u: SessionUser, assetId: string | null): boolean {
  if (!assetId) return false;
  return u.assetIds.includes(assetId);
}

/**
 * Cette personne peut-elle ouvrir ce template ?
 *
 * Qui voit tous les templates (super_admin, ou `all_templates`), oui — sous réserve que la route ait
 * déjà vérifié la MARQUE, ce que fait le filtre `.eq("asset_id")` commun à toutes les routes et à
 * toutes les pages (`findTemplate`, `getTemplateWithDraft`, `loadTemplate`). C'est cette vérification
 * amont, et elle seule, qui empêche « tous les templates » de devenir « ceux des autres marques
 * aussi ». Un autre membre, seulement si le template lui a été octroyé : par un administrateur, ou
 * automatiquement parce qu'il l'a créé.
 *
 * ⛔ C'est l'un des DEUX seuls points où l'octroi de template est lu (l'autre : `templatesVisibles`).
 * Tout chemin d'ouverture passe par ici ; les deux lisent `seesAllTemplates` — jamais
 * `seesAllAssets`, jamais `isSuperAdmin`.
 *
 * `db` n'est passé que par les tests ; `undefined` = la vraie base.
 */
export async function canEditTemplate(
  u: Pick<SessionUser, "id" | "seesAllTemplates">,
  templateId: string,
  db?: Db | null,
): Promise<boolean> {
  if (u.seesAllTemplates) return true;
  const base = db === undefined ? getDb() : db;
  if (!base) return false; // fail closed : sans base, on ne peut rien affirmer.
  return hasTemplateGrant(base, u.id, templateId);
}

/**
 * Les templates que cette personne peut voir dans une liste : `null` = AUCUN FILTRE PAR TEMPLATE
 * (qui voit tous les templates, y compris ceux créés plus tard), sinon ses octrois explicites.
 *
 * ⛔ `null` ne veut pas dire « tous les templates de la base » : l'appelant applique TOUJOURS, en
 * plus, son filtre de marque (`listTemplatesRead` : `.eq("asset_id", assetId)`). C'est la
 * composition des deux qui donne « tous les templates de MES marques ».
 *
 * ⛔ `null` et `[]` sont OPPOSÉS : `[]` veut dire « aucun ». Ne jamais rendre `[]` pour « tous ».
 */
export async function templatesVisibles(
  u: Pick<SessionUser, "id" | "seesAllTemplates">,
  db: Db,
): Promise<string[] | null> {
  return u.seesAllTemplates ? null : grantedTemplateIds(db, u.id);
}

/**
 * Restreint une liste d'identifiants de marque à ce que cette personne voit.
 * Utilisé par les écrans qui agrègent volontairement plusieurs marques (le `perBrand` du
 * tableau de bord, le catalogue de formulaires), pour qu'ils cessent de tout montrer.
 */
export function limiterAuxMarques(u: SessionUser, assetIds: string[]): string[] {
  return assetIds.filter((id) => u.assetIds.includes(id));
}
