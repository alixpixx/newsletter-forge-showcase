/**
 * Double du client Supabase pour les bancs — AUCUN accès réseau.
 *
 * Chaque `from(table)` ou `rpc(nom, args)` ouvre un appel qui enregistre les méthodes chaînées
 * (`select`, `eq`, `update`…) ; l'`await` final consomme la réponse suivante de la file, DANS L'ORDRE.
 * Ce qu'un banc mesure avec lui, c'est la requête construite et la réaction du code à la réponse, pas
 * ce que PostgREST en ferait.
 *
 * ⚠️ Fichier sans `.test` : bun ne le lance pas, et rien hors des bancs ne l'importe (Next ne l'embarque
 * donc jamais). Pas de `mock.module` : le double se PASSE au code testé, il ne remplace aucun module
 * pour toute la suite (`mock.module` fuit d'un fichier de test à l'autre).
 */

export type AppelDb = { table: string; methodes: { m: string; args: unknown[] }[] };
export type ReponseDb = { data: unknown; error: unknown };

export function fauxDb<T = never>(...reponses: ReponseDb[]): { db: T; appels: AppelDb[]; restantes: () => number } {
  const appels: AppelDb[] = [];
  let i = 0;
  const ouvrir = (table: string, premiere?: { m: string; args: unknown[] }) => {
    const appel: AppelDb = { table, methodes: premiere ? [premiere] : [] };
    appels.push(appel);
    const chaine: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const reponse = reponses[i++] ?? { data: null, error: null };
            return (resoudre: (v: unknown) => void) => resoudre(reponse);
          }
          return (...args: unknown[]) => {
            appel.methodes.push({ m: prop, args });
            return chaine;
          };
        },
      },
    );
    return chaine;
  };
  const db = {
    from: (table: string) => ouvrir(table),
    rpc: (nom: string, args?: unknown) => ouvrir(`rpc:${nom}`, { m: "rpc", args: [args] }),
  };
  return { db: db as unknown as T, appels, restantes: () => reponses.length - i };
}

/** Les filtres `eq` d'un appel, en paires `[colonne, valeur]`. */
export const eqsDe = (a: AppelDb): [unknown, unknown][] =>
  a.methodes.filter((m) => m.m === "eq").map((m) => [m.args[0], m.args[1]]);

/** Vrai si l'appel a écrit (`insert`, `update`, `upsert`, `delete`) ou appelé une RPC. */
export const ecrit = (a: AppelDb): boolean =>
  a.methodes.some((m) => ["insert", "update", "upsert", "delete", "rpc"].includes(m.m));
