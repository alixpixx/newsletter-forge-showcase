/**
 * Le client Claude a DÉMÉNAGÉ dans `packages/ai` (`@nf/ai`).
 *
 * ⛔ POURQUOI CE FICHIER SUBSISTE. Le worker doit appeler le même client pour générer
 * l'introduction d'une édition au gel, et un import qui remonte hors du dossier déployé casse en
 * production. Le code est donc parti dans un package du workspace.
 *
 * Ce ré-export garde les quatre consommateurs de l'admin (`compose`, `direction`, `images`, `log`)
 * inchangés : déplacer un client d'API et réécrire quatre appelants dans le même geste, c'est
 * mélanger un déménagement et une modification — si quelque chose casse, on ne sait plus lequel des
 * deux en est la cause.
 */
export {
  CLAUDE_MODEL,
  ClaudeError,
  callClaude,
  parseJsonLoose,
  estimateCostCents,
  EMPTY_USAGE,
  type ClaudeErrorKind,
  type ClaudeUsage,
  type Effort,
  type UserBlock,
} from "@nf/ai/claude";
