import { describe, expect, test } from "bun:test";
import {
  ecrireDesabonnement,
  ipDeLaRequete,
  METHODE_HUMAIN,
  METHODE_MACHINE,
} from "./desabonnement";

/**
 * ⛔ CE BANC GARDE UN CORRECTIF DE CONCURRENCE QUI A ÉTÉ MESURÉ, PAS DEVINÉ.
 *
 * Sans `.neq("status","unsubscribed")` DANS l'instruction d'écriture, 6 POST simultanés portant le
 * même jeton donnaient 6× HTTP 200 et **5 `consent_event` en trop**. La table est append-only : la
 * preuve de consentement restait gonflée pour toujours.
 *
 * Un commentaire ne protège pas ça — n'importe quelle réécriture « plus lisible » en
 * `update().eq('id')` + test applicatif repasserait au vert. C'est pourquoi le banc EXIGE la
 * présence du `.neq`, et pas seulement le bon résultat.
 */

type Appel = { methode: string; args: unknown[] };

function fausseBase(o: {
  lignes?: { id: string }[] | null;
  erreurMaj?: { message: string } | null;
  erreurTrace?: { message: string } | null;
} = {}) {
  const appels: Appel[] = [];
  const inseres: Record<string, unknown>[] = [];

  const constructeur: Record<string, unknown> = {};
  for (const m of ["update", "eq", "neq"]) {
    constructeur[m] = (...args: unknown[]) => {
      appels.push({ methode: m, args });
      return constructeur;
    };
  }
  constructeur.select = (...args: unknown[]) => {
    appels.push({ methode: "select", args });
    return Promise.resolve({
      data: o.erreurMaj ? null : (o.lignes ?? [{ id: "sub-1" }]),
      error: o.erreurMaj ?? null,
    });
  };
  constructeur.insert = (ligne: Record<string, unknown>) => {
    appels.push({ methode: "insert", args: [ligne] });
    inseres.push(ligne);
    return Promise.resolve({ error: o.erreurTrace ?? null });
  };

  const db = {
    from: (table: string) => {
      appels.push({ methode: "from", args: [table] });
      return constructeur;
    },
  };
  return { db, appels, inseres };
}

const BASE = { langue: "es", ip: "203.0.113.7", ua: "Firefox" } as const;

describe("ecrireDesabonnement — l'écriture unique", () => {
  test("⛔⛔ LA CONDITION EST DANS L'ÉCRITURE : `.neq('status','unsubscribed')` est appelé", async () => {
    const { db, appels } = fausseBase();
    await ecrireDesabonnement(db, "sub-1", { methode: METHODE_MACHINE, ...BASE });

    const neq = appels.find((a) => a.methode === "neq");
    expect(neq).toBeDefined();
    expect(neq?.args).toEqual(["status", "unsubscribed"]);
  });

  test("⛔ le `.neq` vient APRÈS le `.update` — sinon il ne conditionne rien", async () => {
    const { db, appels } = fausseBase();
    await ecrireDesabonnement(db, "sub-1", { methode: METHODE_MACHINE, ...BASE });

    const noms = appels.map((a) => a.methode);
    expect(noms.indexOf("update")).toBeLessThan(noms.indexOf("neq"));
    expect(noms.indexOf("neq")).toBeLessThan(noms.indexOf("select"));
  });

  test("⛔ une souscription EFFACÉE n'est pas réécrite : `.neq('status','deleted')` est dans l'écriture", async () => {
    // Sans lui, un vieux lien signé faisait repasser `deleted` à `unsubscribed` — et depuis le
    // 22/09, `fait` met en file un accusé, qui serait parti vers `erased+…@deleted.invalid`.
    const { db, appels } = fausseBase();
    await ecrireDesabonnement(db, "sub-1", { methode: METHODE_HUMAIN, ...BASE });

    const neqs = appels.filter((a) => a.methode === "neq").map((a) => a.args);
    expect(neqs).toContainEqual(["status", "deleted"]);
    const noms = appels.map((a) => a.methode);
    expect(noms.lastIndexOf("neq")).toBeLessThan(noms.indexOf("select"));
  });

  test("une ligne modifiée = `fait`, et la trace est écrite", async () => {
    const { db, inseres } = fausseBase({ lignes: [{ id: "sub-1" }] });
    expect(await ecrireDesabonnement(db, "sub-1", { methode: METHODE_MACHINE, ...BASE })).toBe("fait");
    expect(inseres).toHaveLength(1);
    expect(inseres[0].subscription_id).toBe("sub-1");
    expect(inseres[0].event_type).toBe("unsubscribe");
  });

  test("⛔ ZÉRO ligne = `deja`, et AUCUNE trace n'est écrite", async () => {
    // C'est le perdant de la course. Écrire quand même serait exactement le défaut mesuré.
    const { db, inseres } = fausseBase({ lignes: [] });
    expect(await ecrireDesabonnement(db, "sub-1", { methode: METHODE_MACHINE, ...BASE })).toBe("deja");
    expect(inseres).toHaveLength(0);
  });

  test("⛔ une erreur d'écriture rend `echec` — la personne est TOUJOURS abonnée", async () => {
    const { db, inseres } = fausseBase({ erreurMaj: { message: "boom" } });
    expect(await ecrireDesabonnement(db, "sub-1", { methode: METHODE_MACHINE, ...BASE })).toBe("echec");
    expect(inseres).toHaveLength(0);
  });

  test("⛔ une trace en échec ne transforme PAS le désabonnement en échec", async () => {
    // Le statut est passé : rendre « echec » ferait rejouer sans fin un POST qui ne réussira pas.
    const { db } = fausseBase({ erreurTrace: { message: "append-only" } });
    expect(await ecrireDesabonnement(db, "sub-1", { methode: METHODE_MACHINE, ...BASE })).toBe("fait");
  });

  test("⛔ les deux chemins ne diffèrent QUE par le libellé d'audit", async () => {
    const machine = fausseBase();
    await ecrireDesabonnement(machine.db, "sub-1", { methode: METHODE_MACHINE, ...BASE });
    const humain = fausseBase();
    await ecrireDesabonnement(humain.db, "sub-1", { methode: METHODE_HUMAIN, ...BASE });

    expect(machine.inseres[0].method).toBe("list_unsub_one_click");
    expect(humain.inseres[0].method).toBe("list_unsub");

    // Tout le reste identique : même acte juridique, même forme de preuve.
    const sansMethode = (l: Record<string, unknown>) => ({ ...l, method: undefined });
    expect(sansMethode(machine.inseres[0])).toEqual(sansMethode(humain.inseres[0]));
    expect(machine.appels.map((a) => a.methode)).toEqual(humain.appels.map((a) => a.methode));
  });

  test("⛔ la langue est NORMALISÉE, jamais écrite brute", async () => {
    const { db, inseres } = fausseBase();
    await ecrireDesabonnement(db, "sub-1", { methode: METHODE_HUMAIN, langue: "ES-cl", ip: null, ua: null });
    expect(inseres[0].language).toBe("es");
  });

  test("⛔ une langue nulle ne devient pas NULL en base", async () => {
    const { db, inseres } = fausseBase();
    await ecrireDesabonnement(db, "sub-1", { methode: METHODE_HUMAIN, langue: null, ip: null, ua: null });
    expect(inseres[0].language).toBe("en");
  });
});

describe("ipDeLaRequete — la preuve doit désigner le demandeur", () => {
  const h = (o: Record<string, string>) => new Headers(o);

  test("⛔ le PREMIER maillon de la chaîne, pas la chaîne entière", () => {
    // Toute la chaîne écrirait trois adresses dans une colonne qui en attend une ;
    // le dernier maillon écrirait NOTRE infrastructure comme preuve de consentement.
    expect(ipDeLaRequete(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" }))).toBe("203.0.113.7");
  });

  test("le repli `x-real-ip` sert quand la chaîne manque", () => {
    expect(ipDeLaRequete(h({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  test("⛔ une chaîne vide n'est pas une adresse : on retombe sur le repli", () => {
    expect(ipDeLaRequete(h({ "x-forwarded-for": "  ", "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  test("sans rien, null — et surtout pas une chaîne vide", () => {
    expect(ipDeLaRequete(h({}))).toBeNull();
  });
});
