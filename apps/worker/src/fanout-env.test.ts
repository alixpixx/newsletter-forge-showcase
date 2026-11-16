/**
 * Les réglages du fan-out, et surtout l'AVANCE : c'est elle qui décide si une campagne part avant
 * son heure (22/09/2026 — les lignes enfilées partent aussitôt, voir `DEFAULT_LEAD_MINUTES`).
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_LEAD_MINUTES, runFanout } from "./fanout";
import { optionsFanoutDepuisEnv, optionsFanoutInstantane } from "./fanout-env";
import type { FanoutDb } from "./fanout-db";

describe("fanout-env — l'avance lue dans l'environnement", () => {
  /** ⛔ MUTATION QUI DOIT LE TUER : revenir à `Number(x) || undefined`, qui avale le zéro. */
  test("FANOUT_LEAD_MINUTES=0 veut dire ZÉRO, pas « le défaut »", () => {
    expect(optionsFanoutDepuisEnv({ FANOUT_LEAD_MINUTES: "0" }).leadMinutes).toBe(0);
  });

  test("absente, vide, illisible ou négative : le défaut", () => {
    for (const v of [undefined, "", "  ", "abc", "-5"]) {
      expect(optionsFanoutDepuisEnv({ FANOUT_LEAD_MINUTES: v }).leadMinutes).toBeUndefined();
    }
  });

  test("une avance explicite est lue telle quelle", () => {
    expect(optionsFanoutDepuisEnv({ FANOUT_LEAD_MINUTES: "15" }).leadMinutes).toBe(15);
  });

  /** Le plafond par cible et la borne de retard : zéro n'y a pas de sens, il retombe sur le défaut. */
  test("plafond et retard nuls ou négatifs retombent sur le défaut", () => {
    for (const v of ["0", "-3"]) {
      const o = optionsFanoutDepuisEnv({ FANOUT_MAX_PER_TARGET: v, FANOUT_MAX_LATE_MINUTES: v });
      expect(o.maxPerTarget).toBeUndefined();
      expect(o.maxLateMinutes).toBeUndefined();
    }
    const o = optionsFanoutDepuisEnv({ FANOUT_MAX_PER_TARGET: "500", FANOUT_MAX_LATE_MINUTES: "60" });
    expect(o).toEqual({ leadMinutes: undefined, maxPerTarget: 500, maxLateMinutes: 60 });
  });
});

describe("fanout-env — le fan-out immédiat du drain résident", () => {
  /**
   * ⛔ L'AVANCE EST FORCÉE À ZÉRO, QUOI QUE DISE L'ENVIRONNEMENT. MUTATION QUI DOIT LE TUER : reprendre
   * `FANOUT_LEAD_MINUTES` ici — le résident enverrait avant l'heure à chaque passage.
   */
  test("l'avance est zéro même si FANOUT_LEAD_MINUTES en demande une", () => {
    expect(optionsFanoutInstantane({ FANOUT_LEAD_MINUTES: "20" })?.leadMinutes).toBe(0);
  });

  test("les bornes de sûreté du fan-out sont reprises", () => {
    expect(optionsFanoutInstantane({ FANOUT_MAX_PER_TARGET: "500", FANOUT_MAX_LATE_MINUTES: "60" })).toEqual({
      leadMinutes: 0,
      maxPerTarget: 500,
      maxLateMinutes: 60,
    });
  });

  /** ⛔ La simulation n'écrit rien : elle ne tourne pas en boucle dans un service qui envoie. */
  test("pas de fan-out immédiat en simulation", () => {
    expect(optionsFanoutInstantane({ FANOUT_SIMULATE: "1" })).toBeNull();
  });

  test("INSTANT_FANOUT=0 l'éteint ; absent, il est allumé", () => {
    for (const v of ["0", "false", "no", "FALSE"]) expect(optionsFanoutInstantane({ INSTANT_FANOUT: v })).toBeNull();
    expect(optionsFanoutInstantane({})).not.toBeNull();
  });
});

describe("fanout — l'avance par défaut", () => {
  /**
   * ⛔ ZÉRO PAR DÉFAUT. MUTATION QUI DOIT LE TUER : remettre 20 — une campagne de 20:00 partirait à
   * 19:40, puisque les lignes enfilées n'attendent pas l'heure (0038 ne pose pas `next_attempt_at`).
   */
  test("sans réglage, le fan-out ne regarde pas au-delà de maintenant", async () => {
    expect(DEFAULT_LEAD_MINUTES).toBe(0);
    const avances: number[] = [];
    const db = {
      listDueOccurrences: async (_now: Date, lead: number) => {
        avances.push(lead);
        return [];
      },
      listDueCampaigns: async (_now: Date, lead: number) => {
        avances.push(lead);
        return [];
      },
    } as unknown as FanoutDb;
    await runFanout(db, { now: new Date("2026-09-22T12:00:00Z") });
    expect(avances.length).toBeGreaterThan(0);
    expect(avances.every((a) => a === 0)).toBe(true);
  });
});
