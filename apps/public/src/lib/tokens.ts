/**
 * Ré-export du package partagé @nf/tokens (source unique, partagée avec apps/worker).
 * Historiquement défini ici ; déplacé dans packages/tokens pour éviter toute divergence
 * de signature entre le site public (qui vérifie) et le worker (qui signe les liens).
 *
 * ⛔ La garde est appelée ICI, au point de passage OBLIGÉ : toute page ou route qui signe ou
 * vérifie un token importe ce module. Elle double celle de `instrumentation.ts`, qui s'exécute au
 * chargement du runtime Node et fait répondre 500 à TOUTES les routes — mesuré : le processus
 * imprime « ✓ Ready » et reste vivant, ce n'est pas un échec de démarrage. Le doublon sert au cas
 * où un runtime chargerait ce module sans passer par l'instrumentation : mieux vaut refuser de
 * servir un lien signé avec le mauvais secret que d'en émettre un que personne ne pourra vérifier.
 */
import { assertTokenSecret } from "./token-secret";

assertTokenSecret();

export * from "@nf/tokens";
