import { NextResponse } from "next/server";
import { jsonError, readJson, type requireContext } from "@/app/api/builder/_shared";
import { listSegmentMembers, MEMBERS_SEARCH_MAX_LENGTH } from "@/lib/data/segment-members";

/**
 * POST /api/segments/[id]/members — les abonnés d'un segment enregistré, page par page, avec
 * recherche d'adresse.
 *
 * ⚠️ POST et non GET, comme l'export : la recherche est une adresse e-mail (une PII). Dans une URL,
 * elle finirait dans les journaux d'accès et l'historique du navigateur.
 *
 * Module séparé de `route.ts` (qui ne peut exporter que ses méthodes HTTP) : la session est injectée,
 * pour qu'un banc mesure la route sans cookie ni base.
 */

export interface MembersDeps {
  requireContext: () => ReturnType<typeof requireContext>;
}

type Entree = { ok: true; q: string; page: number } | { ok: false; error: string };

/** Validation de la charge utile. Un champ au mauvais type se REFUSE : on ne le devine pas. */
export function parseMembersInput(body: unknown): Entree {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid JSON body" };
  const b = body as { q?: unknown; page?: unknown };

  let q = "";
  if (b.q !== undefined && b.q !== null) {
    if (typeof b.q !== "string") return { ok: false, error: "q must be a string" };
    if (b.q.length > MEMBERS_SEARCH_MAX_LENGTH) {
      return { ok: false, error: `q must be ${MEMBERS_SEARCH_MAX_LENGTH} characters or less` };
    }
    q = b.q;
  }

  let page = 1;
  if (b.page !== undefined && b.page !== null) {
    // ⛔ Pas de conversion : « 2 » en texte, 1.5 ou 0 viennent d'un appelant qui se trompe.
    if (typeof b.page !== "number" || !Number.isSafeInteger(b.page) || b.page < 1) {
      return { ok: false, error: "page must be a whole number of 1 or more" };
    }
    page = b.page;
  }

  return { ok: true, q, page };
}

export async function postSegmentMembers(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: MembersDeps,
) {
  const c = await deps.requireContext();
  if (!c.ok) return c.res;
  const { db, asset } = c.ctx;

  const { id } = await params;
  const entree = parseMembersInput(await readJson<unknown>(req));
  if (!entree.ok) return jsonError(entree.error, 400);

  const r = await listSegmentMembers(db, asset.id, id, { q: entree.q, page: entree.page });
  if (r.ok) return NextResponse.json(r);

  switch (r.reason) {
    case "not-found":
      return jsonError("segment not found", 404);
    case "unreadable-rule":
      return jsonError(
        "This segment's rule can't be read, so nobody is listed. Open it in the builder and save it again.",
        409,
        { reason: r.reason },
      );
    case "targeting-incomplete":
      // ⛔ 409 et pas 200 vide : « personne » serait un mensonge, la population réelle est PLUS
      // LARGE que la règle — c'est justement pour ça qu'on ne la montre pas.
      return jsonError(
        "Some conditions of this segment can't be applied right now, so the list would be wider than the rule. Nobody is listed.",
        409,
        { reason: r.reason, unsupported: r.unsupported ?? [] },
      );
    case "lookup-failed":
      return jsonError("The member list could not be read from the database. Try again in a moment.", 503, {
        reason: r.reason,
      });
  }
}
