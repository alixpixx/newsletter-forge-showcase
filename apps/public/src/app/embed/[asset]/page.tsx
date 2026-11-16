import { getDb } from "@/lib/supabase";
import { signForm } from "@/lib/tokens";
import { SignupForm } from "@/components/signup-form";
import { normalizeLocale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/**
 * Widget d'inscription — une ÉDITION, pas seulement une marque (lot E-1).
 *
 * `/embed/atlas-review` sert l'édition primaire ; `/embed/atlas-review?edition=cl` sert la section
 * chilienne, qui a sa propre liste, sa propre langue et son propre texte de consentement. C'est le
 * mécanisme demandé par Alix : « le même domaine peut avoir plusieurs newsletters et listes
 * différentes par langue ».
 *
 * ⛔ Une édition demandée mais introuvable n'est PAS remplacée par la primaire : le formulaire
 * afficherait alors un texte de consentement pour une publication que le visiteur n'a pas choisie,
 * et le consentement recueilli ne vaudrait rien.
 */
export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ asset: string }>;
  searchParams: Promise<{ edition?: string }>;
}) {
  const { asset: slug } = await params;
  const editionSlug = ((await searchParams).edition ?? "").trim().toLowerCase();
  const db = getDb();

  let name = "";
  let brand = "#ff368d";
  let locale = normalizeLocale(null);
  let consentMode: "single" | "granular" = "single";
  let consentText = "";
  let editionIntrouvable = false;
  let suiviPourTous = false;

  if (db) {
    const { data: asset } = await db.from("asset").select("id, name").eq("slug", slug).maybeSingle();
    if (asset) {
      name = asset.name;
      // ⚠️ Mêmes précautions que `POST /api/v1/signup` : ordre EXPLICITE (jamais `limit(1)` nu) et
      // repli sur l'ancienne forme tant que la migration 0026 n'a pas ajouté `slug`/`is_primary`.
      // Le tri par `created_at` désigne exactement l'édition que 0026 marquera primaire, donc la
      // page rend la même chose avant et après.
      type EditionLite = { branding?: unknown; language?: string | null; consent_mode?: string | null };
      let edition: EditionLite | null = null;

      const moderne = await db
        .from("asset_edition")
        .select("branding, language, consent_mode, slug, is_primary")
        .eq("asset_id", asset.id)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true });

      if (!moderne.error && moderne.data) {
        const rows = moderne.data as unknown as (EditionLite & { slug?: string | null })[];
        if (editionSlug) {
          edition = rows.find((e) => (e.slug ?? "").toLowerCase() === editionSlug) ?? null;
          if (!edition) editionIntrouvable = true;
        } else {
          edition = rows[0] ?? null;
        }
      } else {
        if (editionSlug) editionIntrouvable = true;
        const ancien = await db
          .from("asset_edition")
          .select("branding, language, consent_mode")
          .eq("asset_id", asset.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        edition = (ancien.data as unknown as EditionLite | null) ?? null;
      }

      const b = (edition?.branding ?? {}) as { color?: string };
      if (b.color) brand = b.color;
      locale = normalizeLocale(edition?.language as string | undefined);
      if (edition?.consent_mode === "granular") consentMode = "granular";
      const { data: cv } = await db
        .from("consent_version").select("legal_text").eq("asset_id", asset.id)
        .order("effective_from", { ascending: false }).limit(1).maybeSingle();
      if (cv?.legal_text) consentText = cv.legal_text;
      // 0092 — en mode « suivi pour tous », la case « J'accepte le suivi » ne changerait rien : la
      // montrer décochée serait un faux choix. Lu À PART : sur une base d'avant 0092 la lecture échoue
      // et la case reste (règle du consentement). Le refus se fait dans le centre de préférences.
      const { data: mode, error: eMode } = await db.from("asset").select("tracking_mode").eq("id", asset.id).maybeSingle();
      if (!eMode && (mode as { tracking_mode?: string | null } | null)?.tracking_mode === "all") suiviPourTous = true;
    }
  }

  // Le refus est explicite. Sans lui, le visiteur verrait le formulaire de la mauvaise liste.
  if (editionIntrouvable) {
    return (
      <div style={{ padding: 24, fontSize: 14, color: "var(--muted)" }}>
        Formulaire indisponible (édition « {editionSlug} » inconnue pour « {slug} »).
      </div>
    );
  }

  if (!name) {
    return (
      <div style={{ padding: 24, fontSize: 14, color: "var(--muted)" }}>
        Formulaire indisponible (marque « {slug} » inconnue).
      </div>
    );
  }

  return (
    <div style={{ ["--brand" as string]: brand }} className="mx-auto max-w-[420px] p-3">
      <SignupForm asset={slug} assetName={name} consentText={consentText} brand={brand} formToken={signForm()} locale={locale} consentMode={consentMode} edition={editionSlug || undefined} trackingForAll={suiviPourTous} />
    </div>
  );
}
