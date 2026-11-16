import { getDb } from "@/lib/supabase";

/**
 * LES SOUS-LISTES PAR FORMULAIRE D'ORIGINE.
 *
 * Un optin, c'est « les contacts venus du guide en barre latérale de Quartz Tips ». Ils arrivent par
 * `POST /api/v1/signup` (apps/public), qui crée l'optin AU VOL — cet écran ne sert donc pas à les
 * déclarer, mais à les nommer, à les compter, et à décider du tag qu'ils portent.
 *
 * ⛔ TOUT EST SCOPÉ MARQUE. `newsletter.optin` est unique par `(asset_id, slug)` : deux marques
 * peuvent parfaitement avoir un formulaire « guide ». Une lecture non scopée mélangerait leurs
 * contacts dans un même écran, et pire, un tag posé depuis cet écran atterrirait sur les contacts
 * d'une autre marque.
 */

/**
 * ⛔ DEUX VUES, DEUX DÉFINITIONS DE « CONTACTS », ET ELLES DIVERGERONT.
 *
 * `optin_stats` (0054) joint `subscription.optin_id` : c'est la PREMIÈRE TOUCHE, une par personne.
 * `capture_source_stats` (0063) joint `capture_event.optin_id` : ce sont TOUTES les touches.
 * Dès la première double inscription, les deux donneront un nombre différent pour la même créative.
 *
 * On ne choisit pas : on lit les deux et on nomme, à l'écran, ce que chaque nombre compte.
 * `taggedSubscriptions` sert de garde-fou au geste d'écriture rétroactif (« N/M tagged », comparé au
 * dry-run) — il n'a de sens que rapporté au dénominateur de SA vue, `firstTouchContacts`. Les
 * mélanger ferait mentir le seul nombre qui protège une écriture sur des milliers de lignes.
 */
export interface OptinRow {
  id: string;
  slug: string;
  name: string;
  defaultTagId: number | null;
  defaultTagSlug: string | null;
  /** Toutes les touches (`capture_source_stats`) — ce que le filtre `?creative=` de la liste rend. */
  contacts: number;
  /** Ce qu'une campagne peut réellement servir. L'écart avec `contacts` EST l'information. */
  sendable: number;
  /** Première touche seulement (`optin_stats`) — le dénominateur du ratio « tagged ». */
  firstTouchContacts: number;
  activeSubscriptions: number;
  /** Contacts portant DÉJÀ le tag par défaut — ce qui rend lisible l'effet d'une application. */
  taggedSubscriptions: number;
  placement: string | null;
  asksInterests: boolean;
  campaignName: string | null;
  lastSignupAt: string | null;
  new30d: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  archivedAt: string | null;
}

export interface OptinsResult {
  rows: OptinRow[];
  /** Les tags de la marque, pour le sélecteur de tag par défaut. */
  tags: { id: number; slug: string; label: string }[];
  source: "db" | "none";
  /** Motif quand la lecture a échoué — distinct d'une marque sans aucun formulaire. */
  reason: string | null;
}

const VIDE: OptinsResult = { rows: [], tags: [], source: "none", reason: null };

export async function listOptins(assetId: string | null): Promise<OptinsResult> {
  const db = getDb();
  if (!db) return { ...VIDE, reason: "no-db" };
  // ⛔ Sans marque courante on ne rend RIEN plutôt que les optins des neuf marques : cet écran porte
  // une action d'écriture (le tag par défaut), et se tromper de marque y coûte des contacts tagués.
  if (!assetId) return { ...VIDE, reason: "no-asset" };

  const [captureRes, statsRes, tagsRes] = await Promise.all([
    db.from("capture_source_stats").select("*").eq("asset_id", assetId).order("name"),
    // Conservée pour ses DEUX seules colonnes introuvables ailleurs : `active_subscriptions` et
    // `tagged_subscriptions`. Une panne de cette vue ne doit pas emporter l'écran — les compteurs
    // de tag manqueront, la gouvernance restera lisible.
    db.from("optin_stats").select("optin_id, subscriptions, active_subscriptions, tagged_subscriptions")
      .eq("asset_id", assetId),
    db.from("tag").select("id, slug, label").eq("asset_id", assetId).order("slug"),
  ]);

  if (captureRes.error) return { ...VIDE, reason: captureRes.error.message };

  const parPremiereTouche = new Map<string, { first: number; active: number; tagged: number }>();
  for (const raw of (statsRes.data as unknown[]) ?? []) {
    const s = raw as Record<string, unknown>;
    parPremiereTouche.set(String(s.optin_id ?? ""), {
      first: Number(s.subscriptions ?? 0),
      active: Number(s.active_subscriptions ?? 0),
      tagged: Number(s.tagged_subscriptions ?? 0),
    });
  }

  const tags = ((tagsRes.data as unknown[]) ?? []).map((raw) => {
    const t = raw as { id: number; slug: string; label: string | null };
    return { id: t.id, slug: t.slug, label: t.label || t.slug };
  });
  const slugById = new Map(tags.map((t) => [t.id, t.slug]));

  const rows: OptinRow[] = ((captureRes.data as unknown[]) ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    const tagId = (r.default_tag_id as number | null) ?? null;
    const id = String(r.optin_id ?? "");
    const pt = parPremiereTouche.get(id);
    return {
      id,
      slug: String(r.slug ?? ""),
      name: String(r.name ?? ""),
      defaultTagId: tagId,
      // Un tag par défaut qui n'est plus dans la liste des tags de la marque (supprimé) doit se
      // VOIR : rendre `null` ferait croire qu'aucun tag n'est configuré.
      defaultTagSlug: tagId === null ? null : (slugById.get(tagId) ?? `#${tagId}`),
      contacts: Number(r.contacts ?? 0),
      sendable: Number(r.sendable ?? 0),
      firstTouchContacts: pt?.first ?? 0,
      activeSubscriptions: pt?.active ?? 0,
      taggedSubscriptions: pt?.tagged ?? 0,
      placement: (r.placement as string | null) ?? null,
      asksInterests: r.asks_interests === true,
      campaignName: (r.capture_campaign_name as string | null) ?? null,
      lastSignupAt: (r.last_signup_at as string | null) ?? null,
      new30d: Number(r.new_30d ?? 0),
      firstSeenAt: (r.first_seen_at as string | null) ?? null,
      lastSeenAt: (r.last_seen_at as string | null) ?? null,
      archivedAt: (r.archived_at as string | null) ?? null,
    };
  });

  return { rows, tags, source: "db", reason: null };
}

/**
 * Pose (ou retire) le tag par défaut d'un optin.
 *
 * ⛔ LE TAG DOIT ÊTRE DE LA MÊME MARQUE, et c'est vérifié ici en plus de l'être dans la fonction
 * SQL : la clé étrangère `default_tag_id → tag(id)` ne regarde pas `asset_id`. Sans cette
 * vérification, un identifiant recopié à la main poserait le tag d'une autre marque sur des
 * milliers de contacts — et le geste rétroactif l'appliquerait sans broncher.
 *
 * ⚠️ Ce geste ne touche AUCUN contact déjà arrivé : c'est la décision d'Alix du 08/09/2026, deux
 * gestes séparés. L'application rétroactive est `applyDefaultTag`, avec son compte et sa
 * confirmation.
 */
export async function setDefaultTag(
  optinId: string,
  assetId: string,
  tagId: number | null,
): Promise<{ ok: boolean; reason?: string }> {
  const db = getDb();
  if (!db) return { ok: false, reason: "no-db" };

  const { data: optin } = await db
    .from("optin").select("id, asset_id").eq("id", optinId).maybeSingle();
  if (!optin || (optin as { asset_id: string }).asset_id !== assetId) {
    return { ok: false, reason: "optin-hors-marque" };
  }

  if (tagId !== null) {
    const { data: tag } = await db
      .from("tag").select("id, asset_id").eq("id", tagId).maybeSingle();
    if (!tag || (tag as { asset_id: string }).asset_id !== assetId) {
      return { ok: false, reason: "tag-hors-marque" };
    }
  }

  const { error } = await db.from("optin").update({ default_tag_id: tagId }).eq("id", optinId);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

/**
 * Applique le tag par défaut aux contacts DÉJÀ arrivés.
 *
 * `dryRun` rend le nombre de contacts qui CHANGERAIENT — pas le nombre total de contacts de
 * l'optin. C'est ce qu'on affiche avant de demander confirmation : annoncer « 340 » quand 220 le
 * portent déjà ferait croire à un effet trois fois plus large que le réel, et le second clic
 * annoncerait encore 340 alors qu'il n'y a plus rien à faire.
 *
 * L'écriture elle-même est en SQL (`0053`) : la double écriture `subscription_tag` +
 * `subscription.tag_ids` a une seule implémentation, et une boucle applicative sur des milliers de
 * lignes ne serait ni atomique ni bornée.
 */
export async function applyDefaultTag(
  optinId: string,
  assetId: string,
  dryRun: boolean,
): Promise<{ ok: boolean; affected?: number; reason?: string }> {
  const db = getDb();
  if (!db) return { ok: false, reason: "no-db" };

  const { data: optin } = await db
    .from("optin").select("id, asset_id, default_tag_id").eq("id", optinId).maybeSingle();
  if (!optin || (optin as { asset_id: string }).asset_id !== assetId) {
    return { ok: false, reason: "optin-hors-marque" };
  }
  if ((optin as { default_tag_id: number | null }).default_tag_id === null) {
    return { ok: false, reason: "aucun-tag-par-defaut" };
  }

  const { data, error } = await db.rpc("apply_optin_default_tag", {
    p_optin_id: optinId,
    p_dry_run: dryRun,
  });
  if (error) return { ok: false, reason: error.message };
  return { ok: true, affected: Number(data ?? 0) };
}
