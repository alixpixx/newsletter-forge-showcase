/**
 * Ce que l'envoi de test DIT à la personne qui l'a demandé — au clic, puis une fois le worker passé.
 *
 * ⛔ LE DÉFAUT MESURÉ (24/09/2026). Deux tests Copper Kettle vers une adresse de l'équipe sont partis
 * « Queued » à l'écran, puis le worker les a écartés (`skipped`, `suppressed`) : l'adresse avait été
 * EFFACÉE (RGPD) le 19/09 lors d'un essai. Personne n'a rien vu, et « l'envoi de test ne fonctionne
 * pas ». La règle du worker est juste (un test est un VRAI e-mail : une adresse de la liste
 * d'exclusion ne reçoit rien, `gate.ts`) ; ce qui manquait, c'est de le DIRE.
 *
 * D'où deux paroles : `refusAvantFile` au clic (la liste d'exclusion se lit avant de mettre en file),
 * et `etatDuTest` ensuite, pour tout ce que le worker décide et que l'admin ne peut pas prévoir.
 */

export type Exclusion = { suppressed: boolean; hard: boolean };

/** `null` = rien ne s'oppose ; sinon la phrase à afficher, avec la sortie possible. */
export function refusAvantFile(e: Exclusion): string | null {
  if (!e.suppressed) return null;
  return e.hard
    ? "This address is on the do-not-send list (it bounced or reported spam): it receives nothing, not even a test. Use another address."
    : "This address is on the do-not-send list because it was erased or unsubscribed from every brand: it receives nothing, not even a test. It can receive tests again once it subscribes to a newsletter and confirms — or use another address.";
}

type Rpc = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * Lit la liste d'exclusion pour CETTE marque (`is_suppressed`, et `is_hard_suppressed` pour dire
 * laquelle). ⛔ Illisible ⇒ refus 503 : mettre en file un test dont on ne sait pas s'il partira
 * referait le « Queued » muet.
 */
export async function verifierExclusion(
  db: Rpc,
  to: string,
  assetId: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const [exclue, dure] = await Promise.all([
    db.rpc("is_suppressed", { p_email: to, p_asset_id: assetId }),
    db.rpc("is_hard_suppressed", { p_email: to, p_asset_id: assetId }),
  ]);
  if (exclue.error || dure.error) {
    return { ok: false, status: 503, message: "the do-not-send list could not be read — no test was sent" };
  }
  const refus = refusAvantFile({ suppressed: exclue.data === true, hard: dure.data === true });
  return refus ? { ok: false, status: 409, message: refus } : { ok: true };
}

export type EtatTest = { etat: "pending" | "sent" | "not_sent" | "failed"; message: string };

export type LigneTest = { status: string; error: string | null; sent_at: string | null };

/** Les motifs d'écart du worker (`process.ts`, `gate.ts`), dits pour quelqu'un qui n'a pas lu le code. */
function motif(raison: string): string {
  if (raison === "suppressed") return "the address is on the do-not-send list";
  if (raison === "not_allowlisted") return "the address is not on the worker's sending allowlist";
  if (raison === "no_sending_domain") return "this brand has no sending domain configured";
  if (raison === "missing_context") return "the email could not be prepared (its brand or template could not be read)";
  if (raison.startsWith("footer_incomplete:")) {
    return `the legal footer is incomplete (${raison.slice("footer_incomplete:".length).split(",").join(", ")})`;
  }
  // ⚠️ Un motif inconnu est montré TEL QUEL : le taire referait exactement le défaut ci-dessus.
  return raison;
}

export function etatDuTest(l: LigneTest): EtatTest {
  if (l.status === "pending" || l.status === "sending") {
    return { etat: "pending", message: "Queued — waiting for the worker, which passes every few seconds." };
  }
  if (l.status === "sent") {
    const heure = l.sent_at ? ` at ${new Date(l.sent_at).toISOString().slice(11, 16)} UTC` : "";
    return { etat: "sent", message: `Handed to the mail provider${heure}. If it is not in the inbox, check the spam folder.` };
  }
  if (l.status === "skipped") {
    return { etat: "not_sent", message: `Not sent: ${motif(l.error ?? "no reason recorded")}.` };
  }
  if (l.status === "failed") {
    return { etat: "failed", message: `The mail provider refused it: ${l.error ?? "no reason recorded"}.` };
  }
  return { etat: "failed", message: `Unexpected state "${l.status}"${l.error ? `: ${l.error}` : ""}.` };
}
