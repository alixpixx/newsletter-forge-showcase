import { describe, expect, test } from "bun:test";
import { MAX_EDITION_START, parseEditionStart } from "./edition-start";

describe("parseEditionStart", () => {
  test("absent ⇒ undefined (la colonne n'est pas touchée)", () => {
    expect(parseEditionStart(undefined)).toBeUndefined();
  });

  test("entiers valides, nombre ou texte", () => {
    expect(parseEditionStart(1)).toBe(1);
    expect(parseEditionStart(140)).toBe(140);
    expect(parseEditionStart("140")).toBe(140);
    expect(parseEditionStart(MAX_EDITION_START)).toBe(MAX_EDITION_START);
  });

  test("⛔ refusé plutôt que corrigé en silence", () => {
    for (const v of [0, -3, 12.5, MAX_EDITION_START + 1, "", "  ", "abc", null, Number.NaN, true, {}]) {
      expect(parseEditionStart(v)).toBeNull();
    }
  });
});
