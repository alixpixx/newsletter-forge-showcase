import { getDb } from "@/lib/supabase";

/** Signup forms / acquisition — public embed widget per brand, read from `newsletter` (service_role). */

export interface FormRow {
  slug: string;
  name: string;
  consentMode: string; // "single" | "granular"
  language: string;
  regime: string; // "gdpr" | "lgpd" | ...
}

export interface FormsData {
  source: "db" | "none";
  rows: FormRow[];
}

/**
 * Hôte public du widget : l'app `apps/public`. Lu dans l'environnement (`PUBLIC_BASE_URL`, puis
 * `NEXT_PUBLIC_PUBLIC_BASE_URL`, comme `apps/public`), repli local `http://localhost:3001`.
 * ⛔ Toujours l'adresse DÉFINITIVE du site public, jamais une redirection : un snippet copié ici
 * doit survivre au changement d'hébergement.
 */
export const PUBLIC_BASE = (
  process.env.PUBLIC_BASE_URL?.trim() ||
  process.env.NEXT_PUBLIC_PUBLIC_BASE_URL?.trim() ||
  "http://localhost:3001"
).replace(/\/+$/, "");

/**
 * VOLONTAIREMENT NON SCOPÉ sur la marque courante : /forms est un catalogue — on veut
 * pouvoir copier le snippet d'embed de n'importe quelle marque sans changer de contexte.
 * La page se charge de MARQUER visuellement la marque courante (comparaison sur `slug`),
 * pour qu'aucun doute ne subsiste sur ce qu'on regarde.
 */
export async function getForms(assetIdsAutorises: string[]): Promise<FormsData> {
  const db = getDb();
  if (!db) return { source: "none", rows: [] };
  // ⛔ Liste vide = aucune marque autorisée : on rend vide plutôt que de retirer le filtre,
  // sinon `.in("id", [])` deviendrait « toutes » au premier refactor distrait.
  if (assetIdsAutorises.length === 0) return { source: "db", rows: [] };

  const { data, error } = await db
    .from("asset")
    .select("name, slug, editions:asset_edition(language, consent_mode, compliance_regime)")
    .in("id", assetIdsAutorises)
    .order("name");

  if (error || !data) return { source: "none", rows: [] };

  const rows: FormRow[] = (data as unknown[]).map((raw) => {
    const r = raw as {
      name?: string;
      slug?: string;
      editions?: { language?: string; consent_mode?: string; compliance_regime?: string }[];
    };
    const ed = r.editions?.[0];
    return {
      slug: String(r.slug ?? ""),
      name: String(r.name ?? r.slug ?? ""),
      consentMode: ed?.consent_mode ?? "single",
      language: ed?.language ?? "—",
      regime: ed?.compliance_regime ?? "—",
    };
  });

  return { source: "db", rows };
}
