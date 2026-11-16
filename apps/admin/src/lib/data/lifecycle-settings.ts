import { getDb } from "@/lib/supabase";

/**
 * L'interrupteur des e-mails de cycle de vie qu'on peut taire (`newsletter.lifecycle_setting`, 0086).
 *
 * ⛔ LIGNE ABSENTE = ACTIVÉ, comme le lit l'app publique (`apps/public/src/lib/cycle-de-vie-coupe.ts`) :
 * l'écran ne peut pas dire « Off » là où l'e-mail part.
 * ⛔ UNE LECTURE RATÉE SE DIT (`known: false`) : l'écran écrit qu'il ne sait pas, jamais « On » par défaut.
 * ⛔ La confirmation n'a pas d'interrupteur : le type l'exclut, la contrainte de 0086 la refuse.
 */
export type Coupable = "welcome" | "unsubscribe_ack";

export interface LifecycleSettingsRead {
  known: boolean;
  value: Record<Coupable, boolean>;
}

const TOUT_ACTIVE: Record<Coupable, boolean> = { welcome: true, unsubscribe_ack: true };

export async function listLifecycleSettings(assetId: string | null): Promise<LifecycleSettingsRead> {
  const db = getDb();
  if (!db || !assetId) return { known: false, value: { ...TOUT_ACTIVE } };
  const { data, error } = await db.from("lifecycle_setting").select("kind, enabled").eq("asset_id", assetId);
  if (error) return { known: false, value: { ...TOUT_ACTIVE } };
  const value = { ...TOUT_ACTIVE };
  for (const row of (data as { kind?: unknown; enabled?: unknown }[] | null) ?? []) {
    if ((row.kind === "welcome" || row.kind === "unsubscribe_ack") && row.enabled === false) value[row.kind] = false;
  }
  return { known: true, value };
}

/**
 * Les e-mails de ce kind ACCEPTÉS par Mailgun pour la marque sur 30 jours (`email_outbox.status = 'sent'`).
 * `null` = non lu (l'écran l'écrit, jamais « 0 »).
 */
export async function countLifecycleSent30d(
  assetId: string | null,
  kind: "confirmation" | Coupable,
  maintenant: Date,
): Promise<number | null> {
  const db = getDb();
  if (!db || !assetId) return null;
  const depuis = new Date(maintenant.getTime() - 30 * 86_400_000).toISOString();
  const { count, error } = await db
    .from("email_outbox")
    .select("id", { count: "exact", head: true })
    .eq("asset_id", assetId)
    .eq("kind", kind)
    .eq("status", "sent")
    .gte("sent_at", depuis);
  return error || typeof count !== "number" ? null : count;
}

/** Pose l'interrupteur (upsert sur `(asset_id, kind)`). Rend l'erreur telle quelle, sans lever. */
export async function setLifecycleSetting(
  db: NonNullable<ReturnType<typeof getDb>>,
  assetId: string,
  kind: Coupable,
  enabled: boolean,
  author: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await db
    .from("lifecycle_setting")
    .upsert(
      { asset_id: assetId, kind, enabled, updated_by: author, updated_at: new Date().toISOString() },
      { onConflict: "asset_id,kind" },
    );
  return error ? { ok: false, message: error.message } : { ok: true };
}
