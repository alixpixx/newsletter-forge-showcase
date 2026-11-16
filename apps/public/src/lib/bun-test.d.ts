/**
 * TYPES DU HARNAIS DE TEST — déclarés ici parce que `@types/bun` n'est pas installé.
 *
 * ⚠️ MÊME FICHIER, MÊME RAISON QUE `apps/admin/src/lib/preflight/bun-test.d.ts`. Sans lui,
 * `tsc --noEmit` du paquet public sort en erreur sur le seul `import … from "bun:test"` de
 * `webhook-ref.test.ts` : la porte de typecheck resterait rouge en permanence, et une porte
 * toujours rouge ne se lit plus. On déclare le strict minimum que le banc utilise — rien de plus,
 * pour qu'un matcher inconnu échoue au typecheck plutôt que de passer en silence.
 *
 * ⛔ À SUPPRIMER le jour où `@types/bun` (ou `bun-types`) entre dans les devDependencies de
 * `apps/public` : deux déclarations du même module se contrediraient à la première évolution de
 * l'API, et c'est celle écrite à la main qui aurait tort.
 */
declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeGreaterThan(expected: number): void;
    toHaveLength(expected: number): void;
    toContain(expected: unknown): void;
    readonly not: Matchers;
  }

  export function expect(actual: unknown): Matchers;
  export function test(name: string, fn: () => void | Promise<void>): void;
  /** Alias de `test` — le banc de `webhook-ref` l'emploie. */
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}
