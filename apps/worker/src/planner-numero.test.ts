/**
 * Banc de la NUMÉROTATION des éditions (0067, décision d'Alix du 16/09 : « on ajoute un numero de
 * depart »).
 *
 * ⛔ On mesure le `seq` que la passe ÉCRIT (`insertOccurrence`), pas seulement la fonction pure :
 * une fonction juste que la passe n'appelle pas laisserait chaque série repartir à 1.
 */
import { describe, expect, test } from "bun:test";

const { runPlanner, prochainNumero } = await import("./planner");
type Db = Parameters<typeof runPlanner>[0];

const NOW = new Date("2026-09-16T12:00:00.000Z");

function plan(editionStart: number | null) {
  return {
    id: "camp_1",
    asset_id: "asset_1",
    name: "Boletín",
    status: "scheduled",
    timezone: "America/Santiago",
    recurrence_days: [1, 5],
    recurrence_time: "10:00",
    recurrence_every_weeks: 1,
    recurrence_anchor: "2026-09-01",
    recurrence_until: null,
    freeze_lead_minutes: 90,
    template_version_id: "tv_1",
    segment_id: null,
    subject: "Sujet",
    preheader: null,
    edition_start: editionStart,
  };
}

const CALCULEES = [
  { local_date: "2026-09-18", fires_at: "2026-09-18T13:00:00.000Z", local_text: "Fri 18 Sep 10:00" },
  { local_date: "2026-09-21", fires_at: "2026-09-21T13:00:00.000Z", local_text: "Mon 21 Sep 10:00" },
];

function fauxDb(
  editionStart: number | null,
  existants: { seq: number; local_date: string }[],
  opts: { collisionSur?: string; apresCollision?: { seq: number; local_date: string }[] } = {},
): { db: Db; ecrits: number[] } {
  const ecrits: number[] = [];
  let lectures = 0;
  const db = {
    listArmedPlans: async () => [plan(editionStart)],
    computeOccurrences: async () => CALCULEES,
    listOccurrences: async () => {
      lectures++;
      const liste = lectures > 1 && opts.apresCollision ? opts.apresCollision : existants;
      return liste.map((o, i) => ({ id: `o${i}`, seq: o.seq, local_date: o.local_date, status: "planned" }));
    },
    insertOccurrence: async (row: Record<string, unknown>) => {
      if (row.local_date === opts.collisionSur) throw Object.assign(new Error("duplicate"), { code: "23505" });
      ecrits.push(row.seq as number);
    },
    listOccurrencesToFreeze: async () => [],
    countOutboxRowsWithOccurrence: async () => 0,
    countOverdueOccurrences: async () => 0,
    // Passe de relecture (0079) : aucune édition relue dans ce banc.
    listOccurrencesToRefreeze: async () => [],
  } as unknown as Db;
  return { db, ecrits };
}

describe("prochainNumero", () => {
  test("sans départ ni existant : 1", () => {
    expect(prochainNumero([], 1)).toBe(1);
    expect(prochainNumero([], null)).toBe(1);
    expect(prochainNumero([], undefined)).toBe(1);
  });

  test("le départ est un plancher : 140 ⇒ 140", () => {
    expect(prochainNumero([], 140)).toBe(140);
  });

  test("un numéro ne recule jamais : départ 40, déjà 45 ⇒ 46", () => {
    expect(prochainNumero([{ seq: 45 }, { seq: 44 }], 40)).toBe(46);
  });

  test("départ relevé après coup : déjà 3, départ 40 ⇒ 40", () => {
    expect(prochainNumero([{ seq: 3 }], 40)).toBe(40);
  });

  test("départ invalide (0, négatif, décimal) ⇒ ignoré", () => {
    expect(prochainNumero([{ seq: 2 }], 0)).toBe(3);
    expect(prochainNumero([], 0)).toBe(1);
    expect(prochainNumero([], -5)).toBe(1);
    expect(prochainNumero([], 2.5)).toBe(1);
  });
});

describe("la passe écrit le numéro attendu", () => {
  test("départ 1, série neuve ⇒ 1 puis 2", async () => {
    const { db, ecrits } = fauxDb(1, []);
    const r = await runPlanner(db, { now: NOW });
    expect(r.errors).toEqual([]);
    expect(ecrits).toEqual([1, 2]);
  });

  test("⛔ départ 140, série neuve ⇒ 140 puis 141", async () => {
    const { db, ecrits } = fauxDb(140, []);
    await runPlanner(db, { now: NOW });
    expect(ecrits).toEqual([140, 141]);
  });

  test("départ 140, déjà 150 existant ⇒ 151 puis 152", async () => {
    const { db, ecrits } = fauxDb(140, [{ seq: 150, local_date: "2026-09-14" }]);
    await runPlanner(db, { now: NOW });
    expect(ecrits).toEqual([151, 152]);
  });

  test("colonne absente (null) ⇒ numérotation d'avant 0067", async () => {
    const { db, ecrits } = fauxDb(null, [{ seq: 7, local_date: "2026-09-14" }]);
    await runPlanner(db, { now: NOW });
    expect(ecrits).toEqual([8, 9]);
  });

  test("⛔ après une collision, la relecture garde le plancher du départ", async () => {
    // Un autre worker a créé le 18 entre notre lecture et notre écriture, numéroté 5 (il tournait
    // avant que le départ soit relevé à 200). Sans le plancher à la relecture, le 21 recevrait 6.
    const { db, ecrits } = fauxDb(200, [], {
      collisionSur: "2026-09-18",
      apresCollision: [{ seq: 5, local_date: "2026-09-18" }],
    });
    const r = await runPlanner(db, { now: NOW });
    expect(r.errors).toEqual([]);
    expect(ecrits).toEqual([200]);
  });
});
