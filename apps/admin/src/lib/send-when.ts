/**
 * QUAND une campagne ponctuelle devient due — la seule lecture du corps de `/schedule`.
 *
 * Deux demandes, et deux seulement :
 *  - `scheduledAt` : une date FUTURE. Une date passée reste refusée — c'est soit une faute de
 *    frappe, soit un envoi immédiat déguisé, et aucun des deux ne doit partir par surprise ;
 *  - `sendNow: true` : l'envoi immédiat, DEMANDÉ EN TOUTES LETTRES (demande d'Alix du 22/09/2026,
 *    « un envoi instantané, pour nos tests et pour le futur »). L'heure est celle du SERVEUR, jamais
 *    celle du navigateur : une horloge client en avance de deux minutes ferait refuser une date
 *    « future » qui ne l'est plus, une horloge en retard daterait l'envoi dans le passé.
 *
 * ⛔ `sendNow` N'EST PAS UN RACCOURCI QUI SAUTE LES GARDES. Il ne décide QUE de la date : le verrou,
 * la finalité, le sujet et le compte d'audience sont exigés à l'identique par la route, et le
 * consentement est revérifié destinataire par destinataire au départ. Il n'écrit rien non plus dans
 * la file : la campagne devient due, et le worker la met en file à son prochain passage.
 *
 * ⛔ LES DEUX À LA FOIS = REFUS. Deviner laquelle des deux l'appelant voulait dire, c'est choisir
 * entre « maintenant » et « jeudi » à sa place.
 */
export type SendWhen =
  | { ok: true; when: Date; sendNow: boolean }
  | { ok: false; error: string };

export function resolveSendWhen(body: { scheduledAt?: unknown; sendNow?: unknown }, now: number): SendWhen {
  if (body.sendNow !== undefined && typeof body.sendNow !== "boolean") {
    return { ok: false, error: "sendNow must be true or false" };
  }

  if (body.sendNow === true) {
    if (body.scheduledAt !== undefined && body.scheduledAt !== null) {
      return { ok: false, error: "send either scheduledAt or sendNow, not both" };
    }
    return { ok: true, when: new Date(now), sendNow: true };
  }

  if (typeof body.scheduledAt !== "string" || body.scheduledAt.trim() === "") {
    return { ok: false, error: "scheduledAt is required (ISO 8601 date-time) — or sendNow: true to send right away" };
  }
  const when = new Date(body.scheduledAt);
  if (Number.isNaN(when.getTime())) {
    return { ok: false, error: `scheduledAt is not a valid date-time: "${body.scheduledAt}"` };
  }
  if (when.getTime() <= now) {
    return {
      ok: false,
      error:
        `scheduledAt must be in the future — ${when.toISOString()} is in the past (now ${new Date(now).toISOString()}). ` +
        "To send right away, use Send now.",
    };
  }
  return { ok: true, when, sendNow: false };
}
