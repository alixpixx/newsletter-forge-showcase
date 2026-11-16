import { hashPassword, refusMotDePasse } from "@/lib/auth";
import { setPassword, type AppUserRow, type AppUserStatus, type Db } from "@/lib/data/app-user";

/**
 * Un administrateur pose le mot de passe d'un AUTRE compte — la décision et l'écriture, sans
 * transport. Éprouvé sans base par handler.test.ts.
 *
 * Trois cas, selon le statut lu :
 *  - `active`   → le mot de passe change, toutes les sessions de la personne tombent (0091) ;
 *  - `invited`  → le compte est ACTIVÉ (décision d'Alix, 01/10/2026) et le lien d'invitation meurt ;
 *  - `disabled` → le mot de passe change, le compte RESTE désactivé : réactiver est un autre geste,
 *                 que l'écran propose à part (Status).
 */

export type ResultatDefinition =
  | { ok: true; activated: boolean; status: AppUserStatus }
  | { ok: false; statut: number; erreur: string };

export async function definirMotDePasse(
  corpsRecu: unknown,
  cible: Pick<AppUserRow, "id" | "email" | "status">,
  db: Db,
  acteur: string,
): Promise<ResultatDefinition> {
  const body = (corpsRecu ?? {}) as { password?: unknown };
  const motif = refusMotDePasse(body.password);
  if (motif) return { ok: false, statut: 400, erreur: motif };

  const ecrit = await setPassword(db, cible.id, await hashPassword(body.password as string), cible.status);
  if (!ecrit) {
    return { ok: false, statut: 409, erreur: "This account changed meanwhile. Reload the page and try again." };
  }
  const activated = cible.status === "invited" && ecrit.status === "active";

  // ⛔ Jamais le mot de passe, ni l'empreinte, dans le journal. Un audit raté ne défait pas le geste.
  const { error } = await db.from("audit_log").insert({
    actor: acteur,
    action: "user-password-set",
    target_type: "app_user",
    target_id: cible.id,
    meta: { email: cible.email, activated },
  });
  if (error) console.error(JSON.stringify({ event: "user-password-set-audit-failed", message: error.message }));

  return { ok: true, activated, status: ecrit.status };
}
