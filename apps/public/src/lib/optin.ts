import type { Db } from "./supabase";
import { attachTags } from "./interests";

/**
 * L'OPTIN : le formulaire par lequel un contact est arrivé.
 *
 * POURQUOI UNE DIMENSION À PART. `subscription.source` est un enum fermé où l'ingestion écrit
 * `content_upgrade` pour tout le monde, et `source_detail` est un jsonb libre où rien ne garantit
 * une clé. Ni l'un ni l'autre ne permet de dire « les contacts venus du guide en barre latérale de
 * Quartz Tips », ni de leur envoyer une newsletter dédiée. D'où une table et une colonne.
 *
 * ⛔ RIEN ICI NE DOIT COÛTER UNE INSCRIPTION. Le classement est un accessoire ; le consentement ne
 * se rattrape pas. Toutes les fonctions de ce module rendent leur échec au lieu de lever, et
 * l'appelant continue sans optin plutôt que de perdre le contact.
 */

/** Même borne que la contrainte `optin_slug_format` en base : les deux doivent dire la même chose. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_NAME = 120;

export interface OptinInput {
  slug: string;
  name?: string;
  /**
   * --- Les colonnes du contrat v2 (0063). Toutes FACULTATIVES, et l'absence a un sens. ---
   *
   * ⛔ `undefined` ≠ `null`. Une clé absente du payload PostgREST n'est pas écrite ; une clé à
   * `null` l'est. C'est le seul mécanisme qui permet à une inscription v1 (ou à un émetteur muet
   * sur la campagne) de ne PAS détacher une créative de sa campagne, alors qu'un `null` explicite
   * la détache pour de bon. `x ?? null` à la construction du payload casserait cette distinction
   * en une ligne, silencieusement.
   */
  externalId?: string;
  placement?: string | null;
  captureCampaignId?: string | null;
  asksInterests?: boolean;
  offeredInterestIds?: number[];
}

export type OptinParse =
  | { ok: true; value: OptinInput | null }
  | { ok: false; reason: "optin-invalide" };

/**
 * Lit le champ `optin` du corps de la requête.
 *
 * ⛔ UN SLUG MAL FORMÉ EST UN REFUS, pas un silence. C'est la SEULE chose refusée de tout ce
 * module : un slug hors format ferait échouer l'insertion en base sur la contrainte, et le
 * contact serait classé « sans optin » sans que l'émetteur l'apprenne jamais. Mieux vaut un 422
 * lisible côté optinforge, qui se corrige, qu'une sous-liste qui se remplit à moitié.
 *
 * Le champ ABSENT, lui, est parfaitement normal (`{ ok: true, value: null }`) : c'est le
 * comportement d'avant ce lot, et le pont doit pouvoir être déployé des deux côtés dans n'importe
 * quel ordre.
 */
export function parseOptin(raw: unknown): OptinParse {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, reason: "optin-invalide" };

  const o = raw as { slug?: unknown; name?: unknown };
  if (typeof o.slug !== "string") return { ok: false, reason: "optin-invalide" };
  const slug = o.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return { ok: false, reason: "optin-invalide" };

  const name = typeof o.name === "string" ? o.name.trim().slice(0, MAX_NAME) : "";
  return { ok: true, value: { slug, name: name || slug } };
}

export interface ResolvedOptin {
  id: string;
  defaultTagId: number | null;
}

/**
 * Trouve l'optin, ou le CRÉE.
 *
 * ⛔ CRÉÉ AU VOL, et ce n'est pas de la commodité. Exiger une déclaration manuelle côté admin
 * ferait perdre en silence tous les contacts d'un formulaire neuf entre sa mise en ligne et le
 * moment où quelqu'un pense à l'enregistrer ici — c'est-à-dire exactement les contacts d'une
 * campagne d'acquisition qui démarre.
 *
 * ⚠️ `upsert … ignoreDuplicates` puis relecture : deux inscriptions simultanées sur un optin neuf
 * courent l'une contre l'autre, et l'unique `(asset_id, slug)` en ferait échouer une — donc perdre
 * le classement d'un contact pour une raison qui ne le concerne pas.
 *
 * ⚠️ Le LIBELLÉ suit, la clé ne bouge pas : renommer le formulaire côté optinforge renomme la
 * sous-liste ici sans détacher un seul contact.
 */
export async function resolveOptin(
  db: Db,
  assetId: string,
  optin: OptinInput,
): Promise<{ value: ResolvedOptin | null; error: string | null }> {
  try {
    const maintenant = new Date().toISOString();
    // ⚠️ CE QUI N'EST PAS CITÉ N'EST PAS ÉCRIT — c'est ce qui préserve `first_seen_at` et
    // `default_tag_id` à chaque inscription, et c'est le même mécanisme qui porte l'« absence ≠
    // null » des colonnes v2 ci-dessous. Les spreads conditionnels ne sont donc pas un raffinement
    // de style : un `capture_campaign_id: id ?? null` détacherait la créative de sa campagne dès
    // qu'un émetteur se tait.
    const { error: upsertError } = await db.from("optin").upsert(
      {
        asset_id: assetId,
        slug: optin.slug,
        name: optin.name ?? optin.slug,
        last_seen_at: maintenant,
        ...(optin.externalId !== undefined ? { external_id: optin.externalId } : {}),
        ...(optin.placement !== undefined ? { placement: optin.placement } : {}),
        ...(optin.captureCampaignId !== undefined ? { capture_campaign_id: optin.captureCampaignId } : {}),
        ...(optin.asksInterests !== undefined ? { asks_interests: optin.asksInterests } : {}),
        ...(optin.offeredInterestIds !== undefined ? { offered_interest_ids: optin.offeredInterestIds } : {}),
      },
      { onConflict: "asset_id,slug", ignoreDuplicates: false },
    );
    if (upsertError) return { value: null, error: `optin-upsert:${upsertError.message}` };

    const { data, error: readError } = await db
      .from("optin")
      .select("id, default_tag_id")
      .eq("asset_id", assetId)
      .eq("slug", optin.slug)
      .maybeSingle();
    if (readError) return { value: null, error: `optin-read:${readError.message}` };
    if (!data) return { value: null, error: "optin-absent-apres-upsert" };

    const row = data as { id: string; default_tag_id: number | null };
    return { value: { id: row.id, defaultTagId: row.default_tag_id }, error: null };
  } catch (err) {
    return { value: null, error: `unexpected:${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Pose le tag par défaut de l'optin sur la souscription.
 *
 * `source = 'optin_default'` : distinct de `capture_bridge` (les catégories cochées par la
 * personne) et des tags posés à la main. Sans cette marque, un nettoyage devrait deviner qui a
 * posé quoi — et un tag automatique n'a pas le même statut qu'un choix explicite de l'abonné.
 */
export async function applyOptinTag(
  db: Db,
  subscriptionId: string,
  defaultTagId: number | null,
): Promise<string | null> {
  if (defaultTagId === null) return null;
  return attachTags(db, subscriptionId, [defaultTagId], "optin_default");
}
