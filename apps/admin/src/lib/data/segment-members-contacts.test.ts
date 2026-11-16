/**
 * LA LISTE DES MEMBRES D'UN SEGMENT « Newsletter: No » (0088) : ce sont les CONTACTS qu'elle déplie.
 *
 * ⛔ Même vue que l'envoi, ou la liste montre des gens que l'envoi ne servira pas : la vue vient de
 * la règle (`AUDIENCE_VIEW`), comme au compteur, à l'estimation et au fan-out.
 */
import { expect, test } from "bun:test";

process.env.AUTH_SECRET = "secret-de-test-uniquement-25092026";
const { listSegmentMembers } = await import("./segment-members");

const ASSET = "asset_1";
const SEG = "11111111-1111-4111-8111-111111111111";
const regle = (...children: unknown[]) => ({ id: "root", type: "group", op: "AND", children });

function fauxDb(rule: unknown) {
  const tables: string[] = [];
  const db = {
    from(table: string) {
      tables.push(table);
      const rep =
        table === "segment"
          ? { data: { id: SEG, name: "Contoso", rule_json: rule }, count: null }
          : table.endsWith("_subscription")
            ? { data: [], count: 0 }
            : { data: [], count: null };
      const chaine: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") return (ok: (v: unknown) => void) => ok({ ...rep, error: null });
            return () => chaine;
          },
        },
      );
      return chaine;
    },
  };
  return { db: db as unknown as Parameters<typeof listSegmentMembers>[0], tables };
}

test("« Newsletter: No » liste les contacts, jamais les abonnés", async () => {
  // MUTATION QUI DOIT TUER CE TEST : remettre `db.from("sendable_subscription")` dans `audience()`.
  const { db, tables } = fauxDb(regle({ id: "n1", type: "predicate", field: "newsletter", op: "eq", value: "no" }));
  const r = await listSegmentMembers(db, ASSET, SEG);
  expect(r.ok).toBe(true);
  expect(tables).toContain("contact_subscription");
  expect(tables).not.toContain("sendable_subscription");
});

test("sans sélecteur : les abonnés, comme avant", async () => {
  const { db, tables } = fauxDb(regle({ id: "n2", type: "predicate", field: "country", op: "eq", value: "BR" }));
  const r = await listSegmentMembers(db, ASSET, SEG);
  expect(r.ok).toBe(true);
  expect(tables).toContain("sendable_subscription");
  expect(tables).not.toContain("contact_subscription");
});
