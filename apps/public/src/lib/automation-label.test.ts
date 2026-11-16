/**
 * LE SLUG D'UN LABEL D'AUTOMATION (0095) — calculé ICI seulement.
 *
 * ⛔ Ce qui se tient : le même nom donne toujours le même slug ; le slug a la forme que la base exige
 * (`automation_label_slug_format`) ; un nom inutilisable rend `null`, jamais une chaîne vide.
 */
import { describe, expect, test } from "bun:test";
import { LABEL_SLUG_RE, MAX_LABEL_NAME, labelName, labelSlug, readLabel } from "./automation-label";

describe("labelSlug", () => {
  for (const [nom, slug] of [
    ["Libertadores 2026", "libertadores-2026"],
    ["  Lakeside — Libertadores  ", "lakeside-libertadores"],
    ["Ça Marche à l'ÉTÉ", "ca-marche-a-l-ete"],
    ["série_1/2", "serie-1-2"],
    ["libertadores-2026", "libertadores-2026"],
    ["---a---", "a"],
  ] as const) {
    test(`${nom} → ${slug}`, () => {
      expect(labelSlug(nom)).toBe(slug);
    });
  }

  test("rien d'utilisable ⇒ null", () => {
    expect(labelSlug("⚽⚽")).toBeNull();
    expect(labelSlug("日本語")).toBeNull();
    expect(labelSlug("---")).toBeNull();
  });

  test("64 caractères au plus, sans tiret final, et toujours la forme de la base", () => {
    const s = labelSlug(`${"a".repeat(63)} b`);
    expect(s).toBe("a".repeat(63));
    for (const nom of ["x".repeat(80), "a b ".repeat(20), "É".repeat(80)]) {
      const r = labelSlug(nom);
      expect(r === null || LABEL_SLUG_RE.test(r)).toBe(true);
      expect((r ?? "").length).toBeLessThanOrEqual(64);
    }
  });

  /** La base vérifie la même forme : `^[a-z0-9][a-z0-9-]{0,63}$` (0095). */
  test("l'expression est celle de la base", () => {
    expect(LABEL_SLUG_RE.source).toBe("^[a-z0-9][a-z0-9-]{0,63}$");
  });
});

describe("labelName / readLabel", () => {
  test("espaces repliés, bornes 1 à 80, refus plutôt que troncature", () => {
    expect(labelName("  Libertadores   2026 ")).toBe("Libertadores 2026");
    expect(labelName("")).toBeNull();
    expect(labelName(null)).toBeNull();
    expect(labelName("x".repeat(MAX_LABEL_NAME))).toHaveLength(MAX_LABEL_NAME);
    expect(labelName("x".repeat(MAX_LABEL_NAME + 1))).toBeNull();
  });

  test("readLabel rend le nom ET le slug, ou null", () => {
    expect(readLabel("Libertadores 2026")).toEqual({ name: "Libertadores 2026", slug: "libertadores-2026" });
    expect(readLabel("⚽")).toBeNull();
  });
});
