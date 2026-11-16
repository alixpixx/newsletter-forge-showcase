import { getDb } from "@/lib/supabase";
import { vueConfirmation } from "./vue";

export const dynamic = "force-dynamic";

/**
 * La page du lien de confirmation (double opt-in).
 *
 * ⛔⛔ CETTE PAGE N'ÉCRIT RIEN (24/09/2026). Elle affiche un bouton « Confirm my subscription » ;
 * c'est le clic qui confirme, par un POST vers `api/v1/confirm`. Jusqu'à ce jour elle confirmait au
 * rendu du GET, donc au passage de n'importe quel antivirus ou aperçu qui pré-charge les liens — et
 * la preuve légale disait que la personne l'avait fait. Le pourquoi complet est dans
 * `api/v1/confirm/route.ts`.
 *
 * Le rendu vit dans `vue.tsx`, sous banc ; ici on ne fait que brancher la vraie base.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ token?: string; lang?: string }> }) {
  return vueConfirmation(await searchParams, { getDb });
}
