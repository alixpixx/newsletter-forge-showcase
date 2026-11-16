import { hashPassword, refusMotDePasse, verifyPassword } from "@/lib/auth";
import { setPassword, type AppUserRow, type Db } from "@/lib/data/app-user";

/**
 * Changement de mot de passe par la personne elle-même — la décision et l'écriture, sans
 * transport ni cookie (route.ts s'en charge). Éprouvé sans base par handler.test.ts.
 *
 * ⛔ Le mot de passe ACTUEL est exigé. Une session ouverte suffit à atteindre cette route : sans
 * cette vérification, quiconque passe devant un poste resté connecté prendrait le compte pour de
 * bon, et fermerait au passage la session de son propriétaire.
 */

export type ResultatChangement =
  | { ok: true; compte: AppUserRow }
  | { ok: false; statut: number; erreur: string; motDePasseFaux: boolean };

const refus = (statut: number, erreur: string, motDePasseFaux = false): ResultatChangement => ({
  ok: false,
  statut,
  erreur,
  motDePasseFaux,
});

export async function changerSonMotDePasse(
  corpsRecu: unknown,
  compte: Pick<AppUserRow, "id" | "email" | "password_hash">,
  db: Db,
): Promise<ResultatChangement> {
  const body = (corpsRecu ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
  const actuel = typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (!actuel) return refus(400, "Enter your current password.");
  const motif = refusMotDePasse(body.newPassword);
  if (motif) return refus(400, motif);
  const nouveau = body.newPassword as string;

  // `motDePasseFaux` est ce que compte le ralentisseur de la route : c'est le seul refus qui
  // renseigne sur le mot de passe stocké, donc le seul qu'un essai en boucle exploiterait.
  if (!(await verifyPassword(actuel, compte.password_hash))) {
    return refus(400, "Your current password is incorrect.", true);
  }
  if (nouveau === actuel) return refus(400, "Choose a password different from your current one.");

  const ecrit = await setPassword(db, compte.id, await hashPassword(nouveau), "active");
  // `null` = le compte n'était plus actif au moment d'écrire (désactivé entre-temps) : rien n'est
  // écrit, et le dire vaut mieux qu'un succès qui n'a pas eu lieu.
  if (!ecrit) return refus(409, "Your account changed meanwhile. Reload the page and try again.");

  // ⛔ Jamais le mot de passe, ni l'empreinte, dans le journal : le geste et son auteur suffisent.
  // Un audit raté ne défait pas le changement (même règle que l'archivage des campagnes).
  const { error } = await db.from("audit_log").insert({
    actor: `admin:${compte.email}`,
    action: "user-password-changed",
    target_type: "app_user",
    target_id: compte.id,
    meta: { by: "self" },
  });
  if (error) console.error(JSON.stringify({ event: "user-password-changed-audit-failed", message: error.message }));

  return { ok: true, compte: ecrit };
}
