"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { ASSET_COOKIE, slugAutorise } from "@/lib/asset-context";

/**
 * Change la marque courante. Server action appelée par le sélecteur de la sidebar.
 * Pose le cookie httpOnly puis revalide tout le dashboard (tous les écrans sont scopés).
 *
 * ⚠️ Une server action est une route publique : elle est appelable directement, pas seulement
 * par le sélecteur. Jusqu'au 31/08/2026 elle ne validait que le FORMAT du slug — n'importe quel
 * slug bien formé passait, et `getCurrentAsset()` servait ensuite la marque correspondante.
 * Le contrôle est désormais un contrôle de DROIT, et il est ici parce que c'est le seul endroit
 * par lequel la bascule passe.
 */
export async function setAsset(slug: string): Promise<void> {
  const clean = slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(clean)) return; // slug invalide : on ignore silencieusement

  // Slug inconnu et slug interdit produisent le même résultat : rien. Un message distinct dirait
  // à un membre quelles marques existent sans qu'il y ait accès.
  if (!(await slugAutorise(clean))) return;

  const jar = await cookies();
  jar.set(ASSET_COOKIE, clean, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  revalidatePath("/", "layout");
}
