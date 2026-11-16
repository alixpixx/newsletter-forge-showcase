import type { LifecycleKind } from "@nf/render/lifecycle-checks";

/*
 * Les mots par lesquels l'interface nomme les quatre e-mails de cycle de vie — propriétaire UNIQUE.
 *
 * ⛔ POURQUOI CE FICHIER, ET PAS UN `export` DANS `lifecycle-binding.tsx`. Ce dernier porte
 * la directive client : un Server Component qui importerait sa constante n'en recevrait qu'une
 * RÉFÉRENCE client, et `LIFECYCLE_LABELS[kind].titre` lèverait à l'exécution — le typecheck, lui, ne
 * voit rien.
 * Même partage que `categories.ts` : un module simple, lu par la fiche (client) et par la liste
 * (serveur), pour que deux écrans ne puissent pas donner deux noms au même e-mail.
 */

/*
 * ⛔ `pasEnvoye` DIT CE QUI NE PART PAS (mesuré le 16/09). Le réengagement de cycle de vie ne part PLUS
 * JAMAIS depuis le 24/09/2026 : la tâche `lifecycle` du worker n'enfile plus, la relance des inactifs
 * est l'automation « Re-engagement » du moteur, avec ses propres modèles par étape. L'écran ne propose
 * plus ce rattachement ; un rattachement ancien reste visible avec cette phrase, pour être détaché.
 *
 * ⭐ L'ACCUSÉ DE DÉSABONNEMENT N'EN A PLUS (22/09/2026) : `apps/public` le met en file quand quelqu'un
 * se désinscrit sur NOS pages — le bouton de `/unsubscribe` et le centre de préférences — et
 * seulement si le geste a changé quelque chose. Jamais après le one-click de Gmail/Yahoo (leur
 * interface confirme déjà), ni après un effacement (`apps/public/src/lib/accuse-desabonnement.ts`).
 */
export const LIFECYCLE_LABELS: Record<LifecycleKind, { titre: string; quand: string; pasEnvoye?: string }> = {
  confirmation: { titre: "Confirmation", quand: "sent when someone signs up, to confirm their address" },
  welcome: { titre: "Welcome", quand: "sent once the address is confirmed" },
  unsubscribe_ack: {
    titre: "Unsubscribe receipt",
    quand: "sent after someone unsubscribes on our pages",
  },
  reengagement: {
    titre: "Re-engagement",
    quand: "for readers who stopped opening, before we stop writing",
    pasEnvoye: "Never sent: re-engagement is now an automation (Automations › Re-engagement) with its own email steps.",
  },
};

/** Libellé court. Un kind inconnu (base plus récente que l'UI) est affiché tel quel, jamais masqué. */
export function lifecycleLabel(kind: string): string {
  return LIFECYCLE_LABELS[kind as LifecycleKind]?.titre ?? kind;
}
