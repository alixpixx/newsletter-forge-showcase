import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/supabase";

/**
 * LES LISTES ET LEUR DOMAINE D'ENVOI, lues par optinforge pour brancher un site TOUT SEUL.
 *
 * Demande d'Alix du 02/11/2026 : « je veux juste qu'à l'avenir ça soit automatiquement branché ».
 * Un site optinforge sans liste gardait ses inscrits pour lui (`site-not-bridged`) — Goalpost Weekly l'a fait
 * trois mois sans que personne ne le voie. Le pont cherche désormais la liste dont le domaine
 * d'envoi (`news.goalpost-weekly.example`) prolonge le domaine du site (`goalpost-weekly.example`).
 *
 * `GET` → `{ ok: true, assets: [{ slug, sending_subdomain }] }`.
 *
 * ⛔ LE RAPPROCHEMENT SE FAIT CHEZ L'APPELANT, PAS ICI. Cette route rend la donnée brute ; c'est
 * optinforge qui connaît le domaine de ses sites et qui refuse un rapprochement ambigu.
 *
 * ⛔ SERVEUR À SERVEUR SEULEMENT, avec le MÊME secret que `/api/v1/signup` (`x-nf-ingest-secret`).
 * La liste des marques n'a rien à faire chez un appelant anonyme : sans secret, c'est un 401.
 */

/** Comparaison à temps constant — même règle que `/api/v1/signup` (longueur testée avant, sans lever). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function GET(req: Request) {
  // Un secret absent de l'environnement ne doit JAMAIS ouvrir la porte.
  const expected = process.env.NF_INGEST_SECRET ?? "";
  const recu = req.headers.get("x-nf-ingest-secret");
  if (!expected || recu === null || !safeEqual(recu, expected)) {
    return NextResponse.json({ error: "ingest-refuse" }, { status: 401 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: "service-indisponible" }, { status: 503 });

  const { data, error } = await db.from("asset").select("slug, sending_subdomain").order("slug");
  if (error) {
    // Le message Postgres brut reste dans le journal : il nomme des tables, il ne sort pas.
    console.error(JSON.stringify({ event: "assets-db-refused", code: error.code ?? null, message: error.message ?? "" }));
    return NextResponse.json({ error: "db" }, { status: 500 });
  }
  const assets = ((data ?? []) as { slug: string; sending_subdomain: string | null }[]).map((a) => ({
    slug: a.slug,
    sending_subdomain: a.sending_subdomain ?? null,
  }));
  return NextResponse.json({ ok: true, assets });
}
