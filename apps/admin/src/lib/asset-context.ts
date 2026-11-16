import { cookies } from "next/headers";
import { getDb } from "@/lib/supabase";
import { getSessionUser } from "@/lib/session";
import { ASSETS as CONFIG_ASSETS, PILOT_ASSET } from "@nf/config";

/**
 * CONTEXTE DE MARQUE — source de vérité unique de « quelle marque regarde-t-on ? ».
 *
 * Racine A de l'audit : l'admin était mono-marque en dur (sélecteur sans handler, aucun contexte,
 * aucune requête filtrée). Tout écran et toute fonction de `lib/data/*` doit désormais passer par
 * `getCurrentAsset()` et filtrer sur `asset.id`.
 *
 * ⚠️ Depuis le 31/08/2026, ce module ne répond plus « quelle marque » sans répondre d'abord
 * « pour qui ». Le sélecteur listait les 9 marques à quiconque était connecté, et un cookie
 * `nf_asset` portant n'importe quel slug bien formé donnait accès à la marque correspondante :
 * changer de marque était un geste d'interface, pas un contournement, et rien ne l'empêchait.
 *
 * Stockage : cookie httpOnly `nf_asset` (slug). Serveur uniquement — ne jamais importer côté client.
 */

export const ASSET_COOKIE = "nf_asset";

export interface CurrentAsset {
  /** uuid de `newsletter.asset` — null si la marque n'a pas pu être résolue (voir `indisponible`). */
  id: string | null;
  slug: string;
  name: string;
  market: string | null;
  languages: string[];
  /** true si la marque vient réellement de la base. */
  fromDb: boolean;
  /**
   * Pourquoi `id` est null, quand il l'est. Sans cette distinction, « la base ne répond pas » et
   * « cette personne n'a aucune marque » seraient le même état — et l'écran dirait la mauvaise
   * chose dans un cas sur deux.
   */
  indisponible?: "base" | "aucune-marque";
}

export interface AssetOption {
  id: string | null;
  slug: string;
  name: string;
  market: string | null;
}

type LigneAsset = { id: string; slug: string; name: string; market: string | null; languages: string[] | null };

/** Repli config quand la base ne répond pas (l'admin reste consultable, mais rien n'est scopé). */
function fromConfig(slug?: string): CurrentAsset {
  const a = CONFIG_ASSETS.find((x) => x.slug === slug) ?? PILOT_ASSET;
  return {
    id: null,
    slug: a.slug,
    name: a.name,
    market: a.markets[0] ?? null,
    languages: a.languages,
    fromDb: false,
    indisponible: "base",
  };
}

function depuisLigne(data: LigneAsset): CurrentAsset {
  return {
    id: data.id,
    slug: data.slug,
    name: data.name,
    market: data.market ?? null,
    languages: data.languages ?? [],
    fromDb: true,
  };
}

/**
 * Les marques sélectionnables — celles de la personne connectée, et elles seules.
 * Un super_admin les voit toutes (lib/session.ts lui attribue la liste complète).
 */
export async function listAssetOptions(): Promise<AssetOption[]> {
  const db = getDb();
  const u = await getSessionUser();
  if (db && u) {
    const { data, error } = await db
      .from("asset")
      .select("id, slug, name, market")
      .in("id", u.assetIds)
      .order("created_at");
    if (!error && data) return data as AssetOption[];
  }
  // ⛔ Sans session ni base, on ne propose RIEN : proposer le registre complet remettrait
  // exactement la fuite que ce module vient de fermer.
  return [];
}

/**
 * La marque courante.
 *
 * Ordre de résolution : le slug du cookie s'il est autorisé, sinon la PREMIÈRE marque autorisée
 * de la personne. ⛔ Le repli d'avant retombait sur la marque pilote quel que soit le demandeur ;
 * il donnait donc accès à une marque qu'on n'avait pas le droit de voir, en silence.
 */
export async function getCurrentAsset(): Promise<CurrentAsset> {
  const jar = await cookies();
  const wanted = jar.get(ASSET_COOKIE)?.value;

  const db = getDb();
  if (!db) return fromConfig(wanted);

  const u = await getSessionUser();
  if (!u) return { ...fromConfig(wanted), indisponible: "aucune-marque" };
  if (u.assetIds.length === 0) {
    return { ...fromConfig(wanted), indisponible: "aucune-marque" };
  }

  // Le slug demandé, mais seulement s'il fait partie des marques autorisées : un slug inconnu
  // comme un slug interdit doivent produire le même résultat, sans rien révéler.
  if (wanted) {
    const { data } = await db
      .from("asset")
      .select("id, slug, name, market, languages")
      .eq("slug", wanted)
      .in("id", u.assetIds)
      .maybeSingle();
    if (data) return depuisLigne(data as LigneAsset);
  }

  // Repli : la première marque autorisée. Ordre stable (création) pour que deux requêtes
  // successives ne changent pas de marque sous les pieds de l'utilisateur.
  const { data } = await db
    .from("asset")
    .select("id, slug, name, market, languages")
    .in("id", u.assetIds)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (data) return depuisLigne(data as LigneAsset);

  return { ...fromConfig(wanted), indisponible: "aucune-marque" };
}

/** Cette personne peut-elle basculer sur ce slug ? Utilisé par l'action de changement de marque. */
export async function slugAutorise(slug: string): Promise<boolean> {
  const db = getDb();
  const u = await getSessionUser();
  if (!db || !u) return false;
  const { count, error } = await db
    .from("asset")
    .select("id", { count: "exact", head: true })
    .eq("slug", slug)
    .in("id", u.assetIds);
  if (error) return false;
  return (count ?? 0) > 0;
}
