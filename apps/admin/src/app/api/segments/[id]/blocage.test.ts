import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { messageDeBlocage } from "./blocage";

describe("messageDeBlocage — une campagne archivée bloque, et le refus la NOMME comme telle", () => {
  test("une archivée est suivie de « (archived) », une active non", () => {
    const m = messageDeBlocage([{ name: "Friday NL" }, { name: "Resumo", archived_at: "2026-09-20T08:00:00Z" }]);
    expect(m).toContain("2 campaign(s)");
    expect(m).toContain("(Friday NL, Resumo (archived))");
    expect(m).toContain("restore them from the Archived tab");
  });

  test("sans archivée, la phrase d'origine, sans mention de l'onglet", () => {
    const m = messageDeBlocage([{ name: "Friday NL", archived_at: null }]);
    expect(m).toBe(
      "This segment is the audience of 1 campaign(s) that have not been sent (Friday NL). Change their audience first.",
    );
  });

  // ⛔ MUTATION QUI DOIT TUER CE TEST : filtrer `archived_at` dans la lecture des bloqueurs. Une
  // campagne archivée, réactivée plus tard, partirait vers un segment disparu.
  test("la route lit `archived_at` et ne filtre PAS les archivées", () => {
    const src = readFileSync(join(import.meta.dir, "route.ts"), "utf8");
    const lecture = src.slice(src.indexOf('.from("campaign")'), src.indexOf(".limit(3)"));
    expect(lecture).toContain("archived_at");
    expect(lecture).not.toMatch(/\.(is|not)\(\s*"archived_at"/);
  });
});
