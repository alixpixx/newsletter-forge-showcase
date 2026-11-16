import type { Db } from "@/lib/supabase";
import { queueEmail } from "@/lib/mailer";
import { emailCoupe } from "@/lib/cycle-de-vie-coupe";
import { dict, normalizeLocale } from "@/lib/i18n";

/**
 * L'ACCUSÉ DE DÉSINSCRIPTION (22/09/2026 — Alix : « fais en sorte qu'il marche quand quelqu'un se
 * unsubscribe »). Jusqu'à ce jour, RIEN ne le mettait en file : le worker savait le rendre, l'admin
 * affichait « Not sent today: nothing triggers this email yet. »
 *
 * ⛔ LES RÈGLES D'ALIX, ET ELLES DÉCIDENT QUI APPELLE CE MODULE :
 *  - UN accusé par désinscription HUMAINE qui CHANGE quelque chose, sur NOS pages : le bouton de
 *    `/unsubscribe` (`api/v1/unsubscribe/confirm`) et le centre de préférences (interrupteur
 *    « Newsletter », « Unsubscribe from all brands »).
 *  - JAMAIS après le one-click RFC 8058 : Gmail et Yahoo confirment déjà dans leur interface, et un
 *    e-mail de plus en réponse à un geste fait DANS la messagerie est ce qu'un filtre anti-spam note.
 *  - Jamais sur un second clic, jamais après un effacement, jamais depuis le webhook Mailgun ni le
 *    sunset. Jamais à une adresse en suppression dure — c'est le gate du worker qui le garantit, au
 *    moment de partir (`apps/worker/src/gate.ts`).
 *  - Aucun suivi, aucun contenu marketing : `unsubscribe_ack` n'a ni pixel ni finalité.
 *
 * ⛔ « QUI CHANGE QUELQUE CHOSE » SE DÉCIDE DANS L'ÉCRITURE, PAS ICI. Chaque appelant n'appelle ce
 * module que si SA mise à jour conditionnelle (`.neq('status','unsubscribed')` … `.select('id')`) a
 * rendu une ligne : deux clics croisés ne peuvent pas gagner tous les deux, donc pas deux accusés.
 *
 * ⛔ UN ÉCHEC NE CHANGE JAMAIS LA RÉPONSE (même doctrine que le bienvenue de `confirm/page.tsx`). La
 * désinscription a EU LIEU : répondre une erreur ferait croire à la personne qu'elle est toujours
 * abonnée, et elle recliquerait — sur une ligne déjà `unsubscribed`, donc sans accusé. Mais l'échec
 * ne passe pas en silence : un accusé qui cesse d'être enfilé est invisible autrement. Et cette
 * fonction ne LÈVE jamais, même si la base lève : un appelant n'a rien à entourer.
 */
export async function mettreEnFileAccuse(
  db: Db,
  a: {
    subscriptionId: string;
    assetId: string | null;
    email: string | null | undefined;
    /** Nom de la marque, pour l'objet. */
    marque: string | null | undefined;
    /**
     * Langue de la SOUSCRIPTION d'abord (même règle que le bienvenue : un e-mail ne change pas de
     * langue parce qu'on a bricolé une query string), le `?lang` de la page en repli.
     */
    langue: string | null | undefined;
    /** D'où vient le geste — pour le journal seulement. */
    origine: string;
  },
): Promise<boolean> {
  const journaliser = (raison: string) =>
    console.error(
      JSON.stringify({
        event: "unsubscribe-ack-queue-failed",
        subscription_id: a.subscriptionId,
        origine: a.origine,
        // ⛔ Jamais l'adresse : ce journal part chez l'hébergeur.
        reason: raison,
      }),
    );

  if (!a.email) {
    journaliser("adresse-introuvable");
    return false;
  }
  // ⚠️ Coupé pour cette marque (Automations › Unsubscribe receipt, 0086) : la désinscription a eu lieu,
  // seul l'accusé ne part pas. Un choix, pas un échec : journal d'info, pas d'erreur.
  if (await emailCoupe(db, a.assetId, "unsubscribe_ack")) {
    console.info(JSON.stringify({ event: "unsubscribe-ack-off", subscription_id: a.subscriptionId, origine: a.origine }));
    return false;
  }
  try {
    const motif = await queueEmail(db, {
      assetId: a.assetId,
      subscriptionId: a.subscriptionId,
      toEmail: a.email,
      kind: "unsubscribe_ack",
      subject: dict(normalizeLocale(a.langue)).m.unsubAckSubject(a.marque || "Newsletter"),
    });
    if (motif) {
      journaliser(motif);
      return false;
    }
    return true;
  } catch (e) {
    journaliser(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * « Unsubscribe from all brands » : UN accusé au total, jamais un par marque.
 *
 * ⛔ UN PAR MARQUE SERAIT UNE RAFALE. Quelqu'un abonné à cinq titres qui dit « arrêtez tout »
 * recevrait cinq e-mails dans la minute — exactement le contraire de ce qu'il vient de demander.
 *
 * Laquelle : celle que l'appelant désigne si elle fait partie des souscriptions réellement
 * désinscrites par ce geste ; sinon la plus récente d'entre elles ; aucune si rien n'a changé
 * (tout était déjà désinscrit : un second clic ne ré-accuse rien).
 *
 * ⚠️ Aujourd'hui le centre de préférences n'est rattaché à aucune marque et n'en désigne pas : c'est
 * la plus récente qui sert. La préférence est acceptée pour le jour où l'écran en portera une.
 */
export function choisirAccuseGlobal<T extends { asset_id?: unknown; created_at?: unknown }>(
  desinscrites: readonly T[],
  assetIdPrefere?: string | null,
): T | null {
  if (desinscrites.length === 0) return null;
  const designee = assetIdPrefere ? desinscrites.find((s) => s.asset_id === assetIdPrefere) : undefined;
  if (designee) return designee;
  // Une date illisible ne gagne jamais : elle ne peut pas prouver qu'elle est la plus récente.
  const date = (s: T) => {
    const t = typeof s.created_at === "string" ? new Date(s.created_at).getTime() : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  };
  return desinscrites.reduce((plusRecente, s) => (date(s) > date(plusRecente) ? s : plusRecente));
}
