import type { Db } from "./supabase";

/**
 * Les catégories choisies à l'inscription, posées en TAGS.
 *
 * D'OÙ ELLES VIENNENT. Le système de capture (OptinForge) laisse le visiteur
 * cocher les catégories qu'il veut recevoir, et transmet leurs slugs bruts dans
 * `interests`. Le vocabulaire est LIBRE et décidé côté capture, par créative :
 * il n'y a pas de table de correspondance à tenir ici, contrairement aux
 * finalités de consentement (`granted_purposes`), dont le jeu est fermé.
 *
 * ⛔ POURQUOI DES TAGS ET SURTOUT PAS DES `granted_purposes`. Les finalités
 * portent une valeur de PREUVE : elles sont journalisées dans `consent_event`
 * avec la base légale, l'IP et l'agent, et la route refuse en 422 toute clé
 * qu'elle ne connaît pas. « foot » et « tennis » ne sont pas des finalités —
 * les y glisser mélangerait un goût révisable à une obligation légale, et
 * ferait refuser l'inscription entière. Les tags, eux, existent déjà, sont
 * scopés par marque, et le compilateur de segments sait déjà s'en servir
 * (`packages/segments/src/compile.ts` : `tag_ids.cs.{id}`).
 *
 * ⛔ LES DEUX ÉCRITURES SONT OBLIGATOIRES, ET C'EST MESURÉ. Aucun trigger ne
 * synchronise `subscription.tag_ids` avec `subscription_tag` (vérifié dans les
 * migrations le 06/09/2026 : la 0004 fait même l'inverse, elle remplit la table
 * de liaison DEPUIS le tableau). Or c'est `tag_ids` que le compilateur de
 * segments interroge. N'écrire que la table de liaison donnerait donc un
 * abonné correctement tagué qu'aucun segment ne trouverait jamais ; n'écrire
 * que le tableau laisserait la liaison muette. On écrit les deux.
 *
 * ⛔ UN ÉCHEC ICI NE COÛTE PAS L'INSCRIPTION. L'abonné et son consentement sont
 * déjà enregistrés quand cette fonction est appelée. Une catégorie est un
 * accessoire : elle se rattrape, un consentement perdu ne se rattrape pas. La
 * fonction ne lève donc jamais et rend ce qu'elle a réellement posé, pour que
 * l'appelant puisse le journaliser.
 */

/**
 * Les mêmes bornes que l'émetteur, pour que rien ne diverge en silence.
 *
 * ⚠️ EXPORTÉES depuis le 10/09/2026 : la sonde `GET /api/v1/signup` DÉCLARE ces deux nombres à
 * l'émetteur. Recopier `24` et `64` dans la sonde ferait d'elle une promesse qui cesserait d'être
 * vraie à la première correction ici — et une sonde qui ment est pire que pas de sonde.
 */
export const MAX_SLUGS = 24;
export const MAX_SLUG_LENGTH = 64;

/**
 * Ce qui est retenu d'un `interests` reçu.
 *
 * Ce qui dépasse est ÉCARTÉ, jamais refusé : la route d'ingestion ne doit pas
 * rendre 422 sur un accessoire. Les slugs sont mis en minuscules — c'est la
 * forme que WordPress stocke et celle que la capture propose.
 */
export function normalizeInterests(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const slug = entry.trim().toLowerCase();
    if (!slug || slug.length > MAX_SLUG_LENGTH) continue;
    if (out.includes(slug)) continue;
    out.push(slug);
    if (out.length >= MAX_SLUGS) break;
  }
  return out;
}

export interface InterestOutcome {
  /** Les slugs réellement rattachés à la souscription. */
  applied: string[];
  /** Le motif, quand rien ou pas tout n'a pu être posé. */
  error: string | null;
}

/**
 * Rattache les catégories à une souscription, en créant les tags manquants.
 *
 * Les tags nés ici portent `source = 'capture_bridge'` : c'est ce qui permet de
 * les distinguer plus tard de ceux créés à la main dans l'admin, et donc de
 * faire le ménage si une créative a envoyé un slug fantaisiste. Sans cette
 * marque, un nettoyage devrait deviner.
 */
export async function applyInterests(
  db: Db,
  assetId: string,
  subscriptionId: string,
  slugs: string[],
): Promise<InterestOutcome> {
  if (slugs.length === 0) return { applied: [], error: null };

  try {
    // 1. Les tags que cette marque connaît déjà.
    const { data: known, error: readError } = await db
      .from("tag")
      .select("id, slug")
      .eq("asset_id", assetId)
      .in("slug", slugs);
    if (readError) return { applied: [], error: `tag-read:${readError.message}` };

    const byslug = new Map<string, number>(
      ((known ?? []) as { id: number; slug: string }[]).map((t) => [t.slug, t.id]),
    );

    // 2. Ceux qui manquent. `on conflict do nothing` plutôt qu'un insert nu :
    //    deux inscriptions simultanées sur la même catégorie neuve courent
    //    sinon l'une contre l'autre, et l'unique `(asset_id, slug)` en ferait
    //    échouer une — donc perdre les catégories d'un abonné pour une raison
    //    qui ne le concerne pas.
    const missing = slugs.filter((s) => !byslug.has(s));
    if (missing.length > 0) {
      const { error: insertError } = await db
        .from("tag")
        .upsert(
          missing.map((slug) => ({
            asset_id: assetId,
            slug,
            label: slug,
            source: "capture_bridge",
          })),
          { onConflict: "asset_id,slug", ignoreDuplicates: true },
        );
      if (insertError) return { applied: [], error: `tag-create:${insertError.message}` };

      // Relecture : `ignoreDuplicates` ne rend pas les lignes, et une ligne
      // créée par un appel concurrent n'aurait de toute façon pas été rendue.
      const { data: after, error: rereadError } = await db
        .from("tag")
        .select("id, slug")
        .eq("asset_id", assetId)
        .in("slug", missing);
      if (rereadError) return { applied: [], error: `tag-reread:${rereadError.message}` };
      for (const t of (after ?? []) as { id: number; slug: string }[]) {
        byslug.set(t.slug, t.id);
      }
    }

    // Un slug qu'on n'a pas su résoudre ne doit pas passer pour posé.
    const resolved = slugs.filter((s) => byslug.has(s));
    const tagIds = resolved.map((s) => byslug.get(s) as number);
    if (tagIds.length === 0) return { applied: [], error: "no-tag-resolved" };

    // 3 et 4 : la liaison ET le tableau dénormalisé (voir `attachTags`).
    const lien = await attachTags(db, subscriptionId, tagIds, "capture_bridge");
    if (lien) return { applied: [], error: lien };

    return {
      applied: resolved,
      error: resolved.length === slugs.length ? null : "partial",
    };
  } catch (err) {
    return { applied: [], error: `unexpected:${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Rattache des tags DÉJÀ résolus à une souscription — les deux écritures, au même endroit.
 *
 * ⛔ EXTRAIT ET PARTAGÉ, pas recopié. Le tag par défaut d'un optin a exactement le même besoin
 * que les centres d'intérêt : écrire `subscription_tag` ET `subscription.tag_ids`, faute de quoi
 * l'abonné est tagué sans qu'aucun segment ne le trouve (c'est `tag_ids` que le compilateur
 * interroge). Deux copies de cette règle ne resteraient d'accord que jusqu'à la première
 * correction de l'une des deux.
 *
 * Rend `null` si tout s'est bien passé, sinon le motif — la fonction ne lève jamais.
 */
export async function attachTags(
  db: Db,
  subscriptionId: string,
  tagIds: number[],
  source: string,
): Promise<string | null> {
  if (tagIds.length === 0) return null;

  const { error: linkError } = await db.from("subscription_tag").upsert(
    tagIds.map((tag_id) => ({ subscription_id: subscriptionId, tag_id, source })),
    { onConflict: "subscription_id,tag_id", ignoreDuplicates: true },
  );
  if (linkError) return `link:${linkError.message}`;

  // UNION avec ce qui s'y trouve déjà : une deuxième inscription (ou une reprise après
  // désabonnement) ne doit pas effacer les tags posés la première fois. Écraser reviendrait à
  // décider à la place de l'abonné qu'il ne veut plus de ce qu'il avait demandé.
  const { data: current, error: currentError } = await db
    .from("subscription")
    .select("tag_ids")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (currentError) return `subscription-read:${currentError.message}`;

  const existing = ((current?.tag_ids as number[] | null) ?? []).filter((n) => typeof n === "number");
  const merged = Array.from(new Set([...existing, ...tagIds]));
  const { error: updateError } = await db
    .from("subscription")
    .update({ tag_ids: merged })
    .eq("id", subscriptionId);
  if (updateError) return `subscription-update:${updateError.message}`;

  return null;
}
