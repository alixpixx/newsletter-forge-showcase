/**
 * TYPES DU HARNAIS DE TEST — déclarés ici parce que `@types/bun` n'est pas installé dans ce paquet.
 *
 * ⚠️ Mesuré le 01/09/2026, en sortant `article-views` de `apps/admin` : sans ce fichier, le typecheck de
 * `packages/analytics` sort en code 2 sur le seul `import … from "bun:test"` (TS2307). Le banc passerait,
 * la porte de typecheck resterait rouge — et une porte toujours rouge ne se lit plus. Le
 * `tsconfig.json` du paquet fixe `types: ["node"]`, donc même un `@types/bun` présent dans
 * `node_modules` ne serait pas chargé : une déclaration ambiante est le seul remède qui ne touche
 * pas la configuration du paquet.
 *
 * ⚠️ Jumeau volontaire de `packages/render/src/bun-test.d.ts` et de
 * `apps/admin/src/lib/preflight/bun-test.d.ts`, et non un import de ceux-ci : ce sont des projets
 * `tsc` distincts, et partager le fichier demanderait d'élargir l'`include` d'un autre paquet pour
 * une commodité.
 *
 * ⛔ On ne déclare QUE les matchers utilisés par le banc, jamais l'API complète : un matcher inconnu
 * doit échouer au typecheck plutôt que de passer en silence. À supprimer le jour où `@types/bun`
 * entre dans les devDependencies de `@nf/wp` — deux déclarations du même module finiraient par se
 * contredire, et c'est celle écrite à la main qui aurait tort.
 */
declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toContain(expected: string): void;
    /**
     * Comparaison structurelle — pour `joursDeFenetre`, qui rend une durée ET sa provenance.
     * ⛔ Les deux doivent être assertées ENSEMBLE : vérifier le seul nombre laisserait passer une
     * provenance fausse, or c'est elle qui distingue « sept jours voulus » de « sept jours faute
     * de mieux ».
     */
    toEqual(expected: unknown): void;
    readonly not: Matchers;
  }

  export function expect(actual: unknown): Matchers;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}
