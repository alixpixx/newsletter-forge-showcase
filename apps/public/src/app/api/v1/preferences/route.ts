import { getDb } from "@/lib/supabase";
import { verifyPrefs } from "@/lib/tokens";
import { handlePreferences } from "./handler";

/**
 * Centre de préférences + droits DSAR (chantier C3 du plan compliance). Actions, doctrine et accusé
 * de désinscription : tout est dans `handler.ts`, sous banc (22/09/2026). Ici on ne fait que
 * brancher la vraie base et la vraie vérification du jeton.
 */
export async function POST(req: Request) {
  return handlePreferences(req, { getDb, verifyPrefs });
}
