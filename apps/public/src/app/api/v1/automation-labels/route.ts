import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/supabase";
import { MAX_LABEL_NAME, readLabel } from "@/lib/automation-label";

/**
 * L'ENREGISTREMENT D'UN LABEL D'AUTOMATION (0095), appelé par optinforge dès qu'un label est tapé
 * dans l'onglet Where d'une créative — AVANT la première inscription. Sans lui, l'automation ne
 * pourrait viser le label qu'une fois qu'un inscrit l'aurait apporté.
 *
 * `POST { asset: <slug de marque>, name: <nom du label> }` → `{ ok, slug, name, created }`.
 * Rejouable : le même nom rend le même slug, et une ligne existante n'est que renommée.
 *
 * ⛔ SERVEUR À SERVEUR SEULEMENT, avec le MÊME secret que `/api/v1/signup` (`x-nf-ingest-secret`).
 * Contrairement au formulaire public, aucun appelant anonyme n'a rien à faire ici : sans secret,
 * c'est un 401, jamais le 200 muet réservé aux robots.
 */

/** Comparaison à temps constant — même règle que `/api/v1/signup` (longueur testée avant, sans lever). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function POST(req: Request) {
  // Un secret absent de l'environnement ne doit JAMAIS ouvrir la porte.
  const expected = process.env.NF_INGEST_SECRET ?? "";
  const recu = req.headers.get("x-nf-ingest-secret");
  if (!expected || recu === null || !safeEqual(recu, expected)) {
    return NextResponse.json({ error: "ingest-refuse" }, { status: 401 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: "service-indisponible" }, { status: 503 });

  let body: { asset?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "json-invalide" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) return NextResponse.json({ error: "json-invalide" }, { status: 400 });

  const assetSlug = typeof body.asset === "string" ? body.asset.trim() : "";
  if (!assetSlug) return NextResponse.json({ error: "marque-requise", field: "asset" }, { status: 422 });
  const label = readLabel(body.name);
  if (!label) {
    return NextResponse.json(
      { error: "label-invalide", field: "name", expected: `1-${MAX_LABEL_NAME} characters, at least one letter or digit` },
      { status: 422 },
    );
  }

  const { data: asset, error: errAsset } = await db.from("asset").select("id").eq("slug", assetSlug).maybeSingle();
  if (errAsset) return refus("asset-read", errAsset);
  if (!asset) return NextResponse.json({ error: "marque-inconnue" }, { status: 404 });
  const assetId = (asset as { id: string }).id;

  const relire = () =>
    db.from("automation_label").select("id, name").eq("asset_id", assetId).eq("slug", label.slug).maybeSingle();

  const { data: deja, error: errLecture } = await relire();
  if (errLecture) return refus("label-read", errLecture);
  if (deja) {
    // Même slug, autre graphie (« Libertadores 2026 » puis « libertadores-2026 ») : le dernier nom
    // tapé est celui qu'on affiche. Le slug, lui, ne bouge pas — c'est lui que visent les automations.
    if ((deja as { name: string }).name !== label.name) {
      const { error } = await db
        .from("automation_label")
        .update({ name: label.name, updated_at: new Date().toISOString() })
        .eq("id", (deja as { id: string }).id);
      if (error) return refus("label-rename", error);
    }
    return NextResponse.json({ ok: true, slug: label.slug, name: label.name, created: false });
  }

  const { error: errInsert } = await db
    .from("automation_label")
    .insert({ asset_id: assetId, slug: label.slug, name: label.name, source: "optinforge" });
  if (errInsert) {
    // Deux enregistrements simultanés du même label : l'unique (asset_id, slug) arbitre, et le
    // perdant relit la ligne du gagnant plutôt que d'échouer.
    if ((errInsert as { code?: string }).code === "23505") {
      const { data: gagnant } = await relire();
      if (gagnant) return NextResponse.json({ ok: true, slug: label.slug, name: label.name, created: false });
    }
    return refus("label-insert", errInsert);
  }
  return NextResponse.json({ ok: true, slug: label.slug, name: label.name, created: true });
}

/** Le message Postgres brut reste dans le journal : il nomme des tables, il ne sort pas. */
function refus(op: string, error: { message?: string; code?: string }) {
  console.error(JSON.stringify({ event: "automation-label-db-refused", op, code: error.code ?? null, message: error.message ?? "" }));
  return NextResponse.json({ error: "db" }, { status: 500 });
}
