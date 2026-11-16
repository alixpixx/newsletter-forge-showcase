/**
 * LA CASE « Segment size » N'AFFICHE QU'UN COMPTE LU — jamais un chiffre de repli.
 *
 * ⛔ Jusqu'au 24/09/2026, quand la base ne répondait pas (ou refusait la règle), le constructeur
 * affichait `estimate()` : 128 450 abonnés FICTIFS × une sélectivité inventée. Ces tests tiennent
 * les deux bouts : la décision pure (`segmentSize`) ne rend un nombre QUE depuis `live.count`, et
 * les sources ne peuvent plus rappeler l'estimation.
 *
 * MUTATION QUI DOIT TUER CE FICHIER : faire rendre au repli final de `segmentSize` un
 * `{ kind: "count", size: 0, pct: null }` (ou tout autre nombre) au lieu de `unavailable`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as segments from "@nf/segments";
import { SIZE_UNAVAILABLE, segmentSize } from "./segment-size";

const sansCommentaires = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("segmentSize — aucun nombre sans lecture", () => {
  test("base injoignable (aucune réponse) ⇒ unavailable/database, sans aucun nombre", () => {
    const r = segmentSize(null, 1056, false);
    expect(r.kind).toBe("unavailable");
    expect(r.kind === "unavailable" ? r.cause : null).toBe("database");
    expect("size" in r).toBe(false);
    expect("pct" in r).toBe(false);
  });

  test("réponse sans compte (`no-db`) ⇒ unavailable/database — jamais « règle refusée »", () => {
    const r = segmentSize({ count: null, widened: false, reason: "no-db" }, 1056, false);
    expect(r.kind === "unavailable" ? r.cause : null).toBe("database");
  });

  test("la base a REFUSÉ la règle (`query-failed`) ⇒ unavailable/rejected", () => {
    const r = segmentSize({ count: null, widened: false, reason: "query-failed" }, 1056, false);
    expect(r.kind).toBe("unavailable");
    expect(r.kind === "unavailable" ? r.cause : null).toBe("rejected");
    expect(r.kind === "unavailable" ? r.message : "").toContain("refused");
  });

  test("un compte lu est rendu tel quel, avec son pourcentage du total actif lu", () => {
    const r = segmentSize({ count: 264, widened: false, reason: null }, 1056, false);
    expect(r).toEqual({ kind: "count", size: 264, pct: 25 });
  });

  test("un vrai zéro lu reste un compte (0), pas une indisponibilité", () => {
    const r = segmentSize({ count: 0, widened: false, reason: null }, 1056, false);
    expect(r).toEqual({ kind: "count", size: 0, pct: 0 });
  });

  test("⛔ total actif non lu (0) ⇒ pas de pourcentage calculé sur un dénominateur de repli", () => {
    const r = segmentSize({ count: 264, widened: false, reason: null }, 0, false);
    expect(r).toEqual({ kind: "count", size: 264, pct: null });
  });

  test("ciblage élargi ⇒ aucun compte, même lu", () => {
    const r = segmentSize({ count: 900, widened: true, reason: null }, 1056, false);
    expect(r).toEqual({ kind: "widened" });
  });

  test("première lecture en cours ⇒ loading ; un ancien compte reste affiché pendant la relecture", () => {
    expect(segmentSize(null, 1056, true)).toEqual({ kind: "loading" });
    const r = segmentSize({ count: 12, widened: false, reason: null }, 1056, true);
    expect(r.kind).toBe("count");
  });

  test("le libellé affiché est « Size unavailable »", () => {
    expect(SIZE_UNAVAILABLE).toBe("Size unavailable");
  });
});

describe("⛔ l'estimation fictive ne peut plus revenir", () => {
  test("@nf/segments n'exporte plus `estimate`", () => {
    expect((segments as Record<string, unknown>).estimate).toBeUndefined();
  });

  test("le constructeur n'appelle ni `estimate` ni le total fictif 128 450, et passe par segmentSize", () => {
    const src = sansCommentaires(readFileSync(new URL("./segment-builder.tsx", import.meta.url), "utf8"));
    expect(/\bestimate\b/.test(src)).toBe(false);
    expect(/128[_,]?450/.test(src)).toBe(false);
    expect(src).toContain("segmentSize(live, baseTotal, loading)");
  });

  test("fields.ts ne porte plus le total fictif", () => {
    const src = sansCommentaires(
      readFileSync(new URL("../../../../../packages/segments/src/fields.ts", import.meta.url), "utf8"),
    );
    expect(/128[_,]?450/.test(src)).toBe(false);
    expect(/\bfunction estimate\b/.test(src)).toBe(false);
  });
});
