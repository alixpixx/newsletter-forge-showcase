import type { Db } from "@/lib/supabase";

/**
 * L'INTERRUPTEUR d'un e-mail de cycle de vie (0086, 24/09/2026 — Alix : « tout éditable depuis la page
 * Automations »). Réglé par marque dans l'admin (`lifecycle_setting`).
 *
 * ⛔ SEULS `welcome` ET `unsubscribe_ack` SE COUPENT. Le type l'impose ici, la contrainte de 0086 le
 * refuse en base : la CONFIRMATION ne lit jamais ce réglage (sans elle, personne ne s'inscrit et le
 * double opt-in n'est plus prouvé).
 *
 * ⛔ COUPÉ = UNE LIGNE LUE QUI DIT `enabled = false`, RIEN D'AUTRE. Ligne absente ⇒ l'e-mail part (état
 * d'avant ce réglage). Lecture en échec ⇒ il part aussi, et c'est journalisé : un e-mail transactionnel
 * envoyé à tort gêne ; une confirmation ou un désabonnement sans leur e-mail, parce que la base a
 * hoqueté, se voit beaucoup moins. Cette fonction ne lève jamais.
 */
export type EmailCoupable = "welcome" | "unsubscribe_ack";

export async function emailCoupe(db: Db, assetId: string | null | undefined, kind: EmailCoupable): Promise<boolean> {
  if (!assetId) return false;
  try {
    const { data, error } = await db
      .from("lifecycle_setting")
      .select("enabled")
      .eq("asset_id", assetId)
      .eq("kind", kind)
      .maybeSingle();
    if (error) {
      console.error(JSON.stringify({ event: "lifecycle-setting-read-failed", kind, reason: error.message }));
      return false;
    }
    return (data as { enabled?: unknown } | null)?.enabled === false;
  } catch (e) {
    console.error(
      JSON.stringify({ event: "lifecycle-setting-read-failed", kind, reason: e instanceof Error ? e.message : String(e) }),
    );
    return false;
  }
}
