import { NextResponse } from "next/server";
import { getCurrentAsset, type CurrentAsset } from "@/lib/asset-context";
import { canEditTemplate, getSessionUser, type SessionUser } from "@/lib/session";
import { getDb } from "@/lib/supabase";

/**
 * Socle commun des routes `app/api/builder/**`.
 *
 * Deux invariants y sont centralisés une seule fois, pour qu'aucune route ne puisse les oublier :
 *  1. Toute route renvoie du JSON — jamais de redirection (le proxy renvoie déjà 401 JSON sur /api).
 *  2. Toute lecture/écriture est scopée sur la MARQUE COURANTE. Un template d'une autre marque doit
 *     être indiscernable d'un template inexistant → 404, jamais 403 (pas d'oracle d'existence).
 */

export type BuilderDb = NonNullable<ReturnType<typeof getDb>>;

/** Marque courante garantie résolue en base (`id` non-null). */
export type ScopedAsset = CurrentAsset & { id: string };

export const jsonError = (error: string, status: number, extra?: Record<string, unknown>) =>
  NextResponse.json({ error, ...(extra ?? {}) }, { status });

/** Corps JSON, ou `null` si absent/illisible — jamais d'exception qui deviendrait un 500. */
export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export type Context = { db: BuilderDb; asset: ScopedAsset; user: SessionUser };

/**
 * Contexte d'exécution d'une route builder.
 *
 * Le mode dégradé (base injoignable) renvoie **503** et non une liste vide : le builder écrit en
 * base, un faux « rien à afficher » ferait croire à une perte de données. On préfère l'erreur nette.
 *
 * ⚠️ Depuis le 31/08/2026 cette fonction REFUSE. Elle ne testait auparavant que la base et la
 * marque : 40 des 43 routes s'appuyaient sur elle sans qu'aucune ne vérifie une identité, et le
 * seul garde était le proxy. Un proxy qui laisse passer — parce qu'un chemin échappe à son
 * matcher, parce qu'une route est appelée depuis le serveur — n'était rattrapé par rien.
 */
export async function requireContext(): Promise<{ ok: true; ctx: Context } | { ok: false; res: NextResponse }> {
  const db = getDb();
  if (!db) return { ok: false, res: jsonError("database unavailable", 503) };

  const user = await getSessionUser();
  if (!user) return { ok: false, res: jsonError("unauthenticated", 401) };

  const asset = await getCurrentAsset();
  if (!asset.id) {
    // Un compte sans aucune marque n'est pas une panne : c'est un état légitime qui doit nommer
    // sa sortie, sinon la personne voit un écran vide sans savoir quoi faire.
    if (asset.indisponible === "aucune-marque") {
      return { ok: false, res: jsonError("no brand access — ask an administrator", 403) };
    }
    return { ok: false, res: jsonError("brand context unavailable", 503) };
  }

  return { ok: true, ctx: { db, asset: { ...asset, id: asset.id }, user } };
}

/** Routes réservées aux administrateurs. Refus explicite : le chemin lui-même n'est pas un secret. */
export async function requireSuperAdmin(): Promise<
  { ok: true; ctx: Context } | { ok: false; res: NextResponse }
> {
  const base = await requireContext();
  if (!base.ok) return base;
  if (!base.ctx.user.isSuperAdmin) return { ok: false, res: jsonError("forbidden", 403) };
  return base;
}

/**
 * Ce template est-il ouvrable par la personne connectée ?
 *
 * ⛔ Rend **404**, jamais 403 : c'est l'invariant du projet, et il vaut aussi entre personnes
 * d'une même marque. Un 403 dirait « ce template existe, mais pas pour vous » — un oracle
 * d'existence que la réponse 404 refuse de donner.
 */
export async function requireTemplateAccess(
  ctx: Context,
  templateId: string,
): Promise<NextResponse | null> {
  if (await canEditTemplate(ctx.user, templateId)) return null;
  return jsonError("not found", 404);
}

/** Aplatit des issues Zod en messages lisibles (`rows.0.columns.1.blocks.0.alt: …`). */
export function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

/** Validation d'adresse volontairement simple : filtrer les fautes de frappe, pas réimplémenter la RFC. */
export const isEmail = (v: string): boolean => v.length <= 254 && EMAIL_RE.test(v);
