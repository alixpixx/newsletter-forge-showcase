/*
 * Formatage partagé par la bibliothèque de modèles.
 * Fuseau figé sur UTC : ces helpers tournent côté serveur ET côté client (après un
 * router.refresh()), un fuseau implicite produirait une hydratation incohérente.
 */

const DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  timeZone: "UTC",
});

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : DATE.format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${DATE_TIME.format(d)} UTC`;
}

/**
 * Seuil de troncature Gmail — RÉ-EXPORTÉ, jamais recopié.
 *
 * La valeur vivait ici en dur ET dans `@nf/render/limits`. Deux vérités pour une même règle de
 * CONFORMITÉ : le jour où l'une bouge, un email passe la garde d'un côté et se fait couper de
 * l'autre — et ce qui est coupé, c'est la fin du message, donc le lien de désabonnement.
 */
export { GMAIL_CLIP_BYTES } from "@nf/render/limits";

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}
