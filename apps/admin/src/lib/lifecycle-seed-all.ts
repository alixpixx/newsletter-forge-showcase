import type { LifecycleKind } from "@nf/render/lifecycle-checks";
import { LIFECYCLE_EDITABLE } from "@/lib/automations";
import { lifecycleStarterLocale } from "@/lib/lifecycle-starter";

/**
 * « CREATE EDITABLE VERSIONS FOR ALL BRANDS » — décision d'Alix du 22/09/2026.
 *
 * Chaque marque obtient, pour chacun des quatre e-mails de cycle de vie, un modèle du builder à ses
 * couleurs, rattaché, qu'elle peut réécrire. Le HTML codé en dur du worker ne sert plus que de filet.
 *
 * ⛔ IDEMPOTENT, ET SURTOUT : N'ÉCRASE JAMAIS UN RATTACHEMENT. Une marque qui a déjà réglé son e-mail
 * de bienvenue a fait un choix ; le remplacer par un point de départ générique lui ferait envoyer,
 * sans prévenir, un e-mail qu'elle n'a pas écrit. Deux barrières, parce qu'une seule ne tient pas :
 *
 *   1. la fente est LUE avant de créer quoi que ce soit — une fente prise n'est pas touchée, et aucun
 *      modèle n'est créé pour elle ;
 *   2. le rattachement est un INSERT, jamais un upsert. Entre la lecture et l'écriture, quelqu'un a pu
 *      rattacher son modèle depuis l'écran : l'INSERT bute alors sur la clé primaire `(asset_id, kind)`
 *      (23505), on RETIRE le modèle qu'on venait de créer, et le sien reste en place.
 *
 * ⚠️ `setLifecycleBinding` n'est PAS utilisé ici : c'est un upsert, fait pour DÉPLACER un rattachement
 * (le geste « Customise » d'une marque). Ici, le déplacer serait exactement la faute à éviter.
 *
 * ⛔ CE MODULE N'IMPORTE NI LA SESSION NI LA BASE : la création est INJECTÉE (`creer`, `retirer`).
 * C'est ce qui permet au banc de prouver les deux barrières avec un faux client, sans rien écrire.
 */

/** Le client Supabase, réduit à ce dont ce module a besoin — un faux client le remplace au banc. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any };

export type StatutSemis = "already_bound" | "created" | "taken_meanwhile" | "failed";

export interface LigneSemis {
  assetId: string;
  assetSlug: string;
  kind: LifecycleKind;
  statut: StatutSemis;
  templateId?: string;
  message?: string;
}

export interface Marque {
  id: string;
  slug: string;
  name: string;
  languages: string[];
}

export interface DepsSemis {
  db: Db;
  author: string | null;
  /** Crée modèle + brouillon + octroi, SANS rattacher (`creerModeleCycleDeVie`). */
  creer: (p: { marque: Marque; kind: LifecycleKind; locale: string; theme: unknown }) => Promise<
    { ok: true; id: string } | { ok: false; message: string }
  >;
  /** Retire un modèle qu'on vient de créer et qui n'est PAS rattaché (`retirerModele`). */
  retirer: (templateId: string) => Promise<boolean>;
}

/** Catégories des modèles de cycle de vie : leur thème n'est pas celui de la marque, c'est le nôtre. */
const CATEGORIES_CYCLE_DE_VIE = new Set(["welcome", "transactional", "win_back"]);

/**
 * Le thème de chaque marque : celui de son modèle PUBLIÉ le plus récemment modifié, hors e-mails de
 * cycle de vie. `known: false` si une lecture échoue — l'appelant ne sème pas à l'aveugle.
 *
 * ⚠️ Une marque sans modèle publié n'a pas d'entrée : son e-mail prendra le thème par défaut du
 * builder, qu'elle pourra régler ensuite dans l'éditeur. Mesuré le 22/09/2026 : les modèles publiés
 * de trois marques gardent le rose par défaut (#E11D48) — le thème recopié est alors celui-là, et
 * c'est bien celui qu'elles envoient déjà.
 */
export async function lireThemesDeMarque(db: Db, assetIds: string[]): Promise<{ known: boolean; value: Map<string, unknown> }> {
  const value = new Map<string, unknown>();
  if (assetIds.length === 0) return { known: true, value };

  const t = await db
    .from("template")
    .select("asset_id, category, current_version_id, updated_at")
    .in("asset_id", assetIds)
    .is("archived_at", null)
    .not("current_version_id", "is", null)
    .order("updated_at", { ascending: false });
  if (t.error) return { known: false, value };

  const versionParMarque = new Map<string, string>();
  for (const r of ((t.data as unknown[]) ?? []) as { asset_id?: unknown; category?: unknown; current_version_id?: unknown }[]) {
    const asset = typeof r.asset_id === "string" ? r.asset_id : null;
    const version = typeof r.current_version_id === "string" ? r.current_version_id : null;
    if (!asset || !version || CATEGORIES_CYCLE_DE_VIE.has(String(r.category))) continue;
    // Trié du plus récent au plus ancien : le premier vu par marque est le bon.
    if (!versionParMarque.has(asset)) versionParMarque.set(asset, version);
  }
  if (versionParMarque.size === 0) return { known: true, value };

  const v = await db
    .from("template_version")
    .select("id, doc")
    .in("id", [...versionParMarque.values()]);
  if (v.error) return { known: false, value };
  const docParVersion = new Map<string, unknown>(
    (((v.data as unknown[]) ?? []) as { id?: unknown; doc?: unknown }[]).map((r) => [String(r.id), r.doc]),
  );
  for (const [asset, version] of versionParMarque) {
    const theme = (docParVersion.get(version) as { theme?: unknown } | null | undefined)?.theme;
    if (theme && typeof theme === "object" && !Array.isArray(theme)) value.set(asset, theme);
  }
  return { known: true, value };
}

/**
 * Pose le rattachement SEULEMENT si la fente est libre. Rend `pris: true` si quelqu'un l'a prise
 * entre-temps (23505 sur la clé primaire `(asset_id, kind)`).
 */
export async function lierSiLibre(
  db: Db,
  assetId: string,
  kind: LifecycleKind,
  templateId: string,
  author: string | null,
): Promise<{ ok: true } | { ok: false; pris: boolean; message: string }> {
  const { error } = await db.from("lifecycle_template").insert({
    asset_id: assetId,
    kind,
    template_id: templateId,
    updated_by: author,
    updated_at: new Date().toISOString(),
  });
  if (!error) return { ok: true };
  const code = (error as { code?: unknown }).code;
  return { ok: false, pris: code === "23505", message: String((error as { message?: unknown }).message ?? "could not attach") };
}

/**
 * Le semis de toutes les marques. `known: false` = une lecture préalable a échoué : RIEN n'a été créé.
 */
export async function semerToutesLesMarques(deps: DepsSemis): Promise<{ known: boolean; lignes: LigneSemis[] }> {
  const { db } = deps;

  const a = await db.from("asset").select("id, slug, name, languages").order("slug");
  if (a.error) return { known: false, lignes: [] };
  const marques: Marque[] = (((a.data as unknown[]) ?? []) as Record<string, unknown>[])
    .filter((r) => typeof r.id === "string")
    .map((r) => ({
      id: String(r.id),
      slug: String(r.slug ?? ""),
      name: String(r.name ?? ""),
      languages: Array.isArray(r.languages) ? r.languages.map(String) : [],
    }));
  if (marques.length === 0) return { known: true, lignes: [] };
  const ids = marques.map((m) => m.id);

  // ⛔ BARRIÈRE 1 : ce qui est déjà rattaché, lu AVANT toute écriture. Une lecture ratée n'est pas
  // « rien de rattaché » : on s'arrête, sinon on sèmerait par-dessus le réglage de chaque marque.
  const b = await db.from("lifecycle_template").select("asset_id, kind").in("asset_id", ids);
  if (b.error) return { known: false, lignes: [] };
  const pris = new Set(
    (((b.data as unknown[]) ?? []) as { asset_id?: unknown; kind?: unknown }[]).map((r) => `${String(r.asset_id)}:${String(r.kind)}`),
  );

  // La langue d'envoi de chaque marque : ce qu'elle ENVOIE (éditions), pas ce qu'elle déclare.
  const e = await db.from("asset_edition").select("asset_id, language, is_primary").in("asset_id", ids);
  if (e.error) return { known: false, lignes: [] };
  const languesParMarque = new Map<string, string[]>();
  const editions = (((e.data as unknown[]) ?? []) as { asset_id?: unknown; language?: unknown; is_primary?: unknown }[])
    // L'édition principale d'abord : c'est la langue de la majorité des abonnés.
    .sort((x, y) => Number(Boolean(y.is_primary)) - Number(Boolean(x.is_primary)));
  for (const r of editions) {
    if (typeof r.asset_id !== "string" || typeof r.language !== "string") continue;
    const l = languesParMarque.get(r.asset_id) ?? [];
    l.push(r.language);
    languesParMarque.set(r.asset_id, l);
  }

  const themes = await lireThemesDeMarque(db, ids);
  if (!themes.known) return { known: false, lignes: [] };

  const lignes: LigneSemis[] = [];
  for (const m of marques) {
    const locale = lifecycleStarterLocale(languesParMarque.get(m.id) ?? [], m.languages);
    // ⛔ Les TROIS e-mails de la carte System, pas `reengagement` : la relance est une automation du
    // moteur (24/09/2026), qui prend ses modèles par étape — un modèle semé ici ne partirait jamais.
    for (const kind of LIFECYCLE_EDITABLE) {
      const base = { assetId: m.id, assetSlug: m.slug, kind };
      if (pris.has(`${m.id}:${kind}`)) {
        lignes.push({ ...base, statut: "already_bound" });
        continue;
      }

      const cree = await deps.creer({ marque: m, kind, locale, theme: themes.value.get(m.id) });
      if (!cree.ok) {
        lignes.push({ ...base, statut: "failed", message: cree.message });
        continue;
      }

      // ⛔ BARRIÈRE 2 : un INSERT, jamais un upsert.
      const lien = await lierSiLibre(db, m.id, kind, cree.id, deps.author);
      if (lien.ok) {
        lignes.push({ ...base, statut: "created", templateId: cree.id });
        continue;
      }
      // Le modèle neuf n'est rattaché à rien et ne contient aucun travail : le garder ferait un
      // jumeau homonyme dans la bibliothèque. On le retire, et on dit s'il subsiste.
      const retire = await deps.retirer(cree.id);
      const suite = retire ? "" : ` — the unused template ${cree.id} could not be removed`;
      lignes.push({
        ...base,
        statut: lien.pris ? "taken_meanwhile" : "failed",
        message: (lien.pris ? "someone attached a template to this email meanwhile; theirs was kept" : lien.message) + suite,
      });
    }
  }
  return { known: true, lignes };
}
