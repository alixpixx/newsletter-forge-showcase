import { getDb } from "@/lib/supabase";
import { verifyPrefs } from "@/lib/tokens";
import { vuePreferences } from "./vue";

export const dynamic = "force-dynamic";

/**
 * Centre de préférences. Le rendu — et la règle « un abonné effacé voit l'écran d'un lien faux » —
 * vit dans `vue.tsx`, sous banc ; ici on ne fait que brancher la vraie base et le vrai jeton.
 */
export default async function PreferencesPage({ searchParams }: { searchParams: Promise<{ token?: string; lang?: string; ls?: string }> }) {
  return vuePreferences(await searchParams, { getDb, verifyPrefs });
}
