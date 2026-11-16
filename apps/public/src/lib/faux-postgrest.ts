/**
 * ⚠️ BANC SEULEMENT — aucune route ne doit l'importer.
 *
 * Une base EN MÉMOIRE qui répond aux chaînes du client Supabase (`from().select().eq()…`,
 * `update().neq().select()`, `insert()`, `rpc()`), et enregistre chaque appel.
 *
 * ⛔ POURQUOI UN ÉTAT, ET PAS DES RÉPONSES SERVIES DANS L'ORDRE (comme le banc du webhook Mailgun).
 * Ce qui se mesure ici, c'est « un second clic n'envoie pas un second accusé » : il faut que le
 * premier clic CHANGE la ligne et que le second la TROUVE changée — et que le `.neq` de l'écriture
 * soit réellement appliqué, pas simulé par le banc. Un double à réponses fixes dirait vert même si
 * le `.neq` disparaissait.
 *
 * Ce qu'il sait faire, et rien de plus : filtres `eq`/`neq`/`is`, `order` sur une colonne, `limit`,
 * `maybeSingle`/`single`, `update` (qui rend les `id` touchés si `.select()` suit), `insert`, et la
 * RPC `erase_subscriber` (abonné pseudonymisé et daté, statuts à `deleted`, comme 0006). Les autres
 * RPC sont enregistrées et répondent sans erreur — avec `null`, ou ce que rend `o.rpc` quand le banc
 * a besoin d'une réponse (une vérification de suppression qui dit « oui », par exemple).
 */

export type Ligne = Record<string, unknown>;
export type Appel = { cible: string; methodes: { m: string; args: unknown[] }[] };
/** Panne injectée : une erreur Postgres rendue, ou une exception levée par le client. */
export type Panne = { message: string } | "lever" | null;

export function fausseBasePostgrest(
  tables: Record<string, Ligne[]>,
  o: { panne?: (a: Appel) => Panne; rpc?: (nom: string, args: unknown) => unknown } = {},
) {
  const appels: Appel[] = [];

  const executer = (a: Appel): { data: unknown; error: { message: string } | null } => {
    const panne = o.panne?.(a) ?? null;
    if (panne === "lever") throw new Error(`panne simulee sur ${a.cible}`);
    if (panne) return { data: null, error: panne };

    if (a.cible.startsWith("rpc:")) {
      if (a.cible === "rpc:erase_subscriber") {
        // Comme 0006 : la ligne `subscriber` est GARDÉE, pseudonymisée et datée ; les souscriptions
        // passent `deleted` sans être supprimées.
        const { p_subscriber_id } = a.methodes[0]!.args[0] as { p_subscriber_id: string };
        for (const p of tables.subscriber ?? []) {
          if (p.id === p_subscriber_id) {
            p.email = `erased+${p_subscriber_id}@deleted.invalid`;
            p.first_name = null;
            p.deleted_at = "2026-09-22T12:00:00Z";
          }
        }
        for (const s of tables.subscription ?? []) if (s.subscriber_id === p_subscriber_id) s.status = "deleted";
      }
      return { data: o.rpc?.(a.cible.slice(4), a.methodes[0]!.args[0]) ?? null, error: null };
    }

    const a_ = (m: string) => a.methodes.find((x) => x.m === m);
    const lignes = (tables[a.cible] ??= []);
    const correspond = (l: Ligne) =>
      a.methodes.every(({ m, args: [col, val] }) => {
        if (m === "eq") return l[col as string] === val;
        if (m === "neq") return l[col as string] !== val;
        if (m === "is") return (l[col as string] ?? null) === val;
        return true;
      });

    const insert = a_("insert");
    if (insert) {
      const v = insert.args[0];
      const nouvelles = (Array.isArray(v) ? v : [v]).map((l, i) => ({
        id: `${a.cible}-${lignes.length + i + 1}`,
        ...(l as Ligne),
      }));
      lignes.push(...nouvelles);
      const rendu = a_("single") ? { ...nouvelles[0] } : nouvelles.map((l) => ({ ...l }));
      return { data: a_("select") ? rendu : null, error: null };
    }

    const update = a_("update");
    if (update) {
      const touchees = lignes.filter(correspond);
      for (const l of touchees) Object.assign(l, update.args[0] as Ligne);
      return { data: a_("select") ? touchees.map((l) => ({ id: l.id })) : null, error: null };
    }

    let res = lignes.filter(correspond).map((l) => ({ ...l }));
    const ordre = a_("order");
    if (ordre) {
      const [col, opts] = ordre.args as [string, { ascending?: boolean } | undefined];
      const sens = opts?.ascending === false ? -1 : 1;
      res.sort((x, y) => (String(x[col]) < String(y[col]) ? -sens : String(x[col]) > String(y[col]) ? sens : 0));
    }
    const limite = a_("limit");
    if (limite) res = res.slice(0, limite.args[0] as number);
    if (a_("maybeSingle") || a_("single")) return { data: res[0] ?? null, error: null };
    return { data: res, error: null };
  };

  const chaine = (a: Appel): unknown => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resoudre: (v: unknown) => void, rejeter: (e: unknown) => void) => {
              try {
                resoudre(executer(a));
              } catch (e) {
                rejeter(e);
              }
            };
          }
          return (...args: unknown[]) => {
            a.methodes.push({ m: prop, args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };

  const db = {
    from: (t: string) => {
      const a: Appel = { cible: t, methodes: [] };
      appels.push(a);
      return chaine(a);
    },
    rpc: (n: string, args: unknown) => {
      const a: Appel = { cible: `rpc:${n}`, methodes: [{ m: "rpc", args: [args] }] };
      appels.push(a);
      return chaine(a);
    },
  };

  /** Lignes écrites dans `email_outbox` — c'est-à-dire les e-mails mis en file. */
  const outbox = () => tables.email_outbox ?? [];
  return { db, appels, tables, outbox };
}
