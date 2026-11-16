import type { PublishedVersion, SegmentOption, VersionLabel } from "@/components/campaigns/shared";
import { isUuid } from "@/lib/data/templates";
import { getDb } from "@/lib/supabase";

/**
 * Lectures d'appoint de l'écran Campagnes : les versions PUBLIÉES et les segments de la marque.
 *
 * Pourquoi ici et pas dans `lib/data/*` : ces deux listes n'ont aucun autre consommateur et aucune
 * route HTTP ne les expose (`/api/segments` n'existe pas, `listTemplates()` ne rend pas l'id des
 * versions). Les pages serveur des campagnes les lisent donc directement, sans aller-retour HTTP.
 *
 * ⚠️ SERVER-ONLY : ce module importe `getDb()` (clé service_role). Il ne doit JAMAIS être importé
 * depuis un composant client — les composants reçoivent ces listes en props.
 *
 * ⚠️ INVARIANT : tout est scopé sur la marque. Une version ou un segment d'une autre marque doit
 * être indiscernable d'un objet inexistant — ces fonctions renvoient `null` / rien, jamais un objet
 * d'ailleurs. Le scope de marque vit sur `template` et sur `segment`, pas sur `template_version` :
 * on remonte d'un cran, exactement comme `findPublishedVersionRef()` côté API.
 */

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Versions PUBLIÉES sélectionnables pour une campagne, les plus récentes en tête par modèle.
 *
 * Un BROUILLON n'y figure jamais : il n'a pas de `html_shell` figé, donc rien à envoyer — c'est
 * aussi ce que refuse `buildCampaignPatch()` côté API, on ne propose pas un choix qui sera rejeté.
 * Les modèles ARCHIVÉS sont exclus de la liste (cohérent avec la bibliothèque) ; une campagne déjà
 * liée à l'un d'eux reste lisible via `describeVersion()`, qui ne filtre pas l'archivage.
 */
export async function listPublishedVersions(assetId: string | null): Promise<PublishedVersion[]> {
  const db = getDb();
  if (!db || !assetId) return [];

  const { data: templates } = await db
    .from("template")
    .select("id, name")
    .eq("asset_id", assetId)
    .is("archived_at", null);

  const nameById = new Map<string, string>();
  for (const raw of ((templates as unknown[]) ?? [])) {
    const t = raw as { id?: unknown; name?: unknown };
    const id = str(t.id);
    if (id) nameById.set(id, str(t.name));
  }
  if (nameById.size === 0) return [];

  const { data } = await db
    .from("template_version")
    .select("id, template_id, version, subject, preheader, size_bytes, compiled_at")
    .in("template_id", [...nameById.keys()])
    .eq("status", "published");

  const rows: PublishedVersion[] = ((data as unknown[]) ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    const templateId = str(r.template_id);
    return {
      versionId: str(r.id),
      templateId,
      templateName: nameById.get(templateId) ?? "",
      version: Number(r.version ?? 0),
      subject: str(r.subject),
      preheader: str(r.preheader),
      sizeBytes: num(r.size_bytes),
      publishedAt: r.compiled_at ? str(r.compiled_at) : null,
    };
  });

  // Tri stable : modèle par nom, puis version décroissante (la dernière publiée en premier).
  rows.sort((a, b) =>
    a.templateName === b.templateName
      ? b.version - a.version
      : a.templateName.localeCompare(b.templateName),
  );
  return rows;
}

/** Segments de la marque, par nom. Aucune règle n'est chargée : l'écran n'affiche que l'étiquette. */
export async function listSegmentOptions(assetId: string | null): Promise<SegmentOption[]> {
  const db = getDb();
  if (!db || !assetId) return [];

  const { data } = await db.from("segment").select("id, name").eq("asset_id", assetId).order("name");
  return ((data as unknown[]) ?? [])
    .map((raw) => {
      const r = raw as { id?: unknown; name?: unknown };
      return { id: str(r.id), name: str(r.name) };
    })
    .filter((s) => s.id !== "");
}

/**
 * De quel modèle vient la version référencée par une campagne.
 *
 * Ne filtre PAS l'archivage : une campagne verrouillée garde son snapshot même si le modèle a été
 * rangé depuis, et l'écran doit pouvoir nommer ce qui est parti. `null` = version inconnue ou
 * appartenant à une autre marque (indiscernables, par construction).
 */
export async function describeVersion(
  versionId: string | null,
  assetId: string | null,
): Promise<VersionLabel | null> {
  const db = getDb();
  if (!db || !assetId || !versionId || !isUuid(versionId)) return null;

  const { data } = await db
    .from("template_version")
    .select("id, template_id, version")
    .eq("id", versionId)
    .maybeSingle();
  if (!data) return null;

  const r = data as Record<string, unknown>;
  const templateId = str(r.template_id);

  const { data: tpl } = await db
    .from("template")
    .select("id, name")
    .eq("id", templateId)
    .eq("asset_id", assetId)
    .maybeSingle();
  if (!tpl) return null;

  return {
    versionId: str(r.id),
    templateId,
    templateName: str((tpl as { name?: unknown }).name),
    version: Number(r.version ?? 0),
  };
}

/** Nom du segment d'une campagne. `null` = inexistant OU appartenant à une autre marque. */
export async function describeSegment(
  segmentId: string | null,
  assetId: string | null,
): Promise<SegmentOption | null> {
  const db = getDb();
  if (!db || !assetId || !segmentId || !isUuid(segmentId)) return null;

  const { data } = await db
    .from("segment")
    .select("id, name")
    .eq("id", segmentId)
    .eq("asset_id", assetId)
    .maybeSingle();
  if (!data) return null;

  const r = data as { id?: unknown; name?: unknown };
  return { id: str(r.id), name: str(r.name) };
}

/** Ce que l'interrupteur de mélange d'une campagne a réellement à commander. */
export interface BlocsClassables {
  /** Blocs `article-feed` du document, tous modes confondus. */
  total: number;
  /** Ceux qui sont classés par vues — les SEULS que la case peut promouvoir en mélange. */
  parVues: number;
}

/**
 * Compte, dans le document servi par cette campagne, les blocs sur lesquels la case mordra.
 *
 * ⛔ POURQUOI CE COMPTE EXISTE. Mesuré le 04/09/2026 : sur les 40 `template_version`, 17 portent un
 * bloc `article-feed` et **AUCUN** n'est classé par vues. Une case cochée n'aurait donc, à cette
 * heure, rien à promouvoir — et sans ce chiffre à côté d'elle, on la cocherait, il ne se passerait
 * rien, et on irait chercher la panne dans l'entrepôt d'audience ou dans le worker. Un interrupteur
 * muet sur ce qu'il commande est un piège, pas un réglage.
 *
 * ⚠️ Rend `null` quand la campagne n'a pas encore de version : « pas de modèle » et « un modèle
 * sans bloc classable » appellent deux gestes différents (en choisir un / le régler), donc ils ne
 * se disent pas avec le même chiffre.
 */
export async function compterBlocsClassables(
  versionId: string | null,
  assetId: string | null,
): Promise<BlocsClassables | null> {
  const db = getDb();
  if (!db || !assetId || !versionId || !isUuid(versionId)) return null;

  const { data } = await db.from("template_version").select("doc").eq("id", versionId).maybeSingle();
  if (!data) return null;

  const doc = (data as Record<string, unknown>).doc;
  if (!doc || typeof doc !== "object") return null;

  // ⛔ La MÊME fonction que le worker (`@nf/render/feed`), pas un parcours réécrit ici : deux façons
  // de trouver les blocs flux finiraient par ne pas en trouver le même nombre, et l'écran
  // annoncerait un compte que le gel ne servirait pas.
  const { feedBlocksOf } = await import("@nf/render/feed");
  const blocs = feedBlocksOf(doc as Parameters<typeof feedBlocksOf>[0]);
  return { total: blocs.length, parVues: blocs.filter((b) => b.orderby === "views").length };
}
