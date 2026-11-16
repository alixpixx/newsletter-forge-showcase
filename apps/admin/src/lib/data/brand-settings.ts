import { LOCALES } from "@nf/email";

/**
 * LES RÉGLAGES D'UNE MARQUE — nom, et pour chaque édition : langue, marché, régime, expéditeur.
 *
 * Décision d'Alix du 22/09/2026 (« je veux tout pouvoir modifier dans le builder ce que les users vont
 * recevoir sans exception ») : ce que la page Settings déclarait « read-only » devient réglable par un
 * super_admin. Ce module porte la LECTURE et la VALIDATION ; la route et son banc portent la décision.
 *
 * ⛔ LE NOM ET L'EXPÉDITEUR FINISSENT DANS UN EN-TÊTE D'E-MAIL. Le nom de marque est le nom affiché du
 * From par défaut, entre guillemets : un `"` fermerait la chaîne, un retour à la ligne ouvrirait un
 * en-tête de plus. Refusés ici, nettoyés par le worker, interdits par la base (0078) pour l'expéditeur.
 *
 * ⛔ L'ADRESSE D'ENVOI N'EST PAS UN RÉGLAGE. Seuls le NOM affiché et l'adresse de RÉPONSE le sont ; le
 * domaine d'envoi reste le sous-domaine vérifié (DMARC). Aucun champ de ce module ne l'atteint.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any };

export const REGIMES_MARQUE = ["gdpr", "lgpd", "canspam"] as const;
export type RegimeMarque = (typeof REGIMES_MARQUE)[number];

/**
 * Le suivi des ouvertures et des clics d'une marque (`asset.tracking_mode`, 0092) :
 *  - `all`     — tous les destinataires, SAUF ceux qui l'ont refusé (décision d'Alix du 07/10/2026) ;
 *  - `consent` — seulement ceux qui l'ont accepté (la règle d'avant 0092).
 * ⚠️ Le risque juridique de `all` au Royaume-Uni et dans l'UE (un pixel de suivi demande en principe un
 * consentement, PECR / ePrivacy) a été signalé AVANT la décision : ce réglage existe pour repasser une
 * marque en `consent` d'un clic, sans une ligne de code.
 */
export const MODES_SUIVI = ["all", "consent"] as const;
export type ModeSuivi = (typeof MODES_SUIVI)[number];

export interface EditionReglages {
  id: string;
  slug: string;
  market: string;
  language: string;
  regime: string;
  isPrimary: boolean;
  sendingSubdomain: string | null;
  fromName: string | null;
  replyTo: string | null;
}

export interface ReglagesMarque {
  id: string;
  slug: string;
  name: string;
  editions: EditionReglages[];
  /**
   * Faux tant que la migration 0078 n'est pas appliquée : les colonnes `from_name` / `reply_to`
   * n'existent pas encore. L'écran grise alors les deux champs au lieu d'échouer à l'enregistrement.
   */
  expediteurDisponible: boolean;
  /**
   * `null` tant que la migration 0092 n'est pas appliquée (colonne `tracking_mode` absente) : l'écran
   * grise alors le réglage au lieu d'échouer, et rien d'autre de la page n'en dépend.
   */
  trackingMode: ModeSuivi | null;
}

/** Colonne absente : Postgres (42703) à la lecture, le cache de schéma de PostgREST (PGRST204) à l'écriture. */
export function colonneAbsente(error: unknown): boolean {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = String(e.code ?? "");
  const message = String(e.message ?? "");
  return (code === "42703" || code === "PGRST204") && /from_name|reply_to/.test(message);
}

/**
 * La colonne `asset.tracking_mode` n'existe pas encore (0092 non appliquée) : « does not exist » de
 * Postgres à la lecture, « schema cache » de PostgREST à l'écriture — et le message NOMME la colonne.
 * ⚠️ Le nom est exigé : une autre colonne absente, ou une panne, ne doit pas se lire « 0092 manquante ».
 */
export function modeSuiviAbsent(error: unknown): boolean {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = String(e.code ?? "");
  const message = String(e.message ?? "");
  return /tracking_mode/.test(message) && (code === "42703" || code === "PGRST204" || /schema cache|does not exist/i.test(message));
}

const COLONNES = "id, slug, market, language, compliance_regime, is_primary, sending_subdomain";

/**
 * Lit une marque par son slug. `null` = inconnue ; `known: false` = la lecture a échoué.
 *
 * ⛔ TOLÉRANTE À L'ABSENCE DE 0078, ET C'EST CE QUI REND CE CODE LIVRABLE AVANT LA MIGRATION. Sans le
 * second essai, la page Settings d'une marque tomberait en erreur le jour où ce code part avant que
 * le collègue n'ait appliqué 0078 — et avec elle le réglage du nom et de la langue, qui n'en dépendent
 * pas.
 */
export async function lireReglagesMarque(db: Db, slug: string): Promise<{ known: boolean; value: ReglagesMarque | null }> {
  // ⛔ Même tolérance pour 0092 : sans `tracking_mode`, on relit la marque sans lui plutôt que de
  // perdre toute la page — le réglage du suivi est alors grisé (`trackingMode: null`).
  const lireMarque = (colonnes: string) => db.from("asset").select(colonnes).eq("slug", slug).maybeSingle();
  let a = await lireMarque("id, slug, name, tracking_mode");
  if (a.error && modeSuiviAbsent(a.error)) a = await lireMarque("id, slug, name");
  if (a.error) return { known: false, value: null };
  if (!a.data) return { known: true, value: null };
  const asset = a.data as { id: string; slug: string; name: string; tracking_mode?: unknown };
  const trackingMode = (MODES_SUIVI as readonly unknown[]).includes(asset.tracking_mode)
    ? (asset.tracking_mode as ModeSuivi)
    : null;

  const lire = (colonnes: string) =>
    db
      .from("asset_edition")
      .select(colonnes)
      .eq("asset_id", asset.id)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });

  let expediteurDisponible = true;
  let e = await lire(`${COLONNES}, from_name, reply_to`);
  if (e.error && colonneAbsente(e.error)) {
    expediteurDisponible = false;
    e = await lire(COLONNES);
  }
  if (e.error) return { known: false, value: null };

  const editions = (((e.data as unknown[]) ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id ?? ""),
    slug: String(r.slug ?? ""),
    market: String(r.market ?? ""),
    language: String(r.language ?? ""),
    regime: String(r.compliance_regime ?? ""),
    isPrimary: Boolean(r.is_primary),
    sendingSubdomain: typeof r.sending_subdomain === "string" ? r.sending_subdomain : null,
    fromName: typeof r.from_name === "string" ? r.from_name : null,
    replyTo: typeof r.reply_to === "string" ? r.reply_to : null,
  }));
  return {
    known: true,
    value: { id: asset.id, slug: asset.slug, name: asset.name, editions, expediteurDisponible, trackingMode },
  };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/** Ce qu'un en-tête d'e-mail ne supporte pas dans un nom affiché. */
const INTERDITS_NOM = /[\u0000-\u001f\u007f"\\<>]/;

/** Même motif que le worker (`mailgun.ts`) et que la base (0078) : une adresse, une seule. */
const EMAIL = /^[^\s@",;<>()\\]+@[^\s@",;<>()\\]+\.[a-z]{2,}$/i;

export type Valide<T> = { ok: true; value: T } | { ok: false; error: string };

export function validerNomMarque(v: unknown): Valide<string> {
  if (typeof v !== "string") return { ok: false, error: "The brand name must be text." };
  const nom = v.trim();
  if (nom.length < 1 || nom.length > 80) return { ok: false, error: "The brand name must be 1 to 80 characters." };
  if (INTERDITS_NOM.test(nom)) {
    return { ok: false, error: "The brand name cannot contain quotes, backslashes, angle brackets or line breaks — it is shown in the From of every email." };
  }
  return { ok: true, value: nom };
}

/** Vide = pas de réglage (`null`) : le nom de la marque sert alors de nom d'expéditeur. */
export function validerNomExpediteur(v: unknown): Valide<string | null> {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "The sender name must be text." };
  const nom = v.trim();
  if (nom === "") return { ok: true, value: null };
  if (nom.length > 64) return { ok: false, error: "The sender name must be 64 characters or less." };
  if (INTERDITS_NOM.test(nom)) {
    return { ok: false, error: "The sender name cannot contain quotes, backslashes, angle brackets or line breaks." };
  }
  return { ok: true, value: nom };
}

/** Vide = pas de Reply-To (`null`). */
export function validerReplyTo(v: unknown): Valide<string | null> {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "The reply-to address must be text." };
  const a = v.trim();
  if (a === "") return { ok: true, value: null };
  if (a.length > 254 || !EMAIL.test(a)) return { ok: false, error: "The reply-to must be a single email address, like team@brand.com." };
  return { ok: true, value: a };
}

export function validerLangue(v: unknown): Valide<string> {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v)
    ? { ok: true, value: v }
    : { ok: false, error: `The language must be one of ${LOCALES.join(", ")}.` };
}

export function validerMarche(v: unknown): Valide<string> {
  return typeof v === "string" && /^[A-Z]{2}$/.test(v.trim())
    ? { ok: true, value: v.trim() }
    : { ok: false, error: "The market must be a two-letter country code, like BR or FR." };
}

/** `all` ou `consent`, rien d'autre — pas même une casse différente : la contrainte de 0092 la refuserait. */
export function validerModeSuivi(v: unknown): Valide<ModeSuivi> {
  return (MODES_SUIVI as readonly unknown[]).includes(v)
    ? { ok: true, value: v as ModeSuivi }
    : { ok: false, error: "Tracking must be “all” or “consent”." };
}

export function validerRegime(v: unknown): Valide<RegimeMarque> {
  return (REGIMES_MARQUE as readonly unknown[]).includes(v)
    ? { ok: true, value: v as RegimeMarque }
    : { ok: false, error: "The compliance regime must be gdpr, lgpd or canspam." };
}
