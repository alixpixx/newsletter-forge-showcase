/**
 * CE QUE LA COLONNE « Last measured size » AFFICHE (bug du 25/09/2026 : elle montrait l'instantané
 * écrit à l'enregistrement, jamais remis à jour — 10 affichés pour 31 abonnés réels).
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { savedSegmentSize, whyNotMeasured } from "./saved-segment-size";
import { SizeCell, type SavedSegment } from "./saved-segments";

const LE_23 = "2026-09-23T18:15:13.111Z";
const STOCKE = { count: 10, at: LE_23 };
const JAMAIS = { count: null, at: null };

describe("savedSegmentSize — le compte mesuré prime", () => {
  test("⛔ la mesure du chargement REMPLACE l'instantané enregistré", () => {
    expect(savedSegmentSize(STOCKE, { ok: true, count: 31 })).toEqual({ kind: "live", count: 31 });
  });

  test("« aucune mesure encore » (segment sans instantané) : le compte mesuré s'affiche", () => {
    expect(savedSegmentSize(JAMAIS, { ok: true, count: 7 })).toEqual({ kind: "live", count: 7 });
  });

  test("un vrai zéro mesuré s'affiche comme zéro, pas comme « jamais mesuré »", () => {
    expect(savedSegmentSize(STOCKE, { ok: true, count: 0 })).toEqual({ kind: "live", count: 0 });
  });
});

describe("savedSegmentSize — mesure impossible : l'ancien chiffre, DATÉ, et pourquoi", () => {
  test("panne de comptage : l'instantané revient avec sa date et la raison", () => {
    expect(savedSegmentSize(STOCKE, { ok: false, reason: "lookup-failed" })).toEqual({
      kind: "stale",
      count: 10,
      at: LE_23,
      why: "Not re-measured: the count query failed",
    });
  });

  test("un instantané à 0 reste un chiffre daté, pas « jamais mesuré »", () => {
    const v = savedSegmentSize({ count: 0, at: LE_23 }, { ok: false, reason: "no-db" });
    expect(v).toEqual({ kind: "stale", count: 0, at: LE_23, why: "Not re-measured: database unavailable" });
  });

  test("aucune mesure encore ET panne : « never measured » avec la raison, aucun chiffre inventé", () => {
    expect(savedSegmentSize(JAMAIS, { ok: false, reason: "lookup-failed" })).toEqual({
      kind: "none",
      why: "Not re-measured: the count query failed",
    });
  });

  test("mesure absente (segment hors de la carte) : jamais présentée comme fraîche", () => {
    expect(savedSegmentSize(STOCKE, null)).toEqual({ kind: "stale", count: 10, at: LE_23, why: "Not re-measured" });
  });
});

describe("whyNotMeasured — chaque échec a SON nom", () => {
  test("ciblage incomplet : les conditions tombées sont nommées", () => {
    expect(whyNotMeasured({ ok: false, reason: "targeting-incomplete", unsupported: ["last_open"] })).toBe(
      "Not re-measured: targeting incomplete (last_open)",
    );
  });

  test("quatre motifs, quatre phrases distinctes", () => {
    const phrases = (["no-db", "unreadable-rule", "targeting-incomplete", "lookup-failed"] as const).map((reason) =>
      whyNotMeasured({ ok: false, reason }),
    );
    expect(new Set(phrases).size).toBe(4);
    expect(phrases[1]).toBe("Not re-measured: the rule can't be read");
    expect(phrases[2]).toBe("Not re-measured: targeting incomplete");
  });
});

describe("SizeCell — la case que lit Alix", () => {
  const seg = (s: Partial<SavedSegment>): SavedSegment => ({
    id: "s",
    name: "Newsletter",
    summary: "",
    cachedCount: 10,
    cachedAt: LE_23,
    live: null,
    usedByAutomation: false,
    updatedAt: LE_23,
    ...s,
  });
  const texte = (s: SavedSegment) =>
    renderToStaticMarkup(createElement(SizeCell, { s })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  test("⛔ affiche le compte MESURÉ (31), pas l'instantané enregistré (10)", () => {
    expect(texte(seg({ live: { ok: true, count: 31 } }))).toBe("31 now");
  });

  test("mesure ratée : l'instantané, SA date, et l'avertissement visible", () => {
    expect(texte(seg({ live: { ok: false, reason: "lookup-failed" } }))).toBe(
      "10 on Sep 23, 2026 Not re-measured: the count query failed",
    );
  });

  test("jamais mesuré et mesure ratée : « never measured » et la raison, aucun chiffre", () => {
    expect(texte(seg({ cachedCount: null, cachedAt: null, live: { ok: false, reason: "no-db" } }))).toBe(
      "never measured Not re-measured: database unavailable",
    );
  });
});
