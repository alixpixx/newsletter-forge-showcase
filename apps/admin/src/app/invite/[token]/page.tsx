import { AcceptInviteForm } from "@/components/users/accept-invite-form";

// Hors du groupe (dashboard) : pas de barre latérale, pas de contexte de marque — la personne
// n'a pas encore de compte utilisable, et rien ici ne doit interroger la session.
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // ⚠️ Le jeton n'est PAS vérifié ici. Le faire côté page dirait, avant toute action, si un lien
  // correspond à un compte — un oracle offert à quiconque essaie des jetons au hasard. La seule
  // réponse vient de la route, en échange d'un mot de passe.
  return <AcceptInviteForm token={token} />;
}
