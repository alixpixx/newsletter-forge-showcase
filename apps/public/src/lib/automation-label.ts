/**
 * LE LABEL D'AUTOMATION (0095) — le nom qu'on tape dans optinforge (onglet Where d'une créative), et
 * le slug qui l'identifie ici.
 *
 * Une créative qui porte le label « Libertadores 2026 » fait arriver ses inscrits avec ce label ; une
 * automation dont le filtre `labels` vaut `["libertadores-2026"]` ne vise qu'eux.
 *
 * ⛔ LE SLUG SE CALCULE ICI ET NULLE PART AILLEURS. optinforge envoie le NOM, deux fois : à
 * l'enregistrement (`POST /api/v1/automation-labels`) et dans chaque inscription
 * (`capture.creative.automation_label`). Si l'émetteur calculait le slug lui-même, deux
 * implémentations devraient s'accorder sur chaque accent et chaque tiret, et le jour où elles
 * divergent, l'automation viserait un label que plus aucune inscription ne porte — sans une erreur.
 *
 * ⚠️ La base vérifie la FORME du slug (`automation_label_slug_format`, `capture_event_automation_label_format`),
 * avec la même expression que `LABEL_SLUG_RE`.
 */

export const MAX_LABEL_NAME = 80;
export const LABEL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Le nom affiché : espaces repliés, 1 à 80 caractères. `null` sinon.
 *
 * ⚠️ UN NOM TROP LONG EST REFUSÉ, PAS TRONQUÉ : deux noms qui ne diffèrent qu'après le 80e caractère
 * deviendraient le même label sans que personne l'ait voulu.
 */
export function labelName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || t.length > MAX_LABEL_NAME) return null;
  return t;
}

/**
 * « Libertadores 2026 » → `libertadores-2026`. Accents retirés, tout ce qui n'est ni lettre ni chiffre
 * devient un tiret. `null` quand il ne reste rien (un nom fait d'emojis ou d'idéogrammes).
 */
export function labelSlug(name: string): string | null {
  const s = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return LABEL_SLUG_RE.test(s) ? s : null;
}

/** Le nom ET son slug, ou `null` si l'un des deux est inutilisable. */
export function readLabel(raw: unknown): { name: string; slug: string } | null {
  const name = labelName(raw);
  if (!name) return null;
  const slug = labelSlug(name);
  return slug ? { name, slug } : null;
}
