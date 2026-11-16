/**
 * Limites de rendu — AUCUNE dépendance, volontairement.
 *
 * Ces constantes vivaient dans `schema.ts`, qui importe Zod. Le worker et `shell-checks` ne peuvent
 * pas tirer Zod : leur promesse est « zéro dépendance ». Les recopier là-bas aurait créé deux
 * valeurs de vérité pour un seuil de CONFORMITÉ — le jour où l'une bouge sans l'autre, un email
 * passe la garde d'un côté et se fait tronquer de l'autre.
 *
 * `schema.ts` les ré-exporte : tous les appelants existants continuent d'écrire
 * `import { GMAIL_CLIP_BYTES } from "@nf/render/schema"` sans rien changer.
 */

/**
 * Seuil de troncature Gmail.
 *
 * ⚠️ CE N'EST PAS UN SEUIL ESTHÉTIQUE. Au-delà, Gmail coupe la FIN du message — c'est-à-dire le
 * footer légal, donc le lien de désabonnement. Un email tronqué est un email non conforme (LGPD
 * art. 18, GDPR art. 21, CAN-SPAM §316.5), et une série récurrente répète l'infraction à chaque
 * occurrence.
 */
export const GMAIL_CLIP_BYTES = 102_400;

/** Longueur maximale d'un label de bouton (au-delà, il passe à la ligne sous Outlook). */
export const MAX_BUTTON_LABEL = 28;
