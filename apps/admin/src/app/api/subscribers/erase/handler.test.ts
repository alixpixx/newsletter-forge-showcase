import { describe, expect, test } from "bun:test";
import { traiterEffacement } from "./handler";

/**
 * ⛔⛔ LE CHEMIN LE PLUS DESTRUCTEUR DE L'ADMIN, ET IL N'AVAIT AUCUN TEST.
 *
 * `erase_subscriber` anonymise pour de bon : l'adresse devient `erased+<uuid>@deleted.invalid`, le
 * prénom disparaît, les souscriptions passent `deleted`, l'IP et l'agent sont retirés du journal de
 * consentement. Rien ne se défait. Et ce chemin n'a jamais été exécuté depuis l'écran.
 *
 * Il ne peut pas être éprouvé contre la base réelle : effacer une vraie personne est irréversible,
 * et le MCP disponible ici pointe l'ANCIENNE base. Ce qui peut être prouvé sans base, c'est la
 * décision — et c'est là que vivent les trois fautes qui coûteraient le plus cher :
 *
 *  1. effacer sans confirmation ;
 *  2. passer un identifiant de SOUSCRIPTION à une fonction qui attend une PERSONNE (elle ne lève
 *     rien : elle ne trouve pas l'adresse et sort, l'écran annonce un effacement qui n'a pas eu lieu) ;
 *  3. effacer à partir d'une ligne d'une AUTRE marque.
 */

type Appel = { methode: string; args: unknown[] };

function fausseBase(o: {
  cibles?: { id: string; subscriber_id: string | null }[];
  erreurLecture?: { message: string } | null;
  portee?: number;
  rpcEchoue?: string[];
} = {}) {
  const appels: Appel[] = [];
  const rpcs: Record<string, unknown>[] = [];
  let requeteCourante = 0;

  const faire = () => {
    const self: Record<string, unknown> = {};
    const mien = ++requeteCourante;
    for (const m of ["select", "in", "eq"]) {
      self[m] = (...args: unknown[]) => {
        appels.push({ methode: m, args });
        // La 1re requête (lecture des cibles) et la 2e (comptage de portée) se terminent quand on
        // cesse de chaîner : on rend un thenable pour que `await` fonctionne dans les deux cas.
        return self;
      };
    }
    (self as { then: unknown }).then = (resoudre: (v: unknown) => void) =>
      resoudre(
        mien === 1
          ? { data: o.erreurLecture ? null : (o.cibles ?? []), error: o.erreurLecture ?? null }
          : { count: o.portee ?? 0, error: null },
      );
    return self;
  };

  const db = {
    from: (t: string) => {
      appels.push({ methode: "from", args: [t] });
      return faire();
    },
    rpc: (f: string, a: Record<string, unknown>) => {
      appels.push({ methode: "rpc", args: [f, a] });
      rpcs.push(a);
      const echoue = (o.rpcEchoue ?? []).includes(String(a.p_subscriber_id));
      return Promise.resolve({ error: echoue ? { message: "boom" } : null });
    },
  };
  return { db, appels, rpcs };
}

const CTX = (db: unknown) => ({ assetId: "asset-1", db: db as never });

describe("traiterEffacement — les refus AVANT toute écriture", () => {
  test("⛔ marque non résolue : on refuse, on ne devine pas", async () => {
    const { db, rpcs } = fausseBase();
    const r = await traiterEffacement({ ids: ["s1"], confirm: true }, { assetId: null, db: db as never });
    expect(r.statut).toBe(409);
    expect(r.corps.reason).toBe("no-asset");
    expect(rpcs).toHaveLength(0);
  });

  test("base injoignable : 503, rien d'effacé", async () => {
    const r = await traiterEffacement({ ids: ["s1"], confirm: true }, { assetId: "a", db: null });
    expect(r.statut).toBe(503);
    expect(r.corps.reason).toBe("no-db");
  });

  test("sélection vide : 400", async () => {
    const { db, rpcs } = fausseBase();
    const r = await traiterEffacement({ ids: [], confirm: true }, CTX(db));
    expect(r.statut).toBe(400);
    expect(rpcs).toHaveLength(0);
  });

  test("⛔ une lecture en erreur n'est JAMAIS lue comme « aucune ligne »", async () => {
    // Sinon la route répondrait « no-match » : un incident de base se lirait comme une sélection
    // qui n'appartient pas à la marque, et personne ne chercherait la panne.
    const { db, rpcs } = fausseBase({ erreurLecture: { message: "timeout" } });
    const r = await traiterEffacement({ ids: ["s1"], confirm: true }, CTX(db));
    expect(r.statut).toBe(500);
    expect(r.corps.reason).toBe("read-failed");
    expect(rpcs).toHaveLength(0);
  });

  test("⛔ aucune ligne de CETTE marque : 409, et surtout aucun effacement", async () => {
    const { db, rpcs } = fausseBase({ cibles: [] });
    const r = await traiterEffacement({ ids: ["s-autre-marque"], confirm: true }, CTX(db));
    expect(r.statut).toBe(409);
    expect(r.corps.reason).toBe("no-match");
    expect(r.corps.people).toBe(0);
    expect(rpcs).toHaveLength(0);
  });

  test("⛔ la lecture est SCOPÉE MARQUE — le `.eq('asset_id')` est bien posé", async () => {
    const { db, appels } = fausseBase({ cibles: [{ id: "s1", subscriber_id: "p1" }] });
    await traiterEffacement({ ids: ["s1"] }, CTX(db));
    const eq = appels.find((a) => a.methode === "eq");
    expect(eq?.args).toEqual(["asset_id", "asset-1"]);
  });
});

describe("traiterEffacement — le premier appel COMPTE et n'écrit rien", () => {
  test("⛔ sans `confirm`, AUCUNE rpc n'est appelée", async () => {
    const { db, rpcs } = fausseBase({
      cibles: [{ id: "s1", subscriber_id: "p1" }, { id: "s2", subscriber_id: "p1" }],
      portee: 5,
    });
    const r = await traiterEffacement({ ids: ["s1", "s2"] }, CTX(db));
    expect(rpcs).toHaveLength(0);
    expect(r.corps.applied).toBe(false);
  });

  test("⛔ il annonce des PERSONNES, pas des lignes cochées", async () => {
    // Deux souscriptions de la même personne = UN effacement. Annoncer « 2 » ferait croire à
    // deux fois plus de dégâts, et « selected » garde le nombre coché pour la phrase d'écran.
    const { db } = fausseBase({
      cibles: [{ id: "s1", subscriber_id: "p1" }, { id: "s2", subscriber_id: "p1" }],
      portee: 7,
    });
    const r = await traiterEffacement({ ids: ["s1", "s2"] }, CTX(db));
    expect(r.corps.people).toBe(1);
    expect(r.corps.selected).toBe(2);
  });

  test("⛔ la PORTÉE annoncée dépasse la marque regardée", async () => {
    // C'est le sens du droit à l'oubli : la personne sort de TOUTES les marques. L'écran doit
    // annoncer ce nombre-là, pas le nombre de lignes visibles.
    const { db } = fausseBase({ cibles: [{ id: "s1", subscriber_id: "p1" }], portee: 9 });
    const r = await traiterEffacement({ ids: ["s1"] }, CTX(db));
    expect(r.corps.subscriptions).toBe(9);
  });

  test("⛔ `confirm` doit valoir exactement `true`", async () => {
    for (const valeur of ["true", 1, {}, "false", null]) {
      const { db, rpcs } = fausseBase({ cibles: [{ id: "s1", subscriber_id: "p1" }] });
      const r = await traiterEffacement({ ids: ["s1"], confirm: valeur }, CTX(db));
      expect(rpcs).toHaveLength(0);
      expect(r.corps.applied).toBe(false);
    }
  });
});

describe("traiterEffacement — l'effacement lui-même", () => {
  test("⛔⛔ la rpc reçoit un identifiant de PERSONNE, jamais de souscription", async () => {
    // `erase_subscriber` ne lève RIEN si on lui passe un id de souscription : elle ne trouve pas
    // l'adresse et sort. L'écran annoncerait « effacé » sur un effacement qui n'a pas eu lieu.
    const { db, rpcs, appels } = fausseBase({
      cibles: [{ id: "sub-AAA", subscriber_id: "pers-BBB" }],
      portee: 1,
    });
    await traiterEffacement({ ids: ["sub-AAA"], confirm: true }, CTX(db));

    expect(rpcs).toEqual([{ p_subscriber_id: "pers-BBB" }]);
    expect(appels.find((a) => a.methode === "rpc")?.args[0]).toBe("erase_subscriber");
  });

  test("⛔ une personne portant N souscriptions n'est effacée QU'UNE fois", async () => {
    const { db, rpcs } = fausseBase({
      cibles: [
        { id: "s1", subscriber_id: "p1" },
        { id: "s2", subscriber_id: "p1" },
        { id: "s3", subscriber_id: "p2" },
      ],
      portee: 3,
    });
    const r = await traiterEffacement({ ids: ["s1", "s2", "s3"], confirm: true }, CTX(db));
    expect(rpcs).toHaveLength(2);
    expect(r.corps.erased).toBe(2);
    expect(r.corps.ok).toBe(true);
  });

  test("⛔ une ligne sans personne est écartée — pas d'appel avec `null`", async () => {
    const { db, rpcs } = fausseBase({
      cibles: [{ id: "s1", subscriber_id: null }, { id: "s2", subscriber_id: "p1" }],
      portee: 2,
    });
    await traiterEffacement({ ids: ["s1", "s2"], confirm: true }, CTX(db));
    expect(rpcs).toEqual([{ p_subscriber_id: "p1" }]);
  });

  test("⛔ un échec partiel se DIT : `ok:false` et le compte exact", async () => {
    // Avaler l'échec afficherait « effacé » sur quelqu'un qui reste en base — avec une demande
    // RGPD ouverte que personne ne saurait rouvrir.
    const { db } = fausseBase({
      cibles: [{ id: "s1", subscriber_id: "p1" }, { id: "s2", subscriber_id: "p2" }],
      portee: 2,
      rpcEchoue: ["p2"],
    });
    const r = await traiterEffacement({ ids: ["s1", "s2"], confirm: true }, CTX(db));
    expect(r.corps.ok).toBe(false);
    expect(r.corps.erased).toBe(1);
    expect(r.corps.failed).toBe(1);
    expect(r.corps.applied).toBe(true);
  });

  test("⛔ un échec sur l'un n'arrête pas les autres", async () => {
    const { db, rpcs } = fausseBase({
      cibles: [
        { id: "s1", subscriber_id: "p1" },
        { id: "s2", subscriber_id: "p2" },
        { id: "s3", subscriber_id: "p3" },
      ],
      portee: 3,
      rpcEchoue: ["p1"],
    });
    const r = await traiterEffacement({ ids: ["s1", "s2", "s3"], confirm: true }, CTX(db));
    expect(rpcs).toHaveLength(3);
    expect(r.corps.erased).toBe(2);
  });

  test("des identifiants non textuels sont ignorés sans faire tomber la route", async () => {
    const { db, rpcs } = fausseBase({ cibles: [{ id: "s1", subscriber_id: "p1" }], portee: 1 });
    const r = await traiterEffacement({ ids: ["s1", 42, null, {}], confirm: true }, CTX(db));
    expect(r.corps.erased).toBe(1);
    expect(rpcs).toHaveLength(1);
  });
});
