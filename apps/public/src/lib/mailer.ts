import type { Db } from "@/lib/supabase";

/**
 * Mailer STUBÉ : écrit dans `newsletter.email_outbox` (status='pending') au lieu d'envoyer.
 * Le worker SES (à venir) drainera cette table. Rien ne part réellement pour l'instant —
 * on ne peut donc pas spammer par accident avant que SES + double opt-in soient validés.
 * En dev, on logue aussi le lien d'action pour tester la boucle.
 *
 * ⚠️ `automation` et `automation_tx` (0082) n'y figurent PAS, délibérément : seule la fonction SQL
 * `automation_due` écrit ces kinds, après sa trace d'idempotence. Les enfiler d'ici contournerait
 * cette trace — et donc la garantie qu'une personne ne reçoit pas deux fois la même étape.
 */
type OutboxKind = "confirmation" | "welcome" | "unsubscribe_ack";

/**
 * Met un e-mail en file. Rend `null` si la ligne est écrite, le MOTIF de l'échec sinon.
 *
 * ⛔ POURQUOI LA SIGNATURE A CHANGÉ (elle rendait `Promise<void>`). C'est l'écriture qui décide si
 * l'e-mail de confirmation partira un jour, et elle ne POUVAIT rien dire — même à un appelant qui
 * l'aurait voulu. Un refus de `email_outbox` laissait la route d'inscription rendre `200 {ok:true}` :
 * le worker n'avait rien à drainer, la personne ne recevait jamais son lien, et sa souscription
 * restait `pending` pour toujours. Un abonné perdu, déclaré acquis.
 *
 * ⚠️ Le motif est une CHAÎNE, pas un booléen : « échoué » sans le message Postgres n'aide personne
 * à trouver la contrainte fautive. C'est à l'appelant de ne pas le rendre au public.
 */
export async function queueEmail(
  db: Db,
  args: {
    assetId: string | null;
    subscriptionId: string | null;
    toEmail: string;
    kind: OutboxKind;
    subject: string;
    actionUrl?: string;
    payload?: Record<string, unknown>;
  },
): Promise<string | null> {
  const { error } = await db.from("email_outbox").insert({
    asset_id: args.assetId,
    subscription_id: args.subscriptionId,
    to_email: args.toEmail,
    kind: args.kind,
    subject: args.subject,
    action_url: args.actionUrl ?? null,
    payload: args.payload ?? {},
    status: "pending",
  });
  // Un refus sans message reste un refus : on ne le laisse pas retomber en `null`, qui voudrait
  // dire « c'est parti ».
  if (error) return (error as { message?: string }).message || "email-outbox-insert-refuse";

  if (process.env.NODE_ENV !== "production" && args.actionUrl) {
    // eslint-disable-next-line no-console
    console.log(`[mailer:stub] ${args.kind} -> ${args.toEmail} : ${args.actionUrl}`);
  }
  return null;
}
