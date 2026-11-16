import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Ancienne adresse du formulaire. ⭐ Plan AUTO-EDIT (25/09/2026) : la page d'un brouillon EST son
 * formulaire (`/automations/[id]`) — un clic de moins, et plus de fiche en lecture seule à traverser
 * pour modifier. Cette route ne fait que rediriger, pour que les liens déjà donnés restent valides.
 */
export default async function EditAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/automations/${encodeURIComponent(id)}`);
}
