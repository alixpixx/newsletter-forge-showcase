import { NextResponse } from "next/server";
import { requireContext } from "@/app/api/builder/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/occurrences/preview — « vos N prochains envois », calculés PAR LE SERVEUR.
 *
 * ⛔ POURQUOI CE N'EST PAS CALCULÉ DANS LE NAVIGATEUR. Il serait facile d'écrire cette arithmétique
 * en TypeScript : quelques lignes avec `Intl`. Le résultat serait juste onze mois sur douze et faux
 * les jours de changement d'heure — parce que Node, le navigateur et Postgres n'embarquent pas la
 * même version de tzdata. Une newsletter qui promet 10:00 à l'écran et part à 09:00 le dimanche du
 * passage à l'heure d'hiver, ce n'est pas un défaut qu'on trouve en test : on l'apprend par un
 * abonné. L'écran et le matérialiseur appellent donc la MÊME fonction SQL (`0025`), donc la même
 * tzdata, donc la même vérité.
 *
 * ⚠️ AUCUNE ÉCRITURE. Cette route ne crée pas d'occurrence : elle montre ce qui SERAIT créé. Le
 * matérialiseur (S-4) est le seul à écrire, et il n'existe pas encore.
 */

interface PreviewBody {
  days?: unknown;
  time?: unknown;
  timezone?: unknown;
  everyWeeks?: unknown;
  anchor?: unknown;
  until?: unknown;
  limit?: unknown;
}

interface OccurrenceRow {
  local_date: string;
  fires_at: string;
  local_text: string;
  utc_offset: string;
}

/** Jours ISO : 1 = lundi … 7 = dimanche. La convention `dow` (0 = dimanche) est refusée. */
function isoDays(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<number>();
  for (const raw of v) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 7) out.add(n);
  }
  return [...out].sort();
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: Request) {
  // Même garde que le reste de l'admin : contexte de marque résolu, base disponible. Cette route
  // ne lit aucune donnée d'abonné, mais une route sans garde dans un back-office finit toujours
  // par en lire une.
  const c = await requireContext();
  if (!c.ok) return c.res;
  const { db } = c.ctx;

  let body: PreviewBody;
  try {
    body = (await req.json()) as PreviewBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const days = isoDays(body.days);
  if (days.length === 0) {
    return NextResponse.json({ error: "pick at least one day of the week" }, { status: 400 });
  }

  const time = typeof body.time === "string" ? body.time.slice(0, 5) : "";
  if (!TIME_RE.test(time)) {
    return NextResponse.json({ error: "`time` must be HH:MM in 24-hour form" }, { status: 400 });
  }

  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
  if (!timezone) return NextResponse.json({ error: "`timezone` is required" }, { status: 400 });
  // Un fuseau inconnu ferait échouer la fonction SQL avec un message Postgres brut. On le
  // reconnaît ici, où l'on sait encore quoi en dire.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return NextResponse.json({ error: `unknown time zone "${timezone}"` }, { status: 400 });
  }

  const everyWeeks = Math.min(8, Math.max(1, Math.trunc(Number(body.everyWeeks ?? 1)) || 1));
  const limit = Math.min(60, Math.max(1, Math.trunc(Number(body.limit ?? 5)) || 5));

  const today = new Date();
  const anchor =
    typeof body.anchor === "string" && DATE_RE.test(body.anchor)
      ? body.anchor
      : today.toISOString().slice(0, 10);

  // Fenêtre de recherche. On part de MAINTENANT : un aperçu qui montrerait des envois passés
  // ferait croire que la série a déjà tourné.
  const from = today.toISOString();
  const to = new Date(today.getTime() + 400 * 24 * 3_600_000).toISOString();
  // Une fin de série écourte la fenêtre. `+1 jour` pour inclure le dernier jour en entier, quel
  // que soit le fuseau : borner à minuit UTC couperait la dernière occurrence en Amérique.
  const until =
    typeof body.until === "string" && DATE_RE.test(body.until)
      ? new Date(`${body.until}T00:00:00Z`).getTime() + 24 * 3_600_000
      : null;

  const { data, error } = await db.rpc("campaign_occurrences", {
    p_days: days,
    p_time: time,
    p_timezone: timezone,
    p_every_weeks: everyWeeks,
    p_anchor: anchor,
    p_from: from,
    p_to: until !== null ? new Date(Math.min(until, new Date(to).getTime())).toISOString() : to,
    p_limit: limit,
  });

  if (error) {
    // La fonction n'existe pas encore (migration 0025 non appliquée) : on le DIT. Renvoyer une
    // liste vide ferait lire « cette cadence ne produit aucun envoi », ce qui est faux et enverrait
    // l'opérateur chercher une erreur dans sa saisie.
    const missing = /could not find the function|does not exist|schema cache/i.test(error.message);
    return NextResponse.json(
      {
        error: missing
          ? "the scheduling function is not installed yet — migration 0025 has not been applied"
          : error.message,
        migrationMissing: missing,
      },
      { status: missing ? 503 : 500 },
    );
  }

  const rows = ((data as unknown[]) ?? []) as OccurrenceRow[];

  return NextResponse.json({
    occurrences: rows.map((r) => ({
      localDate: r.local_date,
      firesAt: r.fires_at,
      /** « 2026-09-07 10:00 -03:00 » — l'heure LOCALE avec le décalage appliqué CE jour-là. */
      localText: r.local_text,
      utcOffset: r.utc_offset,
    })),
    /**
     * Vrai quand le décalage n'est pas le même pour toutes les occurrences affichées : il y a un
     * changement d'heure dans la fenêtre. L'écran le signale, parce que c'est précisément le
     * moment où l'opérateur doute de ce qu'il lit.
     */
    crossesDstChange: new Set(rows.map((r) => r.utc_offset)).size > 1,
  });
}
