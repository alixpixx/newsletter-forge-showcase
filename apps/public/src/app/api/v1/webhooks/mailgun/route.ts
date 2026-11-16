import { NextResponse } from "next/server";
import { getDb } from "@/lib/supabase";
import { handleMailgunWebhook } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — retours d'envoi Mailgun, signés. Le contrat (fail-closed sans clé, 406 sur signature
 * invalide, suppression rejouée sur un doublon) est dans `handler.ts`.
 */
export async function POST(req: Request) {
  return handleMailgunWebhook(req, {
    signingKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY,
    getDb,
    now: () => Date.now() / 1000,
  });
}

/** ⛔ 405 VOULU : un webhook ne se consulte pas, et un GET public sur cette URI n'a aucun sens. */
export async function GET() {
  return NextResponse.json({ error: "method not allowed — this endpoint only accepts signed POSTs" }, { status: 405 });
}
