/**
 * ÉTAT D'UN LIEN DE CONFIRMATION, au moment où le worker s'apprête à l'envoyer.
 *
 * ⛔ CE QUE CE MODULE EXISTE POUR EMPÊCHER, et c'est mesuré, pas supposé. `email_outbox.action_url`
 * est FIGÉE à la mise en file : elle porte le jeton brut, construit une fois, et plus rien ne la
 * regarde ensuite. Côté worker, la seule garde était `render.ts` : `if (!ctx.action_url) return
 * { ok: false, reason: "missing_action_url" }` — elle vérifie que le lien EXISTE, jamais qu'il
 * MÈNE QUELQUE PART. Et `apps/worker` ne nomme la table `doi_token` nulle part.
 *
 * Conséquence constatée le 15/09/2026 : quatre personnes réelles inscrites le 13/09 attendaient
 * dans la file avec un jeton de 48 h. Le worker étant en `dry-run`, l'e-mail n'a jamais été tenté
 * (`attempts = 0`). Le jour de la bascule, ces quatre e-mails seraient partis avec un lien déjà
 * mort, et la personne aurait cliqué pour lire « Enlace caducado ». C'est pire que ne rien
 * envoyer : on demande un geste à quelqu'un, puis on lui refuse le résultat de son geste.
 *
 * Fonction PURE, sans accès base : la question qu'elle tranche est une question de LOGIQUE — « ce
 * lien mène-t-il encore quelque part ? » — et une question de logique doit se tester sans base.
 */

/**
 * `valide` est le SEUL état envoyable. Les trois autres sont nommés séparément parce qu'ils ne
 * disent pas la même chose et n'appellent pas la même suite : `absent` est une anomalie de données
 * (une confirmation en file sans jeton derrière), `expire` est le passage du temps, et
 * `deja_confirme` veut dire que la personne a DÉJÀ fait le geste — lui redemander serait absurde.
 */
export type EtatLienConfirmation = "valide" | "absent" | "expire" | "deja_confirme";

export interface LigneJeton {
  expires_at: string;
  confirmed_at: string | null;
}

/**
 * ⚠️ L'ORDRE DES TESTS EST PORTEUR DE SENS, et l'inverser changerait ce qu'on raconte. « Déjà
 * confirmé » passe AVANT « expiré » : un jeton confirmé puis périmé décrit quelqu'un qui a bien
 * confirmé, pas quelqu'un qui a laissé passer le délai. Dire « expiré » de cette personne serait
 * faux, et la raison finirait écrite en base sur la ligne `skipped`.
 */
export function etatLienConfirmation(ligne: LigneJeton | null | undefined, maintenant: Date): EtatLienConfirmation {
  if (!ligne) return "absent";
  if (ligne.confirmed_at) return "deja_confirme";

  const fin = new Date(ligne.expires_at).getTime();
  // ⛔ Une échéance illisible ne vaut pas « encore valable ». Sans date de fin exploitable, on ne
  // peut rien affirmer sur la vie du lien — et le doute ne se résout pas en envoyant.
  if (!Number.isFinite(fin)) return "expire";

  return fin > maintenant.getTime() ? "valide" : "expire";
}
