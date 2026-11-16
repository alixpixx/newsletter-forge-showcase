/**
 * TYPES DU HARNAIS DE TEST — déclarés ici parce que `@types/bun` n'est pas installé.
 *
 * ⚠️ Sans ce fichier, `tsc --noEmit` du paquet admin sort en code 2 sur le seul
 * `import … from "bun:test"` : la porte de typecheck du dépôt resterait rouge en permanence, et
 * une porte toujours rouge ne se lit plus. On déclare donc le strict minimum que le banc utilise —
 * rien de plus, pour qu'un matcher inconnu échoue au typecheck plutôt que de passer en silence.
 *
 * ⛔ À SUPPRIMER le jour où `@types/bun` (ou `bun-types`) entre dans les devDependencies de
 * `apps/admin` : deux déclarations pour le même module se contrediraient à la première évolution
 * de l'API, et c'est celle écrite à la main qui aurait tort.
 */
declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeGreaterThan(expected: number): void;
    toHaveLength(expected: number): void;
    /** Sous-chaîne d'un texte : sert au libellé d'un correctif, dont on mesure le chiffre, pas la phrase. */
    toContain(expected: unknown): void;
    readonly not: Matchers;
  }

  export function expect(actual: unknown): Matchers;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}
