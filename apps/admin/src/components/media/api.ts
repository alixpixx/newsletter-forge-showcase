/**
 * CLIENT de `/api/builder/media` — un seul endroit où le contrat réseau de la médiathèque est écrit.
 *
 * Les constantes sont dupliquées côté client À DESSEIN : elles servent à refuser un fichier trop
 * gros AVANT de le pousser sur le réseau. Le serveur revérifie tout (taille ET octets d'en-tête) —
 * ce fichier est une commodité d'interface, jamais un contrôle de sécurité.
 */

/**
 * 4 Mo, et pas 5 : Vercel plafonne le corps d'une requete serverless a ~4,5 Mo. Un fichier au-dessus
 * est coupe par la PLATEFORME avant d'atteindre notre code, donc l'utilisateur voit une erreur
 * generique au lieu de notre 413 explicite. On annonce donc une limite qu'on sait tenir.
 * (Passer cette barre demanderait un televersement direct vers Storage par URL signee.)
 */
export const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
export const MAX_MEDIA_MB = 4;
export const ACCEPTED_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const ACCEPT_ATTR = ACCEPTED_MEDIA_TYPES.join(",");

export type MediaSource = "upload" | "ai" | "import";
/** `all` = pas de filtre serveur (l'onglet par défaut). */
export type MediaFilter = "all" | MediaSource;

export interface MediaItem {
  id: string;
  url: string;
  alt: string;
  mime: string;
  bytes: number;
  source: MediaSource;
  createdAt: string;
}

export interface MediaPage {
  items: MediaItem[];
  hasMore: boolean;
}

export interface MediaUpload {
  item: MediaItem;
  /** true = ces octets existaient déjà, on renvoie l'entrée en place (pas de doublon créé). */
  deduplicated: boolean;
}

export const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

async function messageOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Request failed (${res.status})`;
}

export async function fetchMedia(
  params: { q: string; source: MediaFilter; offset: number; limit: number },
  signal?: AbortSignal,
): Promise<MediaPage> {
  const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
  const q = params.q.trim();
  if (q) qs.set("q", q);
  if (params.source !== "all") qs.set("source", params.source);

  const res = await fetch(`/api/builder/media?${qs.toString()}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(await messageOf(res));
  return (await res.json()) as MediaPage;
}

export async function uploadMedia(file: File, alt: string): Promise<MediaUpload> {
  const fd = new FormData();
  fd.append("file", file);
  if (alt) fd.append("alt", alt);

  let res: Response;
  try {
    // 5 Mo sur une connexion médiocre peut prendre un moment : budget large, mais borné.
    res = await fetch("/api/builder/media", { method: "POST", body: fd, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new Error("The upload was aborted after 120 s.");
    throw new Error(err instanceof Error ? err.message : "Network error during upload.");
  }

  if (!res.ok) throw new Error(await messageOf(res));
  return (await res.json()) as MediaUpload;
}

/**
 * Réécrit l'`alt` STOCKÉ (le défaut proposé aux prochaines insertions).
 *
 * ⚠️ À ne pas confondre avec l'alt saisi au moment d'insérer : celui-là appartient à l'USAGE et
 * vit dans le bloc image. Cet appel-ci change la bibliothèque, donc toutes les insertions à venir.
 */
export async function patchMediaAlt(id: string, alt: string): Promise<MediaItem> {
  const res = await fetch(`/api/builder/media/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ alt }),
  });
  if (!res.ok) throw new Error(await messageOf(res));
  return ((await res.json()) as { item: MediaItem }).item;
}

/** Retire l'image de la bibliothèque. Le fichier reste hébergé (emails déjà envoyés). */
export async function deleteMedia(id: string): Promise<void> {
  const res = await fetch(`/api/builder/media/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await messageOf(res));
}
