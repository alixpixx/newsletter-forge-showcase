import { EmailDoc, newId, textBlock, type EmailDoc as EmailDocType } from "@nf/render/schema";
import { getSessionUser, templatesVisibles } from "@/lib/session";
import { getDb } from "@/lib/supabase";

/**
 * Accès serveur aux templates du builder (`newsletter.template` + `newsletter.template_version`).
 *
 * Ces helpers existent pour que les PAGES serveur (/templates) lisent la base directement, sans
 * repasser par HTTP : une page RSC qui fetch sa propre route est un aller-retour inutile et une
 * source de bugs de cookies. Les routes `app/api/builder/**` partagent exactement les mêmes
 * fonctions — une seule définition du scope marque, donc aucune divergence possible.
 *
 * ⚠️ INVARIANT : tout est scopé par marque. Aucune fonction ici n'accepte de lire un template
 * sans `assetId` ; un template d'une autre marque doit être indiscernable d'un template inexistant.
 */

/** Doit rester aligné sur le CHECK de `newsletter.template.category` (migration 0017). */
export const TEMPLATE_CATEGORIES = [
  "newsletter",
  "daily_pick",
  "preview",
  "roundup",
  "win_back",
  "welcome",
  "transactional",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface TemplateListRow {
  id: string;
  name: string;
  slug: string;
  category: string;
  updatedAt: string;
  /** Dernière version publiée, `null` si le template n'a jamais été publié. */
  publishedVersion: number | null;
}

export interface TemplateVersionRow {
  version: number;
  status: string;
  createdAt: string;
  note: string | null;
  sizeBytes: number | null;
}

export interface TemplateWithDraft {
  template: { id: string; name: string; slug: string; category: string };
  draft: {
    doc: unknown;
    subject: string;
    preheader: string;
    /** Jeton anti-conflit : à renvoyer tel quel dans `baseUpdatedAt` au PATCH. */
    updatedAt: string;
    /** Id de la ligne `template_version` version 0 — sert de `template_version_id` aux tests. */
    versionId: string;
  } | null;
  versions: TemplateVersionRow[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un id non-uuid ne peut désigner aucune ligne : on l'écarte avant PostgREST (qui répondrait 400). */
export const isUuid = (v: string): boolean => UUID_RE.test(v);

/**
 * Email de la session courante — écrit dans `created_by` / `author_email` (traçabilité).
 *
 * ⚠️ Passe désormais par `getSessionUser()`, la source unique : cette fonction lisait le cookie
 * elle-même, en doublon d'une lecture identique dans api/ai/_shared.ts. Deux lectures veulent
 * dire deux règles qui divergent le jour où l'une change.
 */
export async function authorEmail(): Promise<string | null> {
  return (await getSessionUser())?.email ?? null;
}

/* ------------------------------------------------------------------ *
 * Slug
 * ------------------------------------------------------------------ */

/** kebab-case ASCII. Les diacritiques sont dépliés (NFD) puis retirés : « Prévia #3 » → « previa-3 ». */
export function slugify(input: string): string {
  const base = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return base.length > 0 ? base : "template";
}

/**
 * Slug unique DANS la marque (contrainte `unique (asset_id, slug)`). On lit les slugs voisins en
 * une requête puis on suffixe -2, -3… Deux créations simultanées du même nom peuvent encore
 * entrer en collision : l'appelant retente, c'est la contrainte d'unicité qui tranche, pas nous.
 */
export async function uniqueSlug(
  db: NonNullable<ReturnType<typeof getDb>>,
  assetId: string,
  name: string,
): Promise<string> {
  const base = slugify(name);
  const { data } = await db
    .from("template")
    .select("slug")
    .eq("asset_id", assetId)
    .like("slug", `${base}%`);

  const taken = new Set<string>(
    ((data as unknown[]) ?? []).map((r) => String((r as { slug?: unknown }).slug ?? "").toLowerCase()),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/* ------------------------------------------------------------------ *
 * Document initial
 * ------------------------------------------------------------------ */

/**
 * Document de départ d'un nouveau template : une row, une colonne, un texte d'accroche et le
 * footer légal. Le footer est posé D'EMBLÉE parce qu'un doc sans lui est refusé à l'envoi
 * (veto de conformité du worker) — on ne veut pas que l'utilisateur découvre ça à la publication.
 */
export function initialDoc(assetSlug: string, locale: string, name: string): EmailDocType {
  return EmailDoc.parse({
    schema: 2,
    meta: {
      subject: name.slice(0, 200),
      preheader: "",
      assetSlug,
      locale: locale.length >= 2 ? locale.slice(0, 12) : "en",
    },
    theme: {},
    rows: [
      {
        id: newId("row"),
        layout: "1",
        columns: [
          {
            id: newId("col"),
            blocks: [
              textBlock("Welcome — start writing your email here.", "body"),
              { id: newId("blk"), type: "footer_legal" },
            ],
          },
        ],
      },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * Lectures
 * ------------------------------------------------------------------ */

/**
 * Liste des templates NON archivés de la marque, avec leur dernière version publiée.
 * `assetId === null` (base injoignable) → liste vide : on préfère un écran vide honnête à
 * l'agrégat des 9 marques.
 *
 * ⚠️ Rend `[]` aussi bien pour « aucun template » que pour « la requête a échoué ». C'est
 * suffisant pour un écran qui ne fait qu'ÉNUMÉRER ; ça ne l'est pas pour un écran qui tire de
 * l'absence une affirmation — voir `listTemplatesRead`.
 */
export async function listTemplates(assetId: string | null): Promise<TemplateListRow[]> {
  return (await listTemplatesRead(assetId)).value;
}

/**
 * La même lecture, mais qui DIT si elle a abouti.
 *
 * ⛔ POURQUOI CETTE FORME EXISTE. Le panneau de cycle de vie ne se contente pas d'énumérer : il
 * conclut de l'ABSENCE d'un modèle dans cette liste que le rattachement pointe hors de la portée du
 * lecteur (« Set to a template that is not in your library »). Sur une requête `template` en erreur,
 * cette absence n'apprend rien — et l'écran transformerait une panne PostgREST en verdict d'accès,
 * avec le sélecteur verrouillé et la phrase « aucun modèle utilisable » sur une marque qui en a
 * douze. La distinction se fait donc ici, à la source, comme le fait déjà `grantedTemplateIds` en
 * levant. Les autres appelants n'ont aucune raison de la payer : ils gardent `listTemplates`.
 */
export async function listTemplatesRead(
  assetId: string | null,
): Promise<{ known: boolean; value: TemplateListRow[] }> {
  const db = getDb();
  // Pas de base, pas de marque : on ne SAIT pas ce que cette marque contient.
  if (!db || !assetId) return { known: false, value: [] };

  // La liste montre ce que cette personne peut ouvrir, et rien d'autre : un membre ne doit pas
  // lire le nom des templates de la marque auxquels il n'a pas accès — le nom d'une campagne
  // à venir en dit déjà long.
  const user = await getSessionUser();
  // ⚠️ Sans session, « rien de visible » est une RÉPONSE, pas une ignorance : le périmètre est vide.
  if (!user) return { known: true, value: [] };
  // `null` = tous (super_admin ou `all_access`, templates futurs compris) — voir lib/session.ts.
  const octroyes = await templatesVisibles(user, db);
  if (octroyes !== null && octroyes.length === 0) return { known: true, value: [] };

  let q = db
    .from("template")
    .select("id, name, slug, category, updated_at")
    .eq("asset_id", assetId)
    .is("archived_at", null);
  if (octroyes !== null) q = q.in("id", octroyes);

  const { data, error } = await q.order("updated_at", { ascending: false });

  // La requête a échoué : on ne sait pas ce que la marque contient. Le dire est le seul moyen
  // d'empêcher un appelant d'en déduire quoi que ce soit.
  if (error) return { known: false, value: [] };
  if (!data) return { known: true, value: [] };
  const rows = data as unknown[];
  const ids = rows.map((r) => String((r as { id?: unknown }).id ?? "")).filter(Boolean);
  if (ids.length === 0) return { known: true, value: [] };

  // Une seule requête pour toutes les versions publiées, réduite en mémoire (max par template).
  const { data: versions } = await db
    .from("template_version")
    .select("template_id, version")
    .in("template_id", ids)
    .eq("status", "published");

  const latest = new Map<string, number>();
  for (const raw of ((versions as unknown[]) ?? [])) {
    const v = raw as { template_id?: unknown; version?: unknown };
    const tid = String(v.template_id ?? "");
    const num = Number(v.version ?? 0);
    if (!latest.has(tid) || num > (latest.get(tid) as number)) latest.set(tid, num);
  }

  return {
    known: true,
    value: rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      const id = String(r.id ?? "");
      return {
        id,
        name: String(r.name ?? ""),
        slug: String(r.slug ?? ""),
        category: String(r.category ?? "newsletter"),
        updatedAt: String(r.updated_at ?? ""),
        publishedVersion: latest.get(id) ?? null,
      };
    }),
  };
}

/** Ligne `template` de la marque courante, ou `null` (inexistant OU appartenant à une autre marque). */
export async function findTemplate(
  db: NonNullable<ReturnType<typeof getDb>>,
  id: string,
  assetId: string,
): Promise<{ id: string; name: string; slug: string; category: string; updated_at: string } | null> {
  if (!isUuid(id)) return null;
  const { data } = await db
    .from("template")
    .select("id, name, slug, category, updated_at")
    .eq("id", id)
    .eq("asset_id", assetId)
    .is("archived_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    slug: String(r.slug ?? ""),
    category: String(r.category ?? "newsletter"),
    updated_at: String(r.updated_at ?? ""),
  };
}

export interface DraftRow {
  id: string;
  doc: unknown;
  subject: string;
  preheader: string;
  updated_at: string;
}

/** Le brouillon vivant (version 0). Unique par template — garanti par `uq_template_single_draft`. */
export async function getDraftRow(
  db: NonNullable<ReturnType<typeof getDb>>,
  templateId: string,
): Promise<DraftRow | null> {
  const { data } = await db
    .from("template_version")
    .select("id, doc, subject, preheader, updated_at")
    .eq("template_id", templateId)
    .eq("status", "draft")
    .maybeSingle();
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    doc: r.doc,
    subject: String(r.subject ?? ""),
    preheader: String(r.preheader ?? ""),
    updated_at: String(r.updated_at ?? ""),
  };
}

/**
 * Template + brouillon + historique publié, en 3 requêtes scopées marque.
 * `versions` ne liste QUE les versions publiées : ce sont les seules restaurables
 * (`template_restore` exige `status='published'`), afficher le brouillon y serait trompeur.
 */
export async function getTemplateWithDraft(id: string, assetId: string | null): Promise<TemplateWithDraft | null> {
  const db = getDb();
  if (!db || !assetId) return null;

  const template = await findTemplate(db, id, assetId);
  if (!template) return null;

  const [draft, published] = await Promise.all([
    getDraftRow(db, template.id),
    db
      .from("template_version")
      .select("version, status, note, size_bytes, created_at, updated_at, compiled_at")
      .eq("template_id", template.id)
      .eq("status", "published")
      .order("version", { ascending: false }),
  ]);

  const versions: TemplateVersionRow[] = ((published.data as unknown[]) ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      version: Number(r.version ?? 0),
      status: String(r.status ?? "published"),
      // Date de PUBLICATION : `created_at` est la naissance du brouillon, pas sa mise en ligne.
      createdAt: String(r.compiled_at ?? r.updated_at ?? r.created_at ?? ""),
      note: (r.note as string | null) ?? null,
      sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
    };
  });

  return {
    template: { id: template.id, name: template.name, slug: template.slug, category: template.category },
    draft: draft
      ? {
          doc: draft.doc,
          subject: draft.subject,
          preheader: draft.preheader,
          updatedAt: draft.updated_at,
          versionId: draft.id,
        }
      : null,
    versions,
  };
}

/** `template.updated_at` sert de tri de la liste — on le rafraîchit à chaque écriture du brouillon. */
export async function touchTemplate(
  db: NonNullable<ReturnType<typeof getDb>>,
  templateId: string,
): Promise<void> {
  await db.from("template").update({ updated_at: new Date().toISOString() }).eq("id", templateId);
}
